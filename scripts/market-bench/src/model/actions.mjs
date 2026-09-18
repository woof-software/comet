// User actions layered on top of an on-chain snapshot.
//
// The bench shows a market exactly as the chain holds it; these two numbers are
// what somebody would do to it next. Both are SIGNED present value in base
// units — plus puts money in, minus takes it out — and both land at t₀, before
// the first accrueInternal of the window.
//
// Where each sign goes, in the contract's own terms:
//
//   supply   > 0   supplyBase (:948)          balance +X, S +X   → R unchanged
//            < 0   withdrawBase (:1196)       balance −W, S −W   → R unchanged
//   reserves > 0   plain token transfer in    balance +Z         → R +Z
//            < 0   withdrawReserves (:1468)   balance −Y         → R −Y
//
// getReserves() = balance − S + B (:396-404), so the supply lever moves cash and
// S together and leaves R alone, while the reserves lever moves cash alone and
// leaves S alone. That asymmetry is why they are two fields and not one:
// u = B/S (:363-367), so **only the supply lever can move utilization.**
//
// Pure BigInt, no DOM. Notes are structured codes, never sentences — wording
// belongs to ui/, so this module stays importable from Node.

import { IDX_SCALE } from "./constants.mjs";
import { pv } from "./accrual.mjs";

// principalValueSupply floors (CometCore.sol:134). Converting the whole supply
// side once — rather than the delta — is what the contract does per balance:
// updateBaseBalance stores principalValue(presentValue(p) ± amount), so the
// rounding happens on the new total, not on the amount.
const toSupplyPrincipal = (pvAmount, bsi) => (pvAmount > 0n ? pvAmount * IDX_SCALE / bsi : 0n);

export const ZERO_ACTIONS = Object.freeze({ supply: 0n, reserves: 0n });

export const anyActions = (a) => a.supply !== 0n || a.reserves !== 0n;

/**
 * Apply the plan to a state and report what the protocol would have refused.
 *
 * Deposits land before withdrawals, which is both the safe order and the
 * protocol's: doTransferOut pays from `balance`, and before the deposit that
 * balance is smaller — a withdrawal sequenced first simply reverts.
 *
 * A withdrawal larger than the market can pay is capped rather than allowed to
 * produce a state no chain could hold: negative supply, or reserves drawn out of
 * an empty balance. Every cap leaves a note naming what bound it.
 */
export function applyActions(st, a) {
  const S0 = pv(st.bsi, st.supplyP);
  const B0 = pv(st.bbi, st.borrowP);
  const R0 = st.cash - S0 + B0;

  const notes = [];
  const pos = (v) => (v > 0n ? v : 0n);
  const cap = (want, ceiling, code) => {
    const lid = pos(ceiling);
    if (want <= lid) return want;
    notes.push({ code, want, cap: lid });
    return lid;
  };

  // One signed field per lever, split here into its two directions — because the
  // two directions are bounded by completely different things.
  const supplyIn = pos(a.supply);
  const reservesIn = pos(a.reserves);

  let cash = st.cash + supplyIn + reservesIn;
  const supplyAfterIn = S0 + supplyIn;

  // withdrawBase cannot hand out supply that is not there, and cannot hand out
  // tokens the market does not hold: `cash` is the token balance, and the
  // borrowers are holding the rest.
  let supplyOut = cap(pos(-a.supply), supplyAfterIn, "supplyOutOverSupply");
  supplyOut = cap(supplyOut, cash, "supplyOutOverCash");
  cash -= supplyOut;

  // withdrawReserves reverts above getReserves() (:1471-1472) — and even inside
  // it, the transfer still has to come out of the balance, which is the tighter
  // bound whenever B > S.
  const reservesAfterIn = R0 + reservesIn;
  let reservesOut = cap(pos(-a.reserves), reservesAfterIn, "reservesOutOverReserves");
  reservesOut = cap(reservesOut, cash, "reservesOutOverCash");
  cash -= reservesOut;

  // Converting an untouched supply back through principalValueSupply would floor
  // away a wei and quietly move utilization — so an empty plan is an exact no-op.
  const S1 = supplyAfterIn - supplyOut;
  const supplyP = (supplyIn > 0n || supplyOut > 0n) ? toSupplyPrincipal(S1, st.bsi) : st.supplyP;
  const next = { ...st, supplyP, cash };

  const S = pv(st.bsi, supplyP);
  const R = cash - S + B0;

  // A market left with dust against a live borrow is the fatal band itself: the
  // state is reachable, it is just fatal. Say it here, where the action that
  // produced it is still in hand.
  if (S === 0n && B0 > 0n) notes.push({ code: "drainedWithBorrow" });

  return {
    st: next,
    // Signed again on the way out, and capped: what the market actually took.
    applied: { supply: supplyIn - supplyOut, reserves: reservesIn - reservesOut },
    requested: { supply: a.supply, reserves: a.reserves },
    notes,
    before: { S: S0, B: B0, R: R0, cash: st.cash },
    after: { S, B: B0, R, cash },
  };
}
