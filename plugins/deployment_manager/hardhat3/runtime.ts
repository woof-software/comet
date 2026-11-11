import type { HardhatEthers } from '@nomicfoundation/hardhat-ethers/types';
import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import type { NetworkConnection } from 'hardhat/types/network';

export async function getDefaultConnection(
  hre: HardhatRuntimeEnvironment
): Promise<NetworkConnection> {
  return hre.network.getOrCreate();
}

export async function getHardhatEthers(
  hre: HardhatRuntimeEnvironment
): Promise<HardhatEthers> {
  return (await getDefaultConnection(hre)).ethers;
}
