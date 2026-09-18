// Solved, not searched: the utilization at which a rate leaves the type.

import { FACTOR } from "./constants.mjs";
import { mulFactor } from "./accrual.mjs";

// smallest utilization at which a two-slope curve exceeds `limit`, or null when
// the curve never leaves the type. Shape matches getSupplyRate / getBorrowRate:
// base + low·u below the kink, plus high·(u − kink) above it.
export function uCritCurve({ base, low, high, kink }, limit) {
  const atKink = base + mulFactor(low, kink);
  if (atKink > limit) {
    if (low === 0n) return null;
    const need = limit - base;
    if (need < 0n) return 0n;
    return need * FACTOR / low + 1n;
  }
  if (high === 0n) return null;
  return kink + (limit - atKink) * FACTOR / high + 1n;
}

export const uCrit = (cfg, limit) =>          // supply curve — the historical name
  uCritCurve({ base: cfg.sBase, low: cfg.sLow, high: cfg.sHigh, kink: cfg.supplyKink }, limit);

export const uCritBorrow = (cfg, limit) =>
  uCritCurve({ base: cfg.bBase, low: cfg.bLow, high: cfg.bHigh, kink: cfg.borrowKink }, limit);

// The largest utilization both rates survive: one below the earlier of the two
// crossings. null means neither curve ever leaves the type.
export function uSafeMax(cfg, limit) {
  const a = uCrit(cfg, limit), b = uCritBorrow(cfg, limit);
  if (a === null && b === null) return null;
  const first = a === null ? b : b === null ? a : (a < b ? a : b);
  return first - 1n;
}
