import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import {
  expectApproximately,
  expectBase,
  expectRevertCustom,
  getInterest,
  hasMinBorrowGreaterThanOne,
  isTriviallySourceable,
  isValidAssetIndex,
  MAX_ASSETS,
  fundAccount,
  usesAssetList,
  isAssetDelisted,
  supportsExtendedPause,
  getExpectedBaseBalance
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
    `Comet#transferAsset > collateral asset ${offset}, enough balance`,
    {
      filter: async (ctx: CometContext) =>
        (await isValidAssetIndex(ctx, offset)) &&
        (await isTriviallySourceable(ctx, offset, getConfigForScenario(ctx, offset).transferCollateral)),
      cometBalances: (ctx: CometContext) => ({
        albert: { [`$asset${offset}`]: getConfigForScenario(ctx, offset).transferCollateral }
      })
    },
    async ({ actors, comet }) => {
      const { albert, betty } = actors;
      const { asset: assetAddress } = await comet.getAssetInfo(offset);
      const fromUserCollateralBefore = await albert.getCometCollateralBalance(assetAddress);
      const dstUserCollateralBefore = await betty.getCometCollateralBalance(assetAddress);

      const amountToTransfer = fromUserCollateralBefore / 2n;

      const txn = await comet
        .connect(albert.signer)
        .transferAsset(betty.address, assetAddress, amountToTransfer)
        .then((tx) => tx.wait());

      expect(await albert.getCometCollateralBalance(assetAddress)).to.equal(
        fromUserCollateralBefore - amountToTransfer
      );
      expect(await betty.getCometCollateralBalance(assetAddress)).to.equal(dstUserCollateralBefore + amountToTransfer);

      return txn; // return txn to measure gas
    }
  );
}

for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#transferAssetFrom > collateral asset ${offset}, enough balance`,
    {
      filter: async (ctx: CometContext) =>
        (await isValidAssetIndex(ctx, offset)) &&
        (await isTriviallySourceable(ctx, offset, getConfigForScenario(ctx, offset).transferCollateral)),
      cometBalances: (ctx: CometContext) => ({
        albert: { [`$asset${offset}`]: getConfigForScenario(ctx, offset).transferCollateral }
      })
    },
    async ({ actors, comet }) => {
      const { albert, betty, charles } = actors;
      const { asset: assetAddress } = await comet.getAssetInfo(offset);
      const fromUserCollateralBefore = await albert.getCometCollateralBalance(assetAddress);
      const dstUserCollateralBefore = await betty.getCometCollateralBalance(assetAddress);

      const amountToTransfer = fromUserCollateralBefore / 2n;

      await albert.allow(charles, true);

      const txn = await comet
        .connect(charles.signer)
        .transferAssetFrom(albert.address, betty.address, assetAddress, amountToTransfer)
        .then((tx) => tx.wait());

      expect(await albert.getCometCollateralBalance(assetAddress)).to.equal(
        fromUserCollateralBefore - amountToTransfer
      );
      expect(await betty.getCometCollateralBalance(assetAddress)).to.equal(dstUserCollateralBefore + amountToTransfer);

      return txn; // return txn to measure gas
    }
  );
}

scenario(
  'Comet#transfer > base asset',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase } // in units of asset, not wei
    })
  },
  async ({ comet, actors }) => {
    const { albert, betty } = actors;
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();

    const fromUserBaseBalance = await albert.getCometBaseBalance();
    const dstUserBaseBalance = await betty.getCometBaseBalance();
    const amountToTransfer = fromUserBaseBalance / 2n;

    const txn = await comet
      .connect(albert.signer)
      .transfer(betty.address, amountToTransfer)
      .then((tx) => tx.wait());

    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();

    expectBase(
      await albert.getCometBaseBalance(),
      getExpectedBaseBalance(fromUserBaseBalance - amountToTransfer, baseIndexScale, baseSupplyIndex)
    );
    expectBase(
      await betty.getCometBaseBalance(),
      getExpectedBaseBalance(dstUserBaseBalance + amountToTransfer, baseIndexScale, baseSupplyIndex)
    );

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#transferFrom > base asset',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase } // in units of asset, not wei
    })
  },
  async ({ comet, actors }) => {
    const { albert, betty, charles } = actors;
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();

    await albert.allow(charles, true);

    const fromUserBaseBalance = await albert.getCometBaseBalance();
    const dstUserBaseBalance = await betty.getCometBaseBalance();
    const amountToTransfer = fromUserBaseBalance / 2n;

    const txn = await comet
      .connect(charles.signer)
      .transferFrom(albert.address, betty.address, amountToTransfer)
      .then((tx) => tx.wait());

    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();

    expectBase(
      await albert.getCometBaseBalance(),
      getExpectedBaseBalance(fromUserBaseBalance - amountToTransfer, baseIndexScale, baseSupplyIndex)
    );
    expectBase(
      await betty.getCometBaseBalance(),
      getExpectedBaseBalance(dstUserBaseBalance + amountToTransfer, baseIndexScale, baseSupplyIndex)
    );

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#transferAsset > base asset',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase } // in units of asset, not wei
    })
  },
  async ({ comet, actors }) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();

    const fromUserBaseBalance = await albert.getCometBaseBalance();
    const dstUserBaseBalance = await betty.getCometBaseBalance();
    const amountToTransfer = fromUserBaseBalance / 2n;

    const txn = await comet
      .connect(albert.signer)
      .transferAsset(betty.address, baseAssetAddress, amountToTransfer)
      .then((tx) => tx.wait());

    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();

    expectBase(
      await albert.getCometBaseBalance(),
      getExpectedBaseBalance(fromUserBaseBalance - amountToTransfer, baseIndexScale, baseSupplyIndex)
    );
    expectBase(
      await betty.getCometBaseBalance(),
      getExpectedBaseBalance(dstUserBaseBalance + amountToTransfer, baseIndexScale, baseSupplyIndex)
    );

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#transferAssetFrom > base asset',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase } // in units of asset, not wei
    })
  },
  async ({ comet, actors }) => {
    const { albert, betty, charles } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();

    await albert.allow(charles, true);

    const fromUserBaseBalance = await albert.getCometBaseBalance();
    const dstUserBaseBalance = await betty.getCometBaseBalance();
    const amountToTransfer = fromUserBaseBalance / 2n;

    const txn = await comet
      .connect(charles.signer)
      .transferAssetFrom(albert.address, betty.address, baseAssetAddress, amountToTransfer)
      .then((tx) => tx.wait());

    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();

    expectBase(
      await albert.getCometBaseBalance(),
      getExpectedBaseBalance(fromUserBaseBalance - amountToTransfer, baseIndexScale, baseSupplyIndex)
    );
    expectBase(
      await betty.getCometBaseBalance(),
      getExpectedBaseBalance(dstUserBaseBalance + amountToTransfer, baseIndexScale, baseSupplyIndex)
    );

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#transfer > base asset, total and user balances are summed up properly',
  {
    cometBalances: {
      albert: { $base: 100 } // in units of asset, not wei
    }
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    // Cache pre-transfer balances
    const { totalSupplyBase: oldTotalSupply, totalBorrowBase: oldTotalBorrow } = await comet.totalsBasic();
    const oldAlbertPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
    const oldBettyPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();

    // Albert transfers 50 units of collateral to Betty
    const amountToTransfer = 50n * (await comet.baseScale()).toBigInt();
    const txn = await comet
      .connect(albert.signer)
      .transfer(betty.address, amountToTransfer)
      .then((tx) => tx.wait());

    // Cache post-transfer balances
    const { totalSupplyBase: newTotalSupply, totalBorrowBase: newTotalBorrow } = await comet.totalsBasic();
    const newAlbertPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
    const newBettyPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();

    // Check that global and user principals are updated by the same amount
    const changeInTotalPrincipal =
      newTotalSupply.toBigInt() - oldTotalSupply.toBigInt() - (newTotalBorrow.toBigInt() - oldTotalBorrow.toBigInt());
    const changeInUserPrincipal = newAlbertPrincipal - oldAlbertPrincipal + newBettyPrincipal - oldBettyPrincipal;
    expect(changeInTotalPrincipal).to.be.equal(changeInUserPrincipal);
    expect([0n, -1n, -2n]).to.include(changeInTotalPrincipal); // these are the only acceptable values for transfer

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#transfer > partial withdraw / borrow base to partial repay / supply',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase, $asset0: getConfigForScenario(ctx).transferAsset1 }, // in units of asset, not wei
      betty: { $base: -getConfigForScenario(ctx).transferBase }
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    // XXX 100 seconds?!
    expectApproximately(
      await albert.getCometBaseBalance(),
      BigInt(getConfigForScenario(context).transferBase) * scale,
      getInterest(BigInt(getConfigForScenario(context).transferBase) * scale, borrowRate, 100n) + 2n
    );

    expectApproximately(
      await betty.getCometBaseBalance(),
      -BigInt(getConfigForScenario(context).transferBase) * scale,
      getInterest(BigInt(getConfigForScenario(context).transferBase) * scale, borrowRate, 100n) + 2n
    );

    // Albert with positive balance transfers to Betty with negative balance
    const amountToTransfer = ((BigInt(getConfigForScenario(context).transferBase) * 25n) / 10n) * scale;
    const txn = await comet
      .connect(albert.signer)
      .transfer(betty.address, amountToTransfer)
      .then((tx) => tx.wait());

    // Albert ends with negative balance and Betty with positive balance
    expectApproximately(
      await albert.getCometBaseBalance(),
      ((-BigInt(getConfigForScenario(context).transferBase) * 15n) / 10n) * scale,
      getInterest(((BigInt(getConfigForScenario(context).transferBase) * 15n) / 10n) * scale, borrowRate, 100n) + 4n
    );
    expectApproximately(
      await betty.getCometBaseBalance(),
      ((BigInt(getConfigForScenario(context).transferBase) * 15n) / 10n) * scale,
      getInterest(((BigInt(getConfigForScenario(context).transferBase) * 15n) / 10n) * scale, borrowRate, 100n) + 4n
    );

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#transferFrom > withdraw to repay',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase, $asset0: getConfigForScenario(ctx).transferAsset2 }, // in units of asset, not wei
      betty: { $base: -getConfigForScenario(ctx).transferBase }
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const scale = (await comet.baseScale()).toBigInt();
    const amountTransferred = BigInt(getConfigForScenario(context).transferBase) * scale;
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    // XXX 70 seconds?!
    expectApproximately(
      await albert.getCometBaseBalance(),
      amountTransferred,
      getInterest(amountTransferred, borrowRate, BigInt(getConfigForScenario(context).interestSeconds)) + 2n
    );
    expectApproximately(
      await betty.getCometBaseBalance(),
      -amountTransferred,
      getInterest(amountTransferred, borrowRate, BigInt(getConfigForScenario(context).interestSeconds)) + 2n
    );

    await albert.allow(betty, true);

    // Betty withdraws from Albert to repay her own borrows
    const toTransfer = amountTransferred - scale; // XXX cannot withdraw 1000 (to ~0)
    const txn = await comet
      .connect(betty.signer)
      .transferFrom(albert.address, betty.address, toTransfer)
      .then((tx) => tx.wait());

    expectApproximately(
      await albert.getCometBaseBalance(),
      scale,
      getInterest(amountTransferred, borrowRate, BigInt(getConfigForScenario(context).interestSeconds)) + 2n
    );
    expectApproximately(
      await betty.getCometBaseBalance(),
      -scale,
      getInterest(amountTransferred, borrowRate, BigInt(getConfigForScenario(context).interestSeconds)) + 2n
    );

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#transferAsset > base reverts if undercollateralized',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase, $asset0: 0.000001 }, // in units of asset, not wei
      betty: { $base: -getConfigForScenario(ctx).transferBase },
      charles: { $base: getConfigForScenario(ctx).transferBase } // to give the protocol enough base for others to borrow from
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const amountTransferred = BigInt(getConfigForScenario(context).transferBase) * scale;
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    // XXX 100 seconds?!
    expectApproximately(
      await albert.getCometBaseBalance(),
      amountTransferred,
      getInterest(amountTransferred, borrowRate, BigInt(getConfigForScenario(context).interestSeconds)) + 2n
    );
    expectApproximately(
      await betty.getCometBaseBalance(),
      -amountTransferred,
      getInterest(amountTransferred, borrowRate, 100n) + 2n
    );

    // Albert with positive balance transfers to Betty with negative balance
    const toTransfer = 2n * amountTransferred + scale; // XXX min borrow...
    await expectRevertCustom(
      comet.connect(albert.signer).transferAsset(betty.address, baseAsset.address, toTransfer),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transferAssetFrom > base reverts if undercollateralized',
  {
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase, $asset0: 0.000001 }, // in units of asset, not wei
      betty: { $base: -getConfigForScenario(ctx).transferBase },
      charles: { $base: getConfigForScenario(ctx).transferBase } // to give the protocol enough base for others to borrow from
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const amountTransferred = BigInt(getConfigForScenario(context).transferBase) * scale;
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    // XXX 70 seconds?!
    expectApproximately(
      await albert.getCometBaseBalance(),
      amountTransferred,
      getInterest(amountTransferred, borrowRate, BigInt(getConfigForScenario(context).interestSeconds)) + 2n
    );
    expectApproximately(
      await betty.getCometBaseBalance(),
      -amountTransferred,
      getInterest(amountTransferred, borrowRate, BigInt(getConfigForScenario(context).interestSeconds)) + 2n
    );

    await albert.allow(betty, true);

    // Albert with positive balance transfers to Betty with negative balance
    const toTransfer = 2n * amountTransferred + scale; // XXX min borrow...
    await expectRevertCustom(
      comet.connect(betty.signer).transferAssetFrom(albert.address, betty.address, baseAsset.address, toTransfer),
      'NotCollateralized()'
    );
  }
);

for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#transferAssetFrom > collateral asset ${offset} reverts if src would be undercollateralized`,
    {
      filter: async (ctx: CometContext) =>
        (await isValidAssetIndex(ctx, offset)) &&
        !(await isAssetDelisted(ctx, offset)) &&
        (await isTriviallySourceable(ctx, offset, getConfigForScenario(ctx, offset).transferCollateral)),
      cometBalances: async (ctx: CometContext) => ({
        albert: { [`$asset${offset}`]: getConfigForScenario(ctx, offset).transferCollateral }
      })
    },
    async ({ comet, actors }, context) => {
      const { albert, betty } = actors;
      const { asset: assetAddress } = await comet.getAssetInfo(offset);
      const baseToken = await comet.baseToken();
      const baseScale = (await comet.baseScale()).toBigInt();

      const borrowAmount = BigInt(getConfigForScenario(context).transferBase) * baseScale;
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      await albert.allow(betty, true);

      const fullCollateral = (await comet.collateralBalanceOf(albert.address, assetAddress)).toBigInt();
      await expectRevertCustom(
        comet.connect(betty.signer).transferAssetFrom(albert.address, betty.address, assetAddress, fullCollateral),
        'NotCollateralized()'
      );
    }
  );
}

scenario(
  'Comet#transferAsset > collateral reverts if undercollateralized',
  {
    // XXX we should probably have a price constraint?
    cometBalances: (ctx: CometContext) => ({
      albert: {
        $base: -getConfigForScenario(ctx).transferBase,
        $asset0: `== ${getConfigForScenario(ctx).transferAsset}`
      }, // in units of asset, not wei
      betty: { $asset0: 0 }
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const scale = scaleBN.toBigInt();

    // Albert transfers all his collateral to Betty
    await expectRevertCustom(
      comet
        .connect(albert.signer)
        .transferAsset(
          betty.address,
          collateralAsset.address,
          BigInt(getConfigForScenario(context).transferAsset) * scale
        ),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transferAssetFrom > collateral reverts if undercollateralized',
  {
    // XXX we should probably have a price constraint?
    cometBalances: (ctx: CometContext) => ({
      albert: {
        $base: -getConfigForScenario(ctx).transferBase,
        $asset0: `== ${getConfigForScenario(ctx).transferAsset}`
      }, // in units of asset, not wei
      betty: { $asset0: 0 }
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const scale = scaleBN.toBigInt();

    await albert.allow(betty, true);

    // Betty transfers all of Albert's collateral to herself
    await expectRevertCustom(
      comet
        .connect(betty.signer)
        .transferAssetFrom(
          albert.address,
          betty.address,
          collateralAsset.address,
          BigInt(getConfigForScenario(context).transferAsset) * scale
        ),
      'NotCollateralized()'
    );
  }
);

scenario('Comet#transferAsset > disallows self-transfer of base', {}, async ({ comet, actors }) => {
  const { albert } = actors;

  const baseToken = await comet.baseToken();

  await expectRevertCustom(
    comet.connect(albert.signer).transferAsset(albert.address, baseToken, 100),
    'NoSelfTransfer()'
  );
});

scenario('Comet#transferAsset > disallows self-transfer of collateral', {}, async ({ comet, actors }) => {
  const { albert } = actors;

  const collateralAsset = await comet.getAssetInfo(0);

  await expectRevertCustom(
    comet.connect(albert.signer).transferAsset(albert.address, collateralAsset.asset, 100),
    'NoSelfTransfer()'
  );
});

scenario('Comet#transferFrom > disallows self-transfer of base', {}, async ({ comet, actors }) => {
  const { albert, betty } = actors;

  const baseToken = await comet.baseToken();

  await betty.allow(albert, true);

  await expectRevertCustom(
    albert.transferAssetFrom({
      src: betty.address,
      dst: betty.address,
      asset: baseToken,
      amount: 100
    }),
    'NoSelfTransfer()'
  );
});

scenario('Comet#transferAssetFrom > disallows self-transfer of collateral', {}, async ({ comet, actors }) => {
  const { albert, betty } = actors;

  const collateralAsset = await comet.getAssetInfo(0);

  await betty.allow(albert, true);

  await expectRevertCustom(
    comet.connect(albert.signer).transferAssetFrom(betty.address, betty.address, collateralAsset.asset, 100),
    'NoSelfTransfer()'
  );
});

scenario(
  'Comet#transferAssetFrom > reverts if operator not given permission',
  {},
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await expectRevertCustom(
      comet.connect(betty.signer).transferAssetFrom(albert.address, betty.address, baseAsset.address, 1n * scale),
      'Unauthorized()'
    );
  }
);

scenario(
  'Comet#transferAsset > reverts when transfer is paused',
  {
    pause: {
      transferPaused: true
    }
  },
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, true);

    await expectRevertCustom(comet.connect(albert.signer).transferAsset(betty.address, baseToken, 100), 'Paused()');
  }
);

scenario(
  'Comet#transferAssetFrom > reverts when transfer is paused',
  {
    pause: {
      transferPaused: true
    }
  },
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, true);

    await expectRevertCustom(
      comet.connect(albert.signer).transferAssetFrom(betty.address, albert.address, baseToken, 100),
      'Paused()'
    );
  }
);

scenario(
  'Comet#transfer > reverts if borrow is less than minimum borrow',
  {
    filter: async (ctx: CometContext) => await hasMinBorrowGreaterThanOne(ctx),
    cometBalances: {
      albert: { $asset0: 100 }
    }
  },
  async ({ comet, actors }) => {
    const { albert, betty } = actors;
    const amountToTransfer = (await comet.baseBorrowMin()).toBigInt() / 2n;

    await expectRevertCustom(
      comet.connect(albert.signer).transfer(betty.address, amountToTransfer, { gasPrice: 0 }),
      'BorrowTooSmall()'
    );
  }
);

scenario(
  'Comet#transferAsset > reverts if borrow is less than minimum borrow',
  {
    filter: async (ctx: CometContext) => await hasMinBorrowGreaterThanOne(ctx),
    cometBalances: {
      albert: { $asset0: 100 }
    }
  },
  async ({ comet, actors }) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const amountToTransfer = (await comet.baseBorrowMin()).toBigInt() / 2n;

    await expectRevertCustom(
      comet.connect(albert.signer).transferAsset(betty.address, baseAssetAddress, amountToTransfer),
      'BorrowTooSmall()'
    );
  }
);

scenario(
  'Comet#transferAsset > reverts when collateral transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).transferCollateral }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    // Pause collateral transfer
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseCollateralTransfer(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet
        .connect(albert.signer)
        .transferAsset(
          betty.address,
          assetAddress,
          BigInt(getConfigForScenario(context).transferCollateral) * scaleBN.toBigInt()
        ),
      'CollateralTransferPaused()'
    );
  }
);

scenario(
  'Comet#transferAssetFrom > reverts when collateral transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).transferCollateral }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, charles, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const scale = scaleBN.toBigInt();

    await albert.allow(betty, true);
    // Pause collateral transfer
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseCollateralTransfer(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet
        .connect(betty.signer)
        .transferAssetFrom(
          albert.address,
          charles.address,
          collateralAsset.address,
          BigInt(getConfigForScenario(context).transferCollateral) * scale
        ),
      'CollateralTransferPaused()'
    );
  }
);

scenario(
  'Comet#transfer > reverts when borrowers transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $base: '== 0' },
      betty: { $base: getConfigForScenario(ctx).transferBase }
    }),
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: -getConfigForScenario(ctx).transferBase, $asset0: getConfigForScenario(ctx).transferAsset },
      charles: { $base: getConfigForScenario(ctx).transferBase } // to give the protocol enough base for others to borrow from
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const scale = (await comet.baseScale()).toBigInt();

    // Pause borrowers transfer
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseBorrowersTransfer(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet.connect(albert.signer).transfer(betty.address, BigInt(getConfigForScenario(context).transferBase) * scale),
      'BorrowersTransferPaused()'
    );
  }
);
scenario(
  'Comet#transferAsset > reverts when borrowers transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $base: '== 0' },
      betty: { $base: getConfigForScenario(ctx).transferBase }
    }),
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: -getConfigForScenario(ctx).transferBase, $asset0: getConfigForScenario(ctx).transferAsset },
      charles: { $base: getConfigForScenario(ctx).transferBase } // to give the protocol enough base for others to borrow from
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const scale = (await comet.baseScale()).toBigInt();

    // Pause borrowers transfer
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseBorrowersTransfer(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet
        .connect(albert.signer)
        .transferAsset(betty.address, baseAssetAddress, BigInt(getConfigForScenario(context).transferBase) * scale),
      'BorrowersTransferPaused()'
    );
  }
);

scenario(
  'Comet#transferFrom > reverts when borrowers transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $base: '== 0' },
      $comet: { $base: getConfigForScenario(ctx).transferBase }
    }),
    cometBalances: async (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).transferAsset }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const scale = (await comet.baseScale()).toBigInt();

    await albert.allow(betty, true);
    // Pause borrowers transfer
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseBorrowersTransfer(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet
        .connect(betty.signer)
        .transferFrom(albert.address, betty.address, BigInt(getConfigForScenario(context).transferBase) * scale),
      'BorrowersTransferPaused()'
    );
  }
);
scenario(
  'Comet#transferAssetFrom > reverts when borrowers transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $base: '== 0' },
      $comet: { $base: getConfigForScenario(ctx).transferBase }
    }),
    cometBalances: async (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).transferAsset }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const scale = (await comet.baseScale()).toBigInt();

    await albert.allow(betty, true);
    // Pause borrowers transfer
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseBorrowersTransfer(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet
        .connect(betty.signer)
        .transferAssetFrom(
          albert.address,
          betty.address,
          baseAssetAddress,
          BigInt(getConfigForScenario(context).transferBase) * scale
        ),
      'BorrowersTransferPaused()'
    );
  }
);

scenario(
  'Comet#transfer > reverts when lenders transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    // Pause lenders transfer
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseLendersTransfer(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet.connect(albert.signer).transfer(betty.address, baseSupplied),
      'LendersTransferPaused()'
    );
  }
);

scenario(
  'Comet#transferAsset > reverts when lenders transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    // Pause lenders transfer
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseLendersTransfer(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet.connect(albert.signer).transferAsset(betty.address, baseAsset.address, baseSupplied),
      'LendersTransferPaused()'
    );
  }
);

scenario(
  'Comet#transferAssetFrom > reverts when lenders transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    await albert.allow(betty, true);

    // Pause lenders transfer
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseLendersTransfer(true, { gasPrice: 0 });

    await expectRevertCustom(
      comet.connect(betty.signer).transferAssetFrom(albert.address, betty.address, baseAsset.address, baseSupplied),
      'LendersTransferPaused()'
    );
  }
);

scenario(
  'Comet#transferAsset > reverts when specific collateral asset is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx, 0).transferCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: {
        $asset0: getConfigForScenario(ctx).transferCollateral
      }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const offset = 0;
    const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(offset);
    const collateralAsset = context.getAssetByAddress(assetAddress);
    const scale = scaleBN.toBigInt();

    // Pause only asset0 transfer
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(offset, true, { gasPrice: 0 });

    // Asset0 transfer should revert
    await expectRevertCustom(
      comet
        .connect(albert.signer)
        .transferAsset(
          betty.address,
          collateralAsset.address,
          BigInt(getConfigForScenario(context).transferCollateral) * scale
        ),
      `CollateralAssetTransferPaused(${offset})`
    );
  }
);

scenario(
  'Comet#transferAssetFrom > reverts when specific collateral asset is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    cometBalances: (ctx: CometContext) => ({
      albert: {
        $asset0: getConfigForScenario(ctx).transferCollateral
      }
    })
  },
  async ({ comet, actors, cometExt }, context) => {
    const { albert, betty, pauseGuardian } = actors;
    const offset = 0;
    const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(offset);
    const collateralAsset = context.getAssetByAddress(assetAddress);
    const scale = scaleBN.toBigInt();

    // Pause only asset0 transfer
    await context.setNextBaseFeeToZero();
    await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(offset, true, { gasPrice: 0 });

    await albert.allow(betty, true);

    // Asset0 transfer should revert
    await expectRevertCustom(
      comet
        .connect(betty.signer)
        .transferAssetFrom(
          albert.address,
          betty.address,
          collateralAsset.address,
          BigInt(getConfigForScenario(context).transferCollateral) * scale
        ),
      `CollateralAssetTransferPaused(${offset})`
    );
  }
);

scenario(
  'Comet#transferAsset > reverts when collateral asset transfer is paused and allows to transfer when unpaused',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!(await isValidAssetIndex(context, i))) continue;
      if (!(await isTriviallySourceable(context, i, getConfigForScenario(context).transferCollateral))) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(assetAddress);
      const scale = scaleBN.toBigInt();
      const transferCollateral = BigInt(getConfigForScenario(context).transferCollateral) * scale;

      log(`Transferring reverts when collateral asset ${i} transfer is paused`);

      // Source collateral asset
      await context.sourceTokens(transferCollateral, collateralAsset.address, albert.address);

      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);

      // Supply collateral asset
      await comet.connect(albert.signer).supply(collateralAsset.address, transferCollateral);

      // Pause specific collateral asset transfer at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(i, true);

      await expectRevertCustom(
        comet.connect(albert.signer).transferAsset(betty.address, collateralAsset.address, transferCollateral),
        `CollateralAssetTransferPaused(${i})`
      );

      log(`Transferring is allowed when collateral asset ${i} transfer is unpaused`);

      // Unpause specific collateral asset transfer at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(i, false);

      // Save balances
      const albertBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceBefore = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      // Transfer asset from albert to betty
      await comet.connect(albert.signer).transferAsset(betty.address, collateralAsset.address, transferCollateral);

      // Get balances after transfer
      const albertBalanceAfter = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceAfter = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      // Assert balances after transfer
      expect(albertBalanceAfter).to.be.equal(albertBalanceBefore.toBigInt() - transferCollateral);
      expect(bettyBalanceAfter).to.be.equal(bettyBalanceBefore.toBigInt() + transferCollateral);
    }
  }
);

scenario(
  'Comet#transferAssetFrom > reverts when collateral asset transfer is paused and allows to transfer when unpaused',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!(await isValidAssetIndex(context, i))) continue;
      if (!(await isTriviallySourceable(context, i, getConfigForScenario(context).transferCollateral))) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(assetAddress);
      const scale = scaleBN.toBigInt();
      const transferCollateral = BigInt(getConfigForScenario(context).transferCollateral) * scale;

      log(`Transferring reverts when collateral asset ${i} transfer is paused`);

      // Fund pause guardian account for gas fees
      await context.sourceTokens(transferCollateral, collateralAsset.address, albert.address);

      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);

      // Supply collateral asset
      await comet.connect(albert.signer).supply(collateralAsset.address, transferCollateral);

      // Pause specific collateral asset transfer at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(i, true);

      // Allow betty to transfer asset from albert
      await albert.allow(betty, true);

      await expectRevertCustom(
        comet
          .connect(betty.signer)
          .transferAssetFrom(albert.address, betty.address, collateralAsset.address, transferCollateral),
        `CollateralAssetTransferPaused(${i})`
      );

      log(`Transferring is allowed when collateral asset ${i} transfer is unpaused`);

      // Unpause specific collateral asset transfer at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(i, false);

      // Save balances
      const albertBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceBefore = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      // Transfer asset from albert to betty
      await comet
        .connect(betty.signer)
        .transferAssetFrom(
          albert.address,
          betty.address,
          collateralAsset.address,
          BigInt(getConfigForScenario(context).transferCollateral) * scale
        );

      // Get balances after transfer
      const albertBalanceAfter = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceAfter = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      // Assert balances after transfer
      expect(albertBalanceAfter).to.be.equal(albertBalanceBefore.toBigInt() - transferCollateral);
      expect(bettyBalanceAfter).to.be.equal(bettyBalanceBefore.toBigInt() + transferCollateral);
    }
  }
);

scenario('Comet#transferAsset > reverts on unregistered asset', {}, async ({ actors, comet }, context) => {
  const { albert, betty } = actors;

  const unregisteredAsset = await deployMockERC20(context, 'asset');
  const collateralAmount = exp(getConfigForScenario(context).transferCollateral, await unregisteredAsset.decimals());

  // NOTE: with the current contract implementation it is impossible to get BadAsset()
  // due to the order of operations, the transaction reverts with a different error
  // before the asset validity check is reached.
  // await expectRevertCustom(
  //   comet.connect(albert.signer).transferAsset(betty.address, unregisteredAsset.address, collateralAmount),
  //   'BadAsset()'
  // );

  await expect(
    comet.connect(albert.signer).transferAsset(betty.address, unregisteredAsset.address, collateralAmount)
  ).to.be.revertedWithPanic(0x11); // everted with panic code 0x11 - arithmetic operation underflowed
});

scenario('Comet#transferAssetFrom > reverts on unregistered asset', {}, async ({ actors, comet }, context) => {
  const { albert, betty } = actors;

  const unregisteredAsset = await deployMockERC20(context, 'asset');
  const collateralAmount = exp(getConfigForScenario(context).transferCollateral, await unregisteredAsset.decimals());

  await albert.allow(betty, true);

  // NOTE: with the current contract implementation it is impossible to get BadAsset()
  // due to the order of operations, the transaction reverts with a different error
  // before the asset validity check is reached.
  // await expectRevertCustom(
  //   comet
  //     .connect(betty.signer)
  //     .transferAssetFrom(albert.address, betty.address, unregisteredAsset.address, collateralAmount),
  //   'BadAsset()'
  // );

  await expect(
    comet
      .connect(betty.signer)
      .transferAssetFrom(albert.address, betty.address, unregisteredAsset.address, collateralAmount)
  ).to.be.revertedWithPanic(0x11); // everted with panic code 0x11 - arithmetic operation underflowed
});

/*//////////////////////////////////////////////////////////////
                    DEACTIVATE/ACTIVATE COLLATERALS
//////////////////////////////////////////////////////////////*/

scenario(
  'Comet#transferFrom > reverts when collateral asset is deactivated and allows to transfer when activated',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, charles, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Allow betty to act on behalf of albert
    await albert.allow(betty, true);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!(await isValidAssetIndex(context, i))) continue;
      if (!(await isTriviallySourceable(context, i, getConfigForScenario(context).transferCollateral))) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const transferAmount = BigInt(getConfigForScenario(context).transferCollateral) * scale;

      log(`TransferFrom reverts when collateral asset ${i} is deactivated`);

      // Source collateral asset
      await context.sourceTokens(transferAmount, collateralAsset.address, albert.address);

      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);

      // Supply collateral
      await comet.connect(albert.signer).supply(collateralAsset.address, transferAmount);

      // Deactivate collateral asset
      await cometExt.connect(pauseGuardian.signer).deactivateCollateral(i);

      await expectRevertCustom(
        comet
          .connect(betty.signer)
          .transferAssetFrom(albert.address, charles.address, collateralAsset.address, transferAmount),
        `CollateralAssetTransferPaused(${i})`
      );

      // Activate collateral asset
      await cometExt.connect(pauseGuardian.signer).activateCollateral(i);

      log(`TransferFrom is allowed when collateral asset ${i} is activated`);

      // Save balances
      const albertBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const charlesBalanceBefore = await comet.collateralBalanceOf(charles.address, collateralAsset.address);

      await comet
        .connect(betty.signer)
        .transferAssetFrom(albert.address, charles.address, collateralAsset.address, transferAmount);

      // Get balances after transfer
      const albertBalanceAfter = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const charlesBalanceAfter = await comet.collateralBalanceOf(charles.address, collateralAsset.address);

      // Assert balances after transfer
      expect(albertBalanceAfter).to.be.equal(albertBalanceBefore.toBigInt() - transferAmount);
      expect(charlesBalanceAfter).to.be.equal(charlesBalanceBefore.toBigInt() + transferAmount);
    }
  }
);

scenario(
  'Comet#transfer > reverts when collateral asset is deactivated and allows to transfer when activated',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!(await isValidAssetIndex(context, i))) continue;
      if (!(await isTriviallySourceable(context, i, getConfigForScenario(context).transferCollateral))) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const transferAmount = BigInt(getConfigForScenario(context).transferCollateral) * scale;

      log(`Transfer reverts when collateral asset ${i} is deactivated`);

      // Source collateral asset
      await context.sourceTokens(transferAmount, collateralAsset.address, albert.address);

      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);

      // Supply collateral
      await comet.connect(albert.signer).supply(collateralAsset.address, transferAmount);

      // Deactivate collateral asset
      await cometExt.connect(pauseGuardian.signer).deactivateCollateral(i);

      await expectRevertCustom(
        comet.connect(albert.signer).transferAsset(betty.address, collateralAsset.address, transferAmount),
        `CollateralAssetTransferPaused(${i})`
      );

      // Activate collateral asset
      await cometExt.connect(pauseGuardian.signer).activateCollateral(i);

      log(`Transfer is allowed when collateral asset ${i} is activated`);

      // Save balances
      const albertBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceBefore = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      await comet.connect(albert.signer).transferAsset(betty.address, collateralAsset.address, transferAmount);

      // Get balances after transfer
      const albertBalanceAfter = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceAfter = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      // Assert balances after transfer
      expect(albertBalanceAfter).to.be.equal(albertBalanceBefore.toBigInt() - transferAmount);
      expect(bettyBalanceAfter).to.be.equal(bettyBalanceBefore.toBigInt() + transferAmount);
    }
  }
);
