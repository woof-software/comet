import { AssetInfoStructOutput } from 'build/types/CometWithExtendedAssetList';
import { BigNumber } from 'ethers';

import { toBigInt } from './cast';
import { ceilDiv, exp } from './math';

/** The target health factor makeProtocol configures Comet with by default, and Comet's FACTOR_SCALE. */
export const TARGET_HEALTH_FACTOR = exp(1.05, 18);
const FACTOR_SCALE = exp(1, 18);

/**
 * The collateral value a partial liquidation asks for from one asset, mirroring absorb.
 *
 * The account is put back on the liquidation threshold with a 5% margin: seizing collateral worth S
 * repays S * liquidationFactor of the debt and takes S * liquidateCollateralFactor out of the
 * threshold value, so restoring the target health factor means
 *
 *   S = (targetHF * debt - totalCollateralizedValue) / (targetHF * liquidationFactor - liquidateCollateralFactor)
 *
 * Both sides carry an extra FACTOR_SCALE, which keeps this to a single division, and it rounds up:
 * asking for less than absorb does would leave the account short of the target.
 *
 * @param remainingDebt the debt value still to be covered, at the current price of the base asset
 * @param totalCollateralizedValue the account's collateral weighted by liquidateCollateralFactor
 * @param assetInfo the collateral being seized
 */
export function wantedCollateralValue(
  remainingDebt: bigint | BigNumber,
  totalCollateralizedValue: bigint | BigNumber,
  assetInfo: AssetInfoStructOutput
): bigint {
  return ceilDiv(
    (toBigInt(remainingDebt) * TARGET_HEALTH_FACTOR - toBigInt(totalCollateralizedValue) * FACTOR_SCALE) * FACTOR_SCALE,
    toBigInt(assetInfo.liquidationFactor) * TARGET_HEALTH_FACTOR - toBigInt(assetInfo.liquidateCollateralFactor) * FACTOR_SCALE,
  );
}
