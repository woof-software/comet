// States the contract cannot be in.
//
// Copying the formulas is only half of fidelity: the bench must also refuse to
// present a market Comet could never hold — a configuration its constructor
// rejects, or a value wider than the field it is stored in. Every check cites
// the line that enforces it.

import { IDX_SCALE, MAXES } from "./constants.mjs";

const U104 = 2n ** 104n - 1n;              // TotalsBasic principal fields
const MAX_BASE_DECIMALS = 18;              // CometCore.sol:29

export function checkInvariants({ cfg, st, opt }) {
  const out = [];
  const bad = (field, message) => out.push({ field, message });

  // --- constructor sanity checks: a market failing these never deploys
  if (cfg.baseMinForRewards === 0n)
    bad("baseMinForRewards", "constructor reverts with BadMinimum() at 0 — CometWithExtendedAssetList.sol:126");
  if (cfg.decimals > MAX_BASE_DECIMALS)
    bad("decimals", `constructor reverts with BadDecimals() above MAX_BASE_DECIMALS = ${MAX_BASE_DECIMALS} — CometCore.sol:29`);

  // --- storage widths: TotalsBasic packs principal into uint104, indices into uint64
  if (st.supplyP > U104) bad("totalSupplyBase", "does not fit in uint104 — CometStorage.TotalsBasic");
  if (st.borrowP > U104) bad("totalBorrowBase", "does not fit in uint104 — CometStorage.TotalsBasic");
  if (cfg.baseMinForRewards > U104) bad("baseMinForRewards", "does not fit in uint104");

  // Indices are checked against the width chosen in the remediation panel: at the
  // default 64 that is the shipped field, wider is the hypothetical being explored.
  const idxMax = MAXES[opt.idxWidth];
  for (const [field, v] of [["baseSupplyIndex", st.bsi], ["baseBorrowIndex", st.bbi],
                            ["trackingSupplyIndex", st.tsi], ["trackingBorrowIndex", st.tbi]]) {
    if (v > idxMax) bad(field, `does not fit in uint${opt.idxWidth}`);
  }
  // Both base indices start at BASE_INDEX_SCALE (:217-218) and only ever grow.
  if (st.bsi < IDX_SCALE) bad("baseSupplyIndex", "below BASE_INDEX_SCALE = 1e15 — the index only grows from its start");
  if (st.bbi < IDX_SCALE) bad("baseBorrowIndex", "below BASE_INDEX_SCALE = 1e15 — the index only grows from its start");

  // getReserves() = balance − S + B, and a token balance is never negative.
  if (st.cash < 0n) bad("reserves", "cash = R + S − B < 0: a token balance is never negative");

  return out;
}
