import { ethers, exp, expect, makeProtocol } from '../../helpers';
import { CometHarnessInterfaceExtendedAssetList, FaucetToken, ListAccessGate } from '../../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { takeSnapshot, SnapshotRestorer } from '../../helpers/snapshot';
import { ACTIONS, Action } from '../../helpers/access-gate';

// Comet with a list gate reverts with Blocked when a party of the action is blocked: the caller (operator), the
// account and the counterparty. BlocklistGate blocks the listed parties, AllowlistGate blocks the unlisted ones.
// For AllowlistGate every party is allowlisted for every action, then unlisted for a single action to block it.
describe('comet with access gate: list gates', function () {
  const LENT = exp(10_000, 6);
  const BORROWED = exp(2_000, 6);
  const AMOUNT = exp(100, 6);
  const COLLATERAL = exp(1, 18);
  const WETH_PRICE_DROPPED = exp(1_000, 8);

  [
    { gateName: 'BlocklistGate' as const, listedIsBlocked: true },
    { gateName: 'AllowlistGate' as const, listedIsBlocked: false },
  ].forEach(({ gateName, listedIsBlocked }) => {
    describe(gateName, function () {
      let comet: CometHarnessInterfaceExtendedAssetList;
      let gate: ListAccessGate;
      let USDC: FaucetToken;
      let WETH: FaucetToken;
      let listOperator: SignerWithAddress; // holds OPERATOR_ROLE of the gate
      let alice: SignerWithAddress; // lender, allowed Charlie to manage her account
      let bob: SignerWithAddress; // counterparty
      let charlie: SignerWithAddress; // manager of Alice
      let dave: SignerWithAddress; // borrower, underwater after the WETH price drop
      let eve: SignerWithAddress; // liquidator and buyer of collateral

      let snapshot: SnapshotRestorer;

      const block = (party: SignerWithAddress, action: number) =>
        gate.connect(listOperator).setListed([party.address], [action], listedIsBlocked);

      before(async () => {
        const protocol = await makeProtocol({ accessGateContract: gateName, targetReserves: exp(1_000_000, 6) });
        comet = protocol.cometWithExtendedAssetList;
        gate = (await ethers.getContractAt('ListAccessGate', protocol.accessGate.address)) as ListAccessGate;
        listOperator = protocol.pauseGuardian;
        [alice, bob, charlie, dave, eve] = protocol.users;
        USDC = protocol.tokens.USDC as FaucetToken;
        WETH = protocol.tokens.WETH as FaucetToken;

        if (!listedIsBlocked) {
          const everyone = [alice, bob, charlie, dave, eve].map((user) => user.address);
          await gate.connect(listOperator).setListed(everyone, ACTIONS.map(([, action]) => action), true);
        }

        for (const user of [alice, eve]) {
          await USDC.allocateTo(user.address, LENT);
          await USDC.connect(user).approve(comet.address, ethers.constants.MaxUint256);
        }
        await comet.connect(alice).supply(USDC.address, LENT / 2n);
        await comet.connect(alice).allow(charlie.address, true);

        await WETH.allocateTo(dave.address, COLLATERAL);
        await WETH.connect(dave).approve(comet.address, COLLATERAL);
        await comet.connect(dave).supply(WETH.address, COLLATERAL);
        await comet.connect(dave).withdraw(USDC.address, BORROWED);
        await protocol.priceFeeds.WETH.setRoundData(0, WETH_PRICE_DROPPED, 0, 0, 0);

        // Collateral reserves for sale
        await WETH.allocateTo(comet.address, COLLATERAL);

        snapshot = await takeSnapshot();
      });

      // Charlie (operator) supplies from Alice (counterparty) to Bob (account).
      describe('supplyFrom', function () {
        const supplyFrom = () => comet.connect(charlie).supplyFrom(alice.address, bob.address, USDC.address, AMOUNT);

        afterEach(async () => await snapshot.restore());

        it('passes when every party is permitted', async () => {
          await expect(supplyFrom()).to.not.be.reverted;
        });

        it('reverts when the operator is blocked', async () => {
          await block(charlie, Action.SUPPLY_BASE);
          await expect(supplyFrom()).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(charlie.address, Action.SUPPLY_BASE);
        });

        it('reverts when the account is blocked', async () => {
          await block(bob, Action.SUPPLY_BASE);
          await expect(supplyFrom()).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(bob.address, Action.SUPPLY_BASE);
        });

        it('reverts when the counterparty is blocked', async () => {
          await block(alice, Action.SUPPLY_BASE);
          await expect(supplyFrom()).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(alice.address, Action.SUPPLY_BASE);
        });
      });

      // Charlie (operator) withdraws from Alice (account) to Bob (counterparty).
      describe('withdrawFrom', function () {
        const withdrawFrom = () => comet.connect(charlie).withdrawFrom(alice.address, bob.address, USDC.address, AMOUNT);

        afterEach(async () => await snapshot.restore());

        it('passes when every party is permitted', async () => {
          await expect(withdrawFrom()).to.not.be.reverted;
        });

        it('reverts when the operator is blocked', async () => {
          await block(charlie, Action.WITHDRAW_BASE);
          await expect(withdrawFrom()).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(charlie.address, Action.WITHDRAW_BASE);
        });

        it('reverts when the account is blocked', async () => {
          await block(alice, Action.WITHDRAW_BASE);
          await expect(withdrawFrom()).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(alice.address, Action.WITHDRAW_BASE);
        });

        it('reverts when the counterparty is blocked', async () => {
          await block(bob, Action.WITHDRAW_BASE);
          await expect(withdrawFrom()).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(bob.address, Action.WITHDRAW_BASE);
        });
      });

      // Charlie (operator) transfers from Alice (account) to Bob (counterparty).
      describe('transferFrom', function () {
        const transferFrom = () => comet.connect(charlie).transferFrom(alice.address, bob.address, AMOUNT);

        afterEach(async () => await snapshot.restore());

        it('passes when every party is permitted', async () => {
          await expect(transferFrom()).to.not.be.reverted;
        });

        it('reverts when the operator is blocked', async () => {
          await block(charlie, Action.TRANSFER_BASE);
          await expect(transferFrom()).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(charlie.address, Action.TRANSFER_BASE);
        });

        it('reverts when the account is blocked', async () => {
          await block(alice, Action.TRANSFER_BASE);
          await expect(transferFrom()).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(alice.address, Action.TRANSFER_BASE);
        });

        it('reverts when the counterparty is blocked', async () => {
          await block(bob, Action.TRANSFER_BASE);
          await expect(transferFrom()).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(bob.address, Action.TRANSFER_BASE);
        });
      });

      // Eve (operator and account) absorbs Dave with Bob (counterparty) as the absorber.
      describe('absorb', function () {
        const absorb = () => comet.connect(eve).absorb(bob.address, [dave.address]);

        afterEach(async () => await snapshot.restore());

        it('passes when every party is permitted', async () => {
          await expect(absorb()).to.not.be.reverted;
        });

        it('reverts when the caller is blocked', async () => {
          await block(eve, Action.ABSORB);
          await expect(absorb()).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(eve.address, Action.ABSORB);
        });

        it('reverts when the absorber is blocked', async () => {
          await block(bob, Action.ABSORB);
          await expect(absorb()).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(bob.address, Action.ABSORB);
        });

        it('passes when the absorbed account is blocked', async () => {
          await block(dave, Action.ABSORB);
          await expect(absorb()).to.not.be.reverted;
        });
      });

      // Eve (operator and account) buys WETH for Bob (counterparty).
      describe('buyCollateral', function () {
        const buyCollateral = () => comet.connect(eve).buyCollateral(WETH.address, 0, AMOUNT, bob.address);

        afterEach(async () => await snapshot.restore());

        it('passes when every party is permitted', async () => {
          await expect(buyCollateral()).to.not.be.reverted;
        });

        it('reverts when the caller is blocked', async () => {
          await block(eve, Action.BUY_COLLATERAL);
          await expect(buyCollateral()).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(eve.address, Action.BUY_COLLATERAL);
        });

        it('reverts when the recipient is blocked', async () => {
          await block(bob, Action.BUY_COLLATERAL);
          await expect(buyCollateral()).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(bob.address, Action.BUY_COLLATERAL);
        });
      });
    });
  });
});
