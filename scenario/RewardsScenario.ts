import { CometContext, CometProperties, scenario } from './context/CometContext';
import { expect } from 'chai';
import { exp } from '../test/helpers';
import { isRewardSupported, matchesDeployment } from './utils';
import { Contract, ContractReceipt } from 'ethers';
import { CometRewards, ERC20__factory } from '../build/types';
import {World} from '../plugins/scenario';
import { getConfigForScenario } from './utils/scenarioHelper';

function calculateRewardsOwed(
  userBalance: bigint,
  totalBalance: bigint,
  speed: bigint,
  timeElapsed: number,
  trackingIndexScale: bigint,
  rewardTokenScale: bigint,
  rescaleFactor: bigint
): bigint {
  const accrued = userBalance * speed * BigInt(timeElapsed) * rewardTokenScale / totalBalance / trackingIndexScale;
  return accrued / rescaleFactor * rescaleFactor;
}

scenario(
  'Comet#rewards > can claim supply rewards for self',
  {
    filter: async (ctx) => await isRewardSupported(ctx),
    tokenBalances: {
      albert: { $base: ' == 100' },
    },
  },
  async ({ comet, rewards, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();

    const [rewardTokenAddress, rescaleFactor] = await rewards.rewardConfig(comet.address);
    const rewardToken = new Contract(
      rewardTokenAddress,
      ERC20__factory.createInterface(),
      world.deploymentManager.hre.ethers.provider
    );
    const rewardScale = exp(1, await rewardToken.decimals());

    await baseAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: baseAssetAddress, amount: config.rewards.baseSupplyAmount * baseScale });

    expect(await rewardToken.balanceOf(albert.address)).to.be.equal(0n);

    const supplyTimestamp = await world.timestamp();
    const albertBalance = await albert.getCometBaseBalance();
    const totalSupplyBalance = (await comet.totalSupply()).toBigInt();

    await world.increaseTime(Number(config.common.timing.oneDay));
    const preTxnTimestamp = await world.timestamp();

    const rewardsOwedBefore = (await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt();
    const txn = await (await rewards.connect(albert.signer).claim(comet.address, albert.address, true)).wait();
    const rewardsOwedAfter = (await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt();

    const postTxnTimestamp = await world.timestamp();
    const timeElapsed = postTxnTimestamp - preTxnTimestamp;

    const supplySpeed = (await comet.baseTrackingSupplySpeed()).toBigInt();
    const trackingIndexScale = (await comet.trackingIndexScale()).toBigInt();
    const timestampDelta = preTxnTimestamp - supplyTimestamp;
    const totalSupplyPrincipal = (await comet.totalsBasic()).totalSupplyBase.toBigInt();
    const baseMinForRewards = (await comet.baseMinForRewards()).toBigInt();
    let expectedRewardsOwed = 0n;
    let expectedRewardsReceived = 0n;
    if (totalSupplyPrincipal >= baseMinForRewards) {
      expectedRewardsOwed = calculateRewardsOwed(albertBalance, totalSupplyBalance, supplySpeed, timestampDelta, trackingIndexScale, rewardScale, rescaleFactor.toBigInt());
      expectedRewardsReceived = calculateRewardsOwed(albertBalance, totalSupplyBalance, supplySpeed, timestampDelta + timeElapsed, trackingIndexScale, rewardScale, rescaleFactor.toBigInt());
    }

    expect(timestampDelta).to.be.greaterThanOrEqual(config.rewards.minTimeDelta);
    expect(rewardsOwedBefore).to.be.equal(expectedRewardsOwed);
    expect(await rewardToken.balanceOf(albert.address)).to.be.equal(expectedRewardsReceived);
    expect(rewardsOwedAfter).to.be.equal(0n);

    return txn;
  }
);

scenario(
  'Comet#rewards > manager can claimTo supply rewards from a managed account',
  {
    filter: async (ctx) => await isRewardSupported(ctx) && !matchesDeployment(ctx, [{network: 'mainnet', deployment: 'weth'}]),
    tokenBalances: {
      albert: { $base: ' == 100' },
    },
  },
  async ({ comet, rewards, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();

    const [rewardTokenAddress, rescaleFactor] = await rewards.rewardConfig(comet.address);
    const rewardToken = new Contract(
      rewardTokenAddress,
      ERC20__factory.createInterface(),
      world.deploymentManager.hre.ethers.provider
    );
    const rewardScale = exp(1, await rewardToken.decimals());

    await albert.allow(betty, true);
    await baseAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: baseAssetAddress, amount: config.rewards.baseSupplyAmount * baseScale });

    expect(await rewardToken.balanceOf(albert.address)).to.be.equal(0n);

    const supplyTimestamp = await world.timestamp();
    const albertBalance = await albert.getCometBaseBalance();
    const totalSupplyBalance = (await comet.totalSupply()).toBigInt();

    await world.increaseTime(Number(config.common.timing.oneDay));
    const preTxnTimestamp = await world.timestamp();

    const rewardsOwedBefore = (await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt();
    const txn = await (await rewards.connect(betty.signer).claimTo(comet.address, albert.address, betty.address, true)).wait();
    const rewardsOwedAfter = (await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt();

    const postTxnTimestamp = await world.timestamp();
    const timeElapsed = postTxnTimestamp - preTxnTimestamp;

    const supplySpeed = (await comet.baseTrackingSupplySpeed()).toBigInt();
    const trackingIndexScale = (await comet.trackingIndexScale()).toBigInt();
    const timestampDelta = preTxnTimestamp - supplyTimestamp;
    const totalSupplyPrincipal = (await comet.totalsBasic()).totalSupplyBase.toBigInt();
    const baseMinForRewards = (await comet.baseMinForRewards()).toBigInt();
    let expectedRewardsOwed = 0n;
    let expectedRewardsReceived = 0n;
    if (totalSupplyPrincipal >= baseMinForRewards) {
      expectedRewardsOwed = calculateRewardsOwed(albertBalance, totalSupplyBalance, supplySpeed, timestampDelta, trackingIndexScale, rewardScale, rescaleFactor.toBigInt());
      expectedRewardsReceived = calculateRewardsOwed(albertBalance, totalSupplyBalance, supplySpeed, timestampDelta + timeElapsed, trackingIndexScale, rewardScale, rescaleFactor.toBigInt());
    }

    expect(timestampDelta).to.be.greaterThanOrEqual(config.rewards.minTimeDelta);
    expect(rewardsOwedBefore).to.be.equal(expectedRewardsOwed);
    expect(await rewardToken.balanceOf(betty.address)).to.be.equal(expectedRewardsReceived);
    expect(rewardsOwedAfter).to.be.equal(0n);

    return txn;
  }
);

scenario(
  'Comet#rewards > can claim borrow rewards for self',
  {
    filter: async (ctx) => await isRewardSupported(ctx),
    tokenBalances: async (ctx) => (
      {
        albert: { $asset0: `== ${getConfigForScenario(ctx).rewards.assetAmount}` },
        $comet: { $base: `>= ${getConfigForScenario(ctx).rewards.baseAmount}` }
      }
    )
  },
  async ({ comet, rewards, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const scale = scaleBN.toBigInt();
    const toSupply = BigInt(config.rewards.assetAmount) * scale;
    const baseAssetAddress = await comet.baseToken();
    const baseScale = (await comet.baseScale()).toBigInt();
    const toBorrow = BigInt(config.rewards.baseAmount) * baseScale;

    const { rescaleFactor } = await context.getRewardConfig();
    const rewardToken = await context.getRewardToken();
    const rewardScale = exp(1, await rewardToken.decimals());

    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: collateralAssetAddress, amount: toSupply });
    await albert.withdrawAsset({ asset: baseAssetAddress, amount: toBorrow });

    expect(await rewardToken.balanceOf(albert.address)).to.be.equal(0n);

    const borrowTimestamp = await world.timestamp();
    const albertBalance = await albert.getCometBaseBalance();
    const totalBorrowBalance = (await comet.totalBorrow()).toBigInt();

    await world.increaseTime(Number(config.common.timing.oneDay));
    const preTxnTimestamp = await world.timestamp();

    const rewardsOwedBefore = (await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt();
    const txn = await (await rewards.connect(albert.signer).claim(comet.address, albert.address, true)).wait();
    const rewardsOwedAfter = (await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt();

    const postTxnTimestamp = await world.timestamp();
    const timeElapsed = postTxnTimestamp - preTxnTimestamp;

    const borrowSpeed = (await comet.baseTrackingBorrowSpeed()).toBigInt();
    const trackingIndexScale = (await comet.trackingIndexScale()).toBigInt();
    const timestampDelta = preTxnTimestamp - borrowTimestamp;
    const totalBorrowPrincipal = (await comet.totalsBasic()).totalBorrowBase.toBigInt();
    const baseMinForRewards = (await comet.baseMinForRewards()).toBigInt();
    let expectedRewardsOwed = 0n;
    let expectedRewardsReceived = 0n;
    if (totalBorrowPrincipal >= baseMinForRewards) {
      expectedRewardsOwed = calculateRewardsOwed(-albertBalance, totalBorrowBalance, borrowSpeed, timestampDelta, trackingIndexScale, rewardScale, rescaleFactor.toBigInt());
      expectedRewardsReceived = calculateRewardsOwed(-albertBalance, totalBorrowBalance, borrowSpeed, timestampDelta + timeElapsed, trackingIndexScale, rewardScale, rescaleFactor.toBigInt());
    }

    expect(timestampDelta).to.be.greaterThanOrEqual(config.rewards.minTimeDelta);
    expect(rewardsOwedBefore).to.be.equal(expectedRewardsOwed);
    expect(await rewardToken.balanceOf(albert.address)).to.be.equal(expectedRewardsReceived);
    expect(rewardsOwedAfter).to.be.equal(0n);

    return txn;
  }
);

for (let i = 0; i < 5; i++) {
  scenario(
    `Comet#rewards > can claim supply rewards on scaling rewards contract with multiplier ${i}`,
    {
      filter: async (ctx) => await isRewardSupported(ctx),
      tokenBalances: async (ctx) => (
        {
          albert: {
            $base: `== ${getConfigForScenario(ctx).rewards.baseAmount}`
          }
        }),
    },
    async (properties, context, world) => {
      const config = getConfigForScenario(context);
      return await testScalingReward(properties, context, world, config.rewards.multipliers[i]);
    }
  );
}

async function testScalingReward(properties: CometProperties, context: CometContext, world: World, multiplier: bigint): Promise<void | ContractReceipt> {
  const config = getConfigForScenario(context);
  const { comet, actors, rewards } = properties;
  const { albert } = actors;
  const baseAssetAddress = await comet.baseToken();
  const baseAsset = context.getAssetByAddress(baseAssetAddress);

  const [rewardTokenAddress, rescaleFactorWithoutMultiplier] = await rewards.rewardConfig(comet.address);
  const rewardToken = new Contract(
    rewardTokenAddress,
    ERC20__factory.createInterface(),
    world.deploymentManager.hre.ethers.provider
  );
  const rewardDecimals = await rewardToken.decimals();
  const rewardScale = exp(1, rewardDecimals);

  const newRewards = await world.deploymentManager.deploy<CometRewards, [string]>(
    'newRewards',
    'CometRewards.sol',
    [albert.address]
  );
  await newRewards.connect(albert.signer).setRewardConfigWithMultiplier(comet.address, rewardTokenAddress, multiplier);
  await context.sourceTokens(exp(Number(config.rewards.compRewardsAmount), rewardDecimals), rewardTokenAddress, newRewards.address);

  const albertBaseBalance = await baseAsset.balanceOf(albert.address);
  await baseAsset.approve(albert, comet.address);
  await albert.safeSupplyAsset({ asset: baseAssetAddress, amount: albertBaseBalance / config.rewards.albertBaseDivisor });

  expect(await rewardToken.balanceOf(albert.address)).to.be.equal(0n);

  const supplyTimestamp = await world.timestamp();
  const albertBalance = await albert.getCometBaseBalance();
  const totalSupplyBalance = (await comet.totalSupply()).toBigInt();

  await world.increaseTime(Number(config.common.timing.oneDay));
  const preTxnTimestamp = await world.timestamp();

  const newRewardsOwedBefore = (await newRewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt();
  const txn = await (await newRewards.connect(albert.signer).claim(comet.address, albert.address, true)).wait();
  const newRewardsOwedAfter = (await newRewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt();

  const postTxnTimestamp = await world.timestamp();
  const timeElapsed = postTxnTimestamp - preTxnTimestamp;

  const supplySpeed = (await comet.baseTrackingSupplySpeed()).toBigInt();
  const trackingIndexScale = (await comet.trackingIndexScale()).toBigInt();
  const timestampDelta = preTxnTimestamp - supplyTimestamp;
  const totalSupplyPrincipal = (await comet.totalsBasic()).totalSupplyBase.toBigInt();
  const baseMinForRewards = (await comet.baseMinForRewards()).toBigInt();
  let expectedRewardsOwedWithoutMultiplier = 0n;
  let expectedRewardsReceivedWithoutMultiplier = 0n; 
  if (totalSupplyPrincipal >= baseMinForRewards) {
    expectedRewardsOwedWithoutMultiplier = calculateRewardsOwed(albertBalance, totalSupplyBalance, supplySpeed, timestampDelta, trackingIndexScale, rewardScale, rescaleFactorWithoutMultiplier.toBigInt());
    expectedRewardsReceivedWithoutMultiplier = calculateRewardsOwed(albertBalance, totalSupplyBalance, supplySpeed, timestampDelta + timeElapsed, trackingIndexScale, rewardScale, rescaleFactorWithoutMultiplier.toBigInt());
  }

  expect(timestampDelta).to.be.greaterThanOrEqual(config.rewards.minTimeDelta);
  expect(newRewardsOwedBefore).to.be.equal(expectedRewardsOwedWithoutMultiplier * multiplier / config.rewards.multiplierScale);
  expect(await rewardToken.balanceOf(albert.address)).to.be.equal(expectedRewardsReceivedWithoutMultiplier * multiplier / config.rewards.multiplierScale);
  expect(newRewardsOwedAfter).to.be.equal(0n);

  return txn;
}