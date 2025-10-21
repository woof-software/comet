import { exp } from '../../../test/helpers';
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
    borrow: exp(1.6e-6, 18),
  },

  timing: {
    oneDay: 86400n,
    interestSeconds: 110n,
  },

  amounts: {
    base: {
      tiny: 1n,
      small: 2n,
      standard: 1000n,
      large: 10000n,
      hundred: 100n,
    },
    collateral: {
      tiny: 1n,
      small: 50n,
      standard: 100n,
      large: 5000n,
      hundred: 100n,
    },
  },
};