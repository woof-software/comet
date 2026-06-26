import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import {
  CometHarnessExtendedAssetList,
  CometHarnessInterfaceExtendedAssetList,
  LiquidationModule,
  LiquidationModule__factory,
} from 'build/types';
import { ethers } from 'hardhat';
import { exp } from './math';

type DeployLiquidationModuleOpts = {
  comet: CometHarnessInterfaceExtendedAssetList | CometHarnessExtendedAssetList;
  governor: SignerWithAddress;
  multisig: string;
  executors: string[];
  pausers: string[];
  dexAdapter?: string;
  borderHF?: bigint;
  healthPositionHF?: bigint;
  penaltyBps?: bigint;
};

const DEFAULT_DEX_ADAPTER = '0x1111111111111111111111111111111111111111';
const DEFAULT_BORDER_HF = exp(102, 16); // 1.02e18
const DEFAULT_HEALTH_POSITION_HF = exp(110, 16); // 1.10e18
const DEFAULT_PENALTY_BPS = 500n; // 5% executor penalty on the DEX route

export async function deployAndUpdateLiquidationModule(
  opts: DeployLiquidationModuleOpts
): Promise<LiquidationModule> {
  const LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;

  // The DAO is derived from comet.governor() in the constructor. The Multisig, Executor and Pauser
  // roles are required and must be supplied explicitly by the caller (see makeProtocol/makeConfigurator,
  // which reserve dedicated signers for these roles and return them).
  const liquidationModule = await LiquidationModuleFactory.deploy(
    opts.comet.address,
    opts.multisig,
    opts.executors,
    opts.pausers,
    opts.dexAdapter ?? DEFAULT_DEX_ADAPTER,
    opts.borderHF ?? DEFAULT_BORDER_HF,
    opts.healthPositionHF ?? DEFAULT_HEALTH_POSITION_HF,
    opts.penaltyBps ?? DEFAULT_PENALTY_BPS
  );

  await opts.comet.connect(opts.governor).setLiquidationModule(liquidationModule.address);

  return liquidationModule;
}
