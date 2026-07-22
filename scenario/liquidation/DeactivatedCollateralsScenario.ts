import { expect } from 'chai';
import { scenario } from '../context/CometContext';
import {
  captureAbsorbStateBefore,
  configureModule,
  fundAccount,
  getAssetInfo,
  getUsableCollateralIndices,
  hasModule,
  makeCollateralStates,
  TARGET_HF,
  wantedCollateralValue,
} from '../utils';
import { divPrice, factorScale, mulFactor, mulPrice, principalValue } from '../../test/helpers';

/**
 * Deactivated collateral scenarios for the liquidation module.
 *
 * These cases use Comet.absorb directly and derive every amount from the active deployment. Unlike
 * delisting, deactivation keeps the asset's risk factors intact but blocks borrow-side health checks.
 */

/**
 * A deactivated collateral makes borrow-side health checks revert while its positive LCF and LF
 * remain available to liquidation. After a price drop, partial mode seizes only enough collateral
 * to restore target health while leaving both collateral and debt on the account.
 */
scenario(
  'Comet#absorb > deactivated collateral: one asset, partial liquidation',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, cometExt, actors }, context, world) => {
    const { pauseGuardian, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    let assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPriceBeforeDrop = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    // Derive debt above the deployment-specific threshold at which target-health liquidation leaves
    // more than baseBorrowMin outstanding. This keeps the scenario in genuine partial mode even on
    // markets whose collateral factors are close to 0.9.
    const seizeFormulaDenominator = mulFactor(assetInfo.liquidationFactor, TARGET_HF) - assetInfo.borrowCollateralFactor;
    const partialWindowThreshold = minDebtValue * seizeFormulaDenominator * assetInfo.liquidateCollateralFactor
      / (assetInfo.borrowCollateralFactor * (assetInfo.liquidationFactor - assetInfo.liquidateCollateralFactor));
    const minimumDebtValue = 2n * minDebtValue;
    const targetDebtValue = 2n * (partialWindowThreshold > minimumDebtValue ? partialWindowThreshold : minimumDebtValue);
    const borrowAmount = divPrice(targetDebtValue, basePrice, baseScale);
    const debt = borrowAmount;
    const debtValue = mulPrice(debt, basePrice, baseScale);
    const suppliedCollateralValue = debtValue * factorScale / assetInfo.borrowCollateralFactor * 110n / 100n;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPriceBeforeDrop;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The pause guardian deactivates the collateral without changing its liquidation parameters.
    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);

    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Move collateral into the genuine partial-seizure window. The lower bound ensures that a
    // target-health seizure leaves debt above baseBorrowMin; the upper bound makes the account
    // liquidatable. Their midpoint also remains below the original supplied value, so this is a drop.
    const guardFloorValue = debtValue * factorScale / assetInfo.liquidationFactor
      + minDebtValue * seizeFormulaDenominator * factorScale / (assetInfo.liquidationFactor * assetInfo.borrowCollateralFactor);
    const liquidatableMaxValue = debtValue * factorScale / assetInfo.liquidateCollateralFactor;
    const targetCollateralValue = (guardFloorValue + liquidatableMaxValue) / 2n;
    const droppedPrice = targetCollateralValue * assetInfo.scale / collateralAmount;
    await context.changePriceFeeds({ [assetInfo.asset]: droppedPrice });

    // The price-feed upgrade installs a fresh module; configure its default partial mode and verify
    // that Comet and the module share the upgraded asset list.
    assetInfo = await getAssetInfo(comet, collateralIndex);
    const module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;
    expect(assetInfo.liquidateCollateralFactor).to.be.greaterThan(0n);
    expect(assetInfo.liquidationFactor).to.be.greaterThan(0n);
    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    // Partial mode seizes the target-health amount instead of falling into debt closeout.
    const collateralValue = mulPrice(collateralStateBefore.collateralBalance, droppedPrice, assetInfo.scale);
    const totalCollateralizedValue = mulFactor(collateralValue, assetInfo.borrowCollateralFactor);
    const wantedValue = wantedCollateralValue(debtValue, totalCollateralizedValue, assetInfo.liquidationFactor, assetInfo.borrowCollateralFactor);
    collateralStateBefore.seizeAmount = divPrice(wantedValue, droppedPrice, assetInfo.scale);
    collateralStateBefore.seizedValue = mulFactor(wantedValue, assetInfo.liquidationFactor);

    const debtValueRemaining = debtValue - collateralStateBefore.seizedValue;
    const debtRemaining = divPrice(debtValueRemaining, basePrice, baseScale);
    const basePaidOut = debt - debtRemaining;
    expect(debtRemaining).to.be.greaterThan(baseBorrowMin);

    // The account remains a borrower at the expected reduced balance and principal.
    const expectedPrincipal = principalValue(-debtRemaining, cometStateAfter.totals.baseSupplyIndex, cometStateAfter.totals.baseBorrowIndex);
    expect(cometStateAfter.user.principal).to.equal(expectedPrincipal);
    expect(-cometStateAfter.userBalance).to.equal(debtRemaining);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(debtRemaining);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The partial seizure restores the remaining open position above the target health factor.
    const collateralValueAfter = mulPrice(collateralStateAfter.collateralBalance, droppedPrice, assetInfo.scale);
    const healthFactorAfter = mulFactor(collateralValueAfter, assetInfo.liquidateCollateralFactor) * factorScale
      / mulPrice(-cometStateAfter.userBalance, basePrice, baseScale);
    expect(healthFactorAfter).to.be.greaterThan(TARGET_HF);

    // Only the computed amount is seized. The collateral bit and reserved bits remain unchanged
    // because the deactivated asset still has a surplus balance on the account.
    const remainingCollateral = collateralStateBefore.collateralBalance - collateralStateBefore.seizeAmount;
    expect(collateralStateAfter.collateralBalance).to.equal(remainingCollateral);
    expect(collateralStateAfter.userCollateral.balance).to.equal(remainingCollateral);
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    // Only the repaid principal leaves total borrows; supply principal and Comet's base balance stay fixed.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal).sub(cometStateAfter.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // The seized collateral moves from supplied totals into reserves without an ERC20 transfer.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

    // Borrow rates are frozen, so base reserves fall by exactly the amount repaid.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves - basePaidOut);
  }
);

/**
 * Full-close mode can still seize a deactivated collateral because deactivation blocks borrow-side
 * actions without removing its liquidation value. Absorb closes the debt, seizes debt / LF worth of
 * collateral and leaves the remaining deactivated collateral on the account.
 */
scenario(
  'Comet#absorb > deactivated collateral: one asset, full debt close',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, cometExt, actors }, context, world) => {
    const { pauseGuardian, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    let assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPriceBeforeDrop = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    // Supply collateral worth 4x the deployment's minimum debt and borrow 2x the minimum.
    const suppliedCollateralValue = 4n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPriceBeforeDrop;
    const debt = 2n * baseBorrowMin;
    const debtValue = mulPrice(debt, basePrice, baseScale);

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * debt, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: debt });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Deactivation blocks borrow-side health checks but leaves the positive liquidation factors intact.
    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;
    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Drop into the window where LCF-weighted collateral is below the debt while LF-weighted
    // collateral still covers it. Full-close mode therefore closes all debt and leaves surplus.
    const minimumCollateralValue = debtValue * factorScale / assetInfo.liquidationFactor;
    const liquidatableMaxValue = debtValue * factorScale / assetInfo.liquidateCollateralFactor;
    const targetCollateralValue = (minimumCollateralValue + liquidatableMaxValue) / 2n;
    const droppedPrice = targetCollateralValue * assetInfo.scale / collateralAmount;
    await context.changePriceFeeds({ [assetInfo.asset]: droppedPrice });

    assetInfo = await getAssetInfo(comet, collateralIndex);
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.false;
    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;
    expect(assetInfo.liquidateCollateralFactor).to.be.greaterThan(0n);
    expect(assetInfo.liquidationFactor).to.be.greaterThan(0n);
    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    // Full-close mode seizes exactly debt / LF worth of collateral.
    collateralStateBefore.seizeAmount = divPrice(debtValue * factorScale / assetInfo.liquidationFactor, droppedPrice, assetInfo.scale);
    collateralStateBefore.seizedValue = mulPrice(collateralStateBefore.seizeAmount, droppedPrice, assetInfo.scale);

    // The debt is fully closed and the debt-free account is no longer liquidatable.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Only the computed amount is seized; surplus remains, preserving the collateral and reserved bits.
    const remainingCollateral = collateralStateBefore.collateralBalance - collateralStateBefore.seizeAmount;
    expect(collateralStateAfter.collateralBalance).to.equal(remainingCollateral);
    expect(collateralStateAfter.userCollateral.balance).to.equal(remainingCollateral);
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    // The absorbed principal leaves total borrows; supply principal and Comet's base balance stay fixed.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // The seized amount moves from supplied collateral into reserves without an ERC20 transfer.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

    // Borrow rates are frozen, so reserves decrease by the full absorbed debt.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * A deactivated collateral remains seizable even when its value no longer covers the debt. Absorb
 * drains the entire asset, clears the borrow state and writes the uncovered shortfall off against
 * base reserves.
 */
scenario(
  'Comet#absorb > deactivated collateral: one asset, full debt close with bad debt',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, cometExt, actors }, context, world) => {
    const { pauseGuardian, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    let assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPriceBeforeDrop = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    // Supply collateral worth 4x the deployment's minimum debt and borrow 2x the minimum.
    const suppliedCollateralValue = 4n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPriceBeforeDrop;
    const debt = 2n * baseBorrowMin;
    const debtValue = mulPrice(debt, basePrice, baseScale);

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * debt, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: debt });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Deactivation blocks borrow-side health checks without removing the asset's liquidation value.
    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;
    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Cut the asset's market value to half of debt / LF. Even a full seizure then repays only half
    // the debt, making the remaining half genuine bad debt.
    const targetCollateralValue = debtValue * factorScale / assetInfo.liquidationFactor / 2n;
    const droppedPrice = targetCollateralValue * assetInfo.scale / collateralAmount;
    await context.changePriceFeeds({ [assetInfo.asset]: droppedPrice });

    assetInfo = await getAssetInfo(comet, collateralIndex);
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    const collateralValue = mulPrice(collateralAmount, droppedPrice, assetInfo.scale);
    const collateralRepaymentValue = mulFactor(collateralValue, assetInfo.liquidationFactor);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.false;
    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;
    expect(assetInfo.liquidationFactor).to.be.greaterThan(0n);
    expect(collateralRepaymentValue).to.be.lessThan(debtValue);
    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    // Insufficient collateral is fully seized before the remaining debt is written off.
    collateralStateBefore.seizeAmount = collateralStateBefore.collateralBalance;
    collateralStateBefore.seizedValue = collateralRepaymentValue;

    // Bad-debt handling clears the complete borrow state and removes all liquidation risk.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The only collateral is fully drained, so both collateral membership bitmaps are clear.
    expect(collateralStateAfter.collateralBalance).to.equal(0n);
    expect(collateralStateAfter.userCollateral.balance).to.equal(0n);
    expect(cometStateAfter.user.assetsIn).to.equal(0);
    expect(cometStateAfter.user._reserved).to.equal(0);

    // The full absorbed principal leaves total borrows; supply principal and base balance stay fixed.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // The full collateral balance moves from supplied totals into reserves without an ERC20 transfer.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

    // Base reserves absorb the full debt, including the portion not covered by seized collateral.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);
