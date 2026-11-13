import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { utils } from 'ethers';
import { DeploymentManager } from '../../plugins/deployment_manager';

// EIP-1967 admin slot: bytes32(uint256(keccak256('eip1967.proxy.admin')) - 1)
const EIP1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

// Offset that Arbitrum and OP-stack chains add to an L1 contract's address when it sends a message to L2
const L1_TO_L2_ALIAS_OFFSET = 0x1111000000000000000000000000000000001111n;

/**
 * Impersonates an account on the fork, optionally funding it with ETH first.
 * @param dm Deployment manager of the network to impersonate on
 * @param address Account to impersonate
 * @param value Optional ETH amount (wei) added to the account's current balance
 * @returns A signer that sends transactions as `address`
 */
export async function impersonateAddress(dm: DeploymentManager, address: string, value?: bigint): Promise<SignerWithAddress> {
  if (value) {
    const balance = (await dm.hre.ethers.provider.getBalance(address)).toBigInt();
    await setEtherBalance(dm, address, balance + value);
  }
  await dm.hre.network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [address],
  });
  return await dm.getSigner(address);
}

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

/**
 * Returns the address an L1 contract appears as on L2 (msg.sender of its relayed messages).
 * @param address L1 address, e.g. the governor timelock
 * @returns The aliased L2 address, lowercase hex
 */
export function applyL1ToL2Alias(address: string): string {
  return `0x${(BigInt(address) + L1_TO_L2_ALIAS_OFFSET).toString(16)}`;
}

/**
 * Reads the admin of an EIP-1967 proxy from its admin storage slot.
 * @param dm Deployment manager of the network the proxy lives on
 * @param proxyAddress Address of the proxy
 * @returns Checksummed address of the proxy admin
 */
export async function getProxyAdmin(dm: DeploymentManager, proxyAddress: string): Promise<string> {
  const slotValue = await dm.hre.ethers.provider.getStorageAt(proxyAddress, EIP1967_ADMIN_SLOT);
  return utils.getAddress(utils.hexDataSlice(slotValue, 12));
}
