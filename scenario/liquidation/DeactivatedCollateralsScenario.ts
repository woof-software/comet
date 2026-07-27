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
    const firstCollateralValue = mulPrice(collateralStatesBefore[0].collateralBalance, droppedFirstPrice, collateralInfos[0].scale);
    const secondCollateralValue = mulPrice(collateralStatesBefore[1].collateralBalance, collateralPrices[1], collateralInfos[1].scale);

    // healthFactor = (value0*LCF0 + value1*LCF1) / debtValue
    const liquidityBefore = mulFactor(firstCollateralValue, collateralInfos[0].liquidateCollateralFactor)
      + mulFactor(secondCollateralValue, collateralInfos[1].liquidateCollateralFactor);
    const healthFactorBefore = (liquidityBefore * factorScale) / borrowValue;
    expect(healthFactorBefore).to.be.lessThan(TARGET_HF);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    collateralStatesBefore[0].seizedValue = mulFactor(firstCollateralValue, collateralInfos[0].liquidationFactor);

    // The drained first asset leaves the running total, so only the second still backs the debt — and the
    // module wants less of it than it holds, so it is only partially seized.
    const debtValueAfterFirst = borrowValue - collateralStatesBefore[0].seizedValue;
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

/**
 * A deactivated first collateral can be fully consumed before the normal second collateral closes
 * the remaining debt. The second asset covers that remainder with only part of its balance, proving
 * the full-close loop preserves its surplus and clears only the drained first asset's membership bit.
 */
scenario(
  'Comet#absorb > deactivated collateral: 2 collaterals, first asset deactivated first, second asset normal second, full debt close',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, cometExt, actors }, context, world) => {
    const { pauseGuardian, albert, betty } = actors;

    const collateralIndexes = await getUsableCollateralIndices(context, 2);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    let collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const collateralAssets = collateralInfos.map(({ asset }) => context.getAssetByAddress(asset));
    const collateralPrices = await Promise.all(collateralInfos.map(async ({ priceFeed }) => (await comet.getPrice(priceFeed)).toBigInt()));

    // Supply a combined value of 4x baseBorrowMin and borrow 2x baseBorrowMin. After the first asset's
    // price drop, fully seizing it retires half the debt. The second asset is placed at the midpoint
    // between the value needed to close that remainder at LF and the value that would make the account
    // safe at LCF, so it both closes the debt and leaves a surplus.
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
    const firstDebtCoverage = borrowValue / 2n;
    const firstDroppedValue = firstDebtCoverage * factorScale / collateralInfos[0].liquidationFactor;
    const firstLiquidationLiquidity = mulFactor(firstDroppedValue, collateralInfos[0].liquidateCollateralFactor);
    const minimumSecondValue = (borrowValue - firstDebtCoverage) * factorScale / collateralInfos[1].liquidationFactor;
    const maximumSecondValue = (borrowValue - firstLiquidationLiquidity) * factorScale / collateralInfos[1].liquidateCollateralFactor;
    const secondSuppliedValue = (minimumSecondValue + maximumSecondValue) / 2n;
    const firstSuppliedValue = 4n * minDebtValue - secondSuppliedValue;
    const collateralAmounts = [
      firstSuppliedValue * collateralInfos[0].scale / collateralPrices[0],
      secondSuppliedValue * collateralInfos[1].scale / collateralPrices[1],
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

    // Governance updates the first asset's price-feed configuration. changePriceFeeds deploys and sets
    // a fresh liquidation module before upgrading Comet, so configure full-close mode only afterward.
    const droppedFirstPrice = firstDroppedValue * collateralInfos[0].scale / collateralAmounts[0];
    await context.changePriceFeeds({ [collateralInfos[0].asset]: droppedFirstPrice });

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.false;

    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.false;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[0].asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);
    const firstCollateralValue = mulPrice(collateralStatesBefore[0].collateralBalance, droppedFirstPrice, collateralInfos[0].scale);
    const secondCollateralValue = mulPrice(collateralStatesBefore[1].collateralBalance, collateralPrices[1], collateralInfos[1].scale);
    const firstSeizedDebtValue = mulFactor(firstCollateralValue, collateralInfos[0].liquidationFactor);
    const secondAvailableDebtValue = mulFactor(secondCollateralValue, collateralInfos[1].liquidationFactor);

    // The first asset cannot close the debt and is fully consumed; the second has more than enough
    // LF-weighted value to close the carried remainder with only a partial seizure.
    expect(firstSeizedDebtValue).to.be.lessThan(borrowValue);
    expect(secondAvailableDebtValue).to.be.greaterThan(borrowValue - firstSeizedDebtValue);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // The first asset is fully drained. The second closes the remaining debt with only the amount
    // required by the full-close formula, leaving the rest of its balance with the borrower.
    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    collateralStatesBefore[0].seizedValue = firstCollateralValue;

    const debtValueAfterFirst = borrowValue - firstSeizedDebtValue;
    collateralStatesBefore[1].seizeAmount = divPrice(debtValueAfterFirst * factorScale / collateralInfos[1].liquidationFactor, collateralPrices[1], collateralInfos[1].scale);
    collateralStatesBefore[1].seizedValue = mulPrice(collateralStatesBefore[1].seizeAmount, collateralPrices[1], collateralInfos[1].scale);

    // Debt is closed in full and the account is no longer liquidatable.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The first asset is fully drained; the second keeps the surplus left after closing the debt.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }

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

    // The deactivated asset no longer freezes borrow-side checks once its balance and bit are cleared.
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Seized collateral moves from supplied totals into reserves; no token leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * A deactivated first collateral and a normal second collateral are both fully consumed when their
 * combined liquidation-factor-weighted value cannot cover the debt. Absorb clears the account and
 * writes the remaining shortfall off through base reserves.
 */
scenario(
  'Comet#absorb > deactivated collateral: 2 collaterals, first asset deactivated first, second asset normal second, full debt close with bad debt',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, cometExt, actors }, context, world) => {
    const { pauseGuardian, albert, betty } = actors;

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

    // Each collateral initially contributes borrowValue of BCF-weighted capacity, so the account is
    // safely collateralized before the price change while both assets remain relevant to the loop.
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
    const collateralAmounts = collateralInfos.map((assetInfo, index) => {
      const collateralValue = borrowValue * factorScale / assetInfo.borrowCollateralFactor;
      return collateralValue * assetInfo.scale / collateralPrices[index];
    });

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

    // Give each collateral only one quarter of the debt in LF-weighted repayment value. Even after
    // both assets are fully seized, half of the debt remains as bad debt.
    const targetSeizedDebtValue = borrowValue / 4n;
    const droppedPrices = collateralInfos.map((assetInfo, index) => {
      const droppedCollateralValue = targetSeizedDebtValue * factorScale / assetInfo.liquidationFactor;
      return droppedCollateralValue * assetInfo.scale / collateralAmounts[index];
    });
    const newPrices: Record<string, bigint> = {};
    for (let i = 0; i < collateralInfos.length; i++) {
      newPrices[collateralInfos[i].asset] = droppedPrices[i];
    }
    await context.changePriceFeeds(newPrices);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.false;

    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.false;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[0].asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    const seizedDebtValues = collateralStatesBefore.map((state, index) => {
      const collateralValue = mulPrice(state.collateralBalance, droppedPrices[index], collateralInfos[index].scale);
      return mulFactor(collateralValue, collateralInfos[index].liquidationFactor);
    });

    // new collateral values * LF < debt value -> bad debt case
    expect(seizedDebtValues[0] + seizedDebtValues[1]).to.be.lessThan(borrowValue);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    for (const collateralState of collateralStatesBefore) {
      collateralState.seizeAmount = collateralState.collateralBalance;
    }

    // Debt is cleared in full and the remaining shortfall is written off through base reserves.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Both collateral balances are fully consumed.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }

    // Both collateral membership bits are cleared.
    expect(cometStateAfter.user.assetsIn).to.equal(0);
    expect(cometStateAfter.user._reserved).to.equal(0);

    // The deactivated asset no longer freezes borrow-side checks once its balance and bit are cleared.
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Seized collateral moves from supplied totals into reserves; no token leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * A normal first collateral is fully consumed before the deactivated second collateral is partially
 * seized. The second asset remains on the open account and restores it to a safe health level while
 * proving deactivation does not exclude collateral from the liquidation-module seizure loop.
 */
scenario(
  'Comet#absorb > deactivated collateral: 2 collaterals, first asset normal first, second asset deactivated second, partial liquidation',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, cometExt, actors }, context, world) => {
    const { pauseGuardian, albert, betty } = actors;

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

    // Keep the debt well above the minimum so both seizures stay in partial mode. Fully seizing the
    // normal first asset repays 60% of the debt; the deactivated second asset is sized inside the band
    // where a partial seizure restores target health and leaves debt above baseBorrowMin.
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    const borrowValue = 20n * minDebtValue;
    const borrowAmount = divPrice(borrowValue, basePrice, baseScale);
    const firstTargetValue = (borrowValue * 6n / 10n) * factorScale / collateralInfos[0].liquidationFactor;
    const secondBcfRatio = (collateralInfos[1].borrowCollateralFactor * factorScale / collateralInfos[1].liquidationFactor + TARGET_HF) / 2n;
    const secondTargetValue = ((borrowValue * 4n / 10n) * secondBcfRatio) / collateralInfos[1].borrowCollateralFactor;
    const collateralAmounts = [
      3n * borrowValue * collateralInfos[0].scale / collateralPrices[0],
      secondTargetValue * collateralInfos[1].scale / collateralPrices[1],
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
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndexes[1]);

    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.false;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[1].asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    const droppedFirstPrice = firstTargetValue * collateralInfos[0].scale / collateralAmounts[0];
    await context.changePriceFeeds({ [collateralInfos[0].asset]: droppedFirstPrice });

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.true;

    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.false;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[1].asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    const firstCollateralValue = mulPrice(collateralStatesBefore[0].collateralBalance, droppedFirstPrice, collateralInfos[0].scale);
    const secondCollateralValue = mulPrice(collateralStatesBefore[1].collateralBalance, collateralPrices[1], collateralInfos[1].scale);

    // healthFactor = (value0*LCF0 + value1*LCF1) / borrowValue
    const liquidityBefore = mulFactor(firstCollateralValue, collateralInfos[0].liquidateCollateralFactor)
      + mulFactor(secondCollateralValue, collateralInfos[1].liquidateCollateralFactor);
    const healthFactorBefore = liquidityBefore * factorScale / borrowValue;
    expect(healthFactorBefore).to.be.lessThan(TARGET_HF);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    collateralStatesBefore[0].seizedValue = mulFactor(firstCollateralValue, collateralInfos[0].liquidationFactor);

    const debtValueAfterFirst = borrowValue - collateralStatesBefore[0].seizedValue;
    const secondTotalCollateralizedValue = mulFactor(secondCollateralValue, collateralInfos[1].borrowCollateralFactor);
    const secondWantedValue = wantedCollateralValue(debtValueAfterFirst, secondTotalCollateralizedValue, collateralInfos[1].liquidationFactor, collateralInfos[1].borrowCollateralFactor);
    collateralStatesBefore[1].seizeAmount = divPrice(secondWantedValue, collateralPrices[1], collateralInfos[1].scale);
    collateralStatesBefore[1].seizedValue = mulFactor(secondWantedValue, collateralInfos[1].liquidationFactor);

    const debtValueRemaining = debtValueAfterFirst - collateralStatesBefore[1].seizedValue;
    const debtRemaining = divPrice(debtValueRemaining, basePrice, baseScale);
    const basePaidOut = -cometStateBefore.userBalance - debtRemaining;
    expect(debtValueRemaining).to.be.greaterThan(minDebtValue);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // The account remains a borrower at the expected reduced balance and principal.
    const expectedPrincipal = principalValue(-debtRemaining, cometStateAfter.totals.baseSupplyIndex, cometStateAfter.totals.baseBorrowIndex);
    expect(cometStateAfter.user.principal).to.equal(expectedPrincipal);
    expect(-cometStateAfter.userBalance).to.equal(debtRemaining);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(debtRemaining);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    const collateralRemaining = collateralStatesBefore.map((state) => state.collateralBalance - state.seizeAmount);
    const liquidityAfter = mulFactor(mulPrice(collateralRemaining[1], collateralPrices[1], collateralInfos[1].scale), collateralInfos[1].liquidateCollateralFactor);
    const healthFactorAfter = liquidityAfter * factorScale / mulPrice(debtRemaining, basePrice, baseScale);
    expect(healthFactorAfter).to.be.greaterThan(TARGET_HF);

    // The normal first asset is fully consumed; the deactivated second asset is partially seized.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].collateralBalance).to.equal(collateralRemaining[i]);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(collateralRemaining[i]);
    }

    // Only the surviving deactivated second asset remains in the collateral membership bitmaps.
    let expectedAssetsIn = cometStateBefore.user.assetsIn;
    let expectedReserved = cometStateBefore.user._reserved;
    if (collateralInfos[0].offset < 16) {
      expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[0].offset);
    } else {
      expectedReserved = expectedReserved & ~(1 << (collateralInfos[0].offset - 16));
    }
    expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
    expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

    // The second asset remains deactivated and on the account, so borrow-side checks stay blocked.
    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[1].asset);
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.true;

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

/**
 * A normal first collateral is fully consumed before the deactivated second collateral closes the
 * remaining debt. Full-close mode seizes only the required amount of the second asset, leaving its
 * surplus on the debt-free account.
 */
scenario(
  'Comet#absorb > deactivated collateral: 2 collaterals, first asset normal first, second asset deactivated second, full debt close',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, cometExt, actors }, context, world) => {
    const { pauseGuardian, albert, betty } = actors;

    const collateralIndexes = await getUsableCollateralIndices(context, 2);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    let collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const collateralAssets = collateralInfos.map(({ asset }) => context.getAssetByAddress(asset));
    const collateralPrices = await Promise.all(collateralInfos.map(async ({ priceFeed }) => (await comet.getPrice(priceFeed)).toBigInt()));

    // Supply a combined value of 4x baseBorrowMin and borrow 2x baseBorrowMin. The deactivated second
    // asset supplies half the debt's LCF-weighted value, which keeps the account liquidatable after
    // the first price drop while its larger LF-weighted value covers the remaining debt with surplus.
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
    const secondSuppliedValue = borrowValue * factorScale / (2n * collateralInfos[1].liquidateCollateralFactor);
    const firstSuppliedValue = 4n * minDebtValue - secondSuppliedValue;
    const collateralAmounts = [
      firstSuppliedValue * collateralInfos[0].scale / collateralPrices[0],
      secondSuppliedValue * collateralInfos[1].scale / collateralPrices[1],
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
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndexes[1]);

    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.false;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[1].asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Fully seizing the normal first asset retires half the debt, leaving the rest for the deactivated
    // second asset.
    const firstDroppedValue = borrowValue * factorScale / (2n * collateralInfos[0].liquidationFactor);
    const droppedFirstPrice = firstDroppedValue * collateralInfos[0].scale / collateralAmounts[0];
    await context.changePriceFeeds({ [collateralInfos[0].asset]: droppedFirstPrice });

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.false;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.false;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[1].asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    const firstCollateralValue = mulPrice(collateralStatesBefore[0].collateralBalance, droppedFirstPrice, collateralInfos[0].scale);
    const secondCollateralValue = mulPrice(collateralStatesBefore[1].collateralBalance, collateralPrices[1], collateralInfos[1].scale);
    const firstSeizedDebtValue = mulFactor(firstCollateralValue, collateralInfos[0].liquidationFactor);
    const secondAvailableDebtValue = mulFactor(secondCollateralValue, collateralInfos[1].liquidationFactor);

    // The first asset cannot close the debt and is fully consumed; the second has more than enough
    // LF-weighted value to close the carried remainder with only a partial seizure.
    expect(firstSeizedDebtValue).to.be.lessThan(borrowValue);
    expect(secondAvailableDebtValue).to.be.greaterThan(borrowValue - firstSeizedDebtValue);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // The normal first asset is fully drained. The deactivated second asset closes the remaining debt
    // with only the amount required by the full-close formula.
    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    collateralStatesBefore[0].seizedValue = firstCollateralValue;

    const debtValueAfterFirst = borrowValue - firstSeizedDebtValue;
    collateralStatesBefore[1].seizeAmount = divPrice(debtValueAfterFirst * factorScale / collateralInfos[1].liquidationFactor, collateralPrices[1], collateralInfos[1].scale);
    collateralStatesBefore[1].seizedValue = mulPrice(collateralStatesBefore[1].seizeAmount, collateralPrices[1], collateralInfos[1].scale);

    // Debt is closed in full and the account is no longer liquidatable.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The normal first asset is fully consumed; the deactivated second asset keeps its closeout surplus.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }

    // Only the surviving deactivated second asset remains in the collateral membership bitmaps.
    let expectedAssetsIn = cometStateBefore.user.assetsIn;
    let expectedReserved = cometStateBefore.user._reserved;
    if (collateralInfos[0].offset < 16) {
      expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[0].offset);
    } else {
      expectedReserved = expectedReserved & ~(1 << (collateralInfos[0].offset - 16));
    }
    expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
    expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

    // Debt-free accounts short-circuit borrow-side collateral checks before reaching deactivated assets.
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.true;

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Seized collateral moves from supplied totals into reserves; no token leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * A normal first collateral and a deactivated second collateral are both exhausted when their
 * combined liquidation-factor-weighted value cannot cover the debt. Absorb clears the borrow and
 * writes the remaining loss off through base reserves.
 */
scenario(
  'Comet#absorb > deactivated collateral: 2 collaterals, first asset normal first, second asset deactivated second, full debt close with bad debt',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, cometExt, actors }, context, world) => {
    const { pauseGuardian, albert, betty } = actors;

    const collateralIndexes = await getUsableCollateralIndices(context, 2);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    let collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const collateralAssets = collateralInfos.map(({ asset }) => context.getAssetByAddress(asset));
    const collateralPrices = await Promise.all(collateralInfos.map(async ({ priceFeed }) => (await comet.getPrice(priceFeed)).toBigInt()));

    // Supply a combined value of 4x baseBorrowMin, split equally between the two assets, and borrow
    // 2x baseBorrowMin.
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
    const suppliedCollateralValue = 2n * minDebtValue;
    const collateralAmounts = collateralInfos.map((assetInfo, index) =>
      suppliedCollateralValue * assetInfo.scale / collateralPrices[index]
    );

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
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndexes[1]);

    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.false;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[1].asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Give each collateral only one quarter of the debt in LF-weighted repayment value. Fully seizing
    // both assets still leaves half of the debt as bad debt.
    const targetSeizedDebtValue = borrowValue / 4n;
    const droppedPrices = collateralInfos.map((assetInfo, index) => {
      const droppedCollateralValue = targetSeizedDebtValue * factorScale / assetInfo.liquidationFactor;
      return droppedCollateralValue * assetInfo.scale / collateralAmounts[index];
    });
    const newPrices: Record<string, bigint> = {};
    for (let i = 0; i < collateralInfos.length; i++) {
      newPrices[collateralInfos[i].asset] = droppedPrices[i];
    }
    await context.changePriceFeeds(newPrices);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.false;

    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.false;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[1].asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    const seizedDebtValues = collateralStatesBefore.map((state, index) => {
      const collateralValue = mulPrice(state.collateralBalance, droppedPrices[index], collateralInfos[index].scale);
      return mulFactor(collateralValue, collateralInfos[index].liquidationFactor);
    });

    // new collateral values * LF < debt value -> bad debt case
    expect(seizedDebtValues[0] + seizedDebtValues[1]).to.be.lessThan(borrowValue);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    for (const collateralState of collateralStatesBefore) {
      collateralState.seizeAmount = collateralState.collateralBalance;
    }

    // Debt is cleared in full and the remaining shortfall is written off through base reserves.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Both collateral balances are fully consumed.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }

    expect(cometStateAfter.user.assetsIn).to.equal(0);
    expect(cometStateAfter.user._reserved).to.equal(0);

    // Debt-free accounts short-circuit borrow-side collateral checks before reaching deactivated assets.
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.true;

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Seized collateral moves from supplied totals into reserves; no token leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * A deactivated collateral with zero borrow collateral factor still retains positive liquidation
 * factors. Full-close mode can therefore seize it to close the debt while leaving the surplus on
 * the debt-free account.
 */
scenario(
  'Comet#absorb > deactivated collateral: 1 collateral, BCF = 0, full debt close mode',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, cometExt, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, pauseGuardian, albert, betty } = actors;
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
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance removes the asset's borrow-side support and installs a fresh liquidation module
    // against the updated Comet asset list.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    assetInfo = await getAssetInfo(comet, collateralIndex);
    let module = await configureModule(context, world, 'absorb', false, betty.address);

    expect(assetInfo.borrowCollateralFactor).to.equal(0n);
    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Drop the collateral value between debt / LF and debt / LCF. Its LF-weighted value can close
    // the debt, while its LCF-weighted value leaves the account liquidatable.
    const minimumCollateralValue = borrowValue * factorScale / assetInfo.liquidationFactor;
    const maximumCollateralValue = borrowValue * factorScale / assetInfo.liquidateCollateralFactor;
    const targetCollateralValue = (minimumCollateralValue + maximumCollateralValue) / 2n;
    const droppedPrice = targetCollateralValue * assetInfo.scale / collateralAmount;
    await context.changePriceFeeds({ [assetInfo.asset]: droppedPrice });

    assetInfo = await getAssetInfo(comet, collateralIndex);
    module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.false;

    expect(assetInfo.borrowCollateralFactor).to.equal(0n);
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

    collateralStateBefore.seizeAmount = divPrice(borrowValue * factorScale / assetInfo.liquidationFactor, droppedPrice, assetInfo.scale);
    collateralStateBefore.seizedValue = mulPrice(collateralStateBefore.seizeAmount, droppedPrice, assetInfo.scale);

    // Debt is closed in full and the account is no longer liquidatable.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Only the amount required to close the debt is seized, so collateral membership is unchanged.
    const remainingCollateral = collateralStateBefore.collateralBalance - collateralStateBefore.seizeAmount;
    expect(collateralStateAfter.collateralBalance).to.equal(remainingCollateral);
    expect(collateralStateAfter.userCollateral.balance).to.equal(remainingCollateral);

    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    // Debt-free accounts short-circuit borrow-side collateral checks before reaching deactivated assets.
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

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
 * A deactivated collateral with zero liquidate collateral factor contributes no liquidation
 * liquidity and is valued at zero by the module's cached-price path. Absorb drains the full balance
 * and writes the debt off through base reserves.
 */
scenario(
  'Comet#absorb > deactivated collateral: 1 collateral, LCF = 0, full debt close mode',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, cometExt, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, pauseGuardian, albert, betty } = actors;
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
    const collateralPrice = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    const suppliedCollateralValue = 4n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPrice;
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // LCF cannot be zero while BCF remains positive, so governance first removes borrow support and
    // then liquidation health before installing a fresh module against the updated asset list.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    assetInfo = await getAssetInfo(comet, collateralIndex);
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.false;

    expect(assetInfo.borrowCollateralFactor).to.equal(0n);
    expect(assetInfo.liquidateCollateralFactor).to.equal(0n);
    expect(assetInfo.liquidationFactor).to.be.greaterThan(0n);

    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    // At its real oracle price the collateral could cover the debt, but zero LCF makes the module's
    // cached collateral price zero and routes the entire balance through full seizure.
    const collateralValueAfterLF = mulFactor(
      mulPrice(collateralStateBefore.collateralBalance, collateralPrice, assetInfo.scale),
      assetInfo.liquidationFactor
    );
    expect(collateralValueAfterLF).to.be.greaterThan(borrowValue);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    collateralStateBefore.seizeAmount = collateralStateBefore.collateralBalance;
    collateralStateBefore.seizedValue = mulPrice(collateralStateBefore.seizeAmount, collateralPrice, assetInfo.scale);

    // Debt is cleared in full and the remaining shortfall is written off through base reserves.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    expect(collateralStateAfter.collateralBalance).to.equal(0n);
    expect(collateralStateAfter.userCollateral.balance).to.equal(0n);

    expect(cometStateAfter.user.assetsIn).to.equal(0);
    expect(cometStateAfter.user._reserved).to.equal(0);

    // Debt-free accounts short-circuit borrow-side collateral checks before reaching deactivated assets.
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Full seizure moves all supplied collateral into reserves; no token leaves Comet.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * A deactivated collateral with zero borrow collateral factor remains liquidatable while LCF and LF
 * stay positive. If its LF-weighted value falls below the debt, absorb drains the entire asset and
 * writes the uncovered shortfall off through base reserves.
 */
scenario(
  'Comet#absorb > deactivated collateral: 1 collateral, BCF = 0, bad debt case',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, cometExt, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, pauseGuardian, albert, betty } = actors;
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
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance removes borrow-side support and installs a fresh liquidation module against the
    // updated asset list. LCF and LF remain positive.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    assetInfo = await getAssetInfo(comet, collateralIndex);
    let module = await configureModule(context, world, 'absorb', false, betty.address);

    expect(assetInfo.borrowCollateralFactor).to.equal(0n);
    expect(assetInfo.liquidateCollateralFactor).to.be.greaterThan(0n);
    expect(assetInfo.liquidationFactor).to.be.greaterThan(0n);
    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Even a full seizure now repays only half the debt at LF, leaving the rest as bad debt.
    const targetCollateralValue = borrowValue * factorScale / assetInfo.liquidationFactor / 2n;
    const droppedPrice = targetCollateralValue * assetInfo.scale / collateralAmount;
    await context.changePriceFeeds({ [assetInfo.asset]: droppedPrice });

    assetInfo = await getAssetInfo(comet, collateralIndex);
    module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.false;

    expect(assetInfo.borrowCollateralFactor).to.equal(0n);
    expect(assetInfo.liquidateCollateralFactor).to.be.greaterThan(0n);
    expect(assetInfo.liquidationFactor).to.be.greaterThan(0n);

    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    const collateralValue = mulPrice(collateralStateBefore.collateralBalance, droppedPrice, assetInfo.scale);
    const collateralRepaymentValue = mulFactor(collateralValue, assetInfo.liquidationFactor);
    expect(collateralRepaymentValue).to.be.lessThan(borrowValue); // Collateral value * LF < debt value -> bad debt case

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    collateralStateBefore.seizeAmount = collateralStateBefore.collateralBalance;
    collateralStateBefore.seizedValue = collateralValue;

    // Debt is cleared in full and the remaining shortfall is written off through base reserves.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    expect(collateralStateAfter.collateralBalance).to.equal(0n);
    expect(collateralStateAfter.userCollateral.balance).to.equal(0n);

    expect(cometStateAfter.user.assetsIn).to.equal(0);
    expect(cometStateAfter.user._reserved).to.equal(0);

    // Debt-free accounts short-circuit borrow-side collateral checks before reaching deactivated assets.
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Full seizure moves all supplied collateral into reserves; no token leaves Comet.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * A deactivated collateral with zero liquidate collateral factor is fully seized after its real
 * LF-weighted value also falls below the debt. The module clears the uncovered borrow as bad debt
 * through base reserves.
 */
scenario(
  'Comet#absorb > deactivated collateral: 1 collateral, LCF = 0, bad debt case',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, cometExt, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, pauseGuardian, albert, betty } = actors;
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
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance first removes BCF, then zeroes LCF and installs a fresh module against the updated
    // asset list. LF remains positive for seizure accounting.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    assetInfo = await getAssetInfo(comet, collateralIndex);

    // Drop the real oracle value until even the full LF-weighted balance covers only half the debt.
    // The LCF-zero cached-price path also values it at zero during seizure planning.
    const targetCollateralValue = borrowValue * factorScale / assetInfo.liquidationFactor / 2n;
    const droppedPrice = targetCollateralValue * assetInfo.scale / collateralAmount;
    await context.changePriceFeeds({ [assetInfo.asset]: droppedPrice });

    assetInfo = await getAssetInfo(comet, collateralIndex);
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.false;

    expect(assetInfo.borrowCollateralFactor).to.equal(0n);
    expect(assetInfo.liquidateCollateralFactor).to.equal(0n);
    expect(assetInfo.liquidationFactor).to.be.greaterThan(0n);

    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(assetInfo.asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    const collateralValue = mulPrice(collateralStateBefore.collateralBalance, droppedPrice, assetInfo.scale);
    const collateralRepaymentValue = mulFactor(collateralValue, assetInfo.liquidationFactor);

    expect(collateralRepaymentValue).to.be.lessThan(borrowValue); // Collateral value * LF < debt value -> bad debt case

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    collateralStateBefore.seizeAmount = collateralStateBefore.collateralBalance;
    collateralStateBefore.seizedValue = collateralValue;

    // Debt is cleared in full and the remaining shortfall is written off through base reserves.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    expect(collateralStateAfter.collateralBalance).to.equal(0n);
    expect(collateralStateAfter.userCollateral.balance).to.equal(0n);
    expect(cometStateAfter.user.assetsIn).to.equal(0);
    expect(cometStateAfter.user._reserved).to.equal(0);

    // Debt-free accounts short-circuit borrow-side collateral checks before reaching deactivated assets.
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndex)).to.be.true;

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Full seizure moves all supplied collateral into reserves; no token leaves Comet.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * A deactivated first collateral with zero borrow collateral factor remains seizable while LCF and
 * LF stay positive. Full-close mode exhausts it after a price drop, then the normal second asset
 * closes the remaining debt with a partial seizure.
 */
scenario(
  'Comet#absorb > deactivated collateral: 2 collaterals, first asset BCF = 0, full debt close mode',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, cometExt, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, pauseGuardian, albert, betty } = actors;
    const collateralIndexes = await getUsableCollateralIndices(context, 2);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    let collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const collateralAssets = collateralInfos.map(({ asset }) => context.getAssetByAddress(asset));
    const collateralPrices = await Promise.all(collateralInfos.map(async ({ priceFeed }) => (await comet.getPrice(priceFeed)).toBigInt()));
    const secondBorrowCollateralFactor = collateralInfos[1].borrowCollateralFactor;

    // Supply a combined value of 4x baseBorrowMin and borrow 2x baseBorrowMin. The normal second asset
    // carries half the debt's LCF-weighted value, so its larger LF-weighted value can close the
    // residual left after the first asset with a surplus.
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
    const secondSuppliedValue = borrowValue * factorScale / (2n * collateralInfos[1].liquidateCollateralFactor);
    const firstSuppliedValue = 4n * minDebtValue - secondSuppliedValue;
    const collateralAmounts = [
      firstSuppliedValue * collateralInfos[0].scale / collateralPrices[0],
      secondSuppliedValue * collateralInfos[1].scale / collateralPrices[1],
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

    // Governance removes only the first asset's borrow support and installs a fresh module against
    // the updated asset list.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      collateralInfos[0].asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));

    // Fully seizing the BCF-zero first asset retires half the debt, leaving the rest for the normal
    // second asset.
    const firstDroppedValue = borrowValue * factorScale / (2n * collateralInfos[0].liquidationFactor);
    const droppedFirstPrice = firstDroppedValue * collateralInfos[0].scale / collateralAmounts[0];
    await context.changePriceFeeds({ [collateralInfos[0].asset]: droppedFirstPrice });

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.false;

    expect(collateralInfos[0].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(secondBorrowCollateralFactor);

    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.false;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[0].asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    const firstCollateralValue = mulPrice(collateralStatesBefore[0].collateralBalance, droppedFirstPrice, collateralInfos[0].scale);
    const secondCollateralValue = mulPrice(collateralStatesBefore[1].collateralBalance, collateralPrices[1], collateralInfos[1].scale);
    const firstSeizedDebtValue = mulFactor(firstCollateralValue, collateralInfos[0].liquidationFactor);
    const secondAvailableDebtValue = mulFactor(secondCollateralValue, collateralInfos[1].liquidationFactor);

    expect(firstSeizedDebtValue).to.be.lessThan(borrowValue);
    expect(secondAvailableDebtValue).to.be.greaterThan(borrowValue - firstSeizedDebtValue);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    collateralStatesBefore[0].seizedValue = firstCollateralValue;

    const debtValueAfterFirst = borrowValue - firstSeizedDebtValue;
    collateralStatesBefore[1].seizeAmount = divPrice(debtValueAfterFirst * factorScale / collateralInfos[1].liquidationFactor, collateralPrices[1], collateralInfos[1].scale);
    collateralStatesBefore[1].seizedValue = mulPrice(collateralStatesBefore[1].seizeAmount, collateralPrices[1], collateralInfos[1].scale);

    // Debt is closed in full and the account is no longer liquidatable.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The BCF-zero first asset is fully consumed; the normal second asset keeps its closeout surplus.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }

    // Only the surviving normal second asset remains in the collateral membership bitmaps.
    let expectedAssetsIn = cometStateBefore.user.assetsIn;
    let expectedReserved = cometStateBefore.user._reserved;
    if (collateralInfos[0].offset < 16) {
      expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[0].offset);
    } else {
      expectedReserved = expectedReserved & ~(1 << (collateralInfos[0].offset - 16));
    }
    expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
    expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Seized collateral moves from supplied totals into reserves; no token leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * A deactivated first collateral with zero liquidate collateral factor is fully seized at zero
 * cached value. The normal second collateral then supplies all repayment value needed to close the
 * debt and keeps its surplus.
 */
scenario(
  'Comet#absorb > deactivated collateral: 2 collaterals, first asset LCF = 0, full debt close mode',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, cometExt, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, pauseGuardian, albert, betty } = actors;
    const collateralIndexes = await getUsableCollateralIndices(context, 2);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    let collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const collateralAssets = collateralInfos.map(({ asset }) => context.getAssetByAddress(asset));
    const collateralPrices = await Promise.all(collateralInfos.map(async ({ priceFeed }) => (await comet.getPrice(priceFeed)).toBigInt()));
    const secondBorrowCollateralFactor = collateralInfos[1].borrowCollateralFactor;

    // Supply a combined value of 4x baseBorrowMin, weighted toward the normal second asset, and
    // borrow 2x baseBorrowMin. The split keeps the initial account healthy while leaving room to
    // drop the second asset into its full-close surplus window.
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
    const firstSuppliedValue = minDebtValue;
    const secondSuppliedValue = 3n * minDebtValue;
    const collateralAmounts = [
      firstSuppliedValue * collateralInfos[0].scale / collateralPrices[0],
      secondSuppliedValue * collateralInfos[1].scale / collateralPrices[1],
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

    // Governance first removes BCF, then zeroes LCF on the deactivated first asset and installs a
    // fresh module against the updated asset list.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      collateralInfos[0].asset,
      0
    );
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(
      comet.address,
      collateralInfos[0].asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));

    // Keep the normal second asset between debt / LF and debt / LCF, but below its original supplied
    // value so the governance price-feed update is a genuine price drop.
    const minimumSecondValue = borrowValue * factorScale / collateralInfos[1].liquidationFactor;
    const maximumSecondValue = borrowValue * factorScale / collateralInfos[1].liquidateCollateralFactor;
    const maximumDroppedSecondValue = secondSuppliedValue * 99n / 100n;
    const upperSecondValue = maximumSecondValue < maximumDroppedSecondValue
      ? maximumSecondValue
      : maximumDroppedSecondValue;
    const targetSecondValue = (minimumSecondValue + upperSecondValue) / 2n;
    const droppedSecondPrice = targetSecondValue * collateralInfos[1].scale / collateralAmounts[1];
    await context.changePriceFeeds({ [collateralInfos[1].asset]: droppedSecondPrice });

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.false;

    expect(collateralInfos[0].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[0].liquidateCollateralFactor).to.equal(0n);
    expect(collateralInfos[0].liquidationFactor).to.be.greaterThan(0n);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(secondBorrowCollateralFactor);

    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.false;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[0].asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    const secondCollateralValue = mulPrice(collateralStatesBefore[1].collateralBalance, droppedSecondPrice, collateralInfos[1].scale);
    const secondAvailableDebtValue = mulFactor(secondCollateralValue, collateralInfos[1].liquidationFactor);

    expect(secondAvailableDebtValue).to.be.greaterThan(borrowValue);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // LCF zero leaves the first asset's cached price at zero, so it is fully seized without reducing
    // debt. The normal second asset then closes the entire borrow with a partial seizure.
    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    collateralStatesBefore[1].seizeAmount = divPrice(borrowValue * factorScale / collateralInfos[1].liquidationFactor, droppedSecondPrice, collateralInfos[1].scale);
    collateralStatesBefore[1].seizedValue = mulPrice(collateralStatesBefore[1].seizeAmount, droppedSecondPrice, collateralInfos[1].scale);

    // Debt is closed in full and the account is no longer liquidatable.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The LCF-zero first asset is fully consumed; the normal second asset keeps its closeout surplus.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }

    // Only the surviving normal second asset remains in the collateral membership bitmaps.
    let expectedAssetsIn = cometStateBefore.user.assetsIn;
    let expectedReserved = cometStateBefore.user._reserved;
    if (collateralInfos[0].offset < 16) {
      expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[0].offset);
    } else {
      expectedReserved = expectedReserved & ~(1 << (collateralInfos[0].offset - 16));
    }
    expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
    expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Seized collateral moves from supplied totals into reserves; no token leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * A deactivated first collateral with zero borrow collateral factor and a normal second collateral
 * are both exhausted when their combined LF-weighted value cannot cover the debt. Absorb clears the
 * account and writes the remaining shortfall off through base reserves.
 */
scenario(
  'Comet#absorb > deactivated collateral: 2 collaterals, first asset BCF = 0, bad debt case',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, cometExt, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, pauseGuardian, albert, betty } = actors;
    const collateralIndexes = await getUsableCollateralIndices(context, 2);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    let collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const collateralAssets = collateralInfos.map(({ asset }) => context.getAssetByAddress(asset));
    const collateralPrices = await Promise.all(collateralInfos.map(async ({ priceFeed }) => (await comet.getPrice(priceFeed)).toBigInt()));
    const secondBorrowCollateralFactor = collateralInfos[1].borrowCollateralFactor;

    // Supply a combined value of 4x baseBorrowMin and borrow 2x baseBorrowMin. This split gives the
    // normal second asset half the debt's LCF-weighted value and keeps the account healthy before
    // the first asset's borrow support is removed.
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
    const secondSuppliedValue = borrowValue * factorScale / (2n * collateralInfos[1].liquidateCollateralFactor);
    const firstSuppliedValue = 4n * minDebtValue - secondSuppliedValue;
    const collateralAmounts = [
      firstSuppliedValue * collateralInfos[0].scale / collateralPrices[0],
      secondSuppliedValue * collateralInfos[1].scale / collateralPrices[1],
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

    // Governance removes the first asset's borrow support and installs a fresh module against the
    // updated asset list.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      collateralInfos[0].asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));

    // Give each collateral only one quarter of the debt in LF-weighted repayment value. Fully
    // seizing both assets still leaves half of the debt as bad debt.
    const targetSeizedDebtValue = borrowValue / 4n;
    const droppedPrices = collateralInfos.map((assetInfo, index) => {
      const droppedCollateralValue = targetSeizedDebtValue * factorScale / assetInfo.liquidationFactor;
      return droppedCollateralValue * assetInfo.scale / collateralAmounts[index];
    });
    const newPrices: Record<string, bigint> = {};
    for (let i = 0; i < collateralInfos.length; i++) {
      newPrices[collateralInfos[i].asset] = droppedPrices[i];
    }
    await context.changePriceFeeds(newPrices);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.false;

    expect(collateralInfos[0].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(secondBorrowCollateralFactor);

    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.false;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[0].asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    const seizedDebtValues = collateralStatesBefore.map((state, index) => {
      const collateralValue = mulPrice(state.collateralBalance, droppedPrices[index], collateralInfos[index].scale);
      return mulFactor(collateralValue, collateralInfos[index].liquidationFactor);
    });

    // new collateral values * LF < debt value -> bad debt case
    expect(seizedDebtValues[0] + seizedDebtValues[1]).to.be.lessThan(borrowValue);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    for (const collateralState of collateralStatesBefore) {
      collateralState.seizeAmount = collateralState.collateralBalance;
    }

    // Debt is cleared in full and the remaining shortfall is written off through base reserves.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Both collateral balances are fully consumed.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }

    // Both collateral membership bits are cleared.
    expect(cometStateAfter.user.assetsIn).to.equal(0);
    expect(cometStateAfter.user._reserved).to.equal(0);

    // Debt-free accounts short-circuit borrow-side collateral checks before reaching deactivated assets.
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Full seizure moves all supplied collateral into reserves; no token leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * A deactivated first collateral with zero liquidate collateral factor contributes no liquidation
 * value. The normal second collateral is also exhausted when its LF-weighted value cannot cover the
 * debt, and absorb writes the remaining shortfall off through base reserves.
 */
scenario(
  'Comet#absorb > deactivated collateral: 2 collaterals, first asset LCF = 0, bad debt case',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, cometExt, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, pauseGuardian, albert, betty } = actors;
    const collateralIndexes = await getUsableCollateralIndices(context, 2);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    let collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const collateralAssets = collateralInfos.map(({ asset }) => context.getAssetByAddress(asset));
    const collateralPrices = await Promise.all(collateralInfos.map(async ({ priceFeed }) => (await comet.getPrice(priceFeed)).toBigInt()));
    const secondBorrowCollateralFactor = collateralInfos[1].borrowCollateralFactor;

    // Supply a combined value of 4x baseBorrowMin, weighted toward the normal second asset, and
    // borrow 2x baseBorrowMin. The account is healthy before the first asset's factors are zeroed.
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
    const firstSuppliedValue = minDebtValue;
    const secondSuppliedValue = 3n * minDebtValue;
    const collateralAmounts = [
      firstSuppliedValue * collateralInfos[0].scale / collateralPrices[0],
      secondSuppliedValue * collateralInfos[1].scale / collateralPrices[1],
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

    // Governance first removes BCF, then zeroes LCF on the deactivated first asset and installs a
    // fresh module against the updated asset list.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      collateralInfos[0].asset,
      0
    );
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(
      comet.address,
      collateralInfos[0].asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));

    // The first asset contributes zero cached liquidation value. Drop the normal second asset until
    // even its full LF-weighted value covers only half the debt.
    const targetSecondValue = borrowValue * factorScale / (2n * collateralInfos[1].liquidationFactor);
    const droppedSecondPrice = targetSecondValue * collateralInfos[1].scale / collateralAmounts[1];
    await context.changePriceFeeds({ [collateralInfos[1].asset]: droppedSecondPrice });

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.false;

    expect(collateralInfos[0].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[0].liquidateCollateralFactor).to.equal(0n);
    expect(collateralInfos[0].liquidationFactor).to.be.greaterThan(0n);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(secondBorrowCollateralFactor);

    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[1])).to.be.false;

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
      .withArgs(collateralInfos[0].asset);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    const secondCollateralValue = mulPrice(collateralStatesBefore[1].collateralBalance, droppedSecondPrice, collateralInfos[1].scale);
    const secondAvailableDebtValue = mulFactor(secondCollateralValue, collateralInfos[1].liquidationFactor);

    // First collateral value is zero and second collateral value * LF < debt value -> bad debt case
    expect(secondAvailableDebtValue).to.be.lessThan(borrowValue);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    for (const collateralState of collateralStatesBefore) {
      collateralState.seizeAmount = collateralState.collateralBalance;
    }

    // Debt is cleared in full and the remaining shortfall is written off through base reserves.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Both collateral balances are fully consumed.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }

    // Both collateral membership bits are cleared.
    expect(cometStateAfter.user.assetsIn).to.equal(0);
    expect(cometStateAfter.user._reserved).to.equal(0);

    // Debt-free accounts short-circuit borrow-side collateral checks before reaching deactivated assets.
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await cometExt.isCollateralDeactivated(collateralIndexes[0])).to.be.true;

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Full seizure moves all supplied collateral into reserves; no token leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);
