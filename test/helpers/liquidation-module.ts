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
  dexAdapter?: string;
  borderHF?: bigint;
  healthPositionHF?: bigint;
};

const DEFAULT_DEX_ADAPTER = '0x1111111111111111111111111111111111111111';
const DEFAULT_BORDER_HF = exp(102, 16); // 1.02e18
const DEFAULT_HEALTH_POSITION_HF = exp(110, 16); // 1.10e18

export async function deployAndUpdateLiquidationModule(
  opts: DeployLiquidationModuleOpts
): Promise<LiquidationModule> {
  const LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;

  const liquidationModule = await LiquidationModuleFactory.deploy(
    opts.comet.address,
    opts.dexAdapter ?? DEFAULT_DEX_ADAPTER,
    opts.borderHF ?? DEFAULT_BORDER_HF,
    opts.healthPositionHF ?? DEFAULT_HEALTH_POSITION_HF
  );

  await opts.comet.connect(opts.governor).setLiquidationModule(liquidationModule.address);

  return liquidationModule;
}
