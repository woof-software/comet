import { expect } from 'chai';
import {
  BigNumber,
  Contract,
  ContractReceipt,
  ContractTransaction,
  Event,
  EventFilter,
  constants,
  utils,
} from 'ethers';
import { CometContext } from '../context/CometContext';
import { exp } from '../../test/helpers';
import { MAX_ASSETS, SECONDS_PER_YEAR } from './constants';

/** Convert a per-year interest factor to per-second (Comet constructor truncation). */
export const perSecond = (perYear: BigNumber): BigNumber => perYear.div(SECONDS_PER_YEAR);

export const max = (...args: bigint[]): bigint => args.reduce((m, e) => (e > m ? e : m));
export const min = (...args: bigint[]): bigint => args.reduce((m, e) => (e < m ? e : m));
export const abs = (x: bigint): bigint => (x < 0n ? -x : x);

export function expectApproximately (
  expected: bigint,
  actual: bigint,
  precision = 0n
) {
  expect(BigNumber.from(abs(expected - actual))).to.be.lte(
    BigNumber.from(precision)
  );
}

export function expectBase(expected: bigint, actual: bigint, precision = 2n) {
  expectApproximately(expected, actual, precision);
}

export function expectRevertCustom(
  tx: Promise<ContractReceipt | ContractTransaction>,
  custom: string
) {
  return tx
    .then((_) => {
      throw new Error('Expected transaction to be reverted');
    })
    .catch((e) => {
      const selector = utils
        .keccak256(
          custom
            .split('')
            .reduce((a, s) => a + s.charCodeAt(0).toString(16), '0x')
        )
        .slice(2, 2 + 8);
      const errorName = custom.replace(/\(\)$/, '');
      const escaped = custom.replace(/[()]/g, '\\$&');

      // ethers sometimes decodes the error (CALL_EXCEPTION), sometimes only the selector
      if (
        e.errorName === errorName ||
        e.errorSignature === custom ||
        e.data === `0x${selector}`
      ) {
        return;
      }

      const patterns = [
        new RegExp(`custom error '${escaped}'`),
        new RegExp(`unrecognized custom error with selector ${selector}`),
        new RegExp(
          `unrecognized custom error \\(return data: 0x${selector}\\)`
        ),
        new RegExp(`errorSignature="${escaped}"`),
        new RegExp(`errorName="${errorName}"`),
        new RegExp(`data="0x${selector}"`),
      ];
      for (const pattern of patterns)
        if (pattern.test(e.message) || pattern.test(e.reason)) return;
      throw new Error(
        `Expected revert message in one of [${patterns}], but reverted with: ${e.message}`
      );
    });
}

export function expectRevertMatches(
  tx: Promise<ContractReceipt>,
  patterns: RegExp[]
) {
  return tx
    .then((_) => {
      throw new Error('Expected transaction to be reverted');
    })
    .catch((e) => {
      for (const pattern of patterns) if (pattern.test(e.message)) return;
      throw new Error(
        `Expected revert message in one of ${patterns}, but reverted with: ${e.message}`
      );
    });
}

export function getExpectedBaseBalance(
  balance: bigint,
  baseIndexScale: bigint,
  borrowOrSupplyIndex: bigint
): bigint {
  const principalValue = (balance * baseIndexScale) / borrowOrSupplyIndex;
  const baseBalanceOf = (principalValue * borrowOrSupplyIndex) / baseIndexScale;
  return baseBalanceOf;
}

export function getInterest(balance: bigint, rate: bigint, seconds: bigint) {
  return (balance * rate * seconds) / 10n ** 18n;
}

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

type DeploymentCriterion = {
  network?: string;
  deployment?: string;
};

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

export async function supportsMarketAdminPermissionChecker(ctx: CometContext): Promise<boolean> {
  try {
    const configurator = await ctx.getConfigurator();
    const ethers = ctx.world.deploymentManager.hre.ethers;
    
    // Use function selector to probe existence without reverting on unsupported networks
    const iface = new ethers.utils.Interface([
      'function marketAdminPermissionChecker() public view returns (address)'
    ]);
    const functionSelector = iface.getSighash('marketAdminPermissionChecker');
    
    const result = await ethers.provider.call({
      to: configurator.address,
      data: functionSelector
    });
    
    if (result && result !== '0x') {
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}
