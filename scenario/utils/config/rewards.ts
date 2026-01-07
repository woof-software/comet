import { exp } from '../../../test/helpers';
import { RewardsConfig } from './types';

export const rewardsConfig: RewardsConfig = {
  assetAmount: 10000n,
  baseAmount: 1000n,
  baseSupplyAmount: 100n,
  minTimeDelta: 86400n,
  albertBaseDivisor: 10n,
  compRewardsAmount: 100n,
  multiplierScale: exp(1, 18),
  multipliers: [
    exp(55, 18),
    exp(10, 18),
    exp(1, 18),
    exp(0.01, 18),
    exp(0.00355, 18),
  ],
};