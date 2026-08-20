import { CometHarnessInterfaceExtendedAssetList as CometWithExtendedAssetList, FaucetToken } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers, expect, exp, makeConfigurator } from '../helpers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';

/**
 * `isBorrowCollateralized` and `isLiquidatable` used to value a collateral in two steps: the balance
 * was priced first and weighted by its factor second, each step truncating. Both truncations discard
 * value and both discard it the same way — down — so the protocol counted less collateral than the
 * account holds. The borrower paid for it twice: less borrowing power than their collateral supports,
 * and liquidation while that collateral still covers the debt.
 *
 * Valuing the balance in one division removes it. One collateral can lose at most a single value unit
 * to the old form — `1e-8` of a dollar, the resolution of the price feeds — because the two forms'
 * arguments differ by less than one, so their floors differ by zero or one. Two million random draws
 * over the parameters of this market never produced two. The first six contexts stand on that ceiling:
 * every collateral loses its unit, so a portfolio of twenty-four is short twenty-four.
 *
 * The last context drops the pinning and supplies ordinary balances instead — ten thousand dollars'
 * worth of each asset, to the token's full precision - to show what the same error costs without help.
 *
 * Two things decide whether an asset can lose anything at all. Its price must not divide its scale: a
 * six-decimal token quoted to the cent has an exact first division and is untouched by any of this.
 * And the balance must have a fractional tail; a round deposit of a whole number of tokens usually
 * divides exactly too. Balances that came out of a swap, an interest accrual or a transfer do not.
 *
 * The base token has 18 decimals so the difference is visible. On a 6-decimal base one unit of debt
 * moves the account's liquidity by a hundred value units, more than the whole error, and the borrower
 * would gain nothing they could actually draw.
 */
describe('collateralization rounding', function () {
  const BASE = 'USDS';
  const FACTOR_SCALE = exp(1, 18);
  const BORROW_CF = exp(0.8, 18);
  const LIQUIDATE_CF = exp(0.85, 18);

  const PRICE = [
    1234.56, 78.9, 0.4321, 3517.08, 12.7, 0.0913,
    64211.5, 1.0007, 5.5555, 918.42, 0.7777, 249.1357,
    33.3333, 0.0451, 7712.9481, 2.048, 111.11, 0.6234,
    4096.77, 19.99, 0.3141, 1580.25, 88.88, 0.0072,
  ];

  // Balances the old form loses a whole value unit of, one per asset. Found by walking `balance *
  // price` modulo the scale until both remainders line up, then pinned here rather than searched for
  // at run time. The first test in every context checks they still do what they were picked for.
  const BORROW_BALANCE = [
    3000000000011000033n, 301000003n, 6000009n,
    3000000000004000012n, 307000021n, 8000015n,
    3000000000001000003n, 422000366n, 4000003n,
    3000000000014000042n, 303000009n, 5000006n,
    3000000000375001125n, 310000030n, 5000006n,
    3000000006104018312n, 302000006n, 16000039n,
    3000000000004000012n, 334000102n, 6000009n,
    3000000000008000024n, 301000003n, 6000009n,
  ];
  const LIQUIDATE_BALANCE = [
    3000000000010000030n, 301000003n, 4000003n,
    3000000000004000012n, 303000009n, 4000003n,
    3000000000007000021n, 329000087n, 26000069n,
    3000000000013000039n, 312000036n, 5000006n,
    3000000000353001059n, 309000027n, 5000006n,
    3000000005745017235n, 403000309n, 24000063n,
    3000000000003000009n, 334000102n, 4000003n,
    3000000000008000024n, 314000042n, 7000012n,
  ];

  // Ten thousand dollars of each asset, to the token's full precision: what a balance looks like when
  // it came from a swap rather than from someone typing a round number.
  const ORDINARY_DEPOSIT = [
    8100051840331778123n, 12674271229n, 23142791020n,
    2843267710714570041n, 78740157480n, 109529025191n,
    155735343357498267n, 999300489657n, 1800018000n,
    10888264628383528233n, 1285842870001n, 40138767n,
    300000300000300000300n, 22172949002217n, 1296521n,
    4882812500000000000000n, 9000090000n, 16041065126n,
    2440947380497318619n, 50025012506n, 31836994587n,
    6328112640404999208n, 11251125112n, 1388888888888n,
  ];

  let comet: CometWithExtendedAssetList;
  let tokens: { [symbol: string]: FaucetToken };
  let alice: SignerWithAddress;
  let baseSupplier: SignerWithAddress;
  let baseScale: bigint;
  let basePrice: bigint;
  let snapshot: SnapshotRestorer;

  before(async () => {
    // A spread of decimals and prices across the table, so the two valuations part company for
    // different reasons rather than for one arithmetic accident repeated 24 times.
    const assets = { [BASE]: { decimals: 18, initial: 1e9, initialPrice: 1 } };
    for (let i = 0; i < 24; i++) {
      assets[`C${i}`] = {
        decimals: [18, 8, 6][i % 3],
        initial: 1e9,
        initialPrice: PRICE[i],
        borrowCF: BORROW_CF,
        liquidateCF: LIQUIDATE_CF,
        supplyCap: exp(1e9, 18),
      };
    }

    // Nothing here is about interest, and an accruing index would move the debt under the test.
    const protocol = await makeConfigurator({
      base: BASE,
      assets,
      supplyInterestRateBase: 0,
      supplyInterestRateSlopeLow: 0,
      supplyInterestRateSlopeHigh: 0,
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
      borrowInterestRateSlopeHigh: 0,
      baseTrackingBorrowSpeed: 0,
    });

    // The extended asset list Comet: the one this branch's rounding change lives in.
    comet = protocol.cometWithExtendedAssetList;
    tokens = protocol.tokens as { [symbol: string]: FaucetToken };
    [alice, baseSupplier] = protocol.users;

    baseScale = (await comet.baseScale()).toBigInt();
    basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();

    await tokens[BASE].allocateTo(baseSupplier.address, exp(1e8, 18));
    await tokens[BASE].connect(baseSupplier).approve(comet.address, ethers.constants.MaxUint256);
    await comet.connect(baseSupplier).supply(tokens[BASE].address, exp(1e8, 18));

    snapshot = await takeSnapshot();
  });

  context('borrow capacity: one collateral', function () {
    let underOneDivision = 0n;
    let underTwoSteps = 0n;
    let limit: bigint;
    let limitUnderTwoSteps: bigint;

    before(async () => {
      await snapshot.restore();
      underOneDivision = 0n;
      underTwoSteps = 0n;

      for (let i = 0; i < 1; i++) {
        const token = tokens[`C${i}`];
        const info = await comet.getAssetInfoByAddress(token.address);
        const scale = info.scale.toBigInt();
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const balance = BORROW_BALANCE[i];

        await token.allocateTo(alice.address, balance);
        await token.connect(alice).approve(comet.address, balance);
        await comet.connect(alice).supply(token.address, balance);

        underOneDivision += (balance * price * BORROW_CF) / (scale * FACTOR_SCALE);
        underTwoSteps += (((balance * price) / scale) * BORROW_CF) / FACTOR_SCALE;
      }

      // The contract compares floor(debt * basePrice / baseScale) against the liquidity, so the last
      // debt that fits is one base unit short of the first that does not.
      limit = ((underOneDivision + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;
      limitUnderTwoSteps = ((underTwoSteps + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;

      console.log(`      collateral value, one division   ${underOneDivision}`);
      console.log(`      collateral value, two steps      ${underTwoSteps}`);
      console.log(`      lost to the old form             ${underOneDivision - underTwoSteps} value units`);
      console.log(`      borrowing power withheld         ${limit - limitUnderTwoSteps} base units`);
    });

    it('the old valuation loses a unit of value on the collateral', async () => {
      expect(underOneDivision - underTwoSteps).to.equal(1n);
    });

    it('the account borrows up to the limit its collateral supports', async () => {
      await comet.connect(alice).withdraw(tokens[BASE].address, limit);

      expect(await comet.borrowBalanceOf(alice.address)).to.equal(limit);
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('one base unit beyond that limit is refused', async () => {
      await expect(
        comet.connect(alice).withdraw(tokens[BASE].address, limit + 1n)
      ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
    });

    it('the old valuation would have stopped the borrow short', async () => {
      expect(limit - limitUnderTwoSteps).to.equal(1n * exp(1, 10));
    });
  });

  context('borrow capacity: five collaterals', function () {
    let underOneDivision = 0n;
    let underTwoSteps = 0n;
    let limit: bigint;
    let limitUnderTwoSteps: bigint;

    before(async () => {
      await snapshot.restore();
      underOneDivision = 0n;
      underTwoSteps = 0n;

      for (let i = 0; i < 5; i++) {
        const token = tokens[`C${i}`];
        const info = await comet.getAssetInfoByAddress(token.address);
        const scale = info.scale.toBigInt();
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const balance = BORROW_BALANCE[i];

        await token.allocateTo(alice.address, balance);
        await token.connect(alice).approve(comet.address, balance);
        await comet.connect(alice).supply(token.address, balance);

        underOneDivision += (balance * price * BORROW_CF) / (scale * FACTOR_SCALE);
        underTwoSteps += (((balance * price) / scale) * BORROW_CF) / FACTOR_SCALE;
      }

      // The contract compares floor(debt * basePrice / baseScale) against the liquidity, so the last
      // debt that fits is one base unit short of the first that does not.
      limit = ((underOneDivision + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;
      limitUnderTwoSteps = ((underTwoSteps + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;

      console.log(`      collateral value, one division   ${underOneDivision}`);
      console.log(`      collateral value, two steps      ${underTwoSteps}`);
      console.log(`      lost to the old form             ${underOneDivision - underTwoSteps} value units`);
      console.log(`      borrowing power withheld         ${limit - limitUnderTwoSteps} base units`);
    });

    it('the old valuation loses a unit of value on every collateral', async () => {
      expect(underOneDivision - underTwoSteps).to.equal(5n);
    });

    it('the account borrows up to the limit its collateral supports', async () => {
      await comet.connect(alice).withdraw(tokens[BASE].address, limit);

      expect(await comet.borrowBalanceOf(alice.address)).to.equal(limit);
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('one base unit beyond that limit is refused', async () => {
      await expect(
        comet.connect(alice).withdraw(tokens[BASE].address, limit + 1n)
      ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
    });

    it('the old valuation would have stopped the borrow short', async () => {
      expect(limit - limitUnderTwoSteps).to.equal(5n * exp(1, 10));
    });
  });

  context('borrow capacity: twenty-four collaterals', function () {
    let underOneDivision = 0n;
    let underTwoSteps = 0n;
    let limit: bigint;
    let limitUnderTwoSteps: bigint;

    before(async () => {
      await snapshot.restore();
      underOneDivision = 0n;
      underTwoSteps = 0n;

      for (let i = 0; i < 24; i++) {
        const token = tokens[`C${i}`];
        const info = await comet.getAssetInfoByAddress(token.address);
        const scale = info.scale.toBigInt();
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const balance = BORROW_BALANCE[i];

        await token.allocateTo(alice.address, balance);
        await token.connect(alice).approve(comet.address, balance);
        await comet.connect(alice).supply(token.address, balance);

        underOneDivision += (balance * price * BORROW_CF) / (scale * FACTOR_SCALE);
        underTwoSteps += (((balance * price) / scale) * BORROW_CF) / FACTOR_SCALE;
      }

      // The contract compares floor(debt * basePrice / baseScale) against the liquidity, so the last
      // debt that fits is one base unit short of the first that does not.
      limit = ((underOneDivision + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;
      limitUnderTwoSteps = ((underTwoSteps + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;

      console.log(`      collateral value, one division   ${underOneDivision}`);
      console.log(`      collateral value, two steps      ${underTwoSteps}`);
      console.log(`      lost to the old form             ${underOneDivision - underTwoSteps} value units`);
      console.log(`      borrowing power withheld         ${limit - limitUnderTwoSteps} base units`);
    });

    it('the old valuation loses a unit of value on every collateral', async () => {
      expect(underOneDivision - underTwoSteps).to.equal(24n);
    });

    it('the account borrows up to the limit its collateral supports', async () => {
      await comet.connect(alice).withdraw(tokens[BASE].address, limit);

      expect(await comet.borrowBalanceOf(alice.address)).to.equal(limit);
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('one base unit beyond that limit is refused', async () => {
      await expect(
        comet.connect(alice).withdraw(tokens[BASE].address, limit + 1n)
      ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
    });

    it('the old valuation would have stopped the borrow short', async () => {
      expect(limit - limitUnderTwoSteps).to.equal(24n * exp(1, 10));
    });
  });

  context('liquidation threshold: one collateral', function () {
    let underOneDivision = 0n;
    let underTwoSteps = 0n;
    let covered: bigint;
    let coveredUnderTwoSteps: bigint;

    before(async () => {
      await snapshot.restore();
      underOneDivision = 0n;
      underTwoSteps = 0n;

      for (let i = 0; i < 1; i++) {
        const token = tokens[`C${i}`];
        const info = await comet.getAssetInfoByAddress(token.address);
        const scale = info.scale.toBigInt();
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const balance = LIQUIDATE_BALANCE[i];

        await token.allocateTo(alice.address, balance);
        await token.connect(alice).approve(comet.address, balance);
        await comet.connect(alice).supply(token.address, balance);

        underOneDivision += (balance * price * LIQUIDATE_CF) / (scale * FACTOR_SCALE);
        underTwoSteps += (((balance * price) / scale) * LIQUIDATE_CF) / FACTOR_SCALE;
      }

      covered = ((underOneDivision + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;
      coveredUnderTwoSteps = ((underTwoSteps + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;

      // The debt is placed rather than borrowed: the borrow limit uses the borrow collateral factor,
      // which sits below the liquidate factor, so an account cannot borrow its way to this boundary.
      await comet.setBasePrincipal(alice.address, -covered);

      console.log(`      collateral value, one division   ${underOneDivision}`);
      console.log(`      collateral value, two steps      ${underTwoSteps}`);
      console.log(`      lost to the old form             ${underOneDivision - underTwoSteps} value units`);
      console.log(`      debt wrongly called under water  ${covered - coveredUnderTwoSteps} base units`);
    });

    it('the old valuation loses a unit of value on the collateral', async () => {
      expect(underOneDivision - underTwoSteps).to.equal(1n);
    });

    it('at a debt its collateral exactly covers, the account is not liquidatable', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(covered);
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('one base unit more of debt and it is', async () => {
      await comet.setBasePrincipal(alice.address, -(covered + 1n));

      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('the old valuation would have called it liquidatable earlier', async () => {
      expect(covered - coveredUnderTwoSteps).to.equal(1n * exp(1, 10));

      // The first debt the old form would have refused to call covered.
      await comet.setBasePrincipal(alice.address, -(coveredUnderTwoSteps + 1n));
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });
  });

  context('liquidation threshold: five collaterals', function () {
    let underOneDivision = 0n;
    let underTwoSteps = 0n;
    let covered: bigint;
    let coveredUnderTwoSteps: bigint;

    before(async () => {
      await snapshot.restore();
      underOneDivision = 0n;
      underTwoSteps = 0n;

      for (let i = 0; i < 5; i++) {
        const token = tokens[`C${i}`];
        const info = await comet.getAssetInfoByAddress(token.address);
        const scale = info.scale.toBigInt();
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const balance = LIQUIDATE_BALANCE[i];

        await token.allocateTo(alice.address, balance);
        await token.connect(alice).approve(comet.address, balance);
        await comet.connect(alice).supply(token.address, balance);

        underOneDivision += (balance * price * LIQUIDATE_CF) / (scale * FACTOR_SCALE);
        underTwoSteps += (((balance * price) / scale) * LIQUIDATE_CF) / FACTOR_SCALE;
      }

      covered = ((underOneDivision + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;
      coveredUnderTwoSteps = ((underTwoSteps + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;

      // The debt is placed rather than borrowed: the borrow limit uses the borrow collateral factor,
      // which sits below the liquidate factor, so an account cannot borrow its way to this boundary.
      await comet.setBasePrincipal(alice.address, -covered);

      console.log(`      collateral value, one division   ${underOneDivision}`);
      console.log(`      collateral value, two steps      ${underTwoSteps}`);
      console.log(`      lost to the old form             ${underOneDivision - underTwoSteps} value units`);
      console.log(`      debt wrongly called under water  ${covered - coveredUnderTwoSteps} base units`);
    });

    it('the old valuation loses a unit of value on every collateral', async () => {
      expect(underOneDivision - underTwoSteps).to.equal(5n);
    });

    it('at a debt its collateral exactly covers, the account is not liquidatable', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(covered);
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('one base unit more of debt and it is', async () => {
      await comet.setBasePrincipal(alice.address, -(covered + 1n));

      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('the old valuation would have called it liquidatable earlier', async () => {
      expect(covered - coveredUnderTwoSteps).to.equal(5n * exp(1, 10));

      // The first debt the old form would have refused to call covered.
      await comet.setBasePrincipal(alice.address, -(coveredUnderTwoSteps + 1n));
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });
  });

  context('liquidation threshold: twenty-four collaterals', function () {
    let underOneDivision = 0n;
    let underTwoSteps = 0n;
    let covered: bigint;
    let coveredUnderTwoSteps: bigint;

    before(async () => {
      await snapshot.restore();
      underOneDivision = 0n;
      underTwoSteps = 0n;

      for (let i = 0; i < 24; i++) {
        const token = tokens[`C${i}`];
        const info = await comet.getAssetInfoByAddress(token.address);
        const scale = info.scale.toBigInt();
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const balance = LIQUIDATE_BALANCE[i];

        await token.allocateTo(alice.address, balance);
        await token.connect(alice).approve(comet.address, balance);
        await comet.connect(alice).supply(token.address, balance);

        underOneDivision += (balance * price * LIQUIDATE_CF) / (scale * FACTOR_SCALE);
        underTwoSteps += (((balance * price) / scale) * LIQUIDATE_CF) / FACTOR_SCALE;
      }

      covered = ((underOneDivision + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;
      coveredUnderTwoSteps = ((underTwoSteps + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;

      // The debt is placed rather than borrowed: the borrow limit uses the borrow collateral factor,
      // which sits below the liquidate factor, so an account cannot borrow its way to this boundary.
      await comet.setBasePrincipal(alice.address, -covered);

      console.log(`      collateral value, one division   ${underOneDivision}`);
      console.log(`      collateral value, two steps      ${underTwoSteps}`);
      console.log(`      lost to the old form             ${underOneDivision - underTwoSteps} value units`);
      console.log(`      debt wrongly called under water  ${covered - coveredUnderTwoSteps} base units`);
    });

    it('the old valuation loses a unit of value on every collateral', async () => {
      expect(underOneDivision - underTwoSteps).to.equal(24n);
    });

    it('at a debt its collateral exactly covers, the account is not liquidatable', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(covered);
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('one base unit more of debt and it is', async () => {
      await comet.setBasePrincipal(alice.address, -(covered + 1n));

      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('the old valuation would have called it liquidatable earlier', async () => {
      expect(covered - coveredUnderTwoSteps).to.equal(24n * exp(1, 10));

      // The first debt the old form would have refused to call covered.
      await comet.setBasePrincipal(alice.address, -(coveredUnderTwoSteps + 1n));
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });
  });

  context('borrow capacity: ordinary balances, twenty-four collaterals', function () {
    let underOneDivision = 0n;
    let underTwoSteps = 0n;
    let limit: bigint;
    let limitUnderTwoSteps: bigint;

    before(async () => {
      await snapshot.restore();
      underOneDivision = 0n;
      underTwoSteps = 0n;
      let lostOn = 0;

      for (let i = 0; i < 24; i++) {
        const token = tokens[`C${i}`];
        const info = await comet.getAssetInfoByAddress(token.address);
        const scale = info.scale.toBigInt();
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const balance = ORDINARY_DEPOSIT[i];

        await token.allocateTo(alice.address, balance);
        await token.connect(alice).approve(comet.address, balance);
        await comet.connect(alice).supply(token.address, balance);

        underOneDivision += (balance * price * BORROW_CF) / (scale * FACTOR_SCALE);
        underTwoSteps += (((balance * price) / scale) * BORROW_CF) / FACTOR_SCALE;
        if ((balance * price * BORROW_CF) / (scale * FACTOR_SCALE) > (((balance * price) / scale) * BORROW_CF) / FACTOR_SCALE) lostOn++;
      }

      // The contract compares floor(debt * basePrice / baseScale) against the liquidity, so the last
      // debt that fits is one base unit short of the first that does not.
      limit = ((underOneDivision + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;
      limitUnderTwoSteps = ((underTwoSteps + 1n) * baseScale + basePrice - 1n) / basePrice - 1n;

      console.log(`      collateral value, one division   ${underOneDivision}`);
      console.log(`      collateral value, two steps      ${underTwoSteps}`);
      console.log(`      lost to the old form             ${underOneDivision - underTwoSteps} value units`);
      console.log(`      collaterals that lost a unit     ${lostOn} of 24`);
      console.log(`      borrowing power withheld         ${limit - limitUnderTwoSteps} base units`);
    });

    it('the old valuation loses value on the balances it happens to catch', async () => {
      expect(underOneDivision - underTwoSteps).to.equal(2n);
    });

    it('the account borrows up to the limit its collateral supports', async () => {
      await comet.connect(alice).withdraw(tokens[BASE].address, limit);

      expect(await comet.borrowBalanceOf(alice.address)).to.equal(limit);
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('one base unit beyond that limit is refused', async () => {
      await expect(
        comet.connect(alice).withdraw(tokens[BASE].address, limit + 1n)
      ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
    });

    it('the old valuation would have stopped the borrow short', async () => {
      expect(limit - limitUnderTwoSteps).to.equal(2n * exp(1, 10));
    });
  });
});
