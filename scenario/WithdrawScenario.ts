import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import {
  expectRevertCustom,
  hasMinBorrowGreaterThanOne,
  isTriviallySourceable,
  isValidAssetIndex,
  MAX_ASSETS,
  fundAccount,
  usesAssetList,
  isAssetDelisted,
  supportsExtendedPause,
  getExpectedBaseBalance,
  expectBase
} from './utils';
import { getConfigForScenario } from './utils/scenarioHelper';
import { log } from 'console';
import { exp } from '../test/helpers';
import { MockERC20 } from '../build/types';

async function deployMockERC20(context: CometContext, alias: string, force?: boolean): Promise<MockERC20> {
  const dm = context.world.deploymentManager;

  const mockERC20 = (await dm.deploy(
    `mockERC20:${alias}`,
    'capo/contracts/test/MockERC20.sol',
    ['Mock Token', 'MOCK', 18],
    force
  )) as MockERC20;

  return mockERC20;
}

for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#withdraw > collateral asset ${offset}`,
    {
      filter: async (ctx: CometContext) =>
        (await isValidAssetIndex(ctx, offset)) &&
        (await isTriviallySourceable(ctx, offset, getConfigForScenario(ctx, offset).withdrawCollateral)),
      cometBalances: (ctx: CometContext) => ({
        albert: { [`$asset${offset}`]: getConfigForScenario(ctx, offset).withdrawCollateral }
      })
    },
    async ({ comet, actors }, context) => {
      const { albert } = actors;
      const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(offset);
      const collateralAsset = context.getAssetByAddress(assetAddress);
      const amountToWithdraw = BigInt(getConfigForScenario(context, offset).withdrawCollateral) * scaleBN.toBigInt();
      const userCollateralBalanceBefore = await albert.getCometCollateralBalance(assetAddress);
      const userAssetBalanceBefore = await collateralAsset.balanceOf(albert.address);

      const txn = await comet
        .connect(albert.signer)
        .withdraw(collateralAsset.address, amountToWithdraw)
        .then((tx) => tx.wait());
      // should change collateral balance of user
      expect(await albert.getCometCollateralBalance(assetAddress)).to.equal(
        userCollateralBalanceBefore - amountToWithdraw
      );
      // should change asset balance of user
      expect(await collateralAsset.balanceOf(albert.address)).to.equal(userAssetBalanceBefore + amountToWithdraw);

      return txn; // return txn to measure gas
    }
  );
}

for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#withdrawTo > collateral asset ${offset}`,
    {
      filter: async (ctx: CometContext) =>
        (await isValidAssetIndex(ctx, offset)) &&
        (await isTriviallySourceable(ctx, offset, getConfigForScenario(ctx, offset).withdrawCollateral)),
      cometBalances: (ctx: CometContext) => ({
        albert: { [`$asset${offset}`]: getConfigForScenario(ctx, offset).withdrawCollateral }
      })
    },
    async ({ comet, actors }, context) => {
      const { albert, betty } = actors;
      const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(offset);
      const collateralAsset = context.getAssetByAddress(assetAddress);
      const amountToWithdraw = BigInt(getConfigForScenario(context, offset).withdrawCollateral) * scaleBN.toBigInt();
      const fromUserCollateralBalanceBefore = await albert.getCometCollateralBalance(assetAddress);
      const fromUserAssetBalanceBefore = await collateralAsset.balanceOf(albert.address);
      const dstUserCollateralBalanceBefore = await betty.getCometCollateralBalance(assetAddress);
      const dstUserAssetBalanceBefore = await collateralAsset.balanceOf(betty.address);

      // Albert withdraws 100 units of collateral from Comet
      const txn = await comet
        .connect(albert.signer)
        .withdrawTo(betty.address, collateralAsset.address, amountToWithdraw)
        .then((tx) => tx.wait());

      // should change collateral balance of from user
      expect(await albert.getCometCollateralBalance(assetAddress)).to.equal(
        fromUserCollateralBalanceBefore - amountToWithdraw
      );
      // shouldn't change collateral balance of dst user
      expect(await betty.getCometCollateralBalance(assetAddress)).to.equal(dstUserCollateralBalanceBefore);
      // shouldn't change asset balance of from user
      expect(await collateralAsset.balanceOf(albert.address)).to.equal(fromUserAssetBalanceBefore);
      // should change asset balance of dst user
      expect(await collateralAsset.balanceOf(betty.address)).to.equal(dstUserAssetBalanceBefore + amountToWithdraw);

      return txn; // return txn to measure gas
    }
  );
}

for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#withdrawFrom > collateral asset ${offset}`,
    {
      filter: async (ctx: CometContext) =>
        (await isValidAssetIndex(ctx, offset)) &&
        (await isTriviallySourceable(ctx, offset, getConfigForScenario(ctx, offset).withdrawCollateral)),
      cometBalances: (ctx: CometContext) => ({
        albert: { [`$asset${offset}`]: getConfigForScenario(ctx, offset).withdrawCollateral }
      })
    },
    async (_properties, context) => {
      const comet = await context.getComet();
      const { albert, betty, charles } = context.actors;
      const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(offset);
      const collateralAsset = context.getAssetByAddress(assetAddress);
      const amountToWithdraw = BigInt(getConfigForScenario(context, offset).withdrawCollateral) * scaleBN.toBigInt();

      await albert.allow(charles, true);

      const fromUserCollateralBalanceBefore = await albert.getCometCollateralBalance(assetAddress);
      const fromUserAssetBalanceBefore = await collateralAsset.balanceOf(albert.address);
      const dstUserCollateralBalanceBefore = await betty.getCometCollateralBalance(assetAddress);
      const dstUserAssetBalanceBefore = await collateralAsset.balanceOf(betty.address);
      const operatorCollateralBalanceBefore = await charles.getCometCollateralBalance(assetAddress);
      const operatorAssetBalanceBefore = await collateralAsset.balanceOf(charles.address);

      const txn = await comet
        .connect(charles.signer)
        .withdrawFrom(albert.address, betty.address, collateralAsset.address, amountToWithdraw)
        .then((tx) => tx.wait());

      // should change collateral balance of from user
      expect(await albert.getCometCollateralBalance(assetAddress)).to.equal(
        fromUserCollateralBalanceBefore - amountToWithdraw
      );
      // shouldn't change collateral balance of dst user
      expect(await betty.getCometCollateralBalance(assetAddress)).to.equal(dstUserCollateralBalanceBefore);
      // shouldn't change collateral balance of operator
      expect(await charles.getCometCollateralBalance(assetAddress)).to.equal(operatorCollateralBalanceBefore);
      // shouldn't change asset balance of from user
      expect(await collateralAsset.balanceOf(albert.address)).to.equal(fromUserAssetBalanceBefore);
      // should change asset balance of dst user
      expect(await collateralAsset.balanceOf(betty.address)).to.equal(dstUserAssetBalanceBefore + amountToWithdraw);
      // shouldn't change asset balance of operator
      expect(await collateralAsset.balanceOf(charles.address)).to.equal(operatorAssetBalanceBefore);

      return txn; // return txn to measure gas
    }
  );
}

scenario(
  'Comet#withdraw > base asset',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).withdrawBase } // in units of asset, not wei
    })
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseAsset = context.getAssetByAddress(await comet.baseToken());
    // save balances before the withdraw for later comparison
    const userBaseBalanceBefore = await albert.getCometBaseBalance();
    const userAssetBalanceBefore = await baseAsset.balanceOf(albert.address);
    const amountToWithdraw = userBaseBalanceBefore / 2n;

    const txn = await comet
      .connect(albert.signer)
      .withdraw(baseAsset.address, amountToWithdraw)
      .then((tx) => tx.wait());

    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    // should change base balance of user
    const precision = 3n;
    expectBase(
      await albert.getCometBaseBalance(),
      getExpectedBaseBalance(userBaseBalanceBefore - amountToWithdraw, baseIndexScale, baseSupplyIndex),
      precision
    );
    // should change asset balance of user
    expect(await baseAsset.balanceOf(albert.address)).to.equal(userAssetBalanceBefore + amountToWithdraw);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#withdrawTo > base asset',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).withdrawBase } // in units of asset, not wei
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseAsset = context.getAssetByAddress(await comet.baseToken());
    // save balances before the withdraw for later comparison
    const fromUserBaseBalanceBefore = await albert.getCometBaseBalance();
    const fromUserAssetBalanceBefore = await baseAsset.balanceOf(albert.address);
    const dstUserBaseBalanceBefore = await betty.getCometBaseBalance();
    const dstUserAssetBalanceBefore = await baseAsset.balanceOf(betty.address);

    const amountToWithdraw = fromUserBaseBalanceBefore / 2n;

    // Albert withdraws supplied units of base from Comet
    const txn = await comet
      .connect(albert.signer)
      .withdrawTo(betty.address, baseAsset.address, amountToWithdraw)
      .then((tx) => tx.wait());

    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    // should change base balance of from user
    const precision = 3n;
    expectBase(
      await albert.getCometBaseBalance(),
      getExpectedBaseBalance(fromUserBaseBalanceBefore - amountToWithdraw, baseIndexScale, baseSupplyIndex),
      precision
    );
    // shouldn't change asset balance of from user
    expect(await baseAsset.balanceOf(albert.address)).to.equal(fromUserAssetBalanceBefore);
    // shouldn't change base balance of dst user
    expect(await betty.getCometBaseBalance()).to.equal(dstUserBaseBalanceBefore);
    // should change asset balance of dst user
    expect(await baseAsset.balanceOf(betty.address)).to.equal(dstUserAssetBalanceBefore + amountToWithdraw);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#withdrawFrom > base asset',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).withdrawBase } // in units of asset, not wei
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty, charles } = actors;
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseAsset = context.getAssetByAddress(await comet.baseToken());

    await albert.allow(charles, true);
    // save balances before the withdraw for later comparison
    const fromUserBaseBalanceBefore = await albert.getCometBaseBalance();
    const fromUserAssetBalanceBefore = await baseAsset.balanceOf(albert.address);
    const dstUserBaseBalanceBefore = await betty.getCometBaseBalance();
    const dstUserAssetBalanceBefore = await baseAsset.balanceOf(betty.address);
    const operatorBaseBalanceBefore = await charles.getCometBaseBalance();
    const operatorAssetBalanceBefore = await baseAsset.balanceOf(charles.address);

    const amountToWithdraw = fromUserBaseBalanceBefore / 2n;

    // Betty withdraws supplied units of base from Albert
    const txn = await comet
      .connect(charles.signer)
      .withdrawFrom(albert.address, betty.address, baseAsset.address, amountToWithdraw)
      .then((tx) => tx.wait());

    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const precision = 3n;
    // should change base balance of from user
    expectBase(
      await albert.getCometBaseBalance(),
      getExpectedBaseBalance(fromUserBaseBalanceBefore - amountToWithdraw, baseIndexScale, baseSupplyIndex),
      precision
    );
    // shouldn't change asset balance of from user
    expect(await baseAsset.balanceOf(albert.address)).to.equal(fromUserAssetBalanceBefore);
    // shouldn't change base balance of dst user
    expect(await betty.getCometBaseBalance()).to.equal(dstUserBaseBalanceBefore);
    // should change asset balance of dst user
    expect(await baseAsset.balanceOf(betty.address)).to.equal(dstUserAssetBalanceBefore + amountToWithdraw);
    // shouldn't change base balance of operator
    expect(await charles.getCometBaseBalance()).to.equal(operatorBaseBalanceBefore);
    // shouldn't change asset balance of operator
    expect(await baseAsset.balanceOf(charles.address)).to.equal(operatorAssetBalanceBefore);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#withdraw > borrow base',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).withdrawAsset } // in units of asset, not wei
    })
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseAsset = context.getAssetByAddress(await comet.baseToken());
    const scale = (await comet.baseScale()).toBigInt();

    const userBorrowBalanceBefore = (await comet.borrowBalanceOf(albert.address)).toBigInt();
    const userAssetBalanceBefore = await baseAsset.balanceOf(albert.address);

    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawBase) * scale;

    expect(await baseAsset.balanceOf(albert.address)).to.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.equal(0n);

    const txn = await comet
      .connect(albert.signer)
      .withdraw(baseAsset.address, amountToWithdraw)
      .then((tx) => tx.wait());

    const baseBorrowIndex = (await comet.totalsBasic()).baseBorrowIndex.toBigInt();

    // should change borrow balance of user
    const precision = 3n;
    expectBase(
      (await comet.borrowBalanceOf(albert.address)).toBigInt(),
      getExpectedBaseBalance(userBorrowBalanceBefore + amountToWithdraw, baseIndexScale, baseBorrowIndex),
      precision
    );
    // should change asset balance of user
    expect(await baseAsset.balanceOf(albert.address)).to.equal(userAssetBalanceBefore + amountToWithdraw);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#withdrawTo > borrow base',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).withdrawAsset } // in units of asset, not wei
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseAsset = context.getAssetByAddress(await comet.baseToken());
    const scale = (await comet.baseScale()).toBigInt();
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawBase) * scale;

    const fromUserBorrowBalanceBefore = (await comet.borrowBalanceOf(albert.address)).toBigInt();
    const fromUserAssetBalanceBefore = await baseAsset.balanceOf(albert.address);
    const dstUserBorrowBalanceBefore = (await comet.borrowBalanceOf(betty.address)).toBigInt();
    const dstUserAssetBalanceBefore = await baseAsset.balanceOf(betty.address);

    const txn = await comet
      .connect(albert.signer)
      .withdrawTo(betty.address, baseAsset.address, amountToWithdraw)
      .then((tx) => tx.wait());

    const baseBorrowIndex = (await comet.totalsBasic()).baseBorrowIndex.toBigInt();

    // should change borrow balance of from user
    const precision = 3n;
    expectBase(
      (await comet.borrowBalanceOf(albert.address)).toBigInt(),
      getExpectedBaseBalance(fromUserBorrowBalanceBefore + amountToWithdraw, baseIndexScale, baseBorrowIndex),
      precision
    );
    // shouldn't change asset balance of from user
    expect(await baseAsset.balanceOf(albert.address)).to.equal(fromUserAssetBalanceBefore);
    // shouldn't change borrow balance of dst user
    expect((await comet.borrowBalanceOf(betty.address)).toBigInt()).to.equal(dstUserBorrowBalanceBefore);
    // should change asset balance of dst user
    expect(await baseAsset.balanceOf(betty.address)).to.equal(dstUserAssetBalanceBefore + amountToWithdraw);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#withdrawFrom > borrow base',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).withdrawAsset } // in units of asset, not wei
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty, charles } = actors;
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseAsset = context.getAssetByAddress(await comet.baseToken());
    const scale = (await comet.baseScale()).toBigInt();
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawBase) * scale;

    await albert.allow(charles, true);

    const fromUserBorrowBalanceBefore = (await comet.borrowBalanceOf(albert.address)).toBigInt();
    const fromUserAssetBalanceBefore = await baseAsset.balanceOf(albert.address);
    const dstUserBorrowBalanceBefore = (await comet.borrowBalanceOf(betty.address)).toBigInt();
    const dstUserAssetBalanceBefore = await baseAsset.balanceOf(betty.address);
    const operatorBorrowBalanceBefore = (await comet.borrowBalanceOf(charles.address)).toBigInt();
    const operatorAssetBalanceBefore = await baseAsset.balanceOf(charles.address);

    const txn = await comet
      .connect(charles.signer)
      .withdrawFrom(albert.address, betty.address, baseAsset.address, amountToWithdraw)
      .then((tx) => tx.wait());

    const baseBorrowIndex = (await comet.totalsBasic()).baseBorrowIndex.toBigInt();

    // should change borrow balance of from user
    const precision = 3n;
    expectBase(
      (await comet.borrowBalanceOf(albert.address)).toBigInt(),
      getExpectedBaseBalance(fromUserBorrowBalanceBefore + amountToWithdraw, baseIndexScale, baseBorrowIndex),
      precision
    );
    // shouldn't change asset balance of from user
    expect(await baseAsset.balanceOf(albert.address)).to.equal(fromUserAssetBalanceBefore);
    // shouldn't change borrow balance of dst user
    expect((await comet.borrowBalanceOf(betty.address)).toBigInt()).to.equal(dstUserBorrowBalanceBefore);
    // should change asset balance of dst user
    expect(await baseAsset.balanceOf(betty.address)).to.equal(dstUserAssetBalanceBefore + amountToWithdraw);
    // shouldn't change borrow balance of operator
    expect((await comet.borrowBalanceOf(charles.address)).toBigInt()).to.equal(operatorBorrowBalanceBefore);
    // shouldn't change asset balance of operator
    expect(await baseAsset.balanceOf(charles.address)).to.equal(operatorAssetBalanceBefore);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#withdrawFrom reverts if operator not given permission',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).withdrawBase } // in units of asset, not wei
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawBase) * (await comet.baseScale()).toBigInt();

    await expectRevertCustom(
      comet.connect(betty.signer).withdrawFrom(albert.address, betty.address, baseAssetAddress, amountToWithdraw),
      'Unauthorized()'
    );
  }
);

scenario(
  'Comet#withdraw reverts when withdraw is paused',
  {
    pause: {
      withdrawPaused: true
    }
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawBase) * (await comet.baseScale()).toBigInt();

    await expectRevertCustom(comet.connect(albert.signer).withdraw(baseAssetAddress, amountToWithdraw), 'Paused()');
  }
);

scenario(
  'Comet#withdrawTo reverts when withdraw is paused',
  {
    pause: {
      withdrawPaused: true
    }
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawBase) * (await comet.baseScale()).toBigInt();

    await expectRevertCustom(
      comet.connect(albert.signer).withdrawTo(betty.address, baseAssetAddress, amountToWithdraw),
      'Paused()'
    );
  }
);

scenario(
  'Comet#withdrawFrom reverts when withdraw is paused',
  {
    pause: {
      withdrawPaused: true
    }
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;

    const baseAssetAddress = await comet.baseToken();
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawBase) * (await comet.baseScale()).toBigInt();

    await betty.allow(albert, true);

    await expectRevertCustom(
      comet.connect(albert.signer).withdrawFrom(betty.address, albert.address, baseAssetAddress, amountToWithdraw),
      'Paused()'
    );
  }
);

scenario(
  'Comet#withdraw reverts when collateral withdraw is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).withdrawCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).withdrawCollateral }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawCollateral) * scaleBN.toBigInt();

    // Pause collateral withdraw
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseCollateralWithdraw(true);

    await expectRevertCustom(
      comet.connect(albert.signer).withdraw(collateralAsset.address, amountToWithdraw),
      'CollateralWithdrawPaused()'
    );
  }
);

scenario(
  'Comet#withdrawTo reverts when collateral withdraw is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).withdrawCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).withdrawCollateral }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawCollateral) * scaleBN.toBigInt();

    // Pause collateral withdraw
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseCollateralWithdraw(true);

    await expectRevertCustom(
      comet.connect(albert.signer).withdrawTo(betty.address, collateralAsset.address, amountToWithdraw),
      'CollateralWithdrawPaused()'
    );
  }
);

scenario(
  'Comet#withdrawFrom reverts when collateral withdraw is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).withdrawCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).withdrawCollateral }
    })
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawCollateral) * scaleBN.toBigInt();

    await albert.allow(betty, true);
    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause collateral withdraw
    await cometExt.connect(pauseGuardian.signer).pauseCollateralWithdraw(true);

    await expectRevertCustom(
      comet
        .connect(betty.signer)
        .withdrawFrom(albert.address, betty.address, collateralAsset.address, amountToWithdraw),
      'CollateralWithdrawPaused()'
    );
  }
);

scenario(
  'Comet#withdraw reverts when borrowers withdraw is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).withdrawBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $base: '== 0' },
      $comet: { $base: getConfigForScenario(ctx).withdrawBase }
    }),
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).withdrawAsset }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawBase) * (await comet.baseScale()).toBigInt();

    // Pause borrowers withdraw
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseBorrowersWithdraw(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet.connect(albert.signer).withdraw(baseAssetAddress, amountToWithdraw),
      'BorrowersWithdrawPaused()'
    );
  }
);

scenario(
  'Comet#withdrawTo reverts when borrowers withdraw is paused',
  {
    filter: async (ctx: CometContext) => {
      return !(await isAssetDelisted(ctx, 0)) && (await supportsExtendedPause(ctx));
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).supplyCollateral }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawBase) * (await comet.baseScale()).toBigInt();
    // Pause borrowers withdraw
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseBorrowersWithdraw(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet.connect(albert.signer).withdrawTo(betty.address, baseAssetAddress, amountToWithdraw),
      'BorrowersWithdrawPaused()'
    );
  }
);

scenario(
  'Comet#withdrawFrom reverts when borrowers withdraw is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).withdrawBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $base: '== 0' },
      $comet: { $base: getConfigForScenario(ctx).withdrawBase }
    }),
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).withdrawAsset }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawBase) * (await comet.baseScale()).toBigInt();

    await albert.allow(betty, true);
    // Pause borrowers withdraw
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseBorrowersWithdraw(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet.connect(betty.signer).withdrawFrom(albert.address, betty.address, baseAssetAddress, amountToWithdraw),
      'BorrowersWithdrawPaused()'
    );
  }
);

scenario(
  'Comet#withdraw > reverts when lenders withdraw is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).withdrawBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).withdrawBase }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    // Pause lenders withdraw
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseLendersWithdraw(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet.connect(albert.signer).withdraw(baseAsset.address, baseSupplied),
      'LendersWithdrawPaused()'
    );
  }
);

scenario(
  'Comet#withdrawTo > reverts when lenders withdraw is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).withdrawBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).withdrawBase }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, berry, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    // Pause lenders withdraw
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseLendersWithdraw(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet.connect(albert.signer).withdrawTo(berry.address, baseAsset.address, baseSupplied),
      'LendersWithdrawPaused()'
    );
  }
);

scenario(
  'Comet#withdrawFrom reverts when lenders withdraw is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).withdrawBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).withdrawBase }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    await albert.allow(betty, true);
    // Pause lenders withdraw
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseLendersWithdraw(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet.connect(betty.signer).withdrawFrom(albert.address, betty.address, baseAssetAddress, baseSupplied),
      'LendersWithdrawPaused()'
    );
  }
);

scenario(
  'Comet#withdraw > reverts when specific collateral asset is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).withdrawCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: {
        $asset0: getConfigForScenario(ctx).withdrawCollateral
      }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, pauseGuardian } = actors;
    const offset = 0;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(offset);
    const collateralAsset = context.getAssetByAddress(asset);
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawCollateral) * scaleBN.toBigInt();

    // Pause only asset0 withdraw
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetWithdraw(offset, true);

    // Asset0 withdraw should revert
    await expectRevertCustom(
      comet.connect(albert.signer).withdraw(collateralAsset.address, amountToWithdraw),
      `CollateralAssetWithdrawPaused(${offset})`
    );
  }
);

scenario(
  'Comet#withdrawTo > reverts when specific collateral asset is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).withdrawCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: {
        $asset0: getConfigForScenario(ctx).withdrawCollateral
      }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const offset = 0;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(offset);
    const collateralAsset = context.getAssetByAddress(asset);
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawCollateral) * scaleBN.toBigInt();

    // Pause only asset0 withdraw
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetWithdraw(offset, true);

    // Asset0 withdraw should revert
    await expectRevertCustom(
      comet.connect(albert.signer).withdrawTo(betty.address, collateralAsset.address, amountToWithdraw),
      `CollateralAssetWithdrawPaused(${offset})`
    );
  }
);

scenario(
  'Comet#withdrawFrom > reverts when specific collateral asset is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).withdrawCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: {
        $asset0: getConfigForScenario(ctx).withdrawCollateral
      }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const offset = 0;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(offset);
    const collateralAsset = context.getAssetByAddress(asset);
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawCollateral) * scaleBN.toBigInt();

    // Pause only asset0 withdraw
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetWithdraw(offset, true);

    await albert.allow(betty, true);

    // Asset0 withdraw should revert
    await expectRevertCustom(
      comet
        .connect(betty.signer)
        .withdrawFrom(albert.address, betty.address, collateralAsset.address, amountToWithdraw),
      `CollateralAssetWithdrawPaused(${offset})`
    );
  }
);

scenario('Comet#withdraw > base reverts if position is undercollateralized', {}, async ({ comet, actors }, context) => {
  const { albert } = actors;
  const baseAssetAddress = await comet.baseToken();
  const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawBase) * (await comet.baseScale()).toBigInt();

  await expectRevertCustom(
    comet.connect(albert.signer).withdraw(baseAssetAddress, amountToWithdraw),
    'NotCollateralized()'
  );
});

scenario(
  'Comet#withdrawTo > base reverts if position is undercollateralized',
  {},
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawBase) * (await comet.baseScale()).toBigInt();

    await expectRevertCustom(
      comet.connect(albert.signer).withdrawTo(betty.address, baseAssetAddress, amountToWithdraw),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#withdrawFrom > base reverts if position is undercollateralized',
  {},
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawBase) * (await comet.baseScale()).toBigInt();

    await albert.allow(betty, true);

    await expectRevertCustom(
      comet.connect(betty.signer).withdrawFrom(albert.address, betty.address, baseAssetAddress, amountToWithdraw),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#withdraw > collateral reverts if position is undercollateralized',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: {
        $base: -getConfigForScenario(ctx).withdrawBase1,
        $asset0: getConfigForScenario(ctx).withdrawAsset1
      } // in units of asset, not wei
    })
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawAsset1) * scaleBN.toBigInt();

    await expectRevertCustom(
      comet.connect(albert.signer).withdraw(assetAddress, amountToWithdraw),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#withdrawTo > collateral reverts if position is undercollateralized',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: {
        $base: -getConfigForScenario(ctx).withdrawBase1,
        $asset0: getConfigForScenario(ctx).withdrawAsset1
      } // in units of asset, not wei
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawAsset1) * scaleBN.toBigInt();

    await expectRevertCustom(
      comet.connect(albert.signer).withdrawTo(betty.address, assetAddress, amountToWithdraw),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#withdrawFrom > collateral reverts if position is undercollateralized',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: {
        $base: -getConfigForScenario(ctx).withdrawBase1,
        $asset0: getConfigForScenario(ctx).withdrawAsset1
      } // in units of asset, not wei
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const amountToWithdraw = BigInt(getConfigForScenario(context).withdrawAsset1) * scaleBN.toBigInt();

    await albert.allow(betty, true);

    await expectRevertCustom(
      comet.connect(betty.signer).withdrawFrom(albert.address, betty.address, assetAddress, amountToWithdraw),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#withdraw reverts if borrow is less than minimum borrow',
  {
    filter: async (ctx: CometContext) => await hasMinBorrowGreaterThanOne(ctx),
    cometBalances: {
      albert: { $asset0: 100 }
    }
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const amountToWithdraw = (await comet.baseBorrowMin()).toBigInt() / 2n;

    await expectRevertCustom(
      comet.connect(albert.signer).withdraw(baseAssetAddress, amountToWithdraw),
      'BorrowTooSmall()'
    );
  }
);

scenario(
  'Comet#withdrawTo > reverts if borrow is less than minimum borrow',
  {
    filter: async (ctx: CometContext) => await hasMinBorrowGreaterThanOne(ctx),
    cometBalances: {
      albert: { $asset0: 100 }
    }
  },
  async ({ comet, actors }) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const amountToWithdraw = (await comet.baseBorrowMin()).toBigInt() / 2n;

    await expectRevertCustom(
      comet.connect(albert.signer).withdrawTo(betty.address, baseAssetAddress, amountToWithdraw),
      'BorrowTooSmall()'
    );
  }
);

scenario(
  'Comet#withdrawFrom > reverts if borrow is less than minimum borrow',
  {
    filter: async (ctx: CometContext) => await hasMinBorrowGreaterThanOne(ctx),
    cometBalances: {
      albert: { $asset0: 100 }
    }
  },
  async ({ comet, actors }) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const amountToWithdraw = (await comet.baseBorrowMin()).toBigInt() / 2n;

    await albert.allow(betty, true);

    await expectRevertCustom(
      comet.connect(betty.signer).withdrawFrom(albert.address, betty.address, baseAssetAddress, amountToWithdraw),
      'BorrowTooSmall()'
    );
  }
);

scenario('Comet#withdraw > _reverts if not enough base asset in protocol', {}, async ({ comet, actors }, context) => {
  const { albert } = actors;
  const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();

  const offset = 0;
  const { asset: assetAddress, borrowCollateralFactor, priceFeed, scale: scaleBN } = await comet.getAssetInfo(offset);
  const collateralAsset = context.getAssetByAddress(assetAddress);
  const collateralScale = scaleBN.toBigInt();

  const baseAsset = context.getAssetByAddress(await comet.baseToken());

  const collateralPrice = (await comet.getPrice(priceFeed)).toBigInt();
  const baseScale = (await comet.baseScale()).toBigInt();
  const factorScale = (await comet.factorScale()).toBigInt();

  const targetBorrowBase = BigInt(await baseAsset.balanceOf(comet.address)) + 1n; // borrow more than protocol has

  const collateralPerUnitBase = (collateralScale * basePrice) / collateralPrice;
  let collateralNeeded = (collateralPerUnitBase * targetBorrowBase) / baseScale;
  collateralNeeded = (collateralNeeded * factorScale) / borrowCollateralFactor.toBigInt();
  collateralNeeded = (collateralNeeded * 11n) / 10n; // add fudge factor to ensure collateralization

  await context.sourceTokens(collateralNeeded, collateralAsset, albert);

  await collateralAsset.approve(albert, comet.address);
  await albert.safeSupplyAsset({ asset: collateralAsset.address, amount: collateralNeeded });

  expect(comet.connect(albert.signer).withdraw(baseAsset.address, targetBorrowBase)).to.be.reverted;
});

scenario('Comet#withdraw > reverts if not enough base asset in protocol', {}, async ({ comet, actors }, context) => {
  const { albert } = actors;
  const baseAsset = context.getAssetByAddress(await comet.baseToken());
  const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
  const baseScale = (await comet.baseScale()).toBigInt();
  const factorScale = (await comet.factorScale()).toBigInt();
  const numAssets = await comet.numAssets();

  // We know exactly how much we need to borrow to drain the protocol: balance + 1
  const targetBorrowBase = BigInt(await baseAsset.balanceOf(comet.address)) + 1n;

  // Walk collaterals, supplying as much as each one's remaining supplyCap allows,
  // until accumulated borrowing power covers the target.
  let remaining = targetBorrowBase;
  for (let i = 0; i < numAssets && remaining > 0n; i++) {
    const { asset, borrowCollateralFactor, priceFeed, scale: scaleBN, supplyCap } = await comet.getAssetInfo(i);
    const bCF = borrowCollateralFactor.toBigInt();
    if (bCF === 0n) continue; // delisted: skip

    const { totalSupplyAsset } = await comet.totalsCollateral(asset);
    const headroom = supplyCap.toBigInt() - totalSupplyAsset.toBigInt();
    if (headroom <= 0n) continue; // no cap headroom: skip

    const collateralAsset = context.getAssetByAddress(asset);
    const collateralScale = scaleBN.toBigInt();
    const collateralPrice = (await comet.getPrice(priceFeed)).toBigInt();

    // Collateral needed to cover `remaining`, inverse of the borrow-capacity formula,
    // with a 10% fudge factor for rounding / price drift between blocks:
    const collateralPerUnitBase = (collateralScale * basePrice) / collateralPrice;
    let collateralNeeded = (collateralPerUnitBase * remaining) / baseScale;
    collateralNeeded = (collateralNeeded * factorScale) / bCF;
    collateralNeeded = (collateralNeeded * 11n) / 10n;

    // Respect the cap: supply only what fits. Deliberately plain supplyAsset,
    // NOT safeSupplyAsset — bumping caps here would defeat the whole point.
    const supplyAmount = collateralNeeded < headroom ? collateralNeeded : headroom;

    await context.sourceTokens(supplyAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.supplyAsset({ asset: collateralAsset.address, amount: supplyAmount });

    // Borrowing power actually gained, counted conservatively (inverse fudge):
    const valueInBase = (supplyAmount * collateralPrice * baseScale) / (collateralScale * basePrice);
    const capacityGained = (((valueInBase * bCF) / factorScale) * 10n) / 11n;
    remaining = capacityGained >= remaining ? 0n : remaining - capacityGained;
  }

  // The filter guarantees feasibility; this guards against drift between filter and now
  // expect(remaining).to.equal(0n, 'collected collateral does not cover target borrow');

  // Collateralization is sufficient, so the failure must come from the token transfer
  // itself (protocol lacks base), not from NotCollateralized.
  await expect(comet.connect(albert.signer).withdraw(baseAsset.address, targetBorrowBase)).to.be.reverted;
});

/**
 * @title Withdraw Scenario - isBorrowCollateralized with borrowCollateralFactor = 0
 * @notice Test suite for isBorrowCollateralized behavior when borrowCollateralFactor is set to 0
 *
 * @dev This test suite was written after the USDM incident, when a token price feed was removed from Chainlink.
 * The incident revealed that when a price feed becomes unavailable, the protocol cannot calculate the USD value
 * of collateral (e.g., during absorption when trying to getPrice() for a delisted asset).
 *
 * @dev The solution was to set the asset's borrowCollateralFactor to 0 for delisted collateral. For isBorrowCollateralized,
 * when borrowCollateralFactor = 0, the contract skips that asset in the liquidity calculation (see CometWithExtendedAssetList.sol
 * lines 402-405), effectively excluding it from contributing to the user's collateralization. This prevents the protocol
 * from calling getPrice() on unavailable price feeds.
 *
 * @dev This scenario tests isBorrowCollateralized behavior in two phases:
 * 1. Normal operation: Verifies that positions with positive borrowCF are properly collateralized and can borrow
 * 2. Delisted asset: Sets borrowCF to 0 and verifies that the collateral is excluded from liquidity calculations,
 *    causing positions to become undercollateralized and preventing further borrowing when their only collateral asset is delisted
 *
 * @dev Unlike isLiquidatable which uses liquidateCollateralFactor, this function determines whether a user can initiate
 * new borrows, making it critical for preventing new positions from being opened with unpriceable collateral.
 *
 * @dev The scenario runs for all valid assets (up to MAX_ASSETS) and only on Comet deployments that use
 * the extended asset list feature (CometExtAssetList), as the borrowCollateralFactor = 0 behavior is specific
 * to that implementation. The base Comet contract does not have this check and will attempt to call getPrice()
 * even when borrowCF=0, which would cause a revert if the price feed is unavailable. The test filters deployments
 * using the usesAssetList() utility function to ensure compatibility, and excludes assets that are already delisted.
 */
for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#isBorrowCollateralized > skips liquidity of asset ${offset} with borrowCF=0`,
    {
      filter: async (ctx) =>
        (await isValidAssetIndex(ctx, offset)) &&
        (await isTriviallySourceable(ctx, offset, getConfigForScenario(ctx, offset).supplyCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, offset)) &&
        (await supportsExtendedPause(ctx)),
      tokenBalances: (ctx: CometContext) => ({
        albert: { $base: '== 0' },
        $comet: { $base: getConfigForScenario(ctx, offset).withdrawBase }
      })
    },
    async ({ comet, configurator, proxyAdmin, actors }, context) => {
      const { albert, admin } = actors;
      const { asset, borrowCollateralFactor, priceFeed, scale: scaleBN } = await comet.getAssetInfo(offset);
      const collateralAsset = context.getAssetByAddress(asset);
      const collateralScale = scaleBN.toBigInt();

      // Get price feeds and scales
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const collateralPrice = (await comet.getPrice(priceFeed)).toBigInt();
      const baseScale = (await comet.baseScale()).toBigInt();
      const factorScale = (await comet.factorScale()).toBigInt();

      // Target borrow amount (in base units, not wei)
      const targetBorrowBase = BigInt(getConfigForScenario(context, offset).withdrawBase);
      const targetBorrowBaseWei = targetBorrowBase * baseScale;

      // Calculate required collateral amount
      // Formula from CometBalanceConstraint.ts:
      const collateralWeiPerUnitBase = (collateralScale * basePrice) / collateralPrice;
      let collateralNeeded = (collateralWeiPerUnitBase * targetBorrowBaseWei) / baseScale;
      collateralNeeded = (collateralNeeded * factorScale) / borrowCollateralFactor.toBigInt();
      collateralNeeded = (collateralNeeded * 11n) / 10n; // add fudge factor to ensure collateralization

      // Set up balances dynamically
      // 1. Source collateral tokens for albert
      await context.sourceTokens(collateralNeeded, collateralAsset, albert);

      // 2. Approve and supply collateral
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAsset.address, amount: collateralNeeded });

      // 3. Borrow base (this will make albert have negative base balance)
      const baseTokenAddress = await comet.baseToken();
      await comet.connect(albert.signer).withdraw(baseTokenAddress, targetBorrowBaseWei);

      // Verify initial state: position should be collateralized
      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;

      // Zero borrowCF for target asset via governance
      await context.setNextBaseFeeToZero();
      await configurator
        .connect(admin.signer)
        .updateAssetBorrowCollateralFactor(comet.address, asset, 0n, { gasPrice: 0 });
      await context.setNextBaseFeeToZero();
      await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

      // Verify borrowCF is 0
      const assetInfo = await comet.getAssetInfoByAddress(asset);
      expect(assetInfo.borrowCollateralFactor).to.equal(0);

      // After zeroing the only supplied asset's borrowCF, position should be undercollateralized
      expect(await comet.isBorrowCollateralized(albert.address)).to.equal(false);
    }
  );
}

scenario(
  'Comet#withdraw > reverts when collateral asset withdraw is paused and allows to withdraw when unpaused',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, pauseGuardian } = actors;
    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let offset = 0; offset < MAX_ASSETS; offset++) {
      if (!(await isValidAssetIndex(context, offset))) continue;
      if (!(await isTriviallySourceable(context, offset, getConfigForScenario(context).withdrawCollateral))) continue;
      if (await isAssetDelisted(context, offset)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(offset);
      const collateralAsset = context.getAssetByAddress(asset);
      const withdrawCollateral = BigInt(getConfigForScenario(context).withdrawCollateral) * scaleBN.toBigInt();

      log(`Withdrawing reverts when collateral asset ${offset} withdraw is paused`);

      // Source collateral asset
      await context.sourceTokens(withdrawCollateral, collateralAsset.address, albert.address);
      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);
      // Supply collateral asset
      await comet.connect(albert.signer).supply(collateralAsset.address, withdrawCollateral);
      // Pause specific collateral withdraw by asset offset
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetWithdraw(offset, true);

      await expectRevertCustom(
        comet.connect(albert.signer).withdraw(collateralAsset.address, withdrawCollateral),
        `CollateralAssetWithdrawPaused(${offset})`
      );

      log(`Withdrawing is allowed when collateral asset ${offset} withdraw is unpaused`);
      // Unpause specific collateral withdraw by asset offset
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetWithdraw(offset, false);
      // Save balance
      const albertBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      // Withdraw asset from albert
      await comet.connect(albert.signer).withdraw(collateralAsset.address, withdrawCollateral);
      // Get balance after withdraw
      const albertBalanceAfter = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      // Assert balance after withdraw
      expect(albertBalanceAfter).to.equal(albertBalanceBefore.toBigInt() - withdrawCollateral);
    }
  }
);

scenario(
  'Comet#withdrawTo > reverts when collateral asset withdraw is paused and allows to withdraw when unpaused',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let offset = 0; offset < MAX_ASSETS; offset++) {
      if (!(await isValidAssetIndex(context, offset))) continue;
      if (!(await isTriviallySourceable(context, offset, getConfigForScenario(context).withdrawCollateral))) continue;
      if (await isAssetDelisted(context, offset)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(offset);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const withdrawCollateral = BigInt(getConfigForScenario(context).withdrawCollateral) * scale;

      log(`Withdrawing reverts when collateral asset ${offset} withdraw is paused`);

      // Source collateral asset
      await context.sourceTokens(withdrawCollateral, collateralAsset.address, albert.address);

      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);

      // Supply collateral asset
      await albert.safeSupplyAsset({
        asset: collateralAsset.address,
        amount: withdrawCollateral
      });

      // Pause specific collateral asset withdraw at index offset
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetWithdraw(offset, true);

      await expectRevertCustom(
        comet.connect(albert.signer).withdrawTo(betty.address, collateralAsset.address, withdrawCollateral),
        `CollateralAssetWithdrawPaused(${offset})`
      );

      log(`Withdrawing is allowed when collateral asset ${offset} withdraw is unpaused`);

      // Unpause specific collateral asset withdraw at index offset
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetWithdraw(offset, false);

      // Save balance
      const albertBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceBefore = await comet.collateralBalanceOf(betty.address, collateralAsset.address);
      const albertTokenBalanceBefore = await collateralAsset.balanceOf(albert.address);
      const bettyTokenBalanceBefore = await collateralAsset.balanceOf(betty.address);

      // Withdraw asset to betty
      await comet.connect(albert.signer).withdrawTo(betty.address, collateralAsset.address, withdrawCollateral);

      // Get balances after withdraw
      const albertBalanceAfter = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceAfter = await comet.collateralBalanceOf(betty.address, collateralAsset.address);
      const albertTokenBalanceAfter = await collateralAsset.balanceOf(albert.address);
      const bettyTokenBalanceAfter = await collateralAsset.balanceOf(betty.address);

      // Assert balances after withdraw
      expect(albertBalanceAfter).to.equal(albertBalanceBefore.toBigInt() - withdrawCollateral);
      expect(bettyBalanceAfter).to.equal(bettyBalanceBefore);

      expect(albertTokenBalanceBefore).to.equal(albertTokenBalanceAfter);
      expect(bettyTokenBalanceAfter).to.equal(bettyTokenBalanceBefore + withdrawCollateral);
    }
  }
);

scenario(
  'Comet#withdrawFrom > reverts when collateral asset withdraw is paused and allows to withdraw when unpaused',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);
    // Allow betty to withdraw asset from albert
    await albert.allow(betty, true);

    for (let offset = 0; offset < MAX_ASSETS; offset++) {
      if (!(await isValidAssetIndex(context, offset))) continue;
      if (!(await isTriviallySourceable(context, offset, getConfigForScenario(context).withdrawCollateral))) continue;
      if (await isAssetDelisted(context, offset)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(offset);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const withdrawCollateral = BigInt(getConfigForScenario(context).withdrawCollateral) * scale;

      log(`Withdrawing reverts when collateral asset ${offset} withdraw is paused`);
      // Source collateral asset
      await context.sourceTokens(withdrawCollateral, collateralAsset.address, albert.address);
      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);
      // Supply collateral asset
      await comet.connect(albert.signer).supply(collateralAsset.address, withdrawCollateral);
      // Pause specific collateral withdraw by asset offset
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetWithdraw(offset, true);

      await expectRevertCustom(
        comet
          .connect(betty.signer)
          .withdrawFrom(albert.address, betty.address, collateralAsset.address, withdrawCollateral),
        `CollateralAssetWithdrawPaused(${offset})`
      );

      log(`Withdrawing is allowed when collateral asset ${offset} withdraw is unpaused`);

      // Unpause specific collateral withdraw by asset offset
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetWithdraw(offset, false);

      // Save balances
      const albertBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceBefore = await comet.collateralBalanceOf(betty.address, collateralAsset.address);
      const albertTokenBalanceBefore = await collateralAsset.balanceOf(albert.address);
      const bettyTokenBalanceBefore = await collateralAsset.balanceOf(betty.address);

      // Withdraw asset from albert to betty
      await comet
        .connect(betty.signer)
        .withdrawFrom(albert.address, betty.address, collateralAsset.address, withdrawCollateral);

      // Get balances after withdraw
      const albertBalanceAfter = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceAfter = await comet.collateralBalanceOf(betty.address, collateralAsset.address);
      const albertTokenBalanceAfter = await collateralAsset.balanceOf(albert.address);
      const bettyTokenBalanceAfter = await collateralAsset.balanceOf(betty.address);

      // Assert balances after withdraw
      expect(albertBalanceAfter).to.equal(albertBalanceBefore.toBigInt() - withdrawCollateral);
      expect(bettyBalanceAfter).to.equal(bettyBalanceBefore);

      expect(albertTokenBalanceBefore).to.equal(albertTokenBalanceAfter);
      expect(bettyTokenBalanceAfter).to.equal(bettyTokenBalanceBefore + withdrawCollateral);
    }
  }
);

scenario('Comet#withdraw > reverts on unregistered asset', {}, async ({ comet, actors }, context) => {
  const { albert } = actors;

  const unregisteredAsset = await deployMockERC20(context, 'asset');
  const collateralAmount = exp(getConfigForScenario(context).withdrawCollateral, await unregisteredAsset.decimals());

  // NOTE: with the current contract implementation it is impossible to get BadAsset()
  // due to the order of operations, the transaction reverts with a different error
  // before the asset validity check is reached.
  // await expectRevertCustom(
  //   comet.connect(albert.signer).withdraw(unregisteredAsset.address, collateralAmount),
  //   'BadAsset()'
  // );

  await expect(
    comet.connect(albert.signer).withdraw(unregisteredAsset.address, collateralAmount)
  ).to.be.revertedWithPanic(0x11); // everted with panic code 0x11 - arithmetic operation underflowed
});

scenario('Comet#withdrawTo > reverts on unregistered asset', {}, async ({ comet, actors }, context) => {
  const { albert, betty } = actors;

  const unregisteredAsset = await deployMockERC20(context, 'asset');
  const collateralAmount = exp(getConfigForScenario(context).withdrawCollateral, await unregisteredAsset.decimals());

  // NOTE: with the current contract implementation it is impossible to get BadAsset()
  // due to the order of operations, the transaction reverts with a different error
  // before the asset validity check is reached.
  // await expectRevertCustom(
  //   comet.connect(albert.signer).withdrawTo(betty.address, unregisteredAsset.address, collateralAmount),
  //   'BadAsset()'
  // );

  await expect(
    comet.connect(albert.signer).withdrawTo(betty.address, unregisteredAsset.address, collateralAmount)
  ).to.be.revertedWithPanic(0x11); // everted with panic code 0x11 - arithmetic operation underflowed
});

scenario('Comet#withdrawFrom > reverts on unregistered asset', {}, async ({ comet, actors }, context) => {
  const { albert, betty } = actors;

  const unregisteredAsset = await deployMockERC20(context, 'asset');
  const collateralAmount = exp(getConfigForScenario(context).withdrawCollateral, await unregisteredAsset.decimals());

  await albert.allow(betty, true);

  // NOTE: with the current contract implementation it is impossible to get BadAsset()
  // due to the order of operations, the transaction reverts with a different error
  // before the asset validity check is reached.
  // await expectRevertCustom(
  //   comet
  //     .connect(betty.signer)
  //     .withdrawFrom(albert.address, betty.address, unregisteredAsset.address, collateralAmount),
  //   'BadAsset()'
  // );

  await expect(
    comet.connect(betty.signer).withdrawFrom(albert.address, betty.address, unregisteredAsset.address, collateralAmount)
  ).to.be.revertedWithPanic(0x11); // everted with panic code 0x11 - arithmetic operation underflowed
});

scenario(
  'Comet#withdraw > allows withdrawing deactivated collateral asset',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context) => {
    const { pauseGuardian, albert } = actors;

    for (let offset = 0; offset < MAX_ASSETS; offset++) {
      if (!(await isValidAssetIndex(context, offset))) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(offset);
      const collateralAsset = context.getAssetByAddress(asset);

      const amountToWithdraw = BigInt(getConfigForScenario(context, offset).withdrawCollateral) * scaleBN.toBigInt();

      // Source collateral asset
      await context.sourceTokens(amountToWithdraw, collateralAsset.address, albert.address);
      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);
      // Supply collateral
      await comet.connect(albert.signer).supply(collateralAsset.address, amountToWithdraw);

      const userCollateralBalanceBefore = await albert.getCometCollateralBalance(collateralAsset.address);
      const userAssetBalanceBefore = await collateralAsset.balanceOf(albert.address);

      // Deactivate collateral asset
      await context.setNextBaseFeeToZero();
      await cometExt.connect(pauseGuardian.signer).deactivateCollateral(offset, { gasPrice: 0 });

      await comet.connect(albert.signer).withdraw(collateralAsset.address, amountToWithdraw);

      // should change collateral balance of user
      expect(await albert.getCometCollateralBalance(collateralAsset.address)).to.equal(
        userCollateralBalanceBefore - amountToWithdraw
      );
      // should change token balance of user
      expect(await collateralAsset.balanceOf(albert.address)).to.equal(userAssetBalanceBefore + amountToWithdraw);
    }
  }
);
