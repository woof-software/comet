import { expect } from '../helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BigNumber, utils } from 'ethers';
import { BaseBridgeReceiverHarness, Timelock } from '../../build/types';
import { takeSnapshot, SnapshotRestorer } from '../helpers/snapshot';
import { GRACE_PERIOD, ProposalState, deployBaseBridgeReceiverFixture, encodeProposal, mineAt } from './shared';

// state reports a proposal as queued until the end of the local timelock grace period after its eta, then as expired.
// A new proposal being queued and executed proposals are covered with processMessage and executeProposal.
describe('base bridge receiver: state', function () {
  let receiver: BaseBridgeReceiverHarness;
  let localTimelock: Timelock;
  let govTimelock: SignerWithAddress;

  let eta: BigNumber;

  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ receiver, localTimelock, govTimelock } = await deployBaseBridgeReceiverFixture());
    await receiver.processMessageExternal(govTimelock.address, encodeProposal([{
      target: localTimelock.address,
      signature: 'setDelay(uint256)',
      calldata: utils.defaultAbiCoder.encode(['uint256'], [20 * 60]),
    }]));
    ({ eta } = await receiver.proposals(1));
    snapshot = await takeSnapshot();
  });

  describe('happy path (end of the grace period)', function () {
    before(async () => await mineAt(eta.add(GRACE_PERIOD)));

    after(async () => await snapshot.restore());

    it('still reports the proposal as queued', async () => {
      expect(await receiver.state(1)).to.equal(ProposalState.Queued);
    });
  });

  describe('happy path (after the grace period)', function () {
    before(async () => await mineAt(eta.add(GRACE_PERIOD).add(1)));

    after(async () => await snapshot.restore());

    it('reports the proposal as expired', async () => {
      expect(await receiver.state(1)).to.equal(ProposalState.Expired);
    });
  });

  describe('revert when', function () {
    it('the proposal id is zero', async () => {
      await expect(receiver.state(0)).to.be.revertedWithCustomError(receiver, 'InvalidProposalId');
    });

    it('the proposal id is above the proposal count', async () => {
      await expect(receiver.state(2)).to.be.revertedWithCustomError(receiver, 'InvalidProposalId');
    });
  });
});
