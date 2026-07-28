import { scenario } from '../context/CometContext';
import { expect } from 'chai';
import {
  Entry,
  hasModule,
  configureModule,
  captureAbsorbStateBefore,
  makeCollateralStates,
  getAssetInfo,
  getUsableCollateralIndices,
  expectRevertCustom,
  TARGET_HF,
} from '../utils';
import { mulPrice, divPrice, mulFactor, factorScale } from '../../test/helpers';

/**
 * Absorb / liquidation end-state scenarios for the liquidation module.
 *
 * These mirror `test/liquidation-logic/absorb.test.ts` but run against forked deployments. Every
 * case is exercised across the two entry points and the two liquidation modes:
 *   - entry point:  Comet.absorb()          vs  LiquidationModule.liquidate()
 *   - mode:         default (partial)        vs  full debt close
 *
 * The shared filters, setup and assertions live in `scenario/utils/liquidationHelpers.ts`; the
 * module's `liquidate` path is driven with the DEX route paused, so it falls back to the pure
 * absorb flow (`_liquidate`) and no swap data is required — matching `viaLiquidationModule` in the
 * unit tests.
 */
function absorbScenarios(entry: Entry, partial: boolean) {
  const mode = partial ? 'default' : 'full-close';
  const tag = `entry=${entry}, mode=${mode}`;

  /*//////////////////////////////////////////////////////////////
                             HAPPY PATHS
  //////////////////////////////////////////////////////////////*/

  // 1 collateral: seized down to a surplus; debt fully closed.
  scenario(
    `Comet#absorb > 1 collateral: debt closed, surplus retained [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 1)).length === 1,
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

      // Use the first collateral usable for the liquidation math (all three factors positive).
      const [collateralIndex] = await getUsableCollateralIndices(context, 1);

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      // Freeze interest so the debt stays exactly where the borrow puts it — the price drop alone makes
      // the position liquidatable, and the seizure / reserve assertions below are exact, with no
      // intra-block accrual to reason about.
      await context.zeroBorrowRates();

      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const collateralPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();
      const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);

      // 1. Borrow 1.5× the minimum debt, so the debt sits just above the floor: a single partial seizure
      //    to restore the target health factor would drop the residual below baseBorrowMin, so the
      //    min-debt guard closes the debt in full instead — identically in both modes.
      const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const borrowAmount = (15n * baseBorrowMin + 9n) / 10n;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);

      // 2. Supply the collateral that borrow needs, with a 10% buffer, then borrow. Fund Comet with 2× the
      //    borrow straight to its balance — enough base liquidity with a buffer, no separate supplier.
      //      collateralValue = borrowValue / BCF * 1.10
      const minimumSuppliedValue = (borrowValue * factorScale + collateralAssetInfo.borrowCollateralFactor - 1n)
        / collateralAssetInfo.borrowCollateralFactor;
      const suppliedValue = (minimumSuppliedValue * 110n + 99n) / 100n;
      const collateralAmount = (suppliedValue * collateralAssetInfo.scale + collateralPrice - 1n) / collateralPrice;

      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });

      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 3. Drop the collateral price into the window where the debt still closes with a surplus but the
      //    partial-seizure guard fires (D is the debt, m the min debt, v the post-drop market value):
      //      lowerValue        = D / LF   the collateral's LF-weighted value covers the whole debt (surplus stays)
      //      liquidatableBound = D / LCF  above this the account is no longer liquidatable
      //      guardBound        = (targetHF*LF*m + (D - m)*BCF) / (BCF*LF)   below this, reducing the debt
      //                          to m still leaves the position short of targetHF, so no legal partial
      //                          stop exists and the guard closes the debt in full
      //    Take the midpoint of [lowerValue, min(liquidatableBound, guardBound)]: the account is
      //    liquidatable, the collateral still covers the debt, and the guard fires — a full close with a
      //    surplus in either mode.
      const debtValue = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
      const lowerValue = (debtValue * factorScale + collateralAssetInfo.liquidationFactor - 1n)
        / collateralAssetInfo.liquidationFactor;
      const liquidatableBound = (debtValue * factorScale) / collateralAssetInfo.liquidateCollateralFactor;
      const guardBound =
        (minDebtValue * TARGET_HF) / collateralAssetInfo.borrowCollateralFactor
        + ((debtValue - minDebtValue) * factorScale) / collateralAssetInfo.liquidationFactor;
      const upperValue = liquidatableBound < guardBound ? liquidatableBound : guardBound;
      const targetCollateralValue = (lowerValue + upperValue) / 2n;
      const droppedPrice = (targetCollateralValue * collateralAssetInfo.scale + collateralAmount - 1n)
        / collateralAmount;
      await context.changePriceFeeds({ [collateralAssetInfo.asset]: droppedPrice });

      // changePriceFeeds redeploys the liquidation module, so configure it only once the price is set.
      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // Sanity checks
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect((await comet.borrowBalanceOf(albert.address)).toBigInt()).to.be.greaterThan(baseBorrowMin);

      // 4. Capture the borrower's base state and the single collateral's state before the absorb.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);

      // 5. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 6. Capture the borrower's base state and the collateral's state after the absorb.
      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);

      // 7. Independently compute the expected seizure (mirrors _processDebtClosing full closure): the debt
      //    closes in full, so the protocol seizes exactly debt / LF worth of collateral, priced at the
      //    dropped collateral price. Borrow rates are zeroed, so no intra-block interest accrues and the
      //    debt re-derived from the captured principal is exactly what the seizure saw.
      //    debtValue   = debt * basePrice / baseScale                   (mulPrice)
      //    seizeAmount = (debtValue * FACTOR_SCALE / LF) / droppedPrice (divPrice by collateral price)
      const debtAtAbsorb = (await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      const debtRemainingValue = mulPrice(-debtAtAbsorb, basePrice, baseScale);
      collateralStateBefore.seizeAmount = divPrice(debtRemainingValue * factorScale / collateralAssetInfo.liquidationFactor, droppedPrice, collateralAssetInfo.scale);
      collateralStateBefore.seizedValue = mulPrice(collateralStateBefore.seizeAmount, droppedPrice, collateralAssetInfo.scale);
      // 8. Post-absorb checks.

      // Debt fully repaid: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // Collateral seized by the independently-computed amount, surplus retained.
      const remainingCollateral = collateralStateBefore.collateralBalance - collateralStateBefore.seizeAmount;
      expect(collateralStateAfter.collateralBalance).to.equal(remainingCollateral);
      expect(collateralStateAfter.userCollateral.balance).to.equal(remainingCollateral);

      // assetsIn keeps the collateral bit (surplus remains); reserved bits are untouched.
      expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
      expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: totals down by the seized amount, reserves up by it, ERC20 balances untouched.
      expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
      expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
      expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Closing the debt in full pays the borrower's (negative) base balance out of reserves, so
      // base reserves move by exactly that balance: reservesAfter = reservesBefore + userBalanceBefore.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      // The position is healthy again.
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
    }
  );

  // 2 collaterals: the first is fully seized, the second keeps the surplus; debt fully closed.
  scenario(
    `Comet#absorb > 2 collaterals: debt closed, surplus retained [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 2)).length === 2,
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

      // The first two collaterals usable for the liquidation math, in the order the absorb loop walks
      // them: [0] stays at its price and is fully seized, [1] is over-supplied, dropped into the guard
      // window, and keeps the surplus after closing the residual debt.
      const collateralIndexes = await getUsableCollateralIndices(context, 2);
      const collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
      const collateralPrices = await Promise.all(collateralInfos.map(async (info) => (await comet.getPrice(info.priceFeed)).toBigInt()));

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      // Freeze interest so the debt stays exactly where the borrow puts it — the price drop alone makes
      // the position liquidatable, and the seizure / reserve assertions below are exact.
      await context.zeroBorrowRates();

      // 1. Borrow 1.5× the minimum debt. Asset [0] is sized to retire a fixed 0.3× the min debt when fully
      //    seized, leaving a residual of 1.2× the min debt on asset [1] — still above the floor, so the
      //    last asset goes through the guard rather than the sub-min branch.
      const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const borrowAmount = (15n * baseBorrowMin + 9n) / 10n;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
      const firstAfterLF = (3n * minDebtValue + 9n) / 10n; // LF-weighted value asset [0] retires when drained

      // 2. Supply asset [0] small at its own price (fully seized below) and asset [1] over-supplied so the
      //    borrow is valid; asset [1]'s price is dropped onto the guard window afterwards.
      //      collateral0Value = firstAfterLF / LF0                 asset [0]'s market value
      //      collateral1Value = remaining borrow power / BCF1 * 1.10
      const collateral0Value = (firstAfterLF * factorScale + collateralInfos[0].liquidationFactor - 1n)
        / collateralInfos[0].liquidationFactor;
      const collateral0SupplyAmount = (collateral0Value * collateralInfos[0].scale + collateralPrices[0] - 1n)
        / collateralPrices[0];
      const collateral0Asset = context.getAssetByAddress(collateralInfos[0].asset);
      await context.sourceTokens(collateral0SupplyAmount, collateral0Asset, albert);
      await collateral0Asset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralInfos[0].asset, amount: collateral0SupplyAmount });

      const collateral0SuppliedValue = mulPrice(collateral0SupplyAmount, collateralPrices[0], collateralInfos[0].scale);
      const firstBorrowLiquidity = mulFactor(collateral0SuppliedValue, collateralInfos[0].borrowCollateralFactor);
      const minimumCollateral1Value = ((borrowValue - firstBorrowLiquidity) * factorScale + collateralInfos[1].borrowCollateralFactor - 1n)
        / collateralInfos[1].borrowCollateralFactor;
      const collateral1Value = (minimumCollateral1Value * 110n + 99n) / 100n;
      const collateral1SupplyAmount = (collateral1Value * collateralInfos[1].scale + collateralPrices[1] - 1n)
        / collateralPrices[1];
      const collateral1Asset = context.getAssetByAddress(collateralInfos[1].asset);
      await context.sourceTokens(collateral1SupplyAmount, collateral1Asset, albert);
      await collateral1Asset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralInfos[1].asset, amount: collateral1SupplyAmount });

      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 3. Read asset [0]'s actual supplied balance to size the drop from real state, then drop asset [1]'s
      //    price into the window where it covers the residual debt with a surplus while the guard fires
      //    (R = residual debt after [0], m the min debt, v = asset [1]'s value):
      //      lowerValue        = R / LF1                               the LF-weighted value covers the residual
      //      liquidatableBound = (debtValue - firstLiquidity) / LCF1   above this the account is healthy
      //      guardBound        = (targetHF*LF1*m + (R - m)*BCF1) / (BCF1*LF1)   below this the guard fires
      //    Midpoint of [lowerValue, min(bounds)]: asset [1] is partially seized and the guard closes the
      //    debt in full — a surplus in either mode.
      const debtValue = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
      const collateralStatesBeforeDrop = await makeCollateralStates(comet, context, albert.address, collateralInfos);
      const firstValue = mulPrice(collateralStatesBeforeDrop[0].collateralBalance, collateralPrices[0], collateralInfos[0].scale);
      const firstSeizedLF = mulFactor(firstValue, collateralInfos[0].liquidationFactor);
      const firstLiquidity = mulFactor(firstValue, collateralInfos[0].liquidateCollateralFactor);
      const remainingValue = debtValue - firstSeizedLF;

      const lowerValue = (remainingValue * factorScale + collateralInfos[1].liquidationFactor - 1n)
        / collateralInfos[1].liquidationFactor;
      const liquidatableBound = ((debtValue - firstLiquidity) * factorScale) / collateralInfos[1].liquidateCollateralFactor;
      const guardBound =
        (minDebtValue * TARGET_HF) / collateralInfos[1].borrowCollateralFactor
        + ((remainingValue - minDebtValue) * factorScale) / collateralInfos[1].liquidationFactor;
      const upperValue = liquidatableBound < guardBound ? liquidatableBound : guardBound;
      const secondTargetValue = (lowerValue + upperValue) / 2n;
      const secondDroppedPrice = (secondTargetValue * collateralInfos[1].scale + collateralStatesBeforeDrop[1].collateralBalance - 1n)
        / collateralStatesBeforeDrop[1].collateralBalance;
      await context.changePriceFeeds({ [collateralInfos[1].asset]: secondDroppedPrice });

      // Each collateral's price at absorb time: [0] unchanged, [1] dropped.
      const pricesAtAbsorb = [collateralPrices[0], secondDroppedPrice];

      // changePriceFeeds redeploys the liquidation module, so configure it only once the price is set.
      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // Sanity checks
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect((await comet.borrowBalanceOf(albert.address)).toBigInt()).to.be.greaterThan(baseBorrowMin);

      // 4. Capture the borrower's base state and each collateral's state before the absorb (in index order).
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

      // 5. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 6. Capture the borrower's base state and each collateral's state after the absorb.
      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

      // 7. Independently compute the expected seizure (mirrors the absorb loop), pricing each seizure at its
      //    price at absorb time. Borrow rates are zeroed, so no intra-block interest accrues and the debt
      //    re-derived from the captured principal is exactly what the seizure saw.
      const debtAtAbsorb = (await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      const debtRemainingValue = mulPrice(-debtAtAbsorb, basePrice, baseScale);

      // Iter 1 (asset 0): its whole value falls short of the debt, so it is fully seized.
      //   debt reduction = collateralValue × LF (mulFactor).
      collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
      collateralStatesBefore[0].seizedValue = mulPrice(collateralStatesBefore[0].seizeAmount, pricesAtAbsorb[0], collateralInfos[0].scale);
      const debtAfterFirst = debtRemainingValue - mulFactor(collateralStatesBefore[0].seizedValue, collateralInfos[0].liquidationFactor);

      // Iter 2 (asset 1): closes the residual debt, seizing exactly debtAfterFirst / LF worth; surplus stays.
      collateralStatesBefore[1].seizeAmount = divPrice(debtAfterFirst * factorScale / collateralInfos[1].liquidationFactor, pricesAtAbsorb[1], collateralInfos[1].scale);
      collateralStatesBefore[1].seizedValue = mulPrice(collateralStatesBefore[1].seizeAmount, pricesAtAbsorb[1], collateralInfos[1].scale);

      // 8. Post-absorb checks.

      // Debt fully repaid: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // Each collateral balance is reduced by its seized amount.
      for (let i = 0; i < collateralInfos.length; i++) {
        const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
        expect(collateralStatesAfter[i].collateralBalance)
          .to.equal(remainingCollateral);
      }

      // Each packed userCollateral balance is reduced by its seized amount.
      for (let i = 0; i < collateralInfos.length; i++) {
        const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
        expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
      }

      // Clear the storage bit for every fully seized asset, regardless of which packed field owns it.
      let expectedAssetsIn = cometStateBefore.user.assetsIn;
      let expectedReserved = cometStateBefore.user._reserved;
      for (let i = 0; i < collateralInfos.length; i++) {
        const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
        if (remainingCollateral === 0n) {
          if (collateralInfos[i].offset < 16) {
            expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[i].offset);
          } else {
            expectedReserved = expectedReserved & ~(1 << (collateralInfos[i].offset - 16));
          }
        }
      }
      expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
      expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Supplied collateral totals drop by the seized amount.
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].totalsCollateral)
          .to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      }

      // Collateral reserves rise by the seized amount.
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].collateralReserves)
          .to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      }

      // Collateral ERC20 balances are untouched on the absorb path.
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
      }
      // Base token ERC20 balance is untouched on the absorb path.
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Closing the debt in full pays the borrower's (negative) base balance out of reserves.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      // The position is healthy again.
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
    }
  );

  // All usable collaterals: every earlier asset fully seized, the last keeps the surplus.
  scenario(
    `Comet#absorb > all collaterals: debt closed, surplus retained [${tag}]`,
    {
      filter: async (ctx) => (await hasModule(ctx)) && ((await getUsableCollateralIndices(ctx)).length > 2),
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

      // Every usable collateral, in index order. Each earlier asset stays at its price and is fully seized;
      // the last is over-supplied, dropped into the guard window, and keeps the surplus.
      const collateralIndexes = await getUsableCollateralIndices(context);
      const collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
      const collateralPrices = await Promise.all(collateralInfos.map(async (info) => (await comet.getPrice(info.priceFeed)).toBigInt()));
      const lastIdx = collateralInfos.length - 1;

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      // Freeze interest so the debt stays exactly where the borrow puts it — the price drop alone makes
      // the position liquidatable, and the seizure / reserve assertions below are exact.
      await context.zeroBorrowRates();

      // 1. Borrow 1.5× the minimum debt. The earlier assets together are sized to retire a fixed 0.3× the
      //    min debt when fully seized (split evenly), leaving a residual of 1.2× the min debt on the last
      //    asset — still above the floor, so it goes through the guard rather than the sub-min branch.
      const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const borrowAmount = (15n * baseBorrowMin + 9n) / 10n;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
      const earlierAfterLFTotal = (3n * minDebtValue + 9n) / 10n;
      const perEarlierAfterLF = (earlierAfterLFTotal + BigInt(lastIdx) - 1n) / BigInt(lastIdx); // LF-weighted value each earlier asset retires

      // 2. Supply every earlier asset small at its own price (fully seized below), and the last asset
      //    over-supplied so the borrow is valid; the last asset's price is dropped onto the guard window
      //    afterwards.
      //      collateralValue = perEarlierAfterLF / LF_i             each earlier asset's market value
      //      lastValue       = remaining borrow power / BCF_last * 1.10
      let earlierBorrowLiquidity = 0n;
      for (let i = 0; i < lastIdx; i++) {
        const collateralValue = (perEarlierAfterLF * factorScale + collateralInfos[i].liquidationFactor - 1n)
          / collateralInfos[i].liquidationFactor;
        const supplyAmount = (collateralValue * collateralInfos[i].scale + collateralPrices[i] - 1n)
          / collateralPrices[i];
        const suppliedValue = mulPrice(supplyAmount, collateralPrices[i], collateralInfos[i].scale);
        earlierBorrowLiquidity += mulFactor(suppliedValue, collateralInfos[i].borrowCollateralFactor);
        const collateralAsset = context.getAssetByAddress(collateralInfos[i].asset);
        await context.sourceTokens(supplyAmount, collateralAsset, albert);
        await collateralAsset.approve(albert, comet.address);
        await albert.safeSupplyAsset({ asset: collateralInfos[i].asset, amount: supplyAmount });
      }

      const minimumLastValue = ((borrowValue - earlierBorrowLiquidity) * factorScale + collateralInfos[lastIdx].borrowCollateralFactor - 1n)
        / collateralInfos[lastIdx].borrowCollateralFactor;
      const lastValue = (minimumLastValue * 110n + 99n) / 100n;
      const lastSupplyAmount = (lastValue * collateralInfos[lastIdx].scale + collateralPrices[lastIdx] - 1n)
        / collateralPrices[lastIdx];
      const lastAsset = context.getAssetByAddress(collateralInfos[lastIdx].asset);
      await context.sourceTokens(lastSupplyAmount, lastAsset, albert);
      await lastAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralInfos[lastIdx].asset, amount: lastSupplyAmount });

      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 3. Read the earlier assets' actual supplied balances to size the drop from real state: sum the
      //    LF-weighted value they retire and the LCF-weighted liquidity they still contribute, then drop
      //    the last asset into the window where it covers the residual debt with a surplus while the guard
      //    fires (R = residual debt after the earlier assets, m the min debt, v = last asset's value):
      //      lowerValue        = R / LF_last                                 the LF-weighted value covers R
      //      liquidatableBound = (debtValue - earlierLiquidity) / LCF_last   above this the account is healthy
      //      guardBound        = (targetHF*LF_last*m + (R - m)*BCF_last) / (BCF_last*LF_last)   below this the guard fires
      //    Midpoint of [lowerValue, min(bounds)]: the last asset is partially seized and the guard closes
      //    the debt in full — a surplus in either mode.
      const debtValue = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
      const collateralStatesBeforeDrop = await makeCollateralStates(comet, context, albert.address, collateralInfos);
      let earlierSeizedLF = 0n;
      let earlierLiquidity = 0n;
      for (let i = 0; i < lastIdx; i++) {
        const value = mulPrice(collateralStatesBeforeDrop[i].collateralBalance, collateralPrices[i], collateralInfos[i].scale);
        earlierSeizedLF += mulFactor(value, collateralInfos[i].liquidationFactor);
        earlierLiquidity += mulFactor(value, collateralInfos[i].liquidateCollateralFactor);
      }
      const remainingValue = debtValue - earlierSeizedLF;

      const lowerValue = (remainingValue * factorScale + collateralInfos[lastIdx].liquidationFactor - 1n)
        / collateralInfos[lastIdx].liquidationFactor;
      const liquidatableBound = ((debtValue - earlierLiquidity) * factorScale) / collateralInfos[lastIdx].liquidateCollateralFactor;
      const guardBound =
        (minDebtValue * TARGET_HF) / collateralInfos[lastIdx].borrowCollateralFactor
        + ((remainingValue - minDebtValue) * factorScale) / collateralInfos[lastIdx].liquidationFactor;
      const upperValue = liquidatableBound < guardBound ? liquidatableBound : guardBound;
      const lastTargetValue = (lowerValue + upperValue) / 2n;
      const lastDroppedPrice = (lastTargetValue * collateralInfos[lastIdx].scale + collateralStatesBeforeDrop[lastIdx].collateralBalance - 1n)
        / collateralStatesBeforeDrop[lastIdx].collateralBalance;
      await context.changePriceFeeds({ [collateralInfos[lastIdx].asset]: lastDroppedPrice });

      // Each collateral's price at absorb time: the earlier assets unchanged, the last dropped.
      const pricesAtAbsorb = collateralPrices.map((price, i) => (i === lastIdx ? lastDroppedPrice : price));

      // changePriceFeeds redeploys the liquidation module, so configure it only once the price is set.
      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // Sanity checks
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect((await comet.borrowBalanceOf(albert.address)).toBigInt()).to.be.greaterThan(baseBorrowMin);

      // 4. Capture the borrower's base state and each collateral's state before the absorb (in index order).
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

      // 5. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 6. Capture the borrower's base state and each collateral's state after the absorb.
      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

      // 7. Independently compute the expected seizure (mirrors the absorb loop), pricing each seizure at its
      //    price at absorb time: every earlier asset is fully seized (debt drops by its value × LF) and the
      //    last asset closes the residual debt, seizing exactly (debtRemaining / LF) worth. Borrow rates are
      //    zeroed, so no intra-block interest accrues and the debt re-derived from the captured principal is
      //    exactly what the seizure saw.
      const debtAtAbsorb = (await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      let debtRemainingValue = mulPrice(-debtAtAbsorb, basePrice, baseScale);
      for (let i = 0; i < lastIdx; i++) {
        // Earlier collateral: fully seized; debt drops by collateralValue × LF (mulFactor).
        collateralStatesBefore[i].seizeAmount = collateralStatesBefore[i].collateralBalance;
        collateralStatesBefore[i].seizedValue = mulPrice(collateralStatesBefore[i].seizeAmount, pricesAtAbsorb[i], collateralInfos[i].scale);
        debtRemainingValue -= mulFactor(collateralStatesBefore[i].seizedValue, collateralInfos[i].liquidationFactor);
      }

      // Closing collateral: seize exactly debtRemaining / LF worth; surplus stays.
      collateralStatesBefore[lastIdx].seizeAmount = divPrice(debtRemainingValue * factorScale / collateralInfos[lastIdx].liquidationFactor, pricesAtAbsorb[lastIdx], collateralInfos[lastIdx].scale);
      collateralStatesBefore[lastIdx].seizedValue = mulPrice(collateralStatesBefore[lastIdx].seizeAmount, pricesAtAbsorb[lastIdx], collateralInfos[lastIdx].scale);

      // 8. Post-absorb checks.

      // Debt fully repaid: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // Each collateral balance is reduced by its seized amount.
      for (let i = 0; i < collateralInfos.length; i++) {
        const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
        expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      }
      expect(collateralStatesAfter[lastIdx].collateralBalance).to.be.greaterThan(0);

      // Each packed userCollateral balance is reduced by its seized amount.
      for (let i = 0; i < collateralInfos.length; i++) {
        const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
        expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
      }

      // Supplied collateral totals drop by the seized amount.
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].totalsCollateral)
          .to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      }

      // Collateral reserves rise by the seized amount.
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].collateralReserves)
          .to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      }

      // Collateral ERC20 balances are untouched on the absorb path.
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
      }

      // Clear the storage bit for every fully seized asset, regardless of which packed field owns it.
      let expectedAssetsIn = cometStateBefore.user.assetsIn;
      let expectedReserved = cometStateBefore.user._reserved;
      for (let i = 0; i < collateralInfos.length; i++) {
        const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
        if (remainingCollateral === 0n) {
          if (collateralInfos[i].offset < 16) {
            expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[i].offset);
          } else {
            expectedReserved = expectedReserved & ~(1 << (collateralInfos[i].offset - 16));
          }
        }
      }
      expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
      expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Base token ERC20 balance is untouched on the absorb path.
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Closing the debt in full pays the borrower's (negative) base balance out of reserves.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      // The position is healthy again.
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
    }
  );

  /*//////////////////////////////////////////////////////////////
                                ACCRUE
  //////////////////////////////////////////////////////////////*/

  // absorb() runs accrueInternal before any seizure, advancing the global interest indices by exactly
  // one accrual period. This mirrors `test/liquidation-logic/absorb.test.ts`: a real base supply and
  // borrow set totalSupplyBase / totalBorrowBase, then every index is checked against the on-chain
  // accrual formula for the measured elapsed time.
  scenario(
    `Comet#absorb > accrues all indices and advances lastAccrualTime [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 1)).length === 1,
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

      // Use the first collateral usable for the liquidation math (all three factors positive).
      const [collateralIndex] = await getUsableCollateralIndices(context, 1);

      const baseToken = await comet.baseToken();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const minBorrowValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const borrowAmount = 2n * baseBorrowMin;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);

      // 1. Betty supplies base for real, so totalSupplyBase > 0 (the supply and tracking-supply indices
      //    can grow / divide safely) and albert has liquidity to borrow against.
      await context.sourceTokens(borrowAmount, context.getAssetByAddress(baseToken), betty);
      await context.getAssetByAddress(baseToken).approve(betty, comet.address);
      await betty.safeSupplyAsset({ asset: baseToken, amount: borrowAmount });

      // 2. Albert supplies collateral worth 5× the minimum borrow value and borrows 2× the min debt.
      //    minBorrowValue  = baseBorrowMin * basePrice / baseScale
      //    collateralValue = 5 * minBorrowValue
      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const collateralPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();
      const collateralValue = 5n * minBorrowValue;
      const collateralAmount = (collateralValue * collateralAssetInfo.scale) / collateralPrice;
      const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);
      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 3. Set the dropped price so LCF-weighted collateral covers only 90% of the debt, making the
      //    account liquidatable, then accrue so lastAccrualTime is a clean starting point.
      const targetValueAfterLCF = borrowValue * 90n / 100n;
      const targetCollateralValue = targetValueAfterLCF * factorScale / collateralAssetInfo.liquidateCollateralFactor;
      const droppedPrice = targetCollateralValue * collateralAssetInfo.scale / collateralAmount;
      await context.changePriceFeeds({ [collateralAssetInfo.asset]: droppedPrice });
      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // Sanity check
      expect(await comet.isLiquidatable(albert.address)).to.be.true;

      // 4. Capture everything accrueInternal() will use. No state-changing call happens between here and
      //    absorb (only evm time advances), so the utilization / rates read now are exactly what absorb
      //    applies, and the checks below can be exact.
      const utilization = await comet.getUtilization();
      const totalsBefore = await comet.totalsBasic();
      const lastAccrualTimeBefore = totalsBefore.lastAccrualTime;
      const baseSupplyIndexBefore = totalsBefore.baseSupplyIndex.toBigInt();
      const baseBorrowIndexBefore = totalsBefore.baseBorrowIndex.toBigInt();
      const trackingSupplyIndexBefore = totalsBefore.trackingSupplyIndex.toBigInt();
      const trackingBorrowIndexBefore = totalsBefore.trackingBorrowIndex.toBigInt();
      const totalSupplyBaseBefore = totalsBefore.totalSupplyBase.toBigInt();
      const totalBorrowBaseBefore = totalsBefore.totalBorrowBase.toBigInt();
      const supplyRate = (await comet.getSupplyRate(utilization)).toBigInt();
      const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();
      const trackingSupplySpeed = (await comet.baseTrackingSupplySpeed()).toBigInt();
      const trackingBorrowSpeed = (await comet.baseTrackingBorrowSpeed()).toBigInt();
      const baseMinForRewards = (await comet.baseMinForRewards()).toBigInt();

      // 5. Let an hour pass, then absorb (which accrues before any seizure).
      const AVERAGE_WAIT_TIME = 3600; // 1 hour in seconds
      await world.increaseTime(AVERAGE_WAIT_TIME);
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // Sanity post absorb check
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 6. Exact accrual checks. timeElapsed is measured from the on-chain lastAccrualTime move, so the
      //    index formulas match regardless of how many seconds the absorb block actually landed on.
      const totalsAfter = await comet.totalsBasic();
      const timeElapsed = BigInt(totalsAfter.lastAccrualTime - lastAccrualTimeBefore);

      // lastAccrualTime advanced to ~the absorb block (the 1-hour wait plus a block or two).
      expect(totalsAfter.lastAccrualTime).to.be.approximately(lastAccrualTimeBefore + AVERAGE_WAIT_TIME, 10);

      // baseSupplyIndex += baseSupplyIndex * supplyRate * timeElapsed / factorScale
      expect(totalsAfter.baseSupplyIndex).to.equal(
        baseSupplyIndexBefore + baseSupplyIndexBefore * supplyRate * timeElapsed / factorScale
      );
      // baseBorrowIndex += baseBorrowIndex * borrowRate * timeElapsed / factorScale
      expect(totalsAfter.baseBorrowIndex).to.equal(
        baseBorrowIndexBefore + baseBorrowIndexBefore * borrowRate * timeElapsed / factorScale
      );
      // trackingSupplyIndex += trackingSupplySpeed * timeElapsed * baseScale / totalSupplyBase, applied
      // only when totalSupplyBase >= baseMinForRewards (otherwise accrueInternal leaves it untouched).
      const expectedTrackingSupplyIndex = totalSupplyBaseBefore >= baseMinForRewards
        ? trackingSupplyIndexBefore + trackingSupplySpeed * timeElapsed * baseScale / totalSupplyBaseBefore
        : trackingSupplyIndexBefore;
      expect(totalsAfter.trackingSupplyIndex).to.equal(expectedTrackingSupplyIndex);
      // trackingBorrowIndex += trackingBorrowSpeed * timeElapsed * baseScale / totalBorrowBase, applied
      // only when totalBorrowBase >= baseMinForRewards.
      const expectedTrackingBorrowIndex = totalBorrowBaseBefore >= baseMinForRewards
        ? trackingBorrowIndexBefore + trackingBorrowSpeed * timeElapsed * baseScale / totalBorrowBaseBefore
        : trackingBorrowIndexBefore;
      expect(totalsAfter.trackingBorrowIndex).to.equal(expectedTrackingBorrowIndex);
    }
  );

  /*//////////////////////////////////////////////////////////////
                             REVERT CASES
  //////////////////////////////////////////////////////////////*/

  // principal == 0: nothing borrowed, so the account is not liquidatable.
  scenario(
    `Comet#absorb > reverts when principal is zero [${tag}]`,
    { filter: async (ctx) => await hasModule(ctx) },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;
      const module = await configureModule(context, world, entry, partial, betty.address);

      // sanity checks
      expect((await comet.userBasic(albert.address)).principal).to.equal(0);
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      if (entry === 'absorb') {
        await expectRevertCustom(comet.connect(betty.signer).absorb(betty.address, [albert.address]), 'NotLiquidatable()');
      } else {
        await expectRevertCustom(module.connect(betty.signer).liquidate(betty.address, albert.address, []), 'NotLiquidatable()');
      }
    }
  );

  // principal > 0: the account is a net supplier, guarded out before any seizure math.
  scenario(
    `Comet#absorb > reverts when principal is positive [${tag}]`,
    { filter: async (ctx) => await hasModule(ctx) },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;
      const module = await configureModule(context, world, entry, partial, betty.address);

      // Albert supplies base only, so he is a net supplier (principal > 0).
      const baseToken = await comet.baseToken();
      const supplyAmount = 100n;
      await context.sourceTokens(supplyAmount, context.getAssetByAddress(baseToken), albert);
      await context.getAssetByAddress(baseToken).approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: baseToken, amount: supplyAmount });

      // sanity checks
      expect((await comet.userBasic(albert.address)).principal).to.be.greaterThan(0);
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      if (entry === 'absorb') {
        await expectRevertCustom(comet.connect(betty.signer).absorb(betty.address, [albert.address]), 'NotLiquidatable()');
      } else {
        await expectRevertCustom(module.connect(betty.signer).liquidate(betty.address, albert.address, []), 'NotLiquidatable()');
      }
    }
  );

  // absorb paused: the pause guard fires before liquidatability is ever evaluated.
  scenario(
    `Comet#absorb > reverts when absorb is paused [${tag}]`,
    { filter: async (ctx) => await hasModule(ctx), pause: { absorbPaused: true } },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;
      const module = await configureModule(context, world, entry, partial, betty.address);

      expect(await comet.isAbsorbPaused()).to.be.true;

      if (entry === 'absorb') {
        await expectRevertCustom(comet.connect(betty.signer).absorb(betty.address, [albert.address]), 'Paused()');
      } else {
        await expectRevertCustom(module.connect(betty.signer).liquidate(betty.address, albert.address, []), 'Paused()');
      }
    }
  );

  // Has debt but is fully borrow-collateralized → LCF-weighted collateral covers the debt.
  scenario(
    `Comet#absorb > reverts when debt is borrow collateralized [${tag}]`,
    {
      filter: async (ctx) => (await hasModule(ctx)) && (await getUsableCollateralIndices(ctx, 1)).length === 1,
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;
      const module = await configureModule(context, world, entry, partial, betty.address);

      // Use the first collateral usable for the liquidation math (all three factors positive).
      const [collateralIndex] = await getUsableCollateralIndices(context, 1);

      // Supply collateral worth ~3× the debt and borrow the minimum: well within the BCF limit.
      const baseToken = await comet.baseToken();
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      const debtValue = (baseBorrowMin * basePrice) / baseScale;

      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const collateralPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();
      const amount = (3n * debtValue * collateralAssetInfo.scale) / collateralPrice;
      const asset = context.getAssetByAddress(collateralAssetInfo.asset);
      await context.sourceTokens(amount, asset, albert);
      await asset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount });

      // Fund Comet with base so the borrow is drawable, then borrow the minimum.
      await context.sourceTokens(2n * baseBorrowMin, context.getAssetByAddress(baseToken), comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: baseBorrowMin });

      expect((await comet.userBasic(albert.address)).principal).to.be.lessThan(0);
      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      if (entry === 'absorb') {
        await expectRevertCustom(comet.connect(betty.signer).absorb(betty.address, [albert.address]), 'NotLiquidatable()');
      } else {
        await expectRevertCustom(module.connect(betty.signer).liquidate(betty.address, albert.address, []), 'NotLiquidatable()');
      }
    }
  );

  // Not borrow-collateralized (BCF-weighted < debt) but still not liquidatable (LCF-weighted ≥ debt).
  scenario(
    `Comet#absorb > reverts when not borrow collateralized but still not liquidatable [${tag}]`,
    {
      filter: async (ctx) => (await hasModule(ctx)) && (await getUsableCollateralIndices(ctx, 1)).length === 1,
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;
      const module = await configureModule(context, world, entry, partial, betty.address);

      // Use the first collateral usable for the liquidation math (all three factors positive).
      const [collateralIndex] = await getUsableCollateralIndices(context, 1);

      const baseToken = await comet.baseToken();
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      // Debt value at the minimum borrow: debtValueMin = baseBorrowMin * basePrice / baseScale.
      const debtValueMin = (baseBorrowMin * basePrice) / baseScale;

      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const collateralScale = collateralAssetInfo.scale;
      const collateralBCF = collateralAssetInfo.borrowCollateralFactor;
      const collateralLCF = collateralAssetInfo.liquidateCollateralFactor;
      const collateralPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();

      // Supply collateral whose BCF-weighted value is ~110% of the min debt: the min borrow is drawable
      // and the account starts borrow-collateralized and not liquidatable. amount = value * scale / price.
      const collateralValue = (110n * debtValueMin * factorScale) / (100n * collateralBCF);
      const amount = (collateralValue * collateralScale) / collateralPrice;
      const asset = context.getAssetByAddress(collateralAssetInfo.asset);
      await context.sourceTokens(amount, asset, albert);
      await asset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount });

      // Fund Comet with base so the borrow is drawable, then borrow the minimum.
      await context.sourceTokens(2n * baseBorrowMin, context.getAssetByAddress(baseToken), comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: baseBorrowMin });

      // Instead of moving the price, let borrow interest carry the debt into the band where the account
      // is no longer borrow-collateralized (BCF·collateral < debt) yet still not liquidatable
      // (LCF·collateral ≥ debt). Aim for the middle of that band and solve for the time to get there.
      //   borrowWeightedValue    = suppliedCollateralValue * BCF / factorScale
      //   liquidateWeightedValue = suppliedCollateralValue * LCF / factorScale
      //   targetDebtValue        = (borrowWeightedValue + liquidateWeightedValue) / 2
      const suppliedCollateralValue = ((await comet.collateralBalanceOf(albert.address, collateralAssetInfo.asset)).toBigInt() * collateralPrice) / collateralScale;
      const borrowWeightedValue = (suppliedCollateralValue * collateralBCF) / factorScale;
      const liquidateWeightedValue = (suppliedCollateralValue * collateralLCF) / factorScale;
      const targetDebtValue = (borrowWeightedValue + liquidateWeightedValue) / 2n;
      const targetDebt = (targetDebtValue * baseScale) / basePrice; // back to base units

      // A single accrual grows the debt linearly: debt(T) = debt0 * (1 + borrowRate * T / factorScale).
      // Solve for T so debt(T) == targetDebt. Nothing changes state before the accrual below, so the
      // borrow rate read here is exactly the one that accrual applies.
      const debt0 = (await comet.borrowBalanceOf(albert.address)).toBigInt();
      const borrowRate = (await comet.getBorrowRate(await comet.getUtilization())).toBigInt();
      const secondsToBand = ((targetDebt - debt0) * factorScale) / (debt0 * borrowRate);

      await world.increaseTime(Number(secondsToBand));
      await comet.accrueAccount(albert.address);

      expect((await comet.userBasic(albert.address)).principal).to.be.lessThan(0);
      expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      if (entry === 'absorb') {
        await expectRevertCustom(comet.connect(betty.signer).absorb(betty.address, [albert.address]), 'NotLiquidatable()');
      } else {
        await expectRevertCustom(module.connect(betty.signer).liquidate(betty.address, albert.address, []), 'NotLiquidatable()');
      }
    }
  );

  // A zero base price is rejected before the module can value the debt or build a seizure plan.
  scenario(
    `Comet#absorb > base token price feed returns bad price during absorb [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 1)).length === 1,
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;
      const [collateralIndex] = await getUsableCollateralIndices(context, 1);

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();

      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const collateralPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();
      const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);

      // 1. Establish a healthy borrow using the deployment's own minimum debt, price, scale and BCF.
      const borrowAmount = 2n * baseBorrowMin;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
      const minimumCollateralValue = (borrowValue * factorScale + collateralAssetInfo.borrowCollateralFactor)
        / collateralAssetInfo.borrowCollateralFactor;
      const suppliedCollateralValue = (minimumCollateralValue * 110n) / 100n;
      const collateralAmount = (suppliedCollateralValue * collateralAssetInfo.scale + collateralPrice)
        / collateralPrice;

      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });

      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 2. Drop collateral until its LCF-weighted value is 90% of debt, then prove the account is
      //    liquidatable while the base-token oracle is still valid.
      const debtValue = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
      const targetValueAfterLCF = (debtValue * 90n) / 100n;
      const targetCollateralValue = (targetValueAfterLCF * factorScale) / collateralAssetInfo.liquidateCollateralFactor;
      const droppedPrice = (targetCollateralValue * collateralAssetInfo.scale) / collateralAmount;
      await context.changePriceFeeds({ [collateralAssetInfo.asset]: droppedPrice });
      await comet.accrueAccount(albert.address);

      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;

      // 3. Replace the base-token feed with a zero-price feed. The feed change redeploys the module, so
      //    configure the active entry point only after the broken oracle is installed.
      await context.changePriceFeeds({ [baseToken]: 0n });
      const module = await configureModule(context, world, entry, partial, betty.address);

      await expect(comet.isBorrowCollateralized(albert.address)).to.be.revertedWithCustomError(comet, 'BadPrice');
      await expect(comet.isLiquidatable(albert.address)).to.be.revertedWithCustomError(comet, 'BadPrice');

      if (entry === 'absorb') {
        await expectRevertCustom(comet.connect(betty.signer).absorb(betty.address, [albert.address]), 'BadPrice()');
      } else {
        await expectRevertCustom(module.connect(betty.signer).liquidate(betty.address, albert.address, []), 'BadPrice()');
      }
    }
  );

  // A revert from the base oracle bubbles through both liquidatability and the complete absorb path.
  scenario(
    `Comet#absorb > base token price feed reverts during absorb [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 1)).length === 1,
    },
    async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
      const { admin, albert, betty } = actors;
      const [collateralIndex] = await getUsableCollateralIndices(context, 1);

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();

      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const collateralPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();
      const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);

      // 1. Establish a healthy borrow using the deployment's own minimum debt, price, scale and BCF.
      const borrowAmount = 2n * baseBorrowMin;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
      const minimumCollateralValue = (borrowValue * factorScale + collateralAssetInfo.borrowCollateralFactor)
        / collateralAssetInfo.borrowCollateralFactor;
      const suppliedCollateralValue = (minimumCollateralValue * 110n) / 100n;
      const collateralAmount = (suppliedCollateralValue * collateralAssetInfo.scale + collateralPrice)
        / collateralPrice;

      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });

      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 2. Drop collateral until its LCF-weighted value is 90% of debt, then prove the account is
      //    liquidatable while the original base-token oracle still works.
      const debtValue = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
      const targetValueAfterLCF = (debtValue * 90n) / 100n;
      const targetCollateralValue = (targetValueAfterLCF * factorScale) / collateralAssetInfo.liquidateCollateralFactor;
      const droppedPrice = (targetCollateralValue * collateralAssetInfo.scale) / collateralAmount;
      await context.changePriceFeeds({ [collateralAssetInfo.asset]: droppedPrice });
      await comet.accrueAccount(albert.address);

      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;

      // 3. Install a base-token oracle whose latestRoundData() always reverts, then redeploy Comet and
      //    its bound liquidation module through the normal Configurator/proxy-admin path.
      const priceFeedWithRevert = await world.deploymentManager.deploy(
        'absorb:baseTokenPriceFeedWithRevert',
        'test/PriceFeedWithRevert.sol',
        [],
        true
      );
      await configurator.connect(admin.signer).setBaseTokenPriceFeed(comet.address, priceFeedWithRevert.address);
      await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
      await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

      const module = await configureModule(context, world, entry, partial, betty.address);

      await expect(comet.isBorrowCollateralized(albert.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
      await expect(comet.isLiquidatable(albert.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

      if (entry === 'absorb') {
        await expect(comet.connect(betty.signer).absorb(betty.address, [albert.address]))
          .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
      } else {
        await expect(module.connect(betty.signer).liquidate(betty.address, albert.address, []))
          .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
      }
    }
  );
}

/*//////////////////////////////////////////////////////////////
                        REGISTER SCENARIOS
//////////////////////////////////////////////////////////////*/

absorbScenarios('absorb', true);
absorbScenarios('liquidate', true);
absorbScenarios('absorb', false);
