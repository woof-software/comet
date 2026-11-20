import { Contract, Event, EventFilter, constants, utils } from 'ethers';
import { CometContext } from '../context/CometContext';
import { exp } from './math';
import { MAX_ASSETS } from './constants';

type DeploymentCriterion = {
  network?: string;
  deployment?: string;
};

export async function isValidAssetIndex(
  ctx: CometContext,
  assetNum: number
): Promise<boolean> {
  // Sanity checks
  if (assetNum < 0) return false;
  if (assetNum >= MAX_ASSETS) return false;
  // Asset info checks. If any of these are false, the asset is invalid. This means that the asset is deprecated.
  const comet = await ctx.getComet();

  const numAssets = await comet.numAssets();
  if (assetNum >= numAssets) return false;

  const assetInfo = await comet.getAssetInfo(assetNum);
  if (assetInfo.borrowCollateralFactor.toBigInt() == 0n) return false;
  if (assetInfo.supplyCap.toBigInt() == 0n) return false;
  if (assetInfo.liquidateCollateralFactor.toBigInt() == 0n) return false;
  if (assetInfo.liquidationFactor.toBigInt() == 0n) return false;
  if (assetInfo.liquidateCollateralFactor.toBigInt() <= assetInfo.borrowCollateralFactor.toBigInt()) return false;
  return true;
}

export async function isAssetDelisted(
  ctx: CometContext,
  assetNum: number
): Promise<boolean> {
  const comet = await ctx.getComet();
  const assetInfo = await comet.getAssetInfo(assetNum);
  return assetInfo.borrowCollateralFactor.toBigInt() === 0n;
}

export async function isTriviallySourceable(
  ctx: CometContext,
  assetNum: number,
  amount: number
): Promise<boolean> {
  const fauceteer = await ctx.getFauceteer();
  // If fauceteer does not exist (e.g. mainnet), then token is likely sourceable from events
  if (fauceteer == null) return true;

  const comet = await ctx.getComet();
  const assetInfo = await comet.getAssetInfo(assetNum);
  const asset = ctx.getAssetByAddress(assetInfo.asset);
  const amountInWei = BigInt(amount) * assetInfo.scale.toBigInt();
  // Fauceteer should have greater than the expected amount of the asset
  return (await asset.balanceOf(fauceteer.address)) > amountInWei;
}

export async function isBulkerSupported(ctx: CometContext): Promise<boolean> {
  const bulker = await ctx.getBulker();
  return bulker == null ? false : true;
}

export async function hasMinBorrowGreaterThanOne(
  ctx: CometContext
): Promise<boolean> {
  const comet = await ctx.getComet();
  const minBorrow = (await comet.baseBorrowMin()).toBigInt();
  return minBorrow > 1n;
}

export function matchesDeployment(
  ctx: CometContext,
  deploymentCriteria: DeploymentCriterion[]
): boolean {
  const currentDeployment = {
    network: ctx.world.base.network,
    deployment: ctx.world.base.deployment,
  };

  function matchesCurrentDeployment(deploymentCriterion: DeploymentCriterion) {
    for (const [k, v] of Object.entries(deploymentCriterion)) {
      if (currentDeployment[k] !== v) return false;
    }
    return true;
  }

  return deploymentCriteria.some(matchesCurrentDeployment);
}

export async function isRewardSupported(ctx: CometContext): Promise<boolean> {
  const rewards = await ctx.getRewards();
  const comet = await ctx.getComet();
  const COMP = await ctx.getComp();

  if (rewards == null) return false;

  const [rewardTokenAddress] = await rewards.rewardConfig(comet.address);
  if (rewardTokenAddress === constants.AddressZero) return false;

  const totalSupply = await COMP.totalSupply();
  if (totalSupply.toBigInt() < exp(1, 18)) return false;

  return true;
}

export function isBridgedDeployment(ctx: CometContext): boolean {
  return ctx.world.auxiliaryDeploymentManager !== undefined;
}

export async function fetchLogs(
  contract: Contract,
  filter: EventFilter,
  fromBlock: number,
  toBlock: number,
  BLOCK_SPAN = 2047
): Promise<Event[]> {
  if (toBlock - fromBlock > BLOCK_SPAN) {
    const midBlock = fromBlock + BLOCK_SPAN;
    const logs = await contract.queryFilter(filter, fromBlock, midBlock);
    return logs.concat(
      await fetchLogs(contract, filter, midBlock + 1, toBlock)
    );
  } else {
    return contract.queryFilter(filter, fromBlock, toBlock);
  }
}

/// Finds the index of the first collateral asset that can back a borrow in the bulker scenarios.
/// The wrapped native token is skipped, since it is supplied and withdrawn through the native token actions,
/// and so are delisted assets, which have a zero borrow collateral factor. Returns -1 if there is none.
export async function getBulkerCollateralIndex(ctx: CometContext): Promise<number> {
  const bulker = await ctx.getBulker();
  if (bulker == null) return -1;

  const comet = await ctx.getComet();
  const wrappedNativeToken = (await bulker.wrappedNativeToken()).toLowerCase();
  const numAssets = await comet.numAssets();
  for (let i = 0; i < numAssets; i++) {
    const { asset } = await comet.getAssetInfo(i);
    if (asset.toLowerCase() === wrappedNativeToken) continue;
    if (await isAssetDelisted(ctx, i)) continue;
    return i;
  }
  return -1;
}

/**
 * @notice Checks if the market is fresh (no supplies and no borrows)
 * @dev A fresh market has totalSupplyBase == 0 and totalBorrowBase == 0
 *      This is used to filter scenarios that should only run on new/empty markets
 */
export async function isFreshMarket(ctx: CometContext): Promise<boolean> {
  try {
    const comet = await ctx.getComet();
    const totals = await comet.totalsBasic();
    return totals.totalSupplyBase.isZero() && totals.totalBorrowBase.isZero();
  } catch (error) {
    return false;
  }
}

export async function usesAssetList(ctx: CometContext): Promise<boolean> {
  const comet = await ctx.getComet();
  return await comet.maxAssets() === MAX_ASSETS;
}



// returns indices of collaterals that have a supply cap and all collateral factors above zero.
// pass `amount` to get only the first N of them, omit it to get all.
export async function getUsableCollateralIndices(ctx: CometContext, amount?: number): Promise<number[]> {
  const comet = await ctx.getComet();
  const numAssets = await comet.numAssets();
  const indices: number[] = [];

  for (let i = 0; i < numAssets; i++) {
    if (amount !== undefined && indices.length >= amount) break;

    const info = await comet.getAssetInfo(i);

    // We skip assets with a supply cap of 0
    if (info.supplyCap.isZero()) continue;

    // We skip assets with a borrow collateral factor, liquidate collateral factor, or liquidation factor of 0
    if (info.borrowCollateralFactor.isZero() || info.liquidateCollateralFactor.isZero() || info.liquidationFactor.isZero()) continue;
    
    indices.push(i);
  }
  return indices;
}

/**
 * Checks whether the Configurator has the marketAdminPermissionChecker() getter (market-admin flow).
 * An older Configurator without it returns false instead of reverting.
 * @param ctx Scenario context of the market being checked
 * @returns true if the Configurator has the getter, false if it does not
 * @throws If the call fails for any other reason, such as the RPC being down
 */
export async function supportsMarketAdminPermissionChecker(ctx: CometContext): Promise<boolean> {
  return hasFunction(await ctx.getConfigurator(), 'marketAdminPermissionChecker()');
}

/**
 * Checks whether Comet enforces a utilization cap, i.e. has the MAX_SUPPORTED_UTILIZATION() getter.
 * @param ctx Scenario context of the market being checked
 * @returns true if Comet has the getter, false if it does not
 * @throws If the call fails for any other reason, such as the RPC being down
 */
export async function supportUtilizationLimit(ctx: CometContext): Promise<boolean> {
  return hasFunction(await ctx.getComet(), 'MAX_SUPPORTED_UTILIZATION()');
}

/**
 * Checks whether Comet supports the extended pause flags, i.e. has the isLendersWithdrawPaused() getter
 * (only CometWithExtendedAssetList has it).
 * @param ctx Scenario context of the market being checked
 * @returns true if Comet has the getter, false if it does not
 * @throws If the call fails for any other reason, such as the RPC being down
 */
export async function supportsExtendedPause(ctx: CometContext): Promise<boolean> {
  return hasFunction(await ctx.getComet(), 'isLendersWithdrawPaused()');
}

// Tells whether the code deployed at `contract` has the no-argument function `signature`, by calling it with
// only its selector. A missing function makes the call return empty data, or makes the provider throw
// CALL_EXCEPTION; both mean "not supported". Any other error (RPC down, rate limit) is rethrown, so a broken
// connection fails the run instead of quietly filtering scenarios out as unsupported.
async function hasFunction(contract: Contract, signature: string): Promise<boolean> {
  try {
    const result = await contract.provider.call({
      to: contract.address,
      data: utils.id(signature).slice(0, 10),
    });
    return result !== '0x';
  } catch (e) {
    if (e?.code === 'CALL_EXCEPTION') return false;
    throw e;
  }
}