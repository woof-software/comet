import { scenario } from './context/CometContext';
import { expect } from 'chai';
import { annualize, defactor, exp } from '../test/helpers';
import { BigNumber } from 'ethers';
import { FuzzType } from './constraints/Fuzzing';
import { getConfigForScenario } from './utils/scenarioHelper';

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
  async ({ comet }, context) => {
    const config = getConfigForScenario(context);
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

    expect(defactor(actualUtilization)).to.be.approximately(defactor(expectedUtilization), config.interestRate.utilizationTolerance);
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
    upgrade: async (ctx) => {
      const config = getConfigForScenario(ctx);
      return {
        supplyKink: exp(config.interestRate.supplyKink, 18),
        supplyPerYearInterestRateBase: exp(0, 18),
        supplyPerYearInterestRateSlopeLow: exp(config.interestRate.supplyRateSlopeLow, 18),
        supplyPerYearInterestRateSlopeHigh: exp(config.interestRate.supplyRateSlopeHigh, 18),
        borrowKink: exp(config.interestRate.borrowKink, 18),
        borrowPerYearInterestRateBase: exp(config.interestRate.borrowRateBase, 18),
        borrowPerYearInterestRateSlopeLow: exp(config.interestRate.borrowRateSlopeLow, 18),
        borrowPerYearInterestRateSlopeHigh: exp(config.interestRate.borrowRateSlopeHigh, 18),
      };
    },
    utilization: await (async (ctx) => {
      const config = getConfigForScenario(ctx);
      return config.interestRate.utilizationBelowKink;
    })()
  },
  async ({ comet }, context) => {
    const config = getConfigForScenario(context);
    const utilization = await comet.getUtilization();
    expect(defactor(utilization)).to.be.approximately(config.interestRate.utilizationBelowKink, config.interestRate.utilizationTolerance);
    expect(annualize(await comet.getSupplyRate(utilization))).to.be.approximately(config.interestRate.expectedSupplyRateBelowKink, config.interestRate.rateTolerance);
    expect(annualize(await comet.getBorrowRate(utilization))).to.be.approximately(config.interestRate.expectedBorrowRateBelowKink, config.interestRate.rateTolerance);
  }
);

scenario(
  'Comet#interestRate > above kink rates using hypothetical configuration constants',
  {
    upgrade: async (ctx) => {
      const config = getConfigForScenario(ctx);
      return {
        supplyKink: exp(config.interestRate.supplyKink, 18),
        supplyPerYearInterestRateBase: exp(0, 18),
        supplyPerYearInterestRateSlopeLow: exp(config.interestRate.supplyRateSlopeLow, 18),
        supplyPerYearInterestRateSlopeHigh: exp(config.interestRate.supplyRateSlopeHigh, 18),
        borrowKink: exp(config.interestRate.borrowKink, 18),
        borrowPerYearInterestRateBase: exp(config.interestRate.borrowRateBase, 18),
        borrowPerYearInterestRateSlopeLow: exp(config.interestRate.borrowRateSlopeLow, 18),
        borrowPerYearInterestRateSlopeHigh: exp(config.interestRate.borrowRateSlopeHigh, 18),
      };
    },
    utilization: await(async (ctx) => {
      const config = getConfigForScenario(ctx);
      return config.interestRate.utilizationAboveKink;
    })()
  },
  async ({ comet }, context) => {
    const config = getConfigForScenario(context);
    const utilization = await comet.getUtilization();
    expect(defactor(utilization)).to.be.approximately(config.interestRate.utilizationAboveKink, config.interestRate.utilizationTolerance);
    expect(annualize(await comet.getSupplyRate(utilization))).to.be.approximately(config.interestRate.expectedSupplyRateAboveKink, config.interestRate.rateTolerance);
    expect(annualize(await comet.getBorrowRate(utilization))).to.be.approximately(config.interestRate.expectedBorrowRateAboveKink, config.interestRate.rateTolerance);
  }
);

scenario(
  'Comet#interestRate > rates using fuzzed configuration constants',
  {
    upgrade: async (ctx) => {
      const config = getConfigForScenario(ctx);
      return {
        // TODO: Read types directly from Solidity?
        supplyPerYearInterestRateBase: { type: FuzzType.UINT64 },
        borrowPerYearInterestRateBase: { type: FuzzType.UINT64, max: config.interestRate.maxBorrowRate.toString() /* 100% */ },
      };
    }
  },
  async ({ comet }, context) => {
    const config = getConfigForScenario(context);
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

    expect(defactor(actualUtilization)).to.be.approximately(defactor(expectedUtilization), config.interestRate.utilizationTolerance);
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
  { 
    utilization: await (async (ctx) => {
      const config = getConfigForScenario(ctx);
      return config.interestRate.utilizationBelowKink;
    })()
  },
  async ({ comet }, context) => {
    const config = getConfigForScenario(context);
    const utilization = await comet.getUtilization();
    expect(defactor(utilization)).to.be.approximately(config.interestRate.utilizationBelowKink, config.interestRate.utilizationTolerance);

    // Note: this is dependent on the `deployments/fuji/configuration.json` variables
    // TODO: Consider if there's a better way to test the live curve.
    if (context.world.base.network === 'fuji') {
      // (interestRateBase + interestRateSlopeLow * utilization) * utilization * (1 - reserveRate)
      // utilization = 50%
      // ( 1% + 2% * 50% ) * 50% * (100% - 10%)
      // ( 1% + 1% ) * 50% * 90% -> 1% * 90% = 0.9%
      expect(annualize(await comet.getSupplyRate(utilization))).to.be.approximately(0.009, config.interestRate.rateTolerance);

      // interestRateBase + interestRateSlopeLow * utilization
      // utilization = 50%
      // ( 1% + 2% * 50% )
      expect(annualize(await comet.getBorrowRate(utilization))).to.be.approximately(0.02, config.interestRate.rateTolerance);
    }
  }
);