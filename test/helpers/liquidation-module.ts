import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import {
  CometProxyAdmin,
  Configurator,
  LiquidationModule,
  LiquidationModule__factory,
  LiquidationModuleForComet__factory
} from 'build/types';
import { ethers } from 'hardhat';

type DeployLiquidationModuleOpts = {
  multisig: string;
  executors: string[];
  pausers: string[];
  dexAdapter: string;
  incentiveBps?: bigint;
};

const DEFAULT_INCENTIVE_BPS = BigInt(500);

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

export async function deployDefaultLiquidationModuleWithCometUpdate(
  opts: DeployLiquidationModuleOpts,
  governor: SignerWithAddress,
  cometProxyAddress: string,
  configurator: Configurator,
  cometProxyAdmin: CometProxyAdmin
): Promise<LiquidationModule> {
  const liquidationModule = await deployDefaultLiquidationModuleWithComet(opts, cometProxyAddress);

  await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
  await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configurator.address, cometProxyAddress);

  return liquidationModule;
}