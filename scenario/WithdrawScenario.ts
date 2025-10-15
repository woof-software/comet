import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { expectApproximately, expectRevertCustom, hasMinBorrowGreaterThanOne, isTriviallySourceable, isValidAssetIndex, MAX_ASSETS } from './utils';
import { ContractReceipt } from 'ethers';
import { getConfigForScenario } from './utils/scenarioHelper';

// Constants
const BASE_BALANCE_SMALL = 2n;
const BASE_PERCENT_DIVISOR = 100n;
const PRECISION_DIVISOR = 1_000_000n;
const AUTHORIZATION_ENABLED = true;
const BASE_BALANCE_TEST = 100n;
const COLLATERAL_BALANCE_TEST = 100n;
const WITHDRAW_AMOUNT_TINY = 1n;
const WITHDRAW_AMOUNT_TEST = 100n;
const BASE_BALANCE_LARGE = 1000n;
const WITHDRAW_AMOUNT_LARGE = 1000n;
const BORROW_DIVISOR = 2n;

async function testWithdrawCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const comet = await context.getComet();
  const { albert } = context.actors;
  const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);
  const scale = scaleBN.toBigInt();

  expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(0n);
  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(BigInt(getConfigForScenario(context).supply.collateralAmount) * scale);

  // Albert withdraws collateral from Comet
  const txn = await albert.withdrawAsset({ asset: collateralAsset.address, amount: BigInt(getConfigForScenario(context).supply.collateralAmount) * scale });

  expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(BigInt(getConfigForScenario(context).supply.collateralAmount) * scale);
  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(0n);

  return txn;
}

async function testWithdrawFromCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const comet = await context.getComet();
  const { albert, betty } = context.actors;
  const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);
  const scale = scaleBN.toBigInt();

  expect(await collateralAsset.balanceOf(betty.address)).to.be.equal(0n);
  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(BigInt(getConfigForScenario(context).supply.collateralAmount) * scale);

  await albert.allow(betty, AUTHORIZATION_ENABLED);

  // Betty withdraws collateral from Albert
  const txn = await betty.withdrawAssetFrom({ src: albert.address, dst: betty.address, asset: collateralAsset.address, amount: BigInt(getConfigForScenario(context).supply.collateralAmount) * scale });

  expect(await collateralAsset.balanceOf(betty.address)).to.be.equal(BigInt(getConfigForScenario(context).supply.collateralAmount) * scale);
  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(0n);

  return txn;
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#withdraw > collateral asset ${i}`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx).withdraw.collateralAmount),
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
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx).withdraw.collateralAmount),
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
    cometBalances: {
      albert: { $base: BASE_BALANCE_SMALL },
    },
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    // Albert withdraws supplied units of base from Comet
    const txn = await albert.withdrawAsset({ asset: baseAsset.address, amount: baseSupplied });

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(baseSupplied);
    expect(await comet.balanceOf(albert.address)).to.be.lessThan(baseSupplied / BASE_PERCENT_DIVISOR);

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
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const precision = scale / PRECISION_DIVISOR;

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);

    // Albert borrows base from Comet
    const txn = await albert.withdrawAsset({ asset: baseAsset.address, amount: BigInt(getConfigForScenario(context).withdraw.baseAmount) * scale });

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(BigInt(getConfigForScenario(context).withdraw.baseAmount) * scale);
    expectApproximately(await albert.getCometBaseBalance(), -BigInt(getConfigForScenario(context).withdraw.baseAmount) * scale, precision);

    return txn;
  }
);

scenario(
  'Comet#withdrawFrom > base asset',
  {
    cometBalances: {
      albert: { $base: BASE_BALANCE_SMALL },
    },
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(baseSupplied);

    await albert.allow(betty, AUTHORIZATION_ENABLED);

    // Betty withdraws supplied units of base from Albert
    const txn = await betty.withdrawAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: baseSupplied });

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(baseSupplied);
    expect(await comet.balanceOf(albert.address)).to.be.lessThan(baseSupplied / BASE_PERCENT_DIVISOR);

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
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const precision = scale / PRECISION_DIVISOR;

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);

    await albert.allow(betty, AUTHORIZATION_ENABLED);

    // Betty borrows base using Albert's account
    const txn = await betty.withdrawAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: BigInt(getConfigForScenario(context).withdraw.baseAmount) * scale });

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(BigInt(getConfigForScenario(context).withdraw.baseAmount) * scale);
    expectApproximately(await albert.getCometBaseBalance(), -BigInt(getConfigForScenario(context).withdraw.baseAmount) * scale, precision);

    return txn;
  }
);

scenario(
  'Comet#withdrawFrom reverts if operator not given permission',
  {
    tokenBalances: {
      $comet: { $base: BASE_BALANCE_TEST },
    },
    cometBalances: {
      albert: { $asset0: COLLATERAL_BALANCE_TEST }
    },
  },
  async ({ comet, actors }, context) => {
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
        amount: WITHDRAW_AMOUNT_TINY * scale,
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
  async ({ comet, actors }) => {
    const { albert } = actors;
    const baseToken = await comet.baseToken();

    await expectRevertCustom(
      albert.withdrawAsset({
        asset: baseToken,
        amount: WITHDRAW_AMOUNT_TEST,
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
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, AUTHORIZATION_ENABLED);

    await expectRevertCustom(
      albert.withdrawAssetFrom({
        src: betty.address,
        dst: albert.address,
        asset: baseToken,
        amount: WITHDRAW_AMOUNT_TEST,
      }),
      'Paused()'
    );
  }
);

scenario(
  'Comet#withdraw base reverts if position is undercollateralized',
  {
    cometBalances: {
      albert: { $base: 0n },
      charles: { $base: BASE_BALANCE_LARGE },
    },
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await expectRevertCustom(
      albert.withdrawAsset({
        asset: baseAsset.address,
        amount: WITHDRAW_AMOUNT_LARGE * scale,
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
    const { albert } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const scale = scaleBN.toBigInt();

    await expectRevertCustom(
      albert.withdrawAsset({
        asset: collateralAsset.address,
        amount: BigInt(getConfigForScenario(context).withdraw.alternateAsset) * scale
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#withdraw reverts if borrow is less than minimum borrow',
  {
    filter: async (ctx) => await hasMinBorrowGreaterThanOne(ctx),
    cometBalances: {
      albert: { $base: 0n, $asset0: COLLATERAL_BALANCE_TEST }
    }
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const minBorrow = (await comet.baseBorrowMin()).toBigInt();

    await expectRevertCustom(
      albert.withdrawAsset({
        asset: baseAsset.address,
        amount: minBorrow / BORROW_DIVISOR
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
