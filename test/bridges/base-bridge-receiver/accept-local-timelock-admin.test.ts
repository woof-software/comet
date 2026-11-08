import { expect } from '../../helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction, utils } from 'ethers';
import { BaseBridgeReceiverHarness, Timelock } from '../../../build/types';
import { takeSnapshot, SnapshotRestorer } from '../../helpers/snapshot';
import { deployBaseBridgeReceiverFixture, encodeProposal, mineAt } from './shared';

// acceptLocalTimelockAdmin hands an existing local timelock over to a new receiver in two steps:
// 1. a proposal through the current receiver makes the new receiver the pending admin of the local timelock;
// 2. any address calls acceptLocalTimelockAdmin on the new receiver, which accepts the admin role, once.
// A receiver deployed as the admin of the local timelock (new chain) starts with the role accepted.
describe('base bridge receiver: acceptLocalTimelockAdmin', function () {
  let receiver: BaseBridgeReceiverHarness;
  let newReceiver: BaseBridgeReceiverHarness;
  let localTimelock: Timelock;
  let govTimelock: SignerWithAddress;
  let other: SignerWithAddress;

  let snapshot: SnapshotRestorer;

  before(async () => {
    let ReceiverFactory, guardian: SignerWithAddress;
    ({ ReceiverFactory, receiver, localTimelock, govTimelock, guardian, other } = await deployBaseBridgeReceiverFixture());
    newReceiver = await ReceiverFactory.deploy(govTimelock.address, localTimelock.address, guardian.address);
    snapshot = await takeSnapshot();
  });

  describe('happy path', function () {
    let acceptTx: ContractTransaction;

    // Step 1: the proposal makes the new receiver the pending admin of the local timelock
    before(async () => {
      await receiver.processMessageExternal(govTimelock.address, encodeProposal([{
        target: localTimelock.address,
        signature: 'setPendingAdmin(address)',
        calldata: utils.defaultAbiCoder.encode(['address'], [newReceiver.address]),
      }]));
      const { eta } = await receiver.proposals(1);
      await mineAt(eta);
      await receiver.executeProposal(1);
    });

    after(async () => await snapshot.restore());

    // Step 2
    it('an arbitrary address triggers accepting the admin role for the new receiver', async () => {
      acceptTx = await newReceiver.connect(other).acceptLocalTimelockAdmin();
      await expect(acceptTx).to.not.be.reverted;
    });

    it('emits NewAdmin from the local timelock', async () => {
      await expect(acceptTx).to.emit(localTimelock, 'NewAdmin').withArgs(newReceiver.address);
    });

    it('makes the new receiver the admin of the local timelock', async () => {
      expect(await localTimelock.admin()).to.equal(newReceiver.address);
    });

    it('marks the admin role accepted', async () => {
      expect(await newReceiver.adminAccepted()).to.be.true;
    });
  });

  describe('revert when', function () {
    it('the receiver is not the pending admin of the local timelock', async () => {
      await expect(newReceiver.connect(other).acceptLocalTimelockAdmin())
        .to.be.revertedWith('Timelock::acceptAdmin: Call must come from pendingAdmin.');
    });

    it('the admin role is already accepted', async () => {
      await expect(receiver.connect(other).acceptLocalTimelockAdmin())
        .to.be.revertedWithCustomError(receiver, 'AdminAlreadyAccepted');
    });
  });
});
