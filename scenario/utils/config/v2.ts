import { exp } from '../../../test/helpers';
import { V2Config } from './types';

export const v2Config: V2Config = {
  eth: {
    repayAmount: exp(2, 18),
    borrowAmount: exp(1, 18),
    finalRepayAmount: exp(1, 18),
  },
  dai: { mintRedeemAmount: exp(1000, 18) },
  usdc: { mintRedeemAmount: exp(20_000, 18) },
  wbtc: {
    approveAmount: exp(1, 8),
    repayBehalfAmount: exp(0.1, 8),
    borrowAmount: exp(0.2, 8),
    repayAmount: exp(0.2, 8),
  },
  borrowTolerance: exp(1.6e-6, 18),
};