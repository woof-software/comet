import { expect } from '../../helpers';
import { ListAccessGate } from '../../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import { takeSnapshot, SnapshotRestorer } from '../../helpers/snapshot';
import {
  ACTIONS,
  Action,
  OPERATOR_ROLE,
  UNDEFINED_ACTION,
  deployListAccessGateFixture,
  missingRole,
} from '../../helpers/access-gate';

// ListAccessGate is abstract, so it is tested through AllowlistGate. setListed lists or unlists the accounts
// for the actions, keeping their other listed actions; it is available to the Operators only.
describe('list access gate: setListed', function () {
  // Bitmap of the listed actions, as exposed by listedActions(account).
  const bitmap = (...actions: number[]) => actions.reduce((mask, action) => mask | (1 << action), 0);

  // Accounts listed by the tests, by their position in the fixture accounts.
  const ALICE = 0;
  const BOB = 1;
  const CAROL = 2;

  let gate: ListAccessGate;
  let governor: SignerWithAddress;
  let operatorAdmin: SignerWithAddress;
  let pauser: SignerWithAddress;
  let operator: SignerWithAddress;
  let other: SignerWithAddress;
  let accounts: SignerWithAddress[];

  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ gate, governor, operatorAdmin, pauser, operator, other, accounts } = await deployListAccessGateFixture('AllowlistGate'));
    snapshot = await takeSnapshot();
  });

  describe('happy path (list)', function () {
    const LISTED = [Action.BORROW, Action.WITHDRAW_BASE];

    let listTx: ContractTransaction;

    after(async () => await snapshot.restore());

    it('an Operator lists Alice and Bob for BORROW and WITHDRAW_BASE', async () => {
      listTx = await gate.connect(operator).setListed([accounts[ALICE].address, accounts[BOB].address], LISTED, true);
      await expect(listTx).to.not.be.reverted;
    });

    it('emits ListedActionsSet', async () => {
      await expect(listTx)
        .to.emit(gate, 'ListedActionsSet')
        .withArgs([accounts[ALICE].address, accounts[BOB].address], LISTED, true);
    });

    ([['Alice', ALICE], ['Bob', BOB]] as [string, number][]).forEach(([who, index]) => {
      it(`lists ${who} for BORROW`, async () => {
        expect(await gate.isListed(accounts[index].address, Action.BORROW)).to.be.true;
      });

      it(`lists ${who} for WITHDRAW_BASE`, async () => {
        expect(await gate.isListed(accounts[index].address, Action.WITHDRAW_BASE)).to.be.true;
      });

      it(`exposes the listed actions of ${who}`, async () => {
        expect(await gate.listedActions(accounts[index].address)).to.equal(bitmap(...LISTED));
      });

      it(`keeps ${who} unlisted for the other actions`, async () => {
        for (const [, action] of ACTIONS.filter(([, a]) => !LISTED.includes(a))) {
          expect(await gate.isListed(accounts[index].address, action)).to.be.false;
        }
      });
    });

    it('keeps the other accounts unlisted', async () => {
      expect(await gate.listedActions(accounts[CAROL].address)).to.equal(0);
    });
  });

  describe('happy path (unlist)', function () {
    let unlistTx: ContractTransaction;

    before(async () => {
      await gate.connect(operator).setListed([accounts[ALICE].address], [Action.SUPPLY_BASE, Action.BORROW, Action.WITHDRAW_BASE], true);
    });

    after(async () => await snapshot.restore());

    it('an Operator unlists Alice for BORROW and WITHDRAW_BASE', async () => {
      unlistTx = await gate.connect(operator).setListed([accounts[ALICE].address], [Action.BORROW, Action.WITHDRAW_BASE], false);
      await expect(unlistTx).to.not.be.reverted;
    });

    it('emits ListedActionsSet', async () => {
      await expect(unlistTx)
        .to.emit(gate, 'ListedActionsSet')
        .withArgs([accounts[ALICE].address], [Action.BORROW, Action.WITHDRAW_BASE], false);
    });

    it('unlists Alice for BORROW', async () => {
      expect(await gate.isListed(accounts[ALICE].address, Action.BORROW)).to.be.false;
    });

    it('unlists Alice for WITHDRAW_BASE', async () => {
      expect(await gate.isListed(accounts[ALICE].address, Action.WITHDRAW_BASE)).to.be.false;
    });

    it('keeps Alice listed for SUPPLY_BASE', async () => {
      expect(await gate.isListed(accounts[ALICE].address, Action.SUPPLY_BASE)).to.be.true;
    });
  });

  // Listing more actions keeps the already listed ones.
  describe('happy path (extend a listing)', function () {
    let listTx: ContractTransaction;

    before(async () => {
      await gate.connect(operator).setListed([accounts[ALICE].address], [Action.SUPPLY_BASE], true);
    });

    after(async () => await snapshot.restore());

    it('an Operator lists Alice for BORROW', async () => {
      listTx = await gate.connect(operator).setListed([accounts[ALICE].address], [Action.BORROW], true);
      await expect(listTx).to.not.be.reverted;
    });

    it('lists Alice for BORROW', async () => {
      expect(await gate.isListed(accounts[ALICE].address, Action.BORROW)).to.be.true;
    });

    it('keeps Alice listed for SUPPLY_BASE', async () => {
      expect(await gate.isListed(accounts[ALICE].address, Action.SUPPLY_BASE)).to.be.true;
    });
  });

  describe('edge cases', function () {
    describe('no actions are passed', function () {
      after(async () => await snapshot.restore());

      it('an Operator lists Alice for no actions', async () => {
        await expect(gate.connect(operator).setListed([accounts[ALICE].address], [], true)).to.not.be.reverted;
      });

      it('keeps Alice unlisted', async () => {
        expect(await gate.listedActions(accounts[ALICE].address)).to.equal(0);
      });
    });
  });

  describe('revert when', function () {
    it('the caller holds no role', async () => {
      await expect(gate.connect(other).setListed([accounts[ALICE].address], [Action.BORROW], true))
        .to.be.revertedWith(missingRole(other.address, OPERATOR_ROLE));
    });

    it('the caller is the operator admin without the operator role', async () => {
      await expect(gate.connect(operatorAdmin).setListed([accounts[ALICE].address], [Action.BORROW], true))
        .to.be.revertedWith(missingRole(operatorAdmin.address, OPERATOR_ROLE));
    });

    it('the caller is the governor without the operator role', async () => {
      await expect(gate.connect(governor).setListed([accounts[ALICE].address], [Action.BORROW], true))
        .to.be.revertedWith(missingRole(governor.address, OPERATOR_ROLE));
    });

    it('the caller is a Pauser', async () => {
      await expect(gate.connect(pauser).setListed([accounts[ALICE].address], [Action.BORROW], true))
        .to.be.revertedWith(missingRole(pauser.address, OPERATOR_ROLE));
    });

    it('an action is undefined', async () => {
      await expect(gate.connect(operator).setListed([accounts[ALICE].address], [Action.BORROW, UNDEFINED_ACTION], true))
        .to.be.reverted;
    });

    it('an action is passed twice', async () => {
      await expect(gate.connect(operator).setListed([accounts[ALICE].address], [Action.BORROW, Action.BORROW], true))
        .to.be.revertedWithCustomError(gate, 'DuplicateAction').withArgs(Action.BORROW);
    });

    it('an account is passed twice', async () => {
      await expect(gate.connect(operator).setListed([accounts[ALICE].address, accounts[ALICE].address], [Action.BORROW], true))
        .to.be.revertedWithCustomError(gate, 'ListedStatusAlreadySet').withArgs(accounts[ALICE].address, Action.BORROW, true);
    });

    it('an account is not listed for an action being unlisted', async () => {
      await expect(gate.connect(operator).setListed([accounts[ALICE].address], [Action.BORROW], false))
        .to.be.revertedWithCustomError(gate, 'ListedStatusAlreadySet').withArgs(accounts[ALICE].address, Action.BORROW, false);
    });

    describe('an account is already listed', function () {
      before(async () => {
        await gate.connect(operator).setListed([accounts[ALICE].address], [Action.BORROW], true);
      });

      after(async () => await snapshot.restore());

      it('an account is listed again for the action', async () => {
        await expect(gate.connect(operator).setListed([accounts[ALICE].address], [Action.BORROW], true))
          .to.be.revertedWithCustomError(gate, 'ListedStatusAlreadySet').withArgs(accounts[ALICE].address, Action.BORROW, true);
      });

      it('an account is listed again for one of the actions', async () => {
        await expect(gate.connect(operator).setListed([accounts[ALICE].address], [Action.WITHDRAW_BASE, Action.BORROW], true))
          .to.be.revertedWithCustomError(gate, 'ListedStatusAlreadySet').withArgs(accounts[ALICE].address, Action.BORROW, true);
      });

      it('one of the accounts is listed again for the action', async () => {
        await expect(gate.connect(operator).setListed([accounts[BOB].address, accounts[ALICE].address], [Action.BORROW], true))
          .to.be.revertedWithCustomError(gate, 'ListedStatusAlreadySet').withArgs(accounts[ALICE].address, Action.BORROW, true);
      });
    });
  });
});
