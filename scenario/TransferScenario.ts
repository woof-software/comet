import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { expectApproximately, expectBase, expectRevertCustom, getInterest, hasMinBorrowGreaterThanOne, isTriviallySourceable, isValidAssetIndex, MAX_ASSETS } from './utils';
import { ContractReceipt } from 'ethers';
import { getConfigForScenario } from './utils/scenarioHelper';

// Constants
const TRANSFER_DIVISOR = 2n;
const COLLATERAL_TRANSFER_AMOUNT = 50n;
const TRANSFER_MULTIPLIER_NUM = 25n;
const TRANSFER_MULTIPLIER_DENOM = 10n;
const TRANSFER_RESULT_NUM = 15n;
const TRANSFER_RESULT_DENOM = 10n;
const INTEREST_TIME_SECONDS = 100n;
const TRANSFER_AMOUNT_NEAR_MAX = 999n;
const REMAINING_BALANCE = 1n;
const TRANSFER_OVER_LIMIT = 2001n;
const INTEREST_TOLERANCE = 2n;
const INTEREST_TOLERANCE_LARGE = 4n;
const PRINCIPAL_TOLERANCE_VALUES = [0n, -1n, -2n];
const BASE_PERCENT_DIVISOR = 100n;
const AUTHORIZATION_ENABLED = true;
const TRANSFER_AMOUNT_SMALL = 100n;
const TRANSFER_AMOUNT_TINY = 1n;
const COLLATERAL_BALANCE_TEST = 100n;

async function testTransferCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const comet = await context.getComet();
  const { albert, betty } = context.actors;
  const { asset: assetAddress, scale } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);

  // Albert transfers 50 units of collateral to Betty
  const toTransfer = scale.toBigInt() * BigInt(getConfigForScenario(context).supply.collateralAmount) / TRANSFER_DIVISOR;
  const txn = await albert.transferAsset({ dst: betty.address, asset: collateralAsset.address, amount: toTransfer });

  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(scale.mul(BigInt(getConfigForScenario(context).supply.collateralAmount) / TRANSFER_DIVISOR));
  expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(scale.mul(BigInt(getConfigForScenario(context).supply.collateralAmount) / TRANSFER_DIVISOR));

  return txn;
}

async function testTransferFromCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const comet = await context.getComet();
  const { albert, betty, charles } = context.actors;
  const { asset: assetAddress, scale } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);

  await albert.allow(charles, AUTHORIZATION_ENABLED);

  // Charles transfers 50 units of collateral from Albert to Betty
  const toTransfer = scale.toBigInt() * BigInt(getConfigForScenario(context).supply.collateralAmount) / TRANSFER_DIVISOR;
  const txn = await charles.transferAssetFrom({ src: albert.address, dst: betty.address, asset: collateralAsset.address, amount: toTransfer });

  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(scale.mul(BigInt(getConfigForScenario(context).supply.collateralAmount) / TRANSFER_DIVISOR));
  expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(scale.mul(BigInt(getConfigForScenario(context).supply.collateralAmount) / TRANSFER_DIVISOR));

  return txn;
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#transfer > collateral asset ${i}, enough balance`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx).transfer.collateralAmount),
      cometBalances: async (ctx) =>  (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).transfer.collateralAmount }
        }
      ),
    },
    async (_properties, context) => {
      return await testTransferCollateral(context, i);
    }
  );
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#transferFrom > collateral asset ${i}, enough balance`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx).transfer.collateralAmount),
      cometBalances: async (ctx) =>  (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).transfer.collateralAmount }
        }
      ),
    },
    async (_properties, context) => {
      return await testTransferFromCollateral(context, i);
    }
  );
}

scenario(
  'Comet#transfer > base asset, enough balance',
  {
    cometBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).transfer.baseBalanceTransfer },
    }),
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    // Albert transfers half supplied base to Betty
    const toTransfer = baseSupplied / TRANSFER_DIVISOR;
    const txn = await albert.transferAsset({ dst: betty.address, asset: baseAsset.address, amount: toTransfer });

    expectBase(await albert.getCometBaseBalance(), baseSupplied - toTransfer, baseSupplied / BASE_PERCENT_DIVISOR);
    expectBase(await betty.getCometBaseBalance(), toTransfer, baseSupplied / BASE_PERCENT_DIVISOR);

    return txn;
  }
);

scenario(
  'Comet#transfer > base asset, total and user balances are summed up properly',
  {
    cometBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).transfer.baseBalanceTransfer },
    }),
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    // Cache pre-transfer balances
    const { totalSupplyBase: oldTotalSupply, totalBorrowBase: oldTotalBorrow } = await comet.totalsBasic();
    const oldAlbertPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
    const oldBettyPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();

    // Albert transfers 50 units of collateral to Betty
    const toTransfer = COLLATERAL_TRANSFER_AMOUNT * scale;
    const txn = await albert.transferAsset({ dst: betty.address, asset: baseAsset.address, amount: toTransfer });

    // Cache post-transfer balances
    const { totalSupplyBase: newTotalSupply, totalBorrowBase: newTotalBorrow } = await comet.totalsBasic();
    const newAlbertPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
    const newBettyPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();

    // Check that global and user principals are updated by the same amount
    const changeInTotalPrincipal = newTotalSupply.toBigInt() - oldTotalSupply.toBigInt() - (newTotalBorrow.toBigInt() - oldTotalBorrow.toBigInt());
    const changeInUserPrincipal = newAlbertPrincipal - oldAlbertPrincipal + newBettyPrincipal - oldBettyPrincipal;
    expect(changeInTotalPrincipal).to.be.equal(changeInUserPrincipal).to;
    expect(PRINCIPAL_TOLERANCE_VALUES).to.include(changeInTotalPrincipal);

    return txn;
  }
);

scenario(
  'Comet#transfer > partial withdraw / borrow base to partial repay / supply',
  {
    cometBalances: async (ctx) =>  (
      {
        albert: { $base: getConfigForScenario(ctx).transfer.baseAmount, $asset0: getConfigForScenario(ctx).transfer.alternateAsset },
        betty: { $base: -getConfigForScenario(ctx).transfer.baseAmount },
        charles: { $base: getConfigForScenario(ctx).transfer.baseAmount },
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(
      await albert.getCometBaseBalance(),
      BigInt(getConfigForScenario(context).transfer.baseAmount) * scale,
      getInterest(BigInt(getConfigForScenario(context).transfer.baseAmount) * scale, borrowRate, INTEREST_TIME_SECONDS) + INTEREST_TOLERANCE
    );

    expectApproximately(
      await betty.getCometBaseBalance(),
      -BigInt(getConfigForScenario(context).transfer.baseAmount) * scale,
      getInterest(BigInt(getConfigForScenario(context).transfer.baseAmount) * scale, borrowRate, INTEREST_TIME_SECONDS) + INTEREST_TOLERANCE
    );

    // Albert with positive balance transfers to Betty with negative balance
    const toTransfer = BigInt(getConfigForScenario(context).transfer.baseAmount) * TRANSFER_MULTIPLIER_NUM / TRANSFER_MULTIPLIER_DENOM * scale;
    const txn = await albert.transferAsset({ dst: betty.address, asset: baseAsset.address, amount: toTransfer });

    // Albert ends with negative balance and Betty with positive balance
    expectApproximately(await albert.getCometBaseBalance(), -BigInt(getConfigForScenario(context).transfer.baseAmount) * TRANSFER_RESULT_NUM / TRANSFER_RESULT_DENOM * scale, getInterest(BigInt(getConfigForScenario(context).transfer.baseAmount) * TRANSFER_RESULT_NUM / TRANSFER_RESULT_DENOM * scale, borrowRate, INTEREST_TIME_SECONDS) + INTEREST_TOLERANCE_LARGE);
    expectApproximately(await betty.getCometBaseBalance(), BigInt(getConfigForScenario(context).transfer.baseAmount) * TRANSFER_RESULT_NUM / TRANSFER_RESULT_DENOM * scale, getInterest(BigInt(getConfigForScenario(context).transfer.baseAmount) * TRANSFER_RESULT_NUM / TRANSFER_RESULT_DENOM * scale, borrowRate, INTEREST_TIME_SECONDS) + INTEREST_TOLERANCE_LARGE);

    return txn;
  }
);

scenario(
  'Comet#transferFrom > withdraw to repay',
  {
    cometBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).transfer.baseBalanceLarge, $asset0: getConfigForScenario(ctx).transfer.collateralBalanceSmall },
      betty: { $base: getConfigForScenario(ctx).transfer.borrowAmountLarge },
      charles: { $base: getConfigForScenario(ctx).transfer.baseBalanceLarge },
    }),
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();
    const config = getConfigForScenario(context);

    expectApproximately(await albert.getCometBaseBalance(), BigInt(config.transfer.baseBalanceLarge) * scale, getInterest(BigInt(config.transfer.baseBalanceLarge) * scale, borrowRate, BigInt(config.timing.interestSeconds)) + INTEREST_TOLERANCE);
    expectApproximately(await betty.getCometBaseBalance(), BigInt(config.transfer.borrowAmountLarge) * scale, getInterest(BigInt(config.transfer.baseBalanceLarge) * scale, borrowRate, BigInt(config.timing.interestSeconds)) + INTEREST_TOLERANCE);

    await albert.allow(betty, AUTHORIZATION_ENABLED);

    // Betty withdraws from Albert to repay her own borrows
    const toTransfer = TRANSFER_AMOUNT_NEAR_MAX * scale;
    const txn = await betty.transferAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: toTransfer });

    expectApproximately(await albert.getCometBaseBalance(), REMAINING_BALANCE * scale, getInterest(BigInt(config.transfer.baseBalanceLarge) * scale, borrowRate, BigInt(config.timing.interestSeconds)) + INTEREST_TOLERANCE);
    expectApproximately(await betty.getCometBaseBalance(), -REMAINING_BALANCE * scale, getInterest(BigInt(config.transfer.baseBalanceLarge) * scale, borrowRate, BigInt(config.timing.interestSeconds)) + INTEREST_TOLERANCE);

    return txn;
  }
);

scenario(
  'Comet#transfer base reverts if undercollateralized',
  {
    cometBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).transfer.baseBalanceLarge, $asset0: getConfigForScenario(ctx).transfer.collateralBalanceTiny },
      betty: { $base: getConfigForScenario(ctx).transfer.borrowAmountLarge },
      charles: { $base: getConfigForScenario(ctx).transfer.baseBalanceLarge },
    }),
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();
    const config = getConfigForScenario(context);

    expectApproximately(await albert.getCometBaseBalance(), BigInt(config.transfer.baseBalanceLarge) * scale, getInterest(BigInt(config.transfer.baseBalanceLarge) * scale, borrowRate, INTEREST_TIME_SECONDS) + INTEREST_TOLERANCE);
    expectApproximately(await betty.getCometBaseBalance(), BigInt(config.transfer.borrowAmountLarge) * scale, getInterest(BigInt(config.transfer.baseBalanceLarge) * scale, borrowRate, INTEREST_TIME_SECONDS) + INTEREST_TOLERANCE);

    // Albert with positive balance transfers to Betty with negative balance
    const toTransfer = TRANSFER_OVER_LIMIT * scale;
    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: baseAsset.address,
        amount: toTransfer,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transferFrom base reverts if undercollateralized',
  {
    cometBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).transfer.baseBalanceLarge, $asset0: getConfigForScenario(ctx).transfer.collateralBalanceTiny },
      betty: { $base: getConfigForScenario(ctx).transfer.borrowAmountLarge },
      charles: { $base: getConfigForScenario(ctx).transfer.baseBalanceLarge },
    }),
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();
    const config = getConfigForScenario(context);

    expectApproximately(await albert.getCometBaseBalance(), BigInt(config.transfer.baseBalanceLarge) * scale, getInterest(BigInt(config.transfer.baseBalanceLarge) * scale, borrowRate, BigInt(config.timing.interestSeconds)) + INTEREST_TOLERANCE);
    expectApproximately(await betty.getCometBaseBalance(), BigInt(config.transfer.borrowAmountLarge) * scale, getInterest(BigInt(config.transfer.baseBalanceLarge) * scale, borrowRate, BigInt(config.timing.interestSeconds)) + INTEREST_TOLERANCE);

    await albert.allow(betty, AUTHORIZATION_ENABLED);

    // Albert with positive balance transfers to Betty with negative balance
    const toTransfer = TRANSFER_OVER_LIMIT * scale;
    await expectRevertCustom(
      betty.transferAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: toTransfer,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transfer collateral reverts if undercollateralized',
  {
    cometBalances: async (ctx) =>  (
      {
        albert: {
          $base: -getConfigForScenario(ctx).transfer.baseAmount,
          $asset0: `== ${getConfigForScenario(ctx).transfer.assetAmount}`
        },
        betty: { $asset0: 0 },
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const scale = scaleBN.toBigInt();

    // Albert transfers all his collateral to Betty
    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: collateralAsset.address,
        amount: BigInt(getConfigForScenario(context).transfer.assetAmount) * scale,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transferFrom collateral reverts if undercollateralized',
  {
    cometBalances: async (ctx) =>  (
      {
        albert: {
          $base: -getConfigForScenario(ctx).transfer.baseAmount,
          $asset0: `== ${getConfigForScenario(ctx).transfer.assetAmount}`
        },
        betty: { $asset0: 0 },
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const scale = scaleBN.toBigInt();

    await albert.allow(betty, AUTHORIZATION_ENABLED);

    // Betty transfers all of Albert's collateral to herself
    await expectRevertCustom(
      betty.transferAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: BigInt(getConfigForScenario(context).transfer.assetAmount) * scale,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transfer disallows self-transfer of base',
  {},
  async ({ comet, actors }) => {
    const { albert } = actors;

    const baseToken = await comet.baseToken();

    await expectRevertCustom(
      albert.transferAsset({
        dst: albert.address,
        asset: baseToken,
        amount: TRANSFER_AMOUNT_SMALL,
      }),
      'NoSelfTransfer()'
    );
  }
);

scenario(
  'Comet#transfer disallows self-transfer of collateral',
  {},
  async ({ comet, actors }) => {
    const { albert } = actors;

    const collateralAsset = await comet.getAssetInfo(0);

    await expectRevertCustom(
      albert.transferAsset({
        dst: albert.address,
        asset: collateralAsset.asset,
        amount: TRANSFER_AMOUNT_SMALL,
      }),
      'NoSelfTransfer()'
    );
  }
);

scenario(
  'Comet#transferFrom disallows self-transfer of base',
  {},
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, AUTHORIZATION_ENABLED);

    await expectRevertCustom(
      albert.transferAssetFrom({
        src: betty.address,
        dst: betty.address,
        asset: baseToken,
        amount: TRANSFER_AMOUNT_SMALL,
      }),
      'NoSelfTransfer()'
    );
  }
);

scenario(
  'Comet#transferFrom disallows self-transfer of collateral',
  {},
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    const collateralAsset = await comet.getAssetInfo(0);

    await betty.allow(albert, AUTHORIZATION_ENABLED);

    await expectRevertCustom(
      albert.transferAssetFrom({
        src: betty.address,
        dst: betty.address,
        asset: collateralAsset.asset,
        amount: TRANSFER_AMOUNT_SMALL,
      }),
      'NoSelfTransfer()'
    );
  }
);

scenario(
  'Comet#transferFrom reverts if operator not given permission',
  {},
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await expectRevertCustom(
      betty.transferAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: TRANSFER_AMOUNT_TINY * scale,
      }),
      'Unauthorized()'
    );
  }
);

scenario(
  'Comet#transfer reverts when transfer is paused',
  {
    pause: {
      transferPaused: true,
    },
  },
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, AUTHORIZATION_ENABLED);

    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: baseToken,
        amount: TRANSFER_AMOUNT_SMALL,
      }),
      'Paused()'
    );
  }
);


scenario(
  'Comet#transferFrom reverts when transfer is paused',
  {
    pause: {
      transferPaused: true,
    },
  },
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, AUTHORIZATION_ENABLED);

    await expectRevertCustom(
      albert.transferAssetFrom({
        src: betty.address,
        dst: albert.address,
        asset: baseToken,
        amount: TRANSFER_AMOUNT_SMALL,
      }),
      'Paused()'
    );
  }
);

scenario(
  'Comet#transfer reverts if borrow is less than minimum borrow',
  {
    filter: async (ctx) => await hasMinBorrowGreaterThanOne(ctx),
    cometBalances: {
      albert: { $base: 0, $asset0: COLLATERAL_BALANCE_TEST }
    }
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const minBorrow = (await comet.baseBorrowMin()).toBigInt();

    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: baseAsset.address,
        amount: minBorrow / TRANSFER_DIVISOR
      }),
      'BorrowTooSmall()'
    );
  }
);