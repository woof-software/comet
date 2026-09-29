import { expect } from '../../helpers';
import { DefaultAccessGate } from '../../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import { takeSnapshot, SnapshotRestorer } from '../../helpers/snapshot';
import {
  ACTIONS,
  Action,
  NO_ASSET,
  PAUSER_ROLE,
  UNDEFINED_ACTION,
  WBTC_INDEX,
  WETH_INDEX,
  deployDefaultAccessGateFixture,
} from '../../helpers/access-gate';

// setActionPaused pauses or unpauses an action entirely. It is available to the Pausers and to the governor,
// which does not need PAUSER_ROLE. Setting the status an action already has reverts.
describe('default access gate: setActionPaused', function () {
  let gate: DefaultAccessGate;
  let governor: SignerWithAddress;
  let operatorAdmin: SignerWithAddress;
  let pauser: SignerWithAddress;
  let other: SignerWithAddress;

  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ gate, governor, operatorAdmin, pauser, other } = await deployDefaultAccessGateFixture());
    snapshot = await takeSnapshot();
  });

  describe('happy path (pauser caller)', function () {
    let pauseTx: ContractTransaction;

    after(async () => await snapshot.restore());

    it('a Pauser pauses BORROW', async () => {
      pauseTx = await gate.connect(pauser).setActionPaused(Action.BORROW, true);
      await expect(pauseTx).to.not.be.reverted;
    });

    it('emits PauseAction', async () => {
      await expect(pauseTx).to.emit(gate, 'PauseAction').withArgs(Action.BORROW, true);
    });

    it('marks BORROW as paused', async () => {
      expect(await gate.isPaused(Action.BORROW, NO_ASSET)).to.be.true;
    });

    ACTIONS.filter(([, action]) => action !== Action.BORROW).forEach(([name, action]) => {
      it(`keeps ${name} unpaused`, async () => {
        expect(await gate.isPaused(action, NO_ASSET)).to.be.false;
      });
    });
  });

  // The governor may pause without holding PAUSER_ROLE.
  describe('happy path (governor caller)', function () {
    let pauseTx: ContractTransaction;

    after(async () => await snapshot.restore());

    it('the governor pauses WITHDRAW_BASE', async () => {
      pauseTx = await gate.connect(governor).setActionPaused(Action.WITHDRAW_BASE, true);
      await expect(pauseTx).to.not.be.reverted;
    });

    it('emits PauseAction', async () => {
      await expect(pauseTx).to.emit(gate, 'PauseAction').withArgs(Action.WITHDRAW_BASE, true);
    });

    it('marks WITHDRAW_BASE as paused', async () => {
      expect(await gate.isPaused(Action.WITHDRAW_BASE, NO_ASSET)).to.be.true;
    });
  });

  // Pausing a collateral action entirely applies to every collateral asset.
  describe('happy path (collateral action)', function () {
    let pauseTx: ContractTransaction;

    after(async () => await snapshot.restore());

    it('a Pauser pauses SUPPLY_COLLATERAL', async () => {
      pauseTx = await gate.connect(pauser).setActionPaused(Action.SUPPLY_COLLATERAL, true);
      await expect(pauseTx).to.not.be.reverted;
    });

    it('marks SUPPLY_COLLATERAL as paused', async () => {
      expect(await gate.isPaused(Action.SUPPLY_COLLATERAL, NO_ASSET)).to.be.true;
    });

    [WETH_INDEX, WBTC_INDEX].forEach((assetIndex) => {
      it(`marks SUPPLY_COLLATERAL as paused for asset #${assetIndex}`, async () => {
        expect(await gate.isPaused(Action.SUPPLY_COLLATERAL, assetIndex)).to.be.true;
      });
    });
  });

  describe('happy path (unpause)', function () {
    let unpauseTx: ContractTransaction;

    before(async () => {
      await gate.connect(pauser).setActionPaused(Action.BORROW, true);
    });

    after(async () => await snapshot.restore());

    it('a Pauser unpauses BORROW', async () => {
      unpauseTx = await gate.connect(pauser).setActionPaused(Action.BORROW, false);
      await expect(unpauseTx).to.not.be.reverted;
    });

    it('emits PauseAction', async () => {
      await expect(unpauseTx).to.emit(gate, 'PauseAction').withArgs(Action.BORROW, false);
    });

    it('marks BORROW as unpaused', async () => {
      expect(await gate.isPaused(Action.BORROW, NO_ASSET)).to.be.false;
    });
  });

  describe('revert when', function () {
    after(async () => await snapshot.restore());

    it('the caller holds no role', async () => {
      await expect(gate.connect(other).setActionPaused(Action.BORROW, true))
        .to.be.revertedWithCustomError(gate, 'Unauthorized');
    });

    it('the caller is the operator admin without the pauser role', async () => {
      await expect(gate.connect(operatorAdmin).setActionPaused(Action.BORROW, true))
        .to.be.revertedWithCustomError(gate, 'Unauthorized');
    });

    it('the action is undefined', async () => {
      await expect(gate.connect(pauser).setActionPaused(UNDEFINED_ACTION, true)).to.be.reverted;
    });

    it('the action is already unpaused', async () => {
      await expect(gate.connect(pauser).setActionPaused(Action.BORROW, false))
        .to.be.revertedWithCustomError(gate, 'PauseStatusAlreadySet').withArgs(Action.BORROW, NO_ASSET, false);
    });

    it('the action is already paused', async () => {
      await gate.connect(pauser).setActionPaused(Action.BORROW, true);
      await expect(gate.connect(pauser).setActionPaused(Action.BORROW, true))
        .to.be.revertedWithCustomError(gate, 'PauseStatusAlreadySet').withArgs(Action.BORROW, NO_ASSET, true);
    });

    it('the caller\'s pauser role was revoked', async () => {
      await gate.connect(operatorAdmin).revokeRole(PAUSER_ROLE, pauser.address);
      await expect(gate.connect(pauser).setActionPaused(Action.WITHDRAW_BASE, true))
        .to.be.revertedWithCustomError(gate, 'Unauthorized');
    });
  });
});
