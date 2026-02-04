# Comet Protocol: Position Tracking Guide

A comprehensive guide for tracking user positions, rewards, and events in the Compound III (Comet) protocol.

---

## Table of Contents

1. [Overview](#overview)
2. [Core Concepts](#core-concepts)
3. [Position Lifecycle](#position-lifecycle)
   - [Lend Positions](#lend-position-lifecycle)
   - [Borrow Positions](#borrow-position-lifecycle)
   - [Liquidation](#liquidation)
4. [Rewards System](#rewards-system)
5. [Reading Position Data](#reading-position-data)
6. [Events Reference](#events-reference)
7. [Storage & State](#storage--state)
8. [Best Practices](#best-practices)

---

## Overview

Comet is a monolithic lending protocol where:
- Users **supply** the base token (e.g., USDC) to earn interest
- Users **borrow** the base token by depositing collateral assets
- Both suppliers and borrowers earn **COMP rewards**
- Underwater positions are **liquidated** via the `absorb()` mechanism

**Key characteristics:**
- Single borrowable asset (base token) per market
- Multiple collateral assets supported
- Interest and rewards accrue automatically via index-based system
- No external liquidation incentives — protocol absorbs bad debt

---

## Core Concepts

### Principal vs Present Value

The protocol stores user balances as **principal values** (scaled amounts) which are converted to **present values** (actual token amounts) using interest indices:

```
presentValue = principal × index / BASE_INDEX_SCALE
```

| Constant | Value | Description |
|----------|-------|-------------|
| `BASE_INDEX_SCALE` | `1e15` | Scale for interest indices |
| `FACTOR_SCALE` | `1e18` | Scale for collateral factors |
| `PRICE_SCALE` | `1e8` | Scale for price feed values |
| `BASE_ACCRUAL_SCALE` | `1e6` | Scale for reward accrual |

### User Principal States

A user's `principal` in the `UserBasic` struct determines their position type:

| Principal | Position Type | Interest Index Used |
|-----------|---------------|---------------------|
| Positive (`> 0`) | Supplier (lender) | `baseSupplyIndex` |
| Negative (`< 0`) | Borrower | `baseBorrowIndex` |
| Zero (`= 0`) | No position | — |

### Interest Indices

Interest accrues through monotonically increasing indices:

```solidity
// Indices increase over time based on utilization rate
uint64 baseSupplyIndex;  // Tracks accrued supply interest
uint64 baseBorrowIndex;  // Tracks accrued borrow interest
```

Indices update on every protocol interaction via `accrueInternal()`.

---

## Position Lifecycle

> **Note:** Both lend and borrow positions accrue COMP rewards in addition to interest. See [Rewards System](#rewards-system) for details.

### Lend Position Lifecycle

#### 1. Creation

A lend position is created when a user supplies the base token. The user's principal becomes **positive**.

**Functions:**
```solidity
comet.supply(baseToken, amount);              // Supply to yourself
comet.supplyTo(dst, baseToken, amount);       // Supply to another address
comet.supplyFrom(from, dst, baseToken, amount); // Supply from another (requires approval)
```

**Events emitted:**
| Event | When |
|-------|------|
| `Supply(from, dst, amount)` | Always |
| `Transfer(address(0), dst, amount)` | When minting new supply (not repaying debt) |

#### 2. Growth

The position grows automatically as interest accrues:

```
currentBalance = principal × baseSupplyIndex / BASE_INDEX_SCALE
```

- `baseSupplyIndex` increases over time based on supply APR
- No events emitted for interest — poll `balanceOf()` to track growth
- Rewards also accrue (see [Rewards System](#rewards-system))

**Tracking:**
```solidity
uint256 balance = comet.balanceOf(userAddress);      // Current balance with interest
uint64 supplyIndex = comet.baseSupplyIndex();        // Current index
```

#### 3. Closure

A lend position closes when the user withdraws their entire balance.

**Functions:**
```
comet.withdraw(baseToken, amount);                   // Withdraw to yourself
comet.withdrawTo(to, baseToken, amount);             // Withdraw to another address
comet.withdraw(baseToken, type(uint256).max);        // Withdraw entire balance
```

**Events emitted:**
| Event | When |
|-------|------|
| `Withdraw(src, to, amount)` | Always |
| `Transfer(src, address(0), amount)` | When burning supply balance |

---

### Borrow Position Lifecycle

#### 1. Creation

A borrow position requires two steps:

**Step 1 — Deposit collateral:**
```solidity
comet.supply(collateralAsset, amount);
comet.supplyTo(dst, collateralAsset, amount);
```

Events: `SupplyCollateral(from, dst, asset, amount)`

**Step 2 — Borrow base token:**
```solidity
comet.withdraw(baseToken, borrowAmount);
```

Events: `Withdraw(src, to, amount)`, `Transfer(src, address(0), amount)`

After borrowing, the user's principal becomes **negative**.

#### 2. Growth (Debt Increase)

Debt grows as interest accrues:

```
currentDebt = |principal| × baseBorrowIndex / BASE_INDEX_SCALE
```

- `baseBorrowIndex` increases faster than `baseSupplyIndex`
- No events emitted — poll `borrowBalanceOf()` to track debt
- Borrowers also earn COMP rewards

**Tracking:**
```solidity
uint256 debt = comet.borrowBalanceOf(userAddress);   // Current debt with interest
uint64 borrowIndex = comet.baseBorrowIndex();        // Current index
```

**Health monitoring:**
```solidity
bool healthy = comet.isBorrowCollateralized(user);   // Can still borrow?
bool underwater = comet.isLiquidatable(user);        // Can be liquidated?
```

#### 3. Closure (Repayment)

Repay debt by supplying base token:

```solidity
comet.supply(baseToken, repayAmount);                // Partial repay
comet.supply(baseToken, type(uint256).max);          // Full repay
comet.supplyTo(borrower, baseToken, amount);         // Repay someone else's debt
```

Events: `Supply(from, dst, amount)`

**After repayment, withdraw collateral:**
```solidity
comet.withdraw(collateralAsset, amount);
```

Events: `WithdrawCollateral(src, to, asset, amount)`

---

### Liquidation

When a borrow position becomes undercollateralized, anyone can liquidate it.

#### Trigger Condition

```solidity
// Liquidatable when:
// sum(collateralValue × liquidateCollateralFactor) < borrowValue
bool canLiquidate = comet.isLiquidatable(borrowerAddress);
```

#### Process

1. **Call `absorb()`** — anyone can trigger liquidation
2. **Protocol absorbs debt** — paid from protocol reserves
3. **Protocol seizes collateral** — all collateral transferred to protocol
4. **Liquidator earns points** — tracked in `liquidatorPoints[absorber]` (currently not used)

```solidity
address[] memory accounts = new address[](1);
accounts[0] = borrowerAddress;
comet.absorb(absorberAddress, accounts);
```

#### Liquidation Events

| Event | Description |
|-------|-------------|
| `AbsorbDebt(absorber, borrower, basePaidOut, usdValue)` | Debt absorbed by protocol |
| `AbsorbCollateral(absorber, borrower, asset, amount, usdValue)` | Collateral seized (per asset) |
| `Transfer(borrower, address(0), debtAmount)` | Debt "burned" |

#### Post-Liquidation

- Borrower's `principal` → `0`
- Borrower's collateral balances → `0`
- Seized collateral held as protocol reserves
- Anyone can buy collateral at discount via `buyCollateral()`

```solidity
uint quote = comet.quoteCollateral(asset, baseAmount);  // Get price
comet.buyCollateral(asset, minAmount, baseAmount, recipient);
```

---

## Rewards System

COMP rewards are distributed to both suppliers and borrowers. Rewards are tracked in Comet but claimed through the `CometRewards` contract.

### Tracking Mechanism

Rewards use a similar index system to interest:

```solidity
// Per-user tracking (in UserBasic)
uint64 baseTrackingIndex;    // Last recorded global index
uint64 baseTrackingAccrued;  // Accumulated rewards (÷ 1e6 for actual amount)

// Global indices
uint64 trackingSupplyIndex;  // For suppliers
uint64 trackingBorrowIndex;  // For borrowers

// Reward speeds (per second)
uint64 baseTrackingSupplySpeed;
uint64 baseTrackingBorrowSpeed;
```

**Minimum requirement:** Users must have `principal ≥ baseMinForRewards` to earn rewards.

### Reading Rewards

**From Comet:**
```solidity
uint64 accrued = comet.baseTrackingAccrued(user);  // Raw accrued (scaled)
```

**From CometRewards:**
```solidity
// Get claimable amount (calls accrueAccount internally)
CometRewards.RewardOwed memory owed = cometRewards.getRewardOwed(comet, user);
// owed.token = COMP address
// owed.owed = claimable amount
```

### Claiming Rewards

```solidity
// Claim to yourself
cometRewards.claim(cometAddress, userAddress, true);

// Claim to another address (requires permission)
cometRewards.claimTo(cometAddress, srcAddress, toAddress, true);
```

**Event:** `RewardClaimed(src, recipient, token, amount)`

### Rewards Summary

| Stage | Contract | Function |
|-------|----------|----------|
| Accrue | Comet | Automatic on any interaction |
| Check raw | Comet | `baseTrackingAccrued(account)` |
| Check claimable | CometRewards | `getRewardOwed(comet, account)` |
| Claim | CometRewards | `claim()` / `claimTo()` |

---

## Reading Position Data

### Base Token Position

| Function | Returns | Description |
|----------|---------|-------------|
| `balanceOf(account)` | `uint256` | Supply balance (0 if borrower) |
| `borrowBalanceOf(account)` | `uint256` | Borrow balance (0 if supplier) |
| `userBasic(account)` | `UserBasic` | Raw principal and tracking data |

```solidity
struct UserBasic {
    int104 principal;           // + = supply, - = borrow
    uint64 baseTrackingIndex;   // Reward tracking index
    uint64 baseTrackingAccrued; // Accrued rewards
    uint16 assetsIn;            // Bitmap of collateral assets
    uint8 _reserved;
}
```

### Collateral Position

| Function | Returns | Description |
|----------|---------|-------------|
| `collateralBalanceOf(account, asset)` | `uint128` | Collateral balance for asset |
| `userCollateral(account, asset)` | `UserCollateral` | Raw collateral data |
| `numAssets()` | `uint8` | Number of supported collaterals |
| `getAssetInfo(i)` | `AssetInfo` | Info for collateral at index |

**Iterate all collateral:**
```solidity
for (uint8 i = 0; i < comet.numAssets(); i++) {
    AssetInfo memory info = comet.getAssetInfo(i);
    uint128 balance = comet.collateralBalanceOf(user, info.asset);
}
```

### Account Health

| Function | Returns | Description |
|----------|---------|-------------|
| `isBorrowCollateralized(account)` | `bool` | `true` if can borrow more |
| `isLiquidatable(account)` | `bool` | `true` if can be liquidated |

### Rewards

| Function | Returns | Description |
|----------|---------|-------------|
| `baseTrackingAccrued(account)` | `uint64` | Raw accrued rewards |

---

## Events Reference

### Supply & Withdraw Events

| Event | Emitted When |
|-------|--------------|
| `Supply(from, dst, amount)` | Base token supplied |
| `Withdraw(src, to, amount)` | Base token withdrawn |
| `SupplyCollateral(from, dst, asset, amount)` | Collateral deposited |
| `WithdrawCollateral(src, to, asset, amount)` | Collateral withdrawn |

### Transfer Events

| Event | Emitted When |
|-------|--------------|
| `Transfer(from, to, amount)` | Base token balance transfer |
| `TransferCollateral(from, to, asset, amount)` | Collateral transfer |

**Special `Transfer` cases:**
- `from = address(0)` → New supply minted
- `to = address(0)` → Balance burned (withdraw/borrow)

### Liquidation Events

| Event | Emitted When |
|-------|--------------|
| `AbsorbDebt(absorber, borrower, basePaidOut, usdValue)` | Debt absorbed |
| `AbsorbCollateral(absorber, borrower, asset, amount, usdValue)` | Collateral seized |

### Reward Events (CometRewards)

| Event | Emitted When |
|-------|--------------|
| `RewardClaimed(src, recipient, token, amount)` | Rewards claimed |

---

## Storage & State

### User Mappings

| Mapping | Description |
|---------|-------------|
| `userBasic[address]` | Principal and reward tracking |
| `userCollateral[address][asset]` | Collateral balances |
| `isAllowed[owner][manager]` | Permission delegation |

### Global State

| Variable | Description |
|----------|-------------|
| `baseSupplyIndex` | Supply interest index |
| `baseBorrowIndex` | Borrow interest index |
| `trackingSupplyIndex` | Supply reward index |
| `trackingBorrowIndex` | Borrow reward index |
| `totalSupplyBase` | Total principal supplied |
| `totalBorrowBase` | Total principal borrowed |
| `lastAccrualTime` | Last interest accrual timestamp |

### Protocol Reserves

| Function | Description |
|----------|-------------|
| `getReserves()` | Base token reserves (can be negative) |
| `getCollateralReserves(asset)` | Collateral reserves from liquidations |

---

## Best Practices

### 1. Accrue Before Reading

For the most up-to-date values, call `accrueAccount()` first:

```solidity
comet.accrueAccount(userAddress);
uint256 balance = comet.balanceOf(userAddress);
```

Or use view functions that include pending interest internally.

### 2. Use Multicall for Efficiency

Batch multiple position reads in a single call:

```solidity
// Using a multicall contract to fetch multiple balances
bytes[] memory calls = new bytes[](3);
calls[0] = abi.encodeCall(comet.balanceOf, (user1));
calls[1] = abi.encodeCall(comet.balanceOf, (user2));
calls[2] = abi.encodeCall(comet.borrowBalanceOf, (user3));
```

### 3. Index Events for History

For historical position tracking, index events in a database or subgraph rather than querying on-chain state repeatedly.

### 4. Monitor Liquidation Risk

Set up alerts when positions approach liquidation:

```solidity
// Check health factor periodically
if (comet.isLiquidatable(borrower)) {
    // Alert or liquidate
}
```

### 5. Handle Precision Correctly

Always use the correct scale constants:

| Scale | Value | Used For |
|-------|-------|----------|
| `BASE_INDEX_SCALE` | `1e15` | Interest indices |
| `FACTOR_SCALE` | `1e18` | Collateral factors |
| `PRICE_SCALE` | `1e8` | Price feed values |
| `BASE_ACCRUAL_SCALE` | `1e6` | Reward accrual |

### 6. Track Position Changes via Events

| To Track | Listen For |
|----------|------------|
| New supply | `Supply` where `from = dst` |
| Repayment | `Supply` where principal was negative |
| New borrow | `Withdraw` where principal becomes negative |
| Liquidation | `AbsorbDebt` + `AbsorbCollateral` |
| Reward claims | `RewardClaimed` (CometRewards) |
