import { exp } from '../../../test/helpers';
import { LiquidationConfig } from './types';

export const liquidationConfig: LiquidationConfig = {
  base: { tiny: 10n, standard: 100000n, medium: 1000n, large: 1000n },
  asset: {
    tiny: exp(0.001, 18),
    small: exp(0.5, 18),
    standard: 200n,
    medium: 1000n,
    large: 5000n,
  },
  timeMultiplier: 1.001,
  factors: { denominator: 90n, alternateDenominator: 100n, numerator: 90n },
};