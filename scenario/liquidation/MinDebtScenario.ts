import { scenario } from '../context/CometContext';
import { expect } from 'chai';
import {
  Entry,
  hasModule,
  configureModule,
  captureAbsorbStateBefore,
  makeCollateralStates,
  usableCollateralIndices,
  usesAssetList,
  zeroBaseBorrowMin,
} from '../utils';
import { mulPrice, mulFactor, divPrice, factorScale } from '../../test/helpers';
import { ContractTransaction } from 'ethers';

/**
 * Min-debt (sub-`baseBorrowMin`) absorb scenarios for the liquidation module — the mirror of
 * `test/liquidation-logic/min-debt.test.ts`, run against forked deployments.
 *
 * When a liquidatable account's debt is already below `baseBorrowMin`, absorb closes the whole
 * (small) debt in one shot and seizes only as much collateral as the debt needs — a PARTIAL seizure
 * that leaves a surplus. The end state is identical across both entry points (Comet.absorb vs
 * LiquidationModule.liquidate) and both modes (default/partial vs full-close): the sub-min branch
 * always closes fully and seizes just enough, so it does not depend on the partial-liquidation toggle.
 */
function absorbScenarios(entry: Entry, partial: boolean) {
  const mode = partial ? 'default' : 'full-close';
  const tag = `entry=${entry}, mode=${mode}`;

  /**
   * 1 collateral: debt below the min debt, and the collateral still covers it — partial seizure.
   *
   * Proves the simplest sub-min-debt path: the debt is under `baseBorrowMin` before absorb even runs,
   * and the one collateral held is worth enough (after the liquidation factor) to close it with room
   * to spare. Only part of the collateral is taken, and the account is left healthy with a surplus.
   */
  scenario(
    `Comet#absorb > min debt: 1 collateral partially seized, surplus remains [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await usesAssetList(ctx)) &&
        !(await zeroBaseBorrowMin(ctx)) &&
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
      // Freeze interest so the sub-min debt stays exactly where we put it — the partial-seizure and
      // reserve assertions below are exact, with no intra-block accrual to reason about.
      await context.zeroBorrowRates();

      const info = await comet.getAssetInfo(collateralIndex);
      const scale = info.scale.toBigInt();
      const originalPrice = (await comet.getPrice(info.priceFeed)).toBigInt();
      const borrowCF = info.borrowCollateralFactor.toBigInt();
      const lcf = info.liquidateCollateralFactor.toBigInt();
      const lf = info.liquidationFactor.toBigInt();
      const collateralAsset = context.getAssetByAddress(info.asset);

      // 1. Supply enough collateral to support a borrow above the normal minimum, then borrow it:
      //      borrowAmount    = 1.2 * baseBorrowMin
      //      collateralValue = borrowValue / BCF, with a 10% rounding buffer
      const borrowAmount = (12n * baseBorrowMin) / 10n;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
      const collateralValue = ((borrowValue * factorScale) / borrowCF * 110n) / 100n;
      const collateralAmount = (collateralValue * scale) / originalPrice + 1n;

      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: info.asset, amount: collateralAmount });

      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 2. Repay part of the borrow so the remaining debt sits below baseBorrowMin.
      const repayAmount = (4n * baseBorrowMin) / 10n;
      await baseAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: baseToken, amount: repayAmount });
      const remainingDebt = (await comet.borrowBalanceOf(albert.address)).toBigInt();
      expect(remainingDebt).to.be.lessThan(baseBorrowMin);

      // 3. Drop the collateral price into the partial-seizure window. The position must become
      //    liquidatable (debt > value·LCF) while the collateral's liquidation value still covers the
      //    debt (value·LF > debt) — since the protocol enforces LCF < LF, that band always exists.
      //    Pick its midpoint so both inequalities hold with margin:
      //      lowerValue = debt / LF   (LF-seizure exactly covers the debt)
      //      upperValue = debt / LCF  (position stops being liquidatable)
      //      target     = (lowerValue + upperValue) / 2
      const remainingDebtValue = mulPrice(remainingDebt, basePrice, baseScale);
      const lowerValue = (remainingDebtValue * factorScale) / lf;
      const upperValue = (remainingDebtValue * factorScale) / lcf;
      const targetCollateralValue = (lowerValue + upperValue) / 2n;
      const droppedPrice = (targetCollateralValue * scale) / collateralAmount;
      await context.changePriceFeeds({ [info.asset]: Number(droppedPrice) / 1e8 });

      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // 4. Capture state and run the sanity checks that define the sub-min partial-seizure case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralState] = await makeCollateralStates(comet, context, albert.address, [collateralIndex]);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
      const collateralValueAfterLF = mulFactor(
        mulPrice(collateralState.collateralBalance, collateralState.price, collateralState.scale),
        lf
      );

      // User is liquidatable, the debt is below the minimum, and the collateral's LF-weighted value
      // still exceeds the debt — so the seizure is partial and leaves a surplus.
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.lessThan(baseBorrowMin);
      expect(collateralValueAfterLF).to.be.greaterThan(debtValueBefore);

      // 5. Absorb via the active entry point.
      let absorbTx: ContractTransaction;
      if (entry === 'absorb') {
        absorbTx = await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        absorbTx = await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 6. Independently derive the expected event values. presentValue() on the captured principal at
      //    the post-absorb index gives exactly the debt the branch closed:
      //      debtValue   = debtAtAbsorb priced in USD
      //      wantedValue = debtValue / LF                  (gross collateral value to seize)
      //      seizeAmount = wantedValue * scale / price      (divPrice)
      //      seizedValue = seizeAmount * price / scale      (mulPrice — the event's value field)
      const debtAtAbsorb = -(await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      const basePaidOutValue = mulPrice(debtAtAbsorb, basePrice, baseScale);
      const wantedCollateralValue = (basePaidOutValue * factorScale) / lf;
      const seizeAmount = divPrice(wantedCollateralValue, collateralState.price, collateralState.scale);
      const seizedValue = mulPrice(seizeAmount, collateralState.price, collateralState.scale);

      // 7. Post-absorb checks.

      // AbsorbDebt is emitted for the FULL (small) debt — the whole sub-min debt is closed at once.
      await expect(absorbTx)
        .to.emit(module, 'AbsorbDebt')
        .withArgs(betty.address, albert.address, debtAtAbsorb, basePaidOutValue);
      // AbsorbCollateral is emitted for a PARTIAL seizure — only enough to cover the debt after LF.
      await expect(absorbTx)
        .to.emit(module, 'AbsorbCollateral')
        .withArgs(betty.address, albert.address, collateralState.asset, seizeAmount, seizedValue);

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect((await comet.userBasic(albert.address)).principal).to.equal(0);
      expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // Only part of the collateral is seized; a surplus remains and the account is healthy again.
      const remainingCollateral = collateralState.collateralBalance - seizeAmount;
      expect(remainingCollateral).to.be.greaterThan(0n);
      expect(await comet.collateralBalanceOf(albert.address, collateralState.asset)).to.equal(remainingCollateral);
      expect((await comet.userCollateral(albert.address, collateralState.asset)).balance).to.equal(remainingCollateral);
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // Collateral remains, so the user's assetsIn bit and reserved bits are untouched.
      expect((await comet.userBasic(albert.address)).assetsIn).to.equal(cometStateBefore.user.assetsIn);
      expect((await comet.userBasic(albert.address))._reserved).to.equal(cometStateBefore.user._reserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(totalsAfter.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: supplied total drops by the seized amount, reserves rise by it,
      // and the collateral + base ERC20 balances are untouched on the absorb path.
      expect((await comet.totalsCollateral(collateralState.asset)).totalSupplyAsset)
        .to.equal(collateralState.totalsCollateral - seizeAmount);
      expect(await comet.getCollateralReserves(collateralState.asset))
        .to.equal(collateralState.collateralReserves + seizeAmount);
      expect(await collateralAsset.balanceOf(comet.address)).to.equal(collateralState.cometErc20Balance);
      expect(await baseAsset.balanceOf(comet.address)).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the debt paid out.
      expect(await comet.getReserves()).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
    }
  );
}

/*//////////////////////////////////////////////////////////////
                        REGISTER SCENARIOS
//////////////////////////////////////////////////////////////*/

absorbScenarios('absorb', true);
absorbScenarios('liquidate', true);
absorbScenarios('absorb', false);
