// A lender exit, one withdrawal per block.
//
// minsupply.mjs asks a static question — "which supply levels are alive" — and a
// mass exit is not a level, it is a path. The difference is not cosmetic: while
// lenders leave, utilization climbs, `baseBorrowIndex` compounds on every block,
// and present borrow grows faster than supply falls. So the exit halts at a
// LARGER residual than the single-step floor, and where exactly depends on the
// shape of the tail — on how much dust the last lenders leave behind.
//
// The contract's own sequence is reproduced: withdrawBase accrues first, then
// moves principal, then transfers out. A withdrawal can never pay out more than
// the market's cash, which is the accounting bound S >= B − R arriving one block
// at a time.

import { IDX_SCALE } from "./constants.mjs";
import { accrue, pv, utilization } from "./accrual.mjs";

const W_SCALE = 10n ** 12n;

/** Weights per lender, largest first. `profile` is used verbatim when given. */
export function shapeWeights(shape, count, profile) {
  if (profile?.length) return profile.map(BigInt);
  const n = Math.max(1, count);
  const w = [];
  for (let i = 1; i <= n; i++) {
    if (shape === "zipf") w.push(W_SCALE / BigInt(i));
    else if (shape === "zipf2") w.push(W_SCALE / BigInt(i * i));
    else w.push(W_SCALE);                                  // equal
  }
  return w;
}

/**
 * Split `supplyP` into per-lender principals in weight order. The rounding
 * remainder goes to the largest holder, where it is proportionally smallest —
 * never to the tail, whose size is exactly what decides the outcome.
 */
export function buildPlan(weights, supplyP) {
  const total = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n || supplyP <= 0n) return [];
  const plan = weights.map(w => supplyP * w / total);
  const assigned = plan.reduce((a, b) => a + b, 0n);
  if (plan.length) plan[0] += supplyP - assigned;
  return plan.filter(p => p > 0n);
}

/**
 * Run the exit. Returns a row per block plus the outcome:
 *   halt    — accrueInternal reverted; the market is wedged with dust supply
 *   stopped — "cash": the market ran out of tokens, the rest cannot leave
 *   drained — every lender got out; supply is the singular safe zero
 */
export function simulateExit({ cfg, st, opt, exit }) {
  const dt = exit.dt > 0n ? exit.dt : 12n;
  const weights = shapeWeights(exit.shape, exit.count, exit.weights);
  const plan = buildPlan(weights, st.supplyP);
  const bbi0 = st.bbi;
  const B = (s) => pv(s.bbi, s.borrowP);

  let cur = { ...st, t: 0n };
  const rows = [];
  let halt = null, stopped = null, out = 0n, peakU = 0n, satFired = false;

  for (let i = 0; i < plan.length; i++) {
    const r = accrue(cfg, cur, dt, opt);                   // withdrawBase accrues first
    if (r.halted) {
      halt = {
        lender: i + 1, t: cur.t + dt,
        supplyP: cur.supplyP, supplyPv: pv(cur.bsi, cur.supplyP),
        borrowPv: B(cur), u: utilization(cur),
        sites: r.sites.filter(s => s.trip),
        bbiGrowth: cur.bbi, left: plan.length - i,
        leftPv: plan.slice(i).reduce((a, p) => a + pv(cur.bsi, p), 0n),
      };
      break;
    }
    if (r.saturated) satFired = true;      // the mode being on is not the same as it firing
    cur = r.next;

    // the lender takes their whole balance — but a transfer cannot exceed cash
    let principal = plan[i] > cur.supplyP ? cur.supplyP : plan[i];
    let amount = pv(cur.bsi, principal);
    if (amount > cur.cash) { amount = cur.cash; principal = amount * IDX_SCALE / cur.bsi; }
    if (amount <= 0n) { stopped = "cash"; break; }

    cur = { ...cur, supplyP: cur.supplyP - principal, cash: cur.cash - amount };
    out += amount;
    const uNow = utilization(cur);
    if (uNow > peakU) peakU = uNow;
    rows.push({
      lender: i + 1, t: cur.t, amount,
      supplyP: cur.supplyP, supplyPv: pv(cur.bsi, cur.supplyP),
      borrowPv: B(cur), u: utilization(cur), bbi: cur.bbi, cash: cur.cash,
    });
  }

  return {
    plan, rows, halt, stopped, out, final: cur, dt, peakU,
    // weights that rounded to nothing are dropped: a share under one wei of
    // principal is not a lender, and pretending otherwise miscounts the tail
    requested: weights.length,
    bbi0, bbiEnd: cur.bbi,
    drained: halt === null && stopped === null,
    saturated: satFired,
  };
}
