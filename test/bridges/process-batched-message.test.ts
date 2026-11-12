import { ethers, expect } from '../helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction, utils } from 'ethers';
import { BaseBridgeReceiverHarness, Timelock } from '../../build/types';
import { takeSnapshot, SnapshotRestorer } from '../helpers/snapshot';
import {
  DELAY,
  MAX_BATCH_SIZE,
  ProposalState,
  Transaction,
  deployBaseBridgeReceiverFixture,
  encodeBatchedProposal,
  encodeProposal,
  mineAt,
  txHash,
} from './shared';

const BATCH_ID = utils.id('batch');
const OTHER_BATCH_ID = utils.id('other batch');

// processMessage also takes the message of a proposal in a batch: the 4 arrays of a proposal followed by the batch id,
// the zero-based index of the proposal in the batch and the batch size. The messages of a batch may arrive in any
// order; the receiver stores the batch and the index on the proposal, and the queued positions on the batch.
describe('base bridge receiver: processMessage (batched message)', function () {
  let receiver: BaseBridgeReceiverHarness;
  let localTimelock: Timelock;
  let govTimelock: SignerWithAddress;
  let other: SignerWithAddress;

  // One transaction for each position of a batch of 3, setting a different delay of the local timelock
  let setDelayTxs: Transaction[];

  let snapshot: SnapshotRestorer;

  function processMessage(data: string): Promise<ContractTransaction> {
    return receiver.processMessageExternal(govTimelock.address, data);
  }

  before(async () => {
    ({ receiver, localTimelock, govTimelock, other } = await deployBaseBridgeReceiverFixture());
    setDelayTxs = [0, 1, 2].map((i) => ({
      target: localTimelock.address,
      signature: 'setDelay(uint256)',
      calldata: utils.defaultAbiCoder.encode(['uint256'], [DELAY + i + 1]),
    }));
    snapshot = await takeSnapshot();
  });

  describe('happy path (first message of a batch)', function () {
    let processTx: ContractTransaction;
    let eta: number;

    before(async () => {
      // Necessary for test case: leaves the queued positions of the other batch 
      await processMessage(encodeBatchedProposal([], { batchId: OTHER_BATCH_ID, index: 0, size: 2 }));
      const queuedAt = (await ethers.provider.getBlock('latest')).timestamp + 100;
      eta = queuedAt + DELAY;
      await ethers.provider.send('evm_setNextBlockTimestamp', [queuedAt]);
    });

    after(async () => await snapshot.restore());

    it('queues position 1 of a batch of 3 before the other positions', async () => {
      processTx = await processMessage(encodeBatchedProposal([setDelayTxs[1]], { batchId: BATCH_ID, index: 1, size: 3 }));
      await expect(processTx).to.not.be.reverted;
    });

    it('emits ProposalCreated', async () => {
      const { target, signature, calldata } = setDelayTxs[1];
      await expect(processTx)
        .to.emit(receiver, 'ProposalCreated')
        .withArgs(govTimelock.address, 2, [target], [0], [signature], [calldata], eta);
    });

    it('emits ProposalBatched', async () => {
      await expect(processTx).to.emit(receiver, 'ProposalBatched').withArgs(2, BATCH_ID, 1, 3);
    });

    it('emits ProposalBatched after ProposalCreated', async () => {
      const { logs } = await processTx.wait();
      const events = logs
        .filter((log) => log.address === receiver.address)
        .map((log) => receiver.interface.parseLog(log).name);
      expect(events).to.deep.equal(['ProposalCreated', 'ProposalBatched']);
    });

    it('increments the proposal count', async () => {
      expect(await receiver.proposalCount()).to.equal(2);
    });

    it('stores the batch id on the proposal', async () => {
      expect((await receiver.proposals(2)).batchId).to.equal(BATCH_ID);
    });

    it('stores the index in the batch on the proposal', async () => {
      expect((await receiver.proposals(2)).batchIndex).to.equal(1);
    });

    it('stores the batch size', async () => {
      expect((await receiver.batches(BATCH_ID)).size).to.equal(3);
    });

    it('marks position 1 queued', async () => {
      expect((await receiver.batches(BATCH_ID)).queuedPositions).to.equal(0b010);
    });

    it('counts one queued proposal of the batch', async () => {
      expect(await receiver.batchQueuedCount(BATCH_ID)).to.equal(1);
    });

    it('counts no executed proposal of the batch', async () => {
      expect((await receiver.batches(BATCH_ID)).executedCount).to.equal(0);
    });

    it('reports the proposal as queued', async () => {
      expect(await receiver.state(2)).to.equal(ProposalState.Queued);
    });

    it('queues the transaction in the local timelock', async () => {
      expect(await localTimelock.queuedTransactions(txHash(setDelayTxs[1], eta))).to.be.true;
    });

    it('leaves the queued positions of the other batch', async () => {
      expect((await receiver.batches(OTHER_BATCH_ID)).queuedPositions).to.equal(0b1);
    });

    it('counts no queued proposal of a batch never delivered', async () => {
      expect(await receiver.batchQueuedCount(utils.id('unknown batch'))).to.equal(0);
    });
  });

  describe('happy path (next message of a batch)', function () {
    let processTx: ContractTransaction;

    before(async () => {
      // Setup proposals necessary for test cases
      await processMessage(encodeBatchedProposal([setDelayTxs[2]], { batchId: BATCH_ID, index: 2, size: 3 }));
    });

    after(async () => await snapshot.restore());

    it('queues position 0 after position 2', async () => {
      processTx = await processMessage(encodeBatchedProposal([setDelayTxs[0]], { batchId: BATCH_ID, index: 0, size: 3 }));
      await expect(processTx).to.not.be.reverted;
    });

    it('emits ProposalBatched', async () => {
      await expect(processTx).to.emit(receiver, 'ProposalBatched').withArgs(2, BATCH_ID, 0, 3);
    });

    it('stores the index in the batch on the proposal', async () => {
      expect((await receiver.proposals(2)).batchIndex).to.equal(0);
    });

    it('keeps the batch size', async () => {
      expect((await receiver.batches(BATCH_ID)).size).to.equal(3);
    });

    it('marks position 0 queued along with position 2', async () => {
      expect((await receiver.batches(BATCH_ID)).queuedPositions).to.equal(0b101);
    });

    it('counts two queued proposals of the batch', async () => {
      expect(await receiver.batchQueuedCount(BATCH_ID)).to.equal(2);
    });
  });

  describe('happy path (last message of a batch)', function () {
    before(async () => {
      // Setup proposals necessary for test cases
      await processMessage(encodeBatchedProposal([setDelayTxs[2]], { batchId: BATCH_ID, index: 2, size: 3 }));
      await processMessage(encodeBatchedProposal([setDelayTxs[0]], { batchId: BATCH_ID, index: 0, size: 3 }));
    });

    after(async () => await snapshot.restore());

    it('queues the missing position 1', async () => {
      await expect(processMessage(encodeBatchedProposal([setDelayTxs[1]], { batchId: BATCH_ID, index: 1, size: 3 })))
        .to.not.be.reverted;
    });

    it('marks every position queued', async () => {
      expect((await receiver.batches(BATCH_ID)).queuedPositions).to.equal(0b111);
    });

    it('counts three queued proposals of the batch', async () => {
      expect(await receiver.batchQueuedCount(BATCH_ID)).to.equal(3);
    });
  });

  describe(`happy path (batch of ${MAX_BATCH_SIZE}, the largest)`, function () {
    before(async () => {
      for (let index = MAX_BATCH_SIZE - 1; index > 0; --index) {
        await processMessage(encodeBatchedProposal([], { batchId: BATCH_ID, index, size: MAX_BATCH_SIZE }));
      }
    });

    after(async () => await snapshot.restore());

    it('queues the missing position 0', async () => {
      await expect(processMessage(encodeBatchedProposal([], { batchId: BATCH_ID, index: 0, size: MAX_BATCH_SIZE })))
        .to.not.be.reverted;
    });

    it('marks every position queued', async () => {
      expect((await receiver.batches(BATCH_ID)).queuedPositions).to.equal(ethers.constants.MaxUint256);
    });

    it(`counts ${MAX_BATCH_SIZE} queued proposals of the batch`, async () => {
      expect(await receiver.batchQueuedCount(BATCH_ID)).to.equal(MAX_BATCH_SIZE);
    });
  });

  describe('happy path (message outside any batch)', function () {
    let processTx: ContractTransaction;

    after(async () => await snapshot.restore());

    it('queues a message of 4 arrays', async () => {
      processTx = await processMessage(encodeProposal([setDelayTxs[0]]));
      await expect(processTx).to.not.be.reverted;
    });

    it('does not emit ProposalBatched', async () => {
      await expect(processTx).to.not.emit(receiver, 'ProposalBatched');
    });

    it('stores a zero batch id on the proposal', async () => {
      expect((await receiver.proposals(1)).batchId).to.equal(ethers.constants.HashZero);
    });

    it('stores a zero index on the proposal', async () => {
      expect((await receiver.proposals(1)).batchIndex).to.equal(0);
    });
  });

  describe('revert when', function () {
    afterEach(async () => await snapshot.restore());

    it('the sender is not the governing timelock', async () => {
      const data = encodeBatchedProposal([setDelayTxs[0]], { batchId: BATCH_ID, index: 0, size: 3 });
      await expect(receiver.processMessageExternal(other.address, data))
        .to.be.revertedWithCustomError(receiver, 'Unauthorized');
    });

    it('the batch id is zero', async () => {
      await expect(processMessage(encodeBatchedProposal([setDelayTxs[0]], { batchId: ethers.constants.HashZero, index: 0, size: 3 })))
        .to.be.revertedWithCustomError(receiver, 'BadData');
    });

    it('the size is zero', async () => {
      await expect(processMessage(encodeBatchedProposal([setDelayTxs[0]], { batchId: BATCH_ID, index: 0, size: 0 })))
        .to.be.revertedWithCustomError(receiver, 'BadData');
    });

    it('the index equals the size', async () => {
      await expect(processMessage(encodeBatchedProposal([setDelayTxs[0]], { batchId: BATCH_ID, index: 3, size: 3 })))
        .to.be.revertedWithCustomError(receiver, 'BadData');
    });

    it('the index is above the size', async () => {
      await expect(processMessage(encodeBatchedProposal([setDelayTxs[0]], { batchId: BATCH_ID, index: 4, size: 3 })))
        .to.be.revertedWithCustomError(receiver, 'BadData');
    });

    it(`the size is above ${MAX_BATCH_SIZE}`, async () => {
      await expect(processMessage(encodeBatchedProposal([setDelayTxs[0]], { batchId: BATCH_ID, index: 0, size: MAX_BATCH_SIZE + 1 })))
        .to.be.revertedWithCustomError(receiver, 'BadData');
    });

    it('a message carries a larger size than the batch, with an index out of the batch', async () => {
      await processMessage(encodeBatchedProposal([setDelayTxs[0]], { batchId: BATCH_ID, index: 0, size: 3 }));
      await expect(processMessage(encodeBatchedProposal([setDelayTxs[1]], { batchId: BATCH_ID, index: 3, size: 4 })))
        .to.be.revertedWithCustomError(receiver, 'BadData');
    });

    it('a message carries a smaller size than the batch', async () => {
      await processMessage(encodeBatchedProposal([setDelayTxs[0]], { batchId: BATCH_ID, index: 0, size: 3 }));
      await expect(processMessage(encodeBatchedProposal([setDelayTxs[1]], { batchId: BATCH_ID, index: 1, size: 2 })))
        .to.be.revertedWithCustomError(receiver, 'BadData');
    });

    it('the same message arrives twice', async () => {
      const data = encodeBatchedProposal([setDelayTxs[0]], { batchId: BATCH_ID, index: 0, size: 3 });
      await processMessage(data);
      await expect(processMessage(data)).to.be.revertedWithCustomError(receiver, 'BatchPositionAlreadyQueued');
    });

    it('another message takes a queued position', async () => {
      await processMessage(encodeBatchedProposal([setDelayTxs[0]], { batchId: BATCH_ID, index: 0, size: 3 }));
      await expect(processMessage(encodeBatchedProposal([setDelayTxs[1]], { batchId: BATCH_ID, index: 0, size: 3 })))
        .to.be.revertedWithCustomError(receiver, 'BatchPositionAlreadyQueued');
    });

    it('a message reuses the id of an executed batch', async () => {
      const data = encodeBatchedProposal([setDelayTxs[0]], { batchId: BATCH_ID, index: 0, size: 1 });
      await processMessage(data);
      await mineAt((await receiver.proposals(1)).eta);
      await receiver.executeProposal(1);
      await expect(processMessage(data)).to.be.revertedWithCustomError(receiver, 'BatchPositionAlreadyQueued');
    });

    it('the values and targets of a batched message differ in length', async () => {
      const { target, signature, calldata } = setDelayTxs[0];
      const data = utils.defaultAbiCoder.encode(
        ['address[]', 'uint256[]', 'string[]', 'bytes[]', 'bytes32', 'uint256', 'uint256'],
        [[target], [0, 0], [signature], [calldata], BATCH_ID, 0, 3]
      );
      await expect(processMessage(data)).to.be.revertedWithCustomError(receiver, 'BadData');
    });

    it('the message carries a batch id and an index but no size', async () => {
      const { target, signature, calldata } = setDelayTxs[0];
      const data = utils.defaultAbiCoder.encode(
        ['address[]', 'uint256[]', 'string[]', 'bytes[]', 'bytes32', 'uint256'],
        [[target], [0], [signature], [calldata], BATCH_ID, 0]
      );
      await expect(processMessage(data)).to.be.revertedWithCustomError(receiver, 'BadData');
    });

    it('the message is empty', async () => {
      await expect(processMessage('0x')).to.be.reverted;
    });
  });
});
