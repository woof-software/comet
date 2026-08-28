import { LiquidationModule, LiquidationModule__factory, LiquidationModuleForComet__factory } from 'build/types';
import { AssetInfoStructOutput } from 'build/types/CometWithExtendedAssetList';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

import { toBigInt } from './cast';
import { ceilDiv, exp } from './math';

export type DeployLiquidationModuleOpts = {
  multisig: string;
  executors: string[];
  pausers: string[];
  dexAdapter: string;
  incentiveBps?: bigint;
};

const DEFAULT_INCENTIVE_BPS = BigInt(500);
/** Mirrors TARGET_HEALTH_FACTOR and FACTOR_SCALE in SeizureCalculations.sol. */
export const TARGET_HEALTH_FACTOR = exp(1.05, 18);
const FACTOR_SCALE = exp(1, 18);

/**
 * Deploys a LiquidationModule. Pass the returned module's address as
 * `config.liquidationModule` when deploying the Comet (see makeProtocol/makeConfigurator).
 *
 * The DAO is a constant. The Multisig, Executor and Pauser roles are required and must be supplied by the
 * caller (makeProtocol/makeConfigurator reserve dedicated signers for these roles and return them).
 */
export async function deployDefaultLiquidationModule(
  opts: DeployLiquidationModuleOpts
): Promise<LiquidationModule> {
  const LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
  const liquidationModule = await LiquidationModuleFactory.deploy(
    opts.dexAdapter,
    opts.multisig,
    opts.executors,
    opts.pausers,
    opts.incentiveBps ?? DEFAULT_INCENTIVE_BPS
  );
  await liquidationModule.deployed();

  return liquidationModule;
}

export async function deployDefaultLiquidationModuleWithComet(
  opts: DeployLiquidationModuleOpts,
  comet: string
): Promise<LiquidationModule> {
  const LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModuleForComet')) as LiquidationModuleForComet__factory;
  const liquidationModule = await LiquidationModuleFactory.deploy(
    opts.dexAdapter,
    opts.multisig,
    opts.executors,
    opts.pausers,
    opts.incentiveBps ?? DEFAULT_INCENTIVE_BPS,
    comet
  );
  await liquidationModule.deployed();

  return liquidationModule;
}

/**
 * The collateral value a partial liquidation asks for from one asset, mirroring the seizure planner.
 *
 * The account is put back on the liquidation threshold with a 5% margin: seizing collateral worth S
 * repays S * liquidationFactor of the debt and takes S * liquidateCollateralFactor out of the
 * threshold value, so restoring the target health factor means
 *
 *   S = (targetHF * debt - totalCollateralizedValue) / (targetHF * liquidationFactor - liquidateCollateralFactor)
 *
 * Both sides carry an extra FACTOR_SCALE, which keeps this to a single division, and it rounds up:
 * asking for less than the seizure planner does would leave the account short of the target.
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
