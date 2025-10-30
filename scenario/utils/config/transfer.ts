import { commonConfig } from './common';
import { TransferConfig } from './types';

export const transferConfig: TransferConfig = {
  baseAmount: commonConfig.amounts.base.standard,
  assetAmount: 5000n,
  collateralAmount: commonConfig.amounts.collateral.standard,
  multiplier: { num: 25n, denom: 10n },
  result: { num: 15n, denom: 10n },
  remainingBalance: 1n,
  overLimit: 2001n,
  principalToleranceValues: [0n, -1n, -2n],
};