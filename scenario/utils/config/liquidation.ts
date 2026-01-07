import { LiquidationConfig } from './types';

export const liquidationConfig: LiquidationConfig = {
  base: { borrowPrincipal: 100000n, undercollateralized: 1000n },
  asset: {
    smallPosition: 0.001, // used for small position liquidation scenarios
    supplyAmount: 200n,
  },
  timeMultiplier: 1.001,
  factors: { denominator: 90n, alternateDenominator: 100n, numerator: 90n },
};