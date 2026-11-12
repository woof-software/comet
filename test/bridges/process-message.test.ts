import { ethers, expect } from '../helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction, utils } from 'ethers';
import { BaseBridgeReceiverHarness, Timelock } from '../../build/types';
import { takeSnapshot, SnapshotRestorer } from '../helpers/snapshot';
import { DELAY, ProposalState, Transaction, deployBaseBridgeReceiverFixture, encodeProposal, txHash } from './shared';

const PROPOSAL_TYPES = ['address[]', 'uint256[]', 'string[]', 'bytes[]'];

// processMessage queues the transactions of a message from the governing timelock in the local timelock, with an eta
// of the queueing time plus the timelock delay, and stores them as a new proposal. The harness exposes it as
// processMessageExternal, in place of the entry point of each chain.
describe('base bridge receiver: processMessage', function () {
  let receiver: BaseBridgeReceiverHarness;
  let localTimelock: Timelock;
  let govTimelock: SignerWithAddress;
  let other: SignerWithAddress;

  // Two transactions setting the delay of the local timelock
  let setDelayTxs: Transaction[];
  let targets: string[];
  let signatures: string[];
  let calldatas: string[];

  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ receiver, localTimelock, govTimelock, other } = await deployBaseBridgeReceiverFixture());
    setDelayTxs = [42, 43].map((delay) => ({
      target: localTimelock.address,
      signature: 'setDelay(uint256)',
      calldata: utils.defaultAbiCoder.encode(['uint256'], [delay]),
    }));
    targets = setDelayTxs.map((tx) => tx.target);
    signatures = setDelayTxs.map((tx) => tx.signature);
    calldatas = setDelayTxs.map((tx) => tx.calldata);
    snapshot = await takeSnapshot();
  });

  describe('happy path', function () {
    let processTx: ContractTransaction;
    let eta: number;

    before(async () => {
      const queuedAt = (await ethers.provider.getBlock('latest')).timestamp + 100;
      eta = queuedAt + DELAY;
      await ethers.provider.send('evm_setNextBlockTimestamp', [queuedAt]);
    });

    after(async () => await snapshot.restore());

    it('queues a message from the governing timelock', async () => {
      processTx = await receiver.processMessageExternal(govTimelock.address, encodeProposal(setDelayTxs));
      await expect(processTx).to.not.be.reverted;
    });

    it('emits ProposalCreated', async () => {
      await expect(processTx)
        .to.emit(receiver, 'ProposalCreated')
        .withArgs(govTimelock.address, 1, targets, [0, 0], signatures, calldatas, eta);
    });

    it('increments the proposal count', async () => {
      expect(await receiver.proposalCount()).to.equal(1);
    });

    it('stores the proposal id', async () => {
      expect((await receiver.proposals(1)).id).to.equal(1);
    });

    it('stores the eta as the queueing time plus the local timelock delay', async () => {
      expect((await receiver.proposals(1)).eta).to.equal(eta);
    });

    it('stores the proposal as not executed', async () => {
      expect((await receiver.proposals(1)).executed).to.be.false;
    });

    it('reports the proposal as queued', async () => {
      expect(await receiver.state(1)).to.equal(ProposalState.Queued);
    });

    [0, 1].forEach((i) => {
      it(`queues transaction #${i + 1} in the local timelock`, async () => {
        expect(await localTimelock.queuedTransactions(txHash(setDelayTxs[i], eta))).to.be.true;
      });
    });
  });

  describe('revert when', function () {
    it('the sender is not the governing timelock', async () => {
      await expect(receiver.processMessageExternal(other.address, encodeProposal(setDelayTxs)))
        .to.be.revertedWithCustomError(receiver, 'Unauthorized');
    });

    it('values and targets differ in length', async () => {
      const data = utils.defaultAbiCoder.encode(PROPOSAL_TYPES, [targets, [0], signatures, calldatas]);
      await expect(receiver.processMessageExternal(govTimelock.address, data))
        .to.be.revertedWithCustomError(receiver, 'BadData');
    });

    it('signatures and targets differ in length', async () => {
      const data = utils.defaultAbiCoder.encode(PROPOSAL_TYPES, [targets, [0, 0], signatures.slice(1), calldatas]);
      await expect(receiver.processMessageExternal(govTimelock.address, data))
        .to.be.revertedWithCustomError(receiver, 'BadData');
    });

    it('calldatas and targets differ in length', async () => {
      const data = utils.defaultAbiCoder.encode(PROPOSAL_TYPES, [targets, [0, 0], signatures, calldatas.slice(1)]);
      await expect(receiver.processMessageExternal(govTimelock.address, data))
        .to.be.revertedWithCustomError(receiver, 'BadData');
    });

    it('a transaction repeats in the message', async () => {
      await expect(receiver.processMessageExternal(govTimelock.address, encodeProposal([setDelayTxs[0], setDelayTxs[0]])))
        .to.be.revertedWithCustomError(receiver, 'TransactionAlreadyQueued');
    });
  });
});
