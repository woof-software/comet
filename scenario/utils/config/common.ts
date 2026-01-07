import { CommonConfig } from './types';

export const commonConfig: CommonConfig = {
  divisors: {
    transfer: 2n,
    borrow: 2n,
    percent: 100n,
    precision: 1_000_000n,
  },

  tolerances: {
    interest: { small: 1n, medium: 2n, large: 4n },
    balance: 1n,
  },

  timing: {
    oneDay: 86400n,
    interestSeconds: 110n,
  },

  cometBalances: {
    base: 10000n,
    collateral: {
      undercollateralized: 1n,
      asset0CometBalance: 5000n
    },
  },
};