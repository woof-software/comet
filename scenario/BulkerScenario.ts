import { CometContext, scenario } from './context/CometContext';
import { constants, utils } from 'ethers';
import { expect } from 'chai';
import { expectBase, isRewardSupported, isBulkerSupported, getBulkerCollateralIndex, getExpectedBaseBalance, matchesDeployment } from './utils';
import { exp } from '../test/helpers';
import { getBulkerCollateralAmount, getConfigForScenario } from './utils/scenarioHelper';

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

type CollateralAmount = (ctx: CometContext, index: number) => number;

// The WETH base market supplies a smaller amount of collateral
const getBulkerWethCollateralAmount: CollateralAmount = (ctx, index) => getConfigForScenario(ctx, index).bulkerAsset2;

// Supply cap room needed for the collateral asset the scenario supplies (see getBulkerCollateralIndex)
async function getCollateralSupplyCaps(ctx: CometContext, getAmount: CollateralAmount = getBulkerCollateralAmount) {
  const index = await getBulkerCollateralIndex(ctx);
  if (index === -1) return {};
  return { [`$asset${index}`]: getAmount(ctx, index) };
}

// Tokens Albert needs to hold, on top of `base`, to supply the collateral asset the scenario uses
async function getCollateralTokenBalances(ctx: CometContext, base: string, getAmount: CollateralAmount = getBulkerCollateralAmount) {
  const index = await getBulkerCollateralIndex(ctx);
  const comet = { $base: getConfigForScenario(ctx).bulkerComet };
  if (index === -1) return { albert: { $base: base }, $comet: comet };
  return { albert: { $base: base, [`$asset${index}`]: getAmount(ctx, index) }, $comet: comet };
}

scenario(
  'Comet#bulker > WRON base all non-reward actions in one txn for single asset',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && matchesDeployment(ctx, [{ network: 'ronin', deployment: 'wron'}]) && await getBulkerCollateralIndex(ctx) !== -1,
    supplyCaps: async (ctx) => await getCollateralSupplyCaps(ctx),
    tokenBalances: async (ctx) => await getCollateralTokenBalances(ctx, '== 0'),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert, betty } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    // the first asset that is neither the native token nor delisted
    const collateralIndex = await getBulkerCollateralIndex(context);
    const config = getConfigForScenario(context, collateralIndex);
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(collateralIndex);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const toSupplyCollateral = BigInt(getBulkerCollateralAmount(context, collateralIndex)) * collateralScale;
    const toBorrowBase = BigInt(config.bulkerBorrowBase) * baseScale;
    const toTransferBase = BigInt(config.bulkerBorrowAsset) * baseScale;
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
    filter: async (ctx) => await isBulkerSupported(ctx) && !matchesDeployment(ctx, [{ deployment: 'weth' }, { deployment: 'wsteth' }, { network: 'ronin', deployment: 'wron'}]) && await getBulkerCollateralIndex(ctx) !== -1,
    supplyCaps: async (ctx) => await getCollateralSupplyCaps(ctx),
    tokenBalances: async (ctx) => await getCollateralTokenBalances(ctx, '== 0'),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert, betty } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    // the first asset that is neither the native token nor delisted
    const collateralIndex = await getBulkerCollateralIndex(context);
    const config = getConfigForScenario(context, collateralIndex);
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(collateralIndex);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const toSupplyCollateral = BigInt(getBulkerCollateralAmount(context, collateralIndex)) * collateralScale;
    const toBorrowBase = BigInt(config.bulkerBorrowBase) * baseScale;
    const toTransferBase = BigInt(config.bulkerBorrowAsset) * baseScale;
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
      !matchesDeployment(ctx, [{ network: 'ronin', deployment: 'weth' }]) &&
      await getBulkerCollateralIndex(ctx) !== -1,
    supplyCaps: async (ctx) => await getCollateralSupplyCaps(ctx),
    tokenBalances: async (ctx) => await getCollateralTokenBalances(ctx, '== 0'),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    // the first asset that is neither the native token nor delisted
    const collateralIndex = await getBulkerCollateralIndex(context);
    const config = getConfigForScenario(context, collateralIndex);
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(collateralIndex);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const toSupplyCollateral = BigInt(getBulkerCollateralAmount(context, collateralIndex)) * collateralScale;
    const toBorrowBase = BigInt(config.bulkerBorrowBase) * baseScale;
    const toTransferBase = BigInt(config.bulkerBorrowAsset) * baseScale;
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
    filter: async (ctx) => await isBulkerSupported(ctx) && await isRewardSupported(ctx) && matchesDeployment(ctx, [{ network: 'ronin', deployment: 'wron'}]) && await getBulkerCollateralIndex(ctx) !== -1,
    supplyCaps: async (ctx) => await getCollateralSupplyCaps(ctx),
    tokenBalances: async (ctx) => await getCollateralTokenBalances(ctx, `== ${getConfigForScenario(ctx).bulkerBase}`),
  },
  async ({ comet, actors, rewards, bulker }, context, world) => {
    const { albert, betty } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    // the first asset that is neither the native token nor delisted
    const collateralIndex = await getBulkerCollateralIndex(context);
    const config = getConfigForScenario(context, collateralIndex);
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(collateralIndex);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const [rewardTokenAddress] = await rewards.rewardConfig(comet.address);
    const toSupplyBase = BigInt(config.bulkerBase) * baseScale;
    const toSupplyCollateral = BigInt(getBulkerCollateralAmount(context, collateralIndex)) * collateralScale;
    const toBorrowBase = BigInt(config.bulkerBorrowBase) * baseScale;
    const toTransferBase = BigInt(config.bulkerBorrowAsset) * baseScale;
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
    filter: async (ctx) => await isBulkerSupported(ctx) && await isRewardSupported(ctx) && !matchesDeployment(ctx, [{ deployment: 'weth' }, { deployment: 'wsteth' }, { network: 'base', deployment: 'usds' }, { deployment: 'wsteth' }, { network: 'ronin', deployment: 'wron'}]) && await getBulkerCollateralIndex(ctx) !== -1,
    supplyCaps: async (ctx) => await getCollateralSupplyCaps(ctx),
    tokenBalances: async (ctx) => await getCollateralTokenBalances(ctx, `== ${getConfigForScenario(ctx).bulkerBase}`),
  },
  async ({ comet, actors, rewards, bulker }, context, world) => {
    const { albert, betty } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    // the first asset that is neither the native token nor delisted
    const collateralIndex = await getBulkerCollateralIndex(context);
    const config = getConfigForScenario(context, collateralIndex);
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(collateralIndex);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const [rewardTokenAddress] = await rewards.rewardConfig(comet.address);
    const toSupplyBase = BigInt(config.bulkerBase) * baseScale;
    const toSupplyCollateral = BigInt(getBulkerCollateralAmount(context, collateralIndex)) * collateralScale;
    const toBorrowBase = BigInt(config.bulkerBorrowBase) * baseScale;
    const toTransferBase = BigInt(config.bulkerBorrowAsset) * baseScale;
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
    filter: async (ctx) => await isBulkerSupported(ctx) && await isRewardSupported(ctx) && matchesDeployment(ctx, [{ deployment: 'wsteth' }]) && await getBulkerCollateralIndex(ctx) !== -1,
    supplyCaps: async (ctx) => await getCollateralSupplyCaps(ctx),
    tokenBalances: async (ctx) => await getCollateralTokenBalances(ctx, `== ${getConfigForScenario(ctx).bulkerBase}`),
  },
  async ({ comet, actors, rewards, bulker }, context, world) => {
    const { albert, betty } = actors;
    const wrappedNativeToken = await bulker.wrappedNativeToken();
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    // the first asset that is neither the native token nor delisted
    const collateralIndex = await getBulkerCollateralIndex(context);
    const config = getConfigForScenario(context, collateralIndex);
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(collateralIndex);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const [rewardTokenAddress] = await rewards.rewardConfig(comet.address);
    const toSupplyBase = BigInt(config.bulkerBase) * baseScale;
    const toSupplyCollateral = BigInt(getBulkerCollateralAmount(context, collateralIndex)) * collateralScale;
    const toBorrowBase = BigInt(config.bulkerBorrowBase) * baseScale;
    const toTransferBase = BigInt(config.bulkerBorrowAsset) * baseScale;
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
      !matchesDeployment(ctx, [{ network: 'ronin', deployment: 'weth'}]) &&
      await getBulkerCollateralIndex(ctx) !== -1,
    supplyCaps: async (ctx) => await getCollateralSupplyCaps(ctx, getBulkerWethCollateralAmount),
    tokenBalances: async (ctx) => await getCollateralTokenBalances(ctx, `== ${getConfigForScenario(ctx).bulkerBase1}`, getBulkerWethCollateralAmount),
  },
  async ({ comet, actors, rewards, bulker }, context, world) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    // the first asset that is neither the native token nor delisted
    const collateralIndex = await getBulkerCollateralIndex(context);
    const { asset: collateralAssetAddress, scale: scaleBN } = await comet.getAssetInfo(collateralIndex);
    const collateralAsset = context.getAssetByAddress(collateralAssetAddress);
    const collateralScale = scaleBN.toBigInt();
    const [rewardTokenAddress] = await rewards.rewardConfig(comet.address);
    const toSupplyBase = BigInt(getConfigForScenario(context).bulkerBase1) * baseScale;
    const toSupplyCollateral = BigInt(getBulkerWethCollateralAmount(context, collateralIndex)) * collateralScale;
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