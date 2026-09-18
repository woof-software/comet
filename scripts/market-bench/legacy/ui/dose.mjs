// The dose panel: the two levers of a preventive intervention, priced.
//
// Presentation only. Which supply keeps the market off the steep slope, what a
// reserve withdrawal may and may not buy, and how long either survives — all of
// that is model/dose.mjs, which knows nothing about this file.

import { FACTOR } from "../model/constants.mjs";
import { doseReport } from "../model/dose.mjs";
import { $ } from "./fields.mjs";
import { scaled, secs, apr } from "./format.mjs";

const tile = (lab, val, sub, crit) =>
  `<div class="tile"><span class="t-lab">${lab}</span>` +
  `<span class="t-val"${crit ? ' style="color:var(--critical)"' : ""}>${val}</span>` +
  `<span class="t-sub">${sub}</span></div>`;

const slopeChip = (flat) => flat
  ? `<span class="chip chip-ok">LEFT</span>`
  : `<span class="chip chip-trip">RIGHT</span>`;

// "> 10 y" is not "safe": it is the probe's horizon, and saying so keeps the
// ceiling from being read as a result.
const haltText = (d) => d.emptiable ? "bricking under way"
  : d.halt === null ? "—"
  : d.halt.capped ? "> 10 y"
  : secs(Number(d.halt.t));

export function renderDose({ cfg, st, opt, dose }) {
  const r = doseReport({ cfg, st, opt, dose });
  const bs = cfg.baseScale;
  const u = (b, dp = 2) => scaled(b, bs, dp);
  const uti = (v) => scaled(v, FACTOR, 3);
  const p = r.plan;

  $("doseScope").textContent = r.noBorrow
    ? "debt is zero — no dose needed"
    : `kink = ${uti(cfg.borrowKink)} · debt ${u(r.B0)} · reserves ${u(r.R)}`;

  const deadline = r.deadline.capped ? "> 10 y" : secs(Number(r.deadline.t));

  $("doseTiles").innerHTML = [
    tile("intervention deadline", deadline,
      r.deadline.capped ? "no breakdown within the search range"
        : `past it <code>supply</code> and <code>withdrawReserves</code> revert too`,
      !r.deadline.capped),
    tile("supply to add", u(r.needPv),
      `u ≤ kink after everyone else fully exits · if the rest stays — ${u(r.needNowPv)} is enough`),
    tile("plan: we add", u(r.X),
      r.shortPv > 0n ? `${u(r.shortPv)} short of the left-slope threshold`
        : r.marginPct === null ? "—"
        : `${r.marginPct.toFixed(1)} % headroom above the threshold`,
      r.shortPv > 0n),
    // A floor of zero has u = 0 and a flat rate, and printing that would read as
    // the safest row on the panel. The market never gets there: it bricks on the
    // way down. So the state is not described, it is named.
    tile("u after a full exit", p.emptiable ? "—" : uti(p.uPost),
      p.emptiable
        ? "floor 0 — the exit bricks the market on the way, see the exit panel"
        : `${slopeChip(p.onFlat)} borrow APR ${apr(p.brPost)} · floor ${u(p.floorPv)}`,
      p.emptiable || !p.onFlat),
    tile("reserves that can be taken", u(r.yMax),
      r.yBinds === "reserves" ? "bound by <code>getReserves()</code>"
        : "bound by the lenders' cash — past it they are locked in"),
    tile("plan: we take", u(r.Y),
      r.overY ? `${u(r.Y - r.yMax)} over the ceiling`
        : `net cost X − Y = <b>${u(p.net)}</b>`,
      r.overY),
    tile("breakdown after the dose", haltText(p),
      p.onFlat && p.halt?.kinkAt > 0n
        ? `was ${deadline} without the dose · u passes the kink in ${secs(Number(p.halt.kinkAt))}`
        : `was ${deadline} without the dose`,
      !p.onFlat || p.emptiable),
  ].join("");

  // --- the same dose at other sizes
  $("doseRows").innerHTML = r.variants.map(v => {
    const here = v.plan;
    return `<tr${here ? ' class="tripped"' : ""}>
      <td><span class="site-name">${v.label}${here ? ' <span class="chip chip-ok">current</span>' : ""}</span><br>
          <span class="site-loc">${v.sub}</span></td>
      <td class="num mono">${u(v.X)}</td>
      <td class="num mono">${v.emptiable ? "0" : u(v.floorPv)}</td>
      <td class="num mono">${v.emptiable ? "—" : uti(v.uPost)}</td>
      <td>${v.emptiable ? `<span class="chip chip-trip">BRICK</span>` : slopeChip(v.onFlat)}</td>
      <td class="num mono">${v.emptiable ? "—" : apr(v.brPost)}</td>
      <td class="num mono">${haltText(v)}</td>
      <td class="num mono">${u(v.net)}</td></tr>`;
  }).join("");

  // --- the verdict, in words
  const lever =
    `<b>Reserves cannot get you onto the left slope — at all.</b> A reserve withdrawal moves ` +
    `<code>balance</code>, not <code>totalSupplyBase</code>, so it does not touch utilization. ` +
    `The best floor this lever buys is exactly <code>B = ${u(r.reservesCeilPv)}</code> at ` +
    `<code>R' = 0</code>, and <code>u</code> there equals <code>1.000</code> — still past the kink ` +
    `<code>${uti(cfg.borrowKink)}</code>. Only supply lowers the slope.`;

  const policy = p.locked > 0n
    ? `<b style="color:var(--critical)">This dose locks lenders in.</b> After it there is ` +
      `<code>${u(p.cashN)}</code> of cash against <code>${u(r.S0)}</code> of other people's supply — ` +
      `<code>${u(p.locked)}</code> will not be able to leave until the debt is repaid.`
    : `<b>The lenders stay free.</b> After the dose there is <code>${u(p.cashN)}</code> of cash against ` +
      `<code>${u(r.S0)}</code> of other people's supply — everyone can leave. That is exactly why the floor is held ` +
      `by our position alone: if the rest can leave, they leave, and exactly X remains. ` +
      `<code>B − R' = ${u(p.reachPv)}</code> does not work as protection in this setup, and Y is a ` +
      `treasury lever, not a liveness one.`;

  const order =
    `<b>The order of operations matters.</b> First <code>supply</code>, then ` +
    `<code>withdrawReserves</code>: <code>doTransferOut</code> pays out of the balance, and before ` +
    `the deposit that balance is only <code>${u(r.cash)}</code>. In the reverse order Y > ${u(r.cash)} simply ` +
    `reverts, and a smaller Y leaves the lenders with no exit for a few blocks.`;

  const head = r.noBorrow
    ? `<b>Debt is zero.</b> <code>getBorrowRate</code> returns 0 (:350), the index does not compound, ` +
      `and the dose saves nothing from anything.`
    : r.shortPv > 0n
    ? `<b style="color:var(--critical)">The dose falls short of the threshold.</b> After the remaining ` +
      `lenders fully exit, <code>u = ${uti(p.uPost)}</code> — that is the right slope, borrow APR ${apr(p.brPost)}, ` +
      `and <code>baseBorrowIndex</code> compounds at exactly that speed. Breakdown in ${haltText(p)}. ` +
      `To land on the flat branch, at least <code>${u(r.needPv)}</code> is required.`
    : `<b>The dose keeps the market on the left slope.</b> Even if every current lender leaves, ` +
      `our position <code>${u(p.floorPv)}</code> remains, and <code>u = ${uti(p.uPost)}</code> ` +
      `against the kink <code>${uti(cfg.borrowKink)}</code> — borrow APR drops to ${apr(p.brPost)}. ` +
      `That pushes the breakdown from <b>${deadline}</b> out to <b>${haltText(p)}</b>` +
      (p.halt?.kinkAt != null ? `: the debt still grows, crosses the kink in ${secs(Number(p.halt.kinkAt))}, and accelerates from there` : ``) +
      `. Time was bought, not safety — only repaying the debt closes the question for good.`;

  const satNote = opt.saturate
    ? `<br><br><b style="color:var(--critical)">"Saturate instead of revert" mode is on.</b> ` +
      `In it no site reverts by construction, so every breakdown number on this panel is ` +
      `the search ceiling, not a result. Turn it off for the panel to mean anything.`
    : "";

  // With no borrow every paragraph below turns into arithmetic about zero, so the
  // panel says the one thing that is true and stops.
  if (r.noBorrow) {
    $("doseVerdict").innerHTML = `${head} The panel stays here as a control: as soon as debt appears, ` +
      `the left-slope threshold will be recomputed from it.${satNote}`;
    return seatButtons();
  }

  $("doseVerdict").innerHTML = `${head}<br><br>${lever}<br><br>${policy}<br><br>${order}` +
    `<br><br>The table is the same dose at other sizes. The <b>reserves only</b> row is the control: ` +
    `it shows that X = 0 never reaches the flat branch for any Y. Its numbers are ` +
    `computed with a one-day step, the tiles with a one-hour step; over a horizon of years the difference is under ` +
    `half a percent, at the deadline it is noticeable, which is why that one is computed more often.${satNote}`;

  // --- seat buttons: hand them states the model has already built
  function seatButtons() {
    const seat = (id, P, R2, label, val) => {
      const b = $(id);
      b.dataset.p = P.toString();
      b.dataset.r = R2.toString();
      return `${label} ${val}`;
    };
    $("doseSeatNote").textContent = [
      seat("seatDose", p.seatedP, p.Rn, "after the dose:", `S = ${u(r.S0 + p.ourPv)} · R = ${u(p.Rn)}`),
      seat("seatPostExit", p.floorP, p.Rn, "after the exit:", `S = ${u(p.floorPv)} · R = ${u(p.Rn)}`),
    ].join(" · ");
    $("doseMin").dataset.human = scaled(r.needPv, bs, 6).replace(/\s/g, "");
  }
  seatButtons();
}
