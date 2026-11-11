import { Contract, Event, EventFilter, constants, utils } from 'ethers';
import { CometContext } from '../context/CometContext';
import { exp } from './math';
import { MAX_ASSETS } from './constants';

type DeploymentCriterion = {
  network?: string;
  deployment?: string;
};

// Selector of the Configurator getter that only market-admin-aware Configurators have
const MARKET_ADMIN_PERMISSION_CHECKER_SELECTOR = utils.id('marketAdminPermissionChecker()').slice(0, 10);

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

/**
 * Checks whether the Configurator has the marketAdminPermissionChecker() getter (market-admin flow).
 * Probed with a raw call, so an older Configurator returns false instead of reverting.
 * @param ctx Scenario context of the market being checked
 * @returns true if the Configurator has the getter, false otherwise or if the call fails
 */
export async function supportsMarketAdminPermissionChecker(ctx: CometContext): Promise<boolean> {
  try {
    const configurator = await ctx.getConfigurator();
    const result = await configurator.provider.call({
      to: configurator.address,
      data: MARKET_ADMIN_PERMISSION_CHECKER_SELECTOR,
    });
    return result !== '0x';
  } catch {
    return false;
  }
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
