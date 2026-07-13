import { scenario } from '../context/CometContext';
import { expect } from 'chai';
import {
  Entry,
  hasModule,
  configureModule,
  captureAbsorbStateBefore,
  makeCollateralStates,
  isValidAssetIndex,
  isAssetDelisted,
  usesAssetList,
  usableCollateralIndices,
  zeroBaseBorrowMin,
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

  // The single collateral asset used for these scenarios.
  const collateralIndex = 0;

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
        (await usesAssetList(ctx)) &&
        (await isValidAssetIndex(ctx, collateralIndex)) &&
        !(await isAssetDelisted(ctx, collateralIndex)),
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;
      const module = await configureModule(context, world, entry, partial, betty.address);

      const baseToken = await comet.baseToken();
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();

      const info = await comet.getAssetInfo(collateralIndex);
      const scale = info.scale.toBigInt();
      const price = (await comet.getPrice(info.priceFeed)).toBigInt();
      const lf = info.liquidationFactor.toBigInt();

      // 1. Supply collateral worth ~$100 and borrow a healthy 2× min debt — comfortably within the BCF
      //    limit, so the position starts collateralized and not liquidatable.
      const COLLATERAL_VALUE = 100n * 10n ** 8n; // $100 in price scale (1e8 = $1)
      const collateralAmount = (COLLATERAL_VALUE * scale) / price; // amount = value * scale / price
      const collateralAsset = context.getAssetByAddress(info.asset);
      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: info.asset, amount: collateralAmount });

      const borrowAmount = 2n * baseBorrowMin;
      await context.sourceTokens(2n * borrowAmount, context.getAssetByAddress(baseToken), comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 2. Skip time so borrow interest carries the debt past the collateral's LF-weighted value — full
      //    seizure can then no longer cover it (bad debt). Target the debt at 110% of the LF-weighted
      //    collateral value. A single accrual grows the debt linearly:
      //      debt(T) = debt0 * (1 + borrowRate * T / factorScale)
      //    Solve for T. Nothing changes state before the accrual below, so the borrow rate read here is
      //    exactly the one the accrual applies.
      //      collateralValue        = collateralAmount * price / scale                 (mulPrice)
      //      collateralValueAfterLF = collateralValue * LF                             (mulFactor)
      const collateralValue = mulPrice(collateralAmount, price, scale);
      const collateralValueAfterLF = mulFactor(collateralValue, lf);
      const targetDebtValue = (collateralValueAfterLF * 110n) / 100n; // 10% above LF-weighted → bad debt
      const targetDebt = (targetDebtValue * baseScale) / basePrice;   // back to base units

      const debt0 = (await comet.borrowBalanceOf(albert.address)).toBigInt();
      const borrowRate = (await comet.getBorrowRate(await comet.getUtilization())).toBigInt();
      const secondsToBadDebt = ((targetDebt - debt0) * factorScale) / (debt0 * borrowRate);

      await world.increaseTime(Number(secondsToBadDebt));
      await comet.accrueAccount(albert.address);

      // 3. Capture state and run the sanity checks that define the bad-debt case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralState] = await makeCollateralStates(comet, context, albert.address, [collateralIndex]);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);

      // User is liquidatable and the debt still exceeds the minimum.
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.greaterThan(baseBorrowMin);
      // Collateral value after the liquidation factor is below the debt — this is what makes it bad debt.
      const collateralValueAfterLFNow = mulFactor(
        mulPrice(collateralState.collateralBalance, collateralState.price, collateralState.scale),
        lf
      );
      expect(collateralValueAfterLFNow).to.be.lessThan(debtValueBefore);

      // 4. Absorb via the active entry point.
      if (entry === 'absorb') {
        await comet.connect(betty.signer).absorb(betty.address, [albert.address]);
      } else {
        await module.connect(betty.signer).liquidate(betty.address, albert.address, []);
      }

      const seizedAmount = collateralState.collateralBalance;

      // 6. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect((await comet.userBasic(albert.address)).principal).to.equal(0);
      expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // All of the collateral is seized; its assetsIn bit is cleared and the reserved bits are untouched.
      expect(await comet.collateralBalanceOf(albert.address, collateralState.asset)).to.equal(0);
      expect((await comet.userBasic(albert.address)).assetsIn).to.equal(0);
      expect((await comet.userBasic(albert.address))._reserved).to.equal(0);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(totalsAfter.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: supplied total drops by the full seized amount, reserves rise by it,
      // and the collateral + base ERC20 balances are untouched on the absorb path.
      expect((await comet.totalsCollateral(collateralState.asset)).totalSupplyAsset).to.equal(collateralState.totalsCollateral - seizedAmount);
      expect(await comet.getCollateralReserves(collateralState.asset)).to.equal(collateralState.collateralReserves + seizedAmount);
      expect(await collateralAsset.balanceOf(comet.address)).to.equal(collateralState.cometErc20Balance);
      expect(await context.getAssetByAddress(baseToken).balanceOf(comet.address)).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the FULL debt — the bad-debt write-off, not capped by what the collateral
      // covered. The intra-block interest on the borrow cancels the write-off, so this is exact against
      // the captured (pre-absorb) balance.
      expect(await comet.getReserves()).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      console.log('!!!!!!');
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
      filter: async (ctx) => (await hasModule(ctx)) && (await usesAssetList(ctx)),
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;
      const module = await configureModule(context, world, entry, partial, betty.address);

      const indices = await usableCollateralIndices(context, 2);
      expect(indices.length).to.equal(2);

      const baseToken = await comet.baseToken();
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      const borrowAmount = 2n * baseBorrowMin;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);

      // 1. Supply two collaterals sized from their own live borrow factors. Each contributes roughly
      //    the same borrow capacity, so the initial borrow is valid while both assets matter to the loop:
      //      perAssetBorrowCapacity = borrowValue
      //      collateralValue        = perAssetBorrowCapacity / BCF
      for (const index of indices) {
        const info = await comet.getAssetInfo(index);
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const borrowCF = info.borrowCollateralFactor.toBigInt();
        const collateralValue = (borrowValue * factorScale) / borrowCF;
        const amount = (collateralValue * info.scale.toBigInt()) / price + 1n;
        const asset = context.getAssetByAddress(info.asset);

        await context.sourceTokens(amount, asset, albert);
        await asset.approve(albert, comet.address);
        await albert.safeSupplyAsset({ asset: info.asset, amount });
      }

      await context.sourceTokens(2n * borrowAmount, context.getAssetByAddress(baseToken), comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 2. Skip time until the debt is 10% above the combined LF-weighted collateral value. At that
      //    point the first full seizure cannot close the debt, and neither can the second:
      //      totalCollateralAfterLF = sum(collateralValue_i * LF_i)
      //      targetDebt             = totalCollateralAfterLF * 1.10
      let totalCollateralAfterLF = 0n;
      const collateralStatesBeforeInterest = await makeCollateralStates(comet, context, albert.address, indices);
      for (const collateral of collateralStatesBeforeInterest) {
        totalCollateralAfterLF += mulFactor(
          mulPrice(collateral.collateralBalance, collateral.price, collateral.scale),
          collateral.liquidationFactor.toBigInt()
        );
      }
      const targetDebtValue = (totalCollateralAfterLF * 110n) / 100n;
      const targetDebt = (targetDebtValue * baseScale) / basePrice;

      const debt0 = (await comet.borrowBalanceOf(albert.address)).toBigInt();
      const borrowRate = (await comet.getBorrowRate(await comet.getUtilization())).toBigInt();
      const secondsToBadDebt = ((targetDebt - debt0) * factorScale) / (debt0 * borrowRate);

      await world.increaseTime(Number(secondsToBadDebt));
      await comet.accrueAccount(albert.address);

      // 3. Capture state and run the sanity checks that define the multi-collateral bad-debt case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStates = await makeCollateralStates(comet, context, albert.address, indices);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);

      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.greaterThan(baseBorrowMin);

      let totalCollateralValueAfterLFNow = 0n;
      for (const collateral of collateralStates) {
        totalCollateralValueAfterLFNow += mulFactor(
          mulPrice(collateral.collateralBalance, collateral.price, collateral.scale),
          collateral.liquidationFactor.toBigInt()
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
      for (const collateral of collateralStates) {
        collateral.seizeAmount = collateral.collateralBalance;
      }

      // 6. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect((await comet.userBasic(albert.address)).principal).to.equal(0);
      expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      let expectedAssetsIn = cometStateBefore.user.assetsIn;
      let expectedReserved = cometStateBefore.user._reserved;
      for (const collateral of collateralStates) {
        // All collateral is seized and both storage bitfields clear the corresponding asset bit.
        expect(await comet.collateralBalanceOf(albert.address, collateral.asset)).to.equal(0);
        expect((await comet.userCollateral(albert.address, collateral.asset)).balance).to.equal(0);
        if (collateral.offset < 16) {
          expectedAssetsIn = expectedAssetsIn & ~(1 << collateral.offset);
        } else {
          expectedReserved = expectedReserved & ~(1 << (collateral.offset - 16));
        }

        // Comet collateral accounting: supplied total drops by the full seized amount, reserves rise by
        // it, and the collateral ERC20 balance is untouched on the absorb path.
        expect((await comet.totalsCollateral(collateral.asset)).totalSupplyAsset)
          .to.equal(collateral.totalsCollateral - collateral.seizeAmount);
        expect(await comet.getCollateralReserves(collateral.asset))
          .to.equal(collateral.collateralReserves + collateral.seizeAmount);
        expect(await context.getAssetByAddress(collateral.asset).balanceOf(comet.address))
          .to.equal(collateral.cometErc20Balance);
      }

      const userBasicAfter = await comet.userBasic(albert.address);
      expect(userBasicAfter.assetsIn).to.equal(expectedAssetsIn);
      expect(userBasicAfter._reserved).to.equal(expectedReserved);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(totalsAfter.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Base ERC20 balance is untouched, while base reserves absorb the full bad-debt write-off.
      expect(await context.getAssetByAddress(baseToken).balanceOf(comet.address)).to.equal(cometStateBefore.cometBaseErc20Balance);
      expect(await comet.getReserves()).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      console.log('!!!!!!');
    }
  );

  /**
   * All collaterals: full seizure of every usable market collateral.
   *
   * Proves the bad-debt write-off scales across the whole collateral basket: the loop drains every
   * asset, the full debt is closed, and base reserves absorb the basket-wide shortfall.
   */
  // TODO: we can check this scenario only on real market as development has only 2
  scenario(
    `Comet#absorb > bad debt: all usable collaterals fully seized, shortfall written off [${tag}]`,
    {
      filter: async (ctx) =>
        (await hasModule(ctx)) &&
        (await usesAssetList(ctx)) &&
        (await usableCollateralIndices(ctx)).length > 3, // if collaterals amount < 3, then we end up, as for 2 or 1 collaterals we already have the test cases
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;
      const module = await configureModule(context, world, entry, partial, betty.address);

      const indices = await usableCollateralIndices(context);
      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();

      // 1. Supply the full usable collateral basket with equal USD value per asset. The basket is
      //    sized from the intended borrow limit, then split evenly across every usable collateral:
      //      targetBorrowValue      = 200 * baseBorrowMin, in price scale
      //      targetBorrowLimitValue = targetBorrowValue / 0.99
      //      collateralValue_i      = targetBorrowLimitValue / numCollaterals
      const targetBorrowAmount = 200n * baseBorrowMin;
      const targetBorrowValue = mulPrice(targetBorrowAmount, basePrice, baseScale);
      const targetBorrowLimitValue = (targetBorrowValue * 100n) / 99n;
      const collateralValue = targetBorrowLimitValue / BigInt(indices.length);

      for (const index of indices) {
        const info = await comet.getAssetInfo(index);
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const collateralAmount = (collateralValue * info.scale.toBigInt()) / price + 1n;
        const asset = context.getAssetByAddress(info.asset);

        await context.sourceTokens(collateralAmount, asset, albert);
        await asset.approve(albert, comet.address);
        await albert.safeSupplyAsset({ asset: info.asset, amount: collateralAmount });
      }

      const collateralStatesBeforeBorrow = await makeCollateralStates(comet, context, albert.address, indices);
      let borrowLimitValue = 0n;
      for (const collateral of collateralStatesBeforeBorrow) {
        borrowLimitValue += mulFactor(
          mulPrice(collateral.collateralBalance, collateral.price, collateral.scale),
          collateral.borrowCollateralFactor.toBigInt()
        );
      }

      // 2. A third party supplies extra base liquidity, then the borrower takes just under the full
      //    initial borrow limit. The extra supply keeps utilization inside a normal supported band.
      const borrowAmount = ((borrowLimitValue * 99n) / 100n) * baseScale / basePrice;
      await context.sourceTokens(4n * borrowAmount, baseAsset, betty);
      await baseAsset.approve(betty, comet.address);
      await betty.safeSupplyAsset({ asset: baseToken, amount: 4n * borrowAmount });
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 3. Skip time until the debt is 10% above the whole basket's LF-weighted value:
      //      totalCollateralAfterLF = sum(collateralValue_i * LF_i)
      //      targetDebt             = totalCollateralAfterLF * 1.10
      let totalCollateralAfterLF = 0n;
      for (const collateral of collateralStatesBeforeBorrow) {
        totalCollateralAfterLF += mulFactor(
          mulPrice(collateral.collateralBalance, collateral.price, collateral.scale),
          collateral.liquidationFactor.toBigInt()
        );
      }
      const targetDebtValue = (totalCollateralAfterLF * 110n) / 100n;
      const targetDebt = (targetDebtValue * baseScale) / basePrice;

      const usersDebt = (await comet.borrowBalanceOf(albert.address)).toBigInt();
      const borrowRate = (await comet.getBorrowRate(await comet.getUtilization())).toBigInt();
      const secondsToBadDebt = ((targetDebt - usersDebt) * factorScale) / (usersDebt * borrowRate);

      await world.increaseTime(Number(secondsToBadDebt));
      await comet.accrueAccount(albert.address);

      // 4. Capture state and run the sanity checks that define the full-basket bad-debt case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const collateralStates = await makeCollateralStates(comet, context, albert.address, indices);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);

      // Sanity checks
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.greaterThan(baseBorrowMin);
      let totalCollateralValueAfterLFNow = 0n;
      for (const collateral of collateralStates) {
        totalCollateralValueAfterLFNow += mulFactor(
          mulPrice(collateral.collateralBalance, collateral.price, collateral.scale),
          collateral.liquidationFactor.toBigInt()
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
      for (const collateral of collateralStates) {
        collateral.seizeAmount = collateral.collateralBalance;
        collateral.seizedValue = mulPrice(collateral.seizeAmount, collateral.price, collateral.scale);
      }

      // 7. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect((await comet.userBasic(albert.address)).principal).to.equal(0);
      expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      for (const collateral of collateralStates) {
        // Every collateral is fully seized, totals drop by the seized amount, reserves rise by it, and
        // ERC20 balances are untouched on the absorb path.
        expect(await comet.collateralBalanceOf(albert.address, collateral.asset)).to.equal(0);
        expect((await comet.userCollateral(albert.address, collateral.asset)).balance).to.equal(0);
        expect((await comet.totalsCollateral(collateral.asset)).totalSupplyAsset)
          .to.equal(collateral.totalsCollateral - collateral.seizeAmount);
        expect(await comet.getCollateralReserves(collateral.asset))
          .to.equal(collateral.collateralReserves + collateral.seizeAmount);
        expect(await context.getAssetByAddress(collateral.asset).balanceOf(comet.address))
          .to.equal(collateral.cometErc20Balance);
      }

      const userBasicAfter = await comet.userBasic(albert.address);
      expect(userBasicAfter.assetsIn).to.equal(0);
      expect(userBasicAfter._reserved).to.equal(0);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(totalsAfter.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Base ERC20 balance is untouched, while base reserves absorb the full basket-wide write-off.
      expect(await baseAsset.balanceOf(comet.address)).to.equal(cometStateBefore.cometBaseErc20Balance);
      expect(await comet.getReserves()).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      console.log('!!!!!!');
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
      filter: async (ctx) => {
        return !(await hasModule(ctx)) ||
          !(await usesAssetList(ctx)) ||
          !(await isValidAssetIndex(ctx, collateralIndex)) ||
          !(await isAssetDelisted(ctx, collateralIndex)) ||
          !(await zeroBaseBorrowMin(ctx));
      },
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();

      const info = await comet.getAssetInfo(collateralIndex);
      const originalPrice = (await comet.getPrice(info.priceFeed)).toBigInt();
      const borrowCF = info.borrowCollateralFactor.toBigInt();
      const lf = info.liquidationFactor.toBigInt();
      const collateralAsset = context.getAssetByAddress(info.asset);

      // 1. Supply enough collateral to support a borrow above the normal minimum:
      //      borrowAmount     = 1.2 * baseBorrowMin
      //      collateralValue  = borrowValue / BCF, with a 10% rounding buffer
      const borrowAmount = (12n * baseBorrowMin) / 10n;
      const repayAmount = (4n * baseBorrowMin) / 10n;
      const remainingDebt = borrowAmount - repayAmount;
      const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
      const collateralValue = ((borrowValue * factorScale) / borrowCF * 110n) / 100n;
      const collateralAmount = (collateralValue * info.scale.toBigInt()) / originalPrice + 1n;
    
      // Supply collateral
      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: info.asset, amount: collateralAmount });

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
      const targetCollateralValue = ((remainingDebtValue * 80n) / 100n * factorScale) / lf;
      const droppedPrice = (targetCollateralValue * info.scale.toBigInt()) / collateralAmount;
      await context.changePriceFeeds({ [info.asset]: Number(droppedPrice) / 1e8 });
      const module = await configureModule(context, world, entry, partial, betty.address);

      await comet.accrueAccount(albert.address);

      // 4. Capture state and run the sanity checks that define the sub-min bad-debt case.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralState] = await makeCollateralStates(comet, context, albert.address, [collateralIndex]);

      // Sanity checks before absorb
      expect(await comet.isLiquidatable(albert.address)).to.be.true;
      expect(-cometStateBefore.userBalance).to.be.lessThan(baseBorrowMin);

      const collateralValueAfterLF = mulFactor(
        mulPrice(collateralState.collateralBalance, collateralState.price, collateralState.scale),
        collateralState.liquidationFactor.toBigInt()
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

      // 7. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect((await comet.userBasic(albert.address)).principal).to.equal(0);
      expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // All collateral is seized and the user's asset bit is cleared.
      expect(await comet.collateralBalanceOf(albert.address, collateralState.asset)).to.equal(0);
      expect((await comet.userCollateral(albert.address, collateralState.asset)).balance).to.equal(0);
      const userBasicAfter = await comet.userBasic(albert.address);
      expect(userBasicAfter.assetsIn).to.equal(0);
      expect(userBasicAfter._reserved).to.equal(0);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(totalsAfter.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: supplied total drops by the full seized amount, reserves rise by it,
      // and collateral + base ERC20 balances are untouched on the absorb path.
      expect((await comet.totalsCollateral(collateralState.asset)).totalSupplyAsset)
        .to.equal(collateralState.totalsCollateral - seizedAmount);
      expect(await comet.getCollateralReserves(collateralState.asset))
        .to.equal(collateralState.collateralReserves + seizedAmount);
      expect(await collateralAsset.balanceOf(comet.address)).to.equal(collateralState.cometErc20Balance);
      expect(await baseAsset.balanceOf(comet.address)).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the full small debt.
      expect(await comet.getReserves()).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);

      console.log('!!!!!!');
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
      filter: async (ctx) => {
        return (await hasModule(ctx)) &&
          (await usesAssetList(ctx)) &&
          (await isValidAssetIndex(ctx, collateralIndex)) &&
          !(await isAssetDelisted(ctx, collateralIndex)) &&
          !(await zeroBaseBorrowMin(ctx));
      },
    },
    async ({ comet, actors }, context, world) => {
      const { albert, betty } = actors;

      const baseToken = await comet.baseToken();
      const baseAsset = context.getAssetByAddress(baseToken);
      const baseScale = (await comet.baseScale()).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
      await context.zeroBorrowRates();

      const info = await comet.getAssetInfo(collateralIndex);
      const collateralAsset = context.getAssetByAddress(info.asset);
      const collateralScale = info.scale.toBigInt();
      const lf = info.liquidationFactor.toBigInt();

      const originalPrice = (await comet.getPrice(info.priceFeed)).toBigInt();

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
      const targetValue = (minDebtValue * factorScale + lf - 1n) / lf;

      let collateralAmount = (4n * minDebtValue * collateralScale) / originalPrice;
      let droppedPrice = (targetValue * collateralScale + collateralAmount - 1n) / collateralAmount;
      while (mulFactor(mulPrice(collateralAmount, droppedPrice, collateralScale), lf) !== minDebtValue) {
        collateralAmount++;
        droppedPrice = (targetValue * collateralScale + collateralAmount - 1n) / collateralAmount;
      }

      // Supply collateral
      await context.sourceTokens(collateralAmount, collateralAsset, albert);
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: info.asset, amount: collateralAmount });

      // Borrow
      await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      // Sanity checks before dropping price
      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // 2. Apply the price drop that makes the supplied collateral exactly cover the debt after LF.
      await context.changePriceFeeds({ [info.asset]: Number(droppedPrice) / 1e8 });
      const module = await configureModule(context, world, entry, partial, betty.address);

      // 3. Capture state and run the sanity checks that define the equality boundary.
      const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
      const [collateralState] = await makeCollateralStates(comet, context, albert.address, [collateralIndex]);
      const debtValueBefore = mulPrice(-cometStateBefore.userBalance, basePrice, baseScale);
      const collateralValueAfterLF = mulFactor(
        mulPrice(collateralState.collateralBalance, collateralState.price, collateralState.scale),
        collateralState.liquidationFactor.toBigInt()
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

      // 6. Post-absorb checks.

      // Debt fully cleared: principal, borrow balance and simple base balance are all zero.
      expect((await comet.userBasic(albert.address)).principal).to.equal(0);
      expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
      expect(await comet.balanceOf(albert.address)).to.equal(0);

      // All collateral is seized and the user's asset bit is cleared.
      expect(await comet.collateralBalanceOf(albert.address, collateralState.asset)).to.equal(0);
      expect((await comet.userCollateral(albert.address, collateralState.asset)).balance).to.equal(0);
      const userBasicAfter = await comet.userBasic(albert.address);
      expect(userBasicAfter.assetsIn).to.equal(0);
      expect(userBasicAfter._reserved).to.equal(0);

      // Comet borrow state: borrow base reduced by the absorbed principal; supply base unchanged.
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
      expect(totalsAfter.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);

      // Comet collateral accounting: supplied total drops by the full seized amount, reserves rise by it,
      // and collateral + base ERC20 balances are untouched on the absorb path.
      expect((await comet.totalsCollateral(collateralState.asset)).totalSupplyAsset)
        .to.equal(collateralState.totalsCollateral - seizedAmount);
      expect(await comet.getCollateralReserves(collateralState.asset))
        .to.equal(collateralState.collateralReserves + seizedAmount);
      expect(await collateralAsset.balanceOf(comet.address)).to.equal(collateralState.cometErc20Balance);
      expect(await baseAsset.balanceOf(comet.address)).to.equal(cometStateBefore.cometBaseErc20Balance);

      // Base reserves fall by the full debt value.
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
