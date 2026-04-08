import {
  ethers,
  expect,
  exp,
  makeProtocol,
  SnapshotRestorer,
  takeSnapshot,
} from './helpers';
import {
  CometHarnessInterfaceExtendedAssetList,
  FaucetToken,
} from '../build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';

// Tests governor-only reserve management for CometWithExtendedAssetList.
// `withdrawReserves` extracts free reserves (balance − owed-to-suppliers + owed-by-borrowers)
// to a recipient. `approveThis` grants an ERC-20 allowance on any token held by the
// protocol, enabling collateral rescue, arbitrary-token recovery, or base-token
// extraction without the InsufficientReserves guard.
describe('withdrawReserves', function () {
  // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  // Tokens
  let base: FaucetToken;
  let collateral: FaucetToken;
  let unsupportedToken: FaucetToken;
  // Users
  let governor: SignerWithAddress;
  let alice: SignerWithAddress;
  let manager: SignerWithAddress;
  let bob: SignerWithAddress;
  // Snapshot
  let snapshot: SnapshotRestorer;

  before(async () => {
    // Disable tracking rewards to prevent uint64 overflow when accruing over 1 year
    // at very high utilization rates (100% util pushes tracking index beyond uint64 max)
    const protocol = await makeProtocol({
      baseTrackingSupplySpeed: 0,
      baseTrackingBorrowSpeed: 0,
    });
    comet = protocol.cometWithExtendedAssetList;

    base = protocol.tokens.USDC as FaucetToken;
    collateral = protocol.tokens.WETH as FaucetToken;
    unsupportedToken = protocol.unsupportedToken;
    governor = protocol.governor;
    [alice, bob, manager] = protocol.users;

    snapshot = await takeSnapshot();
  });

  describe('base token reserves', function () {
    // ── Initial market state ─────────────────────────────────────────────
    // Immediately after deployment: no tokens in the protocol, no positions.
    // getReserves() = balance − totalSupply + totalBorrow = 0 − 0 + 0 = 0.
    // Any positive withdrawal must revert; zero withdrawal is a no-op.

    describe('initial market state — freshly deployed protocol', function () {
      it('getReserves returns zero', async () => {
        expect(await comet.getReserves()).to.equal(0);
      });

      it('comet base token balance is zero', async () => {
        expect(await base.balanceOf(comet.address)).to.equal(0);
      });

      // Edge case: amount=0 satisfies `0 > unsigned256(0)` → false → no revert
      it('governor can withdraw zero amount without reverting', async () => {
        await expect(
          comet.connect(governor).withdrawReserves(alice.address, 0)
        ).to.not.be.reverted;
      });

      describe('revert when', function () {
        it('caller is not governor', async () => {
          await expect(
            comet.connect(alice).withdrawReserves(alice.address, 0)
          ).to.be.revertedWithCustomError(comet, 'Unauthorized');
        });

        it('amount is 1 when reserves are zero', async () => {
          await expect(
            comet.connect(governor).withdrawReserves(alice.address, 1)
          ).to.be.revertedWithCustomError(comet, 'InsufficientReserves');
        });
      });
    });

    // ── Seeded reserves — direct token transfer to protocol ──────────────
    // Models reserve injection (donations, fee top-ups).
    // No supply or borrow positions exist, so:
    //   reserves = balance − 0 + 0 = balance

    describe('seeded reserves — base token transferred directly to protocol', function () {
      const SEED_AMOUNT = exp(1_000, 6);    // 1,000 USDC
      const PARTIAL_AMOUNT = SEED_AMOUNT - exp(600, 6);   // 400 USDC

      describe('allocate tokens to comet to increase reserves', function () {
        it('allocate tokens to comet to increase reserves', async () => {
          await base.allocateTo(comet.address, SEED_AMOUNT);
        });

        it('getReserves equals the seeded balance', async () => {
          expect(await comet.getReserves()).to.equal(SEED_AMOUNT);
        });

        it('manual proof of reserves', async () => {
          const baseBalance = await base.balanceOf(comet.address);
          const totalSupply = await comet.totalSupply();
          const totalBorrow = await comet.totalBorrow();
          const reserves = baseBalance.add(totalSupply).sub(totalBorrow);
          expect(reserves).to.equal(SEED_AMOUNT);
        });
      });

      describe('revert when', function () {
        it('amount exceeds seeded reserves by one unit', async () => {
          await expect(
            comet.connect(governor).withdrawReserves(alice.address, SEED_AMOUNT + 1n)
          ).to.be.revertedWithCustomError(comet, 'InsufficientReserves');
        });

        it('amount exceeds reserves after a full withdrawal has already drained them', async () => {
          const snapshot = await takeSnapshot();
          await comet.connect(governor).withdrawReserves(alice.address, SEED_AMOUNT);

          await expect(
            comet.connect(governor).withdrawReserves(alice.address, 1)
          ).to.be.revertedWithCustomError(comet, 'InsufficientReserves');

          await snapshot.restore();
        });
      });

      describe('partial withdrawal', function () {
        let reservesBefore: bigint;
        let withdrawReservesTx: ContractTransaction;

        before(async () => {
          reservesBefore = (await comet.getReserves()).toBigInt();
        });

        it('governor withdraws partial amount', async () => {
          withdrawReservesTx = await comet.connect(governor).withdrawReserves(alice.address, PARTIAL_AMOUNT);
          await expect(withdrawReservesTx).to.not.be.reverted;
        });

        it('emits Transfer event from comet to recipient', async () => {
          await expect(withdrawReservesTx)
            .to.emit(base, 'Transfer')
            .withArgs(comet.address, alice.address, PARTIAL_AMOUNT);
        });

        it('emits WithdrawReserves event with correct args', async () => {
          await expect(withdrawReservesTx)
            .to.emit(comet, 'WithdrawReserves')
            .withArgs(alice.address, PARTIAL_AMOUNT);
        });

        it('recipient base token balance increases by the withdrawn amount', async () => {
          expect(withdrawReservesTx).to.changeTokenBalance(base, alice.address, PARTIAL_AMOUNT);
        });

        it('comet base token balance decreases by the withdrawn amount', async () => {
          expect(withdrawReservesTx).to.changeTokenBalance(base, comet.address, -PARTIAL_AMOUNT);
        });

        it('getReserves decreases by the withdrawn amount', async () => {
          // reserves = balance = SEED_AMOUNT − PARTIAL_AMOUNT (no supply or borrow)
          expect(await comet.getReserves()).to.equal(reservesBefore - PARTIAL_AMOUNT);
        });
      });

      describe('full withdrawal: remaining reserves are zero', function () {
        const remainingReserves = SEED_AMOUNT - PARTIAL_AMOUNT;

        it('governor withdraws remaining seed amount', async () => {
          await expect(
            comet.connect(governor).withdrawReserves(alice.address, remainingReserves)
          ).to.not.be.reverted;
        });

        it('getReserves returns zero after full withdrawal', async () => {
          expect(await comet.getReserves()).to.equal(0);
        });

        it('comet base token balance is zero after full withdrawal', async () => {
          expect(await base.balanceOf(comet.address)).to.equal(0);
        });

        it('recipient base token balance equals the full seed amount', async () => {
          expect(await base.balanceOf(alice.address)).to.equal(SEED_AMOUNT);
        });
      });
    });

    // ── Organic reserves — accumulated from protocol interest rate spread ─
    // Reserves grow naturally because borrowRate > supplyRate.
    // At 50% utilization (below kink of 80%):
    //   borrowRate ≈ 5.5% / year  (base 0.5% + slope 10% × 50%)
    //   supplyRate ≈ 2.5% / year  (base 0% + slope 5% × 50%)
    // After 1 year with 5,000 USDC borrowed from 10,000 USDC supplied:
    //   spread ≈ (5.5% − 2.5%) × 5,000 = 150 USDC  (approximate; compounding applies)

    describe('organic reserves — accumulated from protocol interest rate spread', function () {
      const SUPPLY_AMOUNT = exp(10_000, 6);  // 10,000 USDC
      const BORROW_AMOUNT = exp(5_000, 6);   //  5,000 USDC — 50% utilization
      const COLLATERAL_SUPPLY_AMOUNT = exp(10, 18);   //     10 WETH @ $3,000 = $30,000 collateral
      const ONE_YEAR = 31_536_000;

      before(async () => {
        // alice lends base token
        await base.allocateTo(alice.address, SUPPLY_AMOUNT);
        await base.connect(alice).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(alice).supply(base.address, SUPPLY_AMOUNT);

        // bob posts WETH collateral and borrows base token
        await collateral.allocateTo(bob.address, COLLATERAL_SUPPLY_AMOUNT);
        await collateral.connect(bob).approve(comet.address, COLLATERAL_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(collateral.address, COLLATERAL_SUPPLY_AMOUNT);
        await comet.connect(bob).withdraw(base.address, BORROW_AMOUNT);
      });

      describe('after one year passes', function () {
        it('getReserves is zero immediately after supply and borrow', async () => {
          // balance = 10,000 − 5,000 = 5,000; totalSupply = 10,000; totalBorrow = 5,000
          // reserves = 5,000 − 10,000 + 5,000 = 0
          expect(await comet.getReserves()).to.equal(0);
        });

        it('1 year passes', async () => {
          await ethers.provider.send('evm_increaseTime', [ONE_YEAR]);
          await ethers.provider.send('evm_mine', []);
        });

        it('getReserves is positive after interest accrual', async () => {
          expect(await comet.getReserves()).to.be.gt(0);
        });

        describe('governor withdraws partial reserves', function () {
          let withdrawAmount: bigint;
          let withdrawReservesTx: ContractTransaction;

          before(async () => {
            withdrawAmount = (await comet.getReserves()).toBigInt() / 2n;
          });

          it('governor withdraws half the available reserves', async () => {
            withdrawReservesTx = await comet.connect(governor).withdrawReserves(alice.address, withdrawAmount);
            await expect(withdrawReservesTx).to.not.be.reverted;
          });

          it('emits WithdrawReserves event with correct args', async () => {
            await expect(withdrawReservesTx)
              .to.emit(comet, 'WithdrawReserves')
              .withArgs(alice.address, withdrawAmount);
          });

          it('getReserves decreases by the withdrawn amount', async () => {
            // A new block may accrue a small additional amount; check ≥ expected remainder
            expect((await comet.getReserves()).toBigInt()).to.be.gte(withdrawAmount);
          });

          it('recipient base token balance increases by the withdrawn amount', async () => {
            expect(withdrawReservesTx).to.changeTokenBalance(base, alice.address, withdrawAmount);
          });

          it('comet base token balance decreases by the withdrawn amount', async () => {
            expect(withdrawReservesTx).to.changeTokenBalance(base, comet.address, -withdrawAmount);
          });
        });

        describe('governor withdraws all reserves', function () {
          it('governor withdraws all reserves', async () => {
            await expect(
              comet.connect(governor).withdrawReserves(alice.address, await comet.getReserves())
            ).to.not.be.reverted;
          });

          it('getReserves is near zero after full withdrawal', async () => {
            // Micro-accrual in the withdrawal block may add a tiny amount
            expect((await comet.getReserves()).toBigInt()).to.be.approximately(0, 1);
          });

          it('alice can withdraw the available protocol balance after reserves are drained', async () => {
            // Comet holds SUPPLY_AMOUNT − BORROW_AMOUNT in physical tokens.
            // Alice cannot withdraw her full accrued balance (most of it is lent to bob)
            // but she can withdraw exactly what the protocol physically holds.
            const cometBalance = (await base.balanceOf(comet.address)).toBigInt();
            await expect(
              comet.connect(alice).withdraw(base.address, cometBalance)
            ).to.not.be.reverted;
          });

          it('bob can still repay his borrow after reserves are drained', async () => {
            const bobBorrow = (await comet.callStatic.borrowBalanceOf(bob.address)).toBigInt();
            await base.allocateTo(bob.address, bobBorrow);
            await base.connect(bob).approve(comet.address, bobBorrow);
            await expect(
              comet.connect(bob).supply(base.address, bobBorrow)
            ).to.not.be.reverted;
          });
        });
      });
    });

    // ── Near-full utilization — phantom reserves ──────────────────────────
    // When 100% of supplied tokens are borrowed, comet holds 0 physical USDC.
    // As time passes the borrow-supply spread makes getReserves() positive, but
    // the protocol cannot honour a transfer — the ERC-20 transfer will fail.
    // Lenders are also locked until borrowers repay.

    describe('near-full utilization — phantom reserves cannot be extracted', function () {
      const SUPPLY_AMOUNT = exp(1_000, 6);  // 1,000 USDC
      const BORROW_AMOUNT = exp(1_000, 6);  // 1,000 USDC — 100% utilization
      const WETH_COLLATERAL = exp(10, 18);  //    10 WETH @ $3,000 = $30,000 collateral
      const ONE_YEAR = 31_536_000;

      before(async () => {
        // Restore state
        await snapshot.restore();

        await base.allocateTo(alice.address, SUPPLY_AMOUNT);
        await base.connect(alice).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(alice).supply(base.address, SUPPLY_AMOUNT);

        await collateral.allocateTo(bob.address, WETH_COLLATERAL);
        await collateral.connect(bob).approve(comet.address, WETH_COLLATERAL);
        await comet.connect(bob).supply(collateral.address, WETH_COLLATERAL);
        await comet.connect(bob).withdraw(base.address, BORROW_AMOUNT);
      });

      it('comet USDC balance is zero after full borrow', async () => {
        expect(await base.balanceOf(comet.address)).to.equal(0);
      });

      it('getReserves is zero immediately after full borrow', async () => {
        // balance = 0; totalSupply = 1,000; totalBorrow = 1,000 → reserves = 0
        expect(await comet.getReserves()).to.equal(0);
      });

      it('1 year passes', async () => {
        await ethers.provider.send('evm_increaseTime', [ONE_YEAR]);
        await ethers.provider.send('evm_mine', []);
      });

      it('getReserves shows positive value due to interest spread', async () => {
        // reserves = 0 − totalSupply + totalBorrow > 0 (borrow rate > supply rate)
        expect(await comet.getReserves()).to.be.gt(0);
      });

      it('comet base token physical balance remains zero', async () => {
        // Reserves are phantom: they exist in accounting but not in physical tokens
        expect(await base.balanceOf(comet.address)).to.equal(0);
      });

      it('governor tries to withdraw phantom reserves — physical balance is zero', async () => {
        // getReserves() > 0 but comet holds 0 USDC → ERC-20 transfer fails
        const reserves = (await comet.getReserves()).toBigInt();
        await expect(
          comet.connect(governor).withdrawReserves(alice.address, reserves)
        ).to.be.reverted;
      });

      it('alice cannot withdraw her supply position while comet has zero balance', async () => {
        const aliceBalance = (await comet.callStatic.balanceOf(alice.address)).toBigInt();
        await expect(
          comet.connect(alice).withdraw(base.address, aliceBalance)
        ).to.be.reverted;
      });

      describe('after bob repays in full', function () {
        before(async () => {
          const bobBorrow = (await comet.callStatic.borrowBalanceOf(bob.address)).toBigInt();
          await base.allocateTo(bob.address, bobBorrow);
          await base.connect(bob).approve(comet.address, bobBorrow);
          await comet.connect(bob).supply(base.address, bobBorrow);
        });

        it('comet base token balance covers alice total supply after repayment', async () => {
          const cometBalance = (await base.balanceOf(comet.address)).toBigInt();
          const aliceBalance = (await comet.callStatic.balanceOf(alice.address)).toBigInt();
          expect(cometBalance).to.be.gte(aliceBalance);
        });

        it('getReserves is positive after bob repays with interest', async () => {
          // Bob paid back principal + borrow interest; supply interest < borrow interest
          expect(await comet.getReserves()).to.be.gt(0);
        });

        it('governor can now withdraw reserves successfully', async () => {
          // governor withdraws FIRST while comet still holds bob's full repayment;
          // reserves < physical balance so the ERC-20 transfer succeeds
          const reserves = (await comet.getReserves()).toBigInt();
          await expect(
            comet.connect(governor).withdrawReserves(governor.address, reserves)
          ).to.not.be.reverted;
        });

        it('alice can now withdraw her original supply amount', async () => {
          // After governor drains reserves, comet still holds enough USDC for suppliers.
          // Withdraw SUPPLY_AMOUNT (alice's original principal) — safely under current balance.
          await expect(
            comet.connect(alice).withdraw(base.address, SUPPLY_AMOUNT)
          ).to.not.be.reverted;
        });
      });
    });

    // ── Multiple sequential reserve withdrawals ───────────────────────────
    // Verifies that the interest spread keeps accumulating between withdrawals
    // and each new tranche can be safely withdrawn after the previous is exhausted.

    describe('multiple reserve withdrawals over separate time periods', function () {
      const SUPPLY_AMOUNT = exp(10_000, 6);  // 10,000 USDC
      const BORROW_AMOUNT = exp(5_000, 6);   //  5,000 USDC
      const WETH_COLLATERAL = exp(10, 18);   //     10 WETH
      const HALF_YEAR = 15_768_000;

      let firstTrancheReserves: bigint;

      before(async () => {
        // Restore state
        await snapshot.restore();

        await base.allocateTo(alice.address, SUPPLY_AMOUNT);
        await base.connect(alice).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(alice).supply(base.address, SUPPLY_AMOUNT);

        await collateral.allocateTo(bob.address, WETH_COLLATERAL);
        await collateral.connect(bob).approve(comet.address, WETH_COLLATERAL);
        await comet.connect(bob).supply(collateral.address, WETH_COLLATERAL);
        await comet.connect(bob).withdraw(base.address, BORROW_AMOUNT);
      });

      it('reserves are 0 immediately after supply and borrow', async () => {
        expect(await comet.getReserves()).to.equal(0);
      });

      it('first period passes', async () => {
        await ethers.provider.send('evm_increaseTime', [HALF_YEAR]);
        await ethers.provider.send('evm_mine', []);
      });

      it('first tranche of reserves is positive', async () => {
        firstTrancheReserves = (await comet.getReserves()).toBigInt();
        expect(firstTrancheReserves).to.be.gt(0);
      });

      it('governor withdraws first tranche', async () => {
        await expect(
          comet.connect(governor).withdrawReserves(governor.address, firstTrancheReserves)
        ).to.not.be.reverted;
      });

      it('getReserves is near zero after first withdrawal', async () => {
        expect((await comet.getReserves()).toBigInt()).to.be.approximately(0, 1);
      });

      it('second period passes', async () => {
        await ethers.provider.send('evm_increaseTime', [HALF_YEAR]);
        await ethers.provider.send('evm_mine', []);
      });

      it('second tranche of reserves is positive', async () => {
        expect(await comet.getReserves()).to.be.gt(0);
      });

      it('governor withdraws second tranche', async () => {
        const reserves = (await comet.getReserves()).toBigInt();
        await expect(
          comet.connect(governor).withdrawReserves(governor.address, reserves)
        ).to.not.be.reverted;
      });

      it('getReserves is near zero after second withdrawal', async () => {
        expect((await comet.getReserves()).toBigInt()).to.be.approximately(0, 1);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  approveThis (arbitrary token rescue by governor)
  // ═══════════════════════════════════════════════════════════════════════════
  // approveThis sets an ERC-20 allowance on any token held by the protocol.
  // There is no InsufficientReserves guard — governance power only.
  // Used for: post-absorption collateral recovery, accidentally-sent token
  // rescue, or base-token extraction bypassing the reserves accounting check.

  describe('approveThis', function () {
    // ── Base token approval ───────────────────────────────────────────────
    // The governor can approve a manager to pull base tokens directly,
    // bypassing the reserves check used by withdrawReserves.
    // Useful for emergency extractions when getReserves() is negative.

    describe('base token approval', function () {
      // approveThis grants a raw ERC-20 allowance with no InsufficientReserves guard.
      // Each transferFrom reduces comet's balance directly, lowering getReserves.
      // This block verifies the full approval flow and its reserves impact together.

      const SEED_AMOUNT = exp(1_000, 6);  // 1,000 USDC seeded directly — no supply/borrow positions
      const EXTRACT_AMOUNT = exp(600, 6); // 600 USDC extracted via manager

      let extractTx: ContractTransaction;

      before(async () => {
        await snapshot.restore();
        await base.allocateTo(comet.address, SEED_AMOUNT);
      });

      it('getReserves equals seeded amount before approval', async () => {
        // reserves = balance − totalSupply + totalBorrow = 1,000 − 0 + 0 = 1,000
        expect(await comet.getReserves()).to.equal(SEED_AMOUNT);
      });

      it('governor sets approveThis for the base token and a manager', async () => {
        await expect(
          comet.connect(governor).approveThis(manager.address, base.address, SEED_AMOUNT)
        ).to.not.be.reverted;
      });

      it('allowance on USDC from comet to manager equals approved amount', async () => {
        expect(await base.allowance(comet.address, manager.address)).to.equal(SEED_AMOUNT);
      });

      it('manager extracts base token via approved allowance', async () => {
        extractTx = await base.connect(manager).transferFrom(comet.address, manager.address, EXTRACT_AMOUNT);
        await expect(extractTx).to.not.be.reverted;
      });

      it('emits Transfer event from comet to manager', async () => {
        await expect(extractTx)
          .to.emit(base, 'Transfer')
          .withArgs(comet.address, manager.address, EXTRACT_AMOUNT);
      });

      it('getReserves decreases by the extracted amount', async () => {
        // reserves = (1,000 − 600) − 0 + 0 = 400
        expect(await comet.getReserves()).to.equal(SEED_AMOUNT - EXTRACT_AMOUNT);
      });

      it('comet USDC balance decreases by the extracted amount', async () => {
        expect(extractTx).to.changeTokenBalance(base, comet.address, -EXTRACT_AMOUNT);
      });

      it('manager USDC balance equals extracted amount', async () => {
        expect(extractTx).to.changeTokenBalance(base, manager.address, EXTRACT_AMOUNT);
      });

      describe('revert when', function () {
        it('caller is not governor', async () => {
          await expect(
            comet.connect(alice).approveThis(manager.address, base.address, SEED_AMOUNT)
          ).to.be.revertedWithCustomError(comet, 'Unauthorized');
        });

        it('not approved address cannot extract base token', async () => {
          await expect(
            base.connect(alice).transferFrom(comet.address, alice.address, EXTRACT_AMOUNT)
          ).to.be.revertedWith('ERC20: transfer amount exceeds allowance');
        });
      });

      describe('full drain — approveThis bypasses InsufficientReserves guard', function () {
        // withdrawReserves reverts when amount > getReserves().
        // approveThis has no such guard: the manager can drain the remaining balance,
        // reducing getReserves to zero and blocking any future withdrawReserves call.

        const REMAINING = SEED_AMOUNT - EXTRACT_AMOUNT;  // 400 USDC remaining after partial extraction

        it('approveThis allowance on USDC from comet to manager equals remaining amount', async () => {
          await comet.connect(governor).approveThis(manager.address, base.address, REMAINING);
        });

        it('manager drains remaining base tokens', async () => {
          await expect(
            base.connect(manager).transferFrom(comet.address, manager.address, REMAINING)
          ).to.not.be.reverted;
        });

        it('getReserves is zero after full drain', async () => {
          expect(await comet.getReserves()).to.equal(0);
        });

        it('withdrawReserves reverts with InsufficientReserves after approveThis drained all reserves', async () => {
          await expect(
            comet.connect(governor).withdrawReserves(governor.address, 1)
          ).to.be.revertedWithCustomError(comet, 'InsufficientReserves');
        });
      });
    });

    // ── Collateral token approval ─────────────────────────────────────────
    // After absorptions, collateral tokens accumulate in comet and must be
    // rescued or sold. The governor uses approveThis to grant a manager
    // the allowance to move them. Alice supplying WETH places those tokens
    // physically in comet.address — the same mechanism as post-absorption rescue.

    describe('collateral token approval', function () {
      describe('approval and transfer', function () {
        // approveThis grants a raw ERC-20 allowance on the collateral token with no reserves guard.
        // Donating extra WETH creates positive collateral reserves; each manager transferFrom
        // reduces the physical balance and lowers getCollateralReserves.

        const DONATED_WETH = exp(5, 18);   // 5 WETH donated directly → collateral reserves = 5
        const EXTRACT_AMOUNT = exp(2, 18); // 2 WETH extracted by manager

        let extractTx: ContractTransaction;

        before(async () => {
          // Donate WETH directly to comet (outside supply) to create positive collateral reserves
          await collateral.allocateTo(comet.address, DONATED_WETH);
        });

        it('getCollateralReserves equals donated WETH before approval', async () => {
          expect(await comet.getCollateralReserves(collateral.address)).to.equal(DONATED_WETH);
        });

        it('governor sets approveThis for WETH and manager', async () => {
          await expect(
            comet.connect(governor).approveThis(manager.address, collateral.address, DONATED_WETH)
          ).to.not.be.reverted;
        });

        it('allowance on WETH from comet to manager equals approved amount', async () => {
          expect(await collateral.allowance(comet.address, manager.address)).to.equal(DONATED_WETH);
        });

        it('manager extracts collateral token via approved allowance', async () => {
          extractTx = await collateral.connect(manager).transferFrom(comet.address, manager.address, EXTRACT_AMOUNT);
          await expect(extractTx).to.not.be.reverted;
        });

        it('emits Transfer event from comet to manager', async () => {
          await expect(extractTx)
            .to.emit(collateral, 'Transfer')
            .withArgs(comet.address, manager.address, EXTRACT_AMOUNT);
        });

        it('getCollateralReserves decreases by the extracted amount', async () => {
          // getCollateralReserves = (5 + 2 − 1) − 5 = 1 WETH
          expect(await comet.getCollateralReserves(collateral.address)).to.equal(DONATED_WETH - EXTRACT_AMOUNT);
        });

        it('comet collateral balance decreases by the extracted amount', async () => {
          expect(extractTx).to.changeTokenBalance(collateral, comet.address, -EXTRACT_AMOUNT);
        });

        it('manager collateral balance equals extracted amount', async () => {
          expect(extractTx).to.changeTokenBalance(collateral, manager.address, EXTRACT_AMOUNT);
        });
      });

      // Models the two-step pattern required by some non-standard tokens (e.g. USDT)
      // that revert when setting a non-zero allowance over an existing non-zero value.
      // The governor must reset to 0 before setting a new value.
      describe('reset and re-approve', function () {
        const NEW_AMOUNT = exp(2, 18);

        before(async () => {
          // Establish an initial non-zero approval
          await comet.connect(governor).approveThis(manager.address, collateral.address, NEW_AMOUNT);
        });

        it('governor resets WETH allowance to zero', async () => {
          await expect(
            comet.connect(governor).approveThis(manager.address, collateral.address, 0)
          ).to.not.be.reverted;
        });

        it('WETH allowance from comet to manager is zero after reset', async () => {
          expect(await collateral.allowance(comet.address, manager.address)).to.equal(0);
        });

        it('governor sets a new non-zero WETH allowance after reset', async () => {
          await expect(
            comet.connect(governor).approveThis(manager.address, collateral.address, NEW_AMOUNT)
          ).to.not.be.reverted;
        });

        it('WETH allowance from comet to manager equals the new amount', async () => {
          expect(await collateral.allowance(comet.address, manager.address)).to.equal(NEW_AMOUNT);
        });

        it('manager can use the new allowance to transfer WETH out of comet', async () => {
          await expect(
            collateral.connect(manager).transferFrom(comet.address, manager.address, NEW_AMOUNT)
          ).to.not.be.reverted;
        });
      });

      describe('revert when', function () {
        it('caller is not governor', async () => {
          await expect(
            comet.connect(alice).approveThis(manager.address, collateral.address, 1)
          ).to.be.revertedWithCustomError(comet, 'Unauthorized');
        });

        it('not approved address cannot extract collateral token', async () => {
          await expect(
            collateral.connect(alice).transferFrom(comet.address, alice.address, 1)
          ).to.be.revertedWith('ERC20: transfer amount exceeds allowance');
        });
      });
    });

    // ── Arbitrary token rescue ────────────────────────────────────────────
    // Any ERC-20 accidentally sent to comet can be recovered via approveThis.
    // Uses unsupportedToken (not in comet's asset list) as the rescue target.

    describe('arbitrary token rescue', function () {
      const RESCUE_AMOUNT = exp(1_000, 6);  // 1,000 of the unsupported token
      let extractTx: ContractTransaction;

      before(async () => {
        await unsupportedToken.allocateTo(comet.address, RESCUE_AMOUNT);
      });

      it('comet holds the accidentally sent arbitrary token', async () => {
        expect(await unsupportedToken.balanceOf(comet.address)).to.equal(RESCUE_AMOUNT);
      });

      it('governor sets approveThis for the arbitrary token and manager', async () => {
        await expect(
          comet.connect(governor).approveThis(manager.address, unsupportedToken.address, RESCUE_AMOUNT)
        ).to.not.be.reverted;
      });

      it('arbitrary token allowance from comet to manager equals approved amount', async () => {
        expect(await unsupportedToken.allowance(comet.address, manager.address)).to.equal(RESCUE_AMOUNT);
      });

      it('manager can transferFrom the arbitrary token out of comet', async () => {
        extractTx = await unsupportedToken.connect(manager).transferFrom(comet.address, manager.address, RESCUE_AMOUNT);
        await expect(extractTx).to.not.be.reverted;
      });

      it('comet arbitrary token balance is zero after rescue', async () => {
        expect(extractTx).to.changeTokenBalance(unsupportedToken, comet.address, -RESCUE_AMOUNT);
      });

      it('manager holds the rescued tokens', async () => {
        expect(extractTx).to.changeTokenBalance(unsupportedToken, manager.address, RESCUE_AMOUNT);
      });

      describe('revert when', function () {
        it('caller is not governor', async () => {
          await expect(
            comet.connect(alice).approveThis(manager.address, unsupportedToken.address, RESCUE_AMOUNT)
          ).to.be.revertedWithCustomError(comet, 'Unauthorized');
        });

        it('not approved address cannot extract arbitrary token', async () => {
          await expect(
            unsupportedToken.connect(alice).transferFrom(comet.address, alice.address, RESCUE_AMOUNT)
          ).to.be.revertedWith('ERC20: transfer amount exceeds allowance');
        });
      });
    });
  });
});
