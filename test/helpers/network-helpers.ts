import hre from 'hardhat';
import { ethers } from 'hardhat';

interface EthersBigNumberLike {
  toHexString(): string;
}

interface BNLike {
  toNumber(): number;
  toString(base?: number): string;
}

export type NumberLike =
  | number
  | bigint
  | string
  | EthersBigNumberLike
  | BNLike;

/**
 * Sets the balance for the given address.
 *
 * @param address The address whose balance will be edited.
 * @param balance The new balance to set for the given address, in wei.
 */
export async function setBalance(
  address: string,
  balance: NumberLike
): Promise<void> {
  if (!ethers.utils.isAddress(address)) {
    throw new Error(`${address} is not a valid address`);
  }

  let balanceHex: string;
  if (typeof balance === 'bigint' || typeof balance === 'number') {
    balanceHex = `0x${balance.toString(16)}`;
  } else if (typeof balance === 'string') {
    // decimal string, or an already hex-encoded value
    balanceHex = balance.startsWith('0x') ? balance : `0x${BigInt(balance).toString(16)}`;
  } else if (typeof (balance as EthersBigNumberLike).toHexString === 'function') {
    // ethers BigNumber (e.g. ethers.utils.parseEther). String(BigNumber) is decimal, so it must not be prefixed with 0x
    balanceHex = (balance as EthersBigNumberLike).toHexString();
  } else if (typeof (balance as BNLike).toNumber === 'function') {
    // BN.js-like value: toString(16) gives hex
    balanceHex = `0x${(balance as BNLike).toString(16)}`;
  } else {
    throw new Error(`setBalance: unsupported balance type for ${String(balance)}`);
  }

  // Normalize: drop leading zeros, keep at least one digit (e.g. ethers' 0 is "0x00", which must become "0x0")
  balanceHex = `0x${balanceHex.slice(2).replace(/^0+/, '') || '0'}`;

  await hre.network.provider.request({
    method: 'hardhat_setBalance',
    params: [address, balanceHex],
  });
}

/**
 * Allows Hardhat Network to sign transactions as the given address
 *
 * @param address The address to impersonate
 */
export async function impersonateAccount(address: string): Promise<void> {
  if (!ethers.utils.isAddress(address)) {
    throw new Error(`${address} is not a valid address`);
  }

  await hre.network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [address],
  });
}

