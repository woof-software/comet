import { ethers, expect } from '../helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BigNumber, ContractTransaction, utils } from 'ethers';
import { BaseBridgeReceiverHarness, Timelock } from '../../build/types';
import { takeSnapshot, SnapshotRestorer } from '../helpers/snapshot';
import {
  DELAY,
  GRACE_PERIOD,
  MAX_BATCH_SIZE,
  ProposalState,
  deployBaseBridgeReceiverFixture,
  encodeBatchedProposal,
  encodeProposal,
  mineAt,
} from './shared';

const BATCH_ID = utils.id('batch');
const INCOMPLETE_BATCH_ID = utils.id('incomplete batch');
const SINGLE_BATCH_ID = utils.id('single batch');
const LARGEST_BATCH_ID = utils.id('largest batch');

// Delays set by the proposals at positions 0, 1 and 2 of the batch
const DELAYS = [2 * DELAY, 3 * DELAY, 4 * DELAY];

// Proposal ids, in the order of delivery: the batch of 3 arrives as positions 2, 0, 1
const POSITION_2 = 1;
const POSITION_0 = 2;
const POSITION_1 = 3;
const INCOMPLETE_BATCH_POSITION_0 = 4;
const OUTSIDE_BATCH = 5;
const SINGLE_BATCH_POSITION_0 = 6;

// A proposal of a batch executes only once every proposal of the batch is queued, and only right after the previous
// position of the batch. Proposals outside any batch and proposals of other batches execute independently.
describe('base bridge receiver: executeProposal (batched proposal)', function () {
  let receiver: BaseBridgeReceiverHarness;
  let localTimelock: Timelock;
  let govTimelock: SignerWithAddress;
  let other: SignerWithAddress;

  // Time from which every proposal of the fixture is executable
  let executableAt: BigNumber;

  let snapshot: SnapshotRestorer;

  function processMessage(data: string): Promise<ContractTransaction> {
    return receiver.processMessageExternal(govTimelock.address, data);
  }

  before(async () => {
    ({ receiver, localTimelock, govTimelock, other } = await deployBaseBridgeReceiverFixture());
    const setDelayTxs = DELAYS.map((delay) => ({
      target: localTimelock.address,
      signature: 'setDelay(uint256)',
      calldata: utils.defaultAbiCoder.encode(['uint256'], [delay]),
    }));

    // One message a minute, so that the etas are a minute apart
    const messages = [
      encodeBatchedProposal([setDelayTxs[2]], { batchId: BATCH_ID, index: 2, size: 3 }),
      encodeBatchedProposal([setDelayTxs[0]], { batchId: BATCH_ID, index: 0, size: 3 }),
      encodeBatchedProposal([setDelayTxs[1]], { batchId: BATCH_ID, index: 1, size: 3 }),
      encodeBatchedProposal([], { batchId: INCOMPLETE_BATCH_ID, index: 0, size: 2 }),
      encodeProposal([]),
      encodeBatchedProposal([], { batchId: SINGLE_BATCH_ID, index: 0, size: 1 }),
    ];
    const start = (await ethers.provider.getBlock('latest')).timestamp + 60;
    for (const [i, data] of messages.entries()) {
      await ethers.provider.send('evm_setNextBlockTimestamp', [start + 60 * i]);
      await processMessage(data);
    }

    ({ eta: executableAt } = await receiver.proposals(SINGLE_BATCH_POSITION_0));
    snapshot = await takeSnapshot();
  });

  describe('happy path (first position)', function () {
    let executeTx: ContractTransaction;

    before(async () => await ethers.provider.send('evm_setNextBlockTimestamp', [executableAt.toNumber()]));

    after(async () => await snapshot.restore());

    it('any address executes position 0 of a complete batch delivered out of order', async () => {
      executeTx = await receiver.connect(other).executeProposal(POSITION_0);
      await expect(executeTx).to.not.be.reverted;
    });

    it('emits ProposalExecuted', async () => {
      await expect(executeTx).to.emit(receiver, 'ProposalExecuted').withArgs(POSITION_0);
    });

    it('applies the transaction', async () => {
      expect(await localTimelock.delay()).to.equal(DELAYS[0]);
    });

    it('reports the proposal as executed', async () => {
      expect(await receiver.state(POSITION_0)).to.equal(ProposalState.Executed);
    });

    it('counts one executed proposal of the batch', async () => {
      expect((await receiver.batches(BATCH_ID)).executedCount).to.equal(1);
    });

    it('leaves position 1 queued', async () => {
      expect(await receiver.state(POSITION_1)).to.equal(ProposalState.Queued);
    });

    it('leaves position 2 queued', async () => {
      expect(await receiver.state(POSITION_2)).to.equal(ProposalState.Queued);
    });
  });

  describe('happy path (last position)', function () {
    let executeTx: ContractTransaction;

    before(async () => {
      await mineAt(executableAt);
      await receiver.executeProposal(POSITION_0);
      await receiver.executeProposal(POSITION_1);
    });

    after(async () => await snapshot.restore());

    it('executes position 2 after positions 0 and 1', async () => {
      executeTx = await receiver.executeProposal(POSITION_2);
      await expect(executeTx).to.not.be.reverted;
    });

    it('emits ProposalExecuted', async () => {
      await expect(executeTx).to.emit(receiver, 'ProposalExecuted').withArgs(POSITION_2);
    });

    it('applies the transaction of position 2 last', async () => {
      expect(await localTimelock.delay()).to.equal(DELAYS[2]);
    });

    it('reports the proposal as executed', async () => {
      expect(await receiver.state(POSITION_2)).to.equal(ProposalState.Executed);
    });

    it('counts three executed proposals of the batch', async () => {
      expect((await receiver.batches(BATCH_ID)).executedCount).to.equal(3);
    });
  });

  describe('happy path (proposal outside any batch)', function () {
    before(async () => await ethers.provider.send('evm_setNextBlockTimestamp', [executableAt.toNumber()]));

    after(async () => await snapshot.restore());

    it('executes a proposal outside any batch while batches are pending', async () => {
      await expect(receiver.executeProposal(OUTSIDE_BATCH)).to.not.be.reverted;
    });

    it('leaves the batch unexecuted', async () => {
      expect((await receiver.batches(BATCH_ID)).executedCount).to.equal(0);
    });
  });

  describe('happy path (batches interleave)', function () {
    before(async () => {
      await mineAt(executableAt);
      await receiver.executeProposal(POSITION_0);
    });

    after(async () => await snapshot.restore());

    it('executes a proposal of another batch between positions of a batch', async () => {
      await expect(receiver.executeProposal(SINGLE_BATCH_POSITION_0)).to.not.be.reverted;
    });

    it('counts one executed proposal of the other batch', async () => {
      expect((await receiver.batches(SINGLE_BATCH_ID)).executedCount).to.equal(1);
    });

    it('leaves the progress of the batch', async () => {
      expect((await receiver.batches(BATCH_ID)).executedCount).to.equal(1);
    });
  });

  describe(`happy path (batch of ${MAX_BATCH_SIZE}, the largest)`, function () {
    // Delivered as positions 255 down to 0, so the proposal at position `index` has the id `idOf(index)`
    const idOf = (index: number) => SINGLE_BATCH_POSITION_0 + MAX_BATCH_SIZE - index;

    before(async () => {
      for (let index = MAX_BATCH_SIZE - 1; index >= 0; --index) {
        await processMessage(encodeBatchedProposal([], { batchId: LARGEST_BATCH_ID, index, size: MAX_BATCH_SIZE }));
      }
      await mineAt((await receiver.proposals(idOf(0))).eta);
      for (let index = 0; index < MAX_BATCH_SIZE - 1; ++index) {
        await receiver.executeProposal(idOf(index));
      }
    });

    after(async () => await snapshot.restore());

    it(`executes position ${MAX_BATCH_SIZE - 1} last`, async () => {
      await expect(receiver.executeProposal(idOf(MAX_BATCH_SIZE - 1))).to.not.be.reverted;
    });

    it(`counts ${MAX_BATCH_SIZE} executed proposals of the batch`, async () => {
      expect((await receiver.batches(LARGEST_BATCH_ID)).executedCount).to.equal(MAX_BATCH_SIZE);
    });
  });

  describe('revert when', function () {
    afterEach(async () => await snapshot.restore());

    it('a position of the batch is not queued', async () => {
      await mineAt(executableAt);
      await expect(receiver.executeProposal(INCOMPLETE_BATCH_POSITION_0))
        .to.be.revertedWithCustomError(receiver, 'BatchIncomplete');
    });

    it(`one position of a batch of ${MAX_BATCH_SIZE} is not queued`, async () => {
      // Positions 1 to 255, the proposal at position 1 is the first delivered
      for (let index = 1; index < MAX_BATCH_SIZE; ++index) {
        await processMessage(encodeBatchedProposal([], { batchId: LARGEST_BATCH_ID, index, size: MAX_BATCH_SIZE }));
      }
      const position1 = SINGLE_BATCH_POSITION_0 + 1;
      await mineAt((await receiver.proposals(await receiver.proposalCount())).eta);
      await expect(receiver.executeProposal(position1)).to.be.revertedWithCustomError(receiver, 'BatchIncomplete');
    });

    it('position 1 executes before position 0', async () => {
      await mineAt(executableAt);
      await expect(receiver.executeProposal(POSITION_1)).to.be.revertedWithCustomError(receiver, 'ProposalOutOfOrder');
    });

    it('position 2 executes before position 1', async () => {
      await mineAt(executableAt);
      await receiver.executeProposal(POSITION_0);
      await expect(receiver.executeProposal(POSITION_2)).to.be.revertedWithCustomError(receiver, 'ProposalOutOfOrder');
    });

    it('position 0 executes twice', async () => {
      await mineAt(executableAt);
      await receiver.executeProposal(POSITION_0);
      await expect(receiver.executeProposal(POSITION_0)).to.be.revertedWithCustomError(receiver, 'ProposalNotExecutable');
    });

    it('the previous position expired unexecuted', async () => {
      // Position 1 is queued a minute after position 0, so it is still executable when position 0 expires
      const { eta } = await receiver.proposals(POSITION_0);
      await mineAt(eta.add(GRACE_PERIOD).add(1));
      await expect(receiver.executeProposal(POSITION_1)).to.be.revertedWithCustomError(receiver, 'ProposalOutOfOrder');
    });
  });
});
