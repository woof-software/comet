import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { expectApproximately, expectRevertCustom, hasMinBorrowGreaterThanOne, isTriviallySourceable, isValidAssetIndex, MAX_ASSETS } from './utils';
import { ContractReceipt } from 'ethers';
import { getConfigForScenario } from './utils/scenarioHelper';

async function testWithdrawCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const config = getConfigForScenario(context);
  const comet = await context.getComet();
  const { albert } = context.actors;
  const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);
  const scale = scaleBN.toBigInt();

  expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(0n);
  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(BigInt(config.withdraw.collateralAmount) * scale);

  // Albert withdraws collateral from Comet
  const txn = await albert.withdrawAsset({ asset: collateralAsset.address, amount: BigInt(config.withdraw.collateralAmount) * scale });

  expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(BigInt(config.withdraw.collateralAmount) * scale);
  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(0n);

  return txn;
}

async function testWithdrawFromCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const config = getConfigForScenario(context);
  const comet = await context.getComet();
  const { albert, betty } = context.actors;
  const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);
  const scale = scaleBN.toBigInt();

  expect(await collateralAsset.balanceOf(betty.address)).to.be.equal(0n);
  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(BigInt(config.withdraw.collateralAmount) * scale);

  await albert.allow(betty, true);

  // Betty withdraws collateral from Albert
  const txn = await betty.withdrawAssetFrom({ src: albert.address, dst: betty.address, asset: collateralAsset.address, amount: BigInt(config.withdraw.collateralAmount) * scale });

  expect(await collateralAsset.balanceOf(betty.address)).to.be.equal(BigInt(config.withdraw.collateralAmount) * scale);
  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(0n);

  return txn;
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#withdraw > collateral asset ${i}`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, Number(getConfigForScenario(ctx).withdraw.collateralAmount)),
      cometBalances: async (ctx) =>  (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).withdraw.collateralAmount }
        }
      ),
    },
    async (_properties, context) => {
      return await testWithdrawCollateral(context, i);
    }
  );
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#withdrawFrom > collateral asset ${i}`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, Number(getConfigForScenario(ctx).withdraw.collateralAmount)),
      cometBalances: async (ctx) =>  (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).withdraw.collateralAmount }
        }
      ),
    },
    async (_properties, context) => {
      return await testWithdrawFromCollateral(context, i);
    }
  );
}

scenario(
  'Comet#withdraw > base asset',
  {
    tokenBalances: {
      albert: { $base: `== 0n` },
    },
    cometBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).common.amounts.base.small },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    // Albert withdraws supplied units of base from Comet
    const txn = await albert.withdrawAsset({ asset: baseAsset.address, amount: baseSupplied });

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(baseSupplied);
    expect(await comet.balanceOf(albert.address)).to.be.lessThan(baseSupplied / config.common.divisors.percent);

    return txn;
  }
);

scenario(
  'Comet#withdraw > borrow base',
  {
    tokenBalances: async (ctx) => (
      {
        albert: { $base: `== ${0n}` },
        $comet: { $base: getConfigForScenario(ctx).withdraw.baseAmount },
      }
    ),
    cometBalances: async (ctx) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).withdraw.assetAmount }
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const precision = scale / config.common.divisors.precision;

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);

    // Albert borrows base from Comet
    const txn = await albert.withdrawAsset({ asset: baseAsset.address, amount: BigInt(config.withdraw.baseAmount) * scale });

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(BigInt(config.withdraw.baseAmount) * scale);
    expectApproximately(await albert.getCometBaseBalance(), -BigInt(config.withdraw.baseAmount) * scale, precision);

    return txn;
  }
);

scenario(
  'Comet#withdrawFrom > base asset',
  {
    cometBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).common.amounts.base.small },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(baseSupplied);

    await albert.allow(betty, true);

    // Betty withdraws supplied units of base from Albert
    const txn = await betty.withdrawAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: baseSupplied });

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(baseSupplied);
    expect(await comet.balanceOf(albert.address)).to.be.lessThan(baseSupplied / config.common.divisors.percent);

    return txn;
  }
);

scenario(
  'Comet#withdrawFrom > borrow base',
  {
    tokenBalances: async (ctx) => (
      {
        albert: { $base: `== ${0n}` },
        $comet: { $base: getConfigForScenario(ctx).withdraw.baseAmount },
      }
    ),
    cometBalances: async (ctx) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).withdraw.assetAmount }
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const precision = scale / config.common.divisors.precision;

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);

    await albert.allow(betty, true);

    // Betty borrows base using Albert's account
    const txn = await betty.withdrawAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: BigInt(config.withdraw.baseAmount) * scale });

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(BigInt(config.withdraw.baseAmount) * scale);
    expectApproximately(await albert.getCometBaseBalance(), -BigInt(config.withdraw.baseAmount) * scale, precision);

    return txn;
  }
);

scenario(
  'Comet#withdrawFrom reverts if operator not given permission',
  {
    tokenBalances: async (ctx) => ({
      $comet: { $base: getConfigForScenario(ctx).withdraw.baseAmount },
    }),
    cometBalances: async (ctx) => ({
      albert: { $asset0: getConfigForScenario(ctx).withdraw.assetAmount }
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    // Betty borrows using Albert's account without permission
    await expectRevertCustom(
      betty.withdrawAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: config.common.amounts.base.tiny * scale,
      }),
      'Unauthorized()'
    );
  }
);

scenario(
  'Comet#withdraw reverts when withdraw is paused',
  {
    pause: {
      withdrawPaused: true,
    },
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const baseToken = await comet.baseToken();

    await expectRevertCustom(
      albert.withdrawAsset({
        asset: baseToken,
        amount: config.withdraw.baseAmount,
      }),
      'Paused()'
    );
  }
);

scenario(
  'Comet#withdrawFrom reverts when withdraw is paused',
  {
    pause: {
      withdrawPaused: true,
    },
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, true);

    await expectRevertCustom(
      albert.withdrawAssetFrom({
        src: betty.address,
        dst: albert.address,
        asset: baseToken,
        amount: config.withdraw.baseAmount,
      }),
      'Paused()'
    );
  }
);

scenario(
  'Comet#withdraw base reverts if position is undercollateralized',
  {
    cometBalances: async (ctx) => ({
      albert: { $base: 0n },
      charles: { $base: getConfigForScenario(ctx).common.amounts.base.large },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await expectRevertCustom(
      albert.withdrawAsset({
        asset: baseAsset.address,
        amount: config.common.amounts.base.large * scale,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#withdraw collateral reverts if position is undercollateralized',
  {
    cometBalances: async (ctx) => (
      {
        albert: { 
          $base: -getConfigForScenario(ctx).withdraw.alternateBase,
          $asset0: getConfigForScenario(ctx).withdraw.alternateAsset
        },
      }
    )
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const scale = scaleBN.toBigInt();

    await expectRevertCustom(
      albert.withdrawAsset({
        asset: collateralAsset.address,
        amount: BigInt(config.withdraw.alternateAsset) * scale
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#withdraw reverts if borrow is less than minimum borrow',
  {
    filter: async (ctx) => await hasMinBorrowGreaterThanOne(ctx),
    cometBalances: async (ctx) => ({
      albert: { $base: 0n, $asset0: getConfigForScenario(ctx).withdraw.assetAmount }
    })
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const minBorrow = (await comet.baseBorrowMin()).toBigInt();

    await expectRevertCustom(
      albert.withdrawAsset({
        asset: baseAsset.address,
        amount: minBorrow / config.common.divisors.borrow
      }),
      'BorrowTooSmall()'
    );
  }
);

scenario.skip(
  'Comet#withdraw reverts if asset is not supported',
  {},
  async () => {
    // XXX requires deploying an unsupported asset (maybe via remote token constraint)
  }
);

scenario.skip(
  'Comet#withdraw reverts if not enough asset in protocol',
  {},
  async () => {
    // XXX fix for development base, where Faucet token doesn't give the same revert message
  }
);