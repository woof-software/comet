import { scenario } from './context/CometContext';
import { expect } from 'chai';
import { annualize, defactor, exp } from '../test/helpers';
import { BigNumber } from 'ethers';
import { FuzzType } from './constraints/Fuzzing';

const UTILIZATION_TOLERANCE = 0.00001;
const SUPPLY_KINK = 0.8;
const SUPPLY_RATE_SLOPE_LOW = 0.04;
const SUPPLY_RATE_SLOPE_HIGH = 0.4;
const BORROW_KINK = 0.8;
const BORROW_RATE_BASE = 0.01;
const BORROW_RATE_SLOPE_LOW = 0.05;
const BORROW_RATE_SLOPE_HIGH = 0.3;
const UTILIZATION_BELOW_KINK = 0.5;
const UTILIZATION_ABOVE_KINK = 0.85;
const EXPECTED_SUPPLY_RATE_BELOW_KINK = 0.02;
const EXPECTED_BORROW_RATE_BELOW_KINK = 0.035;
const EXPECTED_SUPPLY_RATE_ABOVE_KINK = 0.052;
const EXPECTED_BORROW_RATE_ABOVE_KINK = 0.065;
const RATE_TOLERANCE = 0.001;
const MAX_BORROW_RATE = 1e18;

function calculateInterestRate(
  utilization: BigNumber,
  kink: BigNumber,
  interestRateBase: BigNumber,
  interestRateSlopeLow: BigNumber,
  interestRateSlopeHigh: BigNumber,
  factorScale = BigNumber.from(exp(1, 18))
): BigNumber {
  if (utilization.lte(kink)) {
    const interestRateWithoutBase = interestRateSlopeLow.mul(utilization).div(factorScale);
    return interestRateBase.add(interestRateWithoutBase);
  } else {
    const rateSlopeLow = interestRateSlopeLow.mul(kink).div(factorScale);
    const rateSlopeHigh = interestRateSlopeHigh.mul(utilization.sub(kink)).div(factorScale);
    return interestRateBase.add(rateSlopeLow).add(rateSlopeHigh);
  }
}

function calculateUtilization(
  totalSupplyBase: BigNumber,
  totalBorrowBase: BigNumber,
  baseSupplyIndex: BigNumber,
  baseBorrowIndex: BigNumber,
  factorScale = BigNumber.from(exp(1, 18))
): BigNumber {
  if (totalSupplyBase.isZero()) {
    return BigNumber.from(0);
  } else {
    const totalSupply = totalSupplyBase.mul(baseSupplyIndex).div(factorScale);
    const totalBorrow = totalBorrowBase.mul(baseBorrowIndex).div(factorScale);
    return totalBorrow.mul(factorScale).div(totalSupply);
  }
}

scenario(
  'Comet#interestRate > rates using on-chain configuration constants',
  {},
  async ({ comet }) => {
    let { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
    const supplyKink = await comet.supplyKink();
    const supplyPerSecondInterestRateBase = await comet.supplyPerSecondInterestRateBase();
    const supplyPerSecondInterestRateSlopeLow = await comet.supplyPerSecondInterestRateSlopeLow();
    const supplyPerSecondInterestRateSlopeHigh = await comet.supplyPerSecondInterestRateSlopeHigh();
    const borrowKink = await comet.borrowKink();
    const borrowPerSecondInterestRateBase = await comet.borrowPerSecondInterestRateBase();
    const borrowPerSecondInterestRateSlopeLow = await comet.borrowPerSecondInterestRateSlopeLow();
    const borrowPerSecondInterestRateSlopeHigh = await comet.borrowPerSecondInterestRateSlopeHigh();

    const actualUtilization = await comet.getUtilization();
    const expectedUtilization = calculateUtilization(totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex);

    expect(defactor(actualUtilization)).to.be.approximately(defactor(expectedUtilization), UTILIZATION_TOLERANCE);
    expect(await comet.getSupplyRate(actualUtilization)).to.equal(
      calculateInterestRate(
        actualUtilization,
        supplyKink,
        supplyPerSecondInterestRateBase,
        supplyPerSecondInterestRateSlopeLow,
        supplyPerSecondInterestRateSlopeHigh
      )
    );
    expect(await comet.getBorrowRate(actualUtilization)).to.equal(
      calculateInterestRate(
        actualUtilization,
        borrowKink,
        borrowPerSecondInterestRateBase,
        borrowPerSecondInterestRateSlopeLow,
        borrowPerSecondInterestRateSlopeHigh
      )
    );
  }
);

scenario(
  'Comet#interestRate > below kink rates using hypothetical configuration constants',
  {
    upgrade: {
      supplyKink: exp(SUPPLY_KINK, 18),
      supplyPerYearInterestRateBase: exp(0, 18),
      supplyPerYearInterestRateSlopeLow: exp(SUPPLY_RATE_SLOPE_LOW, 18),
      supplyPerYearInterestRateSlopeHigh: exp(SUPPLY_RATE_SLOPE_HIGH, 18),
      borrowKink: exp(BORROW_KINK, 18),
      borrowPerYearInterestRateBase: exp(BORROW_RATE_BASE, 18),
      borrowPerYearInterestRateSlopeLow: exp(BORROW_RATE_SLOPE_LOW, 18),
      borrowPerYearInterestRateSlopeHigh: exp(BORROW_RATE_SLOPE_HIGH, 18),
    },
    utilization: UTILIZATION_BELOW_KINK,
  },
  async ({ comet }) => {
    const utilization = await comet.getUtilization();
    expect(defactor(utilization)).to.be.approximately(UTILIZATION_BELOW_KINK, UTILIZATION_TOLERANCE);
    expect(annualize(await comet.getSupplyRate(utilization))).to.be.approximately(EXPECTED_SUPPLY_RATE_BELOW_KINK, RATE_TOLERANCE);
    expect(annualize(await comet.getBorrowRate(utilization))).to.be.approximately(EXPECTED_BORROW_RATE_BELOW_KINK, RATE_TOLERANCE);
  }
);

scenario(
  'Comet#interestRate > above kink rates using hypothetical configuration constants',
  {
    upgrade: {
      supplyKink: exp(SUPPLY_KINK, 18),
      supplyPerYearInterestRateBase: exp(0, 18),
      supplyPerYearInterestRateSlopeLow: exp(SUPPLY_RATE_SLOPE_LOW, 18),
      supplyPerYearInterestRateSlopeHigh: exp(SUPPLY_RATE_SLOPE_HIGH, 18),
      borrowKink: exp(BORROW_KINK, 18),
      borrowPerYearInterestRateBase: exp(BORROW_RATE_BASE, 18),
      borrowPerYearInterestRateSlopeLow: exp(BORROW_RATE_SLOPE_LOW, 18),
      borrowPerYearInterestRateSlopeHigh: exp(BORROW_RATE_SLOPE_HIGH, 18),
    },
    utilization: UTILIZATION_ABOVE_KINK,
  },
  async ({ comet }) => {
    const utilization = await comet.getUtilization();
    expect(defactor(utilization)).to.be.approximately(UTILIZATION_ABOVE_KINK, UTILIZATION_TOLERANCE);
    expect(annualize(await comet.getSupplyRate(utilization))).to.be.approximately(EXPECTED_SUPPLY_RATE_ABOVE_KINK, RATE_TOLERANCE);
    expect(annualize(await comet.getBorrowRate(utilization))).to.be.approximately(EXPECTED_BORROW_RATE_ABOVE_KINK, RATE_TOLERANCE);
  }
);

scenario(
  'Comet#interestRate > rates using fuzzed configuration constants',
  {
    upgrade: {
      // TODO: Read types directly from Solidity?
      supplyPerYearInterestRateBase: { type: FuzzType.UINT64 },
      borrowPerYearInterestRateBase: { type: FuzzType.UINT64, max: MAX_BORROW_RATE.toString() /* 100% */ },
    }
  },
  async ({ comet }) => {
    let { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
    const supplyKink = await comet.supplyKink();
    const supplyPerSecondInterestRateBase = await comet.supplyPerSecondInterestRateBase();
    const supplyPerSecondInterestRateSlopeLow = await comet.supplyPerSecondInterestRateSlopeLow();
    const supplyPerSecondInterestRateSlopeHigh = await comet.supplyPerSecondInterestRateSlopeHigh();
    const borrowKink = await comet.borrowKink();
    const borrowPerSecondInterestRateBase = await comet.borrowPerSecondInterestRateBase();
    const borrowPerSecondInterestRateSlopeLow = await comet.borrowPerSecondInterestRateSlopeLow();
    const borrowPerSecondInterestRateSlopeHigh = await comet.borrowPerSecondInterestRateSlopeHigh();


    const actualUtilization = await comet.getUtilization();
    const expectedUtilization = calculateUtilization(totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex);

    expect(defactor(actualUtilization)).to.be.approximately(defactor(expectedUtilization), UTILIZATION_TOLERANCE);
    expect(await comet.getSupplyRate(actualUtilization)).to.equal(
      calculateInterestRate(
        actualUtilization,
        supplyKink,
        supplyPerSecondInterestRateBase,
        supplyPerSecondInterestRateSlopeLow,
        supplyPerSecondInterestRateSlopeHigh
      )
    );
    expect(await comet.getBorrowRate(actualUtilization)).to.equal(
      calculateInterestRate(
        actualUtilization,
        borrowKink,
        borrowPerSecondInterestRateBase,
        borrowPerSecondInterestRateSlopeLow,
        borrowPerSecondInterestRateSlopeHigh
      )
    );
  }
);

// TODO: Scenario for testing custom configuration constants using a utilization constraint.
// XXX this test seems too fickle
scenario.skip(
  'Comet#interestRate > when utilization is 50%',
  { utilization: UTILIZATION_BELOW_KINK },
  async ({ comet }, context) => {
    const utilization = await comet.getUtilization();
    expect(defactor(utilization)).to.be.approximately(UTILIZATION_BELOW_KINK, UTILIZATION_TOLERANCE);

    // Note: this is dependent on the `deployments/fuji/configuration.json` variables
    // TODO: Consider if there's a better way to test the live curve.
    if (context.world.base.network === 'fuji') {
      // (interestRateBase + interestRateSlopeLow * utilization) * utilization * (1 - reserveRate)
      // utilization = 50%
      // ( 1% + 2% * 50% ) * 50% * (100% - 10%)
      // ( 1% + 1% ) * 50% * 90% -> 1% * 90% = 0.9%
      expect(annualize(await comet.getSupplyRate(utilization))).to.be.approximately(0.009, RATE_TOLERANCE);

      // interestRateBase + interestRateSlopeLow * utilization
      // utilization = 50%
      // ( 1% + 2% * 50% )
      expect(annualize(await comet.getBorrowRate(utilization))).to.be.approximately(0.02, RATE_TOLERANCE);
    }
  }
);