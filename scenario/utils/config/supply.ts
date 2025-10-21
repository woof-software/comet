import { commonConfig } from './common';
import { SupplyConfig } from './types';

export const supplyConfig: SupplyConfig = {
  collateralAmount: commonConfig.amounts.collateral.standard,
  baseSupplyAmount: 100n,
  baseSupplyWithFees: 1000n,
  baseBorrowWithFees: -1000n,
  baseBorrowRepayAmount: -999n,
  baseBalance: 1010n,
  baseBalanceMax: 10n,
  baseSupplySmall: 10n,
  baseSupplyAfterFees: 999n,
  usdtFeeBasisPoints: 10n,
  usdtMaxFee: 10n,
  usdtRemainingDebt: -1n,
  ethBalanceForGas: 100n,
  interestTimeFactor: { short: 1n, long: 4n },
  minBorrow: '<= -1000',
};