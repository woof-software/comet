// Where the market sits on the two rate curves.
//
// getSupplyRate (:333-338) and getBorrowRate (:349-356) are piecewise linear in
// u with a single break each. Which side of that break the market is on is what
// prices the next unit of utilization — a fact about the market now, not a
// forecast. The two breaks are independent: supplyKink and borrowKink are
// separate parameters, so one curve can be past its kink while the other is not.
//
// Nothing new is ported here. The rate comes from accrual.mjs; this module only
// splits it into the terms the contract already adds up, and names the
// comparison that chose the branch.

import { FACTOR, IDX_SCALE } from "./constants.mjs";
import { mulFactor, supplyRate, borrowRate } from "./accrual.mjs";

// One percentage point of utilization, on the FACTOR scale.
export const ONE_POINT = FACTOR / 100n;

/**
 * The branch the contract takes, by its own comparison.
 *
 * `u <= kink` (:333, :349) — so the kink itself is the last point of the low
 * leg, not the first of the high one. A market parked exactly on the kink is
 * still priced at slopeLow, while the next wei of utilization is not.
 */
export const legOf = (u, kink) => (u <= kink ? "low" : "high");

// A state that exists only to clear the early returns while drawing a curve.
// getSupplyRate short-circuits on totalSupplyBase and on the token balance
// (:319, :330) and getBorrowRate on totalBorrowBase (:348) — all three are facts
// about the market, not about u, and a curve is the branch alone. Clearing them
// lets the SAME audited function draw the line, so there is no second copy of
// the formula to drift from accrual.mjs. `cash` is 2 against a present value of
// 1 because the cut-off is `PV_S >= balance`.
const CURVE_ONLY = Object.freeze({
  supplyP: 1n, borrowP: 1n, bsi: IDX_SCALE, bbi: IDX_SCALE, cash: 2n,
});

export const supplyCurveAt = (cfg, u) => supplyRate(cfg, CURVE_ONLY, u).v;
export const borrowCurveAt = (cfg, u) => borrowRate(cfg, CURVE_ONLY, u).v;

/**
 * What it takes to land utilization exactly on a kink, in present value.
 *
 * u = B · 1e18 / S (:363-367), so there are two ways to move it and they are not
 * interchangeable: S is the lenders' side, B the borrowers'. Both are signed the
 * way the actions panel is signed — plus deposits, minus withdraws — so the
 * supply figure can be typed straight into the Liquidity field.
 *
 * The supply target rounds UP: u is a floored division, and the smallest S that
 * still satisfies `u <= kink` is the edge of the low leg. One wei less and the
 * market is priced at slopeHigh, which is the whole point of the number.
 */
export function reachKink(S, B, kink) {
  if (kink <= 0n || S <= 0n || B <= 0n) return { supply: null, borrow: null };
  return {
    supply: (B * FACTOR + kink - 1n) / kink - S,
    borrow: kink * S / FACTOR - B,
  };
}

function position(kind, curve, rate, S, B) {
  const { kink, base, low, high } = curve;
  const onLow = legOf(rate.u, kink) === "low";

  // The contract's own three terms. On the low leg the high term does not exist;
  // on the high leg the low term is frozen at the kink. This is the same
  // addition the branch performs, not a reconstruction of it — `sum` is carried
  // beside the audited `rate` so a disagreement shows up instead of hiding.
  const legs = {
    base,
    low: mulFactor(low, onLow ? rate.u : kink),
    high: onLow ? 0n : mulFactor(high, rate.u - kink),
  };
  const sum = legs.base + legs.low + legs.high;

  return {
    kind, kink, u: rate.u,
    leg: onLow ? "low" : "high",
    // Exactly on the break: priced low, while the next wei is priced high.
    atBreak: rate.u === kink,
    // The rate short-circuited before the curve was ever consulted, so the
    // market is not being priced by the leg below.
    early: rate.early ?? null,
    rate: rate.v, legs, sum,
    // The slope in play — what the next unit of u costs. At u == kink this is
    // NOT the slope that priced the market.
    slope: onLow ? low : high,
    perPoint: mulFactor(onLow ? low : high, ONE_POINT),
    // Reference points on the same curve. The kink rate is continuous: both
    // branches agree there, which is what makes it a kink and not a step.
    atKink: base + mulFactor(low, kink),
    atFull: kink >= FACTOR
      ? base + mulFactor(low, FACTOR)
      : base + mulFactor(low, kink) + mulFactor(high, FACTOR - kink),
    toKink: kink - rate.u,
    reach: reachKink(S, B, kink),
  };
}

/**
 * Both curves, read at one utilization — the same `u` the accrual used.
 *
 * `st` is the state that produced `u`, and it is passed through untouched: the
 * early returns belong to the rate, so asking where the market sits has to ask
 * the rate, not the curve.
 */
export function curvePosition(cfg, st, u, S, B) {
  const sCurve = { kink: cfg.supplyKink, base: cfg.sBase, low: cfg.sLow, high: cfg.sHigh };
  const bCurve = { kink: cfg.borrowKink, base: cfg.bBase, low: cfg.bLow, high: cfg.bHigh };
  return {
    u,
    supply: position("supply", sCurve, { ...supplyRate(cfg, st, u), u }, S, B),
    borrow: position("borrow", bCurve, { ...borrowRate(cfg, st, u), u }, S, B),
  };
}

/**
 * Where in the window the market changes legs, if it does.
 *
 * The trajectory is already walked for the charts, so this is a read of it
 * rather than a second run: the first row whose leg differs from the one at t₀.
 */
export function legCrossing(traj, kink, fromLeg) {
  for (const r of traj) {
    if (legOf(r.u, kink) !== fromLeg) return { t: r.t, u: r.u, to: legOf(r.u, kink) };
  }
  return null;
}
