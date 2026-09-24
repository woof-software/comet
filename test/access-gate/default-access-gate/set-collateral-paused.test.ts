import { expect } from '../../helpers';
import { CometWithExtendedAssetList, DefaultAccessGate, FaucetToken } from '../../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import { takeSnapshot, SnapshotRestorer } from '../../helpers/snapshot';
import {
  ACTIONS,
  Action,
  COLLATERAL_ACTIONS,
  NO_ASSET,
  NUM_ASSETS,
  UNDEFINED_ACTION,
  WBTC_INDEX,
  WETH_INDEX,
  deployDefaultAccessGateFixture,
} from '../../helpers/access-gate';

// setCollateralPaused and setCollateralPausedByAddress pause or unpause a collateral action (SUPPLY_COLLATERAL,
// WITHDRAW_COLLATERAL, TRANSFER_COLLATERAL, BUY_COLLATERAL) for a single collateral asset, given by its offset
// or by its address. Both are available to the Pausers and to the governor, which does not need PAUSER_ROLE.
// Setting the status an action already has for the asset reverts.
describe('default access gate: setCollateralPaused', function () {
  let gate: DefaultAccessGate;
  let comet: CometWithExtendedAssetList;
  let usdc: FaucetToken;
  let wbtc: FaucetToken;
  let governor: SignerWithAddress;
  let pauser: SignerWithAddress;
  let other: SignerWithAddress;

  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ gate, comet, usdc, wbtc, governor, pauser, other } = await deployDefaultAccessGateFixture());
    snapshot = await takeSnapshot();
  });

  /*//////////////////////////////////////////////////////////////
                        setCollateralPaused
  //////////////////////////////////////////////////////////////*/

  describe('setCollateralPaused', function () {
    COLLATERAL_ACTIONS.forEach(([name, action]) => {
      describe(`happy path (${name})`, function () {
        let pauseTx: ContractTransaction;

        after(async () => await snapshot.restore());

        it(`a Pauser pauses ${name} for WBTC`, async () => {
          pauseTx = await gate.connect(pauser).setCollateralPaused(action, WBTC_INDEX, true);
          await expect(pauseTx).to.not.be.reverted;
        });

        it('emits PauseCollateralAction', async () => {
          await expect(pauseTx).to.emit(gate, 'PauseCollateralAction').withArgs(action, WBTC_INDEX, true);
        });

        it(`marks ${name} as paused for WBTC`, async () => {
          expect(await gate.isPaused(action, WBTC_INDEX)).to.be.true;
        });

        it(`keeps ${name} unpaused for the other collateral (WETH)`, async () => {
          expect(await gate.isPaused(action, WETH_INDEX)).to.be.false;
        });

        it(`keeps ${name} unpaused entirely`, async () => {
          expect(await gate.isPaused(action, NO_ASSET)).to.be.false;
        });

        it('keeps the other actions unpaused for WBTC', async () => {
          for (const [, otherAction] of ACTIONS.filter(([, a]) => a !== action)) {
            expect(await gate.isPaused(otherAction, WBTC_INDEX)).to.be.false;
          }
        });
      });
    });

    // The governor may pause without holding PAUSER_ROLE.
    describe('happy path (governor caller)', function () {
      let pauseTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('the governor pauses SUPPLY_COLLATERAL for WETH', async () => {
        pauseTx = await gate.connect(governor).setCollateralPaused(Action.SUPPLY_COLLATERAL, WETH_INDEX, true);
        await expect(pauseTx).to.not.be.reverted;
      });

      it('emits PauseCollateralAction', async () => {
        await expect(pauseTx).to.emit(gate, 'PauseCollateralAction').withArgs(Action.SUPPLY_COLLATERAL, WETH_INDEX, true);
      });

      it('marks SUPPLY_COLLATERAL as paused for WETH', async () => {
        expect(await gate.isPaused(Action.SUPPLY_COLLATERAL, WETH_INDEX)).to.be.true;
      });
    });

    describe('happy path (unpause)', function () {
      let unpauseTx: ContractTransaction;

      before(async () => {
        await gate.connect(pauser).setCollateralPaused(Action.SUPPLY_COLLATERAL, WBTC_INDEX, true);
      });

      after(async () => await snapshot.restore());

      it('a Pauser unpauses SUPPLY_COLLATERAL for WBTC', async () => {
        unpauseTx = await gate.connect(pauser).setCollateralPaused(Action.SUPPLY_COLLATERAL, WBTC_INDEX, false);
        await expect(unpauseTx).to.not.be.reverted;
      });

      it('emits PauseCollateralAction', async () => {
        await expect(unpauseTx).to.emit(gate, 'PauseCollateralAction').withArgs(Action.SUPPLY_COLLATERAL, WBTC_INDEX, false);
      });

      it('marks SUPPLY_COLLATERAL as unpaused for WBTC', async () => {
        expect(await gate.isPaused(Action.SUPPLY_COLLATERAL, WBTC_INDEX)).to.be.false;
      });
    });

    describe('revert when', function () {
      after(async () => await snapshot.restore());

      it('the caller holds no role', async () => {
        await expect(gate.connect(other).setCollateralPaused(Action.SUPPLY_COLLATERAL, WETH_INDEX, true))
          .to.be.revertedWithCustomError(gate, 'Unauthorized');
      });

      it('the asset index is beyond the Comet assets', async () => {
        await expect(gate.connect(pauser).setCollateralPaused(Action.SUPPLY_COLLATERAL, NUM_ASSETS, true))
          .to.be.revertedWithCustomError(gate, 'InvalidAssetIndex').withArgs(NUM_ASSETS);
      });

      it('the asset index is NO_ASSET', async () => {
        await expect(gate.connect(pauser).setCollateralPaused(Action.SUPPLY_COLLATERAL, NO_ASSET, true))
          .to.be.revertedWithCustomError(gate, 'InvalidAssetIndex').withArgs(NO_ASSET);
      });

      it('the action is not a collateral action', async () => {
        await expect(gate.connect(pauser).setCollateralPaused(Action.BORROW, WETH_INDEX, true))
          .to.be.revertedWithCustomError(gate, 'InvalidAction').withArgs(Action.BORROW);
      });

      it('the action is undefined', async () => {
        await expect(gate.connect(pauser).setCollateralPaused(UNDEFINED_ACTION, WETH_INDEX, true)).to.be.reverted;
      });

      it('the action is already unpaused for the asset', async () => {
        await expect(gate.connect(pauser).setCollateralPaused(Action.SUPPLY_COLLATERAL, WETH_INDEX, false))
          .to.be.revertedWithCustomError(gate, 'PauseStatusAlreadySet').withArgs(Action.SUPPLY_COLLATERAL, WETH_INDEX, false);
      });

      it('the action is already paused for the asset', async () => {
        await gate.connect(pauser).setCollateralPaused(Action.SUPPLY_COLLATERAL, WETH_INDEX, true);
        await expect(gate.connect(pauser).setCollateralPaused(Action.SUPPLY_COLLATERAL, WETH_INDEX, true))
          .to.be.revertedWithCustomError(gate, 'PauseStatusAlreadySet').withArgs(Action.SUPPLY_COLLATERAL, WETH_INDEX, true);
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                    setCollateralPausedByAddress
  //////////////////////////////////////////////////////////////*/

  describe('setCollateralPausedByAddress', function () {
    describe('happy path', function () {
      let pauseTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('a Pauser pauses WITHDRAW_COLLATERAL for the WBTC address', async () => {
        pauseTx = await gate.connect(pauser).setCollateralPausedByAddress(Action.WITHDRAW_COLLATERAL, wbtc.address, true);
        await expect(pauseTx).to.not.be.reverted;
      });

      it('emits PauseCollateralAction with the WBTC offset', async () => {
        await expect(pauseTx).to.emit(gate, 'PauseCollateralAction').withArgs(Action.WITHDRAW_COLLATERAL, WBTC_INDEX, true);
      });

      it('marks WITHDRAW_COLLATERAL as paused for WBTC', async () => {
        expect(await gate.isPaused(Action.WITHDRAW_COLLATERAL, WBTC_INDEX)).to.be.true;
      });

      it('keeps WITHDRAW_COLLATERAL unpaused for the other collateral (WETH)', async () => {
        expect(await gate.isPaused(Action.WITHDRAW_COLLATERAL, WETH_INDEX)).to.be.false;
      });

      it('keeps WITHDRAW_COLLATERAL unpaused entirely', async () => {
        expect(await gate.isPaused(Action.WITHDRAW_COLLATERAL, NO_ASSET)).to.be.false;
      });

      it('keeps the other actions unpaused for WBTC', async () => {
        for (const [, otherAction] of ACTIONS.filter(([, a]) => a !== Action.WITHDRAW_COLLATERAL)) {
          expect(await gate.isPaused(otherAction, WBTC_INDEX)).to.be.false;
        }
      });
    });

    describe('happy path (unpause)', function () {
      let unpauseTx: ContractTransaction;

      before(async () => {
        await gate.connect(pauser).setCollateralPausedByAddress(Action.WITHDRAW_COLLATERAL, wbtc.address, true);
      });

      after(async () => await snapshot.restore());

      it('a Pauser unpauses WITHDRAW_COLLATERAL for the WBTC address', async () => {
        unpauseTx = await gate.connect(pauser).setCollateralPausedByAddress(Action.WITHDRAW_COLLATERAL, wbtc.address, false);
        await expect(unpauseTx).to.not.be.reverted;
      });

      it('emits PauseCollateralAction with the WBTC offset', async () => {
        await expect(unpauseTx).to.emit(gate, 'PauseCollateralAction').withArgs(Action.WITHDRAW_COLLATERAL, WBTC_INDEX, false);
      });

      it('marks WITHDRAW_COLLATERAL as unpaused for WBTC', async () => {
        expect(await gate.isPaused(Action.WITHDRAW_COLLATERAL, WBTC_INDEX)).to.be.false;
      });
    });

    describe('revert when', function () {
      after(async () => await snapshot.restore());

      it('the caller holds no role', async () => {
        await expect(gate.connect(other).setCollateralPausedByAddress(Action.WITHDRAW_COLLATERAL, wbtc.address, true))
          .to.be.revertedWithCustomError(gate, 'Unauthorized');
      });

      it('the address is not a collateral of the Comet', async () => {
        await expect(gate.connect(pauser).setCollateralPausedByAddress(Action.WITHDRAW_COLLATERAL, other.address, true))
          .to.be.revertedWithCustomError(comet, 'BadAsset');
      });

      it('the address is the base token', async () => {
        await expect(gate.connect(pauser).setCollateralPausedByAddress(Action.WITHDRAW_COLLATERAL, usdc.address, true))
          .to.be.revertedWithCustomError(comet, 'BadAsset');
      });

      it('the action is not a collateral action', async () => {
        await expect(gate.connect(pauser).setCollateralPausedByAddress(Action.BORROW, wbtc.address, true))
          .to.be.revertedWithCustomError(gate, 'InvalidAction').withArgs(Action.BORROW);
      });

      it('the action is already unpaused for the asset', async () => {
        await expect(gate.connect(pauser).setCollateralPausedByAddress(Action.WITHDRAW_COLLATERAL, wbtc.address, false))
          .to.be.revertedWithCustomError(gate, 'PauseStatusAlreadySet').withArgs(Action.WITHDRAW_COLLATERAL, WBTC_INDEX, false);
      });
    });
  });
});
