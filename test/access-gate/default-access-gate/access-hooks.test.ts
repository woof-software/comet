import { exp, expect } from '../../helpers';
import { DefaultAccessGate } from '../../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { takeSnapshot, SnapshotRestorer } from '../../helpers/snapshot';
import {
  ACTIONS,
  Action,
  COLLATERAL_ACTIONS,
  NO_ASSET,
  WBTC_INDEX,
  WETH_INDEX,
  deployDefaultAccessGateFixture,
} from '../../helpers/access-gate';

// Comet asks the gate through checkAccess before an action (reverts when the action is paused, entirely or for
// the collateral asset) and notifies it through postAccessAction after the action. Both are accepted from the
// bound Comet only.
describe('default access gate: access hooks', function () {
  const AMOUNT = exp(1, 18);

  let gate: DefaultAccessGate;
  let governor: SignerWithAddress;
  let pauser: SignerWithAddress;
  let other: SignerWithAddress;
  let counterparty: SignerWithAddress;
  let cometSigner: SignerWithAddress;

  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ gate, governor, pauser, other, counterparty, cometSigner } = await deployDefaultAccessGateFixture());
    snapshot = await takeSnapshot();
  });

  /*//////////////////////////////////////////////////////////////
                            checkAccess
  //////////////////////////////////////////////////////////////*/

  describe('checkAccess', function () {
    const checkAccess = (signer: SignerWithAddress, action: number, assetIndex: number) =>
      gate.connect(signer).checkAccess(action, other.address, other.address, counterparty.address, assetIndex, AMOUNT);

    describe('nothing is paused', function () {
      after(async () => await snapshot.restore());

      ACTIONS.forEach(([name, action]) => {
        it(`permits ${name}`, async () => {
          await expect(checkAccess(cometSigner, action, NO_ASSET)).to.not.be.reverted;
        });
      });

      COLLATERAL_ACTIONS.forEach(([name, action]) => {
        it(`permits ${name} for WBTC`, async () => {
          await expect(checkAccess(cometSigner, action, WBTC_INDEX)).to.not.be.reverted;
        });
      });
    });

    describe('an action is paused entirely', function () {
      before(async () => {
        await gate.connect(pauser).setActionPaused(Action.BORROW, true);
        await gate.connect(pauser).setActionPaused(Action.SUPPLY_COLLATERAL, true);
      });

      after(async () => await snapshot.restore());

      it('rejects BORROW', async () => {
        await expect(checkAccess(cometSigner, Action.BORROW, NO_ASSET))
          .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.BORROW, NO_ASSET);
      });

      [WETH_INDEX, WBTC_INDEX].forEach((assetIndex) => {
        it(`rejects SUPPLY_COLLATERAL for asset #${assetIndex}`, async () => {
          await expect(checkAccess(cometSigner, Action.SUPPLY_COLLATERAL, assetIndex))
            .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.SUPPLY_COLLATERAL, assetIndex);
        });
      });

      it('permits WITHDRAW_BASE', async () => {
        await expect(checkAccess(cometSigner, Action.WITHDRAW_BASE, NO_ASSET)).to.not.be.reverted;
      });

      it('permits WITHDRAW_COLLATERAL for WBTC', async () => {
        await expect(checkAccess(cometSigner, Action.WITHDRAW_COLLATERAL, WBTC_INDEX)).to.not.be.reverted;
      });
    });

    describe('a collateral action is paused for an asset', function () {
      before(async () => {
        await gate.connect(pauser).setCollateralPaused(Action.TRANSFER_COLLATERAL, WBTC_INDEX, true);
      });

      after(async () => await snapshot.restore());

      it('rejects TRANSFER_COLLATERAL for WBTC', async () => {
        await expect(checkAccess(cometSigner, Action.TRANSFER_COLLATERAL, WBTC_INDEX))
          .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.TRANSFER_COLLATERAL, WBTC_INDEX);
      });

      it('permits TRANSFER_COLLATERAL for WETH', async () => {
        await expect(checkAccess(cometSigner, Action.TRANSFER_COLLATERAL, WETH_INDEX)).to.not.be.reverted;
      });

      it('permits WITHDRAW_COLLATERAL for WBTC', async () => {
        await expect(checkAccess(cometSigner, Action.WITHDRAW_COLLATERAL, WBTC_INDEX)).to.not.be.reverted;
      });
    });

    describe('a paused action is unpaused', function () {
      before(async () => {
        // Pause first
        await gate.connect(pauser).setActionPaused(Action.BORROW, true);
        // Then unpause to check that unpausing applied its effect after the pause
        await gate.connect(pauser).setActionPaused(Action.BORROW, false);
      });

      after(async () => await snapshot.restore());

      it('permits BORROW', async () => {
        await expect(checkAccess(cometSigner, Action.BORROW, NO_ASSET)).to.not.be.reverted;
      });
    });

    describe('revert when', function () {
      it('the caller is not the Comet', async () => {
        await expect(checkAccess(other, Action.BORROW, NO_ASSET))
          .to.be.revertedWithCustomError(gate, 'Unauthorized');
      });

      it('the caller is the governor', async () => {
        await expect(checkAccess(governor, Action.BORROW, NO_ASSET))
          .to.be.revertedWithCustomError(gate, 'Unauthorized');
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                          postAccessAction
  //////////////////////////////////////////////////////////////*/

  describe('postAccessAction', function () {
    const postAccessAction = (signer: SignerWithAddress, action: number, assetIndex: number) =>
      gate.connect(signer).postAccessAction(action, other.address, other.address, counterparty.address, assetIndex, AMOUNT);

    describe('happy path', function () {
      after(async () => await snapshot.restore());

      ACTIONS.forEach(([name, action]) => {
        it(`accepts ${name} from the Comet`, async () => {
          await expect(postAccessAction(cometSigner, action, NO_ASSET)).to.not.be.reverted;
        });
      });
    });

    // Pauses are enforced before the action only.
    describe('an action is paused', function () {
      before(async () => {
        await gate.connect(pauser).setActionPaused(Action.BORROW, true);
      });

      after(async () => await snapshot.restore());

      it('accepts BORROW from the Comet', async () => {
        await expect(postAccessAction(cometSigner, Action.BORROW, NO_ASSET)).to.not.be.reverted;
      });
    });

    describe('revert when', function () {
      it('the caller is not the Comet', async () => {
        await expect(postAccessAction(other, Action.BORROW, NO_ASSET))
          .to.be.revertedWithCustomError(gate, 'Unauthorized');
      });
    });
  });
});
