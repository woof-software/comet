
import { commonConfig } from './common';
import { WithdrawConfig } from './types';

export const withdrawConfig: WithdrawConfig = {
  baseAmount: commonConfig.amounts.base.standard,
  assetAmount: 3000n,
  collateralAmount: commonConfig.amounts.collateral.standard,
  alternateBase: commonConfig.amounts.base.standard,
  alternateAsset: 3000n,
};