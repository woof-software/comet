// The rate-curve panel: which leg each curve is on, what put it there, and what
// the next unit of utilization costs.
//
// The arithmetic is model/curve.mjs. This file only turns it into sentences and
// into the one chart where the question is visible at a glance — the model stays
// free of wording so it can be imported outside a browser.

import { FACTOR } from "../model/constants.mjs";
import { legCrossing, supplyCurveAt, borrowCurveAt } from "../model/curve.mjs";
import { $ } from "./fields.mjs";
import { grp, signed, secs, apr, aprNum, pct } from "./format.mjs";
import { lineChart } from "./chart.mjs";

// A gap between two utilizations is measured in percentage points, not per cent
// — pct already handles the adaptive precision, and dust must not round to "0".
const points = (u) => pct(u).replace(" %", " pp");

const LEG = {
  low:  { chip: "SLOPE LOW",  cls: "chip-ok",   word: "slopeLow" },
  high: { chip: "SLOPE HIGH", cls: "chip-sat",  word: "slopeHigh" },
};

// Why the rate never reached the curve. Both are states of the market, not of u.
const EARLY = {
  "totalSupplyBase == 0": "nobody is lending — <code>getSupplyRate</code> returns 0 before it looks at the curve (<code>:319</code>).",
  "liquidity exhausted": "the liquidity cut-off fired: <code>u == 0</code> with a non-zero base rate and the whole supply already lent out (<code>:330</code>). The rate is 0 whatever the curve says.",
  "totalBorrowBase == 0": "nobody is borrowing — <code>getBorrowRate</code> returns 0 before it looks at the curve (<code>:348</code>).",
};

function card(side, bs, crossing, horizonSecs) {
  const L = LEG[side.leg];
  const off = side.early !== null;
  const term = (name, expr, v) =>
    `<tr><td><span class="site-name">${name}</span><br><span class="site-loc">${expr}</span></td>` +
    `<td class="num mono">${grp(v)}</td><td class="num mono">${apr(v)}</td></tr>`;

  // Where the kink sits relative to the market, said in the direction the reader
  // is standing: past it, or short of it.
  const gap = side.toKink;
  const place = side.atBreak
    ? `exactly on the kink — priced at <b>slopeLow</b>, while the next wei of utilization is priced at slopeHigh`
    : gap < 0n
    ? `<b>${points(-gap)}</b> past the kink`
    : `<b>${points(gap)}</b> short of the kink`;

  // The supply figure is signed like the Liquidity field, so it can be typed
  // straight into it. Only one direction is ever interesting per leg.
  const r = side.reach.supply;
  const reach = r === null || r === 0n ? ""
    : side.leg === "high"
    ? `<div class="derived">back onto slopeLow: <b>${signed(r, bs, 2)}</b> base units of liquidity` +
      (side.reach.borrow === null ? "" : `, or <b>${signed(side.reach.borrow, bs, 2)}</b> of debt`) + `</div>`
    : `<div class="derived">onto slopeHigh: <b>${signed(r, bs, 2)}</b> base units of liquidity` +
      (side.reach.borrow === null ? "" : `, or <b>${signed(side.reach.borrow, bs, 2)}</b> of debt`) + `</div>`;

  const cross = crossing
    ? `<div class="derived">crosses onto <b>${LEG[crossing.to].word}</b> at t = ${secs(Number(crossing.t))}, u = ${pct(crossing.u)}</div>`
    : `<div class="derived">stays on ${L.word} for the whole ${secs(Number(horizonSecs))} window</div>`;

  return `
    <div class="curve-side">
      <div class="cs-head">
        <span class="cs-name">${side.kind} curve</span>
        <span class="chip ${off ? "chip-idle" : L.cls}">${off ? "OFF CURVE" : L.chip}</span>
      </div>
      <div class="cs-now">
        <b>${off ? "0 %" : apr(side.rate)}</b>
        <span>u = ${pct(side.u)} · kink ${pct(side.kink)} · ${place}</span>
      </div>
      ${off ? `<div class="note-inline">${EARLY[side.early] ?? side.early}</div>` : `
      <table>
        <thead><tr><th>term</th><th class="num">per second</th><th class="num">APR</th></tr></thead>
        <tbody>
          ${term("InterestRateBase", "the constant leg", side.legs.base)}
          ${term("slopeLow", `× ${side.leg === "low" ? "u" : "kink"} = ${pct(side.leg === "low" ? side.u : side.kink)}`, side.legs.low)}
          ${term("slopeHigh", side.leg === "low" ? "not in play below the kink" : `× (u − kink) = ${pct(side.u - side.kink)}`, side.legs.high)}
          <tr><td><span class="site-name">= rate</span><br><span class="site-loc">${side.sum === side.rate ? "the sum is the contract's own" : "MISMATCH against getRate"}</span></td>
            <td class="num mono">${grp(side.rate)}</td><td class="num mono">${apr(side.rate)}</td></tr>
        </tbody>
      </table>`}
      <div class="cs-foot">
        ${off ? "" : `<div class="derived">the next point of u costs <b>${apr(side.perPoint)}</b> of APR — priced at ${L.word}</div>`}
        <div class="derived">${off ? "the curve is unchanged, only unused: " : ""}at the kink ${apr(side.atKink)} · at u = 100 % ${apr(side.atFull)}</div>
        ${off ? "" : reach + cross}
      </div>
    </div>`;
}

export function renderCurves({ cfg, pos, traj, horizonSecs }) {
  const bs = cfg.baseScale;

  // The window is already walked for the charts, so a crossing is a read of that
  // trajectory rather than a second run.
  const crossS = legCrossing(traj, pos.supply.kink, pos.supply.leg);
  const crossB = legCrossing(traj, pos.borrow.kink, pos.borrow.leg);

  $("curveCards").innerHTML =
    card(pos.supply, bs, crossS, horizonSecs) +
    card(pos.borrow, bs, crossB, horizonSecs);

  $("curveHint").textContent =
    `supplyKink ${pct(pos.supply.kink)} · borrowKink ${pct(pos.borrow.kink)}`;

  // The rail carries the same verdict next to the parameters that produced it.
  const chipFor = (side) => side.early !== null ? "off curve" : LEG[side.leg].word;
  $("supplyLeg").textContent = chipFor(pos.supply);
  $("borrowLeg").textContent = chipFor(pos.borrow);

  drawCurves(cfg, pos);

  const sameKink = pos.supply.kink === pos.borrow.kink;
  $("curveNote").innerHTML =
    `<b>The comparison is <code>u &lt;= kink</code></b> (<code>:333</code>, <code>:349</code>), so the kink is the last ` +
    `point of the low leg rather than the first of the high one: a market parked exactly on it is still priced at ` +
    `<code>slopeLow</code>, and the next wei of utilization is not. ` +
    (sameKink
      ? `Both curves break at the same ${pct(pos.supply.kink)} here, but that is this market's configuration, not a rule — `
      : `The two curves break at different points here (${pct(pos.supply.kink)} and ${pct(pos.borrow.kink)}) — `) +
    `<code>supplyKink</code> and <code>borrowKink</code> are separate parameters, so one curve can be past its kink while the other is not.` +
    `<br><br><b>The three terms are the contract's own addition</b>, not a reconstruction of it: ` +
    `<code>base + slopeLow·min(u, kink) + slopeHigh·max(0, u − kink)</code> is literally what the branch computes, ` +
    `and the table carries their sum beside the rate so a disagreement would show rather than hide. ` +
    `The curve drawn below comes from the same <code>getSupplyRate</code>/<code>getBorrowRate</code> the accrual runs on — ` +
    `only the state short-circuits are cleared, because a curve is the branch and not the market.`;
}

/**
 * Both curves against utilization, with the kinks and the market marked.
 *
 * Sampling is uneven on purpose: an even grid would round the corner off the
 * kink, which is the one feature the chart exists to show. The kinks and the
 * market's own u are inserted as exact samples, so the break lands where the
 * contract puts it.
 */
function drawCurves(cfg, pos) {
  const u = pos.u;
  // Always show the whole low leg and a little of the high one; a market past
  // 100 % utilization — which is the case this bench was built for — pushes the
  // axis out rather than falling off it.
  const uMax = [FACTOR, u * 115n / 100n, pos.supply.kink * 115n / 100n, pos.borrow.kink * 115n / 100n]
    .reduce((a, b) => (b > a ? b : a));

  const xs = [];
  for (let i = 0; i <= 80; i++) xs.push(uMax * BigInt(i) / 80n);
  for (const extra of [pos.supply.kink, pos.borrow.kink, u]) {
    if (extra >= 0n && extra <= uMax) xs.push(extra);
  }
  xs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const grid = xs.filter((v, i) => i === 0 || v !== xs[i - 1]);

  const sVals = grid.map(v => aprNum(supplyCurveAt(cfg, v)));
  const bVals = grid.map(v => aprNum(borrowCurveAt(cfg, v)));
  const frac = (v) => Number(v) / Number(uMax);

  // Where the break is, and where the market stands against it. The two lines
  // are the whole answer to "which leg" — reading their order left to right is
  // faster than reading either number. Labels go on opposite edges because on a
  // live market the two are often a fraction of a point apart.
  const marks = (pos.supply.kink === pos.borrow.kink
    ? [{ frac: frac(pos.supply.kink), label: `kink ${pct(pos.supply.kink)}`, color: "var(--muted)" }]
    : [{ frac: frac(pos.supply.kink), label: `supply kink ${pct(pos.supply.kink)}`, color: "var(--series-1)" },
       { frac: frac(pos.borrow.kink), label: `borrow kink ${pct(pos.borrow.kink)}`, color: "var(--series-2)" }]);
  marks.push({ frac: frac(u), label: `u = ${pct(u)}`, color: "var(--accent)", align: "bottom" });

  // The rate is on the card; here the dot only pins the curve to that line. A
  // curve the market is not being priced by gets none — on an early return the
  // market is not on it at all.
  const dots = [];
  if (pos.supply.early === null) dots.push({ frac: frac(u), v: aprNum(pos.supply.rate), color: "var(--series-1)" });
  if (pos.borrow.early === null) dots.push({ frac: frac(u), v: aprNum(pos.borrow.rate), color: "var(--series-2)" });

  lineChart($("chartCurve"), $("tipCurve"), $("wrapCurve"), {
    height: 260, xMax: Number(uMax), xMin: 0, xs: grid.map(Number),
    xName: "u", xFmt: (v) => (v / 1e16).toFixed(1) + " %",
    yLabelFmt: (p) => p + " %",
    ceiling: null, ceilingLabel: "",
    marks, dots,
    series: [
      { name: "supply APR", color: "var(--series-1)", values: sVals,
        raw: grid.map(v => apr(supplyCurveAt(cfg, v))), endLabel: apr(supplyCurveAt(cfg, uMax)) },
      { name: "borrow APR", color: "var(--series-2)", values: bVals,
        raw: grid.map(v => apr(borrowCurveAt(cfg, v))), endLabel: apr(borrowCurveAt(cfg, uMax)) },
    ],
  });
}
