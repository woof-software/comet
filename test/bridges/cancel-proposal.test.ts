import { ethers, expect } from '../helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BigNumber, ContractTransaction, utils } from 'ethers';
import { BaseBridgeReceiverHarness, Timelock } from '../../build/types';
import { takeSnapshot, SnapshotRestorer } from '../helpers/snapshot';
import {
  GRACE_PERIOD,
  ProposalState,
  Transaction,
  deployBaseBridgeReceiverFixture,
  encodeProposal,
  mineAt,
  txHash,
} from './shared';

// cancelProposal lets the guardian cancel a queued proposal, before or after its eta, together with its transactions in
// the local timelock. A proposal calling setGuardian on the receiver can't be canceled.
describe('base bridge receiver: cancelProposal', function () {
  let receiver: BaseBridgeReceiverHarness;
  let localTimelock: Timelock;
  let govTimelock: SignerWithAddress;
  let guardian: SignerWithAddress;
  let other: SignerWithAddress;

  // Proposal #1 sets the delay twice, the other transaction is for proposals queued later
  let setDelayTxs: Transaction[];
  let otherSetDelayTx: Transaction;
  let eta: BigNumber;

  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ receiver, localTimelock, govTimelock, guardian, other } = await deployBaseBridgeReceiverFixture());
    [otherSetDelayTx, ...setDelayTxs] = [40, 20, 30].map((minutes) => ({
      target: localTimelock.address,
      signature: 'setDelay(uint256)',
      calldata: utils.defaultAbiCoder.encode(['uint256'], [minutes * 60]),
    }));
    await receiver.processMessageExternal(govTimelock.address, encodeProposal(setDelayTxs));
    ({ eta } = await receiver.proposals(1));
    snapshot = await takeSnapshot();
  });

  describe('happy path', function () {
    let cancelTx: ContractTransaction;
    let otherEta: BigNumber;

    before(async () => {
      await receiver.processMessageExternal(govTimelock.address, encodeProposal([otherSetDelayTx]));
      ({ eta: otherEta } = await receiver.proposals(2));
    });

    after(async () => await snapshot.restore());

    it('the guardian cancels a queued proposal', async () => {
      cancelTx = await receiver.connect(guardian).cancelProposal(1);
      await expect(cancelTx).to.not.be.reverted;
    });

    it('emits ProposalCanceled', async () => {
      await expect(cancelTx).to.emit(receiver, 'ProposalCanceled').withArgs(1);
    });

    it('reports the proposal as canceled', async () => {
      expect(await receiver.state(1)).to.equal(ProposalState.Canceled);
    });

    [0, 1].forEach((i) => {
      it(`cancels transaction #${i + 1} in the local timelock`, async () => {
        expect(await localTimelock.queuedTransactions(txHash(setDelayTxs[i], eta))).to.be.false;
      });
    });

    it('keeps the transaction of the other proposal queued in the local timelock', async () => {
      expect(await localTimelock.queuedTransactions(txHash(otherSetDelayTx, otherEta))).to.be.true;
    });

    it('blocks the execution of the proposal', async () => {
      await mineAt(eta);
      await expect(receiver.executeProposal(1)).to.be.revertedWithCustomError(receiver, 'ProposalNotExecutable');
    });

    it('keeps reporting the proposal as canceled after the grace period', async () => {
      await mineAt(eta.add(GRACE_PERIOD).add(1));
      expect(await receiver.state(1)).to.equal(ProposalState.Canceled);
    });
  });

  // The proposal stays cancelable once executable, until it is executed or expires.
  describe('happy path (executable proposal)', function () {
    before(async () => await mineAt(eta));

    after(async () => await snapshot.restore());

    it('the guardian cancels a proposal past its eta', async () => {
      await expect(receiver.connect(guardian).cancelProposal(1)).to.not.be.reverted;
    });

    it('reports the proposal as canceled', async () => {
      expect(await receiver.state(1)).to.equal(ProposalState.Canceled);
    });
  });

  describe('revert when', function () {
    afterEach(async () => await snapshot.restore());

    it('the caller is not the guardian', async () => {
      await expect(receiver.connect(other).cancelProposal(1))
        .to.be.revertedWithCustomError(receiver, 'GuardianUnauthorized');
    });

    it('the proposal is already canceled', async () => {
      await receiver.connect(guardian).cancelProposal(1);
      await expect(receiver.connect(guardian).cancelProposal(1))
        .to.be.revertedWithCustomError(receiver, 'ProposalNotQueued');
    });

    it('the proposal is executed', async () => {
      await ethers.provider.send('evm_setNextBlockTimestamp', [eta.toNumber()]);
      await receiver.executeProposal(1);
      await expect(receiver.connect(guardian).cancelProposal(1))
        .to.be.revertedWithCustomError(receiver, 'ProposalNotQueued');
    });

    it('the proposal is expired', async () => {
      await mineAt(eta.add(GRACE_PERIOD).add(1));
      await expect(receiver.connect(guardian).cancelProposal(1))
        .to.be.revertedWithCustomError(receiver, 'ProposalNotQueued');
    });

    it('the proposal calls setGuardian on the receiver', async () => {
      await receiver.processMessageExternal(govTimelock.address, encodeProposal([
        otherSetDelayTx,
        {
          target: receiver.address,
          signature: 'setGuardian(address)',
          calldata: utils.defaultAbiCoder.encode(['address'], [other.address]),
        },
      ]));
      await expect(receiver.connect(guardian).cancelProposal(2))
        .to.be.revertedWithCustomError(receiver, 'ProposalNotCancelable');
    });

    it('the proposal calls setGuardian on the receiver by calldata, with no signature', async () => {
      await receiver.processMessageExternal(govTimelock.address, encodeProposal([{
        target: receiver.address,
        signature: '',
        calldata: receiver.interface.encodeFunctionData('setGuardian', [other.address]),
      }]));
      await expect(receiver.connect(guardian).cancelProposal(2))
        .to.be.revertedWithCustomError(receiver, 'ProposalNotCancelable');
    });
  });
});
