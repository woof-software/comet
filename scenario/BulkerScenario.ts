import { CometContext, scenario } from './context/CometContext';
import { constants, ContractReceipt, utils } from 'ethers';
import { expect } from 'chai';
import { expectBase, isRewardSupported, isBulkerSupported, getExpectedBaseBalance, matchesDeployment } from './utils';
import { exp } from '../test/helpers';
import { getConfigForScenario } from './utils/scenarioHelper';
import { NonStandardFaucetToken } from '../build/types';

function gasCost(receipt: ContractReceipt): bigint {
  return receipt.gasUsed.mul(receipt.effectiveGasPrice).toBigInt();
}

async function hasNativeAsCollateral(ctx: CometContext): Promise<boolean> {
  const comet = await ctx.getComet();
  const bulker = await ctx.getBulker();
  const wrappedNativeToken = await bulker.wrappedNativeToken();
  const numAssets = await comet.numAssets();
  for (let i = 0; i < numAssets; i++) {
    const { asset } = await comet.getAssetInfo(i);
    if (asset.toLowerCase() === wrappedNativeToken.toLowerCase()) {
      return true;
    }
  }
}

async function hasNativeAsBase(ctx: CometContext): Promise<boolean> {
  const comet = await ctx.getComet();
  const bulker = await ctx.getBulker();
  const wrappedNativeToken = await bulker.wrappedNativeToken();
  if ((await comet.baseToken()).toLowerCase() === wrappedNativeToken.toLowerCase()) return true;
}

async function isRewardsEnabled(ctx: CometContext): Promise<boolean> {
  if (!await isRewardSupported(ctx)) return false;
  const comet = await ctx.getComet();
  return (await comet.baseTrackingSupplySpeed()).toBigInt() > 0n;
}

async function getAvailableCollateralAssetIndexes(ctx: CometContext): Promise<number[]> {
  const comet = await ctx.getComet();
  const numAssets = await comet.numAssets();
  const indices: number[] = [];
  for (let i = 0; i < numAssets; i++) {
    const { supplyCap } = await comet.getAssetInfo(i);
    if (supplyCap.toBigInt() > 0n) {
      indices.push(i);
    }
  }
  return indices;
}

scenario(
  'Comet#bulker > WRON base all non-reward actions in one txn for single asset',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && matchesDeployment(ctx, [{ network: 'ronin', deployment: 'wron'}]),
    supplyCaps: async (ctx) =>  (
      {
        $asset0: getConfigForScenario(ctx).bulkerAsset,
      }
    ),
    tokenBalances: async (ctx) =>  (
      {
        albert: {
          $base: '== 0',
          $asset0: getConfigForScenario(ctx).bulkerAsset,
        },
        $comet: { $base: getConfigForScenario(ctx).bulkerComet },
      }
    ),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert, betty } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    // if asset 0 is native token we took asset 1
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const toSupplyCollateral = BigInt(getConfigForScenario(context).bulkerAsset) * collateralScale;
    const toBorrowBase = BigInt(getConfigForScenario(context).bulkerBorrowBase) * baseScale;
    const toTransferBase = BigInt(getConfigForScenario(context).bulkerBorrowAsset) * baseScale;
    const toSupplyWron = exp(0.01, 18);
    const toWithdrawWron = exp(0.005, 18);

    // Approvals
    await collateralAsset.approve(albert, comet.address);
    await albert.allow(bulker.address, true);

    // Initial expectations
    expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(toSupplyCollateral);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);

    // Albert's actions:
    // 1. Supplies 3000 units of collateral
    // 2. Borrows 1000 base
    // 3. Transfers 500 base to Betty
    // 4. Supplies 0.01 RON
    // 5. Withdraws 0.005 RON
    const supplyAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, collateralAsset.address, toSupplyCollateral]);
    const withdrawAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, baseAsset.address, toBorrowBase]);
    const transferAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, betty.address, baseAsset.address, toTransferBase]);
    const supplyEthCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toSupplyWron]);
    const withdrawEthCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toWithdrawWron]);
    const calldata = [
      supplyAssetCalldata,
      withdrawAssetCalldata,
      transferAssetCalldata,
    ];
    const actions = [
      await bulker.ACTION_SUPPLY_ASSET(),
      await bulker.ACTION_WITHDRAW_ASSET(),
      await bulker.ACTION_TRANSFER_ASSET(),
    ];

    if (await hasNativeAsCollateral(context) || await hasNativeAsBase(context)) {
      calldata.push(supplyEthCalldata);
      calldata.push(withdrawEthCalldata);
      actions.push(await bulker.ACTION_SUPPLY_NATIVE_TOKEN());
      actions.push(await bulker.ACTION_WITHDRAW_NATIVE_TOKEN());
    }

    const txn = await albert.invoke({ actions, calldata }, { value: toSupplyWron });

    // Final expectations
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseTransferred = getExpectedBaseBalance(toTransferBase, baseIndexScale, baseSupplyIndex);
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(toSupplyCollateral);
    if (await hasNativeAsCollateral(context)) expect(await comet.collateralBalanceOf(albert.address, wrappedNativeToken)).to.be.equal(toSupplyWron - toWithdrawWron);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(toBorrowBase);
    expectBase((await comet.balanceOf(betty.address)).toBigInt(), baseTransferred);
    expectBase((await comet.borrowBalanceOf(albert.address)).toBigInt(), toBorrowBase + toTransferBase - toWithdrawWron);

    return txn; // return txn to measure gas
  }
);

// XXX properly handle cases where asset0 is WETH
scenario(
  'Comet#bulker > (non-WETH base) all non-reward actions in one txn',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && !matchesDeployment(ctx, [{ deployment: 'weth' }, { deployment: 'wsteth' }, { network: 'ronin', deployment: 'wron'}]),
    supplyCaps: async (ctx) => (
      {
        $asset0: getConfigForScenario(ctx).bulkerAsset,
        $asset1: getConfigForScenario(ctx).bulkerAsset1,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: {
          $base: '== 0',
          $asset0: getConfigForScenario(ctx).bulkerAsset,
          $asset1: getConfigForScenario(ctx).bulkerAsset1
        },
        $comet: { $base: getConfigForScenario(ctx).bulkerComet },
      }
    ),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert, betty } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    // if asset 0 is native token we took asset 1
    const { asset: asset0, scale: scale0 } = await comet.getAssetInfo(0);
    const { asset: asset1, scale: scale1 } = await comet.getAssetInfo(1);
    const { asset: collateralAssetAddress, scale: scaleBN } = asset0 === wrappedNativeToken ? { asset: asset1, scale: scale1 } : { asset: asset0, scale: scale0 };
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const toSupplyCollateral = BigInt(asset0 === wrappedNativeToken ? getConfigForScenario(context).bulkerAsset1 : getConfigForScenario(context).bulkerAsset) * collateralScale;
    const toBorrowBase = BigInt(getConfigForScenario(context).bulkerBorrowBase) * baseScale;
    const toTransferBase = BigInt(getConfigForScenario(context).bulkerBorrowAsset) * baseScale;
    const toSupplyEth = exp(0.01, 18);
    const toWithdrawEth = exp(0.005, 18);

    // Approvals
    await collateralAsset.approve(albert, comet.address);
    await albert.allow(bulker.address, true);

    // Initial expectations
    expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(toSupplyCollateral);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);

    // Albert's actions:
    // 1. Supplies 3000 units of collateral
    // 2. Borrows 1000 base
    // 3. Transfers 500 base to Betty
    // 4. Supplies 0.01 ETH
    // 5. Withdraws 0.005 ETH
    const supplyAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, collateralAsset.address, toSupplyCollateral]);
    const withdrawAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, baseAsset.address, toBorrowBase]);
    const transferAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, betty.address, baseAsset.address, toTransferBase]);
    const supplyEthCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toSupplyEth]);
    const withdrawEthCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toWithdrawEth]);
    const calldata = [
      supplyAssetCalldata,
      withdrawAssetCalldata,
      transferAssetCalldata
    ];
    const actions = [
      await bulker.ACTION_SUPPLY_ASSET(),
      await bulker.ACTION_WITHDRAW_ASSET(),
      await bulker.ACTION_TRANSFER_ASSET()
    ];

    if (await hasNativeAsCollateral(context) || await hasNativeAsBase(context)) {
      calldata.push(supplyEthCalldata);
      calldata.push(withdrawEthCalldata);
      actions.push(await bulker.ACTION_SUPPLY_NATIVE_TOKEN());
      actions.push(await bulker.ACTION_WITHDRAW_NATIVE_TOKEN());
    }

    const txn = await albert.invoke({ actions, calldata }, { value: toSupplyEth });

    // Final expectations
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseTransferred = getExpectedBaseBalance(toTransferBase, baseIndexScale, baseSupplyIndex);
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(toSupplyCollateral);
    if (await hasNativeAsCollateral(context)) expect(await comet.collateralBalanceOf(albert.address, wrappedNativeToken)).to.be.equal(toSupplyEth - toWithdrawEth);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(toBorrowBase);
    expectBase((await comet.balanceOf(betty.address)).toBigInt(), baseTransferred);
    expectBase((await comet.borrowBalanceOf(albert.address)).toBigInt(), toBorrowBase + toTransferBase);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#bulker > (WETH base) all non-reward actions in one txn',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) &&
      matchesDeployment(ctx, [{ deployment: 'weth' }, { network: 'ronin', deployment: 'wron'}]) &&
      !matchesDeployment(ctx, [{ network: 'ronin', deployment: 'weth' }]),
    supplyCaps: async (ctx) => (
      {
        $asset0: getConfigForScenario(ctx).bulkerAsset,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: {
          $base: '== 0',
          $asset0: getConfigForScenario(ctx).bulkerAsset
        },
        $comet: { $base: getConfigForScenario(ctx).bulkerComet },
      }
    ),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const toSupplyCollateral = BigInt(getConfigForScenario(context).bulkerAsset) * collateralScale;
    const toBorrowBase = BigInt(getConfigForScenario(context).bulkerBorrowBase) * baseScale;
    const toTransferBase = BigInt(getConfigForScenario(context).bulkerBorrowAsset) * baseScale;
    const toSupplyEth = exp(0.01, 18);
    const toWithdrawEth = exp(0.005, 18);

    // Approvals
    await collateralAsset.approve(albert, comet.address);
    await albert.allow(bulker.address, true);

    // Initial expectations
    expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(toSupplyCollateral);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);

    // Albert's actions:
    // 1. Supplies 3000 units of collateral
    // 2. Borrows 1500 base
    // 3. Transfers 500 base to Betty
    // 4. Supplies 0.01 ETH
    // 5. Withdraws 0.005 ETH
    const supplyAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, collateralAsset.address, toSupplyCollateral]);
    const withdrawAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, baseAsset.address, toBorrowBase]);
    const transferAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, betty.address, baseAsset.address, toTransferBase]);
    const supplyNativeTokenCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toSupplyEth]);
    const withdrawNativeTokenCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toWithdrawEth]);
    const calldata = [
      supplyAssetCalldata,
      withdrawAssetCalldata,
      transferAssetCalldata,
      supplyNativeTokenCalldata,
      withdrawNativeTokenCalldata
    ];
    const actions = [
      await bulker.ACTION_SUPPLY_ASSET(),
      await bulker.ACTION_WITHDRAW_ASSET(),
      await bulker.ACTION_TRANSFER_ASSET(),
      await bulker.ACTION_SUPPLY_NATIVE_TOKEN(),
      await bulker.ACTION_WITHDRAW_NATIVE_TOKEN(),
    ];
    const txn = await albert.invoke({ actions, calldata }, { value: toSupplyEth });

    // Final expectations
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseTransferred = getExpectedBaseBalance(toTransferBase, baseIndexScale, baseSupplyIndex);
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(toSupplyCollateral);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(toBorrowBase);
    expectBase((await comet.balanceOf(betty.address)).toBigInt(), baseTransferred);
    expectBase((await comet.borrowBalanceOf(albert.address)).toBigInt(), toBorrowBase + toTransferBase - (toSupplyEth - toWithdrawEth));

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#bulker > (non-WETH base) all actions in one txn for single asset',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await isRewardSupported(ctx) && matchesDeployment(ctx, [{ network: 'ronin', deployment: 'wron'}]),
    supplyCaps: async (ctx) =>  (
      {
        $asset0: getConfigForScenario(ctx).bulkerAsset,
      }
    ),
    tokenBalances: async (ctx) =>  (
      {
        albert: {
          $base: `==  ${getConfigForScenario(ctx).bulkerBase}`,
          $asset0: getConfigForScenario(ctx).bulkerAsset,
        },
        $comet: { $base: getConfigForScenario(ctx).bulkerComet },
      }
    ),
  },
  async ({ comet, actors, rewards, bulker }, context, world) => {
    const { albert, betty } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    // if asset 0 is native token we took asset 1
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const [rewardTokenAddress] = await rewards.rewardConfig(comet.address);
    const toSupplyBase = BigInt(getConfigForScenario(context).bulkerBase) * baseScale;
    const toSupplyCollateral = BigInt(getConfigForScenario(context).bulkerAsset) * collateralScale;
    const toBorrowBase = BigInt(getConfigForScenario(context).bulkerBorrowBase) * baseScale;
    const toTransferBase = BigInt(getConfigForScenario(context).bulkerBorrowAsset) * baseScale;
    const toSupplyEth = exp(0.01, 18);
    const toWithdrawEth = exp(0.005, 18);

    // Approvals
    await baseAsset.approve(albert, comet.address);
    await collateralAsset.approve(albert, comet.address);
    await albert.allow(bulker.address, true);

    // Accrue some rewards to Albert, then transfer away Albert's supplied base
    await albert.safeSupplyAsset({ asset: baseAssetAddress, amount: toSupplyBase });
    await world.increaseTime(86400); // fast forward a day
    await albert.transferAsset({ dst: constants.AddressZero, asset: baseAssetAddress, amount: constants.MaxUint256 }); // transfer all base away

    // Initial expectations
    expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(toSupplyCollateral);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);
    const startingRewardBalance = await albert.getErc20Balance(rewardTokenAddress);
    const rewardOwed = ((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed).toBigInt();
    const expectedFinalRewardBalance = collateralAssetAddress === rewardTokenAddress ?
      startingRewardBalance + rewardOwed - toSupplyCollateral :
      startingRewardBalance + rewardOwed;

    // Albert's actions:
    // 1. Supplies 3000 units of collateral
    // 2. Borrows 1000 base
    // 3. Transfers 500 base to Betty
    // 4. Supplies 0.01 ETH
    // 5. Withdraws 0.005 ETH
    // 6. Claim rewards
    const supplyAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, collateralAsset.address, toSupplyCollateral]);
    const withdrawAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, baseAsset.address, toBorrowBase]);
    const transferAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, betty.address, baseAsset.address, toTransferBase]);
    const supplyEthCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toSupplyEth]);
    const withdrawEthCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toWithdrawEth]);
    const claimRewardCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'bool'], [comet.address, rewards.address, albert.address, true]);
    const calldata = [
      supplyAssetCalldata,
      withdrawAssetCalldata,
      transferAssetCalldata,
      claimRewardCalldata
    ];
    const actions = [
      await bulker.ACTION_SUPPLY_ASSET(),
      await bulker.ACTION_WITHDRAW_ASSET(),
      await bulker.ACTION_TRANSFER_ASSET(),
      await bulker.ACTION_CLAIM_REWARD(),
    ];

    if (await hasNativeAsCollateral(context) || await hasNativeAsBase(context)) {
      calldata.push(supplyEthCalldata);
      calldata.push(withdrawEthCalldata);
      actions.push(await bulker.ACTION_SUPPLY_NATIVE_TOKEN());
      actions.push(await bulker.ACTION_WITHDRAW_NATIVE_TOKEN());
    }

    const txn = await albert.invoke({ actions, calldata }, { value: toSupplyEth });

    // Final expectations
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseTransferred = getExpectedBaseBalance(toTransferBase, baseIndexScale, baseSupplyIndex);
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(toSupplyCollateral);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(toBorrowBase);
    if (await hasNativeAsCollateral(context)) expect(await comet.collateralBalanceOf(albert.address, wrappedNativeToken)).to.be.equal(toSupplyEth - toWithdrawEth);
    expect(await albert.getErc20Balance(rewardTokenAddress)).to.be.equal(expectedFinalRewardBalance);
    expectBase((await comet.balanceOf(betty.address)).toBigInt(), baseTransferred);
    expectBase((await comet.borrowBalanceOf(albert.address)).toBigInt(), toBorrowBase + toTransferBase);

    return txn; // return txn to measure gas
  }
);

// XXX properly handle cases where asset0 is WETH
scenario(
  'Comet#bulker > (non-WETH base) all actions in one txn',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await isRewardSupported(ctx) && !matchesDeployment(ctx, [{ deployment: 'weth' }, { deployment: 'wsteth' }, { network: 'base', deployment: 'usds' }, { deployment: 'wsteth' }, { network: 'ronin', deployment: 'wron'}]),
    supplyCaps: async (ctx) => (
      {
        $asset0: getConfigForScenario(ctx).bulkerAsset,
        $asset1: getConfigForScenario(ctx).bulkerAsset1,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: {
          $base: `==  ${getConfigForScenario(ctx).bulkerBase}`,
          $asset0: getConfigForScenario(ctx).bulkerAsset,
          $asset1: getConfigForScenario(ctx).bulkerAsset1
        },
        $comet: { $base: getConfigForScenario(ctx).bulkerComet },
      }
    ),
  },
  async ({ comet, actors, rewards, bulker }, context, world) => {
    const { albert, betty } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    // if asset 0 is native token we took asset 1
    const { asset: asset0, scale: scale0 } = await comet.getAssetInfo(0);
    const { asset: asset1, scale: scale1 } = await comet.getAssetInfo(1);
    const { asset: collateralAssetAddress, scale: scaleBN } = asset0 === wrappedNativeToken ? { asset: asset1, scale: scale1 } : { asset: asset0, scale: scale0 };
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const [rewardTokenAddress] = await rewards.rewardConfig(comet.address);
    const toSupplyBase = BigInt(getConfigForScenario(context).bulkerBase) * baseScale;
    const toSupplyCollateral = BigInt(asset0 === wrappedNativeToken ? getConfigForScenario(context).bulkerAsset1 : getConfigForScenario(context).bulkerAsset) * collateralScale;
    const toBorrowBase = BigInt(getConfigForScenario(context).bulkerBorrowBase) * baseScale;
    const toTransferBase = BigInt(getConfigForScenario(context).bulkerBorrowAsset) * baseScale;
    const toSupplyEth = exp(0.01, 18);
    const toWithdrawEth = exp(0.005, 18);

    // Approvals
    await baseAsset.approve(albert, comet.address);
    await collateralAsset.approve(albert, comet.address);
    await albert.allow(bulker.address, true);

    // Accrue some rewards to Albert, then transfer away Albert's supplied base
    await albert.safeSupplyAsset({ asset: baseAssetAddress, amount: toSupplyBase });
    await world.increaseTime(86400); // fast forward a day
    await albert.transferAsset({ dst: constants.AddressZero, asset: baseAssetAddress, amount: constants.MaxUint256 }); // transfer all base away

    // Initial expectations
    expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(toSupplyCollateral);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);
    const startingRewardBalance = await albert.getErc20Balance(rewardTokenAddress);
    const rewardOwed = ((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed).toBigInt();
    const expectedFinalRewardBalance = collateralAssetAddress === rewardTokenAddress ?
      startingRewardBalance + rewardOwed - toSupplyCollateral :
      startingRewardBalance + rewardOwed;

    // Albert's actions:
    // 1. Supplies 3000 units of collateral
    // 2. Borrows 1000 base
    // 3. Transfers 500 base to Betty
    // 4. Supplies 0.01 ETH
    // 5. Withdraws 0.005 ETH
    // 6. Claim rewards
    const supplyAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, collateralAsset.address, toSupplyCollateral]);
    const withdrawAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, baseAsset.address, toBorrowBase]);
    const transferAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, betty.address, baseAsset.address, toTransferBase]);
    const supplyEthCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toSupplyEth]);
    const withdrawEthCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toWithdrawEth]);
    const claimRewardCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'bool'], [comet.address, rewards.address, albert.address, true]);
    const calldata = [
      supplyAssetCalldata,
      withdrawAssetCalldata,
      transferAssetCalldata,
      claimRewardCalldata
    ];
    const actions = [
      await bulker.ACTION_SUPPLY_ASSET(),
      await bulker.ACTION_WITHDRAW_ASSET(),
      await bulker.ACTION_TRANSFER_ASSET(),
      await bulker.ACTION_CLAIM_REWARD(),
    ];

    if (await hasNativeAsCollateral(context) || await hasNativeAsBase(context)) {
      calldata.push(supplyEthCalldata);
      calldata.push(withdrawEthCalldata);
      actions.push(await bulker.ACTION_SUPPLY_NATIVE_TOKEN());
      actions.push(await bulker.ACTION_WITHDRAW_NATIVE_TOKEN());
    }

    const txn = await albert.invoke({ actions, calldata }, { value: toSupplyEth });

    // Final expectations
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseTransferred = getExpectedBaseBalance(toTransferBase, baseIndexScale, baseSupplyIndex);
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(toSupplyCollateral);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(toBorrowBase);
    if (await hasNativeAsCollateral(context)) expect(await comet.collateralBalanceOf(albert.address, wrappedNativeToken)).to.be.equal(toSupplyEth - toWithdrawEth);
    expect(await albert.getErc20Balance(rewardTokenAddress)).to.be.equal(expectedFinalRewardBalance);
    expectBase((await comet.balanceOf(betty.address)).toBigInt(), baseTransferred);
    expectBase((await comet.borrowBalanceOf(albert.address)).toBigInt(), toBorrowBase + toTransferBase);

    return txn; // return txn to measure gas
  }
);


scenario(
  'Comet#bulker > (wstETH base) all actions in one txn',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await isRewardSupported(ctx) && matchesDeployment(ctx, [{ deployment: 'wsteth' }]),
    supplyCaps: async (ctx) =>  (
      {
        $asset0: getConfigForScenario(ctx).bulkerAsset,
        $asset1: getConfigForScenario(ctx).bulkerAsset1,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: {
          $base: `== ${getConfigForScenario(ctx).bulkerBase}`,
          $asset0: getConfigForScenario(ctx).bulkerAsset,
          $asset1: getConfigForScenario(ctx).bulkerAsset1
        },
        $comet: { $base: getConfigForScenario(ctx).bulkerComet },
      }
    ),
  },
  async ({ comet, actors, rewards, bulker }, context, world) => {
    const { albert, betty } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    // if asset 0 is native token we took asset 1
    const { asset: asset0, scale: scale0 } = await comet.getAssetInfo(0);
    const { asset: asset1, scale: scale1 } = await comet.getAssetInfo(1);
    const { asset: collateralAssetAddress, scale: scaleBN } = asset0 === wrappedNativeToken ? { asset: asset1, scale: scale1 } : { asset: asset0, scale: scale0 };
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const [rewardTokenAddress] = await rewards.rewardConfig(comet.address);
    const toSupplyBase = BigInt(getConfigForScenario(context).bulkerBase) * baseScale;
    const toSupplyCollateral = BigInt(asset0 === wrappedNativeToken ? getConfigForScenario(context).bulkerAsset1 : getConfigForScenario(context).bulkerAsset) * collateralScale;
    const toBorrowBase = BigInt(getConfigForScenario(context).bulkerBorrowBase) * baseScale;
    const toTransferBase = BigInt(getConfigForScenario(context).bulkerBorrowAsset) * baseScale;
    const toSupplyEth = exp(0.01, 18);
    const toWithdrawEth = exp(0.005, 18);

    // Approvals
    await baseAsset.approve(albert, comet.address);
    await collateralAsset.approve(albert, comet.address);
    await albert.allow(bulker.address, true);

    // Accrue some rewards to Albert, then transfer away Albert's supplied base
    await albert.safeSupplyAsset({ asset: baseAssetAddress, amount: toSupplyBase });
    await world.increaseTime(86400); // fast forward a day
    await albert.transferAsset({ dst: constants.AddressZero, asset: baseAssetAddress, amount: constants.MaxUint256 }); // transfer all base away

    // Initial expectations
    expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(toSupplyCollateral);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);
    const startingRewardBalance = await albert.getErc20Balance(rewardTokenAddress);
    const rewardOwed = ((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed).toBigInt();
    const expectedFinalRewardBalance = collateralAssetAddress === rewardTokenAddress ?
      startingRewardBalance + rewardOwed - toSupplyCollateral :
      startingRewardBalance + rewardOwed;

    // Albert's actions:
    // 1. Supplies 3000 units of collateral
    // 2. Borrows 1000 base
    // 3. Transfers 500 base to Betty
    // 4. Supplies 0.01 ETH
    // 5. Withdraws 0.005 ETH
    // 6. Claim rewards
    const supplyAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, collateralAsset.address, toSupplyCollateral]);
    const withdrawAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, baseAsset.address, toBorrowBase]);
    const transferAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, betty.address, baseAsset.address, toTransferBase]);
    const supplyEthCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toSupplyEth]);
    const withdrawEthCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toWithdrawEth]);
    const claimRewardCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'bool'], [comet.address, rewards.address, albert.address, true]);
    const calldata = [
      supplyAssetCalldata,
      withdrawAssetCalldata,
      transferAssetCalldata,
      claimRewardCalldata
    ];
    const actions = [
      await bulker.ACTION_SUPPLY_ASSET(),
      await bulker.ACTION_WITHDRAW_ASSET(),
      await bulker.ACTION_TRANSFER_ASSET(),
      await bulker.ACTION_CLAIM_REWARD(),
    ];

    if (await hasNativeAsCollateral(context) || await hasNativeAsBase(context)) {
      calldata.push(supplyEthCalldata);
      calldata.push(withdrawEthCalldata);
      actions.push(await bulker.ACTION_SUPPLY_NATIVE_TOKEN());
      actions.push(await bulker.ACTION_WITHDRAW_NATIVE_TOKEN());
    }

    const txn = await albert.invoke({ actions, calldata }, { value: toSupplyEth });

    // Final expectations
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseTransferred = getExpectedBaseBalance(toTransferBase, baseIndexScale, baseSupplyIndex);
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(toSupplyCollateral);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(toBorrowBase);
    if (await hasNativeAsCollateral(context)) expect(await comet.collateralBalanceOf(albert.address, wrappedNativeToken)).to.be.equal(toSupplyEth - toWithdrawEth);
    expect(await albert.getErc20Balance(rewardTokenAddress)).to.be.equal(expectedFinalRewardBalance);
    expectBase((await comet.balanceOf(betty.address)).toBigInt(), baseTransferred);
    expectBase((await comet.borrowBalanceOf(albert.address)).toBigInt(), toBorrowBase + toTransferBase);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#bulker > (WETH base) all actions in one txn',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) &&
      await isRewardSupported(ctx) &&
      matchesDeployment(ctx, [{ deployment: 'weth' }, { network: 'ronin', deployment: 'wron'}]) &&
      !matchesDeployment(ctx, [{ network: 'ronin', deployment: 'weth'}]),
    supplyCaps: async (ctx) => (
      {
        $asset0: getConfigForScenario(ctx).bulkerAsset2,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: { $base: `== ${getConfigForScenario(ctx).bulkerBase1}`, $asset0: getConfigForScenario(ctx).bulkerAsset2 },
        $comet: { $base: getConfigForScenario(ctx).bulkerComet },
      }
    ),
  },
  async ({ comet, actors, rewards, bulker }, context, world) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const [rewardTokenAddress] = await rewards.rewardConfig(comet.address);
    const toSupplyBase = BigInt(getConfigForScenario(context).bulkerBase1) * baseScale;
    const toSupplyCollateral = BigInt(getConfigForScenario(context).bulkerAsset2) * collateralScale;
    const toBorrowBase = 5n * baseScale;
    const toTransferBase = 2n * baseScale;
    const toSupplyEth = exp(0.01, 18);
    const toWithdrawEth = exp(0.005, 18);

    // Approvals
    await baseAsset.approve(albert, comet.address);
    await collateralAsset.approve(albert, comet.address);
    await albert.allow(bulker.address, true);

    // Accrue some rewards to Albert, then transfer away Albert's supplied base
    await albert.safeSupplyAsset({ asset: baseAssetAddress, amount: toSupplyBase });
    await world.increaseTime(86400); // fast forward a day
    await albert.transferAsset({ dst: constants.AddressZero, asset: baseAssetAddress, amount: constants.MaxUint256 }); // transfer all base away

    // Initial expectations
    expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(toSupplyCollateral);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);
    const startingRewardBalance = await albert.getErc20Balance(rewardTokenAddress);
    const rewardOwed = ((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed).toBigInt();
    const expectedFinalRewardBalance = collateralAssetAddress === rewardTokenAddress ?
      startingRewardBalance + rewardOwed - toSupplyCollateral :
      startingRewardBalance + rewardOwed;

    // Albert's actions:
    // 1. Supplies 10 units of collateral
    // 2. Borrows 5 base
    // 3. Transfers 2 base to Betty
    // 4. Supplies 0.01 ETH
    // 5. Withdraws 0.005 ETH
    // 6. Claim rewards
    const supplyAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, collateralAsset.address, toSupplyCollateral]);
    const withdrawAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, baseAsset.address, toBorrowBase]);
    const transferAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, betty.address, baseAsset.address, toTransferBase]);
    const supplyNativeTokenCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toSupplyEth]);
    const withdrawNativeTokenCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toWithdrawEth]);
    const claimRewardCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'bool'], [comet.address, rewards.address, albert.address, true]);
    const calldata = [
      supplyAssetCalldata,
      withdrawAssetCalldata,
      transferAssetCalldata,
      supplyNativeTokenCalldata,
      withdrawNativeTokenCalldata,
      claimRewardCalldata
    ];
    const actions = [
      await bulker.ACTION_SUPPLY_ASSET(),
      await bulker.ACTION_WITHDRAW_ASSET(),
      await bulker.ACTION_TRANSFER_ASSET(),
      await bulker.ACTION_SUPPLY_NATIVE_TOKEN(),
      await bulker.ACTION_WITHDRAW_NATIVE_TOKEN(),
      await bulker.ACTION_CLAIM_REWARD(),
    ];
    const txn = await albert.invoke({ actions, calldata }, { value: toSupplyEth });

    // Final expectations
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseTransferred = getExpectedBaseBalance(toTransferBase, baseIndexScale, baseSupplyIndex);
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(toSupplyCollateral);
    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(toBorrowBase);
    expect(await albert.getErc20Balance(rewardTokenAddress)).to.be.equal(expectedFinalRewardBalance);
    expectBase((await comet.balanceOf(betty.address)).toBigInt(), baseTransferred);
    // NOTE: differs from the equivalent scenario for non-ETH markets
    expectBase((await comet.borrowBalanceOf(albert.address)).toBigInt(), toBorrowBase + toTransferBase - (toSupplyEth - toWithdrawEth));

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#bulker > admin and wrappedNativeToken are wired correctly',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ comet, bulker }) => {
    expect(await bulker.admin()).to.be.equal(await comet.governor());
    expect(await bulker.wrappedNativeToken()).to.not.be.equal(constants.AddressZero);
  }
);

scenario(
  'Comet#bulker > receive() accepts ETH directly',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ actors, bulker }, _context, world) => {
    const { albert } = actors;
    const sendAmount = exp(0.01, 18);

    const bulkerBalanceBefore = await world.deploymentManager.hre.ethers.provider.getBalance(bulker.address);
    await albert.sendEth(bulker.address, 0.01);
    const bulkerBalanceAfter = await world.deploymentManager.hre.ethers.provider.getBalance(bulker.address);

    expect(bulkerBalanceAfter.sub(bulkerBalanceBefore)).to.be.equal(sendAmount);
  }
);

scenario(
  'Comet#bulker > ACTION_SUPPLY_ASSET supplies a collateral asset',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
    supplyCaps: async (ctx) => (
      {
        $asset0: getConfigForScenario(ctx).bulkerAsset,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).bulkerAsset },
      }
    ),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert, betty } = actors;
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const toSupply = BigInt(getConfigForScenario(context).bulkerAsset) * scaleBN.toBigInt();

    await collateralAsset.approve(albert, comet.address);
    await albert.allow(bulker.address, true);

    // Supplies on behalf of msg.sender (albert) to a different account (betty)
    const supplyAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, betty.address, collateralAssetAddress, toSupply]);
    await albert.invoke({ actions: [await bulker.ACTION_SUPPLY_ASSET()], calldata: [supplyAssetCalldata] });

    expect(await comet.collateralBalanceOf(betty.address, collateralAssetAddress)).to.be.equal(toSupply);
  }
);

scenario(
  'Comet#bulker > ACTION_SUPPLY_ASSET supplies the base asset',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
    tokenBalances: async (ctx) => (
      {
        albert: { $base: `== ${getConfigForScenario(ctx).bulkerBase1}` },
      }
    ),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const toSupply = BigInt(getConfigForScenario(context).bulkerBase1) * (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await albert.allow(bulker.address, true);

    const supplyAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, baseAssetAddress, toSupply]);
    await albert.invoke({ actions: [await bulker.ACTION_SUPPLY_ASSET()], calldata: [supplyAssetCalldata] });

    expectBase((await comet.balanceOf(albert.address)).toBigInt(), toSupply);
  }
);

scenario(
  'Comet#bulker > ACTION_SUPPLY_NATIVE_TOKEN with exact msg.value',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && (await hasNativeAsCollateral(ctx) || await hasNativeAsBase(ctx)),
  },
  async ({ comet, actors, bulker }, context, world) => {
    const { albert } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const toSupply = exp(0.01, 18);

    const supplyNativeTokenCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toSupply]);
    const bulkerBalanceBefore = await world.deploymentManager.hre.ethers.provider.getBalance(bulker.address);
    await albert.invoke({ actions: [await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], calldata: [supplyNativeTokenCalldata] }, { value: toSupply });

    expect(await world.deploymentManager.hre.ethers.provider.getBalance(bulker.address)).to.be.equal(bulkerBalanceBefore);
    if (await hasNativeAsBase(context)) {
      expectBase((await comet.balanceOf(albert.address)).toBigInt(), toSupply);
    } else {
      expect(await comet.collateralBalanceOf(albert.address, wrappedNativeToken)).to.be.equal(toSupply);
    }
  }
);

scenario(
  'Comet#bulker > ACTION_SUPPLY_NATIVE_TOKEN refunds unused ETH',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && (await hasNativeAsCollateral(ctx) || await hasNativeAsBase(ctx)),
  },
  async ({ comet, actors, bulker }, context, world) => {
    const { albert } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const toSupply = exp(0.01, 18);

    const supplyNativeTokenCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toSupply]);
    const albertBalanceBefore = await albert.getEthBalance();
    const bulkerBalanceBefore = await world.deploymentManager.hre.ethers.provider.getBalance(bulker.address);
    const receipt = await albert.invoke(
      { actions: [await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], calldata: [supplyNativeTokenCalldata] },
      { value: toSupply * 2n }
    );
    const albertBalanceAfter = await albert.getEthBalance();

    expect(albertBalanceBefore.toBigInt() - albertBalanceAfter.toBigInt()).to.be.equal(toSupply + gasCost(receipt));
    expect(await world.deploymentManager.hre.ethers.provider.getBalance(bulker.address)).to.be.equal(bulkerBalanceBefore);
    if (await hasNativeAsBase(context)) {
      expectBase((await comet.balanceOf(albert.address)).toBigInt(), toSupply);
    } else {
      expect(await comet.collateralBalanceOf(albert.address, wrappedNativeToken)).to.be.equal(toSupply);
    }
  }
);

scenario(
  'Comet#bulker > ACTION_SUPPLY_NATIVE_TOKEN amount=max repays full base debt',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await hasNativeAsBase(ctx),
    supplyCaps: async (ctx) => (
      {
        $asset0: getConfigForScenario(ctx).bulkerAsset2,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: { $base: '== 0', $asset0: getConfigForScenario(ctx).bulkerAsset2 },
      }
    ),
  },
  async ({ comet, actors, bulker }, context, world) => {
    const { albert } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const toSupplyCollateral = BigInt(getConfigForScenario(context).bulkerAsset2) * scaleBN.toBigInt();
    const toBorrowBase = exp(0.01, 18);

    // Albert borrows some native-token base directly against fresh collateral
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: collateralAssetAddress, amount: toSupplyCollateral });
    await albert.withdrawAsset({ asset: wrappedNativeToken, amount: toBorrowBase });

    const borrowBalanceBefore = (await comet.callStatic.borrowBalanceOf(albert.address)).toBigInt();
    expect(borrowBalanceBefore).to.be.greaterThan(0n);

    // Albert repays the full debt through the bulker, sending more ETH than is owed
    const extraEth = exp(0.005, 18);
    const supplyNativeTokenCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, constants.MaxUint256]);
    const albertBalanceBefore = await albert.getEthBalance();
    const receipt = await albert.invoke(
      { actions: [await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], calldata: [supplyNativeTokenCalldata] },
      { value: borrowBalanceBefore + extraEth }
    );
    const albertBalanceAfter = await albert.getEthBalance();

    expect(await comet.borrowBalanceOf(albert.address)).to.be.equal(0n);
    expect(await world.deploymentManager.hre.ethers.provider.getBalance(bulker.address)).to.be.equal(0n);
    expect(albertBalanceBefore.toBigInt() - albertBalanceAfter.toBigInt()).to.be.equal(borrowBalanceBefore + gasCost(receipt));
  }
);

scenario(
  'Comet#bulker > ACTION_TRANSFER_ASSET transfers a collateral asset',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
    supplyCaps: async (ctx) => (
      {
        $asset0: getConfigForScenario(ctx).bulkerAsset,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).bulkerAsset },
      }
    ),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert, betty } = actors;
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const toTransfer = BigInt(getConfigForScenario(context).bulkerAsset) * scaleBN.toBigInt();

    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: collateralAssetAddress, amount: toTransfer });
    await albert.allow(bulker.address, true);

    const transferAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, betty.address, collateralAssetAddress, toTransfer]);
    await albert.invoke({ actions: [await bulker.ACTION_TRANSFER_ASSET()], calldata: [transferAssetCalldata] });

    expect(await comet.collateralBalanceOf(albert.address, collateralAssetAddress)).to.be.equal(0n);
    expect(await comet.collateralBalanceOf(betty.address, collateralAssetAddress)).to.be.equal(toTransfer);
  }
);

scenario(
  'Comet#bulker > ACTION_WITHDRAW_ASSET withdraws a collateral asset',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
    supplyCaps: async (ctx) => (
      {
        $asset0: getConfigForScenario(ctx).bulkerAsset,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).bulkerAsset },
      }
    ),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert, betty } = actors;
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const toWithdraw = BigInt(getConfigForScenario(context).bulkerAsset) * scaleBN.toBigInt();

    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: collateralAssetAddress, amount: toWithdraw });
    await albert.allow(bulker.address, true);

    const withdrawAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, betty.address, collateralAssetAddress, toWithdraw]);
    await albert.invoke({ actions: [await bulker.ACTION_WITHDRAW_ASSET()], calldata: [withdrawAssetCalldata] });

    expect(await comet.collateralBalanceOf(albert.address, collateralAssetAddress)).to.be.equal(0n);
    expect(await collateralAsset.balanceOf(betty.address)).to.be.equal(toWithdraw);
  }
);

scenario(
  'Comet#bulker > ACTION_WITHDRAW_NATIVE_TOKEN withdraws native-token collateral',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await hasNativeAsCollateral(ctx),
  },
  async ({ comet, actors, bulker }) => {
    const { albert, betty } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const toSupply = exp(0.02, 18);
    const toWithdraw = exp(0.01, 18);

    const supplyNativeTokenCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toSupply]);
    await albert.invoke({ actions: [await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], calldata: [supplyNativeTokenCalldata] }, { value: toSupply });
    await albert.allow(bulker.address, true);

    const bettyBalanceBefore = await betty.getEthBalance();
    const withdrawNativeTokenCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, betty.address, toWithdraw]);
    await albert.invoke({ actions: [await bulker.ACTION_WITHDRAW_NATIVE_TOKEN()], calldata: [withdrawNativeTokenCalldata] });
    const bettyBalanceAfter = await betty.getEthBalance();

    expect(await comet.collateralBalanceOf(albert.address, wrappedNativeToken)).to.be.equal(toSupply - toWithdraw);
    expect(bettyBalanceAfter.sub(bettyBalanceBefore)).to.be.equal(toWithdraw);
  }
);

scenario(
  'Comet#bulker > ACTION_WITHDRAW_NATIVE_TOKEN amount=max withdraws full base balance',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await hasNativeAsBase(ctx),
    tokenBalances: async (ctx) => (
      {
        albert: { $base: `== ${getConfigForScenario(ctx).bulkerBase1}` },
      }
    ),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    const toSupplyBase = BigInt(getConfigForScenario(context).bulkerBase1) * baseScale;

    await baseAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: baseAssetAddress, amount: toSupplyBase });
    await albert.allow(bulker.address, true);

    const balanceBefore = (await comet.callStatic.balanceOf(albert.address)).toBigInt();
    expect(balanceBefore).to.be.greaterThan(0n);

    const withdrawNativeTokenCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, constants.MaxUint256]);
    const albertBalanceBefore = await albert.getEthBalance();
    const receipt = await albert.invoke({ actions: [await bulker.ACTION_WITHDRAW_NATIVE_TOKEN()], calldata: [withdrawNativeTokenCalldata] });
    const albertBalanceAfter = await albert.getEthBalance();

    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);
    expect(albertBalanceAfter.toBigInt() - albertBalanceBefore.toBigInt()).to.be.equal(balanceBefore - gasCost(receipt));
  }
);

scenario(
  'Comet#bulker > ACTION_CLAIM_REWARD claims accrued rewards',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await isRewardsEnabled(ctx) && !matchesDeployment(ctx, [{ deployment: 'wsteth' }]),
    tokenBalances: async (ctx) => (
      {
        albert: { $base: `== ${getConfigForScenario(ctx).bulkerBase}` },
      }
    ),
  },
  async ({ comet, actors, rewards, bulker }, context, world) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const [rewardTokenAddress] = await rewards.rewardConfig(comet.address);
    const toSupplyBase = BigInt(getConfigForScenario(context).bulkerBase) * (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: baseAssetAddress, amount: toSupplyBase });
    await world.increaseTime(86400); // fast forward a day to accrue rewards

    const startingRewardBalance = await albert.getErc20Balance(rewardTokenAddress);
    const rewardOwed = ((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed).toBigInt();
    expect(rewardOwed).to.be.greaterThan(0n);

    const claimRewardCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'bool'], [comet.address, rewards.address, albert.address, true]);
    await albert.invoke({ actions: [await bulker.ACTION_CLAIM_REWARD()], calldata: [claimRewardCalldata] });

    expect(await albert.getErc20Balance(rewardTokenAddress)).to.be.equal(startingRewardBalance + rewardOwed);
  }
);

scenario(
  'Comet#bulker > invoke() executes multiple actions in order',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
    supplyCaps: async (ctx) => (
      {
        $asset0: getConfigForScenario(ctx).bulkerAsset,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).bulkerAsset },
      }
    ),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert, betty } = actors;
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const toSupply = BigInt(getConfigForScenario(context).bulkerAsset) * scaleBN.toBigInt();
    const toWithdraw = toSupply / 2n;

    await collateralAsset.approve(albert, comet.address);
    await albert.allow(bulker.address, true);

    // The withdraw only succeeds because the supply earlier in the same invoke() call ran first
    const supplyAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, collateralAssetAddress, toSupply]);
    const withdrawAssetCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, betty.address, collateralAssetAddress, toWithdraw]);

    await albert.invoke({
      actions: [await bulker.ACTION_SUPPLY_ASSET(), await bulker.ACTION_WITHDRAW_ASSET()],
      calldata: [supplyAssetCalldata, withdrawAssetCalldata]
    });

    expect(await comet.collateralBalanceOf(albert.address, collateralAssetAddress)).to.be.equal(toSupply - toWithdraw);
    expect(await collateralAsset.balanceOf(betty.address)).to.be.equal(toWithdraw);
  }
);

scenario(
  'Comet#bulker > invoke() with empty actions and data is a no-op',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ actors }) => {
    const { albert } = actors;

    const albertBalanceBefore = await albert.getEthBalance();
    const receipt = await albert.invoke({ actions: [], calldata: [] });
    const albertBalanceAfter = await albert.getEthBalance();

    expect(albertBalanceBefore.toBigInt() - albertBalanceAfter.toBigInt()).to.be.equal(gasCost(receipt));
  }
);

scenario(
  'Comet#bulker > transferAdmin() by the current admin',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ comet, actors, bulker }, _context, world) => {
    const { betty } = actors;
    const oldAdmin = await comet.governor();
    const adminSigner = await world.impersonateAddress(oldAdmin, { value: exp(1, 18) });

    const receipt = await (await bulker.connect(adminSigner).transferAdmin(betty.address)).wait();

    expect(await bulker.admin()).to.be.equal(betty.address);
    const adminTransferredEvent = receipt.events.find((e) => e.event === 'AdminTransferred');
    expect(adminTransferredEvent.args.oldAdmin).to.be.equal(oldAdmin);
    expect(adminTransferredEvent.args.newAdmin).to.be.equal(betty.address);
  }
);

scenario(
  'Comet#bulker > sweepToken() sweeps a standard ERC-20',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
    tokenBalances: async () => (
      {
        albert: { $base: '== 1' },
      }
    ),
  },
  async ({ comet, actors, bulker }, context, world) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const sweepAmount = exp(1, await baseAsset.decimals());

    // Albert "accidentally" sends the base asset directly to the Bulker
    await baseAsset.transfer(albert, sweepAmount, bulker.address);
    expect(await baseAsset.balanceOf(bulker.address)).to.be.equal(sweepAmount);

    const adminSigner = await world.impersonateAddress(await comet.governor(), { value: exp(1, 18) });
    await bulker.connect(adminSigner).sweepToken(betty.address, baseAssetAddress);

    expect(await baseAsset.balanceOf(bulker.address)).to.be.equal(0n);
    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(sweepAmount);
  }
);

scenario(
  'Comet#bulker > sweepToken() sweeps a non-standard ERC-20',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ comet, actors, bulker }, _context, world) => {
    const { albert, betty } = actors;
    const nonStandardToken = await world.deploymentManager.deploy(
      'bulkerNonStandardToken',
      'test/NonStandardFaucetToken.sol',
      [0, 'Tether', 6, 'USDT'],
      true
    ) as NonStandardFaucetToken;

    const sweepAmount = exp(10, 6);
    await nonStandardToken.allocateTo(albert.address, sweepAmount);
    await nonStandardToken.connect(albert.signer).transfer(bulker.address, sweepAmount);
    expect(await nonStandardToken.balanceOf(bulker.address)).to.be.equal(sweepAmount);

    const adminSigner = await world.impersonateAddress(await comet.governor(), { value: exp(1, 18) });
    await bulker.connect(adminSigner).sweepToken(betty.address, nonStandardToken.address);

    expect(await nonStandardToken.balanceOf(bulker.address)).to.be.equal(0n);
    expect(await nonStandardToken.balanceOf(betty.address)).to.be.equal(sweepAmount);
  }
);

scenario(
  'Comet#bulker > sweepNativeToken() sweeps the Bulker ETH balance',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ comet, actors, bulker }, _context, world) => {
    const { albert, betty } = actors;
    const provider = world.deploymentManager.hre.ethers.provider;

    const bulkerBalanceBefore = (await provider.getBalance(bulker.address)).toBigInt();
    await albert.sendEth(bulker.address, 1);
    const totalBulkerBalance = (await provider.getBalance(bulker.address)).toBigInt();
    expect(totalBulkerBalance).to.be.equal(bulkerBalanceBefore + exp(1, 18));

    const adminSigner = await world.impersonateAddress(await comet.governor(), { value: exp(1, 18) });
    const bettyBalanceBefore = (await betty.getEthBalance()).toBigInt();
    await bulker.connect(adminSigner).sweepNativeToken(betty.address);
    const bettyBalanceAfter = (await betty.getEthBalance()).toBigInt();

    expect(await provider.getBalance(bulker.address)).to.be.equal(0n);
    expect(bettyBalanceAfter - bettyBalanceBefore).to.be.equal(totalBulkerBalance);
  }
);

scenario(
  'Comet#bulker > invoke() supplies every available collateral and base asset in one call',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) &&
      (await hasNativeAsCollateral(ctx) || await hasNativeAsBase(ctx)) &&
      (await getAvailableCollateralAssetIndexes(ctx)).length > 0,
    supplyCaps: async (ctx) => {
      const caps: Record<string, number> = {};
      for (const i of await getAvailableCollateralAssetIndexes(ctx)) caps[`$asset${i}`] = 1;
      return caps;
    },
    tokenBalances: async (ctx) => {
      const balances: Record<string, number> = {};
      for (const i of await getAvailableCollateralAssetIndexes(ctx)) balances[`$asset${i}`] = 1;
      return { albert: balances };
    },
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const toSupplyNative = exp(0.01, 18);

    const actions: string[] = [];
    const calldata: string[] = [];
    const expected: { asset: string, amount: bigint }[] = [];

    // Every available collateral asset, via plain ACTION_SUPPLY_ASSET
    for (const i of await getAvailableCollateralAssetIndexes(context)) {
      const { asset, scale } = await comet.getAssetInfo(i);
      if (asset.toLowerCase() === wrappedNativeToken.toLowerCase()) continue; // covered by ACTION_SUPPLY_NATIVE_TOKEN below
      const collateralAsset = context.getAssetByAddress(asset);
      const amount = scale.toBigInt();
      await collateralAsset.approve(albert, comet.address);
      actions.push(await bulker.ACTION_SUPPLY_ASSET());
      calldata.push(utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, asset, amount]));
      expected.push({ asset, amount });
    }
    await albert.allow(bulker.address, true);

    // Plus the native/base asset, via ACTION_SUPPLY_NATIVE_TOKEN
    actions.push(await bulker.ACTION_SUPPLY_NATIVE_TOKEN());
    calldata.push(utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, toSupplyNative]));

    await albert.invoke({ actions, calldata }, { value: toSupplyNative });

    for (const { asset, amount } of expected) {
      expect(await comet.collateralBalanceOf(albert.address, asset)).to.be.equal(amount);
    }
    if (await hasNativeAsBase(context)) {
      expectBase((await comet.balanceOf(albert.address)).toBigInt(), toSupplyNative);
    } else {
      expect(await comet.collateralBalanceOf(albert.address, wrappedNativeToken)).to.be.equal(toSupplyNative);
    }
  }
);

scenario(
  'Comet#bulker > invoke() withdraws every available collateral asset in one call',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && (await getAvailableCollateralAssetIndexes(ctx)).length > 0,
    supplyCaps: async (ctx) => {
      const caps: Record<string, number> = {};
      for (const i of await getAvailableCollateralAssetIndexes(ctx)) caps[`$asset${i}`] = 1;
      return caps;
    },
    tokenBalances: async (ctx) => {
      const balances: Record<string, number> = {};
      for (const i of await getAvailableCollateralAssetIndexes(ctx)) balances[`$asset${i}`] = 1;
      return { albert: balances };
    },
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert, betty } = actors;

    const actions: string[] = [];
    const calldata: string[] = [];
    const expected: { asset: string, amount: bigint }[] = [];

    // Every available collateral asset (including the native token, if it happens to be one of them) gets
    // a plain ERC-20 withdraw here: ACTION_WITHDRAW_ASSET never wraps/unwraps, so no special-casing is needed.
    for (const i of await getAvailableCollateralAssetIndexes(context)) {
      const { asset, scale } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const amount = scale.toBigInt();
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset, amount });
      actions.push(await bulker.ACTION_WITHDRAW_ASSET());
      calldata.push(utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, betty.address, asset, amount]));
      expected.push({ asset, amount });
    }
    await albert.allow(bulker.address, true);

    await albert.invoke({ actions, calldata });

    for (const { asset, amount } of expected) {
      expect(await comet.collateralBalanceOf(albert.address, asset)).to.be.equal(0n);
      expect(await context.getAssetByAddress(asset).balanceOf(betty.address)).to.be.equal(amount);
    }
  }
);

scenario(
  'Comet#bulker > invoke() borrows base after supplying every available collateral asset',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && (await getAvailableCollateralAssetIndexes(ctx)).length > 0,
    supplyCaps: async (ctx) => {
      const caps: Record<string, number> = {};
      for (const i of await getAvailableCollateralAssetIndexes(ctx)) caps[`$asset${i}`] = 1;
      return caps;
    },
    tokenBalances: async (ctx) => {
      const balances: Record<string, number> = { $base: 0 };
      for (const i of await getAvailableCollateralAssetIndexes(ctx)) balances[`$asset${i}`] = 1;
      return { albert: balances };
    },
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    // Borrow just above the protocol's own minimum, so it stays safely within the borrowing power
    // unlocked by one unit of any combination of available collateral assets.
    const toBorrowBase = (await comet.baseBorrowMin()).toBigInt() * 2n;

    const actions: string[] = [];
    const calldata: string[] = [];
    const expected: { asset: string, amount: bigint }[] = [];

    // Every available collateral asset (including the native token, if it happens to be one of them) gets
    // a plain ERC-20 supply here: ACTION_SUPPLY_ASSET never wraps/unwraps, so no special-casing is needed.
    for (const i of await getAvailableCollateralAssetIndexes(context)) {
      const { asset, scale } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const amount = scale.toBigInt();
      await collateralAsset.approve(albert, comet.address);
      actions.push(await bulker.ACTION_SUPPLY_ASSET());
      calldata.push(utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, albert.address, asset, amount]));
      expected.push({ asset, amount });
    }
    await albert.allow(bulker.address, true);

    actions.push(await bulker.ACTION_WITHDRAW_ASSET());
    calldata.push(utils.defaultAbiCoder.encode(['address', 'address', 'address', 'uint'], [comet.address, betty.address, baseAssetAddress, toBorrowBase]));

    await albert.invoke({ actions, calldata });

    for (const { asset, amount } of expected) {
      expect(await comet.collateralBalanceOf(albert.address, asset)).to.be.equal(amount);
    }
    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(toBorrowBase);
  }
);

// ─── Unhappy Path ───────────────────────────────────────────────────────────

scenario(
  'Comet#bulker > invoke() with mismatched array lengths reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ actors, bulker }) => {
    const { albert } = actors;
    await expect(
      albert.invoke({ actions: [await bulker.ACTION_SUPPLY_ASSET()], calldata: [] })
    ).to.be.revertedWith("custom error 'InvalidArgument()'");
  }
);

scenario(
  'Comet#bulker > invoke() with an action unknown to BaseBulker reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && !matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, actors }) => {
    const { betty } = actors;
    const unknownAction = utils.formatBytes32String('ACTION_SUPPLY_GALACTIC_CREDITS');
    const unknownCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, betty.address, exp(1, 18)]);
    await expect(
      betty.invoke({ actions: [unknownAction], calldata: [unknownCalldata] })
    ).to.be.revertedWith("custom error 'UnhandledAction()'");
  }
);

scenario(
  'Comet#bulker > ACTION_SUPPLY_ASSET without Comet permission reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ comet, actors, bulker }) => {
    const { albert, betty } = actors;
    const { asset: assetAddress } = await comet.getAssetInfo(0);
    const supplyCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'address', 'uint'],
      [comet.address, betty.address, assetAddress, exp(1, 8)]
    );
    await expect(
      albert.invoke({ actions: [await bulker.ACTION_SUPPLY_ASSET()], calldata: [supplyCalldata] })
    ).to.be.revertedWith("custom error 'Unauthorized()'");
  }
);

scenario(
  'Comet#bulker > ACTION_TRANSFER_ASSET without Comet permission reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ comet, actors, bulker }) => {
    const { albert, betty } = actors;
    const { asset: assetAddress } = await comet.getAssetInfo(0);
    const transferCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'address', 'uint'],
      [comet.address, betty.address, assetAddress, exp(1, 8)]
    );
    await expect(
      albert.invoke({ actions: [await bulker.ACTION_TRANSFER_ASSET()], calldata: [transferCalldata] })
    ).to.be.revertedWith("custom error 'Unauthorized()'");
  }
);

scenario(
  'Comet#bulker > ACTION_WITHDRAW_ASSET without Comet permission reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ comet, actors, bulker }) => {
    const { albert, betty } = actors;
    const { asset: assetAddress } = await comet.getAssetInfo(0);
    const withdrawCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'address', 'uint'],
      [comet.address, betty.address, assetAddress, exp(1, 8)]
    );
    await expect(
      albert.invoke({ actions: [await bulker.ACTION_WITHDRAW_ASSET()], calldata: [withdrawCalldata] })
    ).to.be.revertedWith("custom error 'Unauthorized()'");
  }
);

scenario(
  'Comet#bulker > ACTION_WITHDRAW_NATIVE_TOKEN without Comet permission reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && (await hasNativeAsCollateral(ctx) || await hasNativeAsBase(ctx)),
  },
  async ({ comet, actors, bulker }) => {
    const { albert, betty } = actors;
    const withdrawCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, betty.address, exp(0.01, 18)]
    );
    await expect(
      albert.invoke({ actions: [await bulker.ACTION_WITHDRAW_NATIVE_TOKEN()], calldata: [withdrawCalldata] })
    ).to.be.revertedWith("custom error 'Unauthorized()'");
  }
);

scenario(
  'Comet#bulker > ACTION_SUPPLY_NATIVE_TOKEN with msg.value less than amount reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && (await hasNativeAsCollateral(ctx) || await hasNativeAsBase(ctx)),
  },
  async ({ comet, actors, bulker }) => {
    const { albert } = actors;
    const requestedAmount = exp(10, 18);
    const sentAmount = exp(1, 18);
    const supplyCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, requestedAmount]
    );
    await expect(
      albert.invoke(
        { actions: [await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], calldata: [supplyCalldata] },
        { value: sentAmount }
      )
    ).to.be.reverted;
  }
);

scenario(
  'Comet#bulker > ACTION_SUPPLY_NATIVE_TOKEN with amount=max when native is collateral reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await hasNativeAsCollateral(ctx),
  },
  async ({ comet, actors, bulker }) => {
    const { albert } = actors;
    const supplyCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, constants.MaxUint256]
    );
    await expect(
      albert.invoke(
        { actions: [await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], calldata: [supplyCalldata] },
        { value: exp(0.01, 18) }
      )
    ).to.be.reverted;
  }
);

scenario(
  'Comet#bulker > ACTION_WITHDRAW_NATIVE_TOKEN with amount=max when native is collateral reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await hasNativeAsCollateral(ctx),
  },
  async ({ comet, actors, bulker }) => {
    const { albert } = actors;
    const toSupply = exp(0.01, 18);

    await albert.allow(bulker.address, true);
    const supplyCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, toSupply]
    );
    await albert.invoke(
      { actions: [await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], calldata: [supplyCalldata] },
      { value: toSupply }
    );

    const withdrawCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, constants.MaxUint256]
    );
    await expect(
      albert.invoke({ actions: [await bulker.ACTION_WITHDRAW_NATIVE_TOKEN()], calldata: [withdrawCalldata] })
    ).to.be.reverted;
  }
);

scenario(
  'Comet#bulker > ACTION_WITHDRAW_NATIVE_TOKEN to a non-payable recipient reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await hasNativeAsCollateral(ctx),
  },
  async ({ comet, actors, bulker }, _context, world) => {
    const { albert } = actors;
    const toSupply = exp(0.01, 18);

    await albert.allow(bulker.address, true);
    const supplyCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, toSupply]
    );
    await albert.invoke(
      { actions: [await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], calldata: [supplyCalldata] },
      { value: toSupply }
    );

    const nonPayableReceiver = await world.deploymentManager.deploy(
      'bulkerNonPayableReceiver',
      'test/NonPayableReceiver.sol',
      [],
      true
    );
    const withdrawCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, nonPayableReceiver.address, toSupply]
    );
    await expect(
      albert.invoke({ actions: [await bulker.ACTION_WITHDRAW_NATIVE_TOKEN()], calldata: [withdrawCalldata] })
    ).to.be.revertedWith("custom error 'FailedToSendNativeToken()'");
  }
);

scenario(
  'Comet#bulker > sweepToken() with a false-returning token reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ actors, bulker }, _context, world) => {
    const { betty } = actors;
    const falseToken = await world.deploymentManager.deploy(
      'bulkerFalseReturnToken',
      'test/FalseReturnToken.sol',
      [],
      true
    );
    const adminSigner = await world.impersonateAddress(await bulker.admin(), { value: exp(1, 18) });
    await expect(
      bulker.connect(adminSigner).sweepToken(betty.address, falseToken.address)
    ).to.be.revertedWith("custom error 'TransferOutFailed()'");
  }
);

scenario(
  'Comet#bulker > sweepToken() with a wrong-length-returning token reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ actors, bulker }, _context, world) => {
    const { betty } = actors;
    const wrongLengthToken = await world.deploymentManager.deploy(
      'bulkerWrongLengthToken',
      'test/WrongLengthReturnToken.sol',
      [],
      true
    );
    const adminSigner = await world.impersonateAddress(await bulker.admin(), { value: exp(1, 18) });
    await expect(
      bulker.connect(adminSigner).sweepToken(betty.address, wrongLengthToken.address)
    ).to.be.reverted;
  }
);

scenario(
  'Comet#bulker > transferAdmin() called by non-admin reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ actors, bulker }) => {
    const { albert, betty } = actors;
    await expect(
      bulker.connect(albert.signer).transferAdmin(betty.address)
    ).to.be.revertedWith("custom error 'Unauthorized()'");
  }
);

scenario(
  'Comet#bulker > transferAdmin(address(0)) reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ bulker }, _context, world) => {
    const adminSigner = await world.impersonateAddress(await bulker.admin(), { value: exp(1, 18) });
    await expect(
      bulker.connect(adminSigner).transferAdmin(constants.AddressZero)
    ).to.be.revertedWith("custom error 'InvalidAddress()'");
  }
);

scenario(
  'Comet#bulker > sweepToken() called by non-admin reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ comet, actors, bulker }) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    await expect(
      bulker.connect(albert.signer).sweepToken(betty.address, baseAssetAddress)
    ).to.be.revertedWith("custom error 'Unauthorized()'");
  }
);

scenario(
  'Comet#bulker > sweepNativeToken() called by non-admin reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ actors, bulker }) => {
    const { albert, betty } = actors;
    await expect(
      bulker.connect(albert.signer).sweepNativeToken(betty.address)
    ).to.be.revertedWith("custom error 'Unauthorized()'");
  }
);

// ─── Edge Cases ──────────────────────────────────────────────────────────────

scenario(
  'Comet#bulker > invoke() with empty arrays and msg.value > 0 refunds the full ETH',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ actors, bulker }, _context, world) => {
    const { albert } = actors;
    const sendAmount = exp(0.01, 18);

    const bulkerBalanceBefore = (await world.deploymentManager.hre.ethers.provider.getBalance(bulker.address)).toBigInt();
    const albertBalanceBefore = await albert.getEthBalance();
    const receipt = await albert.invoke({ actions: [], calldata: [] }, { value: sendAmount });
    const albertBalanceAfter = await albert.getEthBalance();

    expect(albertBalanceBefore.toBigInt() - albertBalanceAfter.toBigInt()).to.be.equal(gasCost(receipt));
    expect((await world.deploymentManager.hre.ethers.provider.getBalance(bulker.address)).toBigInt()).to.be.equal(bulkerBalanceBefore);
  }
);

scenario(
  'Comet#bulker > ACTION_SUPPLY_NATIVE_TOKEN with amount=0 is a no-op and refunds ETH',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && (await hasNativeAsCollateral(ctx) || await hasNativeAsBase(ctx)),
  },
  async ({ comet, actors, bulker }, _context, world) => {
    const { albert } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const sendAmount = exp(0.01, 18);

    const bulkerBalanceBefore = (await world.deploymentManager.hre.ethers.provider.getBalance(bulker.address)).toBigInt();
    const albertBalanceBefore = await albert.getEthBalance();

    const supplyCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, 0]);
    const receipt = await albert.invoke(
      { actions: [await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], calldata: [supplyCalldata] },
      { value: sendAmount }
    );

    const albertBalanceAfter = await albert.getEthBalance();
    expect(albertBalanceBefore.toBigInt() - albertBalanceAfter.toBigInt()).to.be.equal(gasCost(receipt));
    expect(await comet.collateralBalanceOf(albert.address, wrappedNativeToken)).to.be.equal(0n);
    expect((await world.deploymentManager.hre.ethers.provider.getBalance(bulker.address)).toBigInt()).to.be.equal(bulkerBalanceBefore);
  }
);

scenario(
  'Comet#bulker > ACTION_SUPPLY_NATIVE_TOKEN drawing on residual Bulker ETH triggers underflow revert',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && (await hasNativeAsCollateral(ctx) || await hasNativeAsBase(ctx)),
  },
  async ({ comet, actors, bulker }) => {
    const { albert } = actors;
    // Seed the bulker with 0.01 ETH so its total balance > msg.value below
    await albert.sendEth(bulker.address, 0.01);

    // Request 0.02 ETH but only send 0.01; deposit() succeeds (bulker total = 0.02) but
    // unusedNativeToken (= msg.value = 0.01) -= 0.02 underflows → Panic(0x11)
    const supplyCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, exp(0.02, 18)]
    );
    await expect(
      albert.invoke(
        { actions: [await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], calldata: [supplyCalldata] },
        { value: exp(0.01, 18) }
      )
    ).to.be.reverted;
  }
);

scenario(
  'Comet#bulker > ACTION_WITHDRAW_NATIVE_TOKEN amount=max when balance=0 withdraws nothing',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await hasNativeAsBase(ctx),
  },
  async ({ comet, actors, bulker }) => {
    const { albert } = actors;
    await albert.allow(bulker.address, true);

    expect((await comet.callStatic.balanceOf(albert.address)).toBigInt()).to.be.equal(0n);

    const withdrawCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, constants.MaxUint256]);
    await albert.invoke({ actions: [await bulker.ACTION_WITHDRAW_NATIVE_TOKEN()], calldata: [withdrawCalldata] });

    expect((await comet.callStatic.balanceOf(albert.address)).toBigInt()).to.be.equal(0n);
  }
);

scenario(
  'Comet#bulker > sweepToken() with a zero balance is a no-op',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ actors, bulker }, _context, world) => {
    const { betty } = actors;
    const adminSigner = await world.impersonateAddress(await bulker.admin(), { value: exp(1, 18) });

    const zeroToken = await world.deploymentManager.deploy(
      'bulkerEC04ZeroToken',
      'test/NonStandardFaucetToken.sol',
      [0, 'ZeroToken', 18, 'ZERO'],
      true
    ) as NonStandardFaucetToken;

    await bulker.connect(adminSigner).sweepToken(betty.address, zeroToken.address);
    expect(await zeroToken.balanceOf(betty.address)).to.be.equal(0n);
    expect(await zeroToken.balanceOf(bulker.address)).to.be.equal(0n);
  }
);

scenario(
  'Comet#bulker > transferAdmin(currentAdmin) emits AdminTransferred and leaves admin unchanged',
  {
    filter: async (ctx) => await isBulkerSupported(ctx),
  },
  async ({ bulker }, _context, world) => {
    const adminAddress = await bulker.admin();
    const adminSigner = await world.impersonateAddress(adminAddress, { value: exp(1, 18) });

    await expect(bulker.connect(adminSigner).transferAdmin(adminAddress))
      .to.emit(bulker, 'AdminTransferred')
      .withArgs(adminAddress, adminAddress);

    expect(await bulker.admin()).to.be.equal(adminAddress);
  }
);

scenario(
  'Comet#bulker > ACTION_WITHDRAW_NATIVE_TOKEN to the Bulker itself lands on receive()',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await hasNativeAsCollateral(ctx),
  },
  async ({ comet, actors, bulker }, _context, world) => {
    const { albert } = actors;
    const withdrawAmount = exp(0.01, 18);

    // Supply native token as collateral first
    const supplyCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, albert.address, withdrawAmount]);
    await albert.invoke(
      { actions: [await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], calldata: [supplyCalldata] },
      { value: withdrawAmount }
    );
    await albert.allow(bulker.address, true);

    const bulkerBalanceBefore = (await world.deploymentManager.hre.ethers.provider.getBalance(bulker.address)).toBigInt();
    const withdrawCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'uint'], [comet.address, bulker.address, withdrawAmount]);
    await albert.invoke({ actions: [await bulker.ACTION_WITHDRAW_NATIVE_TOKEN()], calldata: [withdrawCalldata] });

    expect((await world.deploymentManager.hre.ethers.provider.getBalance(bulker.address)).toBigInt()).to.be.equal(bulkerBalanceBefore + withdrawAmount);
    expect(await comet.collateralBalanceOf(albert.address, await bulker.wrappedNativeToken())).to.be.equal(0n);
  }
);

scenario(
  'Comet#bulker > ACTION_CLAIM_REWARD with shouldAccrue=false passes false through',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await isRewardsEnabled(ctx) && !matchesDeployment(ctx, [{ deployment: 'wsteth' }]),
    tokenBalances: async (ctx: CometContext) => (
      {
        albert: { $base: `== ${getConfigForScenario(ctx).bulkerBase}` },
      }
    ),
  },
  async ({ comet, actors, rewards, bulker }, context, world) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const [rewardTokenAddress] = await rewards.rewardConfig(comet.address);
    const toSupplyBase = BigInt(getConfigForScenario(context).bulkerBase) * (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: baseAssetAddress, amount: toSupplyBase });
    await world.increaseTime(86400);

    const rewardsBefore = await albert.getErc20Balance(rewardTokenAddress);

    // shouldAccrue=false: the bulker passes false through to IClaimable.claim() without forcing accrual
    const claimCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'address', 'bool'],
      [comet.address, rewards.address, albert.address, false]
    );
    await albert.invoke({ actions: [await bulker.ACTION_CLAIM_REWARD()], calldata: [claimCalldata] });

    expect(await albert.getErc20Balance(rewardTokenAddress)).to.be.greaterThanOrEqual(rewardsBefore);
  }
);