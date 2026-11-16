import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import {
  expectBase,
  hasMinBorrowGreaterThanOne,
  isTriviallySourceable,
  isValidAssetIndex,
  MAX_ASSETS,
  fundAccount,
  usesAssetList,
  isAssetDelisted,
  supportsExtendedPause,
  getExpectedBaseBalance,
  presentValueSupply,
  presentValueBorrow,
  getUsableCollateralIndices,
  getMinimumBorrowAmounts,
  deployUnsupportedAsset,
  servicePatch
} from './utils';
import { getConfigForScenario } from './utils/scenarioHelper';
import { log } from 'console';
import { exp, factorScale } from '../test/helpers';

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

    const fromUserBaseBalance = (await comet.balanceOf(albert.address)).toBigInt();
    const fromUserPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
    const dstUserPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();
    const amountToTransfer = fromUserBaseBalance / 2n;

    const txn = await comet
      .connect(albert.signer)
      .transfer(betty.address, amountToTransfer)
      .then((tx) => tx.wait());

    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();

    expectBase(
      (await comet.balanceOf(albert.address)).toBigInt(),
      getExpectedBaseBalance(
        presentValueSupply(fromUserPrincipal, baseSupplyIndex, baseIndexScale) - amountToTransfer,
        baseIndexScale,
        baseSupplyIndex
      )
    );
    expectBase(
      (await comet.balanceOf(betty.address)).toBigInt(),
      getExpectedBaseBalance(
        presentValueSupply(dstUserPrincipal, baseSupplyIndex, baseIndexScale) + amountToTransfer,
        baseIndexScale,
        baseSupplyIndex
      )
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

    const fromUserBaseBalance = (await comet.balanceOf(albert.address)).toBigInt();
    const fromUserPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
    const dstUserPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();
    const amountToTransfer = fromUserBaseBalance / 2n;

    const txn = await comet
      .connect(charles.signer)
      .transferFrom(albert.address, betty.address, amountToTransfer)
      .then((tx) => tx.wait());

    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();

    expectBase(
      (await comet.balanceOf(albert.address)).toBigInt(),
      getExpectedBaseBalance(
        presentValueSupply(fromUserPrincipal, baseSupplyIndex, baseIndexScale) - amountToTransfer,
        baseIndexScale,
        baseSupplyIndex
      )
    );
    expectBase(
      (await comet.balanceOf(betty.address)).toBigInt(),
      getExpectedBaseBalance(
        presentValueSupply(dstUserPrincipal, baseSupplyIndex, baseIndexScale) + amountToTransfer,
        baseIndexScale,
        baseSupplyIndex
      )
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

    const fromUserBaseBalance = (await comet.balanceOf(albert.address)).toBigInt();
    const fromUserPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
    const dstUserPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();
    const amountToTransfer = fromUserBaseBalance / 2n;

    const txn = await comet
      .connect(albert.signer)
      .transferAsset(betty.address, baseAssetAddress, amountToTransfer)
      .then((tx) => tx.wait());

    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();

    expectBase(
      (await comet.balanceOf(albert.address)).toBigInt(),
      getExpectedBaseBalance(
        presentValueSupply(fromUserPrincipal, baseSupplyIndex, baseIndexScale) - amountToTransfer,
        baseIndexScale,
        baseSupplyIndex
      )
    );
    expectBase(
      (await comet.balanceOf(betty.address)).toBigInt(),
      getExpectedBaseBalance(
        presentValueSupply(dstUserPrincipal, baseSupplyIndex, baseIndexScale) + amountToTransfer,
        baseIndexScale,
        baseSupplyIndex
      )
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

    const fromUserBaseBalance = (await comet.balanceOf(albert.address)).toBigInt();
    const fromUserPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
    const dstUserPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();
    const amountToTransfer = fromUserBaseBalance / 2n;

    const txn = await comet
      .connect(charles.signer)
      .transferAssetFrom(albert.address, betty.address, baseAssetAddress, amountToTransfer)
      .then((tx) => tx.wait());

    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();

    expectBase(
      (await comet.balanceOf(albert.address)).toBigInt(),
      getExpectedBaseBalance(
        presentValueSupply(fromUserPrincipal, baseSupplyIndex, baseIndexScale) - amountToTransfer,
        baseIndexScale,
        baseSupplyIndex
      )
    );
    expectBase(
      (await comet.balanceOf(betty.address)).toBigInt(),
      getExpectedBaseBalance(
        presentValueSupply(dstUserPrincipal, baseSupplyIndex, baseIndexScale) + amountToTransfer,
        baseIndexScale,
        baseSupplyIndex
      )
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
  async ({ comet, actors }) => {
    const { albert, betty } = actors;
    // Cache pre-transfer balances
    const { totalSupplyBase: oldTotalSupply, totalBorrowBase: oldTotalBorrow } = await comet.totalsBasic();
    const oldAlbertPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
    const oldBettyPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();

    // Albert transfers 50 units of collateral to Betty
    const amountToTransfer = 50n * (await comet.baseScale()).toBigInt();
    const txn = await comet
      .connect(albert.signer)
      .transferAsset(betty.address, await comet.baseToken(), amountToTransfer)
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

// One scenario per collateral slot; each runs only when that slot holds a usable collateral on the current market
for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#transfer > partial withdraw / borrow base to partial repay / supply, collateral asset ${offset}`,
    {
      filter: async (ctx: CometContext) => (await getUsableCollateralIndices(ctx)).includes(offset)
    },
    async ({ comet, actors }, context) => {
      const { albert, betty } = actors;
      const baseAsset = context.getAssetByAddress(await comet.baseToken());
      const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
      const { collateralAsset, supplyAmount, borrowAmount } = await getMinimumBorrowAmounts(context, offset);

      // Betty borrows against the collateral in this scenario's slot
      await context.sourceTokens(supplyAmount, collateralAsset.address, betty.address);
      await collateralAsset.approve(betty, comet.address);
      await betty.safeSupplyAsset({ asset: collateralAsset.address, amount: supplyAmount });

      // Give the protocol enough base liquidity to pay out the borrow
      await context.sourceTokens(borrowAmount, baseAsset.address, comet.address);

      expect(await comet.borrowBalanceOf(betty.address)).to.equal(0n);
      await betty.withdrawAsset({ asset: baseAsset.address, amount: borrowAmount });

      // Betty had no debt, so her borrow balance is the amount borrowed. Comet stores the debt rounded up
      // and reads it back rounded down, which can add 1 wei, so allow for that
      expectBase((await comet.borrowBalanceOf(betty.address)).toBigInt(), borrowAmount);

      // Albert will end up borrowing half again the amount, so he supplies half again the collateral to back it
      await context.sourceTokens((supplyAmount * 3n) / 2n, collateralAsset.address, albert.address);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAsset.address, amount: (supplyAmount * 3n) / 2n });

      // Albert supplies the same amount of base
      await context.sourceTokens(borrowAmount, baseAsset.address, albert.address);
      await baseAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: baseAsset.address, amount: borrowAmount });

      // Albert had nothing supplied, so his balance is the amount supplied. Comet stores the supply rounded down
      // and reads it back rounded down, which can lose a couple of wei, so allow for that
      expectBase((await comet.balanceOf(albert.address)).toBigInt(), borrowAmount);

      // Read the principals before the transfer. The transfer accrues interest before it moves anything, so the
      // expected balances apply the indexes from after it to these principals.
      const albertPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
      const bettyPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();

      // Albert with a supply transfers two and a half times it to Betty with a debt
      const amountToTransfer = (borrowAmount * 5n) / 2n;
      const txn = await comet
        .connect(albert.signer)
        .transfer(betty.address, amountToTransfer)
        .then((tx) => tx.wait());

      const { baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const albertSupplyAtTx = presentValueSupply(albertPrincipal, baseSupplyIndex.toBigInt(), baseIndexScale);
      const bettyDebtAtTx = presentValueBorrow(bettyPrincipal, baseBorrowIndex.toBigInt(), baseIndexScale);

      // Albert's supply is used up and the rest becomes his debt; Betty's debt is paid off and the rest becomes
      // her supply. Each side goes through Comet's rounding once more, so allow a couple of wei.
      expectBase((await comet.borrowBalanceOf(albert.address)).toBigInt(), amountToTransfer - albertSupplyAtTx);
      expectBase((await comet.balanceOf(betty.address)).toBigInt(), amountToTransfer - bettyDebtAtTx);

      return txn; // return txn to measure gas
    }
  );
}

for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#transferFrom > withdraw to repay, collateral asset ${offset}`,
    {
      filter: async (ctx: CometContext) => (await getUsableCollateralIndices(ctx)).includes(offset)
    },
    async ({ comet, actors }, context) => {
      const { albert, betty } = actors;
      const baseAsset = context.getAssetByAddress(await comet.baseToken());
      const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
      const { collateralAsset, supplyAmount, borrowAmount } = await getMinimumBorrowAmounts(context, offset);

      // Betty borrows against the collateral in this scenario's slot
      await context.sourceTokens(supplyAmount, collateralAsset.address, betty.address);
      await collateralAsset.approve(betty, comet.address);
      await betty.safeSupplyAsset({ asset: collateralAsset.address, amount: supplyAmount });

      // Give the protocol enough base liquidity to pay out the borrow
      await context.sourceTokens(borrowAmount, baseAsset.address, comet.address);

      expect(await comet.borrowBalanceOf(betty.address)).to.equal(0n);
      await betty.withdrawAsset({ asset: baseAsset.address, amount: borrowAmount });

      // Betty had no debt, so her borrow balance is the amount borrowed. Comet stores the debt rounded up
      // and reads it back rounded down, which can add 1 wei, so allow for that
      expectBase((await comet.borrowBalanceOf(betty.address)).toBigInt(), borrowAmount);

      // Albert supplies the same amount of base
      await context.sourceTokens(borrowAmount, baseAsset.address, albert.address);
      await baseAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: baseAsset.address, amount: borrowAmount });

      // Albert had nothing supplied, so his balance is the amount supplied. Comet stores the supply rounded down
      // and reads it back rounded down, which can lose a couple of wei, so allow for that
      expectBase((await comet.balanceOf(albert.address)).toBigInt(), borrowAmount);

      await albert.allow(betty, true);

      // Read the principals before the transfer. The transfer accrues interest before it moves anything, so the
      // expected balances apply the indexes from after it to these principals.
      const albertPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
      const bettyPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();

      // Betty moves half of Albert's supply to herself to repay half her debt
      const amountToTransfer = borrowAmount / 2n;
      const txn = await comet
        .connect(betty.signer)
        .transferFrom(albert.address, betty.address, amountToTransfer)
        .then((tx) => tx.wait());

      const { baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const albertSupplyAtTx = presentValueSupply(albertPrincipal, baseSupplyIndex.toBigInt(), baseIndexScale);
      const bettyDebtAtTx = presentValueBorrow(bettyPrincipal, baseBorrowIndex.toBigInt(), baseIndexScale);

      // Both balances shrink by the amount moved. Each side goes through Comet's rounding once more,
      // so allow a couple of wei.
      expectBase((await comet.balanceOf(albert.address)).toBigInt(), albertSupplyAtTx - amountToTransfer);
      expectBase((await comet.borrowBalanceOf(betty.address)).toBigInt(), bettyDebtAtTx - amountToTransfer);

      return txn; // return txn to measure gas
    }
  );
}

for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#transferAsset > base reverts if undercollateralized, collateral asset ${offset}`,
    {
      filter: async (ctx: CometContext) => (await getUsableCollateralIndices(ctx)).includes(offset)
    },
    async ({ comet, actors }, context) => {
      const { albert, betty } = actors;
      const baseAsset = context.getAssetByAddress(await comet.baseToken());
      const { collateralAsset, supplyAmount, borrowAmount } = await getMinimumBorrowAmounts(context, offset);

      // Betty borrows against the collateral in this scenario's slot
      await context.sourceTokens(supplyAmount, collateralAsset.address, betty.address);
      await collateralAsset.approve(betty, comet.address);
      await betty.safeSupplyAsset({ asset: collateralAsset.address, amount: supplyAmount });

      // Give the protocol enough base liquidity to pay out the borrow
      await context.sourceTokens(borrowAmount, baseAsset.address, comet.address);

      expect(await comet.borrowBalanceOf(betty.address)).to.equal(0n);
      await betty.withdrawAsset({ asset: baseAsset.address, amount: borrowAmount });

      // Betty had no debt, so her borrow balance is the amount borrowed. Comet stores the debt rounded up
      // and reads it back rounded down, which can add 1 wei, so allow for that
      expectBase((await comet.borrowBalanceOf(betty.address)).toBigInt(), borrowAmount);

      // Albert backs only a tenth of the borrow he is about to take on
      await context.sourceTokens(supplyAmount / 10n, collateralAsset.address, albert.address);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAsset.address, amount: supplyAmount / 10n });

      // Albert supplies the same amount of base
      await context.sourceTokens(borrowAmount, baseAsset.address, albert.address);
      await baseAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: baseAsset.address, amount: borrowAmount });

      // Albert had nothing supplied, so his balance is the amount supplied. Comet stores the supply rounded down
      // and reads it back rounded down, which can lose a couple of wei, so allow for that
      expectBase((await comet.balanceOf(albert.address)).toBigInt(), borrowAmount);

      // Transferring twice his supply leaves Albert with a debt his collateral cannot back
      await expect(
        comet.connect(albert.signer).transferAsset(betty.address, baseAsset.address, 2n * borrowAmount)
      ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
    }
  );
}

for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#transferAssetFrom > base reverts if undercollateralized, collateral asset ${offset}`,
    {
      filter: async (ctx: CometContext) => (await getUsableCollateralIndices(ctx)).includes(offset)
    },
    async ({ comet, actors }, context) => {
      const { albert, betty } = actors;
      const baseAsset = context.getAssetByAddress(await comet.baseToken());
      const { collateralAsset, supplyAmount, borrowAmount } = await getMinimumBorrowAmounts(context, offset);

      // Betty borrows against the collateral in this scenario's slot
      await context.sourceTokens(supplyAmount, collateralAsset.address, betty.address);
      await collateralAsset.approve(betty, comet.address);
      await betty.safeSupplyAsset({ asset: collateralAsset.address, amount: supplyAmount });

      // Give the protocol enough base liquidity to pay out the borrow
      await context.sourceTokens(borrowAmount, baseAsset.address, comet.address);

      expect(await comet.borrowBalanceOf(betty.address)).to.equal(0n);
      await betty.withdrawAsset({ asset: baseAsset.address, amount: borrowAmount });

      // Betty had no debt, so her borrow balance is the amount borrowed. Comet stores the debt rounded up
      // and reads it back rounded down, which can add 1 wei, so allow for that
      expectBase((await comet.borrowBalanceOf(betty.address)).toBigInt(), borrowAmount);

      // Albert backs only a tenth of the borrow he is about to take on
      await context.sourceTokens(supplyAmount / 10n, collateralAsset.address, albert.address);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAsset.address, amount: supplyAmount / 10n });

      // Albert supplies the same amount of base
      await context.sourceTokens(borrowAmount, baseAsset.address, albert.address);
      await baseAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: baseAsset.address, amount: borrowAmount });

      // Albert had nothing supplied, so his balance is the amount supplied. Comet stores the supply rounded down
      // and reads it back rounded down, which can lose a couple of wei, so allow for that
      expectBase((await comet.balanceOf(albert.address)).toBigInt(), borrowAmount);

      await albert.allow(betty, true);

      // Transferring twice his supply leaves Albert with a debt his collateral cannot back
      await expect(
        comet.connect(betty.signer).transferAssetFrom(albert.address, betty.address, baseAsset.address, 2n * borrowAmount)
      ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
    }
  );
}

scenario(
  'Comet#transferAssetFrom > collateral asset reverts if src would be undercollateralized',
  {},
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;
    // The actors' signers belong to this deployment manager. World._revert swaps in a fork that does not
    // hold them, so their nonce counts have to be reset through this reference.
    const dm = world.deploymentManager;

    const baseToken = context.getAssetByAddress(await comet.baseToken());
    const baseScale = (await comet.baseScale()).toBigInt();
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const borrowAmount = 2n * (await comet.baseBorrowMin()).toBigInt();

    // Allow betty to transfer collateral on behalf of albert
    await albert.allow(betty, true);

    // Every asset starts from this state
    let snapshot = await world._snapshot();

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!(await isValidAssetIndex(context, i))) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, priceFeed, scale: scaleBN, borrowCollateralFactor } = await comet.getAssetInfo(i);
      // Nothing can be borrowed against collateral with a zero borrow collateral factor
      if (borrowCollateralFactor.isZero()) continue;

      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const assetPrice = (await comet.getPrice(priceFeed)).toBigInt();

      // The borrow principal is rounded up, so the debt can exceed the borrowed amount by up to
      // baseBorrowIndex / baseIndexScale wei. Every step rounds up so the collateral always covers the debt.
      const maxDebt = borrowAmount + (await comet.totalsBasic()).baseBorrowIndex.toBigInt() / baseIndexScale + 1n;
      const debtValue = (maxDebt * basePrice + baseScale - 1n) / baseScale;
      const collateralValue = (debtValue * factorScale + borrowCollateralFactor.toBigInt() - 1n) / borrowCollateralFactor.toBigInt();
      const collateralAmount = (collateralValue * scale + assetPrice - 1n) / assetPrice;

      if (!(await isTriviallySourceable(context, i, Number(collateralAmount / scale + 1n)))) continue;

      log(`TransferAssetFrom reverts when moving all collateral asset ${i} would leave the borrow undercollateralized`);

      // Supply just enough collateral to back the borrow
      await context.sourceTokens(collateralAmount, collateralAsset.address, albert.address);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAsset.address, amount: collateralAmount });

      // Give the protocol liquidity for the borrow, then borrow against the collateral
      await context.sourceTokens(borrowAmount, baseToken.address, comet.address);
      await comet.connect(albert.signer).withdraw(baseToken.address, borrowAmount);

      const fullCollateral = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      await expect(
        comet.connect(betty.signer).transferAssetFrom(albert.address, betty.address, collateralAsset.address, fullCollateral)
      ).to.be.revertedWithCustomError(comet, 'NotCollateralized');

      // Drop albert's position so its collateral cannot back the next asset's borrow.
      // Hardhat deletes a snapshot once it is reverted to, so a fresh one is taken for the next asset.
      snapshot = await world._revertAndSnapshot(snapshot);
      // The revert does not rewind the pending nonce counts the signers keep, so reset them
      await dm.resetSignersPendingCounts();
    }
  }
);

// One scenario per collateral slot; each runs only when that slot holds a usable collateral on the current market
for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#transferAsset > collateral asset ${offset} reverts if undercollateralized`,
    {
      filter: async (ctx: CometContext) => (await getUsableCollateralIndices(ctx)).includes(offset)
    },
    async ({ comet, actors }, context) => {
      const { albert, betty } = actors;
      const baseAsset = context.getAssetByAddress(await comet.baseToken());
      const { collateralAsset, supplyAmount, borrowAmount } = await getMinimumBorrowAmounts(context, offset);

      // Albert borrows against the collateral in this scenario's slot
      await context.sourceTokens(supplyAmount, collateralAsset.address, albert.address);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAsset.address, amount: supplyAmount });

      // Give the protocol enough base liquidity to pay out the borrow
      await context.sourceTokens(borrowAmount, baseAsset.address, comet.address);

      expect(await comet.borrowBalanceOf(albert.address)).to.equal(0n);
      await albert.withdrawAsset({ asset: baseAsset.address, amount: borrowAmount });

      // Albert had no debt, so his borrow balance is the amount borrowed. Comet stores the debt rounded up
      // and reads it back rounded down, which can add 1 wei, so allow for that
      expectBase((await comet.borrowBalanceOf(albert.address)).toBigInt(), borrowAmount);

      // Moving out all the collateral leaves the borrow with nothing backing it
      const amountToTransfer = await albert.getCometCollateralBalance(collateralAsset.address);

      await expect(
        comet.connect(albert.signer).transferAsset(betty.address, collateralAsset.address, amountToTransfer)
      ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
    }
  );
}

for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#transferAssetFrom > collateral asset ${offset} reverts if undercollateralized`,
    {
      filter: async (ctx: CometContext) => (await getUsableCollateralIndices(ctx)).includes(offset)
    },
    async ({ comet, actors }, context) => {
      const { albert, betty } = actors;
      const baseAsset = context.getAssetByAddress(await comet.baseToken());
      const { collateralAsset, supplyAmount, borrowAmount } = await getMinimumBorrowAmounts(context, offset);

      // Albert borrows against the collateral in this scenario's slot
      await context.sourceTokens(supplyAmount, collateralAsset.address, albert.address);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAsset.address, amount: supplyAmount });

      // Give the protocol enough base liquidity to pay out the borrow
      await context.sourceTokens(borrowAmount, baseAsset.address, comet.address);

      expect(await comet.borrowBalanceOf(albert.address)).to.equal(0n);
      await albert.withdrawAsset({ asset: baseAsset.address, amount: borrowAmount });

      // Albert had no debt, so his borrow balance is the amount borrowed. Comet stores the debt rounded up
      // and reads it back rounded down, which can add 1 wei, so allow for that
      expectBase((await comet.borrowBalanceOf(albert.address)).toBigInt(), borrowAmount);

      // Moving out all the collateral leaves the borrow with nothing backing it
      const amountToTransfer = await albert.getCometCollateralBalance(collateralAsset.address);

      await albert.allow(betty, true);

      // Betty moves all of Albert's collateral to herself
      await expect(
        comet.connect(betty.signer).transferAssetFrom(albert.address, betty.address, collateralAsset.address, amountToTransfer)
      ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
    }
  );
}

scenario('Comet#transferAsset > disallows self-transfer of base', {}, async ({ comet, actors }) => {
  const { albert } = actors;

  const baseToken = await comet.baseToken();

  await expect(
    comet.connect(albert.signer).transferAsset(albert.address, baseToken, 100)
  ).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
});

scenario('Comet#transferAsset > disallows self-transfer of collateral', {}, async ({ comet, actors }) => {
  const { albert } = actors;

  const collateralAsset = await comet.getAssetInfo(0);

  await expect(
    comet.connect(albert.signer).transferAsset(albert.address, collateralAsset.asset, 100)
  ).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
});

scenario('Comet#transferFrom > disallows self-transfer of base', {}, async ({ comet, actors }) => {
  const { albert, betty } = actors;

  const baseToken = await comet.baseToken();

  await betty.allow(albert, true);

  await expect(
    comet.connect(albert.signer).transferAssetFrom(betty.address, betty.address, baseToken, 100)
  ).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
});

scenario('Comet#transferAssetFrom > disallows self-transfer of collateral', {}, async ({ comet, actors }) => {
  const { albert, betty } = actors;

  const collateralAsset = await comet.getAssetInfo(0);

  await betty.allow(albert, true);

  await expect(
    comet.connect(albert.signer).transferAssetFrom(betty.address, betty.address, collateralAsset.asset, 100)
  ).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
});

scenario(
  'Comet#transferAssetFrom > reverts if operator not given permission',
  {},
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await expect(
      comet.connect(betty.signer).transferAssetFrom(albert.address, betty.address, baseAsset.address, 1n * scale)
    ).to.be.revertedWithCustomError(comet, 'Unauthorized');
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

    await expect(comet.connect(albert.signer).transferAsset(betty.address, baseToken, 100)).to.be.revertedWithCustomError(comet, 'Paused');
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

    await expect(
      comet.connect(albert.signer).transferAssetFrom(betty.address, albert.address, baseToken, 100)
    ).to.be.revertedWithCustomError(comet, 'Paused');
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

    await expect(
      comet.connect(albert.signer).transfer(betty.address, amountToTransfer, { gasPrice: 0 })
    ).to.be.revertedWithCustomError(comet, 'BorrowTooSmall');
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

    await expect(
      comet.connect(albert.signer).transferAsset(betty.address, baseAssetAddress, amountToTransfer)
    ).to.be.revertedWithCustomError(comet, 'BorrowTooSmall');
  }
);

scenario(
  'Comet#transferAsset > reverts when collateral transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferCollateral) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await servicePatch(ctx);
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).transferCollateral }
    })
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause collateral transfer
    await comet.connect(pauseGuardian.signer).pauseCollateralTransfer(true);

    await expect(
      comet
        .connect(albert.signer)
        .transferAsset(
          betty.address,
          assetAddress,
          BigInt(getConfigForScenario(context).transferCollateral) * scaleBN.toBigInt()
        )
    ).to.be.revertedWithCustomError(comet, 'CollateralTransferPaused');
  }
);

scenario(
  'Comet#transferAssetFrom > reverts when collateral transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferCollateral) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await servicePatch(ctx);
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).transferCollateral }
    })
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty, charles, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const scale = scaleBN.toBigInt();

    await albert.allow(betty, true);
    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause collateral transfer
    await comet.connect(pauseGuardian.signer).pauseCollateralTransfer(true);

    await expect(
      comet
        .connect(betty.signer)
        .transferAssetFrom(
          albert.address,
          charles.address,
          collateralAsset.address,
          BigInt(getConfigForScenario(context).transferCollateral) * scale
        )
    ).to.be.revertedWithCustomError(comet, 'CollateralTransferPaused');
  }
);

scenario(
  'Comet#transfer > reverts when borrowers transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await servicePatch(ctx);
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
  async ({ comet, actors }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const scale = (await comet.baseScale()).toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause borrowers transfer
    await comet.connect(pauseGuardian.signer).pauseBorrowersTransfer(true);

    await expect(
      comet.connect(albert.signer).transfer(betty.address, BigInt(getConfigForScenario(context).transferBase) * scale)
    ).to.be.revertedWithCustomError(comet, 'BorrowersTransferPaused');
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
  async ({ comet, actors }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const scale = (await comet.baseScale()).toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause borrowers transfer
    await comet.connect(pauseGuardian.signer).pauseBorrowersTransfer(true);

    await expect(
      comet
        .connect(albert.signer)
        .transferAsset(betty.address, baseAssetAddress, BigInt(getConfigForScenario(context).transferBase) * scale)
    ).to.be.revertedWithCustomError(comet, 'BorrowersTransferPaused');
  }
);

scenario(
  'Comet#transferFrom > reverts when borrowers transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await servicePatch(ctx);
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $base: '== 0' },
      $comet: { $base: getConfigForScenario(ctx).transferBase }
    }),
    cometBalances: async (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).transferAsset }
    })
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const scale = (await comet.baseScale()).toBigInt();

    await albert.allow(betty, true);
    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause borrowers transfer
    await comet.connect(pauseGuardian.signer).pauseBorrowersTransfer(true);

    await expect(
      comet
        .connect(betty.signer)
        .transferFrom(albert.address, betty.address, BigInt(getConfigForScenario(context).transferBase) * scale)
    ).to.be.revertedWithCustomError(comet, 'BorrowersTransferPaused');
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
  async ({ comet, actors }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const scale = (await comet.baseScale()).toBigInt();

    await albert.allow(betty, true);
    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause borrowers transfer
    await comet.connect(pauseGuardian.signer).pauseBorrowersTransfer(true);

    await expect(
      comet
        .connect(betty.signer)
        .transferAssetFrom(
          albert.address,
          betty.address,
          baseAssetAddress,
          BigInt(getConfigForScenario(context).transferBase) * scale
        )
    ).to.be.revertedWithCustomError(comet, 'BorrowersTransferPaused');
  }
);

scenario(
  'Comet#transfer > reverts when lenders transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await servicePatch(ctx);
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase }
    })
  },
  async ({ comet, actors }, _context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause lenders transfer
    await comet.connect(pauseGuardian.signer).pauseLendersTransfer(true);

    await expect(
      comet.connect(albert.signer).transfer(betty.address, baseSupplied)
    ).to.be.revertedWithCustomError(comet, 'LendersTransferPaused');
  }
);

scenario(
  'Comet#transferAsset > reverts when lenders transfer is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await servicePatch(ctx);
    },
    cometBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase }
    })
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause lenders transfer
    await comet.connect(pauseGuardian.signer).pauseLendersTransfer(true);

    await expect(
      comet.connect(albert.signer).transferAsset(betty.address, baseAsset.address, baseSupplied)
    ).to.be.revertedWithCustomError(comet, 'LendersTransferPaused');
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
  async ({ comet, actors }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    await albert.allow(betty, true);

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause lenders transfer
    await comet.connect(pauseGuardian.signer).pauseLendersTransfer(true);

    await expect(
      comet.connect(betty.signer).transferAssetFrom(albert.address, betty.address, baseAsset.address, baseSupplied)
    ).to.be.revertedWithCustomError(comet, 'LendersTransferPaused');
  }
);

scenario(
  'Comet#transferAsset > reverts when specific collateral asset is paused',
  {
    filter: async (ctx: CometContext) => {
      return await isValidAssetIndex(ctx, 0) &&
      await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferCollateral) &&
      await usesAssetList(ctx) &&
      !(await isAssetDelisted(ctx, 0)) &&
      await servicePatch(ctx);
    },
    cometBalances: (ctx: CometContext) => ({
      albert: {
        $asset0: getConfigForScenario(ctx).transferCollateral
      }
    })
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const offset = 0;
    const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(offset);
    const collateralAsset = context.getAssetByAddress(assetAddress);
    const scale = scaleBN.toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause only asset0 transfer
    await comet.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(0, true);

    // Asset0 transfer should revert
    await expect(
      comet
        .connect(albert.signer)
        .transferAsset(
          betty.address,
          collateralAsset.address,
          BigInt(getConfigForScenario(context).transferCollateral) * scale
        )
    ).to.be.revertedWithCustomError(comet, 'CollateralAssetTransferPaused').withArgs(0);
  }
);

scenario(
  'Comet#transferAssetFrom > reverts when specific collateral asset is paused',
  {
    filter: async (ctx: CometContext) => {
      return await usesAssetList(ctx) && await servicePatch(ctx);
    },
    cometBalances: (ctx: CometContext) => ({
      albert: {
        $asset0: getConfigForScenario(ctx).transferCollateral
      }
    })
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const offset = 0;
    const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(offset);
    const collateralAsset = context.getAssetByAddress(assetAddress);
    const scale = scaleBN.toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause only asset0 transfer
    await comet.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(offset, true);

    await albert.allow(betty, true);

    // Asset0 transfer should revert
    await expect(
      comet
        .connect(betty.signer)
        .transferAssetFrom(
          albert.address,
          betty.address,
          collateralAsset.address,
          BigInt(getConfigForScenario(context).transferCollateral) * scale
        )
    ).to.be.revertedWithCustomError(comet, 'CollateralAssetTransferPaused').withArgs(offset);
  }
);

scenario(
  'Comet#transferAsset > reverts when collateral asset transfer is paused and allows to transfer when unpaused',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    const priceScale = (await comet.priceScale()).toBigInt();

    for (const i of await getUsableCollateralIndices(context)) {
      const { asset: assetAddress, scale: scaleBN, priceFeed } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(assetAddress);
      const scale = scaleBN.toBigInt();
      const price = (await comet.getPrice(priceFeed)).toBigInt();

      // Supply and transfer $100 worth of the collateral, whatever the token and its price
      const transferCollateral = (100n * priceScale * scale) / price;
      if (!await isTriviallySourceable(context, i, Number(transferCollateral / scale) + 1)) continue;

      log(`Transferring reverts when collateral asset ${i} transfer is paused`);

      // Source collateral asset
      await context.sourceTokens(transferCollateral, collateralAsset.address, albert.address);

      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);

      // Supply collateral asset
      await albert.safeSupplyAsset({asset: collateralAsset.address, amount: transferCollateral});

      // Pause specific collateral asset transfer at index i
      await comet.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(i, true);

      await expect(
        comet.connect(albert.signer).transferAsset(betty.address, collateralAsset.address, transferCollateral)
      ).to.be.revertedWithCustomError(comet, 'CollateralAssetTransferPaused').withArgs(i);

      log(`Transferring is allowed when collateral asset ${i} transfer is unpaused`);

      // Unpause specific collateral asset transfer at index i
      await comet.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(i, false);

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
      return await usesAssetList(ctx) && await servicePatch(ctx);
    },
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    const priceScale = (await comet.priceScale()).toBigInt();

    for (const i of await getUsableCollateralIndices(context)) {
      const { asset: assetAddress, scale: scaleBN, priceFeed } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(assetAddress);
      const scale = scaleBN.toBigInt();
      const price = (await comet.getPrice(priceFeed)).toBigInt();

      // Supply and transfer $100 worth of the collateral, whatever the token and its price
      const transferCollateral = (100n * priceScale * scale) / price;
      if (!await isTriviallySourceable(context, i, Number(transferCollateral / scale) + 1)) continue;

      log(`Transferring reverts when collateral asset ${i} transfer is paused`);

      // Source collateral asset
      await context.sourceTokens(transferCollateral, collateralAsset.address, albert.address);

      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);

      // Supply collateral asset
      await albert.safeSupplyAsset({asset: collateralAsset.address, amount: transferCollateral});

      // Pause specific collateral asset transfer at index i
      await comet.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(i, true);

      // Allow betty to transfer asset from albert
      await albert.allow(betty, true);

      await expect(
        comet
          .connect(betty.signer)
          .transferAssetFrom(albert.address, betty.address, collateralAsset.address, transferCollateral)
      ).to.be.revertedWithCustomError(comet, 'CollateralAssetTransferPaused').withArgs(i);

      log(`Transferring is allowed when collateral asset ${i} transfer is unpaused`);

      // Unpause specific collateral asset transfer at index i
      await comet.connect(pauseGuardian.signer).pauseCollateralAssetTransfer(i, false);

      // Save balances
      const albertBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const bettyBalanceBefore = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      // Transfer asset from albert to betty
      await comet
        .connect(betty.signer)
        .transferAssetFrom(albert.address, betty.address, collateralAsset.address, transferCollateral);

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

  const unregisteredAsset = await deployUnsupportedAsset(context);
  const collateralAmount = exp(getConfigForScenario(context).transferCollateral, await unregisteredAsset.decimals());

  // NOTE: with the current contract implementation it is impossible to get BadAsset()
  // due to the order of operations, the transaction reverts with a different error
  // before the asset validity check is reached.
  // await expect(
  //   comet.connect(albert.signer).transferAsset(betty.address, unregisteredAsset.address, collateralAmount)
  // ).to.be.revertedWithCustomError(comet, 'BadAsset');

  await expect(
    comet.connect(albert.signer).transferAsset(betty.address, unregisteredAsset.address, collateralAmount)
  ).to.be.revertedWithPanic(0x11); // everted with panic code 0x11 - arithmetic operation underflowed
});

scenario('Comet#transferAssetFrom > reverts on unregistered asset', {}, async ({ actors, comet }, context) => {
  const { albert, betty } = actors;

  const unregisteredAsset = await deployUnsupportedAsset(context);
  const collateralAmount = exp(getConfigForScenario(context).transferCollateral, await unregisteredAsset.decimals());

  await albert.allow(betty, true);

  // NOTE: with the current contract implementation it is impossible to get BadAsset()
  // due to the order of operations, the transaction reverts with a different error
  // before the asset validity check is reached.
  // await expect(
  //   comet
  //     .connect(betty.signer)
  //     .transferAssetFrom(albert.address, betty.address, unregisteredAsset.address, collateralAmount)
  // ).to.be.revertedWithCustomError(comet, 'BadAsset');

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
      return await usesAssetList(ctx) && await servicePatch(ctx);
    },
  },
  async ({ comet, actors }, context, world) => {
    const { admin, albert, betty, charles, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, admin);
    await fundAccount(world, pauseGuardian);

    // Allow betty to act on behalf of albert
    await albert.allow(betty, true);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!await isValidAssetIndex(context, i)) continue;
      if (!await isTriviallySourceable(context, i, getConfigForScenario(context, i).transferCollateral)) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const transferAmount = BigInt(getConfigForScenario(context, i).transferCollateral) * scale;

      log(`TransferFrom reverts when collateral asset ${i} is deactivated`);

      // Source collateral asset
      await context.sourceTokens(transferAmount, collateralAsset.address, albert.address);

      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);

      // Supply collateral
      await albert.safeSupplyAsset({asset: collateralAsset.address, amount: transferAmount});

      // Deactivate collateral asset
      await comet.connect(pauseGuardian.signer).deactivateCollateral(i);

      await expect(
        comet
          .connect(betty.signer)
          .transferAssetFrom(albert.address, charles.address, collateralAsset.address, transferAmount)
      ).to.be.revertedWithCustomError(comet, 'CollateralAssetTransferPaused').withArgs(i);

      // Activate collateral asset
      await comet.connect(admin.signer).activateCollateral(i);

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
      return await usesAssetList(ctx) && await servicePatch(ctx);
    },
  },
  async ({ comet, actors }, context, world) => {
    const { admin, albert, betty, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, admin);
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!await isValidAssetIndex(context, i)) continue;
      if (!await isTriviallySourceable(context, i, getConfigForScenario(context, i).transferCollateral)) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBN.toBigInt();
      const transferAmount = BigInt(getConfigForScenario(context, i).transferCollateral) * scale;

      log(`Transfer reverts when collateral asset ${i} is deactivated`);

      // Source collateral asset
      await context.sourceTokens(transferAmount, collateralAsset.address, albert.address);

      // Approve collateral asset
      await collateralAsset.approve(albert, comet.address);

      // Supply collateral
      await albert.safeSupplyAsset({asset: collateralAsset.address, amount: transferAmount});

      // Deactivate collateral asset
      await comet.connect(pauseGuardian.signer).deactivateCollateral(i);

      await expect(
        comet.connect(albert.signer).transferAsset(betty.address, collateralAsset.address, transferAmount)
      ).to.be.revertedWithCustomError(comet, 'CollateralAssetTransferPaused').withArgs(i);

      // Activate collateral asset
      await comet.connect(admin.signer).activateCollateral(i);

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
