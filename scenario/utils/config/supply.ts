import { SupplyConfig } from './types';

export const supplyConfig: SupplyConfig = {
  collateralAmount: 100n,
  baseSupplyAmount: 100n,
  baseSupplyWithFees: 1000n,
  baseBorrowWithFees: -1000n,
  baseBorrowRepayAmount: -999n,
  baseBalance: 1010n,
  baseSupplySmall: 10n,
  baseSupplyAfterFees: 999n,
  usdtFeeBasisPoints: 10n,
  usdtMaxFee: 10n,
  usdtRemainingDebt: -1n,
  ethBalanceForGas: 100n,
  interestTimeFactor: { short: 1n, long: 4n },
};