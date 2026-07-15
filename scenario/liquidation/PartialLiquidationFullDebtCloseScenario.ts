import { scenario } from '../context/CometContext';
import { expect } from 'chai';
import {
  hasModule,
  configureModule,
  captureAbsorbStateBefore,
  getAssetInfo,
  makeCollateralStates,
  TARGET_HF,
  usableCollateralIndices,
  usesAssetList,
} from '../utils';
import { mulPrice, mulFactor, divPrice, factorScale } from '../../test/helpers';

/**
 * Full-debt-close-mode absorb scenarios for the liquidation module. These reuse the setups from
 * `PartialLiquidationScenario.ts`, but the module runs with `partialLiquidationEnabled = false`, so
 * absorb closes the WHOLE debt instead of restoring the target health factor. Only the `absorb` entry
 * point is exercised (the module's `liquidate` keeper path is covered by the partial-mode file).
 */
const tag = `entry=absorb, mode=full-close`;

/**
 * The base case in full-debt-close mode: a single collateral with plenty of headroom. The position is
 * underwater but the collateral comfortably covers the debt, so absorb closes the WHOLE debt with the
 * plain full-close formula — seizing only the slice the debt needs (a surplus remains) and leaving the
 * borrower with no debt at all. The setup and pre-absorb sanity checks are identical to the partial-mode
 * scenario of the same name; only the seizure size and the post-absorb end state differ.
 */
scenario(
  `Comet#absorb > 1 collateral: partial seizure, user has enough to cover debt [${tag}]`,
  {
    filter: async (ctx) =>
      (await hasModule(ctx)) &&
      (await usesAssetList(ctx)) &&
      (await usableCollateralIndices(ctx, 1)).length > 0,
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    // Use the first collateral usable for the liquidation math (all three factors positive).
    const [collateralIndex] = await usableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    // Freeze interest so the debt stays exactly where the borrow puts it — the seizure the target-HF
    // formula computes is exact, with no intra-block accrual to reason about.
    await context.zeroBorrowRates();

    const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralScale = collateralAssetInfo.scale;
    const collateralPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();
    const collateralBCF = collateralAssetInfo.borrowCollateralFactor;
    const collateralLCF = collateralAssetInfo.liquidateCollateralFactor;
    const collateralLF = collateralAssetInfo.liquidationFactor;
    const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);

    // 1. Size the borrow so a genuine partial seizure is possible at all. Writing the debt as D, the
    //    min debt as m and the collateral's post-drop market value as v, the partial seizure survives
    //    only if the debt it leaves behind stays above the floor:
    //      D - wanted*LF > m
    //    Substituting the target-HF formula for `wanted` turns that into a lower bound on v (relative
    //    to D), while liquidatability caps v from above. Both bounds sit on x = v*LF / D:
    //      x > 1 + m*(targetHF*LF - BCF) / (D*BCF)     the guard stays quiet
    //      x < LF / LCF                                 the account is liquidatable
    //    which is a non-empty window only when the debt is far enough above the minimum:
    //      minBorrowValue = m * LCF * (targetHF*LF - BCF) / (BCF * (LF - LCF))
    //    Borrow 5x that. The window then sits at (1 + h/5, 1 + h) with h = (LF - LCF)/LCF, so its
    //    midpoint is far from the guard boundary on any market — the seizure leaves the debt well
    //    clear of the minimum. The collateral supplied below follows from the borrow, landing at
    //    roughly 10x the min debt in value: plenty of headroom, nowhere near a wipeout.
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    // Denominator of the target-HF seize formula: seizing collateral value S drops the debt by S*LF
    // and the collateralized value by S*BCF, so the health-factor gap closes by S*(targetHF*LF - BCF)
    // per unit seized. The Configurator enforces LF*targetHF > LCF > BCF, so it is always positive.
    const seizeFormulaDenominator = mulFactor(collateralLF, TARGET_HF) - collateralBCF;
    const minBorrowValue = (minDebtValue * collateralLCF * seizeFormulaDenominator) / (collateralBCF * (collateralLF - collateralLCF));
    const borrowValue = 5n * minBorrowValue;
    const borrowAmount = divPrice(borrowValue, basePrice, baseScale);

    // 2. Supply the collateral that borrow needs, with a 10% buffer, then borrow.
    //      collateralValue = borrowValue / BCF * 1.10
    const suppliedValue = ((borrowValue * factorScale) / collateralBCF * 110n) / 100n;
    const collateralAmount = (suppliedValue * collateralScale) / collateralPrice + 1n;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;
    expect((await comet.borrowBalanceOf(albert.address)).toBigInt()).to.be.greaterThan(baseBorrowMin);

    // 3. Drop the collateral price so its post-drop market value lands at the midpoint of the window
    //    the two bounds from step 1 carve out — expressed here directly as collateral values (D is the
    //    debt, m the min debt):
    //      guardFloorValue      = D/LF + m*(targetHF*LF - BCF) / (LF*BCF)
    //                             the smallest value at which the partial seizure still leaves the debt
    //                             above the minimum (below it the min-debt guard fires)
    //      liquidatableMaxValue = D/LCF
    //                             the largest value at which the account is still liquidatable (its
    //                             LCF-weighted value reaches the debt exactly at this point)
    //    The collateral still comfortably covers the debt at the midpoint, so there is plenty left to
    //    work with — nowhere near a wipeout.
    const debtValue = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
    const guardFloorValue = (debtValue * factorScale) / collateralLF + (minDebtValue * seizeFormulaDenominator * factorScale) / (collateralLF * collateralBCF);
    const liquidatableMaxValue = (debtValue * factorScale) / collateralLCF;
    const targetCollateralValue = (guardFloorValue + liquidatableMaxValue) / 2n;
    const newCollateralPrice = (targetCollateralValue * collateralScale) / collateralAmount;
    await context.changePriceFeeds({ [collateralAssetInfo.asset]: Number(newCollateralPrice) / 1e8 });

    // changePriceFeeds redeploys the liquidation module, so configure it only once the price is set.
    await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    // 4. Capture state and run the sanity checks that define the partial-seizure case.
    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [collateralIndex]);
    const debtBefore = -cometStateBefore.userBalance; // the borrower's debt in base units (userBalance is negative)
    const debtValueBefore = mulPrice(debtBefore, basePrice, baseScale);
    const collateralValueBefore = mulPrice(collateralStateBefore.collateralBalance, collateralStateBefore.price, collateralStateBefore.scale);

    // 5. Sanity checks before absorb: the account is liquidatable, with its LCF-weighted health factor
    //    below the target health factor.
    //      healthFactor = collateralValue * LCF / debtValue
    const healthFactorBefore = (mulFactor(collateralValueBefore, collateralLCF) * factorScale) / debtValueBefore;
    expect(healthFactorBefore).to.be.lessThan(TARGET_HF);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    // The debt starts ABOVE the minimum, so the loop does not take the full-close branch on entry.
    expect(debtBefore).to.be.greaterThan(baseBorrowMin);
    expect(debtValueBefore).to.be.greaterThan(minDebtValue);

    // 6. Absorb (the module runs in full-debt-close mode).
    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    // 7. Independently derive the expected seizure. In full-close mode absorb closes the WHOLE debt with
    //    the plain full-close formula — no targetHF, no totalCollateralizedValue. The collateral covers
    //    the debt, so only the slice the debt needs is seized and a surplus remains:
    //      seizeAmount = (debtValue / LF) / price      (divPrice by the collateral price)
    //      seizedValue = seizeAmount * price / scale    (mulPrice — its market value)
    collateralStateBefore.seizeAmount = divPrice((debtValueBefore * factorScale) / collateralLF, collateralStateBefore.price, collateralStateBefore.scale);
    collateralStateBefore.seizedValue = mulPrice(collateralStateBefore.seizeAmount, collateralStateBefore.price, collateralStateBefore.scale);

    // 8. Post-absorb checks. Capture the comet + collateral state again and diff against the before
    //    snapshots.
    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [collateralIndex]);

    // The debt is CLOSED in full: principal, borrow balance and simple base balance are all zero — the
    // borrower is no longer a borrower at all.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);

    // Only the full-close slice of the collateral is seized; a surplus remains, since the collateral's
    // value comfortably covers the debt even after the liquidation factor.
    const remainingCollateral = collateralStateBefore.collateralBalance - collateralStateBefore.seizeAmount;
    expect(collateralStateAfter.collateralBalance).to.equal(remainingCollateral);
    expect((await comet.userCollateral(albert.address, collateralAssetInfo.asset)).balance).to.equal(remainingCollateral);

    // The account is no longer liquidatable.
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Collateral remains, so the user's assetsIn bit and reserved bits are untouched.
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    // Comet borrow state: borrow base reduced by the FULL original debt (principal); supply base unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

    // Comet collateral accounting: supplied total drops by the seized amount, reserves rise by it, and
    // the collateral + base ERC20 balances are untouched on the absorb path.
    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Base reserves fall by the FULL debt paid out (userBalance is the borrower's negative base balance).
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * Multi-collateral full-debt-close. The first collateral's LF-weighted value cannot cover the debt, so
 * it is fully seized — identical to partial mode. The remaining debt is then closed on the second with
 * the plain full-close formula (no targetHF): the second covers it, so only the slice the debt needs is
 * seized and a surplus remains. This proves the "fully seize what can't cover the debt, then close out on
 * the next asset" walk — only the closing asset's sizing differs from partial mode.
 */
scenario(
  `Comet#absorb > multi-collateral: full seizure of first asset then partial of second [${tag}]`,
  {
    filter: async (ctx) =>
      (await hasModule(ctx)) &&
      (await usesAssetList(ctx)) &&
      (await usableCollateralIndices(ctx, 2)).length === 2,
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    // The first two collaterals usable for the liquidation math, in the order the absorb loop walks
    // them: [0] is dropped and fully seized, [1] is left at its price and partially seized.
    const collateralIndexes = await usableCollateralIndices(context, 2);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    // Freeze interest so the debt stays exactly where the borrow puts it — the two-step seizure the
    // loop computes is exact, with no intra-block accrual to reason about.
    await context.zeroBorrowRates();

    const collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const collateralPrices = await Promise.all(collateralIndexes.map(async (index) => (await comet.getPrice(collateralInfos[index].priceFeed)).toBigInt()));

    // 1. Borrow well above the minimum so the min-debt guard is nowhere near either seizure.
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    const borrowValue = 20n * minDebtValue;
    const borrowAmount = divPrice(borrowValue, basePrice, baseScale);

    // 2. Choose each collateral's post-setup value so the loop takes the "full then partial" path on
    //    every market. Writing the debt as D, the first collateral repays a fixed 60% of it when fully
    //    seized, and the second is placed at the midpoint of the band that makes it a partial closer:
    //      firstTargetValue  = 0.6*D / LF1                    so firstTargetValue*LF1 = 0.6*D
    //      secondBcfRatio    = midpoint of (BCF2/LF2, targetHF)
    //      secondTargetValue = 0.4*D * secondBcfRatio / BCF2
    //    The first is fully seized because the formula wants more of it than it is worth; the second
    //    covers the remaining 0.4*D as a genuine partial. BCF2/LF2 < 1 < targetHF keeps the band open,
    //    so this holds whatever factors the market's collateral has (the sanity checks below confirm it
    //    for the market actually under test).
    const firstTargetValue = (borrowValue * 6n / 10n) * factorScale / collateralInfos[0].liquidationFactor;
    const secondBcfRatio = (collateralInfos[1].borrowCollateralFactor * factorScale / collateralInfos[1].liquidationFactor + TARGET_HF) / 2n;
    const secondTargetValue = ((borrowValue * 4n / 10n) * secondBcfRatio) / collateralInfos[1].borrowCollateralFactor;

    // 3. Supply the untouched second collateral at its target value, and the first well over-supplied so
    //    the borrow is valid; the first's price is then dropped onto firstTargetValue.
    const firstAmount = (3n * borrowValue * collateralInfos[0].scale) / collateralPrices[0]; // ~3*D of value, dropped below
    const secondAmount = (secondTargetValue * collateralInfos[1].scale) / collateralPrices[1];

    const firstAsset = context.getAssetByAddress(collateralInfos[0].asset);
    await context.sourceTokens(firstAmount, firstAsset, albert);
    await firstAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: collateralInfos[0].asset, amount: firstAmount });

    const secondAsset = context.getAssetByAddress(collateralInfos[1].asset);
    await context.sourceTokens(secondAmount, secondAsset, albert);
    await secondAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: collateralInfos[1].asset, amount: secondAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // 4. Drop the first collateral onto its target value; the second's price is left alone.
    const firstNewPrice = (firstTargetValue * collateralInfos[0].scale) / firstAmount;
    await context.changePriceFeeds({ [collateralInfos[0].asset]: Number(firstNewPrice) / 1e8 });

    // changePriceFeeds redeploys the liquidation module, so configure it only once the price is set.
    await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    // 5. Capture the pre-absorb state and run the sanity checks that define this case.
    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralIndexes);
    const debtValueBefore = mulPrice((-cometStateBefore.userBalance), basePrice, baseScale);
    const firstValue = mulPrice(collateralStatesBefore[0].collateralBalance, collateralStatesBefore[0].price, collateralStatesBefore[0].scale);
    const secondValue = mulPrice(collateralStatesBefore[1].collateralBalance, collateralStatesBefore[1].price, collateralStatesBefore[1].scale);

    // Sanity checks before absorb: the account is liquidatable, with its LCF-weighted health factor
    // below the target the module aims to restore.
    //   healthFactor = (value1*LCF1 + value2*LCF2) / debtValue
    const liquidityBefore = mulFactor(firstValue, collateralInfos[0].liquidateCollateralFactor) + mulFactor(secondValue, collateralInfos[1].liquidateCollateralFactor);
    const healthFactorBefore = (liquidityBefore * factorScale) / debtValueBefore;
    expect(healthFactorBefore).to.be.lessThan(TARGET_HF);

    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    // 6. Absorb (the module runs in full-debt-close mode).
    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    // 7. Independently derive the expected seizures by simulating the full-close loop from the captured
    //    pre-absorb values, so the expected amounts match the contract's rounding exactly.

    // Iteration 1 (first collateral): its LF-weighted value cannot cover the debt, so it is fully seized —
    // identical to partial mode. The debt drops by its LF-weighted value.
    collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
    collateralStatesBefore[0].seizedValue = mulFactor(firstValue, collateralInfos[0].liquidationFactor);

    // Iteration 2 (second collateral): in full-close mode absorb closes the WHOLE remaining debt with the
    // plain full-close formula — no targetHF. The second covers the remainder, so only the slice it needs
    // is seized and a surplus remains:
    //   seizeAmount = (remainingDebt / LF) / price      (divPrice by the collateral price)
    const debtValueAfterFirst = debtValueBefore - collateralStatesBefore[0].seizedValue;
    collateralStatesBefore[1].seizeAmount = divPrice((debtValueAfterFirst * factorScale) / collateralInfos[1].liquidationFactor, collateralStatesBefore[1].price, collateralStatesBefore[1].scale);

    // 8. Post-absorb checks. Capture the comet + collateral state again and diff against the before
    //    snapshots.
    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralIndexes);

    // The debt is CLOSED in full: principal, borrow balance and simple base balance are all zero.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);

    // First collateral is drained; second keeps the surplus left after its full-close seizure.
    expect(collateralStatesAfter[0].collateralBalance).to.equal(0n);
    expect((await comet.userCollateral(albert.address, collateralInfos[0].asset)).balance).to.equal(0);

    const secondRemaining = collateralStatesBefore[1].collateralBalance - collateralStatesBefore[1].seizeAmount;
    expect(collateralStatesAfter[1].collateralBalance).to.equal(secondRemaining);
    expect((await comet.userCollateral(albert.address, collateralInfos[1].asset)).balance).to.equal(secondRemaining);

    // The account is no longer liquidatable.
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Only the fully-seized first collateral's bit is cleared, in whichever bitfield its index falls;
    // the surviving second collateral keeps its bit and reserved is otherwise untouched.
    let expectedAssetsIn = cometStateBefore.user.assetsIn;
    let expectedReserved = cometStateBefore.user._reserved;
    if (collateralStatesBefore[0].offset < 16) {
      expectedAssetsIn = expectedAssetsIn & ~(1 << collateralStatesBefore[0].offset);
    } else {
      expectedReserved = expectedReserved & ~(1 << (collateralStatesBefore[0].offset - 16));
    }
    expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
    expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

    // Comet borrow state: borrow base reduced by the full original debt (principal); supply base unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

    // Comet collateral accounting, per asset: supplied totals drop by that asset's own seized amount,
    // reserves rise by it, and the ERC20 balances are untouched on the absorb path.
    for (let i = 0; i < collateralIndexes.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Base reserves fall by the FULL debt paid out (userBalance is the borrower's negative base balance).
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * All collaterals in full-debt-close mode: the loop drains every asset but the last, then closes the
 * WHOLE remaining debt on the last with the plain full-close formula (no targetHF) — it covers the
 * remainder, so a surplus is left. Every earlier asset is fully seized in index order, identical to
 * partial mode; only the closing asset's seizure size differs. Needs a market with more than two
 * collaterals, so it is skipped on the two-asset development deployment.
 */
scenario(
  `Comet#absorb > all collaterals: last one covers the debt, the rest are fully seized [${tag}]`,
  {
    filter: async (ctx) =>
      (await hasModule(ctx)) &&
      (await usesAssetList(ctx)) &&
      (await usableCollateralIndices(ctx)).length > 2,
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    // Every usable collateral, in index order. The last is the closing collateral (partially seized);
    // all earlier ones are the small assets that get fully drained first.
    const collateralIndexes = await usableCollateralIndices(context);
    const closing = collateralIndexes.length - 1; // position of the closing collateral in the arrays

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    // Freeze interest so the debt stays exactly where the borrow puts it — the whole-basket seizure the
    // loop computes is exact, and utilization / borrow rate never move (no third-party supplier needed).
    await context.zeroBorrowRates();

    const collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const collateralPrices = await Promise.all(collateralIndexes.map(async (index) => (await comet.getPrice(collateralInfos[index].priceFeed)).toBigInt()));

    // 1. Borrow well above the minimum so the min-debt guard is nowhere near any seizure.
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    const borrowValue = 40n * minDebtValue;
    const borrowAmount = divPrice(borrowValue, basePrice, baseScale);

    // 2. Give every small asset the same modest value, then size the closing collateral so the loop
    //    takes the "drain the smalls, partially close on the last" path on any market. Writing the debt
    //    as D, each small worth `smallValue`, the debt left once every small is fully seized is
    //      R = D - sum(smallValue * LF_small)
    //    and the closing collateral must land in the band where it covers R but the account is still
    //    liquidatable — the single-collateral partial band, shifted by the smalls:
    //      lowerCloseValue = R / LF_close                        (its LF value just covers R → partial)
    //      upperCloseValue = (D - sum(smallValue*LCF_small)) / LCF_close   (account stops being liquidatable)
    //    Take the midpoint. LCF < LF keeps the band open on any market. The smalls are guaranteed to be
    //    fully seized: the gap targetHF*debtRemaining - totalCollateralizedValue only shrinks as each is
    //    drained (targetHF*LF > BCF), so if the closing step does not break early, none of them do.
    const smallValue = borrowValue / (4n * BigInt(closing)); // smalls hold ~a quarter of the debt in total

    let smallsSeizedLF = 0n;
    let smallsSeizedLCF = 0n;
    for (let i = 0; i < closing; i++) {
      smallsSeizedLF += mulFactor(smallValue, collateralInfos[i].liquidationFactor);
      smallsSeizedLCF += mulFactor(smallValue, collateralInfos[i].liquidateCollateralFactor);
    }
    const debtValueAfterSmalls = borrowValue - smallsSeizedLF;
    const lowerCloseValue = debtValueAfterSmalls * factorScale / collateralInfos[closing].liquidationFactor;
    const upperCloseValue = (borrowValue - smallsSeizedLCF) * factorScale / collateralInfos[closing].liquidateCollateralFactor;
    const closingTargetValue = (lowerCloseValue + upperCloseValue) / 2n;

    // 3. Supply every small asset at smallValue (left at its price), and the closing collateral well
    //    over-supplied so the borrow is valid; its price is then dropped onto closingTargetValue.
    for (let i = 0; i < closing; i++) {
      const amount = (smallValue * collateralInfos[i].scale) / collateralPrices[i];
      const asset = context.getAssetByAddress(collateralInfos[i].asset);
      await context.sourceTokens(amount, asset, albert);
      await asset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralInfos[i].asset, amount });
    }

    const closingAmount = (2n * borrowValue * collateralInfos[closing].scale) / collateralPrices[closing]; // ~2*D of value, dropped below
    const closingAsset = context.getAssetByAddress(collateralInfos[closing].asset);
    await context.sourceTokens(closingAmount, closingAsset, albert);
    await closingAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: collateralInfos[closing].asset, amount: closingAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // 4. Drop the closing collateral onto its target value; every small asset is left alone.
    const closingNewPrice = (closingTargetValue * collateralInfos[closing].scale) / closingAmount;
    await context.changePriceFeeds({ [collateralInfos[closing].asset]: Number(closingNewPrice) / 1e8 });

    // changePriceFeeds redeploys the liquidation module, so configure it only once the price is set.
    await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    // 5. Capture the pre-absorb state and run the sanity checks that define this case.
    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralIndexes);
    const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
    const collateralValuesBefore = collateralStatesBefore.map((state) => mulPrice(state.collateralBalance, state.price, state.scale));

    // Sanity checks before absorb: the account is liquidatable, with its LCF-weighted health factor
    // (across every collateral) below the target the module aims to restore.
    let liquidityBefore = 0n;
    for (let i = 0; i < collateralIndexes.length; i++) {
      liquidityBefore += mulFactor(collateralValuesBefore[i], collateralInfos[i].liquidateCollateralFactor);
    }
    const healthFactorBefore = (liquidityBefore * factorScale) / debtValueBefore;
    expect(healthFactorBefore).to.be.lessThan(TARGET_HF);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    // 6. Absorb (the module runs in full-debt-close mode).
    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    // 7. Independently derive the expected seizures by simulating the full-close loop from the captured
    //    pre-absorb values, so the expected amounts match the contract's rounding exactly.

    // Every small asset is fully seized in index order — identical to partial mode; the debt drops by
    // each one's LF-weighted value.
    let debtValueRemaining = debtValueBefore;
    for (let i = 0; i < closing; i++) {
      collateralStatesBefore[i].seizeAmount = collateralStatesBefore[i].collateralBalance;
      collateralStatesBefore[i].seizedValue = mulFactor(collateralValuesBefore[i], collateralInfos[i].liquidationFactor);
      debtValueRemaining -= collateralStatesBefore[i].seizedValue;
    }

    // Closing collateral: in full-close mode absorb closes the WHOLE remaining debt with the plain
    // full-close formula — no targetHF. It covers the remainder, so only the slice the debt needs is
    // seized and a surplus remains:
    //   seizeAmount = (remainingDebt / LF) / price      (divPrice by the collateral price)
    collateralStatesBefore[closing].seizeAmount = divPrice((debtValueRemaining * factorScale) / collateralInfos[closing].liquidationFactor, collateralStatesBefore[closing].price, collateralStatesBefore[closing].scale);

    // 8. Post-absorb checks. Capture the comet + collateral state again and diff against the before
    //    snapshots.
    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralIndexes);

    // The debt is CLOSED in full: principal, borrow balance and simple base balance are all zero — the
    // borrower is no longer a borrower at all.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);

    // Every small asset is drained; the closing collateral keeps the surplus after its full-close seizure.
    const closingRemaining = collateralStatesBefore[closing].collateralBalance - collateralStatesBefore[closing].seizeAmount;
    for (let i = 0; i < closing; i++) {
      expect(collateralStatesAfter[i].collateralBalance).to.equal(0n);
      expect((await comet.userCollateral(albert.address, collateralInfos[i].asset)).balance).to.equal(0);
    }
    expect(collateralStatesAfter[closing].collateralBalance).to.equal(closingRemaining);
    expect((await comet.userCollateral(albert.address, collateralInfos[closing].asset)).balance).to.equal(closingRemaining);

    // The account is no longer liquidatable.
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Every fully-seized small asset's bit is cleared, in whichever bitfield its index falls; the
    // surviving closing collateral keeps its bit and nothing else in either field moves.
    let expectedAssetsIn = cometStateBefore.user.assetsIn;
    let expectedReserved = cometStateBefore.user._reserved;
    for (let i = 0; i < closing; i++) {
      const offset = collateralStatesBefore[i].offset;
      if (offset < 16) {
        expectedAssetsIn = expectedAssetsIn & ~(1 << offset);
      } else {
        expectedReserved = expectedReserved & ~(1 << (offset - 16));
      }
    }
    expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
    expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

    // Comet borrow state: borrow base reduced by the full original debt (principal), within a small
    // tolerance for cross-asset rounding over the whole basket; supply base unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.be.approximately(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal), 2);
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

    // Comet collateral accounting, per asset: supplied totals drop by that asset's own seized amount,
    // reserves rise by it, and the ERC20 balances are untouched on the absorb path.
    for (let i = 0; i < collateralIndexes.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Base reserves fall by the FULL debt paid out (userBalance is the borrower's negative base balance).
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * Two collaterals where the very first the loop touches is already enough. A large first collateral and
 * a tiny second: in full-close mode the plain full-close formula closes the WHOLE debt on the first
 * alone (it covers the debt), so the debt is gone before the loop ever reaches the second. This proves
 * the early-exit path — only one asset is seized even though two are held, just as in partial mode; only
 * the first's seizure size differs.
 */
scenario(
  `Comet#absorb > 2 collaterals: partial seizure of the first restores targetHF, second untouched [${tag}]`,
  {
    filter: async (ctx) =>
      (await hasModule(ctx)) &&
      (await usesAssetList(ctx)) &&
      (await usableCollateralIndices(ctx, 2)).length === 2,
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    // The first two collaterals usable for the liquidation math. [0] is the large one that is partially
    // seized; [1] is a tiny one the loop never reaches.
    const collateralIndexes = await usableCollateralIndices(context, 2);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    // Freeze interest so the debt stays exactly where the borrow puts it — the single partial seizure is
    // exact, with no intra-block accrual to reason about.
    await context.zeroBorrowRates();

    const collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
    const collateralPrices = await Promise.all(collateralIndexes.map(async (index) => (await comet.getPrice(collateralInfos[index].priceFeed)).toBigInt()));

    // 1. Size the borrow off the FIRST collateral exactly as the single-collateral case does, so its
    //    partial seizure alone can restore targetHF while leaving the debt above the minimum:
    //      minBorrowValue = m * LCF * (targetHF*LF - BCF) / (BCF * (LF - LCF))
    //    Borrow 5x that. (The tiny second collateral barely shifts any of this.)
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    const seizeFormulaDenominator = mulFactor(collateralInfos[0].liquidationFactor, TARGET_HF) - collateralInfos[0].borrowCollateralFactor;
    const minBorrowValue = (minDebtValue * collateralInfos[0].liquidateCollateralFactor * seizeFormulaDenominator) 
      / (collateralInfos[0].borrowCollateralFactor * (collateralInfos[0].liquidationFactor - collateralInfos[0].liquidateCollateralFactor));
    const borrowValue = 5n * minBorrowValue;
    const borrowAmount = divPrice(borrowValue, basePrice, baseScale);

    // The second collateral is tiny — a small fraction of the debt — and is left at its price. Its only
    // role is to be present-but-untouched, so it must never on its own satisfy or block the seizure.
    const secondValue = borrowValue / 40n;

    // 2. Supply the first collateral over-valued (so the borrow is valid; its price is dropped below),
    //    and the tiny second at its target value.
    const firstSuppliedValue = ((borrowValue * factorScale) / collateralInfos[0].borrowCollateralFactor * 110n) / 100n;
    const firstAmount = (firstSuppliedValue * collateralInfos[0].scale) / collateralPrices[0];
    const firstAsset = context.getAssetByAddress(collateralInfos[0].asset);
    await context.sourceTokens(firstAmount, firstAsset, albert);
    await firstAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: collateralInfos[0].asset, amount: firstAmount });

    const secondAmount = (secondValue * collateralInfos[1].scale) / collateralPrices[1];
    const secondAsset = context.getAssetByAddress(collateralInfos[1].asset);
    await context.sourceTokens(secondAmount, secondAsset, albert);
    await secondAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: collateralInfos[1].asset, amount: secondAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // 3. Drop the first collateral onto the midpoint of the single-collateral partial band, shifted for
    //    the tiny second's contribution to the liquidatable limit (D is the debt, m the min debt):
    //      guardFloorValue      = D/LF1 + m*(targetHF*LF1 - BCF1) / (LF1*BCF1)   (debt stays above min)
    //      liquidatableMaxValue = (D - secondValue*LCF2) / LCF1                  (account stays liquidatable)
    //    The midpoint keeps the first large enough that its partial seizure alone restores targetHF.
    const debtValue = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
    const guardFloorValue = (debtValue * factorScale) / collateralInfos[0].liquidationFactor + (minDebtValue * seizeFormulaDenominator * factorScale) / (collateralInfos[0].liquidationFactor * collateralInfos[0].borrowCollateralFactor);
    const liquidatableMaxValue = (debtValue - mulFactor(secondValue, collateralInfos[1].liquidateCollateralFactor)) * factorScale / collateralInfos[0].liquidateCollateralFactor;
    const firstTargetValue = (guardFloorValue + liquidatableMaxValue) / 2n;
    const firstNewPrice = (firstTargetValue * collateralInfos[0].scale) / firstAmount;
    await context.changePriceFeeds({ [collateralInfos[0].asset]: Number(firstNewPrice) / 1e8 });

    // changePriceFeeds redeploys the liquidation module, so configure it only once the price is set.
    await configureModule(context, world, 'absorb', false, betty.address);
    await comet.accrueAccount(albert.address);

    // 4. Capture the pre-absorb state and run the sanity checks that define this case.
    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralIndexes);
    const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
    const firstValue = mulPrice(collateralStatesBefore[0].collateralBalance, collateralStatesBefore[0].price, collateralStatesBefore[0].scale);
    const secondValueBefore = mulPrice(collateralStatesBefore[1].collateralBalance, collateralStatesBefore[1].price, collateralStatesBefore[1].scale);

    // Sanity checks before absorb: the account is liquidatable, with its LCF-weighted health factor
    // (across both collaterals) below the target the module aims to restore.
    const liquidityBefore = mulFactor(firstValue, collateralInfos[0].liquidateCollateralFactor) + mulFactor(secondValueBefore, collateralInfos[1].liquidateCollateralFactor);
    const healthFactorBefore = (liquidityBefore * factorScale) / debtValueBefore;
    expect(healthFactorBefore).to.be.lessThan(TARGET_HF);
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    // 5. Absorb (the module runs in full-debt-close mode).
    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    // 6. Independently derive the expected seizure. In full-close mode absorb closes the WHOLE debt on the
    //    first collateral with the plain full-close formula — no targetHF, no totalCollateralizedValue.
    //    The first covers the debt on its own, so only the slice the debt needs is seized:
    //      seizeAmount = (debtValue / LF) / price      (divPrice by the collateral price)
    collateralStatesBefore[0].seizeAmount = divPrice((debtValueBefore * factorScale) / collateralInfos[0].liquidationFactor, collateralStatesBefore[0].price, collateralStatesBefore[0].scale);
    // The second collateral is never reached, so its seize amount stays zero.

    // The seize amount is less than the first collateral's full balance — the debt closes on the first
    // alone (its value covers the debt), so the loop never touches the second.
    expect(collateralStatesBefore[0].seizeAmount).to.be.lessThan(collateralStatesBefore[0].collateralBalance);

    // 7. Post-absorb checks. Capture the comet + collateral state again and diff against the before
    //    snapshots.
    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralIndexes);

    // The debt is CLOSED in full: principal, borrow balance and simple base balance are all zero.
    expect(cometStateAfter.user.principal).to.equal(0);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);

    // First collateral reduced by its full-close seize amount with a surplus; second fully untouched.
    const firstRemaining = collateralStatesBefore[0].collateralBalance - collateralStatesBefore[0].seizeAmount;
    expect(collateralStatesAfter[0].collateralBalance).to.equal(firstRemaining);
    expect((await comet.userCollateral(albert.address, collateralInfos[0].asset)).balance).to.equal(firstRemaining);
    expect(collateralStatesAfter[1].collateralBalance).to.equal(collateralStatesBefore[1].collateralBalance);
    expect((await comet.userCollateral(albert.address, collateralInfos[1].asset)).balance).to.equal(collateralStatesBefore[1].collateralBalance);

    // The account is no longer liquidatable.
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Both collaterals still have a balance, so assetsIn and reserved are unchanged.
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    // Comet borrow state: borrow base reduced by the full original debt (principal); supply base unchanged.
    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

    // Comet collateral accounting: the first drops by its seized amount and its reserves rise by it; the
    // untouched second's totals and reserves stay exactly where they were (its seize amount is zero).
    for (let i = 0; i < collateralIndexes.length; i++) {
      expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
    }
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    // Base reserves fall by the FULL debt paid out (userBalance is the borrower's negative base balance).
    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);
