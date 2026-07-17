import { scenario } from '../context/CometContext';
import { expect } from 'chai';
import {
  Entry,
  hasModule,
  configureModule,
  captureAbsorbStateBefore,
  getAssetInfo,
  makeCollateralStates,
  TARGET_HF,
  getUsableCollateralIndices,
  wantedCollateralValue,
} from '../utils';
import { mulPrice, mulFactor, divPrice, factorScale, principalValue } from '../../test/helpers';

/**
 * Partial-liquidation scenarios for the liquidation module — run against forked deployments with
 * `partialLiquidationEnabled = true` throughout (the full-close mode is covered by the absorb /
 * min-debt / bad-debt scenario files).
 *
 * Here absorb does NOT close the debt. The outer loop sizes the seizure with the target-health-factor
 * formula: it takes only as much collateral as is needed to bring the position back to
 * `TARGET_HEALTH_FACTOR`, leaves the borrower with a smaller (but still live) debt, and leaves the
 * rest of the collateral alone. Both entry points — Comet.absorb and LiquidationModule.liquidate —
 * must produce the same end state.
 */
function absorbScenarios(entry: Entry) {
  const tag = `entry=${entry}, mode=default`;

  /**
   * The base case for partial liquidation: a single collateral with plenty of headroom. The position is
   * underwater but nowhere near a wipeout, so the target-HF formula seizes only part of the collateral,
   * the debt is reduced rather than closed, and the borrower walks away still borrowing — healthy again,
   * with most of the collateral untouched.
   */
  scenario(
    `Comet#absorb > 1 collateral: partial seizure, user has enough to cover debt [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 1)).length > 0,
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
      const liquidationModule = await configureModule(context, world, entry, true, betty.address);
      await comet.accrueAccount(albert.address);

      // 4. Capture state and run the sanity checks that define the partial-seizure case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [collateralIndex]);
      const debtBefore = -cometStateBefore.userBalance; // the borrower's debt in base units (userBalance is negative)
      const debtValueBefore = mulPrice(debtBefore, basePrice, baseScale);
      const collateralValueBefore = mulPrice(collateralStateBefore.collateralBalance, collateralStateBefore.price, collateralStateBefore.scale);

      // 5. Independently derive the expected seizure, mirroring the target-HF formula. The collateral is
      //    the only one the borrower holds, so its BCF-weighted value IS totalCollateralizedValue:
      //      totalCollateralizedValue = collateralValue * BCF                     (mulFactor)
      //      wanted      = (debtValue * targetHF - totalCollateralizedValue) / (LF * targetHF - BCF)
      //      seizeAmount = wanted * scale / price                                 (divPrice)
      //      seizedValue = wanted * LF                                            (mulFactor)
      //    and the debt is reduced by seizedValue rather than closed. Derived before the absorb so the
      //    sanity checks below can assert which branch the seizure lands in.
      const totalCollateralizedValue = mulFactor(collateralValueBefore, collateralBCF);
      const wantedValue = wantedCollateralValue(debtValueBefore, totalCollateralizedValue, collateralLF, collateralBCF);
      collateralStateBefore.seizeAmount = divPrice(wantedValue, collateralStateBefore.price, collateralStateBefore.scale);
      collateralStateBefore.seizedValue = mulFactor(wantedValue, collateralLF);

      // The debt left behind, and the base actually paid out for it.
      const debtValueRemaining = debtValueBefore - collateralStateBefore.seizedValue;
      const debtRemaining = divPrice(debtValueRemaining, basePrice, baseScale);
      const basePaidOut = debtBefore - debtRemaining;

      // The account is liquidatable, and its LCF-weighted health factor is below the target the module
      // aims to restore.
      //   healthFactor = collateralValue * LCF / debtValue
      const healthFactorBefore = (mulFactor(collateralValueBefore, collateralLCF) * factorScale) / debtValueBefore;
      expect(healthFactorBefore).to.be.lessThan(TARGET_HF);
      expect(await comet.isLiquidatable(albert.address)).to.be.true;

      // The debt starts ABOVE the minimum, so the loop does not take the full-close branch on entry.
      expect(debtBefore).to.be.greaterThan(baseBorrowMin);
      expect(debtValueBefore).to.be.greaterThan(minDebtValue);

      // The module never wants more collateral than the debt itself is worth: it caps `wanted` at
      // debtValue / LF, and hitting that cap means the seizure repays the debt outright. That cap must
      // stay slack here — the seizure has to be a genuine partial one, so the target-HF formula must
      // come out strictly under it. (It does whenever the collateral covers the debt, i.e. v*LF > D.)
      const maxWantedCollateralValue = (debtValueBefore * factorScale) / collateralLF;
      expect(wantedValue).to.be.lessThan(maxWantedCollateralValue);

      // The collateral is worth more than the formula wants, so a genuine partial seizure is computed
      // rather than a full drain of the asset.
      expect(wantedValue).to.be.lessThan(collateralValueBefore);

      // And the seizure it computes does NOT trip the min-debt guard: after paying down by S*LF the
      // debt is still above the minimum, so the module stays on the partial path instead of bailing out
      // into the full-close formula. This is what keeps the scenario strictly in the partial case.
      expect(debtValueBefore - collateralStateBefore.seizedValue).to.be.greaterThan(minDebtValue);

      // 6. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await liquidationModule.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 7. Post-absorb checks. Capture the comet + collateral state again and diff against the before
      //    snapshots, the same way the before state was captured.
      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [collateralIndex]);

      // The debt is REDUCED, not closed: the borrower is left owing exactly the debt the seizure did not
      // cover. The module writes that balance back as principal, projected backward by the borrow index:
      //   principal = -((debtRemaining * BASE_INDEX_SCALE + baseBorrowIndex - 1) / baseBorrowIndex)
      const expectedPrincipal = principalValue(-debtRemaining, cometStateAfter.totals.baseSupplyIndex, cometStateAfter.totals.baseBorrowIndex);
      expect(cometStateAfter.user.principal).to.equal(expectedPrincipal);
      expect(-cometStateAfter.userBalance).to.equal(debtRemaining);
      // Still a borrower, so the simple (non-negative) base balance is zero.
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // Only the target-sized slice of the collateral is seized; the rest stays with the borrower.
      const remainingCollateral = collateralStateBefore.collateralBalance - collateralStateBefore.seizeAmount;
      expect(collateralStateAfter.collateralBalance).to.equal(remainingCollateral);
      expect((await comet.userCollateral(albert.address, collateralAssetInfo.asset)).balance).to.equal(remainingCollateral);

      // Health is restored: the position is no longer liquidatable, and its LCF-weighted health factor
      // now sits above the target (the formula restores the BCF-weighted one to exactly targetHF, and
      // LCF > BCF, so the LCF-weighted one clears it).
      const collateralValueAfter = mulPrice(remainingCollateral, collateralStateAfter.price, collateralStateAfter.scale);
      const debtValueAfter = mulPrice(debtRemaining, basePrice, baseScale);
      const healthFactorAfter = (mulFactor(collateralValueAfter, collateralLCF) * factorScale) / debtValueAfter;
      expect(healthFactorAfter).to.be.greaterThan(TARGET_HF);
      
      // The account is no longer liquidatable.
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // Collateral remains, so the user's assetsIn bit and reserved bits are untouched.
      expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
      expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

      // Comet borrow state: borrow base drops by the principal actually repaid; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal).sub(cometStateAfter.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: supplied total drops by the seized amount, reserves rise by it, and
      // the collateral + base ERC20 balances are untouched on the absorb path.
      expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.seizeAmount);
      expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.seizeAmount);
      expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the base actually paid out — only the part of the debt that was repaid,
      // not the whole of it.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves - basePaidOut);
    }
  );

  /**
   * Multi-collateral partial liquidation. The outer loop cannot restore health from the first collateral
   * alone — the target-HF formula wants more of it than it is worth — so it drains the first outright and
   * carries the shortfall to the second, where a target-HF partial seizure finishes the job. This proves
   * the "fully seize what can't cover the target, then close out on the next asset" walk: the first
   * seizure is identical to full-close mode, and only the last asset's sizing is the partial-mode one.
   */
  scenario(
    `Comet#absorb > multi-collateral: full seizure of first asset then partial of second [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 2)).length === 2,
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

      // The first two collaterals usable for the liquidation math, in the order the absorb loop walks
      // them: [0] is dropped and fully seized, [1] is left at its price and partially seized.
      const collateralIndexes = await getUsableCollateralIndices(context, 2);

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
      const liquidationModule = await configureModule(context, world, entry, true, betty.address);
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

      // 6. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await liquidationModule.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 7. Independently derive the expected seizures by simulating the loop from the captured pre-absorb
      //    values — so the expected amounts match the contract's rounding exactly.

      // Iteration 1 (first collateral): the whole collateralized value backs the debt. The formula wants
      // more of the first collateral than it is worth, so it is fully seized and its whole balance goes.
      collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
      collateralStatesBefore[0].seizedValue = mulFactor(firstValue, collateralInfos[0].liquidationFactor);

      // Iteration 2 (second collateral): with the first collateral gone from the running total, the only
      // collateral still backing the debt is the second, so totalCollateralizedValue is its BCF-weighted
      // value alone. The formula wants less of it than it is worth, so it is only partially seized.
      const debtValueAfterFirst = debtValueBefore - collateralStatesBefore[0].seizedValue;
      const secondTotalCollateralizedValue = mulFactor(secondValue, collateralInfos[1].borrowCollateralFactor);
      const secondWanted = wantedCollateralValue(debtValueAfterFirst, secondTotalCollateralizedValue, collateralInfos[1].liquidationFactor, collateralInfos[1].borrowCollateralFactor);
      collateralStatesBefore[1].seizeAmount = divPrice(secondWanted, collateralStatesBefore[1].price, collateralStatesBefore[1].scale);
      collateralStatesBefore[1].seizedValue = mulFactor(secondWanted, collateralInfos[1].liquidationFactor);

      // The second seizure does not trip the min-debt guard: the debt left after it is still above the
      // minimum, so the module stays on the partial path rather than closing out.
      expect(debtValueAfterFirst - collateralStatesBefore[1].seizedValue).to.be.greaterThan(minDebtValue);

      // The debt left behind, and the base actually paid out for it.
      const debtValueRemaining = debtValueAfterFirst - collateralStatesBefore[1].seizedValue;
      const debtRemaining = divPrice(debtValueRemaining, basePrice, baseScale);
      const basePaidOut = (-cometStateBefore.userBalance) - debtRemaining;

      // 8. Post-absorb checks. Capture the comet + collateral state again and diff against the before
      //    snapshots.
      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralIndexes);

      // The debt is REDUCED, not closed: the borrower is left owing exactly the debt the two seizures did
      // not cover, written back as principal projected backward by the borrow index.
      const expectedPrincipal = principalValue(-debtRemaining, cometStateAfter.totals.baseSupplyIndex, cometStateAfter.totals.baseBorrowIndex);
      expect(cometStateAfter.user.principal).to.equal(expectedPrincipal);
      expect(-cometStateAfter.userBalance).to.equal(debtRemaining);

      // Still a borrower, so the simple (non-negative) base balance is zero.
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // First collateral is drained; second keeps the surplus left after its partial seizure.
      const secondRemaining = collateralStatesBefore[1].collateralBalance - collateralStatesBefore[1].seizeAmount;
      expect(collateralStatesAfter[0].collateralBalance).to.equal(0n);
      expect((await comet.userCollateral(albert.address, collateralInfos[0].asset)).balance).to.equal(0);
      expect(collateralStatesAfter[1].collateralBalance).to.equal(secondRemaining);
      expect((await comet.userCollateral(albert.address, collateralInfos[1].asset)).balance).to.equal(secondRemaining);

      // Health is restored above the target, and the account is no longer liquidatable.
      const liquidityAfter =
        mulFactor(mulPrice(secondRemaining, collateralStatesAfter[1].price, collateralStatesAfter[1].scale), collateralInfos[1].liquidateCollateralFactor);
      const healthFactorAfter = (liquidityAfter * factorScale) / mulPrice(debtRemaining, basePrice, baseScale);
      expect(healthFactorAfter).to.be.greaterThan(TARGET_HF);

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

      // Comet borrow state: borrow base drops by the principal actually repaid; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal).sub(cometStateAfter.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting, per asset: supplied totals drop by that asset's own seized amount,
      // reserves rise by it, and the ERC20 balances are untouched on the absorb path.
      for (let i = 0; i < collateralIndexes.length; i++) {
        expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
        expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
        expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
      }
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the base actually paid out — only the part of the debt that was repaid.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves - basePaidOut);
    }
  );

  /**
   * All collaterals: the loop drains every asset but the last, then the last closes what remains with a
   * partial seizure. This proves the walk-every-asset behavior of the general absorb scenarios holds
   * under partial liquidation too — every earlier asset is fully seized in index order, and only the
   * closing asset's seizure size depends on the mode. Needs a market with more than two collaterals, so
   * it is skipped on the two-asset development deployment.
   */
  scenario(
    `Comet#absorb > all collaterals: last one covers the debt, the rest are fully seized [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx)).length > 2,
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

      // Every usable collateral, in index order. The last is the closing collateral (partially seized);
      // all earlier ones are the small assets that get fully drained first.
      const collateralIndexes = await getUsableCollateralIndices(context);
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
      const liquidationModule = await configureModule(context, world, entry, true, betty.address);
      await comet.accrueAccount(albert.address);

      // 5. Capture the pre-absorb state and run the sanity checks that define this case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralIndexes);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
      const collateralValuesBefore = collateralStatesBefore.map((state) => mulPrice(state.collateralBalance, state.price, state.scale));

      // Sanity checks before absorb: the account is liquidatable, with its LCF-weighted health factor
      // (across every collateral) below the target the module aims to restore.
      let liquidityBefore: bigint;
      for (let i = 0; i < collateralIndexes.length; i++) {
        liquidityBefore += mulFactor(collateralValuesBefore[i], collateralInfos[i].liquidateCollateralFactor);
      }
      const healthFactorBefore = (liquidityBefore * factorScale) / debtValueBefore;
      expect(healthFactorBefore).to.be.lessThan(TARGET_HF);
      expect(await comet.isLiquidatable(albert.address)).to.be.true;

      // 6. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await liquidationModule.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 7. Independently derive the expected seizures by simulating the loop from the captured pre-absorb
      //    values, so the expected amounts match the contract's rounding exactly.

      // Every small asset is fully seized in index order; the debt drops by each one's LF-weighted value.
      let debtValueRemaining = debtValueBefore;
      for (let i = 0; i < closing; i++) {
        collateralStatesBefore[i].seizeAmount = collateralStatesBefore[i].collateralBalance;
        collateralStatesBefore[i].seizedValue = mulFactor(collateralValuesBefore[i], collateralInfos[i].liquidationFactor);
        debtValueRemaining -= collateralStatesBefore[i].seizedValue;
      }

      // Closing collateral: with every small gone from the running total, the only collateral still backing
      // the debt is the closing one, so totalCollateralizedValue is its BCF-weighted value alone. The
      // formula wants less of it than it is worth, so it is only partially seized.
      const closingTotalCollateralizedValue = mulFactor(collateralValuesBefore[closing], collateralInfos[closing].borrowCollateralFactor);
      const closingWanted = wantedCollateralValue(debtValueRemaining, closingTotalCollateralizedValue, collateralInfos[closing].liquidationFactor, collateralInfos[closing].borrowCollateralFactor);
      collateralStatesBefore[closing].seizeAmount = divPrice(closingWanted, collateralStatesBefore[closing].price, collateralStatesBefore[closing].scale);
      collateralStatesBefore[closing].seizedValue = mulFactor(closingWanted, collateralInfos[closing].liquidationFactor);

      // The closing seizure does not trip the min-debt guard: the debt left after it stays above the
      // minimum, so the module stays on the partial path rather than closing out.
      expect(debtValueRemaining - collateralStatesBefore[closing].seizedValue).to.be.greaterThan(minDebtValue);

      // The debt left behind, and the base actually paid out for it.
      const debtValueLeft = debtValueRemaining - collateralStatesBefore[closing].seizedValue;
      const debtRemaining = divPrice(debtValueLeft, basePrice, baseScale);
      const basePaidOut = -cometStateBefore.userBalance - debtRemaining;

      // 8. Post-absorb checks. Capture the comet + collateral state again and diff against the before
      //    snapshots.
      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralIndexes);

      // The debt is REDUCED, not closed: the borrower is left owing exactly the debt the basket did not
      // cover, written back as principal projected backward by the borrow index.
      const expectedPrincipal = principalValue(-debtRemaining, cometStateAfter.totals.baseSupplyIndex, cometStateAfter.totals.baseBorrowIndex);
      expect(cometStateAfter.user.principal).to.equal(expectedPrincipal);
      expect(-cometStateAfter.userBalance).to.equal(debtRemaining);
      // Still a borrower, so the simple (non-negative) base balance is zero.
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // Every small asset is drained; the closing collateral keeps the surplus after its partial seizure.
      const closingRemaining = collateralStatesBefore[closing].collateralBalance - collateralStatesBefore[closing].seizeAmount;
      for (let i = 0; i < closing; i++) {
        expect(collateralStatesAfter[i].collateralBalance).to.equal(0n);
        expect((await comet.userCollateral(albert.address, collateralInfos[i].asset)).balance).to.equal(0);
      }
      expect(collateralStatesAfter[closing].collateralBalance).to.equal(closingRemaining);
      expect((await comet.userCollateral(albert.address, collateralInfos[closing].asset)).balance).to.equal(closingRemaining);

      // Health is restored above the target, and the account is no longer liquidatable.
      const liquidityAfter = mulFactor(mulPrice(closingRemaining, collateralStatesAfter[closing].price, collateralStatesAfter[closing].scale), collateralInfos[closing].liquidateCollateralFactor);
      const healthFactorAfter = (liquidityAfter * factorScale) / mulPrice(debtRemaining, basePrice, baseScale);
      expect(healthFactorAfter).to.be.greaterThan(TARGET_HF);
      
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

      // Comet borrow state: borrow base drops by the principal actually repaid; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal).sub(cometStateAfter.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting, per asset: supplied totals drop by that asset's own seized amount,
      // reserves rise by it, and the ERC20 balances are untouched on the absorb path.
      for (let i = 0; i < collateralIndexes.length; i++) {
        expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
        expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
        expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
      }
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the base actually paid out — only the part of the debt that was repaid.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves - basePaidOut);
    }
  );

  /**
   * Two collaterals where the very first the loop touches is already enough. A large first collateral and
   * a tiny second: the target-HF formula's partial seizure of the first alone restores the position to
   * exactly targetHF, so the loop breaks and never reaches the second. This proves the early-break path —
   * only one asset is seized even though two are held, identically in both modes.
   */
  scenario(
    `Comet#absorb > 2 collaterals: partial seizure of the first restores targetHF, second untouched [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 2)).length === 2,
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

      // The first two collaterals usable for the liquidation math. [0] is the large one that is partially
      // seized; [1] is a tiny one the loop never reaches.
      const collateralIndexes = await getUsableCollateralIndices(context, 2);

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
      const liquidationModule = await configureModule(context, world, entry, true, betty.address);
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

      // 5. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await liquidationModule.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 6. Independently derive the expected seizure. When the loop reaches the first collateral neither
      //    has been touched, so totalCollateralizedValue is BOTH collaterals' BCF-weighted value.
      const totalCollateralizedValue = mulFactor(firstValue, collateralInfos[0].borrowCollateralFactor) + mulFactor(secondValueBefore, collateralInfos[1].borrowCollateralFactor);
      const firstWanted = wantedCollateralValue(debtValueBefore, totalCollateralizedValue, collateralInfos[0].liquidationFactor, collateralInfos[0].borrowCollateralFactor);
      collateralStatesBefore[0].seizeAmount = divPrice(firstWanted, collateralStatesBefore[0].price, collateralStatesBefore[0].scale);
      collateralStatesBefore[0].seizedValue = mulFactor(firstWanted, collateralInfos[0].liquidationFactor);
      // The second collateral is never reached, so its seize amount stays zero.

      // The formula wants less of the first collateral than it is worth — a genuine partial seizure.
      expect(firstWanted).to.be.lessThan(firstValue);

      // After the first partial seizure the position is back at exactly targetHF, so the loop's break
      // condition (targetHF*debtRemaining <= remaining collateralized value) holds and the second
      // collateral is never touched.
      const debtValueRemaining = debtValueBefore - collateralStatesBefore[0].seizedValue;
      const totalCollateralizedValueAfter = totalCollateralizedValue - mulFactor(firstWanted, collateralInfos[0].borrowCollateralFactor);
      expect(mulFactor(debtValueRemaining, TARGET_HF)).to.be.at.most(totalCollateralizedValueAfter);

      // The partial seizure does not trip the min-debt guard: the debt left stays above the minimum.
      expect(debtValueRemaining).to.be.greaterThan(minDebtValue);

      // The debt left behind, and the base actually paid out for it.
      const debtRemaining = divPrice(debtValueRemaining, basePrice, baseScale);
      const basePaidOut = -cometStateBefore.userBalance - debtRemaining;

      // 7. Post-absorb checks. Capture the comet + collateral state again and diff against the before
      //    snapshots.
      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralIndexes);

      // The debt is REDUCED, not closed: the borrower is left owing exactly the debt the seizure did not
      // cover, written back as principal projected backward by the borrow index.
      const expectedPrincipal = principalValue(-debtRemaining, cometStateAfter.totals.baseSupplyIndex, cometStateAfter.totals.baseBorrowIndex);
      expect(cometStateAfter.user.principal).to.equal(expectedPrincipal);
      expect(-cometStateAfter.userBalance).to.equal(debtRemaining);
      // Still a borrower, so the simple (non-negative) base balance is zero.
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // First collateral reduced by its seize amount with a surplus; second collateral fully untouched.
      const firstRemaining = collateralStatesBefore[0].collateralBalance - collateralStatesBefore[0].seizeAmount;
      expect(collateralStatesAfter[0].collateralBalance).to.equal(firstRemaining);
      expect((await comet.userCollateral(albert.address, collateralInfos[0].asset)).balance).to.equal(firstRemaining);
      expect(collateralStatesAfter[1].collateralBalance).to.equal(collateralStatesBefore[1].collateralBalance);
      expect((await comet.userCollateral(albert.address, collateralInfos[1].asset)).balance).to.equal(collateralStatesBefore[1].collateralBalance);

      // Health is restored above the target, and the account is no longer liquidatable.
      const liquidityAfter = mulFactor(mulPrice(firstRemaining, collateralStatesAfter[0].price, collateralStatesAfter[0].scale), collateralInfos[0].liquidateCollateralFactor) + mulFactor(secondValueBefore, collateralInfos[1].liquidateCollateralFactor);
      const healthFactorAfter = (liquidityAfter * factorScale) / mulPrice(debtRemaining, basePrice, baseScale);
      expect(healthFactorAfter).to.be.greaterThan(TARGET_HF);
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // Both collaterals still have a balance, so assetsIn and reserved are unchanged.
      expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
      expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

      // Comet borrow state: borrow base drops by the principal actually repaid; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal).sub(cometStateAfter.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: the first drops by its seized amount and its reserves rise by it; the
      // untouched second's totals and reserves stay exactly where they were (its seize amount is zero).
      for (let i = 0; i < collateralIndexes.length; i++) {
        expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
        expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
        expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
      }
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the base actually paid out — only the part of the debt that was repaid.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves - basePaidOut);
    }
  );
}

/*//////////////////////////////////////////////////////////////
                        REGISTER SCENARIOS
//////////////////////////////////////////////////////////////*/

absorbScenarios('absorb');
absorbScenarios('liquidate');
