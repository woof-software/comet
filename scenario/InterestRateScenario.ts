import { scenario, CometContext } from './context/CometContext';
import { expect } from 'chai';
import { annualize, defactor, exp } from '../test/helpers';
import { BigNumber, constants } from 'ethers';
import { CometInterface } from '../build/types';
import { FACTOR_SCALE, isFreshMarket, SECONDS_PER_YEAR } from './utils';

// Bounds of the `uint64` type used for the interest rate base parameters.
const UINT64_MIN = constants.Zero;
const UINT64_MAX = constants.MaxUint256.mask(64);

const ZERO = constants.Zero;
const ONE = constants.One;

function calculateInterestRate(
  utilization: BigNumber,
  kink: BigNumber,
  interestRateBase: BigNumber,
  interestRateSlopeLow: BigNumber,
  interestRateSlopeHigh: BigNumber,
  factorScale = FACTOR_SCALE
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
  factorScale = FACTOR_SCALE
): BigNumber {
  if (totalSupplyBase.isZero()) {
    return ZERO;
  } else {
    const totalSupply = totalSupplyBase.mul(baseSupplyIndex).div(factorScale);
    const totalBorrow = totalBorrowBase.mul(baseBorrowIndex).div(factorScale);
    return totalBorrow.mul(factorScale).div(totalSupply);
  }
}

// Asserts that the utilization and both rate curves reported by `comet` match the
// values recomputed off-chain from the parameters the market is currently deployed with.
async function expectRatesToMatchDeployedCurve(comet: CometInterface) {
  const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
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

  expect(actualUtilization).to.equal(expectedUtilization);
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

scenario('Comet#interestRate > rates using on-chain configuration constants', {}, async ({ comet }) => {
  await expectRatesToMatchDeployedCurve(comet);
});

scenario(
  'Comet#interestRate > below kink rates using hypothetical configuration constants',
  {
    upgrade: {
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.04, 18),
      supplyPerYearInterestRateSlopeHigh: exp(0.4, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(0.01, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.05, 18),
      borrowPerYearInterestRateSlopeHigh: exp(0.3, 18)
    },
    utilization: 0.5
  },
  async ({ comet }) => {
    const utilization = await comet.getUtilization();
    expect(defactor(utilization)).to.be.approximately(0.5, 0.00001);
    expect(annualize(await comet.getSupplyRate(utilization))).to.be.approximately(0.02, 0.001);
    expect(annualize(await comet.getBorrowRate(utilization))).to.be.approximately(0.035, 0.001);
  }
);

scenario(
  'Comet#interestRate > above kink rates using hypothetical configuration constants',
  {
    upgrade: {
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.04, 18),
      supplyPerYearInterestRateSlopeHigh: exp(0.4, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(0.01, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.05, 18),
      borrowPerYearInterestRateSlopeHigh: exp(0.3, 18)
    },
    utilization: 0.85
  },
  async ({ comet }) => {
    const utilization = await comet.getUtilization();
    expect(defactor(utilization)).to.be.approximately(0.85, 0.00001);
    expect(annualize(await comet.getSupplyRate(utilization))).to.be.approximately(0.052, 0.001);
    expect(annualize(await comet.getBorrowRate(utilization))).to.be.approximately(0.065, 0.001);
  }
);

scenario(
  'Comet#interestRate > rates using minimum uint64 interest rate bases',
  {
    upgrade: {
      supplyPerYearInterestRateBase: UINT64_MIN,
      borrowPerYearInterestRateBase: UINT64_MIN
    }
  },
  async ({ comet }) => {
    // At the lower bound the bases contribute nothing, so each curve is purely its slope term.
    expect(await comet.supplyPerSecondInterestRateBase()).to.equal(0);
    expect(await comet.borrowPerSecondInterestRateBase()).to.equal(0);

    await expectRatesToMatchDeployedCurve(comet);
  }
);

scenario(
  'Comet#interestRate > rates using maximum uint64 interest rate bases',
  {
    upgrade: {
      supplyPerYearInterestRateBase: UINT64_MAX,
      borrowPerYearInterestRateBase: UINT64_MAX
    }
  },
  async ({ comet }) => {
    // The per-second bases are the per-year bases truncated by `SECONDS_PER_YEAR` in the constructor.
    expect(await comet.supplyPerSecondInterestRateBase()).to.equal(UINT64_MAX.div(SECONDS_PER_YEAR));
    expect(await comet.borrowPerSecondInterestRateBase()).to.equal(UINT64_MAX.div(SECONDS_PER_YEAR));

    // `getSupplyRate`/`getBorrowRate` must still return without tripping `safe64` at the upper bound.
    await expectRatesToMatchDeployedCurve(comet);
  }
);

scenario(
  'Comet#interestRate > borrow balance grows with new index after time',
  {
    filter: async (ctx) => !(await isFreshMarket(ctx)),
    cometBalances: { betty: { $base: -500 } }
  },
  async ({ comet, actors }, context) => {
    const { betty } = actors;
    const before = (await comet.borrowBalanceOf(betty.address)).toBigInt();
    const { baseBorrowIndex: idxBefore } = await comet.totalsBasic();

    await context.world.increaseTime(3600);
    await comet.accrueAccount(betty.address);

    const after = (await comet.borrowBalanceOf(betty.address)).toBigInt();
    const { baseBorrowIndex: idxAfter } = await comet.totalsBasic();

    expect(after).to.be.approximately((before * idxAfter.toBigInt()) / idxBefore.toBigInt(), 1n);
  }
);

scenario(
  'Comet#interestRate > rate curve matches formula across utilization points',
  {},
  async ({ comet }) => {
    const supplyKink = await comet.supplyKink();
    const supplyBase = await comet.supplyPerSecondInterestRateBase();
    const supplySlopeLow = await comet.supplyPerSecondInterestRateSlopeLow();
    const supplySlopeHigh = await comet.supplyPerSecondInterestRateSlopeHigh();

    const borrowKink = await comet.borrowKink();
    const borrowBase = await comet.borrowPerSecondInterestRateBase();
    const borrowSlopeLow = await comet.borrowPerSecondInterestRateSlopeLow();
    const borrowSlopeHigh = await comet.borrowPerSecondInterestRateSlopeHigh();

    // Sweep 0% -> 200% utilization in 10% steps. Both curves are piecewise linear with a
    // single breakpoint at the kink, so an even sweep lands on both sides of it wherever
    // the kink sits, and every step exercises a different truncation of
    // `slope * utilization / FACTOR_SCALE`. Utilization can exceed 100% in Comet, where
    // borrows are backed by collateral rather than by the base supply.
    const STEPS = 20;
    const step = FACTOR_SCALE.mul(2).div(STEPS);
    const utilizations = [
      ...Array.from({ length: STEPS + 1 }, (_, i) => step.mul(i)),
      await comet.getUtilization() // the real-world point, which the sweep is unlikely to land on
    ];

    for (const u of utilizations) {
      expect(await comet.getSupplyRate(u)).to.equal(
        calculateInterestRate(u, supplyKink, supplyBase, supplySlopeLow, supplySlopeHigh),
        `supply rate mismatch at u=${u.toString()} (supplyKink=${supplyKink.toString()})`
      );
      expect(await comet.getBorrowRate(u)).to.equal(
        calculateInterestRate(u, borrowKink, borrowBase, borrowSlopeLow, borrowSlopeHigh),
        `borrow rate mismatch at u=${u.toString()} (borrowKink=${borrowKink.toString()})`
      );
    }
  }
);

scenario('Comet#interestRate > lastAccrualTime does not lie in the future', {}, async ({ comet }, _context, world) => {
  const { lastAccrualTime } = await comet.totalsBasic();
  const now = await world.timestamp();
  expect(lastAccrualTime).to.be.lte(now, `lastAccrualTime=${lastAccrualTime} > block.timestamp=${now}`);
});

scenario(
  'Comet#interestRate > lastAccrualTime is initialized on a live market',
  {
    filter: async (ctx: CometContext) => !(await isFreshMarket(ctx))
  },
  async ({ comet }) => {
    const { lastAccrualTime } = await comet.totalsBasic();
    expect(lastAccrualTime).to.be.gt(0, `lastAccrualTime is 0 on an active market — interestRate likely corrupted`);
  }
);

scenario(
  'Comet#interestRate > baseSupplyIndex >= BASE_INDEX_SCALE on initialized market',
  {
    filter: async (ctx: CometContext) => !(await isFreshMarket(ctx))
  },
  async ({ comet }) => {
    const { baseSupplyIndex } = await comet.totalsBasic();
    const baseIndexScale = await comet.baseIndexScale();
    expect(baseSupplyIndex).to.be.gte(
      baseIndexScale,
      `baseSupplyIndex=${baseSupplyIndex} < BASE_INDEX_SCALE=${baseIndexScale}`
    );
  }
);

scenario(
  'Comet#interestRate > baseBorrowIndex >= BASE_INDEX_SCALE on initialized market',
  {
    filter: async (ctx: CometContext) => !(await isFreshMarket(ctx))
  },
  async ({ comet }) => {
    const { baseBorrowIndex } = await comet.totalsBasic();
    const baseIndexScale = await comet.baseIndexScale();
    expect(baseBorrowIndex).to.be.gte(
      baseIndexScale,
      `baseBorrowIndex=${baseBorrowIndex} < BASE_INDEX_SCALE=${baseIndexScale}`
    );
  }
);

scenario(
  'Comet#interestRate > baseBorrowIndex >= baseSupplyIndex',
  {
    filter: async (ctx: CometContext) => !(await isFreshMarket(ctx))
  },
  async ({ comet }) => {
    const { baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
    expect(baseBorrowIndex).to.be.gte(
      baseSupplyIndex,
      `baseBorrowIndex=${baseBorrowIndex} < baseSupplyIndex=${baseSupplyIndex}`
    );
  }
);

scenario(
  'Comet#interestRate > trackingSupplyIndex > 0 on rewards-active market',
  {
    filter: async (ctx: CometContext) => {
      if (await isFreshMarket(ctx)) return false;
      const comet = await ctx.getComet();
      const baseTrackingSupplySpeed = await comet.baseTrackingSupplySpeed();
      if (baseTrackingSupplySpeed.isZero()) return false;
      const baseMinForRewards = await comet.baseMinForRewards();
      const { totalSupplyBase } = await comet.totalsBasic();
      return totalSupplyBase.gte(baseMinForRewards);
    }
  },
  async ({ comet }) => {
    const { trackingSupplyIndex } = await comet.totalsBasic();
    expect(trackingSupplyIndex).to.be.gt(0, `trackingSupplyIndex=0 on a market where rewards are active `);
  }
);

scenario(
  'Comet#interestRate > trackingBorrowIndex > 0 on rewards-active market',
  {
    filter: async (ctx: CometContext) => {
      if (await isFreshMarket(ctx)) return false;
      const comet = await ctx.getComet();
      const baseTrackingBorrowSpeed = await comet.baseTrackingBorrowSpeed();
      if (baseTrackingBorrowSpeed.isZero()) return false;
      const baseMinForRewards = await comet.baseMinForRewards();
      const { totalBorrowBase } = await comet.totalsBasic();
      return totalBorrowBase.gte(baseMinForRewards);
    }
  },
  async ({ comet }) => {
    const { trackingBorrowIndex } = await comet.totalsBasic();
    expect(trackingBorrowIndex).to.be.gt(0, `trackingBorrowIndex=0 on a market where rewards are active `);
  }
);

scenario('Comet#interestRate > borrow curve lie strictly above supply curve', {}, async ({ comet }) => {
  const supplyKink = await comet.supplyKink();
  const borrowKink = await comet.borrowKink();
  const currentUtilization = await comet.getUtilization();

  const minKink = supplyKink.lte(borrowKink) ? supplyKink : borrowKink;
  const maxKink = supplyKink.lte(borrowKink) ? borrowKink : supplyKink;

  const points = [
    ZERO,
    minKink.gt(ZERO) ? minKink.sub(ONE) : ZERO,
    minKink,
    maxKink,
    currentUtilization,
    FACTOR_SCALE, // 100% utilization
    FACTOR_SCALE.mul(2) // 200% utilization — reachable in Comet, where borrows are backed by collateral rather than by the base supply
  ];

  const seen = new Set<string>();
  const uniquePoints = points.filter((p) => {
    const k = p.toString();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  for (const u of uniquePoints) {
    const supplyRate = await comet.getSupplyRate(u);
    const borrowRate = await comet.getBorrowRate(u);

    expect(borrowRate).to.be.gt(
      supplyRate,
      `borrowRate=${borrowRate} is not strictly greater than supplyRate=${supplyRate} at u=${u}`
    );
  }
});

scenario('Comet#interestRate > slopeHigh strictly exceeds slopeLow on both curves', {}, async ({ comet }) => {
  const supplySlopeLow = await comet.supplyPerSecondInterestRateSlopeLow();
  const supplySlopeHigh = await comet.supplyPerSecondInterestRateSlopeHigh();
  const borrowSlopeLow = await comet.borrowPerSecondInterestRateSlopeLow();
  const borrowSlopeHigh = await comet.borrowPerSecondInterestRateSlopeHigh();

  expect(supplySlopeHigh).to.be.gt(
    supplySlopeLow,
    `supply curve: slopeHigh=${supplySlopeHigh} is not strictly greater than slopeLow=${supplySlopeLow}`
  );

  expect(borrowSlopeHigh).to.be.gt(
    borrowSlopeLow,
    `borrow curve: slopeHigh=${borrowSlopeHigh} is not strictly greater than slopeLow=${borrowSlopeLow}`
  );
});

scenario('Comet#interestRate > supply and borrow curves share the same kink position', {}, async ({ comet }) => {
  const supplyKink = await comet.supplyKink();
  const borrowKink = await comet.borrowKink();
  expect(supplyKink).to.equal(borrowKink, `supplyKink=${supplyKink} does not equal borrowKink=${borrowKink}`);
});

scenario('Comet#interestRate > supply kink position lies within valid utilization range', {}, async ({ comet }) => {
  const supplyKink = await comet.supplyKink();

  expect(supplyKink).to.be.gt(0, `supplyKink=0`);
  expect(supplyKink).to.be.lte(FACTOR_SCALE, `supplyKink=${supplyKink} > FACTOR_SCALE=${FACTOR_SCALE}`);
});

scenario('Comet#interestRate > borrow kink position lies within valid utilization range', {}, async ({ comet }) => {
  const borrowKink = await comet.borrowKink();

  expect(borrowKink).to.be.gt(0, `borrowKink=0`);
  expect(borrowKink).to.be.lte(FACTOR_SCALE, `borrowKink=${borrowKink} > FACTOR_SCALE=${FACTOR_SCALE}`);
});

scenario(
  'Comet#interestRate > time alone does not change utilization without accrue',
  {},
  async ({ comet }, context) => {
    const world = context.world;
    const utilization = await comet.getUtilization();

    await world.increaseTime(3600);

    expect(await comet.getUtilization()).to.equal(utilization);
  }
);
