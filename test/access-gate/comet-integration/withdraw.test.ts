import { ethers, exp, expect, makeProtocol } from '../../helpers';
import { CometHarnessInterfaceExtendedAssetList, DefaultAccessGate, FaucetToken } from '../../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { takeSnapshot, SnapshotRestorer } from '../../helpers/snapshot';
import { Action, NO_ASSET } from '../../helpers/access-gate';

// Comet checks withdraw against its access gate: a withdraw passes when the gate permits it and reverts with the
// gate error otherwise. A base withdraw leaving the account with a negative balance is BORROW, otherwise WITHDRAW_BASE.
describe('comet with access gate: withdraw', function () {
  const LENT = exp(10_000, 6);
  const BORROWED = exp(100, 6);
  const AMOUNT = exp(50, 6);
  const COLLATERAL = exp(1, 18);
  const COLLATERAL_WITHDRAWN = exp(0.1, 18);

  let comet: CometHarnessInterfaceExtendedAssetList;
  let gate: DefaultAccessGate;
  let USDC: FaucetToken;
  let WETH: FaucetToken;
  let pauseGuardian: SignerWithAddress;
  let alice: SignerWithAddress; // lender of LENT
  let bob: SignerWithAddress; // borrower of BORROWED against WETH
  let charlie: SignerWithAddress; // no position
  let dave: SignerWithAddress; // lender of AMOUNT, with WETH collateral
  let wethIndex: number;

  let snapshot: SnapshotRestorer;

  before(async () => {
    const protocol = await makeProtocol();
    comet = protocol.cometWithExtendedAssetList;
    gate = protocol.accessGate;
    pauseGuardian = protocol.pauseGuardian;
    [alice, bob, charlie, dave] = protocol.users;
    USDC = protocol.tokens.USDC as FaucetToken;
    WETH = protocol.tokens.WETH as FaucetToken;
    wethIndex = (await comet.getAssetInfoByAddress(WETH.address)).offset;

    for (const user of [alice, dave]) {
      await USDC.allocateTo(user.address, LENT);
      await USDC.connect(user).approve(comet.address, ethers.constants.MaxUint256);
    }
    for (const user of [bob, dave]) {
      await WETH.allocateTo(user.address, COLLATERAL);
      await WETH.connect(user).approve(comet.address, COLLATERAL);
      await comet.connect(user).supply(WETH.address, COLLATERAL);
    }

    await comet.connect(alice).supply(USDC.address, LENT);
    await comet.connect(dave).supply(USDC.address, AMOUNT);
    await comet.connect(bob).withdraw(USDC.address, BORROWED);

    snapshot = await takeSnapshot();
  });

  describe('happy path', function () {
    afterEach(async () => await snapshot.restore());

    it('Alice withdraws base', async () => {
      await expect(comet.connect(alice).withdraw(USDC.address, AMOUNT)).to.not.be.reverted;
    });

    it('Alice withdraws base to Charlie', async () => {
      await expect(comet.connect(alice).withdrawTo(charlie.address, USDC.address, AMOUNT)).to.not.be.reverted;
    });

    it('Charlie, allowed by Alice, withdraws base from Alice to Dave', async () => {
      await comet.connect(alice).allow(charlie.address, true);
      await expect(comet.connect(charlie).withdrawFrom(alice.address, dave.address, USDC.address, AMOUNT)).to.not.be.reverted;
    });

    it('Bob borrows base', async () => {
      await expect(comet.connect(bob).withdraw(USDC.address, AMOUNT)).to.not.be.reverted;
    });

    it('Bob withdraws WETH', async () => {
      await expect(comet.connect(bob).withdraw(WETH.address, COLLATERAL_WITHDRAWN)).to.not.be.reverted;
    });
  });

  // Lenders keep withdrawing while borrowing is paused.
  describe('BORROW is paused', function () {
    before(async () => {
      await gate.connect(pauseGuardian).setActionPaused(Action.BORROW, true);
    });

    after(async () => await snapshot.restore());

    it('Alice withdraws base', async () => {
      await expect(comet.connect(alice).withdraw(USDC.address, AMOUNT)).to.not.be.reverted;
    });

    it('reverts when Bob borrows base', async () => {
      await expect(comet.connect(bob).withdraw(USDC.address, AMOUNT))
        .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.BORROW, NO_ASSET);
    });

    it('reverts when Dave withdraws more than the supplied base', async () => {
      await expect(comet.connect(dave).withdraw(USDC.address, AMOUNT * 2n))
        .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.BORROW, NO_ASSET);
    });
  });

  describe('WITHDRAW_COLLATERAL is paused for WETH', function () {
    before(async () => {
      await gate.connect(pauseGuardian).setCollateralPaused(Action.WITHDRAW_COLLATERAL, wethIndex, true);
    });

    after(async () => await snapshot.restore());

    it('reverts when Bob withdraws WETH', async () => {
      await expect(comet.connect(bob).withdraw(WETH.address, COLLATERAL_WITHDRAWN))
        .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.WITHDRAW_COLLATERAL, wethIndex);
    });
  });
});
