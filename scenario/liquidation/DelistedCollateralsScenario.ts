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
 * Delisted and deactivated collateral scenarios for the liquidation module.
 *
 * These cases use Comet.absorb directly. Configuration, prices and collateral amounts are derived
 * from each deployment rather than relying on development-market constants.
 */

/**
 * A soft-delisted collateral has no borrow capacity (BCF = 0), but remains eligible for seizure
 * while its LCF and LF stay positive. Once a price drop makes the account liquidatable, the partial
 * target-health calculation falls through the minimum-debt closeout and seizes only enough collateral
 * to close the debt, leaving the rest with the borrower.
 */
scenario(
  'Comet#absorb > 1 soft delisted collateral: BCF = 0, partial seizure',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    await context.zeroBorrowRates();

    let assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPriceBeforeDrop = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    // Supply collateral worth 4x the deployment's minimum debt and borrow 2x the minimum.
    // collateralAmount = 4 * minDebtValue * collateralScale / collateralPrice.
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    const suppliedCollateralValue = 4n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPriceBeforeDrop;
    const borrowAmount = 2n * baseBorrowMin;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance soft-delists the selected collateral and installs a fresh module bound to the new
    // Comet asset list.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    assetInfo = await getAssetInfo(comet, collateralIndex);
    let module = await configureModule(context, world, 'absorb', true, betty.address);

    expect(assetInfo.borrowCollateralFactor).to.equal(0n);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Drop the collateral value into the band where LF-weighted value still covers the full debt,
    // but LCF-weighted value does not. The account becomes liquidatable immediately while absorb
    // can still close all debt by seizing only part of the collateral.
    const debtBeforeDrop = await comet.borrowBalanceOf(albert.address);
    const debtValueBeforeDrop = mulPrice(debtBeforeDrop, basePrice, baseScale);
    const minimumCollateralValue = debtValueBeforeDrop * factorScale / assetInfo.liquidationFactor;
    const maximumCollateralValue = debtValueBeforeDrop * factorScale / assetInfo.liquidateCollateralFactor;
    const targetCollateralValue = (minimumCollateralValue + maximumCollateralValue) / 2n;
    const droppedPrice = targetCollateralValue * assetInfo.scale / collateralAmount;

    await context.changePriceFeeds({ [assetInfo.asset]: droppedPrice });

    // changePriceFeeds upgrades Comet and refreshes the module, so use the active module and asset
    // configuration for every subsequent calculation and synchronization check.
    module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(assetInfo.borrowCollateralFactor).to.equal(0n);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    // Capture the complete base/collateral state immediately before direct Comet.absorb.
    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(
      comet,
      context,
      albert.address,
      [assetInfo]
    );
    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(
      comet,
      context,
      albert.address,
      [assetInfo]
    );
    // Borrow rates are zero, so absorb uses the same debt value calculated before the price drop.
    // A full debt close seizes exactly debt / LF worth of collateral.
    collateralStateBefore.seizeAmount = divPrice(debtValueBeforeDrop * factorScale / assetInfo.liquidationFactor, droppedPrice, assetInfo.scale);
    collateralStateBefore.seizedValue = mulPrice(collateralStateBefore.seizeAmount, droppedPrice, assetInfo.scale);

    // Debt is closed and the account is no longer liquidatable.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Absorb restored the account's health: the debt is cleared, so there is nothing left to liquidate
    // and the position is borrow-collateralized again (health factor is no longer a finite number).
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;

    // Only the computed amount is seized. Some collateral remains, so its assetsIn bit and the
    // user's reserved bits are unchanged.
    const remainingCollateral = collateralStateBefore.collateralBalance - collateralStateBefore.seizeAmount;
    expect(collateralStateAfter.collateralBalance).to.equal(remainingCollateral);
    expect(collateralStateAfter.userCollateral.balance).to.equal(remainingCollateral);
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    // Borrow principal is removed while supply principal is unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

    // Collateral accounting moves the seized amount from supplied collateral into reserves without
    // transferring ERC20 tokens out of Comet.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Borrow rates are frozen and absorb leaves Comet's base-token balance untouched, so reserves
    // decrease by the borrower's full debt (userBalance is negative).
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * Full-close mode routes a soft-delisted collateral directly through debt closeout. Positive LCF
 * and LF keep the asset liquidatable, so absorb seizes exactly debt / LF worth of collateral and
 * leaves the surplus with the borrower even though BCF is zero.
 */
scenario(
  'Comet#absorb > 1 soft delisted collateral: BCF = 0, close-debt mode leaves collateral',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    await context.zeroBorrowRates();

    let assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPriceBeforeDrop = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    // Supply collateral worth 4x the deployment's minimum debt and borrow 2x the minimum.
    // collateralAmount = 4 * minDebtValue * collateralScale / collateralPrice.
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    const suppliedCollateralValue = 4n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPriceBeforeDrop;
    const borrowAmount = 2n * baseBorrowMin;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance soft-delists the selected collateral and installs a fresh module in full-close mode.
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
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Drop the collateral value into the band where LF-weighted value still covers the full debt,
    // but LCF-weighted value does not. The account becomes immediately liquidatable with surplus
    // collateral available after the full debt close.
    const debtBeforeDrop = await comet.borrowBalanceOf(albert.address);
    const debtValueBeforeDrop = mulPrice(debtBeforeDrop, basePrice, baseScale);
    const minimumCollateralValue = debtValueBeforeDrop * factorScale / assetInfo.liquidationFactor;
    const maximumCollateralValue = debtValueBeforeDrop * factorScale / assetInfo.liquidateCollateralFactor;
    const targetCollateralValue = (minimumCollateralValue + maximumCollateralValue) / 2n;
    const droppedPrice = targetCollateralValue * assetInfo.scale / collateralAmount;

    await context.changePriceFeeds({ [assetInfo.asset]: droppedPrice });

    // changePriceFeeds refreshes the module, so restore full-close mode on the active module.
    module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.false;
    expect(assetInfo.borrowCollateralFactor).to.equal(0n);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    // Capture the complete base/collateral state immediately before direct Comet.absorb.
    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(
      comet,
      context,
      albert.address,
      [assetInfo]
    );
    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(
      comet,
      context,
      albert.address,
      [assetInfo]
    );

    // Borrow rates are zero, so absorb uses the same debt value calculated before the price drop.
    // Full-close mode seizes exactly debt / LF worth of collateral.
    collateralStateBefore.seizeAmount = divPrice(debtValueBeforeDrop * factorScale / assetInfo.liquidationFactor, droppedPrice, assetInfo.scale);
    collateralStateBefore.seizedValue = mulPrice(collateralStateBefore.seizeAmount, droppedPrice, assetInfo.scale);

    // Debt is closed and the account is no longer liquidatable.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Only the computed amount is seized. Some collateral remains, so its assetsIn bit and the
    // user's reserved bits are unchanged.
    const remainingCollateral = collateralStateBefore.collateralBalance - collateralStateBefore.seizeAmount;
    expect(collateralStateAfter.collateralBalance).to.equal(remainingCollateral);
    expect(collateralStateAfter.userCollateral.balance).to.equal(remainingCollateral);
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    // Borrow principal is removed while supply principal is unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

    // Collateral accounting moves the seized amount from supplied collateral into reserves without
    // transferring ERC20 tokens out of Comet.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Borrow rates are frozen and absorb leaves Comet's base-token balance untouched, so reserves
    // decrease by the borrower's full debt (userBalance is negative).
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * With two collaterals, the BCF-zero first asset carries nearly all of the target-health seizure.
 * Integer rounding leaves the account just below the target, so the loop takes a dust amount from
 * the normal second asset and stops with healthy debt still above the minimum.
 */
scenario(
  'Comet#absorb > 2 collaterals: soft delisted first, normal second, partial seizure',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
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

    // Give the normal second asset enough BCF-weighted value to leave roughly 2x baseBorrowMin of
    // debt after the first target-health seizure. Its supplied market value follows from its BCF.
    const targetSecondCollateralizedValue = 2n * mulFactor(minDebtValue, TARGET_HF);
    const secondSuppliedValue = targetSecondCollateralizedValue * factorScale / collateralInfos[1].borrowCollateralFactor;
    const secondCollateralAmount = secondSuppliedValue * collateralInfos[1].scale / collateralPrices[1];
    const secondCollateralValue = mulPrice(secondCollateralAmount, collateralPrices[1], collateralInfos[1].scale);
    const totalCollateralizedValue = mulFactor(secondCollateralValue, collateralInfos[1].borrowCollateralFactor);
    const secondLiquidationValue = mulFactor(secondCollateralValue, collateralInfos[1].liquidateCollateralFactor);

    // The delisted first asset (BCF = 0) only has a real price window while its target-health wanted
    // value stays below the largest first-asset value at which the account is still liquidatable. With
    // BCF0 = 0 both are linear in the debt D (T = second asset's BCF-weighted value):
    //   wanted(D)    = (D*targetHF - T) / (LF0*targetHF)
    //   maxLiquid(D) = (D - secondLiquidationValue) / LCF0
    // Since LCF0 < LF0, wanted < maxLiquid holds for every D above a single threshold; solving that
    // inequality for D gives it in closed form:
    //   D > (secondLiquidationValue*LF0*targetHF - T*LCF0) / (targetHF*(LF0 - LCF0))
    // Borrow twice that threshold (and never below 4x the min debt) so the window is comfortably open.
    const firstWindowThreshold =
      (mulFactor(secondLiquidationValue, mulFactor(collateralInfos[0].liquidationFactor, TARGET_HF))
        - mulFactor(totalCollateralizedValue, collateralInfos[0].liquidateCollateralFactor))
      * factorScale
      / mulFactor(collateralInfos[0].liquidationFactor - collateralInfos[0].liquidateCollateralFactor, TARGET_HF);
    const borrowValue = 2n * (firstWindowThreshold > 2n * minDebtValue ? firstWindowThreshold : 2n * minDebtValue);

    const borrowAmount = divPrice(borrowValue, basePrice, baseScale);
    const firstSuppliedValue = borrowValue * factorScale / collateralInfos[0].borrowCollateralFactor * 110n / 100n;
    const firstCollateralAmount = firstSuppliedValue * collateralInfos[0].scale / collateralPrices[0];
    const collateralAmounts = [firstCollateralAmount, secondCollateralAmount];

    for (let i = 0; i < collateralInfos.length; i++) {
      await context.sourceTokens(collateralAmounts[i], collateralAssets[i], albert);
      await collateralAssets[i].approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralInfos[i].asset, amount: collateralAmounts[i] });
    }

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance soft-delists only the first collateral and installs a fresh partial-mode module.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, collateralInfos[0].asset, 0);
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    let module = await configureModule(context, world, 'absorb', true, betty.address);

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Drop only the first asset to the midpoint between the target-health wanted value and the
    // liquidatable upper bound. The first asset remains large enough for a partial seizure.
    const debtBeforeDrop = await comet.borrowBalanceOf(albert.address);
    const debtValueBeforeDrop = mulPrice(debtBeforeDrop, basePrice, baseScale);
    const firstWantedValue = wantedCollateralValue(debtValueBeforeDrop, totalCollateralizedValue, collateralInfos[0].liquidationFactor, 0n);
    const firstLiquidatableMaxValue = (debtValueBeforeDrop - secondLiquidationValue) * factorScale / collateralInfos[0].liquidateCollateralFactor;
    const targetFirstCollateralValue = (firstWantedValue + firstLiquidatableMaxValue) / 2n;
    const droppedFirstPrice = targetFirstCollateralValue * collateralInfos[0].scale / firstCollateralAmount;

    await context.changePriceFeeds({ [collateralInfos[0].asset]: droppedFirstPrice });

    module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.true;
    expect(collateralInfos[0].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(secondBorrowCollateralFactor);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    // Capture the pre-absorb state; the seizure plan is mirrored independently after the action.
    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // Independently mirror both target-health iterations. Borrow rates are zero, so the seizure
    // plan uses the debt value calculated before the price drop.
    const firstSeizeWantedValue = wantedCollateralValue(debtValueBeforeDrop, totalCollateralizedValue, collateralInfos[0].liquidationFactor, 0n);
    collateralStatesBefore[0].seizeAmount = divPrice(firstSeizeWantedValue, droppedFirstPrice, collateralInfos[0].scale);
    collateralStatesBefore[0].seizedValue = mulFactor(firstSeizeWantedValue, collateralInfos[0].liquidationFactor);

    const debtValueAfterFirstSeize = debtValueBeforeDrop - collateralStatesBefore[0].seizedValue;
    const secondWantedValue = wantedCollateralValue(
      debtValueAfterFirstSeize,
      totalCollateralizedValue,
      collateralInfos[1].liquidationFactor,
      collateralInfos[1].borrowCollateralFactor
    );
    collateralStatesBefore[1].seizeAmount = divPrice(secondWantedValue, collateralPrices[1], collateralInfos[1].scale);
    collateralStatesBefore[1].seizedValue = mulFactor(secondWantedValue, collateralInfos[1].liquidationFactor);

    const debtValueRemaining = debtValueAfterFirstSeize - collateralStatesBefore[1].seizedValue;
    const debtRemaining = divPrice(debtValueRemaining, basePrice, baseScale);
    const basePaidOut = debtBeforeDrop.toBigInt() - debtRemaining;

    expect(debtRemaining).to.be.greaterThan(baseBorrowMin);
    expect(collateralStatesBefore[1].seizeAmount).to.be.greaterThan(0n);

    // Debt remains open at the expected reduced balance and principal, but the account is healthy.
    const expectedPrincipal = principalValue(-debtRemaining, cometStateAfter.totals.baseSupplyIndex, cometStateAfter.totals.baseBorrowIndex);
    expect(cometStateAfter.user.principal).to.equal(expectedPrincipal);
    expect(-cometStateAfter.userBalance).to.equal(debtRemaining);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(debtRemaining);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Absorb restored the account's health: against the reduced debt, the remaining collateral's
    // LCF-weighted value now clears the target health factor.
    //   healthFactor = (value0*LCF0 + value1*LCF1) / debtValue
    const firstCollateralValueAfter = mulPrice(collateralStatesAfter[0].collateralBalance, droppedFirstPrice, collateralInfos[0].scale);
    const secondCollateralValueAfter = mulPrice(collateralStatesAfter[1].collateralBalance, collateralPrices[1], collateralInfos[1].scale);
    const liquidityAfter = mulFactor(firstCollateralValueAfter, collateralInfos[0].liquidateCollateralFactor) + mulFactor(secondCollateralValueAfter, collateralInfos[1].liquidateCollateralFactor);
    const healthFactorAfter = liquidityAfter * factorScale / mulPrice(-cometStateAfter.userBalance, basePrice, baseScale);
    expect(healthFactorAfter).to.be.greaterThan(TARGET_HF);

    // Both collateral balances are reduced by their computed seizure amounts and both remain listed.
    for (let i = 0; i < collateralInfos.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    // Only the repaid principal leaves total borrows; total supply and Comet's base balance are unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal).sub(cometStateAfter.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Each collateral's supplied total falls by its seizure and its reserves rise by the same amount;
    // no collateral ERC20 leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    // Borrow rates are frozen, so base reserves fall by exactly the base amount repaid.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves - basePaidOut);
  }
);

/**
 * Full-close mode with a soft-delisted first asset that cannot cover the debt on its own. Partial
 * liquidation is disabled, so absorb runs the plain full-close formula on every asset in index order:
 * the first (BCF = 0, dropped so its LF-weighted value is below the debt) is fully seized, and the
 * remaining debt is closed on the normal second asset, which is only partially seized and keeps its
 * surplus.
 */
scenario(
  'Comet#absorb > 2 collaterals: soft delisted first fully seized, normal second closes the debt, full-close mode',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
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

    // Supply a combined value of 4x the min debt and borrow 2x. The second asset holds enough that its
    // LCF-weighted value is half the debt: on its own it keeps the account liquidatable-safe, while its
    // LF-weighted value covers the residual left after the first asset with a surplus. The first asset
    // takes the rest of the budget and is dropped below the debt later so its full seizure falls short.
    //   secondSuppliedValue = borrowValue / (2 * LCF1)
    //   firstSuppliedValue  = 4 * minDebtValue - secondSuppliedValue
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
    const secondSuppliedValue = borrowValue * factorScale / (2n * collateralInfos[1].liquidateCollateralFactor);
    const firstSuppliedValue = 4n * minDebtValue - secondSuppliedValue;
    const firstCollateralAmount = firstSuppliedValue * collateralInfos[0].scale / collateralPrices[0];
    const secondCollateralAmount = secondSuppliedValue * collateralInfos[1].scale / collateralPrices[1];
    const collateralAmounts = [firstCollateralAmount, secondCollateralAmount];

    for (let i = 0; i < collateralInfos.length; i++) {
      await context.sourceTokens(collateralAmounts[i], collateralAssets[i], albert);
      await collateralAssets[i].approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralInfos[i].asset, amount: collateralAmounts[i] });
    }

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance soft-delists only the first collateral and installs a fresh full-close module.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, collateralInfos[0].asset, 0);
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    let module = await configureModule(context, world, 'absorb', false, betty.address);

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Drop only the first asset so its full seizure retires just half the debt (LF-weighted), leaving
    // the rest for the second. firstDroppedValue = (borrowValue / 2) / LF0.
    const debtBeforeDrop = await comet.borrowBalanceOf(albert.address);
    const debtValueBeforeDrop = mulPrice(debtBeforeDrop, basePrice, baseScale);
    const firstDroppedValue = debtValueBeforeDrop * factorScale / (2n * collateralInfos[0].liquidationFactor);
    const droppedFirstPrice = firstDroppedValue * collateralInfos[0].scale / firstCollateralAmount;

    await context.changePriceFeeds({ [collateralInfos[0].asset]: droppedFirstPrice });

    module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.false;
    expect(collateralInfos[0].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(secondBorrowCollateralFactor);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    // Capture the pre-absorb state; the seizure plan is mirrored independently after the action.
    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // Independently mirror the full-close seizure. Borrow rates are zero, so the plan uses the debt
    // value calculated before the price drop.
    // First asset: its LF-weighted value is below the debt, so full-close mode drains it.
    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    collateralStatesBefore[0].seizedValue = mulPrice(collateralStatesBefore[0].seizeAmount, droppedFirstPrice, collateralInfos[0].scale);
    const debtValueAfterFirst = debtValueBeforeDrop - mulFactor(collateralStatesBefore[0].seizedValue, collateralInfos[0].liquidationFactor);

    // Second asset: covers the remainder with the plain full-close formula, so only the slice the debt
    // needs is seized and a surplus remains. seizeAmount = (remainingDebt / LF1) / price.
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

    // assetsIn keeps only the surviving second asset; the fully-seized first asset's bit is cleared, in
    // whichever bitfield its index falls, and _reserved is otherwise untouched.
    let expectedAssetsIn = cometStateBefore.user.assetsIn;
    let expectedReserved = cometStateBefore.user._reserved;
    if (collateralInfos[0].offset < 16) {
      expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[0].offset);
    } else {
      expectedReserved = expectedReserved & ~(1 << (collateralInfos[0].offset - 16));
    }
    expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
    expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

    // Borrow principal is removed while supply principal is unchanged; Comet's base balance is untouched.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Each collateral's supplied total falls by its seizure and its reserves rise by the same amount;
    // no collateral ERC20 leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    // Borrow rates are frozen and absorb leaves Comet's base-token balance untouched, so base reserves
    // fall by the borrower's full debt (userBalance is negative).
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * The normal first collateral cannot restore target health and is fully seized. The later
 * soft-delisted collateral still has positive LCF and LF, so partial mode uses it to close the
 * remaining debt while leaving its surplus with the borrower.
 */
scenario(
  'Comet#absorb > 2 collaterals: normal first, soft delisted second, partial seizure closes debt',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
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
    const firstBorrowCollateralFactor = collateralInfos[0].borrowCollateralFactor;

    // Supply 4x the deployment's minimum-debt value in total, split equally between both assets,
    // and borrow 2x baseBorrowMin. Once the second BCF is zeroed, the first asset alone no longer
    // supports the borrow.
    const borrowAmount = 2n * baseBorrowMin;
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    const firstSuppliedValue = 2n * minDebtValue;
    const secondSuppliedValue = 2n * minDebtValue;
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

    // Governance soft-delists only the second collateral and installs a fresh partial-mode module.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, collateralInfos[1].asset, 0);
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    let module = await configureModule(context, world, 'absorb', true, betty.address);

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The first asset's full seizure repays half the debt. Size the second asset between the amount
    // needed to cover the remainder and the maximum that keeps the whole account liquidatable.
    const debtBeforeDrop = await comet.borrowBalanceOf(albert.address);
    const debtValueBeforeDrop = mulPrice(debtBeforeDrop, basePrice, baseScale);

    const firstDroppedValue = debtValueBeforeDrop * factorScale / 2n / collateralInfos[0].liquidationFactor;
    const firstLiquidationValue = mulFactor(firstDroppedValue, collateralInfos[0].liquidateCollateralFactor);
    
    const debtValueAfterFirstTarget = debtValueBeforeDrop - debtValueBeforeDrop / 2n;
    
    const secondSeizedValueMax = (debtValueBeforeDrop - firstLiquidationValue) * factorScale / collateralInfos[1].liquidateCollateralFactor * collateralInfos[1].liquidationFactor / factorScale;
    const secondSeizedValueTarget = (debtValueAfterFirstTarget + secondSeizedValueMax) / 2n;
    const secondDroppedValue = secondSeizedValueTarget * factorScale / collateralInfos[1].liquidationFactor;

    const droppedPrices = [
      firstDroppedValue * collateralInfos[0].scale / collateralAmounts[0],
      secondDroppedValue * collateralInfos[1].scale / collateralAmounts[1],
    ];

    await context.changePriceFeeds({
      [collateralInfos[0].asset]: droppedPrices[0],
      [collateralInfos[1].asset]: droppedPrices[1],
    });

    module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.true;
    expect(collateralInfos[0].borrowCollateralFactor).to.equal(firstBorrowCollateralFactor);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(0n);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    // Capture state immediately before absorb.
    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // Independently mirror the full first seizure and second-asset closeout after absorb.
    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    const firstCollateralValue = mulPrice(collateralStatesBefore[0].seizeAmount, droppedPrices[0], collateralInfos[0].scale);
    collateralStatesBefore[0].seizedValue = mulFactor(firstCollateralValue, collateralInfos[0].liquidationFactor);

    const debtValueAfterFirstSeize = debtValueBeforeDrop - collateralStatesBefore[0].seizedValue;
    collateralStatesBefore[1].seizeAmount = divPrice(debtValueAfterFirstSeize * factorScale / collateralInfos[1].liquidationFactor, droppedPrices[1], collateralInfos[1].scale);
    collateralStatesBefore[1].seizedValue = debtValueAfterFirstSeize;

    // Debt is closed and the debt-free account is healthy again.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The normal first asset is fully seized; the soft-delisted second asset closes the debt and
    // keeps its surplus.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }

    // assetsIn keeps only the surviving second asset; clear the first asset's bit while preserving
    // every other reserved bit.
    let expectedAssetsIn = cometStateBefore.user.assetsIn;
    let expectedReserved = cometStateBefore.user._reserved;
    if (collateralInfos[0].offset < 16) {
      expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[0].offset);
    } else {
      expectedReserved = expectedReserved & ~(1 << (collateralInfos[0].offset - 16));
    }
    expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
    expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

    // Borrow principal is removed while supply principal and Comet's base balance are unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Each collateral's supplied total falls by its seizure and its reserves rise by the same amount;
    // no collateral ERC20 leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    // Borrow rates are frozen, so base reserves fall by the full absorbed debt.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * Full-close mode with a normal first asset and a soft-delisted second asset — the full-close twin of
 * the partial-mode scenario above. Partial liquidation is disabled, but the end state matches the
 * closeout branch exactly: the first asset is fully seized, then the second asset (BCF = 0, positive
 * LCF/LF) closes the remaining debt with a partial seizure and keeps its surplus. Proves full-close and
 * the partial-mode closeout produce the same end state here.
 */
scenario(
  'Comet#absorb > 2 collaterals: normal first fully seized, soft delisted second closes debt, full-close mode',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
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
    const firstBorrowCollateralFactor = collateralInfos[0].borrowCollateralFactor;

    // Supply 4x the min-debt value in total, split equally between both assets, and borrow 2x
    // baseBorrowMin. Once the second BCF is zeroed, the first asset alone no longer supports the borrow.
    const borrowAmount = 2n * baseBorrowMin;
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    const firstSuppliedValue = 2n * minDebtValue;
    const secondSuppliedValue = 2n * minDebtValue;
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

    // Governance soft-delists only the second collateral and installs a fresh full-close module.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, collateralInfos[1].asset, 0);
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    let module = await configureModule(context, world, 'absorb', false, betty.address);

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The first asset's full seizure repays half the debt. Size the second asset between the amount
    // needed to cover the remainder and the maximum that keeps the whole account liquidatable.
    const debtBeforeDrop = await comet.borrowBalanceOf(albert.address);
    const debtValueBeforeDrop = mulPrice(debtBeforeDrop, basePrice, baseScale);

    const firstDroppedValue = debtValueBeforeDrop * factorScale / 2n / collateralInfos[0].liquidationFactor;
    const firstLiquidationValue = mulFactor(firstDroppedValue, collateralInfos[0].liquidateCollateralFactor);

    const debtValueAfterFirstTarget = debtValueBeforeDrop - debtValueBeforeDrop / 2n;

    const secondSeizedValueMax = (debtValueBeforeDrop - firstLiquidationValue) * factorScale / collateralInfos[1].liquidateCollateralFactor * collateralInfos[1].liquidationFactor / factorScale;
    const secondSeizedValueTarget = (debtValueAfterFirstTarget + secondSeizedValueMax) / 2n;
    const secondDroppedValue = secondSeizedValueTarget * factorScale / collateralInfos[1].liquidationFactor;

    const droppedPrices = [
      firstDroppedValue * collateralInfos[0].scale / collateralAmounts[0],
      secondDroppedValue * collateralInfos[1].scale / collateralAmounts[1],
    ];

    await context.changePriceFeeds({
      [collateralInfos[0].asset]: droppedPrices[0],
      [collateralInfos[1].asset]: droppedPrices[1],
    });

    module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.false;
    expect(collateralInfos[0].borrowCollateralFactor).to.equal(firstBorrowCollateralFactor);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(0n);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    // Capture the pre-absorb state; the seizure plan is mirrored independently after the action.
    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);
    const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // Independently mirror the full-close seizure. Borrow rates are zero, so the debt the plan used
    // equals the captured pre-absorb debt.
    // First asset: its LF-weighted value is below the debt, so full-close mode drains it.
    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    const firstCollateralValue = mulPrice(collateralStatesBefore[0].seizeAmount, droppedPrices[0], collateralInfos[0].scale);
    collateralStatesBefore[0].seizedValue = mulFactor(firstCollateralValue, collateralInfos[0].liquidationFactor);

    // Second asset: covers the remainder with the plain full-close formula, so only the slice the debt
    // needs is seized and a surplus remains. seizeAmount = (remainingDebt / LF1) / price.
    const debtValueAfterFirstSeize = debtValueBefore - collateralStatesBefore[0].seizedValue;
    collateralStatesBefore[1].seizeAmount = divPrice(debtValueAfterFirstSeize * factorScale / collateralInfos[1].liquidationFactor, droppedPrices[1], collateralInfos[1].scale);
    collateralStatesBefore[1].seizedValue = mulPrice(collateralStatesBefore[1].seizeAmount, droppedPrices[1], collateralInfos[1].scale);

    // Debt is closed in full and the debt-free account is healthy again.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The normal first asset is fully drained; the soft-delisted second closes the debt and keeps surplus.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }

    // assetsIn keeps only the surviving second asset; the fully-seized first asset's bit is cleared, in
    // whichever bitfield its index falls, and _reserved is otherwise untouched.
    let expectedAssetsIn = cometStateBefore.user.assetsIn;
    let expectedReserved = cometStateBefore.user._reserved;
    if (collateralInfos[0].offset < 16) {
      expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[0].offset);
    } else {
      expectedReserved = expectedReserved & ~(1 << (collateralInfos[0].offset - 16));
    }
    expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
    expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

    // Borrow principal is removed while supply principal is unchanged; Comet's base balance is untouched.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Each collateral's supplied total falls by its seizure and its reserves rise by the same amount;
    // no collateral ERC20 leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    // Borrow rates are frozen and absorb leaves Comet's base-token balance untouched, so base reserves
    // fall by the borrower's full debt (userBalance is negative).
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * Full delist: governance zeroes both BCF and LCF while leaving LF positive. With LCF = 0 the module's
 * liquidity pass skips the asset's price feed (it no longer counts toward liquidation health), so the
 * seizure values the collateral at zero. The account is liquidatable the instant the delist lands, and
 * absorb fully seizes the collateral and writes the whole debt off from reserves as bad debt — even
 * though the collateral's real market value still exceeds the debt. No price move needed.
 */
scenario(
  'Comet#absorb > 1 fully delisted collateral: BCF = 0, LCF = 0, full seizure with bad-debt write-off',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    await context.zeroBorrowRates();

    let assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPrice = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    // Supply collateral worth 4x the min debt and borrow 2x. At its price the collateral comfortably
    // covers the borrow, so the account starts borrow-collateralized and not liquidatable.
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    const suppliedCollateralValue = 4n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPrice;
    const borrowAmount = 2n * baseBorrowMin;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance FULLY delists the collateral — both BCF and LCF set to zero, LF left positive — and
    // installs a fresh module. With zero liquidation health the account is liquidatable immediately,
    // with no price move.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, assetInfo.asset, 0);
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, assetInfo.asset, 0);
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    assetInfo = await getAssetInfo(comet, collateralIndex);
    const module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    // Fresh module is bound to Comet's asset list, both factors are zeroed (LF still positive), and the
    // account is liquidatable from the delist alone — no price drop.
    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(assetInfo.borrowCollateralFactor).to.equal(0n);
    expect(assetInfo.liquidateCollateralFactor).to.equal(0n);
    expect(assetInfo.liquidationFactor).to.be.greaterThan(0n);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    // Capture the pre-absorb state; the seizure is mirrored independently after the action.
    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);
    const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);

    // The collateral's real LF-weighted value still exceeds the debt, so at face value it could cover it.
    // But the full delist (LCF = 0) makes the module's liquidity pass skip this asset's price feed, so the
    // seizure values it at zero: absorb drains the whole balance and writes the entire debt off as bad debt.
    const collateralValueAfterLF = mulFactor(mulPrice(collateralStateBefore.collateralBalance, collateralPrice, assetInfo.scale), assetInfo.liquidationFactor);
    expect(collateralValueAfterLF).to.be.greaterThan(debtValueBefore);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    // Valued at zero by the module, the whole collateral balance is seized and the full debt is written off.
    collateralStateBefore.seizeAmount = collateralStateBefore.collateralBalance;
    collateralStateBefore.seizedValue = mulPrice(collateralStateBefore.seizeAmount, collateralPrice, assetInfo.scale);

    // Debt is cleared and the account is no longer liquidatable.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The full collateral balance is seized; its assetsIn bit is cleared and _reserved is untouched.
    expect(collateralStateAfter.collateralBalance).to.equal(0n);
    expect(collateralStateAfter.userCollateral.balance).to.equal(0n);
    let expectedAssetsIn = cometStateBefore.user.assetsIn;
    let expectedReserved = cometStateBefore.user._reserved;
    if (assetInfo.offset < 16) {
      expectedAssetsIn = expectedAssetsIn & ~(1 << assetInfo.offset);
    } else {
      expectedReserved = expectedReserved & ~(1 << (assetInfo.offset - 16));
    }
    expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
    expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

    // Borrow principal is removed while supply principal is unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

    // Collateral accounting: supplied total falls by the full seized amount, reserves rise by it, and no
    // collateral or base ERC20 leaves Comet.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Base reserves fall by the FULL debt — the bad-debt write-off (userBalance is negative).
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * Fully delisted first asset, normal second asset, partial liquidation that leaves a borrow. The first
 * asset (BCF = 0, LCF = 0) is valued at zero by the module's liquidity pass, so absorb drains its whole
 * balance without paying down the debt; the normal second asset then takes a target-health partial
 * seizure that restores the position and leaves the user borrowing. Proves a delisted asset is consumed
 * first, then a healthy asset partially covers the debt without a full close.
 */
scenario(
  'Comet#absorb > 2 collaterals: fully delisted first drained, normal second partially seized, borrow remains',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
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

    // A target-health partial seizure leaves debt above baseBorrowMin only when debt value D exceeds:
    //   D > m * LCF2 * (targetHF * LF2 - BCF2) / (BCF2 * (LF2 - LCF2))
    // Borrow twice the larger of that threshold and 2x min debt so the partial window remains open
    // across markets even when LF2 and LCF2 are close.
    const seizeFormulaDenominator = mulFactor(collateralInfos[1].liquidationFactor, TARGET_HF) - collateralInfos[1].borrowCollateralFactor;
    const partialWindowThreshold = minDebtValue * collateralInfos[1].liquidateCollateralFactor * seizeFormulaDenominator
      / (collateralInfos[1].borrowCollateralFactor * (collateralInfos[1].liquidationFactor - collateralInfos[1].liquidateCollateralFactor));
    const minimumDebtValue = 2n * minDebtValue;
    const borrowValue = 2n * (partialWindowThreshold > minimumDebtValue ? partialWindowThreshold : minimumDebtValue);
    const borrowAmount = divPrice(borrowValue, basePrice, baseScale);

    // The normal second asset alone initially has 110% of the borrow capacity needed for the debt.
    // The first asset carries one minimum-debt unit of value and will be drained after full delisting.
    const firstSuppliedValue = minDebtValue;
    const secondSuppliedValue = borrowValue * factorScale / collateralInfos[1].borrowCollateralFactor * 110n / 100n;
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

    // Governance FULLY delists only the first collateral (BCF and LCF to zero, LF positive) and installs
    // a fresh partial-mode module.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, collateralInfos[0].asset, 0);
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, collateralInfos[0].asset, 0);
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    let module = await configureModule(context, world, 'absorb', true, betty.address);

    expect(collateralInfos[0].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[0].liquidateCollateralFactor).to.equal(0n);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(secondBorrowCollateralFactor); // no need to check LCF > 0, due to condition BCF < LCF < LF
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Drop the second asset into the single-collateral partial window (it is the only collateral the
    // module now values, since the first is valued at zero). The midpoint keeps the account liquidatable
    // while a target-health seizure of the second leaves the debt above the minimum.
    //   guardFloorValue      = D/LF2 + m*(targetHF*LF2 - BCF2) / (LF2*BCF2)   (debt stays above min)
    //   liquidatableMaxValue = D/LCF2                                          (account stays liquidatable)
    const debtValueBeforeDrop = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
    const guardFloorValue = (debtValueBeforeDrop * factorScale) / collateralInfos[1].liquidationFactor
      + (minDebtValue * seizeFormulaDenominator * factorScale) / (collateralInfos[1].liquidationFactor * collateralInfos[1].borrowCollateralFactor);
    const liquidatableMaxValue = (debtValueBeforeDrop * factorScale) / collateralInfos[1].liquidateCollateralFactor;
    const targetSecondValue = (guardFloorValue + liquidatableMaxValue) / 2n;
    const droppedSecondPrice = targetSecondValue * collateralInfos[1].scale / collateralAmounts[1];
    await context.changePriceFeeds({ [collateralInfos[1].asset]: droppedSecondPrice });

    module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.true;
    expect(collateralInfos[0].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[0].liquidateCollateralFactor).to.equal(0n);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(secondBorrowCollateralFactor);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    // Capture the pre-absorb state; the seizure is mirrored independently after the action.
    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);
    const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // First asset: valued at zero by the module (LCF = 0 skips its price), so it is fully drained without
    // paying down the debt.
    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    collateralStatesBefore[0].seizedValue = 0n;

    // Second asset: the only collateral the module values, so when the loop reaches it the debt is still
    // the full debt and the collateralized value is the second's BCF-weighted value alone. A target-health
    // partial seizure runs on it.
    const secondCollateralValue = mulPrice(collateralStatesBefore[1].collateralBalance, droppedSecondPrice, collateralInfos[1].scale);
    const totalCollateralizedValue = mulFactor(secondCollateralValue, collateralInfos[1].borrowCollateralFactor);
    const wantedSecond = wantedCollateralValue(debtValueBefore, totalCollateralizedValue, collateralInfos[1].liquidationFactor, collateralInfos[1].borrowCollateralFactor);
    collateralStatesBefore[1].seizeAmount = divPrice(wantedSecond, droppedSecondPrice, collateralInfos[1].scale);
    collateralStatesBefore[1].seizedValue = mulFactor(wantedSecond, collateralInfos[1].liquidationFactor);

    const debtValueRemaining = debtValueBefore - collateralStatesBefore[1].seizedValue;
    const debtRemaining = divPrice(debtValueRemaining, basePrice, baseScale);
    const basePaidOut = -cometStateBefore.userBalance - debtRemaining;

    // The second seizure is a genuine partial that leaves the debt above the minimum.
    expect(debtRemaining).to.be.greaterThan(baseBorrowMin);

    // The user remains a borrower at the expected reduced balance and principal.
    const expectedPrincipal = principalValue(-debtRemaining, cometStateAfter.totals.baseSupplyIndex, cometStateAfter.totals.baseBorrowIndex);
    expect(cometStateAfter.user.principal).to.equal(expectedPrincipal);
    expect(-cometStateAfter.userBalance).to.equal(debtRemaining);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(debtRemaining);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The partial seizure restores the remaining borrow to the module's target health factor.
    const secondCollateralValueAfter = mulPrice(collateralStatesAfter[1].collateralBalance, droppedSecondPrice, collateralInfos[1].scale);
    const healthFactorAfter = mulFactor(secondCollateralValueAfter, collateralInfos[1].liquidateCollateralFactor) * factorScale / mulPrice(-cometStateAfter.userBalance, basePrice, baseScale);
    expect(healthFactorAfter).to.be.greaterThan(TARGET_HF);

    // First asset is fully drained; second keeps its surplus after the partial seizure.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }

    // assetsIn keeps only the surviving second asset; the fully-seized first asset's bit is cleared and
    // _reserved is otherwise untouched.
    let expectedAssetsIn = cometStateBefore.user.assetsIn;
    let expectedReserved = cometStateBefore.user._reserved;
    if (collateralInfos[0].offset < 16) {
      expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[0].offset);
    } else {
      expectedReserved = expectedReserved & ~(1 << (collateralInfos[0].offset - 16));
    }
    expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
    expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

    // Borrow base drops by the principal actually repaid; supply base and Comet's base balance unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal).sub(cometStateAfter.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Each collateral's supplied total falls by its seizure and its reserves rise by the same amount; no
    // collateral ERC20 leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    // Base reserves fall only by the base actually paid out — the part of the debt the second asset covered.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves - basePaidOut);
  }
);

/**
 * Fully delisted first asset, normal second asset, partial mode closing the full debt. The first
 * asset is valued at zero and fully drained; the normal second asset covers the debt with only part
 * of its balance, leaving its surplus with the user.
 */
scenario(
  'Comet#absorb > 2 collaterals: first asset delisted first, second asset normal second, full debt close leaves second asset',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
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

    // Put the normal second asset midway between debt / LF and debt / LCF. It can cover all debt at
    // LF while its LCF-weighted value remains below debt. The fully delisted first asset receives the
    // remainder of the combined 4x-minimum collateral value.
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
    const minimumSecondValue = borrowValue * factorScale / collateralInfos[1].liquidationFactor;
    const maximumSecondValue = borrowValue * factorScale / collateralInfos[1].liquidateCollateralFactor;
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

    // Governance fully delists only the first collateral and installs a fresh partial-mode module.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, collateralInfos[0].asset, 0);
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, collateralInfos[0].asset, 0);
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.true;
    expect(collateralInfos[0].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[0].liquidateCollateralFactor).to.equal(0n);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(secondBorrowCollateralFactor); // no need to check LCF > 0, due to condition BCF < LCF < LF
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // The fully delisted first asset is drained at zero value. The second asset then closes the full
    // debt by contributing debt / LF worth of collateral.
    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    collateralStatesBefore[0].seizedValue = 0n;
    collateralStatesBefore[1].seizeAmount = divPrice(borrowValue * factorScale / collateralInfos[1].liquidationFactor, collateralPrices[1], collateralInfos[1].scale);
    collateralStatesBefore[1].seizedValue = mulPrice(collateralStatesBefore[1].seizeAmount, collateralPrices[1], collateralInfos[1].scale);

    // Debt is fully closed and the debt-free account is healthy again.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // First asset is fully drained; second keeps the surplus left after closing the debt.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }

    // assetsIn keeps only the surviving second asset.
    let expectedAssetsIn = cometStateBefore.user.assetsIn;
    let expectedReserved = cometStateBefore.user._reserved;
    if (collateralInfos[0].offset < 16) {
      expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[0].offset);
    } else {
      expectedReserved = expectedReserved & ~(1 << (collateralInfos[0].offset - 16));
    }
    expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
    expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

    // Borrow principal is removed while supply principal and Comet's base balance are unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Both collateral totals fall by their seizures, reserves rise by the same amounts, and no
    // collateral ERC20 leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    // Borrow rates are frozen, so base reserves fall by the full absorbed debt.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * Fully delisted first asset followed by an under-collateralized normal second asset. Both balances
 * are consumed, but their liquidation value cannot cover the debt, so absorb clears the borrow and
 * records the remaining shortfall through base reserves.
 */
scenario(
  'Comet#absorb > 2 collaterals: first asset delisted first, second asset normal second, bad debt with nothing remaining',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
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

    // Supply 4x the deployment's minimum-debt value, split equally between both assets, and borrow
    // 2x baseBorrowMin. After the first asset is fully delisted, the second asset's LF-weighted value
    // is below the debt because its gross value only equals the debt and LF is below one.
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
    const collateralAmounts = collateralInfos.map(({ scale }, i) => 2n * minDebtValue * scale / collateralPrices[i]);

    for (let i = 0; i < collateralInfos.length; i++) {
      await context.sourceTokens(collateralAmounts[i], collateralAssets[i], albert);
      await collateralAssets[i].approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralInfos[i].asset, amount: collateralAmounts[i] });
    }

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance fully delists only the first collateral and installs a fresh partial-mode module.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, collateralInfos[0].asset, 0);
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, collateralInfos[0].asset, 0);
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.true;
    expect(collateralInfos[0].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[0].liquidateCollateralFactor).to.equal(0n);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(secondBorrowCollateralFactor);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // The fully delisted first asset contributes no debt value. The normal second asset is also fully
    // seized, but its LF-weighted value remains below the debt, proving this is the bad-debt branch.
    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    collateralStatesBefore[0].seizedValue = 0n;
    collateralStatesBefore[1].seizeAmount = collateralStatesBefore[1].collateralBalance;
    const secondCollateralValue = mulPrice(collateralStatesBefore[1].seizeAmount, collateralPrices[1], collateralInfos[1].scale);
    collateralStatesBefore[1].seizedValue = mulFactor(secondCollateralValue, collateralInfos[1].liquidationFactor);
    expect(collateralStatesBefore[1].seizedValue).to.be.lessThan(borrowValue);

    // Absorb clears the full borrow even though the collateral cannot cover it.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Both collateral balances are fully consumed.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }

    // Both membership bitfields are empty because every collateral balance was consumed.
    expect(cometStateAfter.user.assetsIn).to.equal(0);
    expect(cometStateAfter.user._reserved).to.equal(0);

    // Borrow principal is removed while supply principal and Comet's base balance are unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Both collateral totals fall by their full balances, reserves rise by the same amounts, and no
    // collateral ERC20 leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    // The full debt is written off through base reserves, not capped by the second asset's coverage.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * Normal first asset followed by a fully delisted second asset. The first asset's partial seizure
 * restores target health and leaves debt open, so the loop stops before the zero-LCF second asset;
 * both collateral balances remain with the user.
 */
scenario(
  'Comet#absorb > 2 collaterals: first asset normal first, second asset delisted second, partial position leaves both assets',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
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
    const firstBorrowCollateralFactor = collateralInfos[0].borrowCollateralFactor;

    // A target-health partial seizure leaves debt above baseBorrowMin only when debt value D exceeds:
    //   D > m * LCF1 * (targetHF * LF1 - BCF1) / (BCF1 * (LF1 - LCF1))
    // Borrow twice the larger of that threshold and 2x min debt so the partial window stays open
    // across markets even when LF1 and LCF1 are close.
    const seizeFormulaDenominator = mulFactor(collateralInfos[0].liquidationFactor, TARGET_HF) - collateralInfos[0].borrowCollateralFactor;
    const partialWindowThreshold = minDebtValue * seizeFormulaDenominator * collateralInfos[0].liquidateCollateralFactor
      / (collateralInfos[0].borrowCollateralFactor * (collateralInfos[0].liquidationFactor - collateralInfos[0].liquidateCollateralFactor));
    const minimumDebtValue = 2n * minDebtValue;
    const targetBorrowValue = 2n * (partialWindowThreshold > minimumDebtValue ? partialWindowThreshold : minimumDebtValue);
    const borrowAmount = divPrice(targetBorrowValue, basePrice, baseScale);
    const debtValueBeforeDrop = mulPrice(borrowAmount, basePrice, baseScale);

    // Put the normal first asset at the midpoint of its valid partial-liquidation window.
    const guardFloorValue = debtValueBeforeDrop * factorScale / collateralInfos[0].liquidationFactor
      + minDebtValue * seizeFormulaDenominator * factorScale / (collateralInfos[0].liquidationFactor * collateralInfos[0].borrowCollateralFactor);
    const liquidatableMaxValue = debtValueBeforeDrop * factorScale / collateralInfos[0].liquidateCollateralFactor;
    const targetFirstValue = (guardFloorValue + liquidatableMaxValue) / 2n;

    // Size the soon-to-be-delisted second asset from the larger of the exact BCF and LCF deficits at
    // the dropped first-asset value. The 10% margin keeps the account healthy before delisting despite
    // token and oracle rounding; after delisting, the first asset alone is liquidatable.
    const firstBorrowValueAfterDrop = mulFactor(targetFirstValue, collateralInfos[0].borrowCollateralFactor);
    const firstLiquidationValueAfterDrop = mulFactor(targetFirstValue, collateralInfos[0].liquidateCollateralFactor);
    const secondValueForBorrowSupport = (debtValueBeforeDrop - firstBorrowValueAfterDrop) * factorScale / collateralInfos[1].borrowCollateralFactor;
    const secondValueForLiquidationSupport = (debtValueBeforeDrop - firstLiquidationValueAfterDrop) * factorScale / collateralInfos[1].liquidateCollateralFactor;
    const requiredSecondValue = secondValueForBorrowSupport > secondValueForLiquidationSupport ? secondValueForBorrowSupport : secondValueForLiquidationSupport;
    const firstSuppliedValue = targetFirstValue * 110n / 100n;
    const secondSuppliedValue = requiredSecondValue * 110n / 100n;
    const collateralAmounts = [
      firstSuppliedValue * collateralInfos[0].scale / collateralPrices[0],
      secondSuppliedValue * collateralInfos[1].scale / collateralPrices[1],
    ];
    const droppedFirstPrice = targetFirstValue * collateralInfos[0].scale / collateralAmounts[0];

    for (let i = 0; i < collateralInfos.length; i++) {
      await context.sourceTokens(collateralAmounts[i], collateralAssets[i], albert);
      await collateralAssets[i].approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralInfos[i].asset, amount: collateralAmounts[i] });
    }

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    // Drop the first asset into the partial-seizure window while the second asset still supports the
    // account. The position remains healthy until governance fully delists the second collateral.
    await context.changePriceFeeds({ [collateralInfos[0].asset]: droppedFirstPrice });
    await comet.accrueAccount(albert.address);

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance fully delists only the second collateral and installs a fresh partial-mode module.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, collateralInfos[1].asset, 0);
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, collateralInfos[1].asset, 0);
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.true;
    expect(collateralInfos[0].borrowCollateralFactor).to.equal(firstBorrowCollateralFactor);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[1].liquidateCollateralFactor).to.equal(0n);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // The normal first asset reaches target health with a partial seizure. The loop then stops before
    // the fully delisted second asset, leaving its full balance untouched.
    const firstCollateralValue = mulPrice(collateralStatesBefore[0].collateralBalance, droppedFirstPrice, collateralInfos[0].scale);
    const totalCollateralizedValue = mulFactor(firstCollateralValue, collateralInfos[0].borrowCollateralFactor);
    const wantedFirstValue = wantedCollateralValue(debtValueBeforeDrop, totalCollateralizedValue, collateralInfos[0].liquidationFactor, collateralInfos[0].borrowCollateralFactor);
    collateralStatesBefore[0].seizeAmount = divPrice(wantedFirstValue, droppedFirstPrice, collateralInfos[0].scale);
    collateralStatesBefore[0].seizedValue = mulFactor(wantedFirstValue, collateralInfos[0].liquidationFactor);

    const debtValueRemaining = debtValueBeforeDrop - collateralStatesBefore[0].seizedValue;
    const debtRemaining = divPrice(debtValueRemaining, basePrice, baseScale);
    const basePaidOut = borrowAmount - debtRemaining;
    expect(debtRemaining).to.be.greaterThan(baseBorrowMin);

    // The account remains a borrower at the expected reduced balance and principal.
    const expectedPrincipal = principalValue(-debtRemaining, cometStateAfter.totals.baseSupplyIndex, cometStateAfter.totals.baseBorrowIndex);
    expect(cometStateAfter.user.principal).to.equal(expectedPrincipal);
    expect(-cometStateAfter.userBalance).to.equal(debtRemaining);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(debtRemaining);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The remaining normal collateral restores the open borrow above target health.
    const firstCollateralValueAfter = mulPrice(collateralStatesAfter[0].collateralBalance, droppedFirstPrice, collateralInfos[0].scale);
    const healthFactorAfter = mulFactor(firstCollateralValueAfter, collateralInfos[0].liquidateCollateralFactor) * factorScale / mulPrice(-cometStateAfter.userBalance, basePrice, baseScale);
    expect(healthFactorAfter).to.be.greaterThan(TARGET_HF);

    // The first asset is partially seized and the second is untouched, so both balances remain.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    // Only the repaid principal leaves total borrows; supply principal and Comet's base balance stay fixed.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal).sub(cometStateAfter.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // The first asset's accounting reflects its partial seizure; every second-asset value is unchanged.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    // Borrow rates are frozen, so reserves fall by exactly the base amount repaid.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves - basePaidOut);
  }
);

/**
 * Normal first asset followed by a fully delisted second asset in full-close mode. The first asset
 * alone closes the debt with a partial balance seizure, so the loop stops before the zero-LCF second
 * asset and both collateral balances remain.
 */
scenario(
  'Comet#absorb > 2 collaterals: first asset normal first, second asset delisted second, full debt close leaves both assets',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
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
    const firstBorrowCollateralFactor = collateralInfos[0].borrowCollateralFactor;

    // Put the normal first asset midway between debt / LF and debt / LCF. It can close the debt with
    // surplus in full-close mode, but after the second asset is delisted its LCF-weighted value leaves
    // the account liquidatable. The second asset receives the rest of the combined 4x-minimum value.
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
    const minimumFirstValue = borrowValue * factorScale / collateralInfos[0].liquidationFactor;
    const maximumFirstValue = borrowValue * factorScale / collateralInfos[0].liquidateCollateralFactor;
    const firstSuppliedValue = (minimumFirstValue + maximumFirstValue) / 2n;
    const secondSuppliedValue = 4n * minDebtValue - firstSuppliedValue;
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

    // Governance fully delists only the second collateral and installs a fresh full-close module.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, collateralInfos[1].asset, 0);
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, collateralInfos[1].asset, 0);
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.false;
    expect(collateralInfos[0].borrowCollateralFactor).to.equal(firstBorrowCollateralFactor);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[1].liquidateCollateralFactor).to.equal(0n);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // The normal first asset closes all debt with a debt / LF seizure. The zero-LCF second asset is
    // never reached and therefore remains completely untouched.
    collateralStatesBefore[0].seizeAmount = divPrice(borrowValue * factorScale / collateralInfos[0].liquidationFactor, collateralPrices[0], collateralInfos[0].scale);
    collateralStatesBefore[0].seizedValue = borrowValue;

    // Debt is fully closed and the debt-free account is healthy again.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The first asset keeps its closeout surplus and the second keeps its full balance.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    // Borrow principal is removed while supply principal and Comet's base balance are unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // The first asset's accounting reflects its closeout seizure; every second-asset value is unchanged.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    // Borrow rates are frozen, so base reserves fall by the full absorbed debt.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * Under-collateralized normal first asset followed by a fully delisted second asset. Absorb drains
 * the first asset without covering the debt, drains the zero-valued second asset, and clears the
 * remaining bad debt through base reserves.
 */
scenario(
  'Comet#absorb > 2 collaterals: first asset normal first, second asset delisted second, bad debt with nothing remaining',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
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
    const firstBorrowCollateralFactor = collateralInfos[0].borrowCollateralFactor;

    // Supply a combined 4x minimum-debt value, split evenly, and borrow 2x baseBorrowMin.
    const borrowAmount = 2n * baseBorrowMin;
    const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
    const suppliedValues = [2n * minDebtValue, 2n * minDebtValue];
    const collateralAmounts = collateralInfos.map(({ scale }, i) => suppliedValues[i] * scale / collateralPrices[i]);

    for (let i = 0; i < collateralInfos.length; i++) {
      await context.sourceTokens(collateralAmounts[i], collateralAssets[i], albert);
      await collateralAssets[i].approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralInfos[i].asset, amount: collateralAmounts[i] });
    }

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    // Keep the account healthy while both assets are normal, but make the first asset insufficient by
    // itself. The midpoint lies above the first value needed with the second asset's support and below
    // debt / LF, so the first asset will be fully consumed after the second is delisted.
    const secondBorrowValue = mulFactor(suppliedValues[1], collateralInfos[1].borrowCollateralFactor);
    const secondLiquidationValue = mulFactor(suppliedValues[1], collateralInfos[1].liquidateCollateralFactor);

    const firstBorrowValueNeeded = borrowValue > secondBorrowValue ? borrowValue - secondBorrowValue : 0n;
    const firstLiquidationValueNeeded = borrowValue > secondLiquidationValue ? borrowValue - secondLiquidationValue : 0n;

    const minimumFirstBorrowValue = firstBorrowValueNeeded * factorScale / collateralInfos[0].borrowCollateralFactor;
    const minimumFirstLiquidationValue = firstLiquidationValueNeeded * factorScale / collateralInfos[0].liquidateCollateralFactor;
    const minimumFirstValue = minimumFirstBorrowValue > minimumFirstLiquidationValue ? minimumFirstBorrowValue : minimumFirstLiquidationValue;

    const maximumFirstValue = borrowValue * factorScale / collateralInfos[0].liquidationFactor;
    const targetFirstValue = (minimumFirstValue + maximumFirstValue) / 2n;
    const droppedFirstPrice = targetFirstValue * collateralInfos[0].scale / collateralAmounts[0];
    await context.changePriceFeeds({ [collateralInfos[0].asset]: droppedFirstPrice });
    await comet.accrueAccount(albert.address);

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance fully delists only the second collateral and installs a fresh partial-mode module.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, collateralInfos[1].asset, 0);
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, collateralInfos[1].asset, 0);
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(await module.partialLiquidationEnabled()).to.be.true;
    expect(collateralInfos[0].borrowCollateralFactor).to.equal(firstBorrowCollateralFactor);
    expect(collateralInfos[1].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[1].liquidateCollateralFactor).to.equal(0n);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // The normal first asset is fully seized but cannot cover the debt. The fully delisted second asset
    // is then drained at zero debt value, leaving a shortfall that absorb writes off.
    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    const firstCollateralValue = mulPrice(collateralStatesBefore[0].seizeAmount, droppedFirstPrice, collateralInfos[0].scale);
    collateralStatesBefore[0].seizedValue = mulFactor(firstCollateralValue, collateralInfos[0].liquidationFactor);
    collateralStatesBefore[1].seizeAmount = collateralStatesBefore[1].collateralBalance;

    // Absorb clears the full borrow despite the collateral shortfall.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);

    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Both collateral balances are fully consumed.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }
    expect(cometStateAfter.user.assetsIn).to.equal(0);
    expect(cometStateAfter.user._reserved).to.equal(0);

    // Borrow principal is removed while supply principal and Comet's base balance are unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Both collateral totals fall by their full balances, reserves rise by the same amounts, and no
    // collateral ERC20 leaves Comet.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    // The full debt is written off through base reserves, not capped by the first asset's coverage.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/*//////////////////////////////////////////////////////////////
                      LF = 0 / FULL DELISTED
//////////////////////////////////////////////////////////////*/

/**
 * A collateral with all three risk factors set to zero has no liquidation repayment value. The
 * module skips it, preserves the user's collateral position, and writes off the entire borrow as
 * bad debt through base reserves.
 */
scenario(
  'Comet#absorb > 1 collateral: LF-zero asset absorb skips collateral and writes off debt',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
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

    // Supply collateral worth 4x the deployment's minimum debt and borrow 2x baseBorrowMin.
    const collateralAmount = 4n * minDebtValue * assetInfo.scale / collateralPrice;
    const borrowAmount = 2n * baseBorrowMin;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance zeros BCF, LCF, and LF, then installs a fresh module bound to the new asset list.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, assetInfo.asset, 0);
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, assetInfo.asset, 0);
    await configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, assetInfo.asset, 0);
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    assetInfo = await getAssetInfo(comet, collateralIndex);
    const module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());
    expect(assetInfo.borrowCollateralFactor).to.equal(0n);
    expect(assetInfo.liquidateCollateralFactor).to.equal(0n);
    expect(assetInfo.liquidationFactor).to.equal(0n);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    // LF-zero collateral is skipped and contributes nothing toward debt repayment.
    collateralStateBefore.seizeAmount = 0n;
    collateralStateBefore.seizedValue = 0n;

    // The full debt is written off even though no collateral was seized.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The skipped collateral and its membership bits remain unchanged.
    expect(collateralStateAfter.collateralBalance).to.equal(collateralStateBefore.collateralBalance);
    expect(collateralStateAfter.userCollateral.balance).to.equal(collateralStateBefore.userCollateral.balance);
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    // Borrow principal is removed while supply principal and Comet's base balance are unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Skipping the collateral leaves its supplied total, reserves, and Comet ERC20 balance unchanged.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

    // The entire borrow is written off through base reserves because the collateral repaid nothing.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * LF-zero first asset followed by a normal second asset. The module skips the first collateral and
 * partially seizes the second collateral to restore target health while leaving both collateral
 * balances and a borrow above the minimum.
 */
scenario(
  'Comet#absorb > 2 collaterals: first asset LF-zero first, second asset normal second, partial second asset seizure',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 2)).length === 2,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
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

    // A target-health partial seizure of the normal second asset leaves debt above baseBorrowMin only
    // when debt value D exceeds:
    //   D > m * LCF2 * (targetHF * LF2 - BCF2) / (BCF2 * (LF2 - LCF2))
    // Borrow twice the larger of that threshold and 2x min debt so the window remains open across
    // markets even when LF2 and LCF2 are close.
    const seizeFormulaDenominator = mulFactor(collateralInfos[1].liquidationFactor, TARGET_HF) - collateralInfos[1].borrowCollateralFactor;
    const partialWindowThreshold = minDebtValue * seizeFormulaDenominator * collateralInfos[1].liquidateCollateralFactor
      / (collateralInfos[1].borrowCollateralFactor * (collateralInfos[1].liquidationFactor - collateralInfos[1].liquidateCollateralFactor));
    const minimumDebtValue = 2n * minDebtValue;
    const targetBorrowValue = 2n * (partialWindowThreshold > minimumDebtValue ? partialWindowThreshold : minimumDebtValue);
    const borrowAmount = divPrice(targetBorrowValue, basePrice, baseScale);
    const debtValueBefore = mulPrice(borrowAmount, basePrice, baseScale);

    // Put the normal second asset at the midpoint of its valid partial-liquidation window.
    const guardFloorValue = debtValueBefore * factorScale / collateralInfos[1].liquidationFactor
      + minDebtValue * seizeFormulaDenominator * factorScale / (collateralInfos[1].liquidationFactor * collateralInfos[1].borrowCollateralFactor);
    const liquidatableMaxValue = debtValueBefore * factorScale / collateralInfos[1].liquidateCollateralFactor;
    const targetSecondValue = (guardFloorValue + liquidatableMaxValue) / 2n;

    // Size the first asset from the larger of the BCF and LCF deficits at the adjusted second-asset
    // value. The 10% margin keeps the position healthy before asset 1 is zeroed; afterward asset 2
    // alone is liquidatable and remains inside its partial-seizure window.
    const secondBorrowValueAfterAdjustment = mulFactor(targetSecondValue, collateralInfos[1].borrowCollateralFactor);
    const secondLiquidationValueAfterAdjustment = mulFactor(targetSecondValue, collateralInfos[1].liquidateCollateralFactor);
    const firstValueForBorrowSupport = (debtValueBefore - secondBorrowValueAfterAdjustment) * factorScale / collateralInfos[0].borrowCollateralFactor;
    const firstValueForLiquidationSupport = (debtValueBefore - secondLiquidationValueAfterAdjustment) * factorScale / collateralInfos[0].liquidateCollateralFactor;
    const requiredFirstValue = firstValueForBorrowSupport > firstValueForLiquidationSupport ? firstValueForBorrowSupport : firstValueForLiquidationSupport;
    const suppliedValues = [
      requiredFirstValue * 110n / 100n,
      targetSecondValue * 110n / 100n,
    ];
    const collateralAmounts = collateralInfos.map(({ scale }, i) => suppliedValues[i] * scale / collateralPrices[i]);
    const adjustedSecondPrice = targetSecondValue * collateralInfos[1].scale / collateralAmounts[1];

    for (let i = 0; i < collateralInfos.length; i++) {
      await context.sourceTokens(collateralAmounts[i], collateralAssets[i], albert);
      await collateralAssets[i].approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralInfos[i].asset, amount: collateralAmounts[i] });
    }

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    // Adjust the second asset into the partial-seizure window. With both assets still active, the
    // first plus second support the debt; the second alone supports neither borrow nor liquidation
    // health. Zeroing the first asset's factors will therefore make the account liquidatable.
    await context.changePriceFeeds({ [collateralInfos[1].asset]: adjustedSecondPrice });
    await comet.accrueAccount(albert.address);

    const firstValueBeforeDelist = mulPrice(collateralAmounts[0], collateralPrices[0], collateralInfos[0].scale);
    const secondValueBeforeDelist = mulPrice(collateralAmounts[1], adjustedSecondPrice, collateralInfos[1].scale);
    const firstBorrowValueBeforeDelist = mulFactor(firstValueBeforeDelist, collateralInfos[0].borrowCollateralFactor);
    const secondBorrowValueBeforeDelist = mulFactor(secondValueBeforeDelist, collateralInfos[1].borrowCollateralFactor);
    const firstLiquidationValueBeforeDelist = mulFactor(firstValueBeforeDelist, collateralInfos[0].liquidateCollateralFactor);
    const secondLiquidationValueBeforeDelist = mulFactor(secondValueBeforeDelist, collateralInfos[1].liquidateCollateralFactor);

    // The second asset cannot support the borrow by itself, but both assets together can.
    expect(secondBorrowValueBeforeDelist).to.be.lessThan(debtValueBefore);
    expect(firstBorrowValueBeforeDelist + secondBorrowValueBeforeDelist).to.be.at.least(debtValueBefore);

    // The second asset alone is below the liquidation threshold, while both assets keep the account safe.
    expect(secondLiquidationValueBeforeDelist).to.be.lessThan(debtValueBefore);
    expect(firstLiquidationValueBeforeDelist + secondLiquidationValueBeforeDelist).to.be.at.least(debtValueBefore);
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance zeros every factor on the first asset and installs a fresh partial-mode module.
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, collateralInfos[0].asset, 0);
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, collateralInfos[0].asset, 0);
    await configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, collateralInfos[0].asset, 0);
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const module = await configureModule(context, world, 'absorb', true, betty.address);
    await comet.accrueAccount(albert.address);

    expect(await comet.liquidationModule()).to.equal(module.address);
    expect(await comet.assetList()).to.equal(await module.assetList());

    expect(await module.partialLiquidationEnabled()).to.be.true;

    expect(collateralInfos[0].borrowCollateralFactor).to.equal(0n);
    expect(collateralInfos[0].liquidateCollateralFactor).to.equal(0n);
    expect(collateralInfos[0].liquidationFactor).to.equal(0n);

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

    // The LF-zero first asset is skipped. The normal second asset is partially seized until the
    // remaining position reaches target health.
    const secondCollateralValue = mulPrice(collateralStatesBefore[1].collateralBalance, adjustedSecondPrice, collateralInfos[1].scale);
    const totalCollateralizedValue = mulFactor(secondCollateralValue, collateralInfos[1].borrowCollateralFactor);
    const wantedSecondValue = wantedCollateralValue(debtValueBefore, totalCollateralizedValue, collateralInfos[1].liquidationFactor, collateralInfos[1].borrowCollateralFactor);
    collateralStatesBefore[1].seizeAmount = divPrice(wantedSecondValue, adjustedSecondPrice, collateralInfos[1].scale);
    collateralStatesBefore[1].seizedValue = mulFactor(wantedSecondValue, collateralInfos[1].liquidationFactor);

    const debtValueRemaining = debtValueBefore - collateralStatesBefore[1].seizedValue;
    const debtRemaining = divPrice(debtValueRemaining, basePrice, baseScale);
    const basePaidOut = borrowAmount - debtRemaining;
    expect(debtRemaining).to.be.greaterThan(baseBorrowMin);

    // The account remains a borrower at the expected reduced balance and principal.
    const expectedPrincipal = principalValue(-debtRemaining, cometStateAfter.totals.baseSupplyIndex, cometStateAfter.totals.baseBorrowIndex);
    expect(cometStateAfter.user.principal).to.equal(expectedPrincipal);
    expect(-cometStateAfter.userBalance).to.equal(debtRemaining);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(debtRemaining);
    expect(await comet.balanceOf(albert.address)).to.equal(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // The remaining second collateral restores the open borrow above target health.
    const secondCollateralValueAfter = mulPrice(collateralStatesAfter[1].collateralBalance, adjustedSecondPrice, collateralInfos[1].scale);
    const healthFactorAfter = mulFactor(secondCollateralValueAfter, collateralInfos[1].liquidateCollateralFactor) * factorScale / mulPrice(-cometStateAfter.userBalance, basePrice, baseScale);
    expect(healthFactorAfter).to.be.greaterThan(TARGET_HF);

    // The first asset is untouched and the second retains collateral after its partial seizure.
    for (let i = 0; i < collateralStatesBefore.length; i++) {
      const remainingCollateral = collateralStatesBefore[i].collateralBalance - collateralStatesBefore[i].seizeAmount;
      expect(collateralStatesAfter[i].collateralBalance).to.equal(remainingCollateral);
      expect(collateralStatesAfter[i].userCollateral.balance).to.equal(remainingCollateral);
    }
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    // Only the repaid principal leaves total borrows; supply principal and Comet's base balance stay fixed.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal).sub(cometStateAfter.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // The first asset's accounting is unchanged; the second reflects only its partial balance seizure.
    for (let i = 0; i < collateralInfos.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }

    // Borrow rates are frozen, so base reserves fall by exactly the base amount repaid.
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves - basePaidOut);
  }
);
