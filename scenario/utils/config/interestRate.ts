import { exp } from '../../../test/helpers';
import { InterestRateConfig } from './types';

export const interestRateConfig: InterestRateConfig = {
  utilizationTolerance: exp(0.00001, 18),
  supply: {
    kink: exp(0.8, 18),
    slopeLow: exp(0.04, 18),
    slopeHigh: exp(0.4, 18),
  },
  borrow: {
    kink: exp(0.8, 18),
    base: exp(0.01, 18),
    slopeLow: exp(0.05, 18),
    slopeHigh: exp(0.3, 18),
    max: exp(1, 18),
  },
  expected: {
    utilizationBelowKink: exp(0.5, 18),
    utilizationAboveKink: exp(0.85, 18),
    supplyRateBelowKink: exp(0.02, 18),
    borrowRateBelowKink: exp(0.035, 18),
    supplyRateAboveKink: exp(0.052, 18),
    borrowRateAboveKink: exp(0.065, 18),
  },
  rateTolerance: exp(0.002, 18),
};