import { ethers, exp, expect, makeProtocol } from '../../helpers';
import { CometHarnessInterfaceExtendedAssetList, DefaultAccessGate, FaucetToken } from '../../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { takeSnapshot, SnapshotRestorer } from '../../helpers/snapshot';
import { Action, NO_ASSET } from '../../helpers/access-gate';

// Comet checks supply against its access gate: a supply passes when the gate permits it and reverts with the
// gate error otherwise. A base supply leaving the account with no positive balance is REPAY, otherwise SUPPLY_BASE.
describe('comet with access gate: supply', function () {
  const LENT = exp(10_000, 6);
  const BORROWED = exp(100, 6);
  const AMOUNT = exp(50, 6);
  const COLLATERAL = exp(1, 18);

  let comet: CometHarnessInterfaceExtendedAssetList;
  let gate: DefaultAccessGate;
  let USDC: FaucetToken;
  let COMP: FaucetToken;
  let WETH: FaucetToken;
  let pauseGuardian: SignerWithAddress;
  let alice: SignerWithAddress; // lender
  let bob: SignerWithAddress; // borrower of BORROWED against WETH
  let charlie: SignerWithAddress; // no position, holds base, COMP and WETH
  let dave: SignerWithAddress; // no position
  let compIndex: number;

  let snapshot: SnapshotRestorer;

  before(async () => {
    const protocol = await makeProtocol();
    comet = protocol.cometWithExtendedAssetList;
    gate = protocol.accessGate;
    pauseGuardian = protocol.pauseGuardian;
    [alice, bob, charlie, dave] = protocol.users;
    USDC = protocol.tokens.USDC as FaucetToken;
    COMP = protocol.tokens.COMP as FaucetToken;
    WETH = protocol.tokens.WETH as FaucetToken;
    compIndex = (await comet.getAssetInfoByAddress(COMP.address)).offset;

    for (const user of [alice, bob, charlie]) {
      await USDC.allocateTo(user.address, LENT);
      await USDC.connect(user).approve(comet.address, ethers.constants.MaxUint256);
    }
    for (const user of [bob, charlie]) {
      await WETH.allocateTo(user.address, COLLATERAL);
      await WETH.connect(user).approve(comet.address, COLLATERAL);
    }
    await COMP.allocateTo(charlie.address, COLLATERAL);
    await COMP.connect(charlie).approve(comet.address, COLLATERAL);

    await comet.connect(alice).supply(USDC.address, LENT);
    await comet.connect(bob).supply(WETH.address, COLLATERAL);
    await comet.connect(bob).withdraw(USDC.address, BORROWED);

    snapshot = await takeSnapshot();
  });

  describe('happy path', function () {
    afterEach(async () => await snapshot.restore());

    it('Charlie supplies base', async () => {
      await expect(comet.connect(charlie).supply(USDC.address, AMOUNT)).to.not.be.reverted;
    });

    it('Charlie supplies base to Dave', async () => {
      await expect(comet.connect(charlie).supplyTo(dave.address, USDC.address, AMOUNT)).to.not.be.reverted;
    });

    it('Dave, allowed by Charlie, supplies base from Charlie to Alice', async () => {
      await comet.connect(charlie).allow(dave.address, true);
      await expect(comet.connect(dave).supplyFrom(charlie.address, alice.address, USDC.address, AMOUNT)).to.not.be.reverted;
    });

    it('Bob repays a part of the debt', async () => {
      await expect(comet.connect(bob).supply(USDC.address, AMOUNT)).to.not.be.reverted;
    });

    it('Charlie supplies COMP', async () => {
      await expect(comet.connect(charlie).supply(COMP.address, COLLATERAL)).to.not.be.reverted;
    });
  });

  // Repayment is a separate action, it stays available while supplying base is paused.
  describe('SUPPLY_BASE is paused', function () {
    before(async () => {
      await gate.connect(pauseGuardian).setActionPaused(Action.SUPPLY_BASE, true);
    });

    after(async () => await snapshot.restore());

    it('Bob repays a part of the debt', async () => {
      await expect(comet.connect(bob).supply(USDC.address, AMOUNT)).to.not.be.reverted;
    });

    it('reverts when Charlie supplies base', async () => {
      await expect(comet.connect(charlie).supply(USDC.address, AMOUNT))
        .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.SUPPLY_BASE, NO_ASSET);
    });

    it('reverts when Bob supplies more than the debt', async () => {
      await expect(comet.connect(bob).supply(USDC.address, BORROWED * 2n))
        .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.SUPPLY_BASE, NO_ASSET);
    });
  });

  describe('SUPPLY_COLLATERAL is paused for COMP', function () {
    before(async () => {
      await gate.connect(pauseGuardian).setCollateralPaused(Action.SUPPLY_COLLATERAL, compIndex, true);
    });

    after(async () => await snapshot.restore());

    it('Charlie supplies WETH', async () => {
      await expect(comet.connect(charlie).supply(WETH.address, COLLATERAL)).to.not.be.reverted;
    });

    it('reverts when Charlie supplies COMP', async () => {
      await expect(comet.connect(charlie).supply(COMP.address, COLLATERAL))
        .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.SUPPLY_COLLATERAL, compIndex);
    });
  });
});
