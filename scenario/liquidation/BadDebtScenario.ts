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
} from '../utils';
import { mulPrice, mulFactor, factorScale } from '../../test/helpers';

/**
 * Bad-debt absorb scenarios for the liquidation module — the mirror of
 * `test/liquidation-logic/bad-debt.test.ts`, run against forked deployments.
 *
 * Every case runs across the two entry points (Comet.absorb vs LiquidationModule.liquidate) and the
 * two liquidation modes (default/partial vs full-close). The end state is identical in all of them:
 * the collateral's liquidation-factor-weighted value sits below the debt, so full seizure cannot
 * cover it — the whole debt is still closed to zero and the shortfall is written off from reserves.
 */
function absorbScenarios(entry: Entry, partial: boolean) {
  const mode = partial ? 'default' : 'full-close';
  const tag = `entry=${entry}, mode=${mode}`;

  /**
   * 1 collateral: full seizure, the user does not have enough collateral to cover the debt.
   *
   * Proves the core bad-debt path: one collateral whose value after the liquidation factor is below
   * the debt. Full seizure isn't enough, but the debt is still closed to zero and the shortfall comes
   * out of reserves.
   */
  scenario(
    `Comet#absorb > bad debt: 1 collateral fully seized, shortfall written off [${tag}]`,
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
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      // Freeze interest so the price drop is the only source of bad debt and all state assertions remain exact.
      await context.zeroBorrowRates();

      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const collateralPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();

      // 1. Supply collateral worth 4× the minimum debt value and borrow 2× the minimum debt. Deriving
      //    both sides from baseBorrowMin keeps the setup proportional across deployments regardless of
      //    the base asset's price or decimals.
      //      minDebtValue   = baseBorrowMin * basePrice / baseScale
      //      collateralValue = 4 * minDebtValue
      //      collateralAmount = collateralValue * collateralScale / collateralPrice, rounded up
      const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const collateralValue = 4n * minDebtValue;
      const collateralAmount = (collateralValue * collateralAssetInfo.scale + collateralPrice - 1n)
        / collateralPrice;
      const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);
      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });

      const borrowAmount = 2n * baseBorrowMin;
      await context.sourceTokens(2n * borrowAmount, context.getAssetByAddress(baseToken), comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 2. Drop the collateral price until its LF-weighted value is 90% of the debt. Full seizure then
      //    leaves a 10% shortfall, which the protocol must write off as bad debt:
      //      targetValueAfterLF = debtValue * 0.90
      //      targetValue        = targetValueAfterLF / LF
      //      droppedPrice       = targetValue * collateralScale / collateralAmount
      const debtValue = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
      const targetValueAfterLF = (debtValue * 90n) / 100n;
      const targetCollateralValue = (targetValueAfterLF * factorScale) / collateralAssetInfo.liquidationFactor;
      const droppedPrice = (targetCollateralValue * collateralAssetInfo.scale) / collateralAmount;
      await context.changePriceFeeds({ [collateralAssetInfo.asset]: droppedPrice });

      // changePriceFeeds redeploys the liquidation module, so configure it only once the price is set.
      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // 3. Capture state and run the sanity checks that define the bad-debt case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralState] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);

      // User is liquidatable and the debt still exceeds the minimum.
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.greaterThan(baseBorrowMin);
      // Collateral value after the liquidation factor is below the debt — this is what makes it bad debt.
      const collateralValueAfterLFNow = mulFactor(
        mulPrice(collateralState.collateralBalance, droppedPrice, collateralAssetInfo.scale),
        collateralAssetInfo.liquidationFactor
      );
      expect(collateralValueAfterLFNow).to.be.lessThan(debtValueBefore);

      // 4. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      const seizedAmount = collateralState.collateralBalance;
      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);

      // 6. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // All of the collateral is seized; its assetsIn bit is cleared and the reserved bits are untouched.
      expect(collateralStateAfter.collateralBalance).to.equal(0);
      expect(collateralStateAfter.userCollateral.balance).to.equal(0);
      expect(cometStateAfter.user.assetsIn).to.equal(0);
      expect(cometStateAfter.user._reserved).to.equal(0);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: supplied total drops by the full seized amount, reserves rise by it,
      // and the collateral + base ERC20 balances are untouched on the absorb path.
      expect(collateralStateAfter.totalsCollateral).to.equal(collateralState.totalsCollateral - seizedAmount);
      expect(collateralStateAfter.collateralReserves).to.equal(collateralState.collateralReserves + seizedAmount);
      expect(collateralStateAfter.cometErc20Balance).to.equal(collateralState.cometErc20Balance);
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the FULL debt — the bad-debt write-off, not capped by what the collateral
      // covered. Borrow rates are zero, so this is exact against the captured pre-absorb balance.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
    }
  );

  /**
   * 2 collaterals: full seizure of the first asset, then full seizure of the second.
   *
   * Proves the bad-debt branch keeps walking the seizure loop after the first full seizure and also
   * drains the second collateral when both liquidation-factor-weighted values still fall short of
   * the absorbed debt.
   */
  scenario(
    `Comet#absorb > bad debt: 2 collaterals fully seized, shortfall written off [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 2)).length === 2,
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

      const collateralIndexes = await getUsableCollateralIndices(context, 2);
      const collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
      const collateralPrices = await Promise.all(collateralInfos.map(async (collateralAssetInfo) => (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt()));

      const baseToken = await comet.baseToken();
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      // Freeze interest so the price drop is the only source of bad debt and all state assertions remain exact.
      await context.zeroBorrowRates();
      const borrowAmount = 2n * baseBorrowMin;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);

      // 1. Supply two collaterals sized from their own live borrow factors. Each contributes roughly
      //    the same borrow capacity, so the initial borrow is valid while both assets matter to the loop:
      //      perAssetBorrowCapacity = borrowValue
      //      collateralValue        = perAssetBorrowCapacity / BCF
      for (let i = 0; i < collateralInfos.length; i++) {
        const collateralAssetInfo = collateralInfos[i];
        const collateralValue = (borrowValue * factorScale) / collateralAssetInfo.borrowCollateralFactor;
        const amount = (collateralValue * collateralAssetInfo.scale) / collateralPrices[i];
        const asset = context.getAssetByAddress(collateralAssetInfo.asset);

        await context.sourceTokens(amount, asset, albert);
        await asset.approve(albert, comet.address);
        await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount });
      }

      await context.sourceTokens(2n * borrowAmount, context.getAssetByAddress(baseToken), comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 2. Scale both collateral prices down until their combined LF-weighted value is 90% of the debt.
      //    The common ratio preserves their relative values, while ensuring neither collateral nor the
      //    full basket can cover the debt:
      //      targetTotalAfterLF = debtValue * 0.90
      //      droppedPrice_i     = price_i * targetTotalAfterLF / totalCollateralAfterLF
      let totalCollateralAfterLF = 0n;
      const collateralStatesBeforeDrop = await makeCollateralStates(comet, context, albert.address, collateralInfos);
      for (let i = 0; i < collateralInfos.length; i++) {
        totalCollateralAfterLF += mulFactor(
          mulPrice(collateralStatesBeforeDrop[i].collateralBalance, collateralPrices[i], collateralInfos[i].scale),
          collateralInfos[i].liquidationFactor
        );
      }
      const debtValue = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
      const targetTotalAfterLF = (debtValue * 90n) / 100n;
      const droppedPrices = collateralPrices.map((price) => (price * targetTotalAfterLF) / totalCollateralAfterLF);
      const newPrices: Record<string, bigint> = {};
      for (let i = 0; i < collateralInfos.length; i++) {
        newPrices[collateralInfos[i].asset] = droppedPrices[i];
      }
      await context.changePriceFeeds(newPrices);

      // changePriceFeeds redeploys the liquidation module, so configure it only once the prices are set.
      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // 3. Capture state and run the sanity checks that define the multi-collateral bad-debt case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);

      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.greaterThan(baseBorrowMin);

      let totalCollateralValueAfterLFNow = 0n;
      for (let i = 0; i < collateralInfos.length; i++) {
        totalCollateralValueAfterLFNow += mulFactor(
          mulPrice(collateralStatesBefore[i].collateralBalance, droppedPrices[i], collateralInfos[i].scale),
          collateralInfos[i].liquidationFactor
        );
      }
      expect(totalCollateralValueAfterLFNow).to.be.lessThan(debtValueBefore);

      // 4. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 5. Independently derive the expected event values. Full bad-debt seizure means every supplied
      //    collateral amount is seized at market value, and the full debt is written off.
      for (const collateral of collateralStatesBefore) {
        collateral.seizeAmount = collateral.collateralBalance;
      }

      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

      // 6. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      let expectedAssetsIn = cometStateBefore.user.assetsIn;
      let expectedReserved = cometStateBefore.user._reserved;
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].collateralBalance).to.equal(0);
      }
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].userCollateral.balance).to.equal(0);
      }
      for (const collateralAssetInfo of collateralInfos) {
        if (collateralAssetInfo.offset < 16) {
          expectedAssetsIn = expectedAssetsIn & ~(1 << collateralAssetInfo.offset);
        } else {
          expectedReserved = expectedReserved & ~(1 << (collateralAssetInfo.offset - 16));
        }
      }

      expect(cometStateAfter.user.assetsIn).to.equal(expectedAssetsIn);
      expect(cometStateAfter.user._reserved).to.equal(expectedReserved);

      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].totalsCollateral)
          .to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      }
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].collateralReserves)
          .to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      }
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
      }

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Base ERC20 balance is untouched, while base reserves absorb the full bad-debt write-off.
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
    }
  );

  /**
   * All collaterals: full seizure of every usable market collateral.
   *
   * Proves the bad-debt write-off scales across the whole collateral basket: the loop drains every
   * asset, the full debt is closed, and base reserves absorb the basket-wide shortfall.
   */
  scenario(
    `Comet#absorb > bad debt: all usable collaterals fully seized, shortfall written off [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx)).length > 2, // if collaterals amount < 3, then we end up, as for 2 or 1 collaterals we already have the test cases
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

      const collateralIndexes = await getUsableCollateralIndices(context);
      const collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
      const collateralPrices = await Promise.all(collateralInfos.map(async (collateralAssetInfo) => (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt()));
      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      // Freeze interest so the price drop is the only source of bad debt and all state assertions remain exact.
      await context.zeroBorrowRates();

      // 1. Supply the full usable collateral basket with equal USD value per asset. The basket is
      //    sized from the intended borrow limit, then split evenly across every usable collateral:
      //      targetBorrowValue      = 200 * baseBorrowMin, in price scale
      //      targetBorrowLimitValue = targetBorrowValue / 0.99
      //      collateralValue_i      = targetBorrowLimitValue / numCollaterals
      const targetBorrowAmount = 200n * baseBorrowMin;
      const targetBorrowValue = mulPrice(targetBorrowAmount, basePrice, baseScale);
      const targetBorrowLimitValue = (targetBorrowValue * 100n) / 99n;
      const collateralValue = targetBorrowLimitValue / BigInt(collateralInfos.length);

      for (let i = 0; i < collateralInfos.length; i++) {
        const collateralAssetInfo = collateralInfos[i];
        const collateralAmount = (collateralValue * collateralAssetInfo.scale) / collateralPrices[i] + 1n;
        const asset = context.getAssetByAddress(collateralAssetInfo.asset);

        await context.sourceTokens(collateralAmount, asset, albert);
        await asset.approve(albert, comet.address);
        await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });
      }

      const collateralStatesBeforeBorrow = await makeCollateralStates(comet, context, albert.address, collateralInfos);
      let borrowLimitValue = 0n;
      for (let i = 0; i < collateralInfos.length; i++) {
        borrowLimitValue += mulFactor(
          mulPrice(collateralStatesBeforeBorrow[i].collateralBalance, collateralPrices[i], collateralInfos[i].scale),
          collateralInfos[i].borrowCollateralFactor
        );
      }

      // 2. Fund Comet directly with base liquidity, then borrow just under the full initial limit.
      //    Utilization no longer matters because bad debt is created by a price drop, not by interest.
      const borrowAmount = ((borrowLimitValue * 99n) / 100n) * baseScale / basePrice;
      await context.sourceTokens(4n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 3. Scale every collateral price down until the basket's combined LF-weighted value is 90% of
      //    the debt. Applying one common ratio preserves the basket composition while guaranteeing a
      //    10% aggregate shortfall after every usable collateral is seized:
      //      targetTotalAfterLF = debtValue * 0.90
      //      droppedPrice_i     = price_i * targetTotalAfterLF / totalCollateralAfterLF
      let totalCollateralAfterLF = 0n;
      for (let i = 0; i < collateralInfos.length; i++) {
        totalCollateralAfterLF += mulFactor(
          mulPrice(collateralStatesBeforeBorrow[i].collateralBalance, collateralPrices[i], collateralInfos[i].scale),
          collateralInfos[i].liquidationFactor
        );
      }
      const debtValue = mulPrice((await comet.borrowBalanceOf(albert.address)).toBigInt(), basePrice, baseScale);
      const targetTotalAfterLF = (debtValue * 90n) / 100n;
      const droppedPrices = collateralPrices.map((price) => (price * targetTotalAfterLF) / totalCollateralAfterLF);
      const newPrices: Record<string, bigint> = {};
      for (let i = 0; i < collateralInfos.length; i++) {
        newPrices[collateralInfos[i].asset] = droppedPrices[i];
      }
      await context.changePriceFeeds(newPrices);

      // changePriceFeeds redeploys the liquidation module, so configure it only once the prices are set.
      const module = await configureModule(context, world, entry, partial, betty.address);
      await comet.accrueAccount(albert.address);

      // 4. Capture state and run the sanity checks that define the full-basket bad-debt case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesBefore = await makeCollateralStates(comet, context, albert.address, collateralInfos);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);

      // Sanity checks
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.greaterThan(baseBorrowMin);
      let totalCollateralValueAfterLFNow = 0n;
      for (let i = 0; i < collateralInfos.length; i++) {
        totalCollateralValueAfterLFNow += mulFactor(
          mulPrice(collateralStatesBefore[i].collateralBalance, droppedPrices[i], collateralInfos[i].scale),
          collateralInfos[i].liquidationFactor
        );
      }
      expect(totalCollateralValueAfterLFNow).to.be.lessThan(debtValueBefore);

      // 5. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 6. Full bad-debt seizure: every supplied collateral amount is seized at market value, and the
      //    full debt is written off.
      for (let i = 0; i < collateralInfos.length; i++) {
        collateralStatesBefore[i].seizeAmount = collateralStatesBefore[i].collateralBalance;
        collateralStatesBefore[i].seizedValue = mulPrice(
          collateralStatesBefore[i].seizeAmount,
          droppedPrices[i],
          collateralInfos[i].scale
        );
      }

      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStatesAfter = await makeCollateralStates(comet, context, albert.address, collateralInfos);

      // 7. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].collateralBalance).to.equal(0);
      }
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].userCollateral.balance).to.equal(0);
      }
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].totalsCollateral)
          .to.equal(collateralStatesBefore[i].totalsCollateral - collateralStatesBefore[i].seizeAmount);
      }
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].collateralReserves)
          .to.equal(collateralStatesBefore[i].collateralReserves + collateralStatesBefore[i].seizeAmount);
      }
      for (let i = 0; i < collateralInfos.length; i++) {
        expect(collateralStatesAfter[i].cometErc20Balance).to.equal(collateralStatesBefore[i].cometErc20Balance);
      }

      expect(cometStateAfter.user.assetsIn).to.equal(0);
      expect(cometStateAfter.user._reserved).to.equal(0);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Base ERC20 balance is untouched, while base reserves absorb the full basket-wide write-off.
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
    }
  );

  /**
   * 1 collateral: debt below the normal borrow minimum, collateral still cannot cover it.
   *
   * Proves `baseBorrowMin` does not gate absorb: once the account is liquidatable and undercollateralized,
   * even a sub-minimum bad debt is fully closed and written off from reserves.
   */
  scenario(
    `Comet#absorb > bad debt: debt below the min debt, collateral still cannot cover it, shortfall written off [${tag}]`,
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

      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const originalPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();
      const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);

      // 1. Supply enough collateral to support a borrow above the normal minimum:
      //      borrowAmount     = 1.2 * baseBorrowMin
      //      collateralValue  = borrowValue / BCF, with a 10% rounding buffer
      const borrowAmount = (12n * baseBorrowMin) / 10n;
      const repayAmount = (4n * baseBorrowMin) / 10n;
      const remainingDebt = borrowAmount - repayAmount;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
      const collateralValue = ((borrowValue * factorScale) / collateralAssetInfo.borrowCollateralFactor * 110n) / 100n;
      const collateralAmount = (collateralValue * collateralAssetInfo.scale) / originalPrice + 1n;
    
      // Supply collateral
      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });

      // Borrow
      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      // Sanity checks
      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 2. Repay part of the borrow so the remaining debt sits below baseBorrowMin.
      await baseAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: baseToken, amount: repayAmount });
      expect(await comet.borrowBalanceOf(albert.address)).to.be.lessThan(baseBorrowMin);

      // 3. Drop the collateral price so the LF-weighted value is below the small remaining debt:
      //      targetCollateralValueAfterLF = remainingDebtValue * 0.80
      //      droppedPrice = targetCollateralValueAfterLF / LF * scale / collateralAmount
      const remainingDebtValue = mulPrice(remainingDebt, basePrice, baseScale);
      const targetCollateralValue = ((remainingDebtValue * 80n) / 100n * factorScale) / collateralAssetInfo.liquidationFactor;
      const droppedPrice = (targetCollateralValue * collateralAssetInfo.scale) / collateralAmount;
      await context.changePriceFeeds({ [collateralAssetInfo.asset]: droppedPrice });
      const module = await configureModule(context, world, entry, partial, betty.address);

      await comet.accrueAccount(albert.address);

      // 4. Capture state and run the sanity checks that define the sub-min bad-debt case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralState] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);

      // Sanity checks before absorb
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.lessThan(baseBorrowMin);

      const collateralValueAfterLF = mulFactor(
        mulPrice(collateralState.collateralBalance, droppedPrice, collateralAssetInfo.scale),
        collateralAssetInfo.liquidationFactor
      );

      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
      expect(collateralValueAfterLF).to.be.lessThan(debtValueBefore);

      // 5. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 6. Full bad-debt seizure: the whole collateral amount is seized at market value, and the full
      //    small debt is written off despite being below baseBorrowMin.
      const seizedAmount = collateralState.collateralBalance;
      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);

      // 7. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // All collateral is seized and the user's asset bit is cleared.
      expect(collateralStateAfter.collateralBalance).to.equal(0);
      expect(collateralStateAfter.userCollateral.balance).to.equal(0);
      expect(cometStateAfter.user.assetsIn).to.equal(0);
      expect(cometStateAfter.user._reserved).to.equal(0);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: supplied total drops by the full seized amount, reserves rise by it,
      // and collateral + base ERC20 balances are untouched on the absorb path.
      expect(collateralStateAfter.totalsCollateral).to.equal(collateralState.totalsCollateral - seizedAmount);
      expect(collateralStateAfter.collateralReserves).to.equal(collateralState.collateralReserves + seizedAmount);
      expect(collateralStateAfter.cometErc20Balance).to.equal(collateralState.cometErc20Balance);
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the full small debt.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
    }
  );

  /**
   * 1 collateral: full seizure exactly covers the debt after the liquidation factor.
   *
   * Proves the boundary case: the collateral's liquidation-factor-weighted value equals the full
   * debt exactly. The account is liquidatable at the equality boundary, the full collateral is seized,
   * and the full debt is closed without requiring an actual shortfall.
   */
  scenario(
    `Comet#absorb > bad debt: 1 collateral fully seized when liquidation value exactly equals debt [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await getUsableCollateralIndices(ctx, 1)).length === 1,
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      await context.zeroBorrowRates();

      // Use the first collateral usable for the liquidation math (all three factors positive).
      const [collateralIndex] = await getUsableCollateralIndices(context, 1);

      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);
      const collateralScale = collateralAssetInfo.scale;
      const collateralLF = collateralAssetInfo.liquidationFactor;

      const originalPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();

      // 1. Engineer the equality boundary: after the price drop, the collateral's LF-weighted value must
      //    equal the debt (minDebtValue) exactly, under the contract's truncating math (mulPrice → mulFactor).
      //      minDebtValue    = baseBorrowMin priced in USD = baseBorrowMin * basePrice / baseScale
      //      borrowAmount    = baseBorrowMin (debt stays exactly here — borrow rates are zeroed above)
      //      collateralAmount= 4× over-collateralized at the original price, so the borrow is valid pre-drop
      //      targetValue     = smallest collateral value whose LF-weighted amount truncates up to minDebtValue
      //                      = ceil(minDebtValue * factorScale / LF)
      //    For a given collateralAmount the exact price is the smallest one whose LF-weighted value reaches
      //    the debt: droppedPrice = ceil(targetValue * collateralScale / collateralAmount). The two chained
      //    truncations mean that price can overshoot minDebtValue for some amounts, so nudge the amount up
      //    until the boundary lands exactly (typically the first amount already works).
      const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const borrowAmount = baseBorrowMin;
      const targetValue = (minDebtValue * factorScale + collateralLF - 1n) / collateralLF;

      let collateralAmount = (4n * minDebtValue * collateralScale) / originalPrice;
      let droppedPrice = (targetValue * collateralScale + collateralAmount - 1n) / collateralAmount;
      while (mulFactor(mulPrice(collateralAmount, droppedPrice, collateralScale), collateralLF) !== minDebtValue) {
        collateralAmount++;
        droppedPrice = (targetValue * collateralScale + collateralAmount - 1n) / collateralAmount;
      }

      // Supply collateral
      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });

      // Borrow
      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      // Sanity checks before dropping price
      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 2. Apply the price drop that makes the supplied collateral exactly cover the debt after LF.
      await context.changePriceFeeds({ [collateralAssetInfo.asset]: droppedPrice });
      const module = await configureModule(context, world, entry, partial, betty.address);

      // 3. Capture state and run the sanity checks that define the equality boundary.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralState] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
      const collateralValueAfterLF = mulFactor(
        mulPrice(collateralState.collateralBalance, droppedPrice, collateralAssetInfo.scale),
        collateralAssetInfo.liquidationFactor
      );

      // Sanity checks before absorb
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.equal(baseBorrowMin);
      expect(collateralValueAfterLF).to.equal(minDebtValue);
      expect(collateralValueAfterLF).to.equal(debtValueBefore);

      // 4. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 5. Full boundary seizure: the whole collateral amount is seized at market value and the full
      //    debt is closed.
      const seizedAmount = collateralState.collateralBalance;
      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);

      // 6. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect(cometStateAfter.user.principal).to.equal(0);
      expect(-cometStateAfter.userBalance).to.equal(0n);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // All collateral is seized and the user's asset bit is cleared.
      expect(collateralStateAfter.collateralBalance).to.equal(0);
      expect(collateralStateAfter.userCollateral.balance).to.equal(0);
      expect(cometStateAfter.user.assetsIn).to.equal(0);
      expect(cometStateAfter.user._reserved).to.equal(0);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: supplied total drops by the full seized amount, reserves rise by it,
      // and collateral + base ERC20 balances are untouched on the absorb path.
      expect(collateralStateAfter.totalsCollateral).to.equal(collateralState.totalsCollateral - seizedAmount);
      expect(collateralStateAfter.collateralReserves).to.equal(collateralState.collateralReserves + seizedAmount);
      expect(collateralStateAfter.cometErc20Balance).to.equal(collateralState.cometErc20Balance);
      expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the full debt value.
      expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
    }
  );
}

/*//////////////////////////////////////////////////////////////
                        REGISTER SCENARIOS
//////////////////////////////////////////////////////////////*/

absorbScenarios('absorb', true);
absorbScenarios('liquidate', true);
absorbScenarios('absorb', false);
