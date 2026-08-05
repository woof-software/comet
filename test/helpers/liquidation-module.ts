import { DexLiquidationModule, DexLiquidationModule__factory, DexLiquidationModuleForComet, DexLiquidationModuleForComet__factory } from 'build/types';
import { ethers } from 'hardhat';

export type DeployLiquidationModuleOpts = {
  multisig: string;
  executors: string[];
  pausers: string[];
  dexAdapter: string;
  incentiveBps?: bigint;
};

const DEFAULT_INCENTIVE_BPS = BigInt(500);

/**
 * Deploys a DexLiquidationModule. Pass the returned module's address as
 * `config.liquidationModule` when deploying the Comet (see makeProtocol/makeConfigurator).
 *
 * The DAO is a constant. The Multisig, Executor and Pauser roles are required and must be supplied by the
 * caller (makeProtocol/makeConfigurator reserve dedicated signers for these roles and return them).
 */
export async function deployDefaultLiquidationModule(
  opts: DeployLiquidationModuleOpts
): Promise<DexLiquidationModule> {
  const LiquidationModuleFactory = (await ethers.getContractFactory('DexLiquidationModule')) as DexLiquidationModule__factory;
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
): Promise<DexLiquidationModuleForComet> {
  const LiquidationModuleFactory = (await ethers.getContractFactory('DexLiquidationModuleForComet')) as DexLiquidationModuleForComet__factory;
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
