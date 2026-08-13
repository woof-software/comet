import type { Contract, ContractFactory, Provider, Signer } from 'ethers';
import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import type { NetworkConnection } from 'hardhat/types/network';

export interface ProjectEthers {
  provider: Provider;
  getSigners(): Promise<Signer[]>;
  getSigner(address: string): Promise<Signer>;
  getContractFactory(name: string): Promise<ContractFactory<any[], Contract>>;
}

export async function getDefaultConnection(
  hre: HardhatRuntimeEnvironment
): Promise<NetworkConnection> {
  return hre.network.getOrCreate();
}

export async function getHardhatEthers(
  hre: HardhatRuntimeEnvironment
): Promise<ProjectEthers> {
  return (await getDefaultConnection(hre)).ethers as unknown as ProjectEthers;
}
