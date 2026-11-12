import { ethers, expect } from '../helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BigNumber, ContractTransaction, utils } from 'ethers';
import { BaseBridgeReceiverHarness, Timelock } from '../../build/types';
import { takeSnapshot, SnapshotRestorer } from '../helpers/snapshot';
import {
  DELAY,
  GRACE_PERIOD,
  ProposalState,
  Transaction,
  deployBaseBridgeReceiverFixture,
  encodeProposal,
  mineAt,
  txHash,
} from './shared';

// executeProposal executes the transactions of a queued proposal through the local timelock, from its eta until the end
// of the local timelock grace period. Any address can call it.
describe('base bridge receiver: executeProposal', function () {
  let receiver: BaseBridgeReceiverHarness;
  let localTimelock: Timelock;
  let govTimelock: SignerWithAddress;
  let other: SignerWithAddress;

  // Proposal #1 doubles the delay of the local timelock
  let setDelayTx: Transaction;
  let eta: BigNumber;

  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ receiver, localTimelock, govTimelock, other } = await deployBaseBridgeReceiverFixture());
    setDelayTx = {
      target: localTimelock.address,
      signature: 'setDelay(uint256)',
      calldata: utils.defaultAbiCoder.encode(['uint256'], [2 * DELAY]),
    };
    await receiver.processMessageExternal(govTimelock.address, encodeProposal([setDelayTx]));
    ({ eta } = await receiver.proposals(1));
    snapshot = await takeSnapshot();
  });

  describe('happy path', function () {
    let executeTx: ContractTransaction;

    before(async () => await ethers.provider.send('evm_setNextBlockTimestamp', [eta.toNumber()]));

    after(async () => await snapshot.restore());

    it('any address executes the proposal at its eta', async () => {
      executeTx = await receiver.connect(other).executeProposal(1);
      await expect(executeTx).to.not.be.reverted;
    });

    it('emits ProposalExecuted', async () => {
      await expect(executeTx).to.emit(receiver, 'ProposalExecuted').withArgs(1);
    });

    it('applies the transaction', async () => {
      expect(await localTimelock.delay()).to.equal(2 * DELAY);
    });

    it('removes the transaction from the local timelock queue', async () => {
      expect(await localTimelock.queuedTransactions(txHash(setDelayTx, eta))).to.be.false;
    });

    it('marks the proposal executed', async () => {
      expect((await receiver.proposals(1)).executed).to.be.true;
    });

    it('reports the proposal as executed', async () => {
      expect(await receiver.state(1)).to.equal(ProposalState.Executed);
    });
  });

  describe('happy path (end of the grace period)', function () {
    before(async () => await ethers.provider.send('evm_setNextBlockTimestamp', [eta.add(GRACE_PERIOD).toNumber()]));

    after(async () => await snapshot.restore());

    it('executes the proposal at the last second of the grace period', async () => {
      await expect(receiver.executeProposal(1)).to.not.be.reverted;
    });
  });

  describe('revert when', function () {
    afterEach(async () => await snapshot.restore());

    it('the eta is not reached', async () => {
      await expect(receiver.executeProposal(1))
        .to.be.revertedWith('Timelock::executeTransaction: Transaction hasn\'t surpassed time lock.');
    });

    it('the proposal is expired', async () => {
      await mineAt(eta.add(GRACE_PERIOD).add(1));
      await expect(receiver.executeProposal(1)).to.be.revertedWithCustomError(receiver, 'ProposalNotExecutable');
    });

    it('the proposal is already executed', async () => {
      await ethers.provider.send('evm_setNextBlockTimestamp', [eta.toNumber()]);
      await receiver.executeProposal(1);
      await expect(receiver.executeProposal(1)).to.be.revertedWithCustomError(receiver, 'ProposalNotExecutable');
    });

    it('the proposal id is zero', async () => {
      await expect(receiver.executeProposal(0)).to.be.revertedWithCustomError(receiver, 'InvalidProposalId');
    });

    it('the proposal id is above the proposal count', async () => {
      await expect(receiver.executeProposal(2)).to.be.revertedWithCustomError(receiver, 'InvalidProposalId');
    });
  });
});
