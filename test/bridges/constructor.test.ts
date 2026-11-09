import { ethers, expect } from '../helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BaseBridgeReceiverHarness, BaseBridgeReceiverHarness__factory, Timelock } from '../../build/types';
import { deployBaseBridgeReceiverFixture } from './shared';

// The constructor binds the receiver to the governing and local timelocks and sets the guardian. It marks the admin
// role accepted when the local timelock was deployed with the receiver as admin, as on a new chain.
describe('base bridge receiver: constructor', function () {
  let ReceiverFactory: BaseBridgeReceiverHarness__factory;
  let receiver: BaseBridgeReceiverHarness;
  let localTimelock: Timelock;
  let govTimelock: SignerWithAddress;
  let guardian: SignerWithAddress;

  before(async () => {
    ({ ReceiverFactory, receiver, localTimelock, govTimelock, guardian } = await deployBaseBridgeReceiverFixture());
  });

  describe('happy path (new chain)', function () {
    it('emits NewGuardian', async () => {
      await expect(receiver.deployTransaction)
        .to.emit(receiver, 'NewGuardian').withArgs(ethers.constants.AddressZero, guardian.address);
    });

    it('sets the governing timelock', async () => {
      expect(await receiver.govTimelock()).to.equal(govTimelock.address);
    });

    it('sets the local timelock', async () => {
      expect(await receiver.localTimelock()).to.equal(localTimelock.address);
    });

    it('sets the guardian', async () => {
      expect(await receiver.guardian()).to.equal(guardian.address);
    });

    it('starts with no proposals', async () => {
      expect(await receiver.proposalCount()).to.equal(0);
    });

    it('marks the admin role accepted, the local timelock having the receiver as admin', async () => {
      expect(await receiver.adminAccepted()).to.be.true;
    });
  });

  describe('happy path (existing local timelock)', function () {
    let newReceiver: BaseBridgeReceiverHarness;

    before(async () => {
      newReceiver = await ReceiverFactory.deploy(govTimelock.address, localTimelock.address, guardian.address);
    });

    it('leaves the admin role to accept, the local timelock having another admin', async () => {
      expect(await newReceiver.adminAccepted()).to.be.false;
    });
  });

  describe('revert when', function () {
    it('the governing timelock is the zero address', async () => {
      await expect(ReceiverFactory.deploy(ethers.constants.AddressZero, localTimelock.address, guardian.address))
        .to.be.revertedWithCustomError(ReceiverFactory, 'ZeroValue');
    });

    it('the local timelock is the zero address', async () => {
      await expect(ReceiverFactory.deploy(govTimelock.address, ethers.constants.AddressZero, guardian.address))
        .to.be.revertedWithCustomError(ReceiverFactory, 'ZeroValue');
    });

    it('the guardian is the zero address', async () => {
      await expect(ReceiverFactory.deploy(govTimelock.address, localTimelock.address, ethers.constants.AddressZero))
        .to.be.revertedWithCustomError(ReceiverFactory, 'ZeroValue');
    });
  });
});
