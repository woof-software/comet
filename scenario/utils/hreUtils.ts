import { DeploymentManager } from '../../plugins/deployment_manager';

export async function setNextBaseFeeToZero(dm: DeploymentManager) {
  await dm.hre.network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x0']);
}

// Directly sets an account's ETH balance via a single RPC (no block mined / tx signed),
// so scenarios can fund an impersonated signer for gas without the per-tx base-fee hack.
export async function setEtherBalance(dm: DeploymentManager, address: string, amount: bigint) {
  await dm.hre.network.provider.send('hardhat_setBalance', [address, '0x' + amount.toString(16)]);
}

export async function mineBlocks(dm: DeploymentManager, blocks: number) {
  const hex = `0x${blocks.toString(16)}`;

  await dm.hre.network.provider.send('hardhat_mine', [hex]);
}

export async function setNextBlockTimestamp(dm: DeploymentManager, timestamp: number) {
  await dm.hre.ethers.provider.send('evm_setNextBlockTimestamp', [timestamp]);
}