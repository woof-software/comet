import { GovernanceConfig } from './types';

export const governanceConfig: GovernanceConfig = {
  delayMultiplier: 2n,
  timelock: {
    delayDays: 2n,
    gracePeriodDays: 14n,
    minDelayDays: 2n,
    maxDelayDays: 30n,
  },
  newFunctionExpectedValue: 101n,
  minBaseBalance: 1000n,
  basePrice: 1n,
  baseBorrowMultiplier: 1000n,
};
