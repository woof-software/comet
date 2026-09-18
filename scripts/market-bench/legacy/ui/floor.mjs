// The supply-floor panel: how little supply a market may keep and still accrue,
// and how little a mass exit can actually leave behind.
//
// Everything here is presentation. The two numbers and the shape of the safe set
// come from model/minsupply.mjs, which knows nothing about this file.

import { FACTOR } from "../model/constants.mjs";
import { minSupplyReport, floorLadder, firstHalt, withSupply } from "../model/minsupply.mjs";
import { $ } from "./fields.mjs";
import { grp, sci, scaled, secs, ratio } from "./format.mjs";

// Windows the floor is quoted against. The year is deliberately absent: one rung
// at 365 steps costs more than the whole rest of the page, and the tiles already
// answer for whatever window the Time panel is set to.
const RUNGS = [
  { label: "next accrue", sub: "12 s — the market is touched every block", dt: 12n, steps: 1 },
  { label: "hour", sub: "3 600 s in one step", dt: 3600n, steps: 1 },
  { label: "day", sub: "86 400 s in one step", dt: 86400n, steps: 1 },
  { label: "30 days", sub: "30 × a day — touched daily", dt: 86400n, steps: 30 },
  { label: "90 days", sub: "90 × a day — touched daily", dt: 86400n, steps: 90 },
];

const tile = (lab, val, sub, crit) =>
  `<div class="tile"><span class="t-lab">${lab}</span>` +
  `<span class="t-val"${crit ? ' style="color:var(--critical)"' : ""}>${val}</span>` +
  `<span class="t-sub">${sub}</span></div>`;

export function renderFloor({ cfg, st, opt, dt, steps }) {
  const r = minSupplyReport({ cfg, st, opt, dt, steps });
  const bs = cfg.baseScale;
  const u = (b, dp = 4) => scaled(b, bs, dp);
  const horizon = secs(Number(dt) * steps);

  // The lowest supply a mass exit can leave that is not the safe singular point.
  // When B <= R the exit can land on exactly 0 — and 0 accrues fine — so the
  // worst reachable state that still looks alive is one wei.
  const worstP = r.reachP > 0n ? r.reachP : 1n;
  const worstHalt = r.hopeless || r.unconstrained
    ? null : firstHalt(cfg, withSupply(st, worstP, r.R, r.B0), dt, opt, steps);

  // A withdrawal stops at whichever comes first: the floor, or the cash that
  // funds it. So "how much may leave" is the distance to the higher of the two,
  // and the fatal band is what is left of the gap once cash has had its say.
  const cap = r.minPv === null ? null : (r.minPv > r.reachPv ? r.minPv : r.reachPv);
  const safeOut = cap === null ? null : (r.S0 > cap ? r.S0 - cap : 0n);
  const bindsCash = cap !== null && r.reachPv >= r.minPv;
  const fatal = r.unconstrained ? null : r.bandPv;   // a 1-wei "band" is noise, not a finding

  const bindName = r.binding.length
    ? r.binding.map(s => `${s.id} · ${s.name}`).join(", ")
    : (r.hopeless ? "does not depend on supply" : "—");

  $("floorScope").textContent = `window ${horizon} · step ${grp(dt)} s`;

  $("minTiles").innerHTML = [
    tile("S_min — must remain",
      r.hopeless ? "unreachable" : r.unconstrained ? "any > 0" : u(r.minPv),
      r.hopeless ? "no supply survives the window"
        : r.unconstrained ? "even 1 wei survives the window"
        : `${grp(r.minP)} principal`,
      r.hopeless),
    tile("reachable floor B − R",
      u(r.reachPv),
      r.emptiable ? "B ≤ R — an exit all the way to zero is reachable"
        : `${grp(r.reachP)} principal · u ceiling = ${sci(r.uAtReach ?? 0n)}`),
    tile("fatal band",
      fatal === null ? "—" : fatal === 0n ? "empty" : u(fatal),
      fatal === null ? "there is no floor on this horizon"
        : fatal === 0n ? "cash stops the exit above S_min"
        : "[B − R, S_min) — reachable and not alive",
      fatal !== null && fatal > 0n),
    tile("can be withdrawn safely",
      r.shortfallPv === null ? "—" : r.shortfallPv > 0n ? "−" + u(r.shortfallPv) : u(safeOut),
      r.shortfallPv === null ? "—"
        : r.shortfallPv > 0n ? "current supply is ALREADY below the floor"
        : r.S0 === 0n ? "supply = 0 — the singular safe point"
        : `${bindsCash ? "bound by cash B − R" : "bound by S_min"} · = ${ratio(safeOut * 100n, r.S0)} % of supply`,
      r.shortfallPv !== null && r.shortfallPv > 0n),
    tile("u at the S_min floor",
      r.uAtMin === null ? "—" : sci(r.uAtMin),
      r.uAtMin === null ? "—"
        : `= ${ratio(r.uAtMin, FACTOR)} × · analytical rate floor ${r.ratePv === null ? "—" : u(r.ratePv, 2)}`),
    tile("breakdown already at S_min",
      r.haltAtMin === null ? "not found" : secs(Number(r.haltAtMin)),
      r.haltAtMin === null ? "beyond the search range — the floor holds for a long time"
        : "the floor buys a window, not eternity"),
    tile("breakdown at the lowest reachable",
      worstHalt ? secs(Number(worstHalt.at)) : "—",
      worstHalt ? `with supply ${r.reachP > 0n ? "B − R" : "1 wei"} · step ${worstHalt.step} of ${steps}`
        : r.unconstrained ? "any supply survives the window" : "the reachable state survives the window"),
  ].join("");

  // --- the verdict, in words
  const criterion =
    `S_min is the smallest <code>totalSupplyBase</code> at which none of the six sites reverts over ` +
    `the window <b>${horizon}</b> (${steps} × ${grp(dt)} s). The binding site is <b>${bindName}</b>. ` +
    `A longer window can only raise the floor: sites 3–4 compound.`;

  const zeroRule =
    `There is exactly one exception and it is singular: precisely <code>S = 0</code> is safe — <code>getSupplyRate</code> returns 0 (:319), ` +
    `and so does <code>getUtilization</code> (:365-366). What is dangerous is not "empty", but "almost empty".`;

  let head;
  if (r.hopeless) {
    head = `<b>A supply floor is not a tool here.</b> No <code>totalSupplyBase</code> survives the window, all the way up to ` +
           `<code>uint104.max</code>: the breakdown is held by a site that does not depend on supply (the borrow index or tracking-borrow).`;
  } else if (r.unconstrained) {
    head = `<b>There is no floor on this horizon:</b> the window ${horizon} is survived even by 1 wei of supply against the current debt ` +
           `${u(r.B0, 2)}. That is a statement about the horizon, not about safety — stretch the window and a floor appears.`;
  } else if (r.bandPv === 0n) {
    head = `<b>A mass exit on its own does not block the market.</b> Liquidity runs out before the floor does: ` +
           `the exit can only go down to <code>S = B − R = ${u(r.reachPv, 2)}</code>, while the breakdown starts below ` +
           `<code>S_min = ${u(r.minPv, 2)}</code> — the band between them is empty. That is a property of the current <code>R/B</code>, ` +
           `not of the market's size: as soon as debt is repaid or reserves grow, <code>R/B</code> rises, the reachability floor drops — ` +
           `and the band opens (profile C).`;
  } else {
    head = `<b>A mass exit opens a fatal band of ${u(r.bandPv, 2)} base units.</b> ` +
           `The lenders can drive supply down to <code>${u(r.reachPv, 2)}</code>` +
           (r.emptiable ? ` (<code>B ≤ R</code> — even to zero)` : ``) +
           `, while the window is survived only from <code>S_min = ${u(r.minPv, 2)}</code> up. Everything between them is a brick` +
           (worstHalt ? `: at the lowest reachable supply the accrual reverts in ${secs(Number(worstHalt.at))}` : ``) +
           `. ` + zeroRule;
  }

  const islandNote = r.island
    ? `<br><br><b>A second band, below the floor.</b> The guard <code>totalSupplyBase >= baseMinForRewards</code> (:282) switches site 5 ` +
      `on in a jump, so the safe set is disconnected: <code>[${grp(r.island.from)}, ${grp(r.island.to)})</code> principal survives the window, ` +
      `while everything from <code>baseMinForRewards</code> up to S_min does not.`
    : "";

  // --- the same floor over a ladder of windows
  $("floorLadder").innerHTML = floorLadder({ cfg, st, opt }, RUNGS).map(g => {
    const here = g.dt === dt && g.steps === steps;
    return `<tr${here ? ' class="tripped"' : ""}>
      <td><span class="site-name">${g.label}${here ? ' <span class="chip chip-ok">current</span>' : ""}</span><br><span class="site-loc">${g.sub}</span></td>
      <td class="num mono">${g.minP === null ? "unreachable" : g.minP === 1n ? "any > 0" : u(g.minPv)}</td>
      <td class="num mono">${g.minP === null ? "—" : grp(g.minP)}</td>
      <td class="site-loc">${g.binding.map(b => `${b.id} · ${b.name}`).join(", ") || "—"}</td></tr>`;
  }).join("");

  $("minVerdict").innerHTML = `${head}<br><br>${criterion} ` +
    `The table above is the same floor against other windows: the next accrue costs dust, a month costs real money. ` +
    `A fork test that withdraws lenders block by block and catches the first revert measures exactly the top row.${islandNote}`;

  // --- seat buttons: the search is expensive, so hand them the numbers found here
  const seat = (id, P, label) => {
    const b = $(id);
    b.disabled = P === null;
    if (P !== null) b.dataset.p = P.toString(); else delete b.dataset.p;
    return P === null ? `${label} —` : `${label} ${grp(P)}`;
  };
  const parts = [
    seat("seatMin", r.minP, "S_min ="),
    seat("seatBelow", r.minP !== null && r.minP > 0n ? r.minP - 1n : null, "one wei below ="),
    seat("seatReach", r.hopeless ? null : r.reachP, "floor B − R ="),
  ];
  $("seatNote").textContent = parts.join(" · ") + " principal";
}
