import { ethers, expect } from '../helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction, utils } from 'ethers';
import { BaseBridgeReceiverHarness, Timelock } from '../../build/types';
import { impersonateAccount, setBalance } from '../helpers/network-helpers';
import { takeSnapshot, SnapshotRestorer } from '../helpers/snapshot';
import { deployBaseBridgeReceiverFixture, encodeProposal } from './shared';

// setGuardian replaces the guardian. Only the local timelock calls it, through a proposal from the governing timelock.
describe('base bridge receiver: setGuardian', function () {
  let receiver: BaseBridgeReceiverHarness;
  let localTimelock: Timelock;
  let govTimelock: SignerWithAddress;
  let guardian: SignerWithAddress;
  let other: SignerWithAddress;

  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ receiver, localTimelock, govTimelock, guardian, other } = await deployBaseBridgeReceiverFixture());
    snapshot = await takeSnapshot();
  });

  describe('happy path', function () {
    let executeTx: ContractTransaction;

    before(async () => {
      await receiver.processMessageExternal(govTimelock.address, encodeProposal([{
        target: receiver.address,
        signature: 'setGuardian(address)',
        calldata: utils.defaultAbiCoder.encode(['address'], [other.address]),
      }]));
      const { eta } = await receiver.proposals(1);
      await ethers.provider.send('evm_setNextBlockTimestamp', [eta.toNumber()]);
    });

    after(async () => await snapshot.restore());

    it('a proposal sets the guardian', async () => {
      executeTx = await receiver.executeProposal(1);
      await expect(executeTx).to.not.be.reverted;
    });

    it('emits NewGuardian', async () => {
      await expect(executeTx).to.emit(receiver, 'NewGuardian').withArgs(guardian.address, other.address);
    });

    it('sets the guardian', async () => {
      expect(await receiver.guardian()).to.equal(other.address);
    });
  });

  describe('revert when', function () {
    it('the caller is not the local timelock', async () => {
      await expect(receiver.connect(guardian).setGuardian(other.address))
        .to.be.revertedWithCustomError(receiver, 'Unauthorized');
    });

    // Called by the local timelock directly: through a proposal, the Timelock replaces the error with its own message
    it('the new guardian is the current guardian', async () => {
      await impersonateAccount(localTimelock.address);
      await setBalance(localTimelock.address, ethers.utils.parseEther('1'));
      const localTimelockSigner = await ethers.getSigner(localTimelock.address);
      await expect(receiver.connect(localTimelockSigner).setGuardian(guardian.address))
        .to.be.revertedWithCustomError(receiver, 'SameValue');
    });
  });
});
