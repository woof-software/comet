import { World } from '../../plugins/scenario';
import { impersonateAddress } from '../../plugins/scenario/utils';
import { CometContext } from '../context/CometContext';
import { CometInterface, LiquidationModule, LiquidationModule__factory } from '../../build/types';
import { fundAccount, getLiquidationModuleAddress, isAssetDelisted } from './index';
import { BigNumber } from 'ethers';

// Compound governance timelock — holds DEFAULT_ADMIN_ROLE (and PAUSER_ROLE) on every liquidation
// module, so it can toggle the mode / DEX switch and grant the keeper EXECUTOR_ROLE.
const DAO = '0x6d903f6003cca6255D85CcA4D3B5E5146dC33925';

/** The two liquidation entry points, which must produce identical end states. */
export type Entry = 'absorb' | 'liquidate';

/**
 * The borrower's base position plus the comet base totals/reserves right before an
 * absorb/liquidate. Capture it with {@link captureAbsorbStateBefore} immediately before calling the
 * entry point, then diff against the on-chain state afterwards. Collateral-scoped state is captured
 * separately, per asset, with {@link makeCollateralState}.
 */
export interface AbsorbStateBefore {
  /** Borrower's `userBasic(account)` (principal, assetsIn, _reserved, …). */
  user: Awaited<ReturnType<CometInterface['userBasic']>>;
  /** Borrower's signed base balance `presentValue(principal)` — negative for debt. */
  userBalance: bigint;
  /** Comet's `totalsBasic()` (totalBorrowBase, totalSupplyBase, indices, …). */
  totals: Awaited<ReturnType<CometInterface['totalsBasic']>>;
  /** Comet base reserves: `getReserves()`. */
  baseReserves: bigint;
  /** Comet's ERC20 balance of the base token (untouched on the pure absorb path). */
  cometBaseErc20Balance: bigint;
}

/**
 * Full collateral-scoped state for a single asset: the on-chain asset config (from
 * `getAssetInfo`, so `asset`, `scale`, `priceFeed`, `liquidationFactor`, … come for free) plus the
 * borrower/comet balances captured before an absorb and the expected seizure. Mirrors the
 * `CollateralState` used in `test/liquidation-logic/absorb.test.ts`; build it with
 * {@link makeCollateralState}, then fill `seizeAmount`/`seizedValue` from the scenario's own math.
 */
export type CollateralState = Awaited<ReturnType<CometInterface['getAssetInfo']>> & {
  /** Borrower's supplied collateral: `collateralBalanceOf(account, asset)`. */
  collateralBalance: bigint;
  /** Protocol-wide supplied total: `totalsCollateral(asset).totalSupplyAsset`. */
  totalsCollateral: bigint;
  /** Protocol collateral reserves: `getCollateralReserves(asset)`. */
  collateralReserves: bigint;
  /** Comet's ERC20 balance of the collateral: `asset.balanceOf(comet)` (untouched by absorb). */
  cometErc20Balance: bigint;
  /** Current collateral price from the asset price feed. */
  price: bigint;
  /** Amount expected to be seized by absorb/liquidate. */
  seizeAmount: bigint;
  /** Market value of `seizeAmount`: `seizeAmount * price / scale`. */
  seizedValue: bigint;
};

/** True only for deployments that actually ship the liquidation module. */
export const hasModule = async (ctx: CometContext): Promise<boolean> =>
  (await getLiquidationModuleAddress(ctx)) !== null;

/** True only for deployments that have a positive base borrow minimum. */
export const zeroBaseBorrowMin = async (ctx: CometContext): Promise<boolean> =>
  (await (await ctx.getComet()).baseBorrowMin()) === BigNumber.from(0);

/**
 * Reads the borrower's base position plus the comet base totals/reserves in one shot. Call it
 * immediately before the absorb/liquidate entry point.
 */
export async function captureAbsorbStateBefore(
  comet: CometInterface,
  context: CometContext,
  account: string,
  baseToken: string
): Promise<AbsorbStateBefore> {
  const user = await comet.userBasic(account);
  const userBalance = (await comet.presentValue(user.principal)).toBigInt(); // signed; negative (debt)
  const totals = await comet.totalsBasic();
  const baseReserves = (await comet.getReserves()).toBigInt();
  const cometBaseErc20Balance = await context.getAssetByAddress(baseToken).balanceOf(comet.address);

  return { user, userBalance, totals, baseReserves, cometBaseErc20Balance };
}

/**
 * Captures the full pre-absorb {@link CollateralState} for each collateral index, one entry per
 * index and in the same order. For every asset it reads the `getAssetInfo` struct plus the
 * borrower's supplied balance, comet's supplied total / reserves / ERC20 balance, and the current
 * price. `seizeAmount`/`seizedValue` start at zero — the scenario fills them from its own seizure
 * math. Returning an ordered array lets callers destructure (`[first, second]`) or iterate (the last
 * entry is the one that closes the debt).
 */
export async function makeCollateralStates(
  comet: CometInterface,
  context: CometContext,
  account: string,
  indices: number[]
): Promise<CollateralState[]> {
  return Promise.all(
    indices.map(async (index) => {
      const info = await comet.getAssetInfo(index);
      // `info` is a frozen ethers Result, so spread into a fresh (extensible) object before adding fields.
      return {
        ...info,
        collateralBalance: (await comet.collateralBalanceOf(account, info.asset)).toBigInt(),
        totalsCollateral: (await comet.totalsCollateral(info.asset)).totalSupplyAsset.toBigInt(),
        collateralReserves: (await comet.getCollateralReserves(info.asset)).toBigInt(),
        cometErc20Balance: await context.getAssetByAddress(info.asset).balanceOf(comet.address),
        price: (await comet.getPrice(info.priceFeed)).toBigInt(),
        seizeAmount: 0n,
        seizedValue: 0n,
      } as CollateralState;
    })
  );
}

/**
 * Puts the module into the requested mode / entry configuration and returns it. For the keeper
 * path the DEX route is paused (so `liquidate` falls back to the pure absorb flow) and the executor
 * role is granted. All parameter setters are driven by the DAO, which holds the admin + pauser roles
 * by default.
 */
export async function configureModule(
  ctx: CometContext,
  world: World,
  entry: Entry,
  partialLiquidationEnabled: boolean,
  executorAddress: string
): Promise<LiquidationModule> {
  const ethers = world.deploymentManager.hre.ethers;
  const module = LiquidationModule__factory.connect((await getLiquidationModuleAddress(ctx))!, ethers.provider);
  const dao = await impersonateAddress(world.deploymentManager, DAO, ethers.utils.parseEther('10').toBigInt());
  await fundAccount(world, dao);

  // Select the liquidation mode. Toggling to the value it already holds reverts (AlreadySet).
  if ((await module.partialLiquidationEnabled()) !== partialLiquidationEnabled) {
    await module.connect(dao).liquidationModeToggle(partialLiquidationEnabled);
  }

  if (entry === 'liquidate') {
    // Pause the DEX route so liquidate() falls back to the pure absorb flow (no swap data),
    // and grant the keeper the executor role required to call it.
    if (!(await module.dexRoutePaused())) {
      await module.connect(dao).setDexRoutePaused(true);
    }
    if (!(await module.hasRole(await module.EXECUTOR_ROLE(), executorAddress))) {
      await module.connect(dao).grantRole(await module.EXECUTOR_ROLE(), executorAddress);
    }
  }

  return module;
}

/** Every collateral index usable for these liquidation scenarios (not delisted), in order. */
export async function usableCollateralIndices(ctx: CometContext, comet: CometInterface): Promise<number[]> {
  const numAssets = await comet.numAssets();
  const indices: number[] = [];
  for (let i = 0; i < numAssets; i++) {
    if (await isAssetDelisted(ctx, i)) continue;
    indices.push(i);
  }
  return indices;
}
