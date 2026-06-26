import {
  LiquidationModule,
  LiquidationModule__factory,
} from 'build/types';
import { ethers } from 'hardhat';
import { exp } from './math';

type DeployLiquidationModuleOpts = {
  multisig: string;
  executors: string[];
  pausers: string[];
  dexAdapter: string;
  borderHF?: bigint;
  penaltyBps?: bigint;
};

export const DEFAULT_DEX_ADAPTER = ethers.constants.AddressZero;
const DEFAULT_BORDER_HF = exp(102, 16); // 1.02e18
const DEFAULT_PENALTY_BPS: bigint = BigInt(500);

/**
 * Deploys a LiquidationModule. Pass the returned module's address as
 * `config.liquidationModule` when deploying the Comet (see makeProtocol/makeConfigurator).
 *
 * The DAO is a constant. The Multisig, Executor and Pauser roles are required and must be supplied by the
 * caller (makeProtocol/makeConfigurator reserve dedicated signers for these roles and return them).
 */
export async function deployAndUpdateLiquidationModule(
  opts: DeployLiquidationModuleOpts
): Promise<LiquidationModule> {
  const LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;

  const liquidationModule = await LiquidationModuleFactory.deploy(
    opts.multisig,
    opts.dexAdapter ?? DEFAULT_DEX_ADAPTER,
    opts.executors,
    opts.pausers,
    opts.borderHF ?? DEFAULT_BORDER_HF,
    opts.penaltyBps ?? DEFAULT_PENALTY_BPS
  );
  await liquidationModule.deployed();

  return liquidationModule;
}
