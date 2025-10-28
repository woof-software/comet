import { exp } from '../../../test/helpers';
import { MainnetBulkerConfig } from './types';

export const mainnetBulkerConfig: MainnetBulkerConfig = {
  stethSupplyAmount: exp(0.1, 18),
  stethBalanceTolerance: 2n,
  wstethBalanceTolerance: 1n,
  stethWithdrawalTolerance: 3n,
  wstethWithdrawalTolerance: 1n,
  maxStethWithdrawalTolerance: 2n,
  sourceTokenBuffer: 3n
};