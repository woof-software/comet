// The supply floor: how little totalSupplyBase a market may hold and still accrue.
//
// Two numbers, and the distance between them is the whole question:
//
//   S_min    the smallest supply at which no revert site trips over the window
//   S_reach  the lowest supply a mass exit can actually leave behind
//
// S_reach follows from the accounting identity getReserves() = balance − S + B
// (:396-404). A withdrawal moves `balance` and S together and never touches R,
// and a token balance is never negative, so S >= B − R. Once B <= R the bound is
// vacuous: the market can be drained to dust — or to exactly zero.
//
// Zero is the exception on both sides. getSupplyRate returns 0 at S == 0 (:319)
// and getUtilization returns 0 (:365-366), so an empty market accrues fine; what
// bricks it is "almost empty". The safe set is therefore never a plain ray:
// {0} is safe, [S_reach, S_min) is reachable and fatal.
//
// Pure BigInt, no DOM — importable from Node for a CLI or a differential test.

import { FACTOR, IDX_SCALE, MAXES } from "./constants.mjs";
import { accrue, pv, utilization } from "./accrual.mjs";
import { runTrajectory } from "./trajectory.mjs";
import { uSafeMax } from "./thresholds.mjs";

export const U104 = 2n ** 104n - 1n;          // TotalsBasic.totalSupplyBase
const ceilDiv = (a, b) => (a + b - 1n) / b;

export const toPrincipal = (pvAmount, bsi) => ceilDiv(pvAmount * IDX_SCALE, bsi);

// The same market with a different supply. Reserves are what a withdrawal leaves
// alone, so R is held and cash is rebuilt from it — the mirror of params.mjs,
// which pins cash and lets R drift while the market accrues.
export const withSupply = (st, P, R, B0) => ({ ...st, supplyP: P, cash: R + pv(st.bsi, P) - B0 });

// First accrual in the window that reverts, or null if the window is survived.
// Deliberately cheaper than runTrajectory: the search calls this ~200 times and
// must not drag the 20 000-step halt hunt along with it.
export function firstHalt(cfg, st, dt, opt, steps) {
  let cur = st;
  for (let i = 0; i < steps; i++) {
    const r = accrue(cfg, cur, dt, opt);
    if (r.halted) return { at: cur.t + dt, step: i + 1, sites: r.sites.filter(s => s.trip) };
    cur = r.next;
  }
  return null;
}

/**
 * The floor itself: the smallest principal that survives `steps` accruals of
 * `dt`, plus any safe island below the rewards guard.
 *
 * Survival is monotone in P — more supply is less utilization is smaller
 * increments at every site — with exactly one seam: the `>= baseMinForRewards`
 * guard (:282) switches site 5 on with a jump. So this is two monotone searches,
 * not one, and a market can hold a safe dust window *below* the guard while the
 * band just above it is fatal.
 *
 * `rateP` (optional) is the analytic rate floor: nothing under it can ever be
 * safe, so it brackets the search. `hopeless` short-circuits the case where even
 * u = 0 overflows the rate type.
 */
export function searchFloor({ cfg, st, opt, dt, steps, R, B0, rateP = null, hopeless = false }) {
  if (hopeless) return { minP: null, island: null };
  const alive = (P) => firstHalt(cfg, withSupply(st, P, R, B0), dt, opt, steps) === null;
  // Bracket by doubling before bisecting: the floor usually sits a few octaves
  // above the analytic rate floor, and a blind bisection over uint104 pays ~104
  // window replays for every one of them.
  const smallestSafe = (lo, hi) => {
    if (lo > hi) return null;
    if (alive(lo)) return lo;
    let a = lo, b = lo * 2n;
    while (b < hi && !alive(b)) { a = b; b *= 2n; }
    if (b >= hi) { if (!alive(hi)) return null; b = hi; }
    while (b - a > 1n) { const mid = (a + b) / 2n; if (alive(mid)) b = mid; else a = mid; }
    return b;
  };

  // The seam exists only when site 5 can actually fire: with no supply speed the
  // rewards guard switches on an increment that is always zero.
  const seam = cfg.trackSupplySpeed > 0n && cfg.baseMinForRewards > 1n ? cfg.baseMinForRewards : 1n;
  const lowest = rateP !== null && rateP > 1n ? rateP : 1n;     // nothing below this is ever safe
  const above = smallestSafe(seam > lowest ? seam : lowest, U104);
  const below = seam === 1n ? null : smallestSafe(lowest, seam - 1n);

  // Contiguous when the guard point itself is safe; otherwise `below` is an island.
  const contiguous = below !== null && above === seam;
  return {
    minP: contiguous ? below : above,
    island: !contiguous && below !== null ? { from: below, to: seam } : null,
  };
}

/**
 * The same floor over a ladder of windows. One number invites the wrong reading
 * — "above this the market is safe" — when the honest statement is "above this
 * the market survives THIS long". The ladder puts the dependence on screen:
 * the next accrual costs dust, a year costs real money.
 */
export function floorLadder({ cfg, st, opt }, rungs) {
  const S0 = pv(st.bsi, st.supplyP);
  const B0 = pv(st.bbi, st.borrowP);
  const R = st.cash - S0 + B0;
  const uMax = uSafeMax(cfg, MAXES[opt.rateWidth]);
  const ratePv = B0 === 0n || uMax === null ? 0n : uMax < 0n ? null : B0 * FACTOR / (uMax + 1n) + 1n;
  const rateP = ratePv === null ? null : toPrincipal(ratePv, st.bsi);

  return rungs.map((rung) => {
    const { dt, steps } = rung;
    const { minP } = searchFloor({ cfg, st, opt, dt, steps, R, B0, rateP, hopeless: ratePv === null });
    const hit = minP === null || minP === 1n ? null
      : firstHalt(cfg, withSupply(st, minP - 1n, R, B0), dt, opt, steps);
    // the rung is carried through whole: callers label their own windows
    return { ...rung, minP, minPv: minP === null ? null : pv(st.bsi, minP), binding: hit?.sites ?? [] };
  });
}

/**
 * Everything the floor panel shows, from one state.
 *
 * `dt` × `steps` is the window the floor is measured against: S_min is the
 * smallest supply that survives it. A longer window can only raise the floor —
 * sites 3/4 compound, so a supply that lives through a day can still die in a
 * month.
 */
export function minSupplyReport({ cfg, st, opt, dt, steps }) {
  const S0 = pv(st.bsi, st.supplyP);
  const B0 = pv(st.bbi, st.borrowP);
  const R  = st.cash - S0 + B0;                       // reserves: untouched while lenders leave
  const reachPv = B0 > R ? B0 - R : 0n;               // cash runs out here
  const reachP  = toPrincipal(reachPv, st.bsi);

  // Analytic floor from the rate sites alone (1–2). Two jobs: it is shown next to
  // the searched floor, and it brackets the search — below it the rate leaves the
  // type on the very first accrual, so nothing under it can be safe.
  const uMax = uSafeMax(cfg, MAXES[opt.rateWidth]);
  const ratePv = B0 === 0n || uMax === null ? 0n
               : uMax < 0n ? null                     // even u = 0 overflows: no supply helps
               : B0 * FACTOR / (uMax + 1n) + 1n;      // smallest S with floor(B·1e18/S) <= uMax
  const rateP = ratePv === null ? null : toPrincipal(ratePv, st.bsi);

  const { minP, island } = searchFloor({ cfg, st, opt, dt, steps, R, B0, rateP, hopeless: ratePv === null });

  const minPv = minP === null ? null : pv(st.bsi, minP);
  // The floor buys the window, not eternity: at S_min the halt has simply moved
  // past the edge. Saying when it lands keeps the number from reading as "safe
  // above this forever" — null means the capped search found none.
  const haltAtMin = minP === null || opt.saturate ? null
    : runTrajectory(cfg, withSupply(st, minP, R, B0), dt, opt, steps).timeToHalt;
  // Which site sets the floor: what breaks one wei under it.
  const binding = minP !== null && minP > 1n
    ? (firstHalt(cfg, withSupply(st, minP - 1n, R, B0), dt, opt, steps)?.sites ?? [])
    : [];

  return {
    S0, B0, R,
    reachPv, reachP,
    ratePv, rateP, uMax,
    minP, minPv, binding, island, haltAtMin,
    hopeless: minP === null,                           // no supply at all survives the window
    unconstrained: minP === 1n,                        // every non-zero supply survives it
    uAtMin:   minP === null ? null : utilization(withSupply(st, minP, R, B0)),
    uAtReach: reachP === 0n ? null : utilization(withSupply(st, reachP, R, B0)),
    emptiable: B0 <= R,                                // a full exit to S = 0 is reachable
    // The reachable fatal band: supplies a mass exit can produce that cannot accrue.
    bandPv:   minPv === null ? null : (minPv > reachPv ? minPv - reachPv : 0n),
    // Room before the floor at today's borrow, or the shortfall if already under it.
    headroomPv:  minPv === null ? null : (S0 > minPv ? S0 - minPv : 0n),
    shortfallPv: minPv === null ? null : (minPv > S0 ? minPv - S0 : 0n),
  };
}
