import { CometHarnessInterfaceExtendedAssetList as CometWithExtendedAssetList, FaucetToken } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers, expect, exp, makeConfigurator } from '../helpers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';

/**
 * `absorbInternal` values each seized collateral the same way the collateralization checks used to:
 * the balance is priced first and weighted by the liquidation factor second, each step truncating
 * downwards. The sum of those values is what the borrower is credited with, so every truncated unit
 * is cashback the borrower does not receive and the reserves keep.
 *
 * One collateral can lose at most a single value unit - `1e-8` of a dollar - because the two forms'
 * arguments differ by less than one and so their floors differ by zero or one. A seizure of
 * twenty-four collaterals is therefore short at most twenty-four units. The balances below are pinned
 * to stand on that ceiling; the first test in every context checks they still do.
 *
 * The base token has 18 decimals and costs a dollar, so the conversion at the end of absorption is
 * an exact multiplication by `1e10` and every lost value unit shows up as exactly `1e10` base units
 * of missing cashback. On a 6-decimal base the same conversion divides by a hundred instead, and the
 * whole twenty-four-unit error disappears below one base unit - which is why this is measured here.
 *
 * The last context is the other half of the answer: when the position is deep enough under water the
 * new balance is clamped to zero, and the error changes nothing at all.
 */
describe('absorb rounding', function () {
  const BASE = 'USDS';
  const FACTOR_SCALE = exp(1, 18);
  const BORROW_CF = exp(0.8, 18);
  const LIQUIDATE_CF = exp(0.85, 18);
  const LIQUIDATION_FACTOR = exp(0.93, 18);

  const PRICE = [
    1234.56, 78.9, 0.4321, 3517.08, 12.7, 0.0913,
    64211.5, 1.0007, 5.5555, 918.42, 0.7777, 249.1357,
    33.3333, 0.0451, 7712.9481, 2.048, 111.11, 0.6234,
    4096.77, 19.99, 0.3141, 1580.25, 88.88, 0.0072,
  ];

  // Balances the two-step valuation loses a whole value unit of at the liquidation factor, one per
  // asset. Found by walking the balance until both remainders line up, then pinned here rather than
  // searched for at run time. Roughly three thousand dollars of each asset.
  const SEIZED_BALANCE = [
    2500000000008910059n, 3850000004n, 6942500002n,
    500000000003127590n, 23650000004n, 32858500007n,
    500000000000171307n, 299750000043n, 540500008n,
    3500000000011977090n, 385750000002n, 12500010n,
    90500000000330000334n, 6651850000026n, 500002n,
    1464500000005371093754n, 2750000004n, 4812500017n,
    500000000002685038n, 15050000002n, 9551500002n,
    1500000000006960925n, 3350000002n, 416666500002n,
  ];

  let comet: CometWithExtendedAssetList;
  let tokens: { [symbol: string]: FaucetToken };
  let alice: SignerWithAddress;
  let absorber: SignerWithAddress;
  let baseSupplier: SignerWithAddress;
  let baseScale: bigint;
  let basePrice: bigint;
  let snapshot: SnapshotRestorer;

  before(async () => {
    const assets = { [BASE]: { decimals: 18, initial: 1e9, initialPrice: 1 } };
    for (let i = 0; i < 24; i++) {
      assets[`C${i}`] = {
        decimals: [18, 8, 6][i % 3],
        initial: 1e9,
        initialPrice: PRICE[i],
        borrowCF: BORROW_CF,
        liquidateCF: LIQUIDATE_CF,
        liquidationFactor: LIQUIDATION_FACTOR,
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
      baseTrackingSupplySpeed: 0,
    });

    comet = protocol.cometWithExtendedAssetList;
    tokens = protocol.tokens as { [symbol: string]: FaucetToken };
    [alice, absorber, baseSupplier] = protocol.users;

    baseScale = (await comet.baseScale()).toBigInt();
    basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();

    await tokens[BASE].allocateTo(baseSupplier.address, exp(1e8, 18));
    await tokens[BASE].connect(baseSupplier).approve(comet.address, ethers.constants.MaxUint256);
    await comet.connect(baseSupplier).supply(tokens[BASE].address, exp(1e8, 18));

    snapshot = await takeSnapshot();
  });

  context('cashback: one collateral', function () {
    let seizedOneDivision = 0n;
    let seizedTwoSteps = 0n;
    let debt: bigint;
    let cashbackOwed: bigint;
    let cashbackUnderTwoSteps: bigint;

    before(async () => {
      await snapshot.restore();
      seizedOneDivision = 0n;
      seizedTwoSteps = 0n;
      let threshold = 0n;

      for (let i = 0; i < 1; i++) {
        const token = tokens[`C${i}`];
        const info = await comet.getAssetInfoByAddress(token.address);
        const scale = info.scale.toBigInt();
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const balance = SEIZED_BALANCE[i];

        await token.allocateTo(alice.address, balance);
        await token.connect(alice).approve(comet.address, balance);
        await comet.connect(alice).supply(token.address, balance);

        seizedOneDivision += (balance * price * LIQUIDATION_FACTOR) / (scale * FACTOR_SCALE);
        seizedTwoSteps += (((balance * price) / scale) * LIQUIDATION_FACTOR) / FACTOR_SCALE;
        threshold += (balance * price * LIQUIDATE_CF) / (scale * FACTOR_SCALE);
      }

      // The smallest debt the account can be absorbed at: one value unit past what its collateral
      // covers at the liquidation collateral factor. Absorption then seizes everything and pays the
      // difference between that debt and the collateral's value at the liquidation factor.
      debt = (threshold + 1n) * baseScale / basePrice;
      cashbackOwed = seizedOneDivision * baseScale / basePrice - debt;
      cashbackUnderTwoSteps = seizedTwoSteps * baseScale / basePrice - debt;

      const totals = await comet.totalsBasic();
      await comet.setTotalsBasic({ ...totals, totalBorrowBase: totals.totalBorrowBase.add(debt) });
      await comet.setBasePrincipal(alice.address, -debt);

      await comet.connect(absorber).absorb(absorber.address, [alice.address]);

      console.log(`      seized value, one division       ${seizedOneDivision}`);
      console.log(`      seized value, two steps          ${seizedTwoSteps}`);
      console.log(`      lost to the old form             ${seizedOneDivision - seizedTwoSteps} value units`);
      console.log(`      debt absorbed                    ${debt} base units`);
      console.log(`      cashback owed                    ${cashbackOwed} base units`);
      console.log(`      cashback paid by the old form    ${cashbackUnderTwoSteps} base units`);
      console.log(`      withheld from the borrower       ${cashbackOwed - cashbackUnderTwoSteps} base units`);
      console.log(`      cashback actually received       ${await comet.balanceOf(alice.address)} base units`);
    });

    it('the old valuation loses a unit of value on the collateral', async () => {
      expect(seizedOneDivision - seizedTwoSteps).to.equal(1n);
    });

    it('the collateral is seized and the debt is gone', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['C0'].address)).to.equal(0);
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
    });

    it('the borrower is paid what the seized collateral is worth', async () => {
      expect(await comet.balanceOf(alice.address)).to.equal(cashbackOwed);
    });

    it('the old valuation would have withheld a value unit of cashback', async () => {
      expect(cashbackOwed - cashbackUnderTwoSteps).to.equal(1n * exp(1, 10));
    });
  });

  context('cashback: five collaterals', function () {
    let seizedOneDivision = 0n;
    let seizedTwoSteps = 0n;
    let debt: bigint;
    let cashbackOwed: bigint;
    let cashbackUnderTwoSteps: bigint;

    before(async () => {
      await snapshot.restore();
      seizedOneDivision = 0n;
      seizedTwoSteps = 0n;
      let threshold = 0n;

      for (let i = 0; i < 5; i++) {
        const token = tokens[`C${i}`];
        const info = await comet.getAssetInfoByAddress(token.address);
        const scale = info.scale.toBigInt();
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const balance = SEIZED_BALANCE[i];

        await token.allocateTo(alice.address, balance);
        await token.connect(alice).approve(comet.address, balance);
        await comet.connect(alice).supply(token.address, balance);

        seizedOneDivision += (balance * price * LIQUIDATION_FACTOR) / (scale * FACTOR_SCALE);
        seizedTwoSteps += (((balance * price) / scale) * LIQUIDATION_FACTOR) / FACTOR_SCALE;
        threshold += (balance * price * LIQUIDATE_CF) / (scale * FACTOR_SCALE);
      }

      debt = (threshold + 1n) * baseScale / basePrice;
      cashbackOwed = seizedOneDivision * baseScale / basePrice - debt;
      cashbackUnderTwoSteps = seizedTwoSteps * baseScale / basePrice - debt;

      const totals = await comet.totalsBasic();
      await comet.setTotalsBasic({ ...totals, totalBorrowBase: totals.totalBorrowBase.add(debt) });
      await comet.setBasePrincipal(alice.address, -debt);

      await comet.connect(absorber).absorb(absorber.address, [alice.address]);

      console.log(`      seized value, one division       ${seizedOneDivision}`);
      console.log(`      seized value, two steps          ${seizedTwoSteps}`);
      console.log(`      lost to the old form             ${seizedOneDivision - seizedTwoSteps} value units`);
      console.log(`      debt absorbed                    ${debt} base units`);
      console.log(`      cashback owed                    ${cashbackOwed} base units`);
      console.log(`      cashback paid by the old form    ${cashbackUnderTwoSteps} base units`);
      console.log(`      withheld from the borrower       ${cashbackOwed - cashbackUnderTwoSteps} base units`);
      console.log(`      cashback actually received       ${await comet.balanceOf(alice.address)} base units`);
    });

    it('the old valuation loses a unit of value on every collateral', async () => {
      expect(seizedOneDivision - seizedTwoSteps).to.equal(5n);
    });

    it('the collateral is seized and the debt is gone', async () => {
      for (let i = 0; i < 5; i++) {
        expect(await comet.collateralBalanceOf(alice.address, tokens[`C${i}`].address)).to.equal(0);
      }
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
    });

    it('the borrower is paid what the seized collateral is worth', async () => {
      expect(await comet.balanceOf(alice.address)).to.equal(cashbackOwed);
    });

    it('the old valuation would have withheld five value units of cashback', async () => {
      expect(cashbackOwed - cashbackUnderTwoSteps).to.equal(5n * exp(1, 10));
    });
  });

  context('cashback: twenty-four collaterals', function () {
    let seizedOneDivision = 0n;
    let seizedTwoSteps = 0n;
    let debt: bigint;
    let cashbackOwed: bigint;
    let cashbackUnderTwoSteps: bigint;

    before(async () => {
      await snapshot.restore();
      seizedOneDivision = 0n;
      seizedTwoSteps = 0n;
      let threshold = 0n;

      for (let i = 0; i < 24; i++) {
        const token = tokens[`C${i}`];
        const info = await comet.getAssetInfoByAddress(token.address);
        const scale = info.scale.toBigInt();
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const balance = SEIZED_BALANCE[i];

        await token.allocateTo(alice.address, balance);
        await token.connect(alice).approve(comet.address, balance);
        await comet.connect(alice).supply(token.address, balance);

        seizedOneDivision += (balance * price * LIQUIDATION_FACTOR) / (scale * FACTOR_SCALE);
        seizedTwoSteps += (((balance * price) / scale) * LIQUIDATION_FACTOR) / FACTOR_SCALE;
        threshold += (balance * price * LIQUIDATE_CF) / (scale * FACTOR_SCALE);
      }

      debt = (threshold + 1n) * baseScale / basePrice;
      cashbackOwed = seizedOneDivision * baseScale / basePrice - debt;
      cashbackUnderTwoSteps = seizedTwoSteps * baseScale / basePrice - debt;

      const totals = await comet.totalsBasic();
      await comet.setTotalsBasic({ ...totals, totalBorrowBase: totals.totalBorrowBase.add(debt) });
      await comet.setBasePrincipal(alice.address, -debt);

      await comet.connect(absorber).absorb(absorber.address, [alice.address]);

      console.log(`      seized value, one division       ${seizedOneDivision}`);
      console.log(`      seized value, two steps          ${seizedTwoSteps}`);
      console.log(`      lost to the old form             ${seizedOneDivision - seizedTwoSteps} value units`);
      console.log(`      debt absorbed                    ${debt} base units`);
      console.log(`      cashback owed                    ${cashbackOwed} base units`);
      console.log(`      cashback paid by the old form    ${cashbackUnderTwoSteps} base units`);
      console.log(`      withheld from the borrower       ${cashbackOwed - cashbackUnderTwoSteps} base units`);
      console.log(`      cashback actually received       ${await comet.balanceOf(alice.address)} base units`);
    });

    it('the old valuation loses a unit of value on every collateral', async () => {
      expect(seizedOneDivision - seizedTwoSteps).to.equal(24n);
    });

    it('the collateral is seized and the debt is gone', async () => {
      for (let i = 0; i < 24; i++) {
        expect(await comet.collateralBalanceOf(alice.address, tokens[`C${i}`].address)).to.equal(0);
      }
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
    });

    it('the borrower is paid what the seized collateral is worth', async () => {
      expect(await comet.balanceOf(alice.address)).to.equal(cashbackOwed);
    });

    it('the old valuation would have withheld twenty-four value units of cashback', async () => {
      expect(cashbackOwed - cashbackUnderTwoSteps).to.equal(24n * exp(1, 10));
    });
  });

  context('bad debt: twenty-four collaterals', function () {
    let seizedOneDivision = 0n;
    let seizedTwoSteps = 0n;
    let debt: bigint;
    let writtenOff: bigint;

    before(async () => {
      await snapshot.restore();
      seizedOneDivision = 0n;
      seizedTwoSteps = 0n;

      for (let i = 0; i < 24; i++) {
        const token = tokens[`C${i}`];
        const info = await comet.getAssetInfoByAddress(token.address);
        const scale = info.scale.toBigInt();
        const price = (await comet.getPrice(info.priceFeed)).toBigInt();
        const balance = SEIZED_BALANCE[i];

        await token.allocateTo(alice.address, balance);
        await token.connect(alice).approve(comet.address, balance);
        await comet.connect(alice).supply(token.address, balance);

        seizedOneDivision += (balance * price * LIQUIDATION_FACTOR) / (scale * FACTOR_SCALE);
        seizedTwoSteps += (((balance * price) / scale) * LIQUIDATION_FACTOR) / FACTOR_SCALE;
      }

      // Twice what the collateral is worth: the new balance is negative under either valuation, and
      // absorption clamps it to zero.
      debt = 2n * seizedOneDivision * baseScale / basePrice;
      writtenOff = debt;

      const totals = await comet.totalsBasic();
      await comet.setTotalsBasic({ ...totals, totalBorrowBase: totals.totalBorrowBase.add(debt) });
      await comet.setBasePrincipal(alice.address, -debt);

      const reservesBefore = (await comet.getReserves()).toBigInt();
      await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      const reservesAfter = (await comet.getReserves()).toBigInt();

      console.log(`      lost to the old form             ${seizedOneDivision - seizedTwoSteps} value units`);
      console.log(`      debt written off                 ${writtenOff} base units`);
      console.log(`      reserves paid                    ${reservesBefore - reservesAfter} base units`);
      console.log(`      cashback under either valuation  ${await comet.balanceOf(alice.address)} base units`);
    });

    it('the old valuation still loses the same value', async () => {
      expect(seizedOneDivision - seizedTwoSteps).to.equal(24n);
    });

    it('the borrower is left with nothing to receive', async () => {
      expect(await comet.balanceOf(alice.address)).to.equal(0);
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
    });

    it('the reserves pay the whole debt, and the lost value changes none of it', async () => {
      // Both valuations land well below the debt, the clamp discards the difference, and the amount
      // charged to reserves is the debt itself either way.
      expect(seizedTwoSteps * baseScale / basePrice).to.be.lessThan(debt);
      expect(seizedOneDivision * baseScale / basePrice).to.be.lessThan(debt);
    });
  });
});
