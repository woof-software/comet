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
  timeUntilUnderwater,
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

      // Put the module into the requested mode / entry configuration.
      const module = await configureModule(context, world, entry, partial, betty.address);

      // 1. Supply collateral worth ~$100: amount = value * scale / price.
      const COLLATERAL_VALUE = 100n * 10n ** 8n; // $100 in price scale (1e8 = $1)
      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const collateralScale = collateralAssetInfo.scale;
      const collateralPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();
      const collateralLF = collateralAssetInfo.liquidationFactor;
      const collateralAmount = (COLLATERAL_VALUE * collateralScale) / collateralPrice;
      const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);

      // 2. Source the collateral through the scenario token-sourcing method, then supply it.
      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });

      // 3. Borrow 2× the minimum-debt value. With ~$100 of collateral this sits just under the
      //    borrow limit, so once the position is underwater a single partial seizure drops the
      //    residual below baseBorrowMin and the debt is closed in full (in both modes).
      const baseToken = await comet.baseToken();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      const borrowAmount = 2n * baseBorrowMin;
      // Fund Comet with 2× the borrow straight to its balance — enough base liquidity for the
      // borrow with a buffer, and no separate base supplier required.
      await context.sourceTokens(2n * borrowAmount, context.getAssetByAddress(baseToken), comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 4. Fast-forward until interest accrual drives the position underwater.
      const secondsUntilUnderwater = await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: 60n * 10n, // 10 minutes past the underwater point
      });
      await world.increaseTime(secondsUntilUnderwater);
      await comet.accrueAccount(albert.address);

      // Sanity checks
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect((await comet.borrowBalanceOf(albert.address)).toBigInt()).to.be.greaterThan(baseBorrowMin);

      // 5. Capture the borrower's base state and the single collateral's state before the absorb.
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseScale = (await comet.baseScale()).toBigInt();
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);

      // 6. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      // 7. Capture the borrower's base state and the collateral's state after the absorb.
      const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [collateralAssetInfo]);

      // 8. Independently compute the expected seizure (mirrors _processDebtClosing full closure): the
      //    debt closes in full, so the protocol seizes exactly debt / LF worth of collateral. The absorb
      //    accrued one more block of interest before seizing, so read the debt at the post-absorb borrow
      //    index — presentValue() uses the current (accrued) index, giving exactly what the seizure saw.
      //    debtValue   = debt * basePrice / baseScale               (mulPrice)
      //    seizeAmount = (debtValue * FACTOR_SCALE / LF) / price     (divPrice by collateral price)
      const debtAtAbsorb = (await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      const debtRemainingValue = mulPrice(-debtAtAbsorb, basePrice, baseScale);
      collateralStateBefore.seizeAmount = divPrice(debtRemainingValue * factorScale / collateralLF, collateralPrice, collateralScale);
      collateralStateBefore.seizedValue = mulPrice(collateralStateBefore.seizeAmount, collateralPrice, collateralScale);
      // 9. Post-absorb checks.

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
      const module = await configureModule(context, world, entry, partial, betty.address);

      // The first two collaterals usable for the liquidation math, in index order.
      const collateralIndexes = await getUsableCollateralIndices(context, 2);
      const collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
      const collateralPrices = await Promise.all(collateralInfos.map(async (info) => (await comet.getPrice(info.priceFeed)).toBigInt()));

      // Asset 0 holds the bulk of the collateral: it carries the borrow power and is fully seized. Asset
      // 1 stays small and keeps the surplus after closing the residual debt. Values are chosen so the
      // BCF-weighted borrow power clears the borrow (a low-BCF asset 1 alone could not), while asset 0
      // still fully closes down to a sub-minDebt residual.
      const FIRST_COLLATERAL_VALUE = 95n * 10n ** 8n; // $95 on asset 0, in price scale (1e8 = $1)
      const SECOND_COLLATERAL_VALUE = 30n * 10n ** 8n; // $30 on asset 1
      const collateralValues = [FIRST_COLLATERAL_VALUE, SECOND_COLLATERAL_VALUE];

      // 1. Supply each collateral: source it, approve, and supply the computed amount.
      for (let i = 0; i < collateralInfos.length; i++) {
        const collateralInfo = collateralInfos[i];
        const amount = (collateralValues[i] * collateralInfo.scale) / collateralPrices[i]; // amount = value * scale / price
        const asset = context.getAssetByAddress(collateralInfo.asset);
        await context.sourceTokens(amount, asset, albert);
        await asset.approve(albert, comet.address);
        await albert.safeSupplyAsset({ asset: collateralInfo.asset, amount });
      }

      // 2. Borrow 2× the minimum debt against the collateral, then fund Comet with the base.
      const baseToken = await comet.baseToken();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      const borrowAmount = 2n * baseBorrowMin;
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseScale = (await comet.baseScale()).toBigInt();
      await context.sourceTokens(2n * borrowAmount, context.getAssetByAddress(baseToken), comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 3. Fast-forward until interest accrual drives the position underwater.
      const secondsUntilUnderwater = await timeUntilUnderwater({ comet, actor: albert, fudgeFactor: 60n * 10n });
      await world.increaseTime(secondsUntilUnderwater);
      await comet.accrueAccount(albert.address);

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

      // 7. Independently compute the expected seizure (mirrors the absorb loop). The absorb accrued one
      //    more block of interest before seizing, so read the debt at the post-absorb borrow index:
      //    presentValue() uses the current (accrued) index, so re-deriving the debt from the captured
      //    principal here is exactly what the seizure saw — no ~1-block drift left to tolerate.
      const debtAtAbsorb = (await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      const debtRemainingValue = mulPrice(-debtAtAbsorb, basePrice, baseScale);

      // Iter 1 (asset 0): its whole value falls short of the debt, so it is fully seized.
      //   debt reduction = collateralValue × LF (mulFactor).
      collateralStatesBefore[0].seizeAmount = collateralStatesBefore[0].collateralBalance;
      collateralStatesBefore[0].seizedValue = mulPrice(collateralStatesBefore[0].seizeAmount, collateralPrices[0], collateralInfos[0].scale);
      const debtAfterFirst = debtRemainingValue - mulFactor(collateralStatesBefore[0].seizedValue, collateralInfos[0].liquidationFactor);

      // Iter 2 (asset 1): closes the residual debt, seizing exactly debtAfterFirst / LF worth; surplus stays.
      collateralStatesBefore[1].seizeAmount = divPrice(debtAfterFirst * factorScale / collateralInfos[1].liquidationFactor, collateralPrices[1], collateralInfos[1].scale);
      collateralStatesBefore[1].seizedValue = mulPrice(collateralStatesBefore[1].seizeAmount, collateralPrices[1], collateralInfos[1].scale);

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
      const module = await configureModule(context, world, entry, partial, betty.address);

      // Every seizable collateral, in index order; the last one keeps the surplus.
      const collateralIndexes = await getUsableCollateralIndices(context);
      const collateralInfos = await Promise.all(collateralIndexes.map((index) => getAssetInfo(comet, index)));
      const collateralPrices = await Promise.all(collateralInfos.map(async (info) => (await comet.getPrice(info.priceFeed)).toBigInt()));
      const lastIdx = collateralInfos.length - 1;

      // Distribute the collateral so the earlier assets hold the bulk ($95, shared): they carry the
      // BCF-weighted borrow power (a low-BCF last asset alone could not) and are each fully seized,
      // while the last asset stays small ($30) and keeps the surplus after closing the residual debt.
      const EARLIER_TOTAL_VALUE = 95n * 10n ** 8n; // $95 shared across the earlier assets
      const LAST_COLLATERAL_VALUE = 30n * 10n ** 8n; // $30 on the last (surplus) asset, in price scale (1e8 = $1)
      const perEarlierValue = collateralInfos.length > 1 ? EARLIER_TOTAL_VALUE / BigInt(collateralInfos.length - 1) : 0n;

      // 1. Supply each collateral: source it, approve, and supply the computed amount. The earlier assets
      //    share the smaller budget; the last (closing) asset stays small and keeps the surplus.
      for (let i = 0; i < collateralInfos.length; i++) {
        const collateralInfo = collateralInfos[i];
        const value = i === lastIdx ? LAST_COLLATERAL_VALUE : perEarlierValue;
        const amount = (value * collateralInfo.scale) / collateralPrices[i]; // amount = value * scale / price
        const asset = context.getAssetByAddress(collateralInfo.asset);
        await context.sourceTokens(amount, asset, albert);
        await asset.approve(albert, comet.address);
        await albert.safeSupplyAsset({ asset: collateralInfo.asset, amount });
      }

      // 2. Borrow 2× the minimum debt against the ~$100 collateral, then fund Comet with the base.
      const baseToken = await comet.baseToken();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      const borrowAmount = 2n * baseBorrowMin;
      await context.sourceTokens(2n * borrowAmount, context.getAssetByAddress(baseToken), comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 3. Fast-forward until interest accrual drives the position underwater.
      const secondsUntilUnderwater = await timeUntilUnderwater({ comet, actor: albert, fudgeFactor: 60n * 10n });
      await world.increaseTime(secondsUntilUnderwater);
      await comet.accrueAccount(albert.address);

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

      // 7. Independently compute the expected seizure (mirrors the absorb loop): every earlier asset is
      //    fully seized (debt drops by its value × LF), and the last asset closes the residual debt,
      //    seizing exactly (debtRemaining / LF) worth. The absorb accrued one more block of interest
      //    before seizing, so read the debt at the post-absorb borrow index: presentValue() uses the
      //    current (accrued) index, so re-deriving the debt from the captured principal here is exactly
      //    what the seizure saw — no ~1-block drift left to tolerate.
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseScale = (await comet.baseScale()).toBigInt();
      const debtAtAbsorb = (await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      let debtRemainingValue = mulPrice(-debtAtAbsorb, basePrice, baseScale);
      for (let i = 0; i < lastIdx; i++) {
        // Earlier collateral: fully seized; debt drops by collateralValue × LF (mulFactor).
        collateralStatesBefore[i].seizeAmount = collateralStatesBefore[i].collateralBalance;
        collateralStatesBefore[i].seizedValue = mulPrice(collateralStatesBefore[i].seizeAmount, collateralPrices[i], collateralInfos[i].scale);
        debtRemainingValue -= mulFactor(collateralStatesBefore[i].seizedValue, collateralInfos[i].liquidationFactor);
      }

      // Closing collateral: seize exactly debtRemaining / LF worth; surplus stays.
      collateralStatesBefore[lastIdx].seizeAmount = divPrice(debtRemainingValue * factorScale / collateralInfos[lastIdx].liquidationFactor, collateralPrices[lastIdx], collateralInfos[lastIdx].scale);
      collateralStatesBefore[lastIdx].seizedValue = mulPrice(collateralStatesBefore[lastIdx].seizeAmount, collateralPrices[lastIdx], collateralInfos[lastIdx].scale);

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
      const borrowAmount = 3n * baseBorrowMin;

      // 1. Betty supplies base for real, so totalSupplyBase > 0 (the supply and tracking-supply indices
      //    can grow / divide safely) and albert has liquidity to borrow against.
      await context.sourceTokens(borrowAmount, context.getAssetByAddress(baseToken), betty);
      await context.getAssetByAddress(baseToken).approve(betty, comet.address);
      await betty.safeSupplyAsset({ asset: baseToken, amount: borrowAmount });

      // 2. Albert supplies the collateral worth 4× the minimum borrow value and borrows 3× the min debt.
      //    minBorrowValue  = baseBorrowMin * basePrice / baseScale
      //    collateralValue = 4 * minBorrowValue
      const collateralAssetInfo = await getAssetInfo(comet, collateralIndex);
      const collateralPrice = (await comet.getPrice(collateralAssetInfo.priceFeed)).toBigInt();
      const minBorrowValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const collateralValue = 4n * minBorrowValue;
      const collateralAmount = (collateralValue * collateralAssetInfo.scale) / collateralPrice;
      const collateralAsset = context.getAssetByAddress(collateralAssetInfo.asset);
      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAssetInfo.asset, amount: collateralAmount });
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 3. Drop the collateral price by 35%, then accrue so lastAccrualTime is a clean starting point.
      await context.changePriceFeeds({ [collateralAssetInfo.asset]: Number((collateralPrice * 65n) / 100n) / 1e8 });
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
}

/*//////////////////////////////////////////////////////////////
                        REGISTER SCENARIOS
//////////////////////////////////////////////////////////////*/

absorbScenarios('absorb', true);
absorbScenarios('liquidate', true);
absorbScenarios('absorb', false);
