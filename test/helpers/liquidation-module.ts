import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { CometHarnessExtendedAssetList, CometHarnessInterfaceExtendedAssetList, DefaultLiquidationModule, DefaultLiquidationModule__factory } from 'build/types';
import { ethers } from 'hardhat';

export async function deployAndUpdateDefaultLiquidationModule(
  comet: CometHarnessInterfaceExtendedAssetList | CometHarnessExtendedAssetList,
  governor: SignerWithAddress
): Promise<DefaultLiquidationModule> {
  const DefaultLiquidationModuleFactory = (await ethers.getContractFactory('DefaultLiquidationModule')) as DefaultLiquidationModule__factory;
  const defaultLiquidationModule = await DefaultLiquidationModuleFactory.deploy(comet.address);

  await comet.connect(governor).setLiquidationModule(defaultLiquidationModule.address);
  
  return defaultLiquidationModule;
}