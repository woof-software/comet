// The exit panel: the mass withdrawal as a process rather than a level.
//
// The floor panel answers "which supply levels are alive". This one runs the
// path: lenders leave one per block, each withdrawal accrues first, and nothing
// can be paid out that the market does not hold in cash. Whether the market ends
// as a brick or as a clean zero is decided by the tail of the distribution — so
// the shape is a control, and its provenance is printed next to it.

import { FACTOR } from "../model/constants.mjs";
import { pv } from "../model/accrual.mjs";
import { simulateExit } from "../model/exit.mjs";
import { $ } from "./fields.mjs";
import { grp, sci, scaled, secs, ratio, esc, lenders } from "./format.mjs";

const SHAPES = {
  equal: "equal shares: every lender holds the same — the market drains linearly",
  zipf:  "1/i: the first lender holds ten times more than the tenth, the tail is shallow",
  zipf2: "1/i²: a heavy head and a sharp tail — closer to a real market",
};

let PROFILES = [];

// main.mjs hands over data/exit-profiles.json. The model never fetches anything;
// a stored profile reaches it as plain weights.
export function initExit(profiles) {
  PROFILES = Array.isArray(profiles) ? profiles : [];
  if (!PROFILES.length) return;
  $("exitShape").innerHTML += PROFILES
    .map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
}

const tile = (lab, val, sub, crit) =>
  `<div class="tile"><span class="t-lab">${lab}</span>` +
  `<span class="t-val"${crit ? ' style="color:var(--critical)"' : ""}>${val}</span>` +
  `<span class="t-sub">${sub}</span></div>`;

export function renderExit({ cfg, st, opt, exit }) {
  const profile = PROFILES.find(p => p.id === exit.shape);
  const sim = simulateExit({ cfg, st, opt, exit: { ...exit, weights: profile?.weights } });
  const bs = cfg.baseScale;
  const u = (b, dp = 4) => scaled(b, bs, dp);
  const B0 = pv(st.bbi, st.borrowP);
  const n = sim.plan.length;

  $("exitShapeNote").textContent = profile ? profile.prov : (SHAPES[exit.shape] ?? "—");
  const dropped = sim.requested - n;
  $("exitScope").textContent =
    `${lenders(n)} · step ${grp(sim.dt)} s` +
    (dropped > 0 ? ` · shares below a wei dropped: ${dropped}` : "") +
    (profile ? " · the count is set by the profile" : "");

  const h = sim.halt;
  const outcome = h ? "BRICK" : sim.stopped === "cash" ? "CASH EXHAUSTED"
    : sim.saturated ? "SATURATED" : "DRAINED TO ZERO";

  $("exitTiles").innerHTML = [
    tile("exit outcome", outcome,
      h ? `accrueInternal reverts on withdrawal #${h.lender}`
        : sim.stopped === "cash" ? `payouts became impossible at #${sim.rows.length + 1}`
        : sim.saturated ? "the indices hit the limit, the accrual is alive"
        : "supply reached exactly 0 — the singular safe point",
      !!h),
    tile(h ? "supply left at the breakdown" : "supply left",
      h ? u(h.supplyPv) : sim.stopped === "cash" ? u(sim.rows.at(-1)?.supplyPv ?? 0n) : "0",
      h ? `${grp(h.supplyP)} principal · ${lenders(h.left)} locked inside`
        : sim.stopped === "cash" ? "cash allows no lower — that is the S ≥ B − R bound"
        : `${u(sim.out, 2)} base units withdrawn`,
      !!h),
    tile(h ? "u at the breakdown" : "peak u", sci(h ? h.u : sim.peakU),
      h ? `= ${ratio(h.u, FACTOR)} × · site ${h.sites.map(s => s.id).join(", ")}`
        : `= ${ratio(sim.peakU, FACTOR)} × · maximum over the whole exit`),
    tile("debt over the course of the exit",
      h ? u(h.borrowPv, 0) : u(pv(sim.final.bbi, sim.final.borrowP), 0),
      `at the start ${u(B0, 0)} · growth ×${ratio(h ? h.bbiGrowth : sim.bbiEnd, sim.bbi0)}`),
    tile("time from the start",
      h ? secs(Number(h.t)) : secs(Number(sim.final.t)),
      `${h ? h.lender - 1 : sim.rows.length} blocks of ${grp(sim.dt)} s`),
    tile("withdrawn in total", u(sim.out, 2),
      `out of ${u(pv(st.bsi, st.supplyP), 2)} base units at the start`),
  ].join("");

  // --- rows: sampled, but never at the cost of the last blocks before the halt
  const keep = new Set();
  const stride = Math.max(1, Math.ceil(sim.rows.length / 10));
  for (let i = 0; i < sim.rows.length; i += stride) keep.add(i);
  for (let i = Math.max(0, sim.rows.length - 4); i < sim.rows.length; i++) keep.add(i);
  const shown = [...keep].sort((a, b) => a - b).map(i => sim.rows[i]);

  const row = (r, state) => `<tr class="${state === "halt" ? "tripped" : ""}">
    <td class="num mono">#${r.lender}</td>
    <td class="num mono">${secs(Number(r.t))}</td>
    <td class="num mono">${r.amount === null ? "—" : u(r.amount, 2)}</td>
    <td class="num mono">${u(r.supplyPv, 4)}</td>
    <td class="num mono">${sci(r.u)}</td>
    <td class="num mono">${u(r.borrowPv, 0)}</td>
    <td>${state === "halt" ? `<span class="chip chip-trip">REVERT</span>`
      : state === "cash" ? `<span class="chip chip-sat">NO CASH</span>`
      : `<span class="chip chip-ok">OK</span>`}</td></tr>`;

  $("exitRows").innerHTML =
    shown.map(r => row(r, "ok")).join("") +
    (h ? row({ lender: h.lender, t: h.t, amount: null, supplyPv: h.supplyPv, u: h.u, borrowPv: h.borrowPv }, "halt")
       : sim.stopped === "cash"
       ? row({ lender: sim.rows.length + 1, t: sim.final.t, amount: null,
               supplyPv: pv(sim.final.bsi, sim.final.supplyP),
               u: sim.rows.at(-1)?.u ?? 0n, borrowPv: pv(sim.final.bbi, sim.final.borrowP) }, "cash")
       : "");

  const mechanism =
    `While the lenders leave, <code>u</code> grows and <code>baseBorrowIndex</code> compounds every block — ` +
    `here the debt grew ×${ratio(h ? h.bbiGrowth : sim.bbiEnd, sim.bbi0)} over ${secs(Number(h ? h.t : sim.final.t))}. ` +
    `That is why the breakdown happens at a remainder <b>higher</b> than the single-step threshold from the window ladder: it is not supply falling to the threshold, ` +
    `it is the threshold rising to meet supply.`;

  const shapeRule =
    `<b>The shape of the tail decides the outcome.</b> Equal shares land the market on exactly 0 — and that is safe (<code>:319</code>). ` +
    `A dusty tail leaves the last few pennies against live debt — and that is a brick. So "will a mass exit kill the market" ` +
    `has no answer without the distribution of balances: it is a property of the set of lenders, not of the market itself.`;

  $("exitNote").innerHTML = h
    ? `<b>The exit ended in a brick at lender ${h.lender} of ${n}.</b> ${lenders(h.left)} were left holding a balance ` +
      `in a market that no longer accepts any transaction: supply, withdraw, repay and liquidation all go ` +
      `through <code>accrueInternal</code>. ${mechanism}<br><br>${shapeRule}`
    : sim.stopped === "cash"
    ? `<b>The exit ran into cash, not into a breakdown.</b> The market paid out everything it had and stopped at the ` +
      `<code>S ≥ B − R</code> bound — the remaining lenders will not get out until the debt is repaid. ${shapeRule}`
    : `<b>The market was drained to zero without a breakdown.</b> The last withdrawal put <code>totalSupplyBase</code> at exactly 0, ` +
      `and zero is the only safe point down there: <code>getSupplyRate</code> returns 0 (<code>:319</code>). ` +
      `${shapeRule}`;
}
