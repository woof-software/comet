import { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import { getHardhatEthers } from '../../plugins/deployment_manager/hardhat3/runtime.js';

export async function setNextBaseFeeToZero(dm: DeploymentManager) {
  const { provider } = await getHardhatEthers(dm.hre);
  await provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x0']);
}

// Directly sets an account's ETH balance via a single RPC (no block mined / tx signed),
// so scenarios can fund an impersonated signer for gas without the per-tx base-fee hack.
export async function setEtherBalance(dm: DeploymentManager, address: string, amount: bigint) {
  const { provider } = await getHardhatEthers(dm.hre);
  await provider.send('hardhat_setBalance', [address, '0x' + amount.toString(16)]);
}

export async function mineBlocks(dm: DeploymentManager, blocks: number) {
  const hex = `0x${blocks.toString(16)}`;

  const { provider } = await getHardhatEthers(dm.hre);
  await provider.send('hardhat_mine', [hex]);
}

export async function setNextBlockTimestamp(dm: DeploymentManager, timestamp: number) {
  const { provider } = await getHardhatEthers(dm.hre);
  await provider.send('evm_setNextBlockTimestamp', [timestamp]);
}
