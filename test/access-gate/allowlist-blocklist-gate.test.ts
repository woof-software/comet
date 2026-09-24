import { ethers, exp, expect } from '../helpers';
import { ListAccessGate } from '../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { takeSnapshot, SnapshotRestorer } from '../helpers/snapshot';
import { ACTIONS, Action, NO_ASSET, deployListAccessGateFixture } from '../helpers/access-gate';

// AllowlistGate blocks every account from every action unless it is listed for the action; BlocklistGate blocks
// the accounts listed for the action. Both check the account and the counterparty of an action (a zero
// counterparty is skipped) on top of the pause state. REPAY, WITHDRAW_RESERVES and APPROVE_THIS are exempt from
// the list policy, the pauses still apply to them. Below, a "permitted" party is one the gate's list lets through
// (listed for AllowlistGate, unlisted for BlocklistGate), a "blocked" party is the opposite.
describe('allowlist and blocklist gates', function () {
  const ZERO = ethers.constants.AddressZero;
  const AMOUNT = exp(1, 18);

  const EXEMPT_ACTIONS = ACTIONS.filter(([, action]) =>
    [Action.REPAY, Action.WITHDRAW_RESERVES, Action.APPROVE_THIS].includes(action)
  );
  const LISTED_ACTIONS = ACTIONS.filter(([, action]) => !EXEMPT_ACTIONS.some(([, exempt]) => exempt === action));

  [
    { gateName: 'AllowlistGate' as const, listedIsBlocked: false },
    { gateName: 'BlocklistGate' as const, listedIsBlocked: true },
  ].forEach(({ gateName, listedIsBlocked }) => {
    describe(gateName, function () {
      let gate: ListAccessGate;
      let pauser: SignerWithAddress;
      let cometSigner: SignerWithAddress;

      let listed: SignerWithAddress; // listed for every action
      let partiallyListed: SignerWithAddress; // listed for BORROW only
      let unlisted: SignerWithAddress; // listed for no action
      let permitted: SignerWithAddress[];
      let blocked: SignerWithAddress[];

      let snapshot: SnapshotRestorer;

      before(async () => {
        let operator: SignerWithAddress;
        let accounts: SignerWithAddress[];
        ({ gate, pauser, operator, cometSigner, accounts } = await deployListAccessGateFixture(gateName));

        const [listed1, listed2, partial, unlisted1, unlisted2] = accounts;
        await gate.connect(operator).setListed([listed1.address, listed2.address], ACTIONS.map(([, action]) => action), true);
        await gate.connect(operator).setListed([partial.address], [Action.BORROW], true);

        listed = listed1;
        partiallyListed = partial;
        unlisted = unlisted1;
        permitted = listedIsBlocked ? [unlisted1, unlisted2] : [listed1, listed2];
        blocked = listedIsBlocked ? [listed1, listed2] : [unlisted1, unlisted2];

        snapshot = await takeSnapshot();
      });

      /*//////////////////////////////////////////////////////////////
                                isBlocked
      //////////////////////////////////////////////////////////////*/

      describe('isBlocked', function () {
        it(`reports a listed account as ${listedIsBlocked ? 'blocked' : 'not blocked'}`, async () => {
          expect(await gate.isBlocked(listed.address, Action.BORROW)).to.equal(listedIsBlocked);
        });

        it(`reports an unlisted account as ${listedIsBlocked ? 'not blocked' : 'blocked'}`, async () => {
          expect(await gate.isBlocked(unlisted.address, Action.BORROW)).to.equal(!listedIsBlocked);
        });

        it(`reports an account listed for BORROW only as ${listedIsBlocked ? 'blocked' : 'not blocked'} for BORROW`, async () => {
          expect(await gate.isBlocked(partiallyListed.address, Action.BORROW)).to.equal(listedIsBlocked);
        });

        it(`reports an account listed for BORROW only as ${listedIsBlocked ? 'not blocked' : 'blocked'} for WITHDRAW_BASE`, async () => {
          expect(await gate.isBlocked(partiallyListed.address, Action.WITHDRAW_BASE)).to.equal(!listedIsBlocked);
        });
      });

      /*//////////////////////////////////////////////////////////////
                                checkAccess
      //////////////////////////////////////////////////////////////*/

      describe('checkAccess', function () {
        const checkAccess = (action: number, operator: string, account: string, counterparty: string) =>
          gate.connect(cometSigner).checkAccess(action, operator, account, counterparty, NO_ASSET, AMOUNT);

        describe('list policy', function () {
          LISTED_ACTIONS.forEach(([name, action]) => {
            it(`permits ${name} when both parties are permitted`, async () => {
              await expect(checkAccess(action, permitted[0].address, permitted[0].address, permitted[1].address)).to.not.be.reverted;
            });
          });

          LISTED_ACTIONS.forEach(([name, action]) => {
            it(`rejects ${name} when the account is blocked`, async () => {
              await expect(checkAccess(action, permitted[0].address, blocked[0].address, permitted[1].address))
                .to.be.revertedWithCustomError(gate, 'Blocked').withArgs(blocked[0].address, action);
            });
          });

          it('rejects BORROW when the counterparty is blocked', async () => {
            await expect(checkAccess(Action.BORROW, permitted[0].address, permitted[0].address, blocked[1].address))
              .to.be.revertedWithCustomError(gate, 'Blocked').withArgs(blocked[1].address, Action.BORROW);
          });

          it('permits BORROW when the counterparty is the zero address', async () => {
            await expect(checkAccess(Action.BORROW, permitted[0].address, permitted[0].address, ZERO)).to.not.be.reverted;
          });

          it('permits BORROW when the operator is blocked', async () => {
            await expect(checkAccess(Action.BORROW, blocked[0].address, permitted[0].address, permitted[1].address)).to.not.be.reverted;
          });

          it(`${listedIsBlocked ? 'rejects' : 'permits'} BORROW for an account listed for BORROW only`, async () => {
            const check = checkAccess(Action.BORROW, permitted[0].address, partiallyListed.address, permitted[1].address);
            if (listedIsBlocked) {
              await expect(check).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(partiallyListed.address, Action.BORROW);
            } else {
              await expect(check).to.not.be.reverted;
            }
          });

          it(`${listedIsBlocked ? 'permits' : 'rejects'} WITHDRAW_BASE for an account listed for BORROW only`, async () => {
            const check = checkAccess(Action.WITHDRAW_BASE, permitted[0].address, partiallyListed.address, permitted[1].address);
            if (listedIsBlocked) {
              await expect(check).to.not.be.reverted;
            } else {
              await expect(check).to.be.revertedWithCustomError(gate, 'Blocked').withArgs(partiallyListed.address, Action.WITHDRAW_BASE);
            }
          });

          EXEMPT_ACTIONS.forEach(([name, action]) => {
            it(`permits ${name} when both parties are blocked`, async () => {
              await expect(checkAccess(action, blocked[0].address, blocked[0].address, blocked[1].address)).to.not.be.reverted;
            });
          });
        });

        describe('an action is paused', function () {
          before(async () => {
            await gate.connect(pauser).setActionPaused(Action.BORROW, true);
            await gate.connect(pauser).setActionPaused(Action.REPAY, true);
          });

          after(async () => await snapshot.restore());

          it('rejects BORROW when both parties are permitted', async () => {
            await expect(checkAccess(Action.BORROW, permitted[0].address, permitted[0].address, permitted[1].address))
              .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.BORROW, NO_ASSET);
          });

          it('rejects REPAY although it is exempt from the list policy', async () => {
            await expect(checkAccess(Action.REPAY, permitted[0].address, permitted[0].address, permitted[1].address))
              .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.REPAY, NO_ASSET);
          });
        });
      });

      /*//////////////////////////////////////////////////////////////
                              postAccessAction
      //////////////////////////////////////////////////////////////*/

      // The list policy is enforced before the action only.
      describe('postAccessAction', function () {
        it('accepts BORROW from the Comet when both parties are blocked', async () => {
          await expect(
            gate.connect(cometSigner).postAccessAction(Action.BORROW, blocked[0].address, blocked[0].address, blocked[1].address, NO_ASSET, AMOUNT)
          ).to.not.be.reverted;
        });
      });
    });
  });
});
