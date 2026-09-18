# Formula audit: contract ↔ bench

**What was audited:** every expression on the accrual path in
[`contracts/CometWithExtendedAssetList.sol`](../../contracts/CometWithExtendedAssetList.sol)
against [`src/model/`](src/model).
**Code state:** `2e9f92d7` + the working tree. The uncommitted contract diff is two lines
in `supplyBase` (the `MAX_SUPPORTED_UTILIZATION` guard, :964) and does not touch the accrual path.
**Audited by hand:** 2026-09-09. This is a snapshot, not a guarantee — see "What this does not guarantee".

## 1. What matches verbatim

| Contract | Line | Bench | |
|---|---|---|---|
| `BASE_INDEX_SCALE = 1e15` | CometCore:69 | `IDX_SCALE` | ✅ |
| `FACTOR_SCALE = 1e18` | CometCore:75 | `FACTOR` | ✅ |
| `SECONDS_PER_YEAR = 31_536_000` | CometCore:63 | `SPY` | ✅ |
| `safe64: n > type(uint64).max → revert` | CometMath:19 | `MAXES[64]` | ✅ |
| `presentValueSupply/Borrow = p * idx / BASE_INDEX_SCALE` | CometCore:108,115 | `pv` | ✅ |
| `mulFactor = n * factor / FACTOR_SCALE` | :746 | `mulFactor` | ✅ |
| `divBaseWei = n * baseScale / baseWei` | :753 | `divBaseWei` | ✅ |
| `getUtilization`, including `S == 0 → 0` | :363–371 | `utilization` | ✅ |
| `getSupplyRate`: `totalSupplyBase == 0 → 0` | :319 | `supplyRate` | ✅ |
| `getSupplyRate`: the liquidity cut-off `u == 0 && base != 0 && PV_S >= balanceOf(this)` | :330 | `supplyRate` | ✅ |
| `getSupplyRate`: both branches of the curve, comparison `u <= supplyKink` | :333–338 | `supplyRate` | ✅ |
| `getBorrowRate`: `totalBorrowBase == 0 → 0` + both branches | :348–356 | `borrowRate` | ✅ |
| `perSecond = perYear / SECONDS_PER_YEAR` (integer division) | :155–161 | `perSec` in `params.mjs` | ✅ |
| `accruedInterestIndices`: `u` is computed **once** from the stored indices, and both rates come from that same `u` | :262–265 | `accrue` | ✅ |
| `index += safe64(mulFactor(index, rate * timeElapsed))` | :266–267 | sites 3/4 | ✅ |
| `trackingSupplyIndex += safe64(divBaseWei(speed * dt, totalSupplyBase))` under the `>= baseMinForRewards` guard | :281–283 | site 5 | ✅ |
| `trackingBorrowIndex += safe64(divBaseWei(speed * dt, totalBorrowBase))` under the `>= baseMinForRewards` guard | :284–286 | site 6 | ✅ *(added 2026-09-09)* |
| The revert is atomic: no field is written | — | `halted ⇒ next = st` | ✅ |

**`model/curve.mjs` ports nothing of its own.** The rate-curve panel reads the
same branch: the rate comes from `supplyRate`/`borrowRate` above, and the module
only splits it into the three terms the contract already adds up and names the
comparison that chose the leg. Two consequences are deliberate. The sum of the
terms is carried beside the audited rate and printed next to it, so a divergence
would be visible rather than silent. And the curve on the chart is drawn by
calling those same functions against a state whose only job is to clear the
early returns (`:319`, `:330`, `:348`) — there is no second copy of the formula
to drift from `accrual.mjs`.

**Rounding.** Solidity divides with truncation toward zero; `BigInt` does the
same. Every quantity on this path is non-negative, so there is no discrepancy in
the direction of rounding.

**`cash` vs `balanceOf(address(this))`.** The contract reads the token balance;
the bench takes `reserves` as input and pins `cash = R + S − B` at t₀ from the
identity `getReserves() = balance − S + B` (:396–404). The balance does not
change during accrual, so pinning it is correct: what drifts is `R`, not `cash`.

**Sites 3/4 — one comparison instead of two checks.** The contract checks twice:
`safe64` on the increment, then a checked `+=` on the `uint64` field. Since
`increment > max ⟹ index + increment > max`, a single comparison of the sum
gives the same verdict. The only difference is which number is shown: the bench
shows the sum, the contract will trip on the increment first.

## 2. What this audit fixed

**Site 6 was missing.** `trackingBorrowIndex += safe64(...)` (:285) is the sixth
revert point, and the bench did not check it: the increment was computed but
never compared against the type limit, and `tbi` was silently truncated. A
scenario that reverts exactly there in the contract would have been shown by the
bench as **LIVE**. That is a false negative in liveness — precisely what the
bench exists for. Fixed; the test builds a scenario where site 6 breaks the
accrual on its own.

**The bench accepted non-constructible markets.**
[`src/model/invariants.mjs`](src/model/invariants.mjs) was added: states the
contract cannot be in are now named out loud in a separate panel instead of
being silently computed.

| Check | Source |
|---|---|
| `baseMinForRewards == 0` → `BadMinimum()` | :126 |
| `decimals > 18` → `BadDecimals()` | CometCore:29 |
| `totalSupplyBase`/`totalBorrowBase`/`baseMinForRewards` do not fit in `uint104` | `CometStorage.TotalsBasic` |
| the indices do not fit in the chosen width | `TotalsBasic`, 1st slot |
| `baseSupplyIndex`/`baseBorrowIndex` below `BASE_INDEX_SCALE` | :217–218 (they start at 1e15 and only grow) |
| `cash = R + S − B < 0` | a token balance is non-negative |

A side effect: `divBaseWei` never divides by zero **in the contract** — the
`>= baseMinForRewards` guard plus `baseMinForRewards >= 1` from the constructor.
The `w === 0n ? 0n` guard in the bench stays, but it is now unreachable rather
than masking a discrepancy.

## 3. Deliberate deviations

These are not bugs — without them the bench would not work. But they are worth
knowing.

1. **The value before `safe64` is shown, not the revert.** The contract throws
   `InvalidUInt64`; the bench computes the quantity and compares it against the
   type limit. That is the whole point: you can see by how much the limit is
   exceeded.
2. **Exactly the current contract is modelled.** `opt` is pinned to
   `uint64`/`uint64`, `clamp = off`, `saturate = off` (`model/params.mjs`,
   `CONTRACT_OPT`) — exactly what is in the tree. Wider types, utilization
   clamping and saturation instead of reverting were toggles in the remediation
   panel; that panel is gone, and the code sits in `legacy/`, because it has no
   counterpart in Solidity.
3. **Time is driven by hand.** `getNowInternal()`/`lastAccrualTime` are not
   modelled: `timeElapsed` is set by the "Cadence" field, and how many times by
   the "Range" field. `lastAccrualTime` from the snapshot is shown in the
   provenance but does not reach the model: t₀ is the moment of the snapshot,
   not the moment of the last accrual.
4. **User actions are signed balance deltas, not function calls.**
   Two fields, `supply` and `reserves`; the sign picks the function:
   `supplyBase`/`withdrawBase` and a transfer to the market's address /
   `withdrawReserves`. They are reproduced in `model/actions.mjs` at the level
   of `totalSupplyBase` and the token balance, with `principalValueSupply`
   (`CometCore.sol:134`), and they land at t₀ without an `accrueInternal` of
   their own. Not modelled: collateral checks, the `MAX_SUPPORTED_UTILIZATION`
   guard (:964, :1104, :1217), `absorb`, liquidations, per-user balances.
   That is, the bench answers the question "will `accrueInternal` survive these
   moves", not "will the transaction itself go through".
5. **The multiplication `rate * timeElapsed`** reverts on `uint256` overflow in
   Solidity; `BigInt` does not. Reachable only at an absurd `dt`.

## 4. What this audit does not guarantee

It is **manual** and was done against one specific state of the tree. A change
to the rate model in Solidity will not break a single bench test — the bench
will simply start lying, silently. That is exactly the class of bug found above:
site 6 had been in the contract from the very beginning.

The only real guarantee is a **differential test**: running the same scenarios
through Foundry (a fixture that stands up a real Comet) and through
`src/model/`, comparing `getUtilization`, `getSupplyRate`, `getBorrowRate` and
both indices step by step. The model is already fit for that: `model/` has no
dependency on the DOM and imports into Node as is.
