// The intervention dose: how much base asset has to be supplied — and how much
// of the reserves may be taken back out — to keep a market off the right slope
// of its own borrow curve.
//
// Two levers, and they are not interchangeable:
//
//   X — base supplied by the intervener and never withdrawn. The only lever that
//       moves utilization: u = B/S (:363-367), and a supply is what raises S.
//   Y — reserves withdrawn (:1468). It moves the token balance, never S, so it
//       cannot touch u at all. What it buys back is capital, plus a cash bound
//       on how far a mass exit can go.
//
// The supply a mass exit leaves behind is exactly max(X, B − R'): either every
// other lender gets out and the intervener's own position is what remains, or
// cash runs dry first and the accounting bound S >= B − R' stops them. Under the
// policy this panel enforces — never lock the current lenders in — the second
// branch is dead by construction, so the floor is X and Y buys no liveness at
// all. That is not an opinion about Y; it is what the two formulas say.
//
// Reserves cannot reach the flat slope even in principle: utilization at the
// cash bound is B/(B − R') >= 1, and the kink is below 1 on every shipped
// market. Only supply can lower u. The panel prints both numbers so the claim
// is checkable rather than asserted.
//
// Pure BigInt, no DOM.

import { FACTOR } from "./constants.mjs";
import { accrue, pv, utilization, borrowRate } from "./accrual.mjs";
import { toPrincipal, withSupply } from "./minsupply.mjs";

// Hourly steps, ten years deep. The cadence barely matters — a market touched
// every 12 minutes halts within 1 % of the hourly answer — but the horizon does:
// a dose that works buys years, and a probe that only looks a month ahead would
// call every dose "safe" and rank none of them.
export const PROBE_DT = 3600n;
export const PROBE_CAP = 87_600;

// The variants table walks the same probe once per row, so it steps daily: at a
// multi-year horizon that lands within half a percent of the hourly answer and
// costs a twenty-fourth of it. The two headline numbers stay hourly.
export const TABLE_DT = 86_400n;
export const TABLE_CAP = 7_300;

/** First accrual that reverts, plus when utilization first leaves the flat slope. */
export function haltProbe(cfg, st, opt, dt = PROBE_DT, cap = PROBE_CAP) {
  let cur = st;
  let kinkAt = utilization(st) > cfg.borrowKink ? 0n : null;
  for (let i = 0; i < cap; i++) {
    const r = accrue(cfg, cur, dt, opt);
    if (r.halted) return { t: cur.t + dt, sites: r.sites.filter(s => s.trip), kinkAt, capped: false };
    cur = r.next;
    if (kinkAt === null && utilization(cur) > cfg.borrowKink) kinkAt = cur.t;
  }
  return { t: null, sites: [], kinkAt, capped: true };
}

/**
 * One dose evaluated end to end: the state it produces, the state a full exit
 * leaves behind it, and whether that second state is still on the flat slope.
 *
 * `X` and `Y` are present-value base units. The exit is the static endpoint, not
 * the path — legitimate here and only here: while the others leave, supply falls
 * monotonically towards X and utilization climbs monotonically towards its final
 * value, so the endpoint is the worst point. That argument fails the moment X is
 * too small to be the binding floor, which is exactly the case the table flags.
 */
export function evalDose({ cfg, st, opt, X, Y, S0, B0, R }, dt = PROBE_DT, cap = PROBE_CAP) {
  const Rn = R - Y;
  const cashN = st.cash + X - Y;                    // balance after supply, then withdrawal
  const reachPv = B0 > Rn ? B0 - Rn : 0n;           // cash bound: S >= B − R'
  const ourP = toPrincipal(X, st.bsi);
  const ourPv = pv(st.bsi, ourP);

  const oursBinds = ourPv >= reachPv;
  const floorPv = oursBinds ? ourPv : reachPv;
  const floorP = oursBinds ? ourP : toPrincipal(reachPv, st.bsi);

  // The market right after the dose, and the market a full exit would leave.
  const seated = withSupply(st, st.supplyP + ourP, Rn, B0);
  const post = withSupply(st, floorP, Rn, B0);
  const uPost = utilization(post);
  const uSeated = utilization(seated);

  // Draining to exactly zero is safe (:319, :365-366) but unreachable as a path:
  // every withdrawal accrues first, so the last lenders out walk the market
  // through the dust band and one of them reverts. Probing the empty state would
  // report a century of life for a market that bricks in minutes. With no borrow
  // there is no band to cross and no reason to say so.
  const emptiable = floorPv === 0n && B0 > 0n;
  const halt = emptiable ? null : haltProbe(cfg, post, opt, dt, cap);

  return {
    X, Y, Rn, cashN, reachPv, ourPv, floorPv, floorP, oursBinds, emptiable,
    seated, post, uPost, uSeated, halt,
    seatedP: st.supplyP + ourP,
    brPost: borrowRate(cfg, post, uPost).v,
    onFlat: uPost <= cfg.borrowKink,
    locked: cashN < S0 ? S0 - cashN : 0n,           // lenders' money that cannot leave
    net: X - Y,                                     // capital actually committed
  };
}

/** Everything the dose panel shows, from one state and one plan. */
export function doseReport({ cfg, st, opt, dose }) {
  const S0 = pv(st.bsi, st.supplyP);
  const B0 = pv(st.bbi, st.borrowP);
  const R = st.cash - S0 + B0;
  const base = { cfg, st, opt, S0, B0, R };

  // The deadline. supplyBase accrues before it credits anything (:948-950) and
  // withdrawReserves reads getReserves (:1471), which accrues too (:397). Both
  // levers stop working at the instant the market does, so the window for any
  // intervention at all is the market's own time to halt — and it is not a
  // scenario, it is the market left alone.
  const deadline = haltProbe(cfg, st, opt);

  // The threshold. getBorrowRate takes the flat branch at u <= borrowKink
  // (:349-353) and u is floor(B·1e18/S), so the smallest supply on the flat side
  // is the first integer above B·1e18/(kink+1).
  const needPv = B0 === 0n ? 0n : B0 * FACTOR / (cfg.borrowKink + 1n) + 1n;
  const needP = toPrincipal(needPv, st.bsi);

  const X = dose.X === null ? needPv : (dose.X > 0n ? dose.X : 0n);
  const Y = dose.Y > 0n ? dose.Y : 0n;
  const plan = evalDose({ ...base, X, Y });

  // What Y is allowed to be. Two ceilings, and the tighter one wins:
  //   withdrawReserves reverts above getReserves() (:1471-1472);
  //   and the policy: cash must still cover every lender who is not us.
  const yReserves = R > 0n ? R : 0n;
  const yLenders = st.cash + X - S0 > 0n ? st.cash + X - S0 : 0n;
  const yMax = yReserves < yLenders ? yReserves : yLenders;

  // Ranked alternatives. The X = 0 row is the point of the table: it is the
  // reserves-only plan, and it never reaches the flat slope.
  const marks = [
    { label: "plan", sub: "your number", X, plan: true },
    { label: "reserves only", sub: "X = 0 — the control row", X: 0n },
    { label: "minimum", sub: "u = kink exactly", X: needPv },
    { label: "+15 %", sub: "headroom for debt drift", X: needPv * 115n / 100n },
    { label: "+50 %", sub: "headroom for debt drift", X: needPv * 150n / 100n },
  ];
  // The plan is first in the list so that a plan which lands on one of the marks
  // swallows it instead of printing the same row twice under two names.
  const seen = new Set();
  const variants = marks.filter(m => {
    const k = m.X.toString();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map(m => ({ ...m, ...evalDose({ ...base, X: m.X, Y }, TABLE_DT, TABLE_CAP) }))
    .sort((a, b) => (a.X < b.X ? -1 : a.X > b.X ? 1 : 0));

  return {
    S0, B0, R, cash: st.cash,
    deadline, needPv, needP,
    // The same threshold under the opposite assumption: nobody else leaves. The
    // panel quotes the conservative one, but the gap between them is the whole
    // cost of assuming a total exit, so it is worth showing rather than hiding.
    needNowPv: needPv > S0 ? needPv - S0 : 0n,
    X, Y, plan, variants,
    yMax, yReserves, yLenders, yBinds: yReserves < yLenders ? "reserves" : "lenders",
    overY: Y > yMax,
    // Below the threshold the dose does not do the one thing it is for.
    shortPv: X < needPv ? needPv - X : 0n,
    marginPct: needPv === 0n ? null : Number((X - needPv) * 10000n / needPv) / 100,
    // Reserves alone, stated as a bound rather than as a result: the best floor
    // the cash lever can buy is B itself, at R' = 0, and u there is exactly 1.
    reservesCeilPv: B0,
    uAtReservesCeil: B0 === 0n ? 0n : FACTOR,
    noBorrow: B0 === 0n,
  };
}
