# KF-02 — Dust base supply against a funded borrow halts accrual permanently

**Witness:** `CometKF02AccrualHalt.t.sol` → `test_KF02_dustSupplyAgainstFundedBorrowHaltsAccrualIrreversibly`
**Verification:** `CometKF02Verify.t.sol` (6 tests) · **Fixture:** `CometKF02Fixture.sol`
**Verified against:** commit `7eb1be82`, branch `feat/service-patch`
**Provenance:** an invariant campaign that is not part of this change set — [§10](#10-provenance)

All line references are to `contracts/CometWithExtendedAssetList.sol` unless stated.

**Scope.** This document records what the finding *is* and how to reproduce it.
It proposes no fix and contains no patch: remediation is a decision for the
protocol team and is tracked separately.

---

## Evidence markers

Every claim carries one of three markers. Nothing is stated without one.

| Marker | Meaning |
|---|---|
| **[VERIFIED BY TEST]** | A named test in this repository executes the claim and passes. The test is named at the point of use. |
| **[VERIFIED BY CODE]** | Not executed by any test — established by reading the contract at the cited line on commit `7eb1be82`, or by arithmetic over constants read there. |
| **[HYPOTHESIS]** | Plausible from the code, **not** demonstrated here. Neither a test nor a reading proves it. What would prove it is stated. |

> **[VERIFIED BY CODE]** is a reading, not an execution — treat it as weaker
> evidence than a test. A **[HYPOTHESIS]** must not be cited as a finding or
> quoted in a severity rating until it is promoted.

---

## Summary

**[VERIFIED BY TEST]** — witness test

A market that holds base cash but has **no base supplier** can be pushed into a
state where accrual reverts on **every** subsequent action — supply, withdraw,
absorb, liquidation — with no way out. The trigger is a **single 2-wei base
supply** against an outstanding borrow.

The rate itself is wrapped in `safe64` and utilization has no upper clamp. With
`totalSupplyBase` at a few wei against a real borrow, utilization reaches
~1.9e27, the rate exceeds `uint64`, and `safe64` reverts inside `accrueInternal`.

**[VERIFIED BY TEST]** — `test_lenderWithdrawToDustBypassesGuardAndHaltsAccrual`

`MAX_SUPPORTED_UTILIZATION = 2e18` (`:114`) does **not** close this: it is
enforced at two lines, both inside the borrower branch — [§5](#5-why-the-new-ceiling-does-not-close-it).

---

## 1. Where it reverts

**[VERIFIED BY CODE]** — read at the cited lines.

Every base mutation calls `accrueInternal` first, so all paths funnel through it.

| Step | Location | Code |
|---|---|---|
| Accrual entry | `:276` `accrueInternal()` | calls `accruedInterestIndices(timeElapsed)` when `timeElapsed > 0` |
| Rate lookup | `:259-271` `accruedInterestIndices` | `supplyRate = getSupplyRate(utilization)` |
| **Overflow site 1 — rate** | `:334` / `:337` `getSupplyRate` | `safe64(base + slopeLow·kink + slopeHigh·(u − kink))` — **no clamp on `u`** |
| (borrow side) | `:352` / `:355` `getBorrowRate` | same shape, same exposure |
| **Overflow site 2 — index** | `:266-267` | `baseSupplyIndex_ += safe64(mulFactor(baseSupplyIndex_, supplyRate * timeElapsed))` — [§4.2](#42-index-overflow) |
| Revert | `CometMath.sol:19-20` `safe64` | `if (n > type(uint64).max) revert InvalidUInt64();` |

---

## 2. Why the dust supply itself succeeds

**[VERIFIED BY TEST]** — the trigger call succeeds inside the witness test before
any assertion fires. Mechanism read at `:948-962`.

The trigger does not revert — it *arms* the trap. `supplyBase` runs
`doTransferIn` and `accrueInternal` **before** writing the new principal, so
utilization is still priced on `totalSupplyBase == 0` and accrual passes. Only
afterwards does the dust principal exist. Every accrual from the next block on
prices utilization against it and reverts.

The supply rate is `0` while supply is `0`, so `baseSupplyIndex` never grows in
the borrow-only phase and a 2-wei present value maps to a 1–2 wei principal.

---

## 3. Scenario with numbers

**[VERIFIED BY TEST]** — `test_evidence_reportNumbers` emits every figure below.

Fixture supply curve:

```
supplyKink            = 0.8e18
slopeLow  (per sec)   = 0.04e18 / SECONDS_PER_YEAR = 1_268_391_679
slopeHigh (per sec)   = 0.40e18 / SECONDS_PER_YEAR = 12_683_916_793
supplyPerSecondBase   = 0
uint64 max            = 18_446_744_073_709_551_615  (1.845e19)
```

1. The market holds `INITIAL_BASE_LIQUIDITY = 20_000e6` of cash. A borrower posts
   collateral and `withdraw(base, 3776e6)` → `totalBorrowBase = 3_776_000_000`,
   `totalSupplyBase = 0`, `getUtilization() == 0`. **Market healthy.**
2. Any actor calls `supply(base, 2)` — succeeds, per §2. `totalSupplyBase = 2`.
3. The next accrual computes:

```
utilization = 3_776_000_071 × 1e18 / 2
            = 1_888_000_035_500_000_000_000_000_000        (1.888e27)

supplyRate  = slopeLow·kink/1e18 + slopeHigh·(u − kink)/1e18
            = 23_947_235_346_330_626_060                   (2.3947e19 = 129 % of uint64 max)

safe64(2.3947e19)  →  revert InvalidUInt64()
```

4. Every base action now reverts, `supply(base, 1000e6)` included, because that
   path must accrue first. **The market is permanently wedged.**

The overflow is in the rate, not the index, so no time jump is required — any
`timeElapsed > 0` triggers it.

---

## 4. Overflow thresholds

### 4.1 Rate overflow

**[VERIFIED BY CODE]** — arithmetic over the constants in §3.

The supply rate crosses `uint64` at `utilization > 1.4543e27`. At `supplyPV = 2
wei` that needs `borrow ≥ 2_908_682_607` (≈2908.7 USDC). The witnessed state
(3776 USDC, `util = 1.888e27`) clears it by ~30 %.

### 4.2 Index overflow

**[VERIFIED BY TEST]** — `test_probe_dustThreshold`.

§4.1 is **not** the safe/unsafe boundary. Below it the rate still returns, but
`baseSupplyIndex` compounds it and crosses `uint64` at `:266` within minutes.
Measured against a fixed 1900 USDC borrow:

| Residual supply | Base units | Utilization | × ceiling | Outcome |
|---|---:|---:|---:|---|
| 1000 USDC | 1 000 000 000 | `1.90e18` | 0.95× | survived 200 min |
| 1 USDC | 1 000 000 | `1.90e21` | 950× | survived 200 min |
| 0.001 USDC | 1 000 | `1.90e24` | 950 000× | **halt after 480 s** |
| 10 wei | 10 | `1.90e26` | 9.5e7× | **halt after 120 s** |
| 2 wei | 2 | `9.50e26` | 4.8e8× | **halt after 120 s** |
| 1 wei | 1 | `1.90e27` | 9.5e8× | **halt after 60 s** |

The fatal region starts at **0.001 USDC** of residual supply, not at 1–2 wei —
and states in that band pass the witness test's own precondition self-check
(`_supplyRateModel(util) > uint64.max`) while still bricking the market. Note the
`× ceiling` column: survival is decided by whether the 64-bit index happens to
overflow, not by any protocol rule.

---

## 5. Why the new ceiling does not close it

**[VERIFIED BY TEST]** — `test_control_borrowPathGuardIsEnforced` and
`test_lenderWithdrawToDustBypassesGuardAndHaltsAccrual`.

Utilization is a ratio; the patch guards the numerator only.
`ExceedsSupportedUtilization` is reverted from exactly two lines, both inside the
`if (srcBalance < 0)` borrower branch:

```text
  GUARDED — the borrow side ...................... both checks live here
      withdrawBase :1215   if (srcBalance < 0) ...  util <= 2e18  ok
      transferBase :1102   if (srcBalance < 0) ...  util <= 2e18  ok

  UNGUARDED — the supply side .................... nothing checks here
      supplyBase   :948    totalSupplyBase += ....  (no check)
      withdrawBase :1216   else { lender exit } ...  (no check)

                                  |  both reach the same code
                                  v

      getUtilization()  -->  getSupplyRate()  -->  safe64( 2.39e19 )
      0 when supply == 0      no clamp on input     uint64 max = 1.8447e19
                                                    -> revert InvalidUInt64
```

Control A confirms the guard works where it is placed: a 2500 USDC borrow against
1000 USDC of supply reverts as intended. Three gaps remain.

**G1 — `supplyBase` (`:948-969`) has no check at all.** It writes
`totalSupplyBase += supplyAmount` on the assumption that supplying can only lower
utilization. That holds except at the transition from zero, where utilization
jumps from `0` to an unbounded ratio in one call. There is also no minimum supply
amount, unlike the borrow side's `baseBorrowMin`.

**G2 — the lender branch of `withdrawBase` (`:1216-1218`) is unguarded.** The
`else` branch asserts only the pause flag, so a lender can walk total supply down
to dust while borrows are outstanding, provided reserves cover the payout.
`test_lenderWithdrawToDustBypassesGuardAndHaltsAccrual` reaches the halt this way
on an ordinary market — real lender, real borrow, utilization `1.9e18` at every
step — ending at `1_903_123_287_000_000_000_000_000_000`.

**G3 — `getUtilization()` (`:363-371`) returns `0` when supply is `0`.** The
borrow-side check at `:1215` reads that value, so a market with cash, live
borrows and no lenders looks 0 % utilized, and a borrow of any size passes the
ceiling it is supposed to be measured against.

---

## 6. Generality

### 6.1 Not a fixture artifact

**[VERIFIED BY CODE]** — `:334`, `:337`, `:352`, `:355`.

`safe64` is applied to a value derived from an unclamped `utilization` argument
under **any** configuration. No configuration removes the overflow; it only moves
the utilization at which it occurs, and a steeper `slopeHigh` or higher `kink`
moves it *down*.

### 6.2 Reachability from a market with a large existing supply

**[HYPOTHESIS]**

Every test here starts from a small base supply: the witness at
`totalSupplyBase == 0`, Control B at 1000 USDC with a single lender who exits.
Whether the halt is reachable on a market carrying a large supply spread across
many holders is not demonstrated — that needs `totalSupplyBase` driven into the
§4.2 band, which no test models.

**To promote:** a test seeding several independent suppliers with a realistic
total that still reaches a halted accrual through permissionless calls. A
negative result is equally useful — it would bound the finding to thin or
newly-seeded markets.

---

## 7. Impact

**[VERIFIED BY TEST]** — Control B asserts the supply and withdraw reverts;
Control C asserts the absorb revert.
**[VERIFIED BY CODE]** — the remaining paths, read at the cited lines.

Once accrual reverts the market is inert. Suppliers cannot withdraw, borrowers
cannot repay (repayment routes through `supplyBase`), collateral is stranded
(`accrueAccountInternal`), and positions cannot be liquidated — `absorb` accrues
at `:1276`, so Control C's underwater borrower cannot be seized at any price.
That last case is a direct violation of the D-1 property: an absorb that passes
its precheck must never revert.

`buyCollateral` (`:1394`) and `withdrawReserves` (`:1466`) still execute, since
neither accrues, but neither helps — `buyCollateral` credits reserves rather than
`totalSupplyBase` and cannot move utilization; `withdrawReserves` only drains
cash. **No sequence of user or governor calls restores accrual.** The state is
recoverable only by replacing the implementation behind the proxy.

---

## 8. Severity

**Critical for a thin or newly-seeded market. Unrated for a mature one** — the
second case rests on §6.2, a [HYPOTHESIS], and must not be folded into the rating
until demonstrated.

| Component | Marker | Basis |
|---|---|---|
| The freeze is total | **[VERIFIED BY TEST]** | §7 |
| The freeze is permanent | **[VERIFIED BY CODE]** | §7 — every recovery path accrues first |
| No privilege, no price manipulation needed | **[VERIFIED BY TEST]** | the witness uses only `supply` and `withdraw` |
| Reachable on a market with many suppliers | **[HYPOTHESIS]** | §6.2 |

Funds are not extractable by the attacker — this is griefing, not theft — but
they are equally not recoverable by their owners.

**Cost to the attacker.** **[HYPOTHESIS]** for the minimal form: post one
collateral, borrow `baseBorrowMin` (`100e6` in the fixture), supply 1 wei. The
attacker's own collateral freezes too, so the cost is roughly the
over-collateralisation on a 100 USDC borrow. No test drives that variant — the
witness posts three collaterals and borrows 3776 USDC.
**To promote:** a test that halts the market from one collateral position at
`baseBorrowMin` and records the collateral left frozen.

---

## 9. Scenario E — reserve-funded borrows are priced at the base rate

**[VERIFIED BY TEST]** — `test_evidence_zeroSupplyBorrowPricedAtBaseRateOnly`.

A **separate finding**: not a denial of service, no overflow, but the same root
cause as G3.

`getBorrowRate` (`:346`) returns early only when `totalBorrowBase == 0`. With a
live borrow and `totalSupplyBase == 0` it receives `utilization = 0`, takes the
`utilization <= borrowKink` branch, and returns the bare
`borrowPerSecondInterestRateBase` regardless of borrow size — while the borrow
itself is funded entirely by reserves.

Measured in the same state as the witness test's phase 1:

| Quantity | Value |
|---|---|
| Borrow drawn from reserves | `3_776_000_000` (3776 USDC) |
| Rate charged (per second, 1e18) | `317_097_919` — exactly `borrowPerSecondInterestRateBase` |
| APR charged | `9_999_999_973_584_000` ≈ **1.00 %** |
| APR the curve charges at `util = 1.9e18` | `599_999_999_928_768_000` ≈ **60.0 %** |

The same borrow is priced at **1.00 %** where the curve's own shape yields
**60.0 %** — a ~60× gap.

**[HYPOTHESIS]** — the economic impact is not modelled. Cheap reserve drainage is
the obvious concern, but whether it is materially exploitable depends on
collateral cost, reserve size and how long a market stays without suppliers.
**To promote:** a test quantifying reserve depletion against interest collected
at a realistic `targetReserves`.

---

## 10. Provenance

**[HYPOTHESIS]**

The invariant campaign that originally surfaced this state is **not part of this
change set** — no handler, no ghost variables, no persisted corpus. Nothing about
the run is verifiable from what is committed here: how the fuzzer reached the
state, whether the harness precheck computes the accrual step in plain `uint256`
and therefore cannot see a rate overflow, or why the accrual-liveness property
did not fail on the same seed.

**To promote:** land the invariant suite and its failing corpus entry, or re-run
the campaign and record the seed. The finding does not depend on any of it — the
deterministic witness stands on its own.

---

## 11. Reproduce

```
forge test --match-contract CometKF02AccrualHaltTest -vv   # witness   (1 test)
forge test --match-contract CometKF02VerifyTest      -vv   # verification (6 tests)
```

`CometKF02Fixture` deploys a 24-asset market — `supplyKink 0.8e18`, supply
`slopeHigh 0.4e18/yr`, borrow `0.5e18/yr` — seeded with 20 000 USDC of reserves
and no base supplier.

| Test | Establishes |
|---|---|
| `test_KF02_dustSupplyAgainstFundedBorrowHaltsAccrualIrreversibly` | Witness — §3 |
| `test_control_borrowPathGuardIsEnforced` | Control A — the ceiling works where placed, §5 |
| `test_lenderWithdrawToDustBypassesGuardAndHaltsAccrual` | Control B — G2, §5 |
| `test_absorbIsBlockedAfterHalt` | Control C — D-1 violated, §7 |
| `test_probe_dustThreshold` | Control D — the frontier, §4.2 |
| `test_evidence_reportNumbers` | Figures for §3 and §4.1 |
| `test_evidence_zeroSupplyBorrowPricedAtBaseRateOnly` | Scenario E — §9 |

The witness is falsifiable: on a guarded contract its precondition self-check
fails before any `expectRevert` is reached.

### Open items

| Item | What is needed |
|---|---|
| Reachability from a large multi-supplier market (§6.2) | a test seeding several independent suppliers that still halts |
| Minimal attacker cost (§8) | a test halting the market from one collateral at `baseBorrowMin` |
| Economic impact of scenario E (§9) | reserve-depletion model against interest collected |
| Fuzzer provenance (§10) | land the invariant suite and its corpus, or re-run and record the seed |
