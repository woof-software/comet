import { scenario } from '../context/CometContext';
import { expect } from 'chai';
import {
  Entry,
  hasModule,
  configureModule,
  captureAbsorbStateBefore,
  makeCollateralStates,
  getAssetInfo,
  TARGET_HF,
  getUsableCollateralIndices,
} from '../utils';
import { mulPrice, mulFactor, divPrice, factorScale } from '../../test/helpers';

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
   * Proves the simplest sub-min-debt path: the debt is under `baseBorrowMin` before absorb even runs,
   * and the one collateral held is worth enough (after the liquidation factor) to close it with room
   * to spare. Only part of the collateral is taken, and the account is left healthy with a surplus.
   */
  scenario(
    `Comet#absorb > debt below the min debt, and the collateral still covers it - partial seizure [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 1)).length > 0,
    },
    async ({ comet, actors }, context, world) => {
      await context.freezeBorrowRates();

      const { albert, betty } = actors;

      // Use the first collateral usable for the liquidation math (all three factors positive).
      const [collateralIndex] = await getUsableCollateralIndices(context, 1);

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const originalPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();
      const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);

      // 1. Supply enough collateral to support a borrow above the normal minimum, then borrow it:
      //      borrowAmount    = 1.2 * baseBorrowMin
      //      collateralValue = borrowValue / BCF, with a 10% rounding buffer
      const borrowAmount = (12n * baseBorrowMin) / 10n;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
      const collateralValue = ((borrowValue * factorScale) / collateralAssetInfo.borrowCollateralFactor * 110n) / 100n;
      const collateralAmount = (collateralValue * collateralAssetInfo.scale) / originalPrice + 1n;

      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });

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
      const lowerValue = (remainingDebtValue * factorScale) / collateralAssetInfo.liquidationFactor;
      const upperValue = (remainingDebtValue * factorScale) / collateralAssetInfo.liquidateCollateralFactor;
      const targetCollateralValue = (lowerValue + upperValue) / 2n;
      const droppedPrice = (targetCollateralValue * collateralAssetInfo.scale) / collateralAmount;
      await context.changePriceFeeds({ [collateralAssetInfo.asset]: droppedPrice });

      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // 4. Capture state and run the sanity checks that define the sub-min partial-seizure case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralState] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
      const collateralValueAfterLF = mulFactor(mulPrice(collateralState.collateralBalance, droppedPrice, collateralAssetInfo.scale), collateralAssetInfo.liquidationFactor);

      // User is liquidatable, the debt is below the minimum, and the collateral's LF-weighted value
      // still exceeds the debt — so the seizure is partial and leaves a surplus.
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.lessThan(baseBorrowMin);
      expect(collateralValueAfterLF).to.be.greaterThan(debtValueBefore);

      // 5. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 6. Independently derive the expected event values. presentValue() on the captured principal at
      //    the post-absorb index gives exactly the debt the branch closed:
      //      debtValue   = debtAtAbsorb priced in USD
      //      wantedValue = debtValue / LF                  (gross collateral value to seize)
      //      seizeAmount = wantedValue * scale / price      (divPrice)
      //      seizedValue = seizeAmount * price / scale      (mulPrice — the event's value field)
      const debtAtAbsorb = -(await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      const basePaidOutValue = mulPrice(debtAtAbsorb, basePrice, baseScale);
      const wantedCollateralValue = (basePaidOutValue * factorScale) / collateralAssetInfo.liquidationFactor;
      collateralState.seizeAmount = divPrice(wantedCollateralValue, droppedPrice, collateralAssetInfo.scale);

      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);

      // 7. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // Only part of the collateral is seized; a surplus remains and the account is healthy again.
      const remainingCollateral = collateralState.collateralBalance - collateralState.seizeAmount;
      expect(collateralStateAfter.collateralBalance).to.equal(remainingCollateral);
      expect(collateralStateAfter.userCollateral.balance).to.equal(remainingCollateral);

      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // Collateral remains, so the user's assetsIn bit and reserved bits are untouched.
      expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
      expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: supplied total drops by the seized amount, reserves rise by it,
      // and the collateral + base ERC20 balances are untouched on the absorb path.
      expect(collateralStateAfter.totalsCollateral).to.equal(collateralState.totalsCollateral - collateralState.seizeAmount);
      expect(collateralStateAfter.collateralReserves).to.equal(collateralState.collateralReserves + collateralState.seizeAmount);
      expect(collateralStateAfter.cometErc20Balance).to.equal(collateralState.cometErc20Balance);
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the debt paid out.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
    }
  );

  /**
   * Proves the sub-min branch is not gated on a "first full seizure": the debt is already below
   * `baseBorrowMin` when absorb starts, so EVERY collateral the loop touches goes straight into the
   * full-close formula — starting with the first one. The first collateral cannot cover the (already
   * small) debt even at its full LF-weighted value, so it is drained and the shortfall is carried
   * forward; the second closes the remainder and keeps its surplus.
   */
  scenario(
    `Comet#absorb > debt below the min debt, first collateral fully seized then the second closes it [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 2)).length === 2,
    },
    async ({ comet, actors }, context, world) => {
      await context.freezeBorrowRates();

      const { albert, betty } = actors;

      // The first two collaterals usable for the liquidation math, in the order the absorb loop walks
      // them: [0] is drained, [1] closes the remaining debt.
      const collateralIndexes = await getUsableCollateralIndices(context, 2);

      const collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
      const collateralPrices = await Promise.all(collateralInfos.map(async (collateralAssetInfo) => (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt()));

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      // 1. Supply both collaterals, each worth 1.5× the minimum debt:
      //      minDebtValue    = baseBorrowMin priced in USD
      //      collateralValue = 1.5 * minDebtValue      (per asset)
      //      amount          = collateralValue * scale / price
      //    Sized off baseBorrowMin, so it holds on any market whatever the collateral turns out to be.
      const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const collateralValue = (15n * minDebtValue) / 10n;

      for (let i = 0; i < collateralInfos.length; i++) {
        const collateralAssetInfo = collateralInfos[i];
        const amount = (collateralValue * collateralAssetInfo.scale) / collateralPrices[i] + 1n;
        const asset = context.getAssetByAddress(collateralAssetInfo.asset);

        await context.sourceTokens(amount, asset, albert);
        await asset.approve(albert, comet.address);
        await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount });
      }

      // 2. Borrow above the minimum: borrowAmount = 1.2 * baseBorrowMin.
      const borrowAmount = (12n * baseBorrowMin) / 10n;
      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 3. Repay part of the borrow so the remaining debt sits below baseBorrowMin:
      //      remainingDebt = 1.2 * baseBorrowMin - 0.4 * baseBorrowMin = 0.8 * baseBorrowMin
      //    From here on the absorb loop takes the full-close branch on its very first collateral.
      const repayAmount = (4n * baseBorrowMin) / 10n;
      await baseAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: baseToken, amount: repayAmount });
      const remainingDebt = (await comet.borrowBalanceOf(albert.address)).toBigInt();
      expect(remainingDebt).to.be.lessThan(baseBorrowMin);

      const remainingDebtValue = mulPrice(remainingDebt, basePrice, baseScale);
      const collateralStatesBeforeDrop = await makeCollateralStates(comet, context, albert.address, collateralInfos);

      // 4. Drop collateral [0]'s price until its whole LF-weighted value covers only half the debt — a
      //    full seizure then cannot close the position, so the loop carries the rest forward:
      //      valueAfterLF = debtValue / 2                (the debt this collateral can retire)
      //      value        = valueAfterLF / LF            (its market value after the drop)
      //      droppedPrice = value * scale / balance
      //    Every input is read from the market, so the drop sizes itself to whatever the asset is.
      const firstValueAfterLF = remainingDebtValue / 2n;
      const firstValue = (firstValueAfterLF * factorScale) / collateralInfos[0].liquidationFactor;
      const firstDroppedPrice = (firstValue * collateralInfos[0].scale) / collateralStatesBeforeDrop[0].collateralBalance;
      // What collateral [0] still contributes to the liquidity keeping the account out of liquidation.
      const firstLiquidity = mulFactor(firstValue, collateralInfos[0].liquidateCollateralFactor);

      // 5. Drop collateral [1]'s price into the window where it closes the carried-forward shortfall
      //    while the account stays liquidatable. Both bounds are on its market value:
      //      lowerValue = (debtValue - firstValueAfterLF) / LF   (an LF seizure exactly closes the rest)
      //      upperValue = (debtValue - firstLiquidity) / LCF     (account stops being liquidatable)
      //      target     = midpoint, so both hold with margin
      //    LCF < LF is enforced by the Configurator, so lowerValue < upperValue on every market: the
      //    window is never empty, whatever the collateral's factors are.
      const lowerValue = ((remainingDebtValue - firstValueAfterLF) * factorScale) / collateralInfos[1].liquidationFactor;
      const upperValue = ((remainingDebtValue - firstLiquidity) * factorScale) / collateralInfos[1].liquidateCollateralFactor;
      const secondValue = (lowerValue + upperValue) / 2n;
      const secondDroppedPrice = (secondValue * collateralInfos[1].scale) / collateralStatesBeforeDrop[1].collateralBalance;

      await context.changePriceFeeds({
        [collateralInfos[0].asset]: firstDroppedPrice,
        [collateralInfos[1].asset]: secondDroppedPrice,
      });

      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // 6. Capture state and run the sanity checks that define this case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStates = await makeCollateralStates(comet, context, albert.address, collateralInfos);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
      const firstValueAfterLFNow = mulFactor(mulPrice(collateralStates[0].collateralBalance, firstDroppedPrice, collateralInfos[0].scale), collateralInfos[0].liquidationFactor);
      const secondValueAfterLFNow = mulFactor(mulPrice(collateralStates[1].collateralBalance, secondDroppedPrice, collateralInfos[1].scale), collateralInfos[1].liquidationFactor);

      // The account is liquidatable and its debt is below the minimum, so the loop is in the full-close
      // branch from collateral [0] on.
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.lessThan(baseBorrowMin);
      // Collateral [0] cannot cover the debt on its own — it is fully seized and the rest carried
      // forward; collateral [1] covers exactly that shortfall, so it is only partially seized.
      expect(firstValueAfterLFNow).to.be.lessThan(debtValueBefore);
      expect(secondValueAfterLFNow).to.be.greaterThan(debtValueBefore - firstValueAfterLFNow);

      // 7. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 8. Independently derive the expected seizures, mirroring the full-close formula on both passes.
      //    Iter 1 (collateral [0]): insufficient → seize everything; the debt drops by its LF-weighted
      //    value, and the event reports its full market value.
      //      seizeAmount    = collateralBalance
      //      seizedValue    = seizeAmount * price / scale                    (mulPrice)
      //      debtAfterFirst = debtValue - seizedValue * LF                   (mulFactor)
      const debtAtAbsorb = -(await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      const basePaidOutValue = mulPrice(debtAtAbsorb, basePrice, baseScale);
      collateralStates[0].seizeAmount = collateralStates[0].collateralBalance;
      collateralStates[0].seizedValue = mulPrice(collateralStates[0].seizeAmount, firstDroppedPrice, collateralInfos[0].scale);
      const debtAfterFirst = basePaidOutValue - mulFactor(collateralStates[0].seizedValue, collateralInfos[0].liquidationFactor);

      //    Iter 2 (collateral [1]): covers the rest → seize only what the residual debt needs.
      //      seizeAmount = (debtAfterFirst / LF) / price                     (divPrice)
      //      seizedValue = seizeAmount * price / scale                       (mulPrice)
      collateralStates[1].seizeAmount = divPrice((debtAfterFirst * factorScale) / collateralInfos[1].liquidationFactor, secondDroppedPrice, collateralInfos[1].scale);
      collateralStates[1].seizedValue = mulPrice(collateralStates[1].seizeAmount, secondDroppedPrice, collateralInfos[1].scale);

      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

      // 9. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // Collateral [0] is drained; collateral [1] keeps the surplus left after closing the debt.
      const expectedSecondCollateralBalance = collateralStates[1].collateralBalance - collateralStates[1].seizeAmount;
      const collateralRemaining = [0n, expectedSecondCollateralBalance];
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].collateralBalance).to.equal(collateralRemaining[i]);
        expect(collateralStatesAfter[i].userCollateral.balance).to.equal(collateralRemaining[i]);
      }

      // Only the fully-seized collateral [0]'s bit is cleared, in whichever bitfield its index falls
      // (assetsIn for offsets 0-15, _reserved above that); the surviving collateral [1] keeps its bit.
      let expectedAssetsIn = cometStateBefore.user.assetsIn;
      let expectedReserved = cometStateBefore.user._reserved;
      if (collateralInfos[0].offset < 16) {
        expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[0].offset);
      } else {
        expectedReserved = expectedReserved & ~(1 << (collateralInfos[0].offset - 16));
      }
      expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
      expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting, per asset: supplied totals drop by that asset's own seized amount,
      // reserves rise by it, and the ERC20 balances are untouched on the absorb path.
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStates[i].totalsCollateral - collateralStates[i].seizeAmount);
        expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStates[i].collateralReserves + collateralStates[i].seizeAmount);
        expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStates[i].cometErc20Balance);
      }
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the debt paid out.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      // The position is healthy again.
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
    }
  );

  /**
   * Proves the sub-min branch is triggered by the debt REMAINING at that point in the loop, not by the
   * debt the account started with. Here the debt starts comfortably above `baseBorrowMin`, so the first
   * collateral is seized through the ordinary outer-loop path — its value cannot cover the wanted
   * amount, so it is drained. That single full seizure drops what is left of the debt below
   * `baseBorrowMin`, which routes the second collateral into the same full-close formula the sub-min
   * cases use: it covers the remainder, so it is only partially seized and keeps a surplus.
   */
  scenario(
    `Comet#absorb > first collateral fully seized drops the debt below the min debt, second closes it [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 2)).length === 2,
    },
    async ({ comet, actors }, context, world) => {
      await context.freezeBorrowRates();

      const { albert, betty } = actors;

      // The first two collaterals usable for the liquidation math, in the order the absorb loop walks
      // them: [0] is drained, [1] closes the remaining (by then sub-min) debt.
      const collateralIndexes = await getUsableCollateralIndices(context, 2);
      const collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
      const collateralPrices = await Promise.all(collateralInfos.map(async (collateralAssetInfo) => (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt()));

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      // 1. Supply both collaterals, each sized to carry the whole borrow on its own:
      //      borrowAmount    = 1.5 * baseBorrowMin   (comfortably above the minimum)
      //      collateralValue = borrowValue / BCF, with a 10% rounding buffer
      //    Prices are dropped onto their targets below, so the initial sizing only has to make the
      //    borrow valid — it is derived from the market's own factors, not from fixed amounts.
      const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const borrowAmount = (15n * baseBorrowMin) / 10n;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);

      for (let i = 0; i < collateralInfos.length; i++) {
        const collateralAssetInfo = collateralInfos[i];
        const collateralValue = ((borrowValue * factorScale) / collateralAssetInfo.borrowCollateralFactor * 110n) / 100n;
        const amount = (collateralValue * collateralAssetInfo.scale) / collateralPrices[i] + 1n;
        const asset = context.getAssetByAddress(collateralAssetInfo.asset);

        await context.sourceTokens(amount, asset, albert);
        await asset.approve(albert, comet.address);
        await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount });
      }

      // 2. Borrow, and keep the debt there: it starts above baseBorrowMin and stays there until absorb.
      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
      expect((await comet.borrowBalanceOf(albert.address)).toBigInt()).to.be.greaterThan(baseBorrowMin);

      const debtValue = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
      const collateralStatesBeforeDrop = await makeCollateralStates(comet, context, albert.address, collateralInfos);

      // 3. Drop collateral [0]'s price so that draining it leaves HALF the min debt still outstanding:
      //      remainingValue = minDebtValue / 2         (what the debt falls to once [0] is seized)
      //      valueAfterLF   = debtValue - remainingValue
      //      value          = valueAfterLF / LF        (its market value after the drop)
      //      droppedPrice   = value * scale / balance
      //    Its LF-weighted value therefore cannot cover the debt (it leaves a remainder), which is the
      //    ordinary full-seizure trigger, and the remainder lands below baseBorrowMin — the whole point.
      const remainingValue = minDebtValue / 2n;
      const firstValueAfterLF = debtValue - remainingValue;
      const firstValue = (firstValueAfterLF * factorScale) / collateralInfos[0].liquidationFactor;
      const firstDroppedPrice = (firstValue * collateralInfos[0].scale) / collateralStatesBeforeDrop[0].collateralBalance;
      // What collateral [0] still contributes to the liquidity keeping the account out of liquidation.
      const firstLiquidity = mulFactor(firstValue, collateralInfos[0].liquidateCollateralFactor);

      // 4. Drop collateral [1]'s price into the window where it closes the remaining (by now sub-min)
      //    debt while the account stays liquidatable. Both bounds are on its market value:
      //      lowerValue = remainingValue / LF                (an LF seizure exactly closes the rest)
      //      upperValue = (debtValue - firstLiquidity) / LCF (account stops being liquidatable)
      //      target     = midpoint, so both hold with margin
      //    LCF < LF is enforced by the Configurator, so lowerValue < upperValue on every market: the
      //    window is never empty, whatever the collateral's factors are.
      const lowerValue = (remainingValue * factorScale) / collateralInfos[1].liquidationFactor;
      const upperValue = ((debtValue - firstLiquidity) * factorScale) / collateralInfos[1].liquidateCollateralFactor;
      const secondValue = (lowerValue + upperValue) / 2n;
      const secondDroppedPrice = (secondValue * collateralInfos[1].scale) / collateralStatesBeforeDrop[1].collateralBalance;

      await context.changePriceFeeds({
        [collateralInfos[0].asset]: firstDroppedPrice,
        [collateralInfos[1].asset]: secondDroppedPrice,
      });

      // changePriceFeeds redeploys the liquidation module, so configure it only once the prices are set
      // — a module handle taken before the drop still reads the old feeds.
      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // 5. Capture state and run the sanity checks that define this case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStates = await makeCollateralStates(comet, context, albert.address, collateralInfos);

      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
      const firstValueAfterLFNow = mulFactor(mulPrice(collateralStates[0].collateralBalance, firstDroppedPrice, collateralInfos[0].scale), collateralInfos[0].liquidationFactor);
      const secondValueAfterLFNow = mulFactor(mulPrice(collateralStates[1].collateralBalance, secondDroppedPrice, collateralInfos[1].scale), collateralInfos[1].liquidationFactor);
      // What is left of the debt once collateral [0] has been drained.
      const debtValueAfterFirst = debtValueBefore - firstValueAfterLFNow;

      // The account is liquidatable, and unlike the sub-min cases its debt is still ABOVE the minimum
      // when absorb is called — so the loop starts outside the full-close branch.
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.greaterThan(baseBorrowMin);
      // Draining collateral [0] cannot close the debt, and what it leaves behind falls below the minimum:
      // that is what routes collateral [1] into the full-close formula.
      expect(debtValueAfterFirst).to.be.lessThan(minDebtValue);
      // Collateral [1] covers that remainder, so it is only partially seized and keeps a surplus.
      expect(secondValueAfterLFNow).to.be.greaterThan(debtValueAfterFirst);

      // 6. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 7. Independently derive the expected seizures.
      //    Iter 1 (collateral [0]): the wanted value exceeds what it holds, so it is drained; the debt
      //    drops by its LF-weighted value.
      //      seizeAmount    = collateralBalance
      //      seizedValue    = seizeAmount * price / scale                    (mulPrice)
      //      debtAfterFirst = debtValue - seizedValue * LF                   (mulFactor)
      const debtAtAbsorb = -(await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      const basePaidOutValue = mulPrice(debtAtAbsorb, basePrice, baseScale);
      collateralStates[0].seizeAmount = collateralStates[0].collateralBalance;
      collateralStates[0].seizedValue = mulPrice(collateralStates[0].seizeAmount, firstDroppedPrice, collateralInfos[0].scale);
      const debtAfterFirst = basePaidOutValue - mulFactor(collateralStates[0].seizedValue, collateralInfos[0].liquidationFactor);

      //    Iter 2 (collateral [1]): the debt is now sub-min, so the full-close formula runs and seizes
      //    only what the residual debt needs.
      //      seizeAmount = (debtAfterFirst / LF) / price                     (divPrice)
      //      seizedValue = seizeAmount * price / scale                       (mulPrice)
      collateralStates[1].seizeAmount = divPrice((debtAfterFirst * factorScale) / collateralInfos[1].liquidationFactor, secondDroppedPrice, collateralInfos[1].scale);
      collateralStates[1].seizedValue = mulPrice(collateralStates[1].seizeAmount, secondDroppedPrice, collateralInfos[1].scale);

      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

      // 8. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      const secondRemaining = collateralStates[1].collateralBalance - collateralStates[1].seizeAmount;
      const collateralRemaining = [0n, secondRemaining];
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].collateralBalance).to.equal(collateralRemaining[i]);
        expect(collateralStatesAfter[i].userCollateral.balance).to.equal(collateralRemaining[i]);
      }

      // Only the fully-seized collateral [0]'s bit is cleared, in whichever bitfield its index falls
      // (assetsIn for offsets 0-15, _reserved above that); the surviving collateral [1] keeps its bit.
      let expectedAssetsIn = cometStateBefore.user.assetsIn;
      let expectedReserved = cometStateBefore.user._reserved;
      if (collateralInfos[0].offset < 16) {
        expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[0].offset);
      } else {
        expectedReserved = expectedReserved & ~(1 << (collateralInfos[0].offset - 16));
      }
      expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
      expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting, per asset: supplied totals drop by that asset's own seized amount,
      // reserves rise by it, and the ERC20 balances are untouched on the absorb path.
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStates[i].totalsCollateral - collateralStates[i].seizeAmount);
        expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStates[i].collateralReserves + collateralStates[i].seizeAmount);
        expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStates[i].cometErc20Balance);
      }
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the debt paid out.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      // The position is healthy again.
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
    }
  );

  /**
   * Proves partial liquidation is not unconditional. The debt stays above `baseBorrowMin` the whole
   * way, so the outer loop computes a genuine partial seizure — but paying the debt down even to
   * `baseBorrowMin` (the largest reduction still legal) would leave the position short of the target
   * health factor. There is no valid partial stopping point, so the guard abandons the partial formula
   * and closes the debt in full through the same full-close path the sub-min cases use: only the
   * collateral the debt needs is seized, and the rest stays with the borrower.
   */
  scenario(
    `Comet#absorb > 1 collateral: formula gives partial seizure but guard fires because S * LF leaves debt below minDebt, closes debt fully [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 1)).length > 0,
    },
    async ({ comet, actors }, context, world) => {
      await context.freezeBorrowRates();

      const { albert, betty } = actors;

      // Use the first collateral usable for the liquidation math (all three factors positive).
      const [collateralIndex] = await getUsableCollateralIndices(context, 1);

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const originalPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();
      const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);

      // 1. Supply enough collateral to support a borrow above the minimum, then borrow it:
      //      borrowAmount    = 1.2 * baseBorrowMin
      //      collateralValue = borrowValue / BCF, with a 10% rounding buffer
      const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const borrowAmount = (12n * baseBorrowMin) / 10n;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
      const suppliedValue = ((borrowValue * factorScale) / collateralAssetInfo.borrowCollateralFactor * 110n) / 100n;
      const collateralAmount = (suppliedValue * collateralAssetInfo.scale) / originalPrice + 1n;

      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });

      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
      expect((await comet.borrowBalanceOf(albert.address)).toBigInt()).to.be.greaterThan(baseBorrowMin);

      // 2. Drop the collateral price into the window where the guard fires. Writing the debt as D, the
      //    min debt as m and the collateral's post-drop market value as v, the case needs:
      //      v > D / LF    the collateral covers the whole debt, so the full-close formula seizes only
      //                    part of it and a leftover remains (this also makes the outer loop's wanted
      //                    value smaller than v, i.e. a genuine partial seizure is what it computes)
      //      v < D / LCF   the account is liquidatable
      //      v <= (targetHF * LF * m + (D - m) * BCF) / (BCF * LF)
      //                    the guard bound: at any larger value, reducing the debt to m WOULD restore
      //                    target health, so a legal partial stopping point exists and the guard stays
      //                    quiet. It is derived from exactly that condition:
      //                      freedCollateral = (D - m) / LF          collateral value the reduction frees
      //                      healthAfter     = (v - freed) * BCF / m
      //                    and solving healthAfter < targetHF for v.
      //    The guard bound always exceeds D / LF (their difference is m * (targetHF*LF - BCF) / (BCF*LF),
      //    which is positive), so the window is never empty whatever the market's factors are.
      const debtValue = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
      const lowerValue = (debtValue * factorScale) / collateralAssetInfo.liquidationFactor;
      const liquidatableBound = (debtValue * factorScale) / collateralAssetInfo.liquidateCollateralFactor;
      const guardBound =
        ((mulFactor(minDebtValue, (TARGET_HF * collateralAssetInfo.liquidationFactor) / factorScale) + mulFactor(debtValue - minDebtValue, collateralAssetInfo.borrowCollateralFactor)) * factorScale)
        / ((collateralAssetInfo.borrowCollateralFactor * collateralAssetInfo.liquidationFactor) / factorScale);
      const upperValue = liquidatableBound < guardBound ? liquidatableBound : guardBound;
      const targetCollateralValue = (lowerValue + upperValue) / 2n;
      const droppedPrice = (targetCollateralValue * collateralAssetInfo.scale) / collateralAmount;
      await context.changePriceFeeds({ [collateralAssetInfo.asset]: droppedPrice });

      // changePriceFeeds redeploys the liquidation module, so configure it only once the price is set.
      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // 3. Capture state and run the sanity checks that define the guard case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralState] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
      const collateralValueBefore = mulPrice(collateralState.collateralBalance, droppedPrice, collateralAssetInfo.scale);

      // The account is liquidatable and, unlike the sub-min cases, its debt is still above the minimum —
      // so the loop enters the partial-seizure formula rather than the full-close one.
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.greaterThan(baseBorrowMin);

      // The guard fires: reducing the debt only to the minimum — the largest reduction still legal —
      // would leave the position short of the target health factor, so no valid partial stop exists.
      //   freedCollateralValue = (debt - minDebt) / LF        collateral freed by that reduction
      //   healthAfter          = (collateral - freed) * BCF / minDebt
      const freedCollateralValue = ((debtValueBefore - minDebtValue) * factorScale) / collateralAssetInfo.liquidationFactor;
      const collateralizedValueAfter = mulFactor(collateralValueBefore - freedCollateralValue, collateralAssetInfo.borrowCollateralFactor);
      const healthFactorAfter = (collateralizedValueAfter * factorScale) / minDebtValue;
      expect(healthFactorAfter).to.be.lessThan(TARGET_HF);

      // 4. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 5. Independently derive the expected seizure. The guard routes this collateral into the
      //    full-close formula, so the whole debt is closed and only the collateral it needs is seized:
      //      wantedValue = debtValue / LF                   (gross collateral value to seize)
      //      seizeAmount = wantedValue * scale / price      (divPrice)
      //      seizedValue = seizeAmount * price / scale      (mulPrice)
      const debtAtAbsorb = -(await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      const basePaidOutValue = mulPrice(debtAtAbsorb, basePrice, baseScale);
      collateralState.seizeAmount = divPrice((basePaidOutValue * factorScale) / collateralAssetInfo.liquidationFactor, droppedPrice, collateralAssetInfo.scale);
      collateralState.seizedValue = mulPrice(collateralState.seizeAmount, droppedPrice, collateralAssetInfo.scale);

      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);

      // 6. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // Only the collateral the debt needed is seized; the leftover stays with the borrower.
      const remainingCollateral = collateralState.collateralBalance - collateralState.seizeAmount;
      expect(collateralStateAfter.collateralBalance).to.equal(remainingCollateral);
      expect(collateralStateAfter.userCollateral.balance).to.equal(remainingCollateral);

      // Collateral remains, so the user's assetsIn bit and reserved bits are untouched.
      expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
      expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: supplied total drops by the seized amount but stays positive,
      // reserves rise by it, and the collateral + base ERC20 balances are untouched on the absorb path.
      const totalsCollateralAfter = collateralStateAfter.totalsCollateral;
      expect(totalsCollateralAfter).to.equal(collateralState.totalsCollateral - collateralState.seizeAmount);

      expect(collateralStateAfter.collateralReserves).to.equal(collateralState.collateralReserves + collateralState.seizeAmount);
      
      expect(collateralStateAfter.cometErc20Balance).to.equal(collateralState.cometErc20Balance);
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the debt paid out.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      // The position is healthy again.
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
    }
  );

  /**
   * Proves the min-debt guard applies MID-LOOP, not just to a single-collateral position. Collateral [0]
   * takes the ordinary outer-loop full seizure and the debt it leaves behind is still above
   * `baseBorrowMin`, so collateral [1] enters the target-health-factor formula and a genuine partial
   * seizure is computed for it — but paying that remaining debt down even to `baseBorrowMin` would still
   * leave the position short of target health. No valid partial stopping point exists, so the guard
   * fires on the SECOND collateral and closes the debt in full through the full-close formula.
   */
  scenario(
    `Comet#absorb > 2 collaterals: first fully seized then second formula gives partial seizure but guard fires because S * LF leaves debt at or under minDebt, closes debt fully [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 2)).length === 2,
    },
    async ({ comet, actors }, context, world) => {
      await context.freezeBorrowRates();

      const { albert, betty } = actors;

      // The first two collaterals usable for the liquidation math, in the order the absorb loop walks
      // them: [0] is drained, [1] is the one the guard fires on.
      const collateralIndexes = await getUsableCollateralIndices(context, 2);
      const collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
      const collateralPrices = await Promise.all(collateralInfos.map(async (collateralAssetInfo) => (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt()));

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      // 1. Supply both collaterals, each sized to carry the whole borrow on its own:
      //      borrowAmount    = 1.5 * baseBorrowMin   (comfortably above the minimum)
      //      collateralValue = borrowValue / BCF, with a 10% rounding buffer
      //    Prices are dropped onto their targets below, so the initial sizing only has to make the
      //    borrow valid — it is derived from the market's own factors, not from fixed amounts.
      const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const borrowAmount = (15n * baseBorrowMin) / 10n;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);

      for (let i = 0; i < collateralInfos.length; i++) {
        const collateralAssetInfo = collateralInfos[i];
        const collateralValue = ((borrowValue * factorScale) / collateralAssetInfo.borrowCollateralFactor * 110n) / 100n;
        const amount = (collateralValue * collateralAssetInfo.scale) / collateralPrices[i] + 1n;
        const asset = context.getAssetByAddress(collateralAssetInfo.asset);

        await context.sourceTokens(amount, asset, albert);
        await asset.approve(albert, comet.address);
        await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount });
      }

      // 2. Borrow, and keep the debt there: it starts above baseBorrowMin and stays there until absorb.
      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
      expect((await comet.borrowBalanceOf(albert.address)).toBigInt()).to.be.greaterThan(baseBorrowMin);

      const debtValue = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
      const collateralStatesBeforeDrop = await makeCollateralStates(comet, context, albert.address, collateralInfos);

      // 3. Drop collateral [0]'s price so that draining it leaves the debt at 1.2 * minDebt — still ABOVE
      //    the minimum, so collateral [1] is not routed into the full-close branch by the debt alone:
      //      remainingValue = 1.2 * minDebtValue      (what the debt falls to once [0] is seized)
      //      valueAfterLF   = debtValue - remainingValue
      //      value          = valueAfterLF / LF       (its market value after the drop)
      //      droppedPrice   = value * scale / balance
      const remainingValue = (12n * minDebtValue) / 10n;
      const firstValueAfterLF = debtValue - remainingValue;
      const firstValue = (firstValueAfterLF * factorScale) / collateralInfos[0].liquidationFactor;
      const firstDroppedPrice = (firstValue * collateralInfos[0].scale) / collateralStatesBeforeDrop[0].collateralBalance;
      // What collateral [0] still contributes to the liquidity keeping the account out of liquidation.
      const firstLiquidity = mulFactor(firstValue, collateralInfos[0].liquidateCollateralFactor);

      // 4. Drop collateral [1]'s price into the window where the guard fires on it. Writing the debt left
      //    after [0] is drained as R, the min debt as m and [1]'s post-drop market value as v:
      //      v > R / LF     it covers the remaining debt, so the full-close formula seizes only part of
      //                     it and a remainder is left (this also makes the outer loop's wanted value
      //                     smaller than v, i.e. a genuine partial seizure is what it computes for [1])
      //      v < (debtValue - firstLiquidity) / LCF     the account is liquidatable
      //      v <= (targetHF * LF * m + (R - m) * BCF) / (BCF * LF)
      //                     the guard bound: at any larger value, reducing the remaining debt to m WOULD
      //                     restore target health, so a legal partial stop would exist and the guard
      //                     would stay quiet. It comes from exactly that condition:
      //                       freedCollateral = (R - m) / LF        collateral the reduction frees
      //                       healthAfter     = (v - freed) * BCF / m
      //                     solved for healthAfter < targetHF.
      //    That same bound is what keeps [0]'s full seizure identical in both modes: it implies
      //    v * BCF < targetHF * R, which is exactly the condition for the outer loop to drain [0]
      //    outright rather than nibble at it.
      //    The guard bound always exceeds R / LF (by m * (targetHF*LF - BCF) / (BCF*LF) > 0), so the
      //    window is never empty whatever factors the market's collateral happens to have.
      const lowerValue = (remainingValue * factorScale) / collateralInfos[1].liquidationFactor;
      const liquidatableBound = ((debtValue - firstLiquidity) * factorScale) / collateralInfos[1].liquidateCollateralFactor;
      const guardBound =
        ((mulFactor(minDebtValue, (TARGET_HF * collateralInfos[1].liquidationFactor) / factorScale) + mulFactor(remainingValue - minDebtValue, collateralInfos[1].borrowCollateralFactor)) * factorScale)
        / ((collateralInfos[1].borrowCollateralFactor * collateralInfos[1].liquidationFactor) / factorScale);
      const upperValue = liquidatableBound < guardBound ? liquidatableBound : guardBound;
      const secondValue = (lowerValue + upperValue) / 2n;
      const secondDroppedPrice = (secondValue * collateralInfos[1].scale) / collateralStatesBeforeDrop[1].collateralBalance;

      await context.changePriceFeeds({
        [collateralInfos[0].asset]: firstDroppedPrice,
        [collateralInfos[1].asset]: secondDroppedPrice,
      });

      // changePriceFeeds redeploys the liquidation module, so configure it only once the prices are set.
      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // 5. Capture state and run the sanity checks that define this case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStates = await makeCollateralStates(comet, context, albert.address, collateralInfos);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
      const firstValueAfterLFNow = mulFactor(mulPrice(collateralStates[0].collateralBalance, firstDroppedPrice, collateralInfos[0].scale), collateralInfos[0].liquidationFactor);
      const secondCollateralValue = mulPrice(collateralStates[1].collateralBalance, secondDroppedPrice, collateralInfos[1].scale);
      // What is left of the debt once collateral [0] has been drained.
      const debtValueAfterFirst = debtValueBefore - firstValueAfterLFNow;

      // The account is liquidatable and its debt is above the minimum, so the loop starts outside the
      // full-close branch.
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.greaterThan(baseBorrowMin);
      // Draining collateral [0] cannot close the debt, and what it leaves behind is STILL above the
      // minimum — so collateral [1] enters the partial-seizure formula rather than the full-close one.
      expect(debtValueAfterFirst).to.be.greaterThan(minDebtValue);

      // The guard fires on collateral [1]: reducing the remaining debt only to the minimum — the largest
      // reduction still legal — would leave the position short of the target health factor, so no valid
      // partial stop exists and the debt is closed in full instead.
      //   freedCollateralValue = (remainingDebt - minDebt) / LF   collateral freed by that reduction
      //   healthAfter          = (collateral - freed) * BCF / minDebt
      const freedCollateralValue = ((debtValueAfterFirst - minDebtValue) * factorScale) / collateralInfos[1].liquidationFactor;
      const collateralizedValueAfter = mulFactor(secondCollateralValue - freedCollateralValue, collateralInfos[1].borrowCollateralFactor);
      const healthFactorAfter = (collateralizedValueAfter * factorScale) / minDebtValue;
      expect(healthFactorAfter).to.be.lessThan(TARGET_HF);

      // 6. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 7. Independently derive the expected seizures.
      //    Iter 1 (collateral [0]): the wanted value exceeds what it holds, so it is drained; the debt
      //    drops by its LF-weighted value.
      //      seizeAmount    = collateralBalance
      //      seizedValue    = seizeAmount * price / scale                    (mulPrice)
      //      debtAfterFirst = debtValue - seizedValue * LF                   (mulFactor)
      const debtAtAbsorb = -(await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      const basePaidOutValue = mulPrice(debtAtAbsorb, basePrice, baseScale);
      collateralStates[0].seizeAmount = collateralStates[0].collateralBalance;
      collateralStates[0].seizedValue = mulPrice(collateralStates[0].seizeAmount, firstDroppedPrice, collateralInfos[0].scale);
      const debtAfterFirst = basePaidOutValue - mulFactor(collateralStates[0].seizedValue, collateralInfos[0].liquidationFactor);

      //    Iter 2 (collateral [1]): the guard routes it into the full-close formula, so the whole
      //    remaining debt is closed and only the collateral it needs is seized.
      //      seizeAmount = (debtAfterFirst / LF) / price                     (divPrice)
      //      seizedValue = seizeAmount * price / scale                       (mulPrice)
      collateralStates[1].seizeAmount = divPrice((debtAfterFirst * factorScale) / collateralInfos[1].liquidationFactor, secondDroppedPrice, collateralInfos[1].scale);
      collateralStates[1].seizedValue = mulPrice(collateralStates[1].seizeAmount, secondDroppedPrice, collateralInfos[1].scale);

      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

      // 8. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      const secondRemaining = collateralStates[1].collateralBalance - collateralStates[1].seizeAmount;
      const collateralRemaining = [0n, secondRemaining];
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].collateralBalance).to.equal(collateralRemaining[i]);
        expect(collateralStatesAfter[i].userCollateral.balance).to.equal(collateralRemaining[i]);
      }

      // Only the fully-seized collateral [0]'s bit is cleared, in whichever bitfield its index falls
      // (assetsIn for offsets 0-15, _reserved above that); the surviving collateral [1] keeps its bit.
      let expectedAssetsIn = cometStateBefore.user.assetsIn;
      let expectedReserved = cometStateBefore.user._reserved;
      if (collateralInfos[0].offset < 16) {
        expectedAssetsIn = expectedAssetsIn & ~(1 << collateralInfos[0].offset);
      } else {
        expectedReserved = expectedReserved & ~(1 << (collateralInfos[0].offset - 16));
      }
      expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
      expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting, per asset: supplied totals drop by that asset's own seized amount,
      // reserves rise by it, and the ERC20 balances are untouched on the absorb path.
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].totalsCollateral).to.equal(collateralStates[i].totalsCollateral - collateralStates[i].seizeAmount);
        expect(collateralStatesAfter[i].collateralReserves).to.equal(collateralStates[i].collateralReserves + collateralStates[i].seizeAmount);
        expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStates[i].cometErc20Balance);
      }
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the debt paid out.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      // The position is healthy again.
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
    }
  );

  /**
   * Proves the exact boundary is treated like being below it. The debt lands precisely on
   * `baseBorrowMin` — the branch is chosen with `debtRemainingValue <= minDebtValue`, so equality still
   * routes into the full-close formula rather than a target-HF partial one: the debt is already at the
   * legal floor with nowhere lower to go. The collateral covers it, so only the collateral the debt
   * needs is seized and the surplus stays with the borrower.
   */
  scenario(
    `Comet#absorb > debt exactly equal to the min debt, and the collateral still covers it - partial seizure [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 1)).length > 0,
    },
    async ({ comet, actors }, context, world) => {
      await context.freezeBorrowRates();

      const { albert, betty } = actors;

      // Use the first collateral usable for the liquidation math (all three factors positive).
      const [collateralIndex] = await getUsableCollateralIndices(context, 1);

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const originalPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();
      const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);

      // 1. Supply enough collateral to support the minimum borrow, then borrow EXACTLY that minimum —
      //    no repay step: the debt is put on the boundary directly.
      //      borrowAmount    = baseBorrowMin
      //      collateralValue = borrowValue / BCF, with a 10% rounding buffer
      const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const suppliedValue = ((minDebtValue * factorScale) / collateralAssetInfo.borrowCollateralFactor * 110n) / 100n;
      const collateralAmount = (suppliedValue * collateralAssetInfo.scale) / originalPrice + 1n;

      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });

      await context.sourceTokens(2n * baseBorrowMin, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: baseBorrowMin });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
      expect(await comet.borrowBalanceOf(albert.address)).to.equal(baseBorrowMin);

      // 2. Drop the collateral price into the partial-seizure window. The position must become
      //    liquidatable (debt > value·LCF) while the collateral's liquidation value still covers the
      //    debt (value·LF > debt) — since the protocol enforces LCF < LF, that band always exists.
      //    Pick its midpoint so both inequalities hold with margin:
      //      lowerValue = minDebtValue / LF   (an LF seizure exactly covers the debt)
      //      upperValue = minDebtValue / LCF  (position stops being liquidatable)
      //      target     = (lowerValue + upperValue) / 2
      const lowerValue = (minDebtValue * factorScale) / collateralAssetInfo.liquidationFactor;
      const upperValue = (minDebtValue * factorScale) / collateralAssetInfo.liquidateCollateralFactor;
      const targetCollateralValue = (lowerValue + upperValue) / 2n;
      const droppedPrice = (targetCollateralValue * collateralAssetInfo.scale) / collateralAmount;
      await context.changePriceFeeds({ [collateralAssetInfo.asset]: droppedPrice });

      // changePriceFeeds redeploys the liquidation module, so configure it only once the price is set.
      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // 3. Capture state and run the sanity checks that define the boundary case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralState] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
      const collateralValueAfterLF = mulFactor(mulPrice(collateralState.collateralBalance, droppedPrice, collateralAssetInfo.scale), collateralAssetInfo.liquidationFactor);

      // The account is liquidatable, the debt sits exactly ON the minimum (not below it, as in the
      // sub-min cases), and the collateral's LF-weighted value still exceeds it — so the seizure is
      // partial and leaves a surplus.
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.equal(baseBorrowMin);
      expect(debtValueBefore).to.equal(minDebtValue);
      expect(collateralValueAfterLF).to.be.greaterThan(minDebtValue);

      // 4. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 5. Independently derive the expected seizure. Equality routes into the full-close formula, so
      //    the whole debt is closed and only the collateral it needs is seized:
      //      wantedValue = debtValue / LF                   (gross collateral value to seize)
      //      seizeAmount = wantedValue * scale / price      (divPrice)
      //      seizedValue = seizeAmount * price / scale      (mulPrice)
      const debtAtAbsorb = -(await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      const basePaidOutValue = mulPrice(debtAtAbsorb, basePrice, baseScale);
      collateralState.seizeAmount = divPrice((basePaidOutValue * factorScale) / collateralAssetInfo.liquidationFactor, droppedPrice, collateralAssetInfo.scale);
      collateralState.seizedValue = mulPrice(collateralState.seizeAmount, droppedPrice, collateralAssetInfo.scale);

      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);

      // 6. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // Only the collateral the debt needed is seized; the surplus stays with the borrower.
      const remainingCollateral = collateralState.collateralBalance - collateralState.seizeAmount;
      expect(collateralStateAfter.collateralBalance).to.equal(remainingCollateral);
      expect(collateralStateAfter.userCollateral.balance).to.equal(remainingCollateral);

      // Collateral remains, so the user's assetsIn bit and reserved bits are untouched.
      expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
      expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: supplied total drops by the seized amount but stays positive,
      // reserves rise by it, and the collateral + base ERC20 balances are untouched on the absorb path.
      const totalsCollateralAfter = collateralStateAfter.totalsCollateral;
      expect(totalsCollateralAfter).to.equal(collateralState.totalsCollateral - collateralState.seizeAmount);
      expect(collateralStateAfter.collateralReserves).to.equal(collateralState.collateralReserves + collateralState.seizeAmount);
      expect(collateralStateAfter.cometErc20Balance).to.equal(collateralState.cometErc20Balance);
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the debt paid out.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      // The position is healthy again.
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
    }
  );

  /**
   * Proves the bad-debt write-off reaches the min-debt boundary too. The debt lands exactly on
   * `baseBorrowMin`, so the full-close formula runs — but this time the collateral's LF-weighted value
   * is BELOW the debt, so seizing every last unit of it still cannot cover even this smallest legal
   * debt. The debt is closed to zero regardless and the shortfall comes out of reserves: the smallest
   * position the protocol allows can still go bad if the collateral behind it is thin enough.
   */
  scenario(
    `Comet#absorb > debt exactly equal to the min debt, and the collateral cannot cover it - full seizure, shortfall written off [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 1)).length > 0,
    },
    async ({ comet, actors }, context, world) => {
      await context.freezeBorrowRates();

      const { albert, betty } = actors;

      // Use the first collateral usable for the liquidation math (all three factors positive).
      const [collateralIndex] = await getUsableCollateralIndices(context, 1);

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const originalPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();
      const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);

      // 1. Supply enough collateral to support the minimum borrow, then borrow EXACTLY that minimum.
      //      borrowAmount    = baseBorrowMin
      //      collateralValue = minDebtValue / BCF, with a 10% rounding buffer
      const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const borrowAmount = baseBorrowMin;
      const suppliedValue = ((minDebtValue * factorScale) / collateralAssetInfo.borrowCollateralFactor * 110n) / 100n;
      const collateralAmount = (suppliedValue * collateralAssetInfo.scale) / originalPrice + 1n;

      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });

      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
      expect((await comet.borrowBalanceOf(albert.address)).toBigInt()).to.equal(baseBorrowMin);

      // 2. Drop the collateral price far enough that its LF-weighted value falls BELOW the debt — full
      //    seizure then cannot cover even this minimum-sized debt, which is what makes it bad debt:
      //      targetValueAfterLF = 0.8 * minDebtValue   (20% short of the debt)
      //      targetValue        = targetValueAfterLF / LF   (its market value after the drop)
      //      droppedPrice       = targetValue * scale / amount
      //    The account is liquidatable for free here: LCF < LF, so an LF-weighted value under the debt
      //    puts the LCF-weighted value under it as well.
      const targetValueAfterLF = (80n * minDebtValue) / 100n;
      const targetCollateralValue = (targetValueAfterLF * factorScale) / collateralAssetInfo.liquidationFactor;
      const droppedPrice = (targetCollateralValue * collateralAssetInfo.scale) / collateralAmount;
      await context.changePriceFeeds({ [collateralAssetInfo.asset]: droppedPrice });

      // changePriceFeeds redeploys the liquidation module, so configure it only once the price is set.
      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // 3. Capture state and run the sanity checks that define the boundary bad-debt case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralState] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
      const collateralValueAfterLF = mulFactor(mulPrice(collateralState.collateralBalance, droppedPrice, collateralAssetInfo.scale), collateralAssetInfo.liquidationFactor);

      // The account is liquidatable and the debt sits exactly ON the minimum, so the full-close formula
      // runs — but the collateral's LF-weighted value is below the debt, so seizing all of it still
      // falls short and the residual is written off.
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.equal(baseBorrowMin);
      expect(debtValueBefore).to.equal(minDebtValue);
      expect(collateralValueAfterLF).to.be.lessThan(minDebtValue);

      // 4. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 5. The collateral cannot cover the debt, so every unit of it is seized at market value.
      collateralState.seizeAmount = collateralState.collateralBalance;
      collateralState.seizedValue = mulPrice(collateralState.seizeAmount, droppedPrice, collateralAssetInfo.scale);

      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);

      // 6. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // All of the collateral is seized.
      expect(collateralStateAfter.collateralBalance).to.equal(0);
      expect(collateralStateAfter.userCollateral.balance).to.equal(0);

      // The fully-seized collateral's bit is cleared, in whichever bitfield its index falls (assetsIn
      // for offsets 0-15, _reserved above that); nothing else in either field moves.
      let expectedAssetsIn = cometStateBefore.user.assetsIn;
      let expectedReserved = cometStateBefore.user._reserved;
      if (collateralAssetInfo.offset < 16) {
        expectedAssetsIn = expectedAssetsIn & ~(1 << collateralAssetInfo.offset);
      } else {
        expectedReserved = expectedReserved & ~(1 << (collateralAssetInfo.offset - 16));
      }
      expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
      expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: supplied total drops by the full seized amount, reserves rise by it,
      // and the collateral + base ERC20 balances are untouched on the absorb path.
      expect(collateralStateAfter.totalsCollateral).to.equal(collateralState.totalsCollateral - collateralState.seizeAmount);
      expect(collateralStateAfter.collateralReserves).to.equal(collateralState.collateralReserves + collateralState.seizeAmount);
      expect(collateralStateAfter.cometErc20Balance).to.equal(collateralState.cometErc20Balance);
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the FULL debt — the bad-debt write-off, not capped by what the collateral
      // actually covered, and here it happens at the exact min-debt boundary.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      // The position is healthy again: nothing is owed and nothing is left to seize.
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
    }
  );
}

/*//////////////////////////////////////////////////////////////
                        REGISTER SCENARIOS
//////////////////////////////////////////////////////////////*/

absorbScenarios('absorb', true);
absorbScenarios('liquidate', true);
absorbScenarios('absorb', false);
