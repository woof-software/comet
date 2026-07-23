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

    // Above this threshold a target-health seizure still leaves more than baseBorrowMin of debt, which is
    // what keeps the market in partial mode instead of closing the debt outright.
    const seizeFormulaDenominator = mulFactor(assetInfo.liquidationFactor, TARGET_HF) - assetInfo.borrowCollateralFactor;
    const partialWindowThreshold = minDebtValue * seizeFormulaDenominator * assetInfo.liquidateCollateralFactor
      / (assetInfo.borrowCollateralFactor * (assetInfo.liquidationFactor - assetInfo.liquidateCollateralFactor));
    const minimumDebtValue = 2n * minDebtValue;
    const targetDebtValue = 2n * (partialWindowThreshold > minimumDebtValue ? partialWindowThreshold : minimumDebtValue);
    const debt = divPrice(targetDebtValue, basePrice, baseScale);
    const debtValue = mulPrice(debt, basePrice, baseScale);
    const suppliedCollateralValue = debtValue * factorScale / assetInfo.borrowCollateralFactor * 110n / 100n;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPriceBeforeDrop;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * debt, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: debt });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);

    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Midpoint of the window where the seizure still leaves debt above baseBorrowMin (floor) and the
    // account is liquidatable (max).
    const guardFloorValue = debtValue * factorScale / assetInfo.liquidationFactor
      + minDebtValue * seizeFormulaDenominator * factorScale / (assetInfo.liquidationFactor * assetInfo.borrowCollateralFactor);
    const liquidatableMaxValue = debtValue * factorScale / assetInfo.liquidateCollateralFactor;
    const targetCollateralValue = (guardFloorValue + liquidatableMaxValue) / 2n;
    const droppedPrice = targetCollateralValue * assetInfo.scale / collateralAmount;
    await context.changePriceFeeds({ [assetInfo.asset]: droppedPrice });

    // changePriceFeeds redeploys Comet and the module, so re-read the configuration and set the mode after.
    assetInfo = await getAssetInfo(comet, collateralIndex);
    const module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    // Partial mode takes only what restores target health, not what closes the debt.
    const collateralValue = mulPrice(collateralStateBefore.collateralBalance, droppedPrice, assetInfo.scale);
    const totalCollateralizedValue = mulFactor(collateralValue, assetInfo.borrowCollateralFactor);
    const wantedValue = wantedCollateralValue(debtValue, totalCollateralizedValue, assetInfo.liquidationFactor, assetInfo.borrowCollateralFactor);
    collateralStateBefore.seizeAmount = divPrice(wantedValue, droppedPrice, assetInfo.scale);
    collateralStateBefore.seizedValue = mulFactor(wantedValue, assetInfo.liquidationFactor);

    const debtValueRemaining = debtValue - collateralStateBefore.seizedValue;
    const debtRemaining = divPrice(debtValueRemaining, basePrice, baseScale);
    const basePaidOut = debt - debtRemaining;
    expect(debtRemaining).to.be.greaterThan(baseBorrowMin);

    const expectedPrincipal = principalValue(-debtRemaining, cometStateAfter.totals.baseSupplyIndex, cometStateAfter.totals.baseBorrowIndex);
    expect(cometStateAfter.user.principal).to.equal(expectedPrincipal);
    expect(-cometStateAfter.userBalance).to.equal(debtRemaining);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(debtRemaining);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // healthFactor = collateralValue*LCF / debtValue
    const collateralValueAfter = mulPrice(collateralStateAfter.collateralBalance, droppedPrice, assetInfo.scale);
    const healthFactorAfter = mulFactor(collateralValueAfter, assetInfo.liquidateCollateralFactor) * factorScale
      / mulPrice(-cometStateAfter.userBalance, basePrice, baseScale);
    expect(healthFactorAfter).to.be.greaterThan(TARGET_HF);

    // Surplus is left on the account, so the collateral and reserved bits are unchanged.
    const remainingCollateral = collateralStateBefore.collateralBalance - collateralStateBefore.seizeAmount;
    expect(collateralStateAfter.collateralBalance).to.equal(remainingCollateral);
    expect(collateralStateAfter.userCollateral.balance).to.equal(remainingCollateral);
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal).sub(cometStateAfter.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Seized collateral moves from supplied totals into reserves; no token leaves Comet.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

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

    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);

    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Midpoint of the window where LF-weighted collateral still covers the debt (min) and the account is
    // liquidatable (max), so the debt closes in full and surplus is left behind.
    const minimumCollateralValue = debtValue * factorScale / assetInfo.liquidationFactor;
    const liquidatableMaxValue = debtValue * factorScale / assetInfo.liquidateCollateralFactor;
    const targetCollateralValue = (minimumCollateralValue + liquidatableMaxValue) / 2n;
    const droppedPrice = targetCollateralValue * assetInfo.scale / collateralAmount;
    await context.changePriceFeeds({ [assetInfo.asset]: droppedPrice });

    // changePriceFeeds redeploys Comet and the module, so re-read the configuration and set the mode after.
    assetInfo = await getAssetInfo(comet, collateralIndex);
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.false;
    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

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

    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Surplus is left on the account, so the collateral and reserved bits are unchanged.
    const remainingCollateral = collateralStateBefore.collateralBalance - collateralStateBefore.seizeAmount;
    expect(collateralStateAfter.collateralBalance).to.equal(remainingCollateral);
    expect(collateralStateAfter.userCollateral.balance).to.equal(remainingCollateral);
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Seized collateral moves from supplied totals into reserves; no token leaves Comet.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

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

    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;
    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Half of debt / LF: even seizing everything repays only half the debt, so the rest is bad debt.
    const targetCollateralValue = debtValue * factorScale / assetInfo.liquidationFactor / 2n;
    const droppedPrice = targetCollateralValue * assetInfo.scale / collateralAmount;
    await context.changePriceFeeds({ [assetInfo.asset]: droppedPrice });

    // changePriceFeeds redeploys Comet and the module, so re-read the configuration and set the mode after.
    assetInfo = await getAssetInfo(comet, collateralIndex);
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    const collateralValue = mulPrice(collateralAmount, droppedPrice, assetInfo.scale);
    const collateralRepaymentValue = mulFactor(collateralValue, assetInfo.liquidationFactor);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.false;
    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;
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

    // The collateral cannot cover the debt, so all of it is seized and the shortfall is written off.
    collateralStateBefore.seizeAmount = collateralStateBefore.collateralBalance;

    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The only collateral is drained, so both membership bitmaps are clear.
    expect(collateralStateAfter.collateralBalance).to.equal(0n);
    expect(collateralStateAfter.userCollateral.balance).to.equal(0n);
    expect(cometStateAfter.user.assetsIn).to.equal(0);
    expect(cometStateAfter.user._reserved).to.equal(0);

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Seized collateral moves from supplied totals into reserves; no token leaves Comet.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

    // Reserves absorb the whole debt, including the part no collateral covered.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * Deactivated first collateral, normal second one, partial liquidation mode. The module ignores the
 * deactivated flag and all risk factors stay in place, so absorb drains the first asset and partially
 * seizes the second, leaving a smaller healthy debt. Draining the deactivated asset is what unfreezes the
 * borrower: it leaves assetsIn, so borrow-side checks stop reverting with TokenIsDeactivated.
 */
scenario(
  'Comet#absorb > deactivated collateral: 2 collaterals, deactivated first fully seized, normal second partially seized',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, cometExt, actors }, context, world) => {
    const { pauseGuardian, albert, betty } = actors;

    // [0] is deactivated, dropped and fully seized; [1] stays normal and is partially seized.
    const collateralIndexes = await getUsableCollateralIndices(context, 2);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    await context.zeroBorrowRates();

    let collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const collateralAssets = collateralInfos.map(({ asset }) => context.getAssetByAddress(asset));
    const collateralPrices = await Promise.all(collateralInfos.map(async ({ priceFeed }) => (await comet.getPrice(priceFeed)).toBigInt()));

    // 20x the minimum debt keeps both seizures clear of the min-debt guard.
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    const borrowValue = 20n * minDebtValue;
    const borrowAmount = divPrice(borrowValue, basePrice, baseScale);

    // Fully seizing the first asset repays 60% of the debt; the second is sized just above the 40% left,
    // at the midpoint of the band where it closes the rest partially instead of being drained too (below
    // BCF/LF) or never being reached (above targetHF, where the first seizure already restores health).
    const firstTargetValue = (borrowValue * 6n / 10n) * factorScale / collateralInfos[0].liquidationFactor;
    const secondBcfRatio = (collateralInfos[1].borrowCollateralFactor * factorScale / collateralInfos[1].liquidationFactor + TARGET_HF) / 2n;
    const secondTargetValue = ((borrowValue * 4n / 10n) * secondBcfRatio) / collateralInfos[1].borrowCollateralFactor;

    const collateralAmounts = [
      (3n * borrowValue * collateralInfos[0].scale) / collateralPrices[0],
      (secondTargetValue * collateralInfos[1].scale) / collateralPrices[1],
    ];

    for (let i = 0; i < collateralInfos.length; i++) {
      await context.sourceTokens(collateralAmounts[i], collateralAssets[i], albert);
      await collateralAssets[i].approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralInfos[i].asset, amount: collateralAmounts[i] });
    }

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndexes[0]);

    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.false;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[0].asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    const droppedFirstPrice = (firstTargetValue * collateralInfos[0].scale) / collateralAmounts[0];
    await context.changePriceFeeds({ [collateralInfos[0].asset]: droppedFirstPrice });

    // changePriceFeeds redeploys Comet and the module, so re-read the configuration and set the mode after.
    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.true;
    
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.false;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[0].asset);

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);
    const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
    const firstCollateralValue = mulPrice(collateralStatesBefore[0].collateralBalance, droppedFirstPrice, collateralInfos[0].scale);
    const secondCollateralValue = mulPrice(collateralStatesBefore[1].collateralBalance, collateralPrices[1], collateralInfos[1].scale);

    // healthFactor = (value0*LCF0 + value1*LCF1) / debtValue
    const liquidityBefore = mulFactor(firstCollateralValue, collateralInfos[0].liquidateCollateralFactor)
      + mulFactor(secondCollateralValue, collateralInfos[1].liquidateCollateralFactor);
    const healthFactorBefore = (liquidityBefore * factorScale) / debtValueBefore;
    expect(healthFactorBefore).to.be.lessThan(TARGET_HF);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    collateralStatesBefore[0].seizedValue = mulFactor(firstCollateralValue, collateralInfos[0].liquidationFactor);

    // The drained first asset leaves the running total, so only the second still backs the debt — and the
    // module wants less of it than it holds, so it is only partially seized.
    const debtValueAfterFirst = debtValueBefore - collateralStatesBefore[0].seizedValue;
    const secondTotalCollateralizedValue = mulFactor(secondCollateralValue, collateralInfos[1].borrowCollateralFactor);
    const secondWantedValue = wantedCollateralValue(debtValueAfterFirst, secondTotalCollateralizedValue, collateralInfos[1].liquidationFactor, collateralInfos[1].borrowCollateralFactor);

    collateralStatesBefore[1].seizeAmount = divPrice(secondWantedValue, collateralPrices[1], collateralInfos[1].scale);
    collateralStatesBefore[1].seizedValue = mulFactor(secondWantedValue, collateralInfos[1].liquidationFactor);

    const debtValueRemaining = debtValueAfterFirst - collateralStatesBefore[1].seizedValue;
    const debtRemaining = divPrice(debtValueRemaining, basePrice, baseScale);
    const basePaidOut = -cometStateBefore.userBalance - debtRemaining;
    expect(debtValueRemaining).to.be.greaterThan(minDebtValue);
    expect(debtRemaining).to.be.greaterThan(baseBorrowMin);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    const expectedPrincipal = principalValue(-debtRemaining, cometStateAfter.totals.baseSupplyIndex, cometStateAfter.totals.baseBorrowIndex);
    expect(cometStateAfter.user.principal).to.equal(expectedPrincipal);
    expect(-cometStateAfter.userBalance).to.equal(debtRemaining);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(debtRemaining);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    const collateralRemaining = collateralStatesBefore.map((state) => state.collateralBalance - state.seizeAmount);
    const liquidityAfter = mulFactor(mulPrice(collateralRemaining[1], collateralPrices[1], collateralInfos[1].scale), collateralInfos[1].liquidateCollateralFactor);
    const healthFactorAfter = (liquidityAfter * factorScale) / mulPrice(debtRemaining, basePrice, baseScale);
    expect(healthFactorAfter).to.be.greaterThan(TARGET_HF);

    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].collateralBalance).to.equal(collateralRemaining[i]);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(collateralRemaining[i]);
    }
    expect(collateralStatesAfter[0].collateralBalance).to.equal(0n);
    expect(collateralStatesAfter[1].collateralBalance).to.be.greaterThan(0n);

    // Assets 0-15 are tracked in assetsIn and the rest in _reserved, so the drained first asset's bit is
    // cleared in whichever of the two it falls.
    let expectedAssetsIn = cometStateBefore.user.assetsIn;
    let expectedReserved = cometStateBefore.user._reserved;
    if (collateralInfos[0].offset < 16) {
      expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[0].offset);
    } else {
      expectedReserved = expectedReserved & ~(1 << (collateralInfos[0].offset - 16));
    }
    expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
    expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

    // The asset is still deactivated, but the borrower holds none of it, so the check never meets it.
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal).sub(cometStateAfter.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Seized collateral moves from supplied totals into reserves; no token leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves - basePaidOut);
  }
);
