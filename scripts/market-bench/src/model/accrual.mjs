// A BigInt port of accrueInternal / getSupplyRate / getBorrowRate /
// getUtilization in contracts/CometWithExtendedAssetList.sol.
//
// Exact at the default widths (rate uint64, index uint64) — that is the shipped
// contract. Wider widths are hypotheticals with no Solidity counterpart: they
// model what the same arithmetic would do in a bigger field.
//
// Hand-kept: nothing checks this against the contract yet. Change the rate
// model in Solidity and the bench keeps showing the old one.

import { IDX_SCALE, FACTOR, MAXES } from "./constants.mjs";

export const pv        = (idx, p) => p * idx / IDX_SCALE;              // presentValueSupply / Borrow
export const mulFactor = (n, f)   => n * f / FACTOR;
const divBaseWei = (n, w, baseScale) => w === 0n ? 0n : n * baseScale / w;

export function utilization(st) {
  const S = pv(st.bsi, st.supplyP);
  const B = pv(st.bbi, st.borrowP);
  return S === 0n ? 0n : B * FACTOR / S;
}

// returns { v, early } — v is the PRE-safe64 value, so overflow is observable
export function supplyRate(cfg, st, u) {
  if (st.supplyP === 0n) return { v: 0n, early: "totalSupplyBase == 0" };
  if (u === 0n && cfg.sBase !== 0n && pv(st.bsi, st.supplyP) >= st.cash)
    return { v: 0n, early: "liquidity exhausted" };
  if (u <= cfg.supplyKink) return { v: cfg.sBase + mulFactor(cfg.sLow, u) };
  return { v: cfg.sBase + mulFactor(cfg.sLow, cfg.supplyKink) + mulFactor(cfg.sHigh, u - cfg.supplyKink) };
}
export function borrowRate(cfg, st, u) {
  if (st.borrowP === 0n) return { v: 0n, early: "totalBorrowBase == 0" };
  if (u <= cfg.borrowKink) return { v: cfg.bBase + mulFactor(cfg.bLow, u) };
  return { v: cfg.bBase + mulFactor(cfg.bLow, cfg.borrowKink) + mulFactor(cfg.bHigh, u - cfg.borrowKink) };
}

/**
 * Bring a stored snapshot up to the height it was read at.
 *
 * TotalsBasic is only current as of `lastAccrualTime`: every index in it is
 * stale by (blockTime − lastAccrualTime) seconds. The chain hides this —
 * getUtilization, getReserves and every present value accrue on the fly
 * (:397) — so a snapshot of the raw storage slots is NOT what the market
 * currently reads, and the next transaction of any kind will settle the gap
 * before doing anything else.
 *
 * So this is not a scenario and not a forecast. It is the same accrueInternal
 * the next caller pays for, run at the elapsed time the chain already owes.
 * Applying it is what makes t₀ the present rather than the last time somebody
 * happened to touch the market.
 *
 * A gap long enough to overflow an index reverts here — and that is the real
 * finding, not an error: the market is already wedged, and no transaction can
 * land on it at all.
 */
export function settle(cfg, st, opt, elapsed) {
  if (elapsed <= 0n) return { st, elapsed: 0n, applied: false, halted: false, sites: [], before: st };
  const r = accrue(cfg, st, elapsed, opt);
  return {
    // the window still starts at zero: the catch-up is history, not the run
    st: r.halted ? st : { ...r.next, t: 0n },
    elapsed, applied: !r.halted, halted: r.halted,
    sites: r.sites.filter(s => s.trip), before: st,
  };
}

// One accrueInternal(dt). Returns next state + per-site diagnostics.
export function accrue(cfg, st, dt, opt) {
  const rateMax = MAXES[opt.rateWidth], idxMax = MAXES[opt.idxWidth];
  const uTrue = utilization(st);
  const u = opt.clampOn && uTrue > opt.clampAt ? opt.clampAt : uTrue;

  const sr = supplyRate(cfg, st, u);
  const br = borrowRate(cfg, st, u);

  const sites = [];
  const push = (id, name, loc, value, limit) =>
    sites.push({ id, name, loc, value, limit, trip: value > limit });

  push(1, "Supply rate", "getSupplyRate :334/:337", sr.v, rateMax);
  push(2, "Borrow rate", "getBorrowRate :352/:355", br.v, rateMax);

  const srUse = sr.v > rateMax ? (opt.saturate ? rateMax : null) : sr.v;
  const brUse = br.v > rateMax ? (opt.saturate ? rateMax : null) : br.v;

  // Sites 3 / 4. The contract checks twice — safe64 on the increment (:266,:267)
  // and then the checked `+=` on the uint64 field — but inc > max implies
  // index + inc > max, so one comparison on the sum decides the revert the same
  // way. The number shown is the sum; the contract's first failing check is the
  // increment.
  const incS = srUse === null ? 0n : mulFactor(st.bsi, srUse * dt);
  const incB = brUse === null ? 0n : mulFactor(st.bbi, brUse * dt);
  push(3, "baseSupplyIndex growth", "accruedInterestIndices :266", st.bsi + incS, idxMax);
  push(4, "baseBorrowIndex growth", "accruedInterestIndices :267", st.bbi + incB, idxMax);

  // Sites 5 / 6. trackingSupplyIndex and trackingBorrowIndex are their own uint64
  // fields in the same slot (CometStorage.TotalsBasic), and each carries its own
  // safe64 — the borrow one is a revert site the contract really has, so it is
  // checked here too. divBaseWei never divides by zero on-chain: the guard is
  // `>= baseMinForRewards`, and the constructor rejects baseMinForRewards == 0.
  let incTS = 0n, incTB = 0n;
  if (st.supplyP >= cfg.baseMinForRewards) incTS = divBaseWei(cfg.trackSupplySpeed * dt, st.supplyP, cfg.baseScale);
  if (st.borrowP >= cfg.baseMinForRewards) incTB = divBaseWei(cfg.trackBorrowSpeed * dt, st.borrowP, cfg.baseScale);
  push(5, "trackingSupplyIndex growth", "accrueInternal :282", st.tsi + incTS, idxMax);
  push(6, "trackingBorrowIndex growth", "accrueInternal :285", st.tbi + incTB, idxMax);

  const tripped = sites.filter(s => s.trip);
  const halted = tripped.length > 0 && !opt.saturate;

  const clamp = (v, m) => v > m ? m : v;
  const next = halted ? st : {
    ...st,
    bsi: clamp(st.bsi + incS, idxMax),
    bbi: clamp(st.bbi + incB, idxMax),
    tsi: clamp(st.tsi + incTS, idxMax),
    tbi: clamp(st.tbi + incTB, idxMax),
    t: st.t + dt,
  };

  return { next, sites, halted, saturated: opt.saturate && tripped.length > 0,
           uTrue, u, sr, br, srUse, brUse, incS, incB };
}
