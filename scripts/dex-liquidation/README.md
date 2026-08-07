# DEX Liquidation — position setup, planning & execution scripts

Operational scripts for exercising a Comet **DEX liquidation** end-to-end on Ethereum mainnet: open an
underwater position across one or more collaterals, see exactly how it will be liquidated (routes +
amounts), and execute it through a Gnosis Safe.

## Two ways to execute — pick a route

The DEX module seizes collateral and swaps it to base through the adapter. The adapter has two paths, and
they differ in **timestamp sensitivity**:

- **Uniswap route** (`ROUTE = 'uniswap'` → `swapData = ['0x']`) — the adapter swaps its *actual* seized
  balance on Uniswap on-chain. There is **no pinned amount**, so the liquidate works at **any timestamp**.
  → Execute the Safe tx normally (Safe UI / any block). **You do not need `liquidate-at-slot.ts`.**
- **1inch route** (`ROUTE = 'oneinch'`) — the 1inch `swapData` bakes in an *exact* input amount computed
  for one timestamp `T`. The adapter enforces `amountIn == desc.amount` (`InvalidAmountIn`), and the seized
  amount drifts every block as the debt accrues interest — so it is valid **only in the slot whose
  `block.timestamp == T`**. → Must be landed in that exact slot via `liquidate-at-slot.ts` (a Flashbots
  bundle bounded to `minTimestamp == maxTimestamp == T`). Better pricing, more moving parts.

For manual/one-off runs, the **Uniswap route is the simple default**. Use the 1inch route only when you
want its pricing and are willing to run the slot-targeted submitter. Full rationale for the slot targeting:
[`../../slot-targeted-safe-execution.md`](../../slot-targeted-safe-execution.md).

## The scripts

| # | Script | Role |
|---|--------|------|
| 1 | `create-borrow-position.ts` | Open an underwater position: supply one or more collaterals, borrow, and drop all their feeds. |
| 2 | `seizure-plan-at.ts` | Report the position; if liquidatable, show how it liquidates (routes + amounts) and emit the `liquidate` calldata (+ target slot `T` for the 1inch route). If **not** liquidatable, print the exact per-feed price drop to apply. |
| 3 | `liquidate-at-slot.ts` | **1inch route only** — submit the pre-signed Safe `execTransaction` as a builder bundle bounded to slot `T`. |

```
 [1] create-borrow-position ─▶ underwater account (supply N collaterals, borrow, drop all feeds)
                                    │
 [2] seizure-plan-at ───────▶ position report + routes/amounts + liquidate calldata (+ T)
                                    │
        Safe: build tx (to=MODULE, value 0, data), owners SIGN — do NOT execute
                                    │
             ┌──────────────────────┴───────────────────────────┐
   Uniswap route (ROUTE='uniswap')                    1inch route (ROUTE='oneinch')
   execute the Safe tx any time (Safe UI)     [3] liquidate-at-slot ─▶ lands in slot T
                                    │
        restore the collateral feed prices
```

## Prerequisites

- `yarn install` (repo `ethers` v5, `dotenv`). Run scripts with `npx ts-node` (below).
- A **Safe** whose owners can sign, holding (or authorized for) the executor role on the liquidation module.
- The **borrower** account must: be an admin of **every** collateral price feed it drops; hold the
  collateral; and hold **no base** (a fresh account). Base liquidity must be seeded **separately in advance**
  from a different account.
- 1inch route only: a funded **1inch** developer API key, and (for slot targeting) an executor EOA + a
  Flashbots auth key.
- Confirm the on-chain addresses in the script constants, and that `SEIZURE_VIEW` is bound to the current
  `MODULE`/`COMET` (a stale view reverts `NotLiquidatable`).

### Environment (`.env` at repo root — auto-loaded via `dotenv`)

| Var | Used by | Notes |
|-----|---------|-------|
| `RPC_URL` | all | Full mainnet node (reads + submissions). |
| `BORROWER_KEY` | 1 | Signs supply/borrow/`setPrice`. Holds the collateral(s) and **no base**; is the feeds' admin. |
| `ONEINCH_API_KEY` | 2 | 1inch v6 quote key — only when `ROUTE = 'oneinch'`. |
| `EXECUTOR_KEY` | 3 | Pays gas only; **no** relationship to the Safe. Needs ≈ `GAS_LIMIT × maxFee` ETH. |
| `FB_AUTH_KEY` | 3 | Flashbots reputation key — signs the `X-Flashbots-Signature` header only. **Must hold zero funds.** |

Config lives in `.env` and in the constants at the top of each script, so no inline env vars are needed.
Run with (no `--network` — each script builds its own provider from `RPC_URL`):

```bash
npx ts-node scripts/dex-liquidation/<script>.ts
```

---

## Step-by-step

### Step 1 — Open the underwater position

Edit the constants at the top of `create-borrow-position.ts`:

- `COLLATERALS` — a **list** of `{ address, amount }` (human units). Add as many as you want; set an entry's
  `amount` to `'0'` to skip supplying it but still borrow against an existing balance.
- `SUPPLY_COLLATERAL` — `true` to supply the amounts first, `false` to borrow against what the account already holds.
- `BORROW_PCT` (default `99`), `LIQUIDATABLE_HEALTH_BPS` (default `9800` ⇒ ~98% health, just liquidatable).

```bash
npx ts-node scripts/dex-liquidation/create-borrow-position.ts
```

What it does: supplies each collateral (if enabled), borrows up to `BORROW_PCT`% of the **aggregate** borrow
capacity **as total debt** (it accounts for any existing debt and only withdraws the delta), then drops
**every** collateral feed by the same factor so the aggregate liquidation line falls to
`LIQUIDATABLE_HEALTH_BPS`% of the debt. It prints each collateral's value, the borrow, a partial-vs-full
prediction, and each feed's `initial → dropped` price (**record the initial prices** — you restore them at
the end). Confirm `isLiquidatable: true`.

Guards (fail fast, before any state change where possible):
- borrower must hold **no base** (else `withdraw` is a paused *lender* withdrawal, `LendersWithdrawPaused`);
- total debt ≥ `baseBorrowMin`;
- a **partial-vs-full** check — the debt must be large enough that the post-restore residual stays above
  `baseBorrowMin`, otherwise Comet force-closes the whole debt (a *full* liquidation);
- a `callStatic` pre-flight that surfaces the exact revert (`NotCollateralized` ⇒ borrow exceeds the
  collateral limit, often pre-existing debt; `ExceedsSupportedUtilization` ⇒ pool needs more base liquidity).

> Already have a position and just want to make it liquidatable? Set `SUPPLY_COLLATERAL = false` (or run
> step 2 — if the account isn't liquidatable it prints the exact per-feed `setPrice` values to apply).

### Step 2 — Report the position and build the liquidate calldata

Edit `seizure-plan-at.ts`:

- `ACCOUNT` = the borrower, `ABSORBER` = incentive recipient.
- `ROUTE` = `'uniswap'` (empty `swapData`, any-timestamp) or `'oneinch'` (quoted per collateral, slot-pinned).
- 1inch route: `OFFSET_SECONDS` = how far ahead to target `T` (snapped **up** to the next slot boundary).
- `TARGET_HEALTH_BPS` = target health for the drop proposal when the account is not yet liquidatable.
- Verify `COMET`/`MODULE`/`ADAPTER`/`SEIZURE_VIEW`.

```bash
npx ts-node scripts/dex-liquidation/seizure-plan-at.ts
```

It prints a **position report** (per-collateral balances/values, debt, borrow limit, liquidation line,
health factor, status). Then:

- **If not liquidatable** — it prints a **uniform price-drop proposal**: for each held collateral, the
  current → proposed price and the `setPrice(<value>)` to reach `TARGET_HEALTH_BPS`. Apply each
  (`setPrice` + `setUseSourceFeed(false)`) and re-run.
- **If liquidatable** — it prints **how the borrower will be liquidated**: per collateral, the seized amount
  (and USD worth / debt covered), the DEX route (for 1inch, the actual AMM protocols, e.g. `UNISWAP_V3`, and
  the expected base out), and a partial/full classification. Then the **Safe transaction** (`to = MODULE`,
  `value 0`, `data`) and — for the 1inch route — `TARGET_TIMESTAMP = <T>`.

**Record** the `data` (and `T` for the 1inch route).

> 1inch route: pick `OFFSET_SECONDS` a little larger than the time to build + sign the Safe tx and launch
> step 4 (which must be running **before `T − 30s`**), but as small as that allows — the 1inch quote is
> fetched now but executes at `T`, so a bigger gap means a staler `minReturn`.

### Step 3 — Build and sign the Safe transaction (owners)

Create a Safe transaction with **exactly** these fields (they are hashed into the signature):

| Field | Value |
|-------|-------|
| `to` | `MODULE` |
| `value` | `0` |
| `data` | the `data` from step 2 |
| `operation` | `0` (CALL) |
| `safeTxGas`, `baseGas`, `gasPrice` | `0` |
| `gasToken`, `refundReceiver` | `0x0000…0000` |
| `nonce` | the Safe's current `nonce()` |

> The zero `safeTxGas`/`gasPrice` make an inner-call failure **revert** the whole tx (`GS013`) instead of
> returning `false`, so a tx landing in the wrong slot simply reverts and the signatures stay reusable. Many
> Safe UIs auto-estimate `safeTxGas` — verify it is `0`, or build the tx via the Safe SDK/API. If owners
> sign a different `safeTxHash`, execution fails with `GS026`.

Owners **sign only — do not execute** (the Safe{Wallet} “Execute” button broadcasts to the public mempool).
For the **1inch route**, keep the Safe **frozen** between signing and `T` — any other Safe tx bumps the nonce
and silently invalidates the signatures.

### Step 4 — Execute

**Uniswap route:** just execute the signed Safe transaction — via the Safe UI or any relayer, at any time.
No slot targeting, no `liquidate-at-slot.ts`. Done. (Skip to step 5.)

**1inch route:** fill the constants in `liquidate-at-slot.ts`:

- `TARGET_TIMESTAMP` = `T` from step 2.
- `SAFE_ADDRESS`, `SAFE_TX.to` / `SAFE_TX.data` from step 3 (the other `SAFE_TX` fields are already the required zeros).
- `OWNER_SIGNATURES` = a **comma-separated** list of each owner's individual signature, in **any order** — the
  script recovers each signer via the Safe's `getTransactionHash`, checks they're owners meeting the
  threshold, sorts them ascending, and concatenates them for you.
- `SIGNED_NONCE` = the nonce the owners signed against. Optionally `GAS_LIMIT`, `PRIORITY_FEE_GWEI`.

Dry-run first (validates constants + signatures, simulates against head — a state-dependent revert here is
expected since the amounts only match at `T`):

```bash
DRY_RUN=1 npx ts-node scripts/dex-liquidation/liquidate-at-slot.ts
```

Then run it live **before `T − 30s`** (it waits, re-checks the Safe nonce, signs the executor tx at `T−30s`,
and submits to the builders from `T−13s` until `T`):

```bash
npx ts-node scripts/dex-liquidation/liquidate-at-slot.ts
```

On success it prints the including block and confirms `block.timestamp == T`.

### Step 5 — Restore the price feeds

Restore every collateral feed dropped in step 1 (from the borrower/admin account), using the values step 1
(or step 2) printed:

- `feed.setUseSourceFeed(true)` — revert to the source oracle, **or**
- `feed.setPrice(<initial>)` — set the recorded initial price back.

---

## Constants & env reference

| Script | Key constants | Env |
|--------|---------------|-----|
| `create-borrow-position.ts` | `COMET`, `COLLATERALS` (list), `SUPPLY_COLLATERAL`, `BORROW_PCT`, `LIQUIDATABLE_HEALTH_BPS` | `RPC_URL`, `BORROWER_KEY` |
| `seizure-plan-at.ts` | `COMET`, `MODULE`, `ADAPTER`, `SEIZURE_VIEW`, `ACCOUNT`, `ABSORBER`, `ROUTE`, `OFFSET_SECONDS`, `TARGET_HEALTH_BPS` | `RPC_URL`, `ONEINCH_API_KEY` (1inch route) |
| `liquidate-at-slot.ts` | `TARGET_TIMESTAMP`, `SAFE_ADDRESS`, `SAFE_TX`, `OWNER_SIGNATURES`, `SIGNED_NONCE`, `GAS_LIMIT`, `PRIORITY_FEE_GWEI` | `RPC_URL`, `EXECUTOR_KEY`, `FB_AUTH_KEY` |

## Gotchas

- **1inch amounts are timestamp-pinned; Uniswap amounts are not.** The adapter's exact `amountIn == desc.amount`
  check + interest accrual means a 1inch calldata is valid only in the slot with `block.timestamp == T`. A
  Tenderly/Safe simulation passing "now" does **not** mean it passes in the block it actually lands in — use
  `liquidate-at-slot.ts`, or switch to the Uniswap route.
- **Borrower must hold no base.** This deployment pauses *lender* withdrawals, so a borrower that holds base
  can never create a borrow (`LendersWithdrawPaused`). Seed base from a separate account.
- **Partial vs full.** A partial liquidation must leave a residual debt **above `baseBorrowMin`**; otherwise
  Comet's min-debt rule force-closes the whole debt (a *full* liquidation). Full/seize-all liquidations are
  not timestamp-sensitive (the seized amount is fixed); partial 1inch liquidations are. Size the debt
  accordingly — step 1's guard checks this.
- **Slot alignment (1inch).** `TARGET_TIMESTAMP` must satisfy `(T − GENESIS) % 12 == 0`. Step 2 guarantees it.
- **Missed slot ⇒ abort, not retarget (1inch).** The `swapData` is pinned to `T`; re-run steps 2–3 for a fresh `T`.
- **Nonce is the primary hazard (1inch).** Freeze all other Safe activity between signing and `T`; step 4
  re-checks `safe.nonce()` at `T−30s` and aborts if it moved.
- **Clock accuracy is load-bearing (1inch).** Run NTP/chrony — ~300 ms of drift can put submissions in the wrong slot.
- **SeizureView binding.** If `seizurePlanAt` reverts while the account is clearly underwater, the view is
  likely bound to a previous module — repoint it at the current `MODULE`.
- **Restore the feeds** afterwards (step 5), or the market stays underwater for that collateral.
