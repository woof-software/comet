import { ethers, exp, expect, makeProtocol } from '../../helpers';
import { CometHarnessInterfaceExtendedAssetList, DefaultAccessGate, FaucetToken } from '../../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { takeSnapshot, SnapshotRestorer } from '../../helpers/snapshot';
import { Action, NO_ASSET } from '../../helpers/access-gate';

// Comet checks transfer against its access gate: a transfer passes when the gate permits it and reverts with the
// gate error otherwise. A base transfer leaving the source with a negative balance is TRANSFER_BASE_BORROW,
// otherwise TRANSFER_BASE.
describe('comet with access gate: transfer', function () {
  const LENT = exp(10_000, 6);
  const BORROWED = exp(100, 6);
  const AMOUNT = exp(50, 6);
  const COLLATERAL = exp(1, 18);
  const COLLATERAL_TRANSFERRED = exp(0.1, 18);

  let comet: CometHarnessInterfaceExtendedAssetList;
  let gate: DefaultAccessGate;
  let USDC: FaucetToken;
  let WETH: FaucetToken;
  let pauseGuardian: SignerWithAddress;
  let alice: SignerWithAddress; // lender of LENT
  let bob: SignerWithAddress; // borrower of BORROWED against WETH
  let charlie: SignerWithAddress; // no position
  let dave: SignerWithAddress; // no position
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

    await USDC.allocateTo(alice.address, LENT);
    await USDC.connect(alice).approve(comet.address, ethers.constants.MaxUint256);
    await WETH.allocateTo(bob.address, COLLATERAL);
    await WETH.connect(bob).approve(comet.address, COLLATERAL);

    await comet.connect(alice).supply(USDC.address, LENT);
    await comet.connect(bob).supply(WETH.address, COLLATERAL);
    await comet.connect(bob).withdraw(USDC.address, BORROWED);

    snapshot = await takeSnapshot();
  });

  describe('happy path', function () {
    afterEach(async () => await snapshot.restore());

    it('Alice transfers base to Charlie', async () => {
      await expect(comet.connect(alice).transfer(charlie.address, AMOUNT)).to.not.be.reverted;
    });

    it('Charlie, allowed by Alice, transfers base from Alice to Dave', async () => {
      await comet.connect(alice).allow(charlie.address, true);
      await expect(comet.connect(charlie).transferFrom(alice.address, dave.address, AMOUNT)).to.not.be.reverted;
    });

    it('Bob transfers base to Charlie', async () => {
      await expect(comet.connect(bob).transfer(charlie.address, AMOUNT)).to.not.be.reverted;
    });

    it('Bob transfers WETH to Charlie', async () => {
      await expect(comet.connect(bob).transferAsset(charlie.address, WETH.address, COLLATERAL_TRANSFERRED)).to.not.be.reverted;
    });

    it('Dave, allowed by Bob, transfers WETH from Bob to Charlie', async () => {
      await comet.connect(bob).allow(dave.address, true);
      await expect(comet.connect(dave).transferAssetFrom(bob.address, charlie.address, WETH.address, COLLATERAL_TRANSFERRED))
        .to.not.be.reverted;
    });
  });

  // Lenders keep transferring while borrowing transfers are paused.
  describe('TRANSFER_BASE_BORROW is paused', function () {
    before(async () => {
      await gate.connect(pauseGuardian).setActionPaused(Action.TRANSFER_BASE_BORROW, true);
    });

    after(async () => await snapshot.restore());

    it('Alice transfers base to Charlie', async () => {
      await expect(comet.connect(alice).transfer(charlie.address, AMOUNT)).to.not.be.reverted;
    });

    it('reverts when Bob transfers base to Charlie', async () => {
      await expect(comet.connect(bob).transfer(charlie.address, AMOUNT))
        .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.TRANSFER_BASE_BORROW, NO_ASSET);
    });
  });

  describe('TRANSFER_COLLATERAL is paused for WETH', function () {
    before(async () => {
      await gate.connect(pauseGuardian).setCollateralPaused(Action.TRANSFER_COLLATERAL, wethIndex, true);
    });

    after(async () => await snapshot.restore());

    it('reverts when Bob transfers WETH to Charlie', async () => {
      await expect(comet.connect(bob).transferAsset(charlie.address, WETH.address, COLLATERAL_TRANSFERRED))
        .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.TRANSFER_COLLATERAL, wethIndex);
    });
  });
});
