# Comet Market Bench

An interactive bench for **irreversible market bricking**. It answers one
question:

> Here is a real market read from the network. Someone supplies liquidity,
> someone withdraws it, the treasury pulls reserves. How will the market behave
> from here and with what numbers — and will it turn into a brick through a
> `uint64` overflow?

All the arithmetic is `BigInt`, with no floating point: the `uint64` limit has
20 digits, while a `double` holds 16.

**Source contract:** [`contracts/CometWithExtendedAssetList.sol`](../../contracts/CometWithExtendedAssetList.sol).
**Port audit:** [`PARITY.md`](PARITY.md).

## Running it

```sh
node scripts/market-bench/serve.mjs --open      # or: yarn market-bench
```

Zero dependencies: the server is `node:http`, the page is native ES modules.
There is no build and no watch: edit a file, reload the tab.

Simply opening the file from disk (`file://`) will not work — the browser blocks
both ES modules and `fetch` on that scheme. Without the server there are no
markets either: state comes from the network, not from fixtures.

## How to use it

Four steps, left to right:

1. **Market.** Pick a row in the rail — the state and the curve land in the
   fields. The market you need is missing: choose a network and a market at the
   bottom of the panel and press "Read the state from the network".
2. **User actions.** Two fields, in human units of the base asset (`125000` =
   125,000 USDC, not wei). The sign sets the direction: **a minus in front of
   the number is a withdrawal, no sign is a deposit.** They are applied on top
   of the state at t₀.
3. **Time.** The observation range and the cadence at which someone touches the
   market.
4. **Read the right-hand column.** `t₀` is the state with `accrueInternal`
   already applied at the snapshot height; "What to expect" is where that leads
   over the chosen window.

### User actions

Two fields, two levers — and they are not interchangeable:

| Field | Example | What it moves | What it does not move |
|---|---|---|---|
| **Liquidity** | `125000` to deposit · `-27000` to withdraw | `balance` and `S` together → `u = B/S` | reserves: `R` stays the same |
| **Reserves** | `80000` to deposit · `-45000` to withdraw | `balance` alone → `R` | `S`, and therefore `u` |

This is not a stylistic split but an accounting identity:
`getReserves() = balance − S + B` (`:396-404`). Liquidity moves `balance` and
`S` in the same direction by the same amount, so they cancel; reserves move
`balance` alone. **Reserves cannot shift utilization at all** — and the bench
shows it as a fact: deposit even 80,000 of reserves and the `utilization` tile
does not budge, while `reserves` and `cash` both grow.

One field per lever instead of a pair means that "deposit 100 and immediately
withdraw 50" cannot be written down — but it does not need to be: at the same
t₀ it is identical to `50`.

**The order is fixed: deposits first, withdrawals after.** That is the
protocol's own order: `doTransferOut` pays out of the balance, and before a
deposit that balance is smaller, so a withdrawal placed first would simply
revert. That is why positive fields land before negative ones, regardless of
the order you typed them in.

**A withdrawal larger than what is possible is clipped — and the panel says
what bound it.** There are three bounds, and they are different:

- more `S` than the market has;
- more `cash` than the contract holds in the token (the rest is with the
  borrowers);
- more than `getReserves()` — `withdrawReserves` reverts (`:1471-1472`).

Supply drained to zero against live debt gets its own name on the bench:
**BRICKING UNDER WAY**. An empty market is alive in itself (`getSupplyRate`
returns 0 when `S == 0`, `:319`; so does `getUtilization`, `:365-366`), but it
cannot be reached — every withdrawal accrues first, so the last lenders walk
the market through the dust band and one of them reverts. Showing such a state
as `LIVE` would be the one lie the bench does not allow itself.

### When the actions happen

The **"After"** field sets how much time passes between the snapshot height and
the moment the transaction lands. Empty or zero means the same block the state
was read at. `20` + `hours` means the market first lives its own life for 20
hours, and only then the deposit or withdrawal arrives.

This is not cosmetic when rates are high. On `cUSDCv3 · linea` a dose of
`+125,000 / −45,000`:

| when | debt at the moment of the action | u right after the action | verdict |
|---|---|---|---|
| the same block | 100,802 | **66.11 %** | LIVE |
| after 20 h | 103,037 | **67.58 %** | LIVE |
| after 20 days | 230,943 | **151.47 %** | breakdown in 127 days |

That is, a 20-day delay turns a sufficient dose into an insufficient one — over
that time the debt grows faster than the dose can cover.

**One scale for the whole page.** Zero is the snapshot height; the delay is an
event inside the range, not a second origin. That is why "time to breakdown",
the charts and the step table all stay absolute: everything is measured from the
snapshot.

**The cadence is shared, and that is deliberate.** The waiting time is stepped
at the same `accrueInternal cadence` as the window: `freq` means "how often the
market is touched", and that is a property of the world, not of which side of
the action a given second happened to fall on. Set the cadence coarser than the
delay and the wait becomes a single flat accrual — exactly the case of "nobody
touched the market until we showed up".

**Two cases where the action does not happen** — both named on the page rather
than hidden:

- **The delay is longer than the range.** There would be nothing to observe
  after the action, so the bench does not execute it and says so in red.
  Silently stretching the range would be worse: it was entered on purpose.
- **The market breaks down sooner.** Then the action does not make it at all:
  both `supply` (`:950`) and `withdrawReserves` (`:1471`) accrue first, and on a
  broken market that reverts. In that case the tiles stand at the moment of the
  breakdown, and the `t₀` caption says exactly that moment, not the planned
  delay.

### Time: range and cadence

This is not cosmetic. The index compounds **between** touches:

```
index += index · rate · dt / 1e18
```

so the same calendar month yields different indices under hourly and daily
accrual — **a rare accrual is safer than a frequent one**. That is why the
cadence is set separately from the range rather than derived from it.

Range × cadence = the number of steps. Beyond `MAX_STEPS` (10,000,
`model/params.mjs`) the window is truncated, and the line under the fields says
so plainly instead of hanging the tab: a year at 12 seconds is 2.6 million
steps.

### What to expect from the market

The tiles read the end of the window, except the first one. **"Time to
breakdown"** looks past the window: if the market survived inside the range, the
bench additionally runs up to 20,000 steps at the same cadence — to say how far
away the wall is, rather than just "fine so far". If there is nothing there
either, the tile says exactly how much time was checked.

**"Tightest site"** is whichever of the six `accrueInternal` sites is closest to
its type's limit at the end of the window. When the market breaks down, that is
the site that broke.

### State at t₀ is the state with accrueInternal already applied

`TotalsBasic` in storage is current **not at the snapshot height, but at
`lastAccrualTime`**. Between the two are seconds whose interest has already
accrued but has not been written into the slots: the contract fills them in on
the fly in `getUtilization`, `getReserves` and any present value (`:397`), and
the next transaction will do the same before getting to its own business.

That is why, before anything else, the bench runs **the same** `accrueInternal`
over `blockTime − lastAccrualTime` seconds. The `t₀` tiles show the market as it
reads right now, not as the last person to touch it left it. The gap is visible
in the **"not accrued"** field in the state panel, and what exactly it changed
is in the note under the tiles.

This is not cosmetic. In the stored snapshots the median gap is **3.6 h**, the
maximum is **8.7 days**, and on `cUSDCv3 · linea` it moves utilization from
**346.43 %** to **367.11 %**, and present debt 6 % up.

Three details that are easy to misread:

- **The rail on the left stayed raw.** The captions under the fields
  (`PV ≈ …`, `cash = …`) describe what has been **entered** into the fields,
  i.e. storage. The settled state lives only on the right, in the tiles.
- **Accrual over the gap is simple, not compound.** `accruedInterestIndices`
  (`:259-271`) takes utilization from the **old** indices, multiplies the rate
  by the whole `timeElapsed` and adds it once. So 69 days in a single step do
  far less damage than the same 69 days accrued hourly — the bench reproduces
  exactly the contract's version, not compounding.
- **The gap can revert on its own.** Then the market is already a brick at the
  snapshot height: no transaction goes through, because both `supply` (`:950`)
  and `withdrawReserves` (`:1471`) accrue first. The bench says so in red and
  shows the stored state — a settled one simply does not exist.

### Where the market sits on the rate curves

`getSupplyRate` (`:333-338`) and `getBorrowRate` (`:349-356`) are piecewise
linear in `u`, with a single break each. Which side of that break the market is
on is what prices the next unit of utilization — a fact about the market now,
not a forecast — so the panel names it twice: as a chip on the card, and again
on the rail next to the parameters that produced it.

Five things are worth knowing about the reading.

**The comparison is `u <= kink`.** The kink is the last point of the low leg,
not the first of the high one. A market parked exactly on it is still priced at
`slopeLow`, while the next wei of utilization is not — the card says that in
those words rather than picking a side.

**The two kinks are independent.** `supplyKink` and `borrowKink` are separate
parameters, so one curve can be past its break while the other is not. On the
stored snapshots they happen to coincide, but nothing here assumes it: move them
apart in the fields and the two cards disagree, as they should.

**The three terms are the contract's own addition**, not a reconstruction of it:
`base + slopeLow·min(u, kink) + slopeHigh·max(0, u − kink)` is literally what
the branch computes. The table prints their sum beside the rate `accrueInternal`
actually used, so a disagreement would show up instead of hiding — the same
habit as the six breakdown sites.

**The reach figure is signed like the Liquidity field.** "back onto slopeLow:
+425,885.14" means that number, typed into the actions panel, lands `u` on the
kink. It rounds the way `u` does: `u` is a floored division, so the target is
the smallest supply that still satisfies `u <= kink` — one wei from the high leg.

**The last line reads the window, not a second run.** The trajectory is already
walked for the charts, so whether the market changes legs inside the range, and
when, is a read of those same rows.

The chart draws both curves against utilization, with the kink and the market's
own `u` as vertical lines: reading their order left to right answers the question
faster than either number does. It is drawn by the same `getSupplyRate` /
`getBorrowRate` the accrual runs on, with only the state short-circuits cleared —
a curve is the branch, not the market. When a short-circuit does fire
(`totalSupplyBase == 0`, the liquidity cut-off at `:330`, `totalBorrowBase == 0`)
the card reads **OFF CURVE**: the rate is 0 whatever the curve says, so the
marginal lines that would be false are dropped rather than shown.

## Market state: why the fields are locked

The state and curve fields come from the network and are read-only by default.
The reason is simple: a typo in `baseBorrowIndex` silently turns a real market
into an invented one, and the whole point of the bench is that it does not show
inventions. The **"edit"** toggle in the panel header lifts the lock — and the
page immediately warns that the provenance above refers to the snapshot, not to
what is on the screen.

## On-chain markets

Every row of the rail is **state read from the network**, not invented and not
saved by hand. The **↻** button re-reads the same market: the row is replaced in
place, and `refreshedAt` and the block number are updated. **×** removes it from
`data/market-presets.json`.

Every row shows **when it was last read** — market state drifts every block, so
the age of a snapshot is part of its meaning. Anything older than a day is
highlighted in yellow.

The server reads, not the browser: that is where the SDK lives
([`@stas-b-woof/compound`](https://www.npmjs.com/package/@stas-b-woof/compound))
and where the RPC keys from `.env` live — only the provider and the network make
it into the snapshot (`base-mainnet.quiknode.pro`), without the endpoint's
unique name and without the token. No key for a network: public nodes are used;
the first endpoint does not answer: the next one is used.

**The snapshot is coherent.** All 16 reads go against one pinned block, so it is
not assembled from values taken at different heights. `source` holds `block`,
`lastAccrualTime`, the base token balance and the time of the read.

**The curve is stored per year, not per second.** The contract holds
`perSecond = perYear / SECONDS_PER_YEAR` (integer division), and the bench's
form keeps the yearly values and divides the same way. Multiplying back,
`perSecond × SECONDS_PER_YEAR`, is lossless — the model gets exactly the number
the contract has. But the yearly value in the snapshot may differ from the one
governance voted on: the chain never stored anything but the rounded per-second
value.

**The snapshot holds neither the window nor the actions.** The range, the
cadence and both action fields are yours, not the market's: switching markets
does not reset them.

### If a market cannot be read

The message names every endpoint and its reason, for example:

```
no RPC for chain 1 answered — rough-neat-glitter.quiknode.pro: ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR;
ethereum-rpc.publicnode.com: HTTP 429; eth.drpc.org: timeout 15s
```

The order of attempts: the key from `.env`, then public nodes. An error **from
the chain itself** (a revert, an unknown method) does not trigger the fallback —
it is shown as is, because the node answered.

As of 2026-09-10 `MAINNET_QUICKNODE_LINK` in the repository `.env` fails the TLS
handshake, and `publicnode` periodically rate-limits — so mainnet is read from
`eth.drpc.org`. Your own key in `.env` removes that dependency on public nodes.

## Layout

```
scripts/market-bench/
├── index.html            markup only
├── serve.mjs             static server + a narrow API to the markets, no dependencies
├── data/
│   └── market-presets.json   on-chain snapshots, refreshed with the ↻ button
├── server/                   ← Node only: the browser never looks in here
│   ├── rpc.mjs               JSON-RPC from .env + public nodes, failover down the list
│   └── market.mjs            reading a market through @stas-b-woof/compound
├── styles/
│   ├── tokens.css        palette and themes
│   ├── base.css          reset and typography
│   ├── layout.css        the page skeleton
│   └── components.css    fields, buttons, tiles, tables, chips, charts
├── legacy/               panels awaiting a rework — see legacy/README.md
└── src/
    ├── main.mjs          composition: rail → form → listeners
    ├── model/            ← pure math, no DOM
    │   ├── constants.mjs   BASE_INDEX_SCALE, FACTOR_SCALE, SECONDS_PER_YEAR, type limits
    │   ├── numeric.mjs     parsing into BigInt (`0.04e18`, `20000e6`) and log10
    │   ├── accrual.mjs     port of accrueInternal / getSupplyRate / getBorrowRate / getUtilization
    │   ├── actions.mjs     actions as signed balance deltas, with the protocol's bounds
    │   ├── curve.mjs       which leg of each rate curve u is on, and what put it there
    │   ├── params.mjs      a parameter record → cfg/st/actions/window
    │   ├── trajectory.mjs  the step run + the breakdown search beyond the window
    │   └── invariants.mjs  states the contract cannot be in
    ├── ui/               ← everything that touches the DOM
    │   ├── fields.mjs      form ↔ parameter record, the lock on the state fields
    │   ├── format.mjs      numbers for people
    │   ├── chart.mjs       a line chart as SVG, no libraries — time axis, or a curve's own x values
    │   ├── actions.mjs     the actions panel: the summary and the caveats
    │   ├── curve.mjs       the rate-curve panel: the two cards and the curve chart
    │   ├── markets.mjs     the on-chain market rail: selection, ↻, ×, provenance
    │   └── render.mjs      paints every readout from one pass of the model
    └── store/markets.mjs a client for /api/markets and /api/market-presets
```

### The layering rule

**`model/` knows nothing about the DOM, `ui/` or `store/`.** That is not a
style choice but a load-bearing condition: it is exactly why the model can be
imported into Node — into a CLI, into a differential test against a Foundry
fixture, into a number generator for reports. For the same reason
`model/actions.mjs` returns caveat **codes**, not sentences: the wording lives
in `ui/actions.mjs`.

Importing any module must not touch the DOM (`main.mjs` attaches the listeners,
not the top level) — otherwise the model stops loading outside a browser.

The direction of dependencies: `main → ui → model`, `ui → store`. Never the
other way.

## Caveats

**The port is maintained by hand.** `model/accrual.mjs` duplicates the logic of
`CometWithExtendedAssetList.sol`. The formulas are checked line by line —
[`PARITY.md`](PARITY.md) — but the check is manual: change the rate model in
Solidity and the bench keeps showing the old one, silently. A differential test
closes this (see "Next").

**The bench computes accrual, not transactions.** The actions are reproduced at
the level of `totalSupplyBase` and the token balance — with no collateral
checks, no `MAX_SUPPORTED_UTILIZATION` guard (`:964`, `:1104`, `:1217`), no
`absorb` and no per-user balances. So the answer here is "will `accrueInternal`
survive these moves", not "will the transaction itself go through".

## Next

- **CLI + differential test**: `model/` is already importable into Node — what
  is left is a wrapper with flags and a check against a Foundry fixture, so the
  port cannot silently drift from the contract.
- **Bringing the panels in `legacy/` back** — the supply floor, the lender exit
  block by block — step by step, as needed.
