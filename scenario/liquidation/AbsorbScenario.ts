import { scenario } from '../context/CometContext';
import { expect } from 'chai';
import {
  Entry,
  hasModule,
  configureModule,
  captureAbsorbStateBefore,
  makeCollateralStates,
  usableCollateralIndices,
  isValidAssetIndex,
  isAssetDelisted,
  usesAssetList,
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

  // The index of the collateral asset to use for the absorb scenarios. Where only 1 token is used, this is the only index.
  const collateralIndex = 0;

  /*//////////////////////////////////////////////////////////////
                             HAPPY PATHS
  //////////////////////////////////////////////////////////////*/

  // 1 collateral: seized down to a surplus; debt fully closed.
  scenario(
    `Comet#absorb > 1 collateral: debt closed, surplus retained [${tag}]`,
    {
      filter: async (ctx) => 
        (await hasModule(ctx)) 
        && (await usesAssetList(ctx)) 
        && (await isValidAssetIndex(ctx, collateralIndex)) 
        && !(await isAssetDelisted(ctx, collateralIndex)),
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

      // Put the module into the requested mode / entry configuration.
      const module = await configureModule(context, world, entry, partial, betty.address);

      // 1. Supply collateral worth ~$100 of asset 0: amount = value * scale / price.
      const COLLATERAL_VALUE = 100n * 10n ** 8n; // $100 in price scale (1e8 = $1)
      const info = await comet.getAssetInfo(collateralIndex);
      const collateralScale = info.scale.toBigInt();
      const collateralPrice = (await comet.getPrice(info.priceFeed)).toBigInt();
      const collateralAmount = (COLLATERAL_VALUE * collateralScale) / collateralPrice;
      const collateralAsset = context.getAssetByAddress(info.asset);

      // 2. Source the collateral through the scenario token-sourcing method, then supply it.
      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: info.asset, amount: collateralAmount });

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
      await context.setNextBaseFeeToZero();
      await comet.accrueAccount(albert.address, { gasPrice: 0 });

      // Sanity checks
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect((await comet.borrowBalanceOf(albert.address)).toBigInt()).to.be.greaterThan(baseBorrowMin);

      // 5. Capture the borrower's base state and the single collateral's state for the post-absorb checks.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralState] = await makeCollateralStates(comet, context, albert.address, [collateralIndex]);

      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseScale = (await comet.baseScale()).toBigInt();
      const collateralLF = info.liquidationFactor.toBigInt();

      // 6. Absorb via the active entry point.
      await context.setNextBaseFeeToZero();
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address], { gasPrice: 0 });
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, [], { gasPrice: 0 });
      }

      // 7. Independently compute the expected seizure (mirrors _processDebtClosing full closure): the
      //    debt closes in full, so the protocol seizes exactly debt / LF worth of collateral. The absorb
      //    accrued one more block of interest before seizing, so read the debt at the post-absorb borrow
      //    index — presentValue() uses the current (accrued) index, giving exactly what the seizure saw.
      //    debtValue   = debt * basePrice / baseScale               (mulPrice)
      //    seizeAmount = (debtValue * FACTOR_SCALE / LF) / price     (divPrice by collateral price)
      const debtAtAbsorb = (await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      const debtRemainingValue = mulPrice(-debtAtAbsorb, basePrice, baseScale);
      collateralState.seizeAmount = divPrice(debtRemainingValue * factorScale / collateralLF, collateralState.price, collateralState.scale);
      collateralState.seizedValue = mulPrice(collateralState.seizeAmount, collateralState.price, collateralState.scale);
      // Only fixed-point rounding remains between the mirrored math and the contract.
      const seizeDelta = 2;

      // 8. Post-absorb checks.

      // Debt fully repaid: principal, borrow balance and simple base balance are all zero.
      expect((await comet.userBasic(albert.address)).principal).to.equal(0);
      expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // Collateral seized by the independently-computed amount, surplus retained.
      expect(await comet.collateralBalanceOf(albert.address, info.asset)).to.be.approximately(collateralState.collateralBalance - collateralState.seizeAmount, seizeDelta);
      expect((await comet.userCollateral(albert.address, info.asset)).balance).to.be.approximately(collateralState.collateralBalance - collateralState.seizeAmount, seizeDelta);

      // assetsIn keeps the collateral bit (surplus remains); reserved bits are untouched.
      expect((await comet.userBasic(albert.address)).assetsIn).to.equal(cometStateBefore.user.assetsIn);
      expect((await comet.userBasic(albert.address))._reserved).to.equal(cometStateBefore.user._reserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(totalsAfter.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: totals down by the seized amount, reserves up by it, ERC20 balances untouched.
      expect((await comet.totalsCollateral(info.asset)).totalSupplyAsset).to.be.approximately(collateralState.totalsCollateral - collateralState.seizeAmount, seizeDelta);
      expect((await comet.getCollateralReserves(info.asset))).to.be.approximately(collateralState.collateralReserves + collateralState.seizeAmount, seizeDelta);
      expect(await collateralAsset.balanceOf(comet.address)).to.equal(collateralState.cometErc20Balance);
      expect(await context.getAssetByAddress(baseToken).balanceOf(comet.address)).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Closing the debt in full pays the borrower's (negative) base balance out of reserves, so
      // base reserves move by exactly that balance: reservesAfter = reservesBefore + userBalanceBefore.
      expect((await comet.getReserves()).toBigInt()).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      // The position is healthy again.
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
    }
  );

  // 2 collaterals: the first is fully seized, the second keeps the surplus; debt fully closed.
  const indices = [0, 1];
  scenario(
    `Comet#absorb > 2 collaterals: debt closed, surplus retained [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await usesAssetList(ctx)) &&
        (await isValidAssetIndex(ctx, indices[0])) &&
        (await isValidAssetIndex(ctx, indices[1])) &&
        !(await isAssetDelisted(ctx, indices[0])) &&
        !(await isAssetDelisted(ctx, indices[1])),
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;
      const module = await configureModule(context, world, entry, partial, betty.address);

      // Asset 0 (index 0) holds the bulk of the collateral: it carries the borrow power and is fully
      // seized. Asset 1 (index 1) stays small and keeps the surplus after closing the residual debt.
      // Values are chosen so the BCF-weighted borrow power clears the borrow (a low-BCF asset 1 alone
      // could not), while asset 0 still fully closes down to a sub-minDebt residual.
      const FIRST_VALUE = 95n * 10n ** 8n; // $95 on asset 0, in price scale (1e8 = $1)
      const LAST_VALUE = 30n * 10n ** 8n;  // $30 on asset 1
      const collateralValues = [FIRST_VALUE, LAST_VALUE];

      // 1. Supply each collateral: source it, approve, and supply the computed amount.
      for (let k = 0; k < indices.length; k++) {
        const info = await comet.getAssetInfo(indices[k]);
        const scale = info.scale.toBigInt();
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const amount = (collateralValues[k] * scale) / price; // amount = value * scale / price
        const asset = context.getAssetByAddress(info.asset);
        await context.sourceTokens(amount, asset, albert);
        await asset.approve(albert, comet.address);
        await albert.safeSupplyAsset({ asset: info.asset, amount });
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
      await context.setNextBaseFeeToZero();
      await comet.accrueAccount(albert.address, { gasPrice: 0 });

      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect((await comet.borrowBalanceOf(albert.address)).toBigInt()).to.be.greaterThan(baseBorrowMin);

      // 4. Capture the borrower's base state and each collateral's state (in index order).
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStates = await makeCollateralStates(comet, context, albert.address, indices);

      // 5. Absorb via the active entry point.
      await context.setNextBaseFeeToZero();
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address], { gasPrice: 0 });
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, [], { gasPrice: 0 });
      }

      // 6. Independently compute the expected seizure (mirrors the absorb loop). The absorb accrued one
      //    more block of interest before seizing, so read the debt at the post-absorb borrow index:
      //    presentValue() uses the current (accrued) index, so re-deriving the debt from the captured
      //    principal here is exactly what the seizure saw — no ~1-block drift left to tolerate.
      const debtAtAbsorb = (await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      const debtRemainingValue = mulPrice(-debtAtAbsorb, basePrice, baseScale);

      // Iter 1 (asset 0): its whole value falls short of the debt, so it is fully seized.
      //   debt reduction = collateralValue × LF (mulFactor).
      collateralStates[0].seizeAmount = collateralStates[0].collateralBalance;
      collateralStates[0].seizedValue = mulPrice(collateralStates[0].seizeAmount, collateralStates[0].price, collateralStates[0].scale);
      const debtAfterFirst = debtRemainingValue - mulFactor(collateralStates[0].seizedValue, collateralStates[0].liquidationFactor);

      // Iter 2 (asset 1): closes the residual debt, seizing exactly debtAfterFirst / LF worth; surplus stays.
      collateralStates[1].seizeAmount = divPrice(debtAfterFirst * factorScale / collateralStates[1].liquidationFactor.toBigInt(), collateralStates[1].price, collateralStates[1].scale);
      collateralStates[1].seizedValue = mulPrice(collateralStates[1].seizeAmount, collateralStates[1].price, collateralStates[1].scale);

      // Only fixed-point rounding remains between the mirrored math and the contract, so a couple of
      // base units of slack is enough.
      const seizeDelta = 2;

      // 7. Post-absorb checks.

      // Debt fully repaid: principal, borrow balance and simple base balance are all zero.
      expect((await comet.userBasic(albert.address)).principal).to.equal(0);
      expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // Each collateral is reduced by its seized amount: asset 0 down to zero, asset 1 to a surplus.
      for (const collateralState of collateralStates) {
        expect(await comet.collateralBalanceOf(albert.address, collateralState.asset))
          .to.be.approximately(collateralState.collateralBalance - collateralState.seizeAmount, seizeDelta);
      }

      // assetsIn clears the fully-seized asset 0 bit, keeps asset 1's; reserved bits untouched.
      const expectedAssetsIn = cometStateBefore.user.assetsIn & ~(1 << indices[0]);
      expect((await comet.userBasic(albert.address)).assetsIn).to.equal(expectedAssetsIn);
      expect((await comet.userBasic(albert.address))._reserved).to.equal(cometStateBefore.user._reserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(totalsAfter.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting, per asset: supplied totals drop by the seized amount, reserves
      // rise by it, and the ERC20 balances are untouched on the absorb path.
      for (const collateralState of collateralStates) {
        expect((await comet.totalsCollateral(collateralState.asset)).totalSupplyAsset)
          .to.be.approximately(collateralState.totalsCollateral - collateralState.seizeAmount, seizeDelta);
        expect(await comet.getCollateralReserves(collateralState.asset))
          .to.be.approximately(collateralState.collateralReserves + collateralState.seizeAmount, seizeDelta);
        expect(await context.getAssetByAddress(collateralState.asset).balanceOf(comet.address))
          .to.equal(collateralState.cometErc20Balance);
      }
      // Base token ERC20 balance is untouched on the absorb path.
      expect(await context.getAssetByAddress(baseToken).balanceOf(comet.address)).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Closing the debt in full pays the borrower's (negative) base balance out of reserves.
      expect((await comet.getReserves()).toBigInt()).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      // The position is healthy again.
      expect(await comet.isLiquidatable(albert.address)).to.be.false;
    }
  );

  // All usable collaterals: every earlier asset fully seized, the last keeps the surplus.
  scenario(
    `Comet#absorb > all collaterals: debt closed, surplus retained [${tag}]`,
    {
      filter: async (ctx) => (await hasModule(ctx)) && (await usesAssetList(ctx)),
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;
      const module = await configureModule(context, world, entry, partial, betty.address);

      // Every seizable collateral, in index order; the last one keeps the surplus.
      const indices = await usableCollateralIndices(context);
      const lastIdx = indices.length - 1;

      // Distribute the collateral so the earlier assets hold the bulk ($95, shared): they carry the
      // BCF-weighted borrow power (a low-BCF last asset alone could not) and are each fully seized,
      // while the last asset stays small ($30) and keeps the surplus after closing the residual debt.
      const EARLIER_TOTAL_VALUE = 95n * 10n ** 8n; // $95 shared across the earlier assets
      const LAST_VALUE = 30n * 10n ** 8n; // $30 on the last (surplus) asset, in price scale (1e8 = $1)
      const perEarlierValue = indices.length > 1 ? EARLIER_TOTAL_VALUE / BigInt(indices.length - 1) : 0n;

      // 1. Supply each collateral: source it, approve, and supply the computed amount. The earlier
      //    assets share the smaller budget; the last (closing) asset holds the bulk, so it is
      //    supplied separately after the loop.
      const supplyCollateral = async (index: number, value: bigint) => {
        const info = await comet.getAssetInfo(index);
        const amount = (value * info.scale.toBigInt()) / (await comet.getPrice(info.priceFeed)).toBigInt(); // amount = value * scale / price
        const asset = context.getAssetByAddress(info.asset);
        await context.sourceTokens(amount, asset, albert);
        await asset.approve(albert, comet.address);
        await albert.safeSupplyAsset({ asset: info.asset, amount });
      };

      const earlierIndices = indices.slice(0, lastIdx);
      const lastIndex = indices[lastIdx];
      for (const index of earlierIndices) {
        await supplyCollateral(index, perEarlierValue);
      }
      await supplyCollateral(lastIndex, LAST_VALUE);

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
      await context.setNextBaseFeeToZero();
      await comet.accrueAccount(albert.address, { gasPrice: 0 });

      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect((await comet.borrowBalanceOf(albert.address)).toBigInt()).to.be.greaterThan(baseBorrowMin);

      // 4. Capture the borrower's base state and each collateral's state (in index order).
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralsState = await makeCollateralStates(comet, context, albert.address, indices);

      // 5. Absorb via the active entry point.
      await context.setNextBaseFeeToZero();
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address], { gasPrice: 0 });
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, [], { gasPrice: 0 });
      }

      // 6. Independently compute the expected seizure (mirrors the absorb loop): every earlier asset is
      //    fully seized (debt drops by its value × LF), and the last asset closes the residual debt,
      //    seizing exactly (debtRemaining / LF) worth.
      const earlierCollaterals = collateralsState.slice(0, lastIdx);
      const lastCollateral = collateralsState[lastIdx];
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseScale = (await comet.baseScale()).toBigInt();

      // The absorb accrued one more block of interest before seizing, so read the debt at the post-absorb
      // borrow index: presentValue() uses the current (accrued) index, so re-deriving the debt from the
      // captured principal here is exactly what the seizure saw — no ~1-block drift left to tolerate.
      const debtAtAbsorb = (await comet.presentValue(cometStateBefore.user.principal)).toBigInt();
      let debtRemainingValue = mulPrice(-debtAtAbsorb, basePrice, baseScale);
      for (const collateral of earlierCollaterals) {
        // Earlier collateral: fully seized; debt drops by collateralValue × LF (mulFactor).
        collateral.seizeAmount = collateral.collateralBalance;
        collateral.seizedValue = mulPrice(collateral.seizeAmount, collateral.price, collateral.scale);
        debtRemainingValue -= mulFactor(collateral.seizedValue, collateral.liquidationFactor);
      }

      // Closing collateral: seize exactly debtRemaining / LF worth; surplus stays.
      lastCollateral.seizeAmount = divPrice(debtRemainingValue * factorScale / lastCollateral.liquidationFactor.toBigInt(), lastCollateral.price, lastCollateral.scale);
      lastCollateral.seizedValue = mulPrice(lastCollateral.seizeAmount, lastCollateral.price, lastCollateral.scale);

      // Only fixed-point rounding remains between the mirrored math and the contract, so a couple of
      // base units of slack is enough.
      const seizeDelta = 2;

      // 7. Post-absorb checks.

      // Debt fully repaid: principal, borrow balance and simple base balance are all zero.
      expect((await comet.userBasic(albert.address)).principal).to.equal(0);
      expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // Per-collateral accounting. Earlier assets are each fully seized and their assetsIn bit cleared;
      // their totals/reserves move exactly (no interest drift on a zeroed balance), ERC20 untouched.
      let expectedAssetsIn = cometStateBefore.user.assetsIn;
      for (const collateral of earlierCollaterals) {
        expect(await comet.collateralBalanceOf(albert.address, collateral.asset)).to.equal(0);
        expectedAssetsIn = expectedAssetsIn & ~(1 << collateral.offset);
        expect((await comet.totalsCollateral(collateral.asset)).totalSupplyAsset)
          .to.equal(collateral.totalsCollateral - collateral.seizeAmount);
        expect(await comet.getCollateralReserves(collateral.asset))
          .to.equal(collateral.collateralReserves + collateral.seizeAmount);
        expect(await context.getAssetByAddress(collateral.asset).balanceOf(comet.address))
          .to.equal(collateral.cometErc20Balance);
      }

      // Closing collateral: seized partially with a surplus retained; totals/reserves move by the
      // seized amount (±1-block drift), ERC20 untouched.
      const lastAfter = (await comet.collateralBalanceOf(albert.address, lastCollateral.asset)).toBigInt();
      expect(lastAfter).to.be.approximately(lastCollateral.collateralBalance - lastCollateral.seizeAmount, seizeDelta);
      expect(lastAfter).to.be.greaterThan(0);
      expect((await comet.totalsCollateral(lastCollateral.asset)).totalSupplyAsset)
        .to.be.approximately(lastCollateral.totalsCollateral - lastCollateral.seizeAmount, seizeDelta);
      expect(await comet.getCollateralReserves(lastCollateral.asset))
        .to.be.approximately(lastCollateral.collateralReserves + lastCollateral.seizeAmount, seizeDelta);
      expect(await context.getAssetByAddress(lastCollateral.asset).balanceOf(comet.address))
        .to.equal(lastCollateral.cometErc20Balance);

      // assetsIn keeps only the surviving (last) collateral bit; reserved bits untouched.
      expect((await comet.userBasic(albert.address)).assetsIn).to.equal(expectedAssetsIn);
      expect((await comet.userBasic(albert.address))._reserved).to.equal(cometStateBefore.user._reserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(totalsAfter.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Base token ERC20 balance is untouched on the absorb path.
      expect(await context.getAssetByAddress(baseToken).balanceOf(comet.address)).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Closing the debt in full pays the borrower's (negative) base balance out of reserves.
      expect((await comet.getReserves()).toBigInt()).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

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
        (await usesAssetList(ctx)) &&
        (await isValidAssetIndex(ctx, 0)) &&
        !(await isAssetDelisted(ctx, 0))
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

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

      // 2. Albert supplies asset 0 worth 4× the minimum borrow value and borrows 3× the min debt.
      //    minBorrowValue  = baseBorrowMin * basePrice / baseScale
      //    collateralValue = 4 * minBorrowValue
      const info = await comet.getAssetInfo(0);
      const collateralPrice = (await comet.getPrice(info.priceFeed)).toBigInt();
      const minBorrowValue = mulPrice(baseBorrowMin, basePrice, baseScale);
      const collateralValue = 4n * minBorrowValue;
      const collateralAmount = (collateralValue * info.scale.toBigInt()) / collateralPrice;
      const collateralAsset = context.getAssetByAddress(info.asset);
      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: info.asset, amount: collateralAmount });
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 3. Drop the collateral price by 35%, then accrue so lastAccrualTime is a clean starting point.
      await context.changePriceFeeds({ [info.asset]: Number((collateralPrice * 65n) / 100n) / 1e8 });
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

      console.log('!!!!!!');
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

      await context.setNextBaseFeeToZero();
      if (entry === 'absorb') {
        await expectRevertCustom(comet.connect(betty.signer).absorb(betty.address, [albert.address], { gasPrice: 0 }), 'NotLiquidatable()');
      } else {
        await expectRevertCustom(module.connect(betty.signer).liquidate(betty.address, albert.address, [], { gasPrice: 0 }), 'NotLiquidatable()');
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

      await context.setNextBaseFeeToZero();
      if (entry === 'absorb') {
        await expectRevertCustom(comet.connect(betty.signer).absorb(betty.address, [albert.address], { gasPrice: 0 }), 'NotLiquidatable()');
      } else {
        await expectRevertCustom(module.connect(betty.signer).liquidate(betty.address, albert.address, [], { gasPrice: 0 }), 'NotLiquidatable()');
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

      await context.setNextBaseFeeToZero();
      if (entry === 'absorb') {
        await expectRevertCustom(comet.connect(betty.signer).absorb(betty.address, [albert.address], { gasPrice: 0 }), 'Paused()');
      } else {
        await expectRevertCustom(module.connect(betty.signer).liquidate(betty.address, albert.address, [], { gasPrice: 0 }), 'Paused()');
      }
    }
  );

  // Has debt but is fully borrow-collateralized → LCF-weighted collateral covers the debt.
  scenario(
    `Comet#absorb > reverts when debt is borrow collateralized [${tag}]`,
    {
      filter: async (ctx) => (await hasModule(ctx)) && (await isValidAssetIndex(ctx, collateralIndex)) && !(await isAssetDelisted(ctx, collateralIndex)),
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;
      const module = await configureModule(context, world, entry, partial, betty.address);

      // Supply collateral worth ~3× the debt and borrow the minimum: well within the BCF limit.
      const baseToken = await comet.baseToken();
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      const debtValue = (baseBorrowMin * basePrice) / baseScale;

      const info = await comet.getAssetInfo(collateralIndex);
      const origPrice = (await comet.getPrice(info.priceFeed)).toBigInt();
      const amount = (3n * debtValue * info.scale.toBigInt()) / origPrice;
      const asset = context.getAssetByAddress(info.asset);
      await context.sourceTokens(amount, asset, albert);
      await asset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: info.asset, amount });

      // Fund Comet with base so the borrow is drawable, then borrow the minimum.
      await context.sourceTokens(2n * baseBorrowMin, context.getAssetByAddress(baseToken), comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: baseBorrowMin });

      expect((await comet.userBasic(albert.address)).principal).to.be.lessThan(0);
      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      await context.setNextBaseFeeToZero();
      if (entry === 'absorb') {
        await expectRevertCustom(comet.connect(betty.signer).absorb(betty.address, [albert.address], { gasPrice: 0 }), 'NotLiquidatable()');
      } else {
        await expectRevertCustom(module.connect(betty.signer).liquidate(betty.address, albert.address, [], { gasPrice: 0 }), 'NotLiquidatable()');
      }
    }
  );

  // Not borrow-collateralized (BCF-weighted < debt) but still not liquidatable (LCF-weighted ≥ debt).
  scenario(
    `Comet#absorb > reverts when not borrow collateralized but still not liquidatable [${tag}]`,
    {
      filter: async (ctx) => (await hasModule(ctx)) && (await isValidAssetIndex(ctx, collateralIndex)) && !(await isAssetDelisted(ctx, collateralIndex)),
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;
      const module = await configureModule(context, world, entry, partial, betty.address);

      const baseToken = await comet.baseToken();
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      // Debt value at the minimum borrow: debtValueMin = baseBorrowMin * basePrice / baseScale.
      const debtValueMin = (baseBorrowMin * basePrice) / baseScale;

      const info = await comet.getAssetInfo(collateralIndex);
      const scale = info.scale.toBigInt();
      const borrowCF = info.borrowCollateralFactor.toBigInt();
      const liquidateCF = info.liquidateCollateralFactor.toBigInt();
      const price = (await comet.getPrice(info.priceFeed)).toBigInt();

      // Supply collateral whose BCF-weighted value is ~110% of the min debt: the min borrow is drawable
      // and the account starts borrow-collateralized and not liquidatable. amount = value * scale / price.
      const collateralValue = (110n * debtValueMin * factorScale) / (100n * borrowCF);
      const amount = (collateralValue * scale) / price;
      const asset = context.getAssetByAddress(info.asset);
      await context.sourceTokens(amount, asset, albert);
      await asset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: info.asset, amount });

      // Fund Comet with base so the borrow is drawable, then borrow the minimum.
      await context.sourceTokens(2n * baseBorrowMin, context.getAssetByAddress(baseToken), comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: baseBorrowMin });

      // Instead of moving the price, let borrow interest carry the debt into the band where the account
      // is no longer borrow-collateralized (BCF·collateral < debt) yet still not liquidatable
      // (LCF·collateral ≥ debt). Aim for the middle of that band and solve for the time to get there.
      //   collateralBCF = collateral * BCF / factorScale ; collateralLCF = collateral * LCF / factorScale
      //   targetDebtValue = (collateralBCF + collateralLCF) / 2
      const collateral = ((await comet.collateralBalanceOf(albert.address, info.asset)).toBigInt() * price) / scale;
      const collateralBCF = (collateral * borrowCF) / factorScale;
      const collateralLCF = (collateral * liquidateCF) / factorScale;
      const targetDebtValue = (collateralBCF + collateralLCF) / 2n;
      const targetDebt = (targetDebtValue * baseScale) / basePrice; // back to base units

      // A single accrual grows the debt linearly: debt(T) = debt0 * (1 + borrowRate * T / factorScale).
      // Solve for T so debt(T) == targetDebt. Nothing changes state before the accrual below, so the
      // borrow rate read here is exactly the one that accrual applies.
      const debt0 = (await comet.borrowBalanceOf(albert.address)).toBigInt();
      const borrowRate = (await comet.getBorrowRate(await comet.getUtilization())).toBigInt();
      const secondsToBand = ((targetDebt - debt0) * factorScale) / (debt0 * borrowRate);

      await world.increaseTime(Number(secondsToBand));
      await context.setNextBaseFeeToZero();
      await comet.accrueAccount(albert.address, { gasPrice: 0 });

      expect((await comet.userBasic(albert.address)).principal).to.be.lessThan(0);
      expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      await context.setNextBaseFeeToZero();
      if (entry === 'absorb') {
        await expectRevertCustom(comet.connect(betty.signer).absorb(betty.address, [albert.address], { gasPrice: 0 }), 'NotLiquidatable()');
      } else {
        await expectRevertCustom(module.connect(betty.signer).liquidate(betty.address, albert.address, [], { gasPrice: 0 }), 'NotLiquidatable()');
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
