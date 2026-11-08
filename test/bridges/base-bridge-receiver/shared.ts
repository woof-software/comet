import { ethers } from '../../helpers';
import { BigNumberish, utils } from 'ethers';
import { BaseBridgeReceiverHarness__factory, Timelock, Timelock__factory } from '../../../build/types';

export const DELAY = 10 * 60;
export const GRACE_PERIOD = 14 * 24 * 60 * 60;

export enum ProposalState {
  Queued,
  Expired,
  Executed,
  Canceled,
}

export type Transaction = { target: string, signature: string, calldata: string };

export function encodeProposal(txs: Transaction[]): string {
  return utils.defaultAbiCoder.encode(
    ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
    [txs.map((tx) => tx.target), txs.map(() => 0), txs.map((tx) => tx.signature), txs.map((tx) => tx.calldata)]
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

// Deploys like a fresh chain: the local timelock gets the receiver as its admin at the address the receiver is deployed at next
export async function deployBaseBridgeReceiverFixture() {
  const [deployer, govTimelock, guardian, other] = await ethers.getSigners();

  const receiverAddress = utils.getContractAddress({ from: deployer.address, nonce: (await deployer.getTransactionCount()) + 1 });
  const TimelockFactory = (await ethers.getContractFactory('Timelock')) as Timelock__factory;
  const localTimelock: Timelock = await TimelockFactory.deploy(receiverAddress, DELAY, GRACE_PERIOD, DELAY, 30 * 24 * 60 * 60);

  const ReceiverFactory = (await ethers.getContractFactory('BaseBridgeReceiverHarness')) as BaseBridgeReceiverHarness__factory;
  const receiver = await ReceiverFactory.deploy(govTimelock.address, localTimelock.address, guardian.address);

  return { ReceiverFactory, receiver, localTimelock, govTimelock, guardian, other };
}
