import { ethers } from '../helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BigNumberish, utils } from 'ethers';
import {
  BaseBridgeReceiverHarness__factory,
  SweepableBridgeReceiverHarness__factory,
  Timelock,
  Timelock__factory,
} from '../../build/types';

export const DELAY = 10 * 60;
export const GRACE_PERIOD = 14 * 24 * 60 * 60;
export const MAX_BATCH_SIZE = 256;

export enum ProposalState {
  Queued,
  Expired,
  Executed,
}

export type Transaction = { target: string, signature: string, calldata: string };

export type BatchPosition = { batchId: string, index: number, size: number };

export function encodeProposal(txs: Transaction[]): string {
  return utils.defaultAbiCoder.encode(
    ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
    [txs.map((tx) => tx.target), txs.map(() => 0), txs.map((tx) => tx.signature), txs.map((tx) => tx.calldata)]
  );
}

export function encodeBatchedProposal(txs: Transaction[], { batchId, index, size }: BatchPosition): string {
  return utils.defaultAbiCoder.encode(
    ['address[]', 'uint256[]', 'string[]', 'bytes[]', 'bytes32', 'uint256', 'uint256'],
    [txs.map((tx) => tx.target), txs.map(() => 0), txs.map((tx) => tx.signature), txs.map((tx) => tx.calldata), batchId, index, size]
  );
}

// Key of a queued transaction in Timelock.queuedTransactions
export function txHash(tx: Transaction, eta: BigNumberish): string {
  return utils.keccak256(
    utils.defaultAbiCoder.encode(
      ['address', 'uint256', 'string', 'bytes', 'uint256'],
      [tx.target, 0, tx.signature, tx.calldata, eta]
    )
  );
}

export async function mineAt(timestamp: BigNumberish) {
  await ethers.provider.send('evm_setNextBlockTimestamp', [Number(timestamp)]);
  await ethers.provider.send('evm_mine', []);
}

// Deploys the local timelock like on a fresh chain: its admin is the contract the deployer deploys next, the receiver
async function deployLocalTimelock(deployer: SignerWithAddress): Promise<Timelock> {
  const receiverAddress = utils.getContractAddress({ from: deployer.address, nonce: (await deployer.getTransactionCount()) + 1 });
  const TimelockFactory = (await ethers.getContractFactory('Timelock')) as Timelock__factory;
  return TimelockFactory.deploy(receiverAddress, DELAY, GRACE_PERIOD, DELAY, 30 * 24 * 60 * 60);
}

export async function deployBaseBridgeReceiverFixture() {
  const [deployer, govTimelock, other] = await ethers.getSigners();

  const localTimelock = await deployLocalTimelock(deployer);
  const ReceiverFactory = (await ethers.getContractFactory('BaseBridgeReceiverHarness')) as BaseBridgeReceiverHarness__factory;
  const receiver = await ReceiverFactory.deploy(govTimelock.address, localTimelock.address);

  return { ReceiverFactory, receiver, localTimelock, govTimelock, other };
}

export async function deploySweepableBridgeReceiverFixture() {
  const [deployer, govTimelock, other] = await ethers.getSigners();

  const localTimelock = await deployLocalTimelock(deployer);
  const ReceiverFactory = (await ethers.getContractFactory('SweepableBridgeReceiverHarness')) as SweepableBridgeReceiverHarness__factory;
  const receiver = await ReceiverFactory.deploy(govTimelock.address, localTimelock.address);

  return { receiver, localTimelock, govTimelock, other };
}
