import { ethers, expect, exp, makeProtocol, ReentryAttack, setTotalsBasic, fastForward, baseBalanceOf } from './helpers';
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers';
import { EvilToken, EvilToken__factory, CometHarnessInterface, FaucetToken, CometHarnessInterfaceExtendedAssetList } from '../build/types';
import { ContractTransaction } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

describe('withdraw', function () {
  const baseTokenDecimals = 6;

  let comet: CometHarnessInterface;
  let baseToken: FaucetToken;
  let collaterals: { [symbol: string]: FaucetToken };
  let unsupportedToken: FaucetToken;

  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;

  let baseSnapshot: SnapshotRestorer;

  before(async function () {
    const protocol = await makeProtocol({ base: 'USDC' });

    comet = protocol.comet;
    baseToken = protocol.tokens[protocol.base] as FaucetToken;
    collaterals = Object.fromEntries(
      Object.entries(protocol.tokens).filter(([_symbol, token]) => token.address !== baseToken.address)
    ) as { [symbol: string]: FaucetToken };
    pauseGuardian = protocol.pauseGuardian;
    unsupportedToken = protocol.unsupportedToken;

    alice = protocol.users[0];
    bob = protocol.users[1];

    await baseToken.allocateTo(alice.address, exp(1e10, baseTokenDecimals));
    await baseToken.allocateTo(bob.address, exp(1e10, baseTokenDecimals));

    baseSnapshot = await takeSnapshot();
  });

  describe('withdraw base asset', function () {
    describe('reverts', function () {
      const COLLATERAL_AMOUNT = exp(100, 6);
      const SUPPLY_AMOUNT = exp(100, 6);
      const BORROW_AMOUNT = exp(80, 6);
      const COLLATERAL_SUPPLY = exp(1, 18);

      it('reverts if withdraw is paused', async () => {
        await comet.connect(pauseGuardian).pause(false, false, true, false, false);
        expect(await comet.isWithdrawPaused()).to.be.true;

        await expect(comet.connect(alice).withdraw(baseToken.address, 1)).to.be.revertedWithCustomError(comet, 'Paused');
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });

      it('reverts if withdrawing more than available liquidity', async () => {
        const snapshot = await takeSnapshot();
        
        await baseToken.connect(alice).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(alice).supply(baseToken.address, SUPPLY_AMOUNT);

        await collaterals['WETH'].allocateTo(bob.address, COLLATERAL_SUPPLY);
        await collaterals['WETH'].connect(bob).approve(comet.address, COLLATERAL_SUPPLY);
        await comet.connect(bob).supply(collaterals['WETH'].address, COLLATERAL_SUPPLY);
        await comet.connect(bob).withdraw(baseToken.address, BORROW_AMOUNT);

        await expect(
          comet.connect(alice).withdraw(baseToken.address, SUPPLY_AMOUNT)
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance');
        
        await snapshot.restore();
      });

      it('reverts if withdraw max for a collateral asset', async () => {
        const snapshot = await takeSnapshot();
        
        const collateral = collaterals['COMP'];
        await collateral.allocateTo(bob.address, COLLATERAL_AMOUNT);

        await expect(
          comet.connect(bob).withdraw(collateral.address, ethers.constants.MaxUint256)
        ).to.be.revertedWithCustomError(comet, 'InvalidUInt128');
        
        await snapshot.restore();
      });

      it('reverts if asset is neither collateral nor base (arithmetic underflow)', async () => {
        await expect(
          comet.connect(alice).withdraw(unsupportedToken.address, 1)
        ).to.be.revertedWithPanic(0x11); // Arithmetic underflow
      });

      it('reverts if borrow amount exceeds collateral backing', async () => {
        await expect(
          comet.connect(alice).withdraw(baseToken.address, exp(1000, baseTokenDecimals))
        ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
      });
    });

    describe('withdraw base: happy path', function () {
      const SUPPLY_AMOUNT: bigint = exp(100, baseTokenDecimals);
      let withdrawTx: ContractTransaction;
      let bobTokenBalanceBefore: bigint;
      let bobCometBalanceBefore: bigint;
      let totalSupplyBaseBefore: bigint;

      before(async () => {
        await baseSnapshot.restore();
        
        await baseToken.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, SUPPLY_AMOUNT);

        bobTokenBalanceBefore = (await baseToken.balanceOf(bob.address)).toBigInt();
        bobCometBalanceBefore = (await comet.balanceOf(bob.address)).toBigInt();
        totalSupplyBaseBefore = (await comet.totalsBasic()).totalSupplyBase.toBigInt();

        withdrawTx = await comet.connect(bob).withdraw(baseToken.address, SUPPLY_AMOUNT);
      });

      it('bob comet balance before withdraw equals supply amount', async () => {
        expect(bobCometBalanceBefore).to.equal(SUPPLY_AMOUNT);
      });

      it('total supply base before withdraw equals supply amount', async () => {
        expect(totalSupplyBaseBefore).to.equal(SUPPLY_AMOUNT);
      });

      it('withdraw tx does not revert', async () => {
        await expect(withdrawTx).to.not.be.reverted;
      });

      it('emits Transfer event (ERC20)', async () => {
        await expect(withdrawTx)
          .to.emit(baseToken, 'Transfer')
          .withArgs(comet.address, bob.address, SUPPLY_AMOUNT);
      });

      it('emits Withdraw event', async () => {
        await expect(withdrawTx)
          .to.emit(comet, 'Withdraw')
          .withArgs(bob.address, bob.address, SUPPLY_AMOUNT);
      });

      it('emits Transfer event (Comet burn)', async () => {
        await expect(withdrawTx)
          .to.emit(comet, 'Transfer')
          .withArgs(bob.address, ethers.constants.AddressZero, SUPPLY_AMOUNT);
      });

      it('bob comet balance is zero after full withdrawal', async () => {
        expect(await comet.balanceOf(bob.address)).to.equal(0);
      });

      it('bob receives withdrawn tokens', async () => {
        expect(await baseToken.balanceOf(bob.address)).to.equal(bobTokenBalanceBefore + SUPPLY_AMOUNT);
      });

      it('total supply base is zero after full withdrawal', async () => {
        expect((await comet.totalsBasic()).totalSupplyBase).to.equal(0n);
      });

      it('total borrow base is zero', async () => {
        expect((await comet.totalsBasic()).totalBorrowBase).to.equal(0n);
      });

      it('gas used is within limit', async () => {
        const receipt = await withdrawTx.wait();
        expect(Number(receipt.gasUsed)).to.be.lessThan(106000);
      });
    });

    describe('withdraw max base with accrued interest', function () {
      const BOB_SUPPLY_AMOUNT = exp(100, 6);
      const ALICE_COLLATERAL_AMOUNT = exp(10, 18);
      const ALICE_BORROW_AMOUNT = exp(50, 6);
      const TIME_FORWARD_SECONDS = 86400; // 24 hours

      let withdrawTx: ContractTransaction;
      let bobAccruedBalance: bigint;
      let aliceBalanceBefore: bigint;

      before(async () => {
        await baseSnapshot.restore();

        await baseToken.connect(bob).approve(comet.address, BOB_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, BOB_SUPPLY_AMOUNT);

        await collaterals['WETH'].allocateTo(alice.address, ALICE_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(collaterals['WETH'].address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).withdraw(baseToken.address, ALICE_BORROW_AMOUNT);

        await baseToken.allocateTo(comet.address, exp(60, 6));

        await fastForward(TIME_FORWARD_SECONDS);
        await ethers.provider.send('evm_mine', []);

        bobAccruedBalance = (await comet.callStatic.balanceOf(bob.address)).toBigInt();
        aliceBalanceBefore = (await baseToken.balanceOf(alice.address)).toBigInt();

        withdrawTx = await comet.connect(bob).withdrawTo(alice.address, baseToken.address, ethers.constants.MaxUint256);
      });

      it('bob balance after accrual is greater than supplied amount', async () => {
        expect(bobAccruedBalance).to.be.gt(BOB_SUPPLY_AMOUNT);
      });

      it('withdraw tx does not revert', async () => {
        await expect(withdrawTx).to.not.be.reverted;
      });

      it('bob comet balance is zero after max withdrawal', async () => {
        expect(await comet.balanceOf(bob.address)).to.equal(0);
      });

      it('alice receives full accrued balance', async () => {
        expect(await baseToken.balanceOf(alice.address)).to.equal(aliceBalanceBefore + bobAccruedBalance);
      });
    });

    describe('withdraw max base with borrow position (edge case)', function () {
      const ALICE_SUPPLY_AMOUNT = exp(200, 6);
      const BOB_COLLATERAL_AMOUNT = exp(1, 18);
      const BOB_BORROW_AMOUNT = exp(100, 6);

      let withdrawTx: ContractTransaction;
      let aliceBalanceBefore: bigint;

      before(async () => {
        await baseSnapshot.restore();

        await baseToken.connect(alice).approve(comet.address, ALICE_SUPPLY_AMOUNT);
        await comet.connect(alice).supply(baseToken.address, ALICE_SUPPLY_AMOUNT);

        await collaterals['WETH'].allocateTo(bob.address, BOB_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(bob).approve(comet.address, BOB_COLLATERAL_AMOUNT);
        await comet.connect(bob).supply(collaterals['WETH'].address, BOB_COLLATERAL_AMOUNT);
        await comet.connect(bob).withdraw(baseToken.address, BOB_BORROW_AMOUNT);

        aliceBalanceBefore = (await baseToken.balanceOf(alice.address)).toBigInt();

        withdrawTx = await comet.connect(bob).withdrawTo(alice.address, baseToken.address, ethers.constants.MaxUint256);
      });

      it('emits Transfer event with 0 amount (no tokens transferred)', async () => {
        await expect(withdrawTx)
          .to.emit(baseToken, 'Transfer')
          .withArgs(comet.address, alice.address, 0);
      });

      it('emits Withdraw event with 0 amount', async () => {
        await expect(withdrawTx)
          .to.emit(comet, 'Withdraw')
          .withArgs(bob.address, alice.address, 0);
      });

      it('alice balance unchanged', async () => {
        expect(await baseToken.balanceOf(alice.address)).to.equal(aliceBalanceBefore);
      });

      it('gas used is within limit', async () => {
        const receipt = await withdrawTx.wait();
        expect(Number(receipt.gasUsed)).to.be.lessThan(121000);
      });
    });

    describe('user can withdraw full accrued balance (interest test)', function () {
      const SUPPLY_AMOUNT = exp(100, 6);
      const COLLATERAL_AMOUNT = exp(10, 18);
      const BORROW_AMOUNT = exp(50, 6);
      const TIME_FORWARD_SECONDS = 86400; // 24 hours

      let balanceAfterAccrual: bigint;

      before(async () => {
        await baseSnapshot.restore();

        await baseToken.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, SUPPLY_AMOUNT);

        await collaterals['WETH'].allocateTo(alice.address, COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(comet.address, COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(collaterals['WETH'].address, COLLATERAL_AMOUNT);
        await comet.connect(alice).withdraw(baseToken.address, BORROW_AMOUNT);

        await fastForward(TIME_FORWARD_SECONDS);
        await ethers.provider.send('evm_mine', []);

        balanceAfterAccrual = (await comet.callStatic.balanceOf(bob.address)).toBigInt();

        await baseToken.allocateTo(alice.address, exp(60, 6));
        await baseToken.connect(alice).approve(comet.address, exp(60, 6));
        await comet.connect(alice).supply(baseToken.address, exp(60, 6));

        await comet.connect(bob).withdraw(baseToken.address, balanceAfterAccrual);
      });

      it('balance after accrual is >= supplied amount', async () => {
        expect(balanceAfterAccrual).to.be.gte(SUPPLY_AMOUNT);
      });

      it('bob final comet balance is zero', async () => {
        const finalBalance = await comet.callStatic.balanceOf(bob.address);
        expect(finalBalance).to.be.equal(0);
      });

      it('can withdraw to different recipient after interest accrual', async () => {
        await baseSnapshot.restore();

        const SUPPLY = exp(100, 6);
        const COLLATERAL = exp(10, 18);
        const BORROW = exp(50, 6);

        await baseToken.connect(bob).approve(comet.address, SUPPLY);
        await comet.connect(bob).supply(baseToken.address, SUPPLY);

        await collaterals['WETH'].allocateTo(alice.address, COLLATERAL);
        await collaterals['WETH'].connect(alice).approve(comet.address, COLLATERAL);
        await comet.connect(alice).supply(collaterals['WETH'].address, COLLATERAL);
        await comet.connect(alice).withdraw(baseToken.address, BORROW);

        await fastForward(86400);
        await ethers.provider.send('evm_mine', []);

        const balanceAfterAccrual = (await comet.callStatic.balanceOf(bob.address)).toBigInt();
        expect(balanceAfterAccrual).to.be.gte(SUPPLY);

        await baseToken.allocateTo(alice.address, exp(60, 6));
        await baseToken.connect(alice).approve(comet.address, exp(60, 6));
        await comet.connect(alice).supply(baseToken.address, exp(60, 6));

        const aliceBalanceBefore = await baseToken.balanceOf(alice.address);
        await comet.connect(bob).withdrawTo(alice.address, baseToken.address, balanceAfterAccrual);

        expect(await baseToken.balanceOf(alice.address)).to.equal(aliceBalanceBefore.add(balanceAfterAccrual));
        expect(await comet.balanceOf(bob.address)).to.equal(0);
      });
    });

    describe('edge cases', function () {
      describe('borrow without base supply (no Transfer burn event)', function () {
        const ALICE_SUPPLY_AMOUNT = exp(110, 6);
        const BOB_COLLATERAL_AMOUNT = exp(1, 18);
        const BORROW_AMOUNT = exp(1, 6);

        let withdrawTx: ContractTransaction;

        before(async () => {
          await baseSnapshot.restore();

          await baseToken.connect(alice).approve(comet.address, ALICE_SUPPLY_AMOUNT);
          await comet.connect(alice).supply(baseToken.address, ALICE_SUPPLY_AMOUNT);

          await collaterals['WETH'].allocateTo(bob.address, BOB_COLLATERAL_AMOUNT);
          await collaterals['WETH'].connect(bob).approve(comet.address, BOB_COLLATERAL_AMOUNT);
          await comet.connect(bob).supply(collaterals['WETH'].address, BOB_COLLATERAL_AMOUNT);

          withdrawTx = await comet.connect(bob).withdrawTo(alice.address, baseToken.address, BORROW_AMOUNT);
        });

        it('emits exactly 2 events (no Transfer burn)', async () => {
          const receipt = await withdrawTx.wait();
          expect(receipt.events.length).to.be.equal(2);
        });

        it('emits Transfer event (ERC20)', async () => {
          await expect(withdrawTx)
            .to.emit(baseToken, 'Transfer')
            .withArgs(comet.address, alice.address, BORROW_AMOUNT);
        });

        it('emits Withdraw event', async () => {
          await expect(withdrawTx)
            .to.emit(comet, 'Withdraw')
            .withArgs(bob.address, alice.address, BORROW_AMOUNT);
        });
      });

      describe('rounding quirk - withdraw 0 emits Transfer of 1 (harness)', function () {
        let withdrawTx: ContractTransaction;

        before(async () => {
          await baseSnapshot.restore();

          // Harness required: This tests a specific rounding edge case where withdrawing 0 tokens
          // causes the principal to round down by 1 due to integer division in presentValue/principalValue.
          // These exact values (principal=99999992291226, index=1000000131467072) were found to
          // trigger this edge case. Cannot be achieved through natural supply/borrow flows.
          await comet.setBasePrincipal(alice.address, 99999992291226);
          await setTotalsBasic(comet, {
            totalSupplyBase: 699999944771920,
            baseSupplyIndex: 1000000131467072,
          });

          withdrawTx = await comet.connect(alice).withdraw(baseToken.address, 0);
        });

        it('emits exactly 3 events', async () => {
          const receipt = await withdrawTx.wait();
          expect(receipt.events.length).to.be.equal(3);
        });

        it('emits Transfer event with 0 amount (ERC20)', async () => {
          await expect(withdrawTx)
            .to.emit(baseToken, 'Transfer')
            .withArgs(comet.address, alice.address, 0);
        });

        it('emits Withdraw event with 0 amount', async () => {
          await expect(withdrawTx)
            .to.emit(comet, 'Withdraw')
            .withArgs(alice.address, alice.address, 0);
        });

        it('emits Transfer burn event with amount 1 (rounding)', async () => {
          await expect(withdrawTx)
            .to.emit(comet, 'Transfer')
            .withArgs(alice.address, ethers.constants.AddressZero, 1);
        });
      });

      describe('withdraw 0 with collateral only position', function () {
        const COLLATERAL_AMOUNT = exp(1, 18);

        it('withdraws 0 base with only collateral position (no base supplied)', async () => {
          await baseSnapshot.restore();
          
          await collaterals['WETH'].allocateTo(alice.address, COLLATERAL_AMOUNT);
          await collaterals['WETH'].connect(alice).approve(comet.address, COLLATERAL_AMOUNT);
          await comet.connect(alice).supply(collaterals['WETH'].address, COLLATERAL_AMOUNT);

          const tx = await comet.connect(alice).withdraw(baseToken.address, 0);

          await expect(tx)
            .to.emit(baseToken, 'Transfer')
            .withArgs(comet.address, alice.address, 0);
        });
      });
    });
  });

  describe('withdraw collateral', function () {
    before(async () => {
      await baseSnapshot.restore();
    });

    describe('reverts', function () {
      const BOB_SUPPLY_AMOUNT = exp(200, 6);
      const ALICE_COLLATERAL_AMOUNT = exp(1, 18);
      const BORROW_AMOUNT = exp(100, 6);
      const COLLATERAL_SUPPLY = exp(1, 18);

      it('reverts if withdraw is paused', async () => {
        await comet.connect(pauseGuardian).pause(false, false, true, false, false);
        expect(await comet.isWithdrawPaused()).to.be.true;

        await expect(comet.connect(alice).withdraw(collaterals['COMP'].address, 1)).to.be.revertedWithCustomError(comet, 'Paused');
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });

      it('reverts if withdrawing more collateral than supplied', async () => {
        await baseSnapshot.restore();
        
        await collaterals['WETH'].allocateTo(alice.address, COLLATERAL_SUPPLY);
        await collaterals['WETH'].connect(alice).approve(comet.address, COLLATERAL_SUPPLY);
        await comet.connect(alice).supply(collaterals['WETH'].address, COLLATERAL_SUPPLY);
        await expect(
          comet.connect(alice).withdraw(collaterals['WETH'].address, COLLATERAL_SUPPLY + 1n)
        ).to.be.revertedWithPanic(0x11);
      });

      it('reverts if collateral withdraw amount is not collateralized', async () => {
        await baseSnapshot.restore();
        
        await baseToken.connect(bob).approve(comet.address, BOB_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, BOB_SUPPLY_AMOUNT);

        await collaterals['WETH'].allocateTo(alice.address, ALICE_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(collaterals['WETH'].address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).withdraw(baseToken.address, BORROW_AMOUNT);

        await expect(
          comet.connect(alice).withdraw(collaterals['WETH'].address, ALICE_COLLATERAL_AMOUNT)
        ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
      });

      it('reverts collateral withdraw if collateral oracle returns 0 (when borrowing)', async () => {
        const { comet, tokens, priceFeeds, users: [alice, bob] } = await makeProtocol({ base: 'USDC' });
        const USDC = tokens.USDC as FaucetToken;
        const WETH = tokens.WETH as FaucetToken;

        await USDC.allocateTo(bob.address, exp(200, 6));
        await USDC.connect(bob).approve(comet.address, exp(200, 6));
        await comet.connect(bob).supply(USDC.address, exp(200, 6));

        await WETH.allocateTo(alice.address, exp(2, 18));
        await WETH.connect(alice).approve(comet.address, exp(2, 18));
        await comet.connect(alice).supply(WETH.address, exp(2, 18));
        await comet.connect(alice).withdraw(USDC.address, exp(100, 6));

        await priceFeeds.WETH.setRoundData(1, 0, 0, 0, 1);

        await expect(
          comet.connect(alice).withdraw(WETH.address, exp(1, 18))
        ).to.be.revertedWithCustomError(comet, 'BadPrice');
      });

      it('reverts collateral withdraw if base oracle returns 0 (when borrowing)', async () => {
        const { comet, tokens, priceFeeds, users: [alice, bob] } = await makeProtocol({ base: 'USDC' });
        const USDC = tokens.USDC as FaucetToken;
        const WETH = tokens.WETH as FaucetToken;

        await USDC.allocateTo(bob.address, exp(200, 6));
        await USDC.connect(bob).approve(comet.address, exp(200, 6));
        await comet.connect(bob).supply(USDC.address, exp(200, 6));

        await WETH.allocateTo(alice.address, exp(2, 18));
        await WETH.connect(alice).approve(comet.address, exp(2, 18));
        await comet.connect(alice).supply(WETH.address, exp(2, 18));
        await comet.connect(alice).withdraw(USDC.address, exp(100, 6)); // borrow

        await priceFeeds.USDC.setRoundData(1, 0, 0, 0, 1);

        await expect(
          comet.connect(alice).withdraw(WETH.address, exp(1, 18))
        ).to.be.revertedWithCustomError(comet, 'BadPrice');
      });
    });

    describe('withdraw collateral: happy path', function () {
      const COLLATERAL_SUPPLY_AMOUNT: bigint = exp(8, 8);

      let collateral: FaucetToken;
      let withdrawTx: ContractTransaction;
      let aliceBalanceBefore: typeof ethers.BigNumber.prototype;
      let totalSupplyBefore: typeof ethers.BigNumber.prototype;

      before(async () => {
        await baseSnapshot.restore();
        
        collateral = collaterals['COMP'];
        await collateral.allocateTo(bob.address, COLLATERAL_SUPPLY_AMOUNT);
        await collateral.connect(bob).approve(comet.address, COLLATERAL_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(collateral.address, COLLATERAL_SUPPLY_AMOUNT);

        aliceBalanceBefore = await collateral.balanceOf(alice.address);
        totalSupplyBefore = (await comet.totalsCollateral(collateral.address)).totalSupplyAsset;
      });

      it('bob collateral balance before withdraw equals supply amount', async () => {
        expect((await comet.userCollateral(bob.address, collateral.address)).balance).to.equal(COLLATERAL_SUPPLY_AMOUNT);
      });

      it('total supply before withdraw equals supply amount', async () => {
        expect(totalSupplyBefore).to.equal(COLLATERAL_SUPPLY_AMOUNT);
      });

      it('withdraw collateral does not revert', async () => {
        withdrawTx = await comet.connect(bob).withdrawTo(alice.address, collateral.address, COLLATERAL_SUPPLY_AMOUNT);
        expect(withdrawTx).to.not.be.reverted;
      });

      it('emits Transfer event (ERC20)', async () => {
        await expect(withdrawTx)
          .to.emit(collateral, 'Transfer')
          .withArgs(comet.address, alice.address, COLLATERAL_SUPPLY_AMOUNT);
      });

      it('emits WithdrawCollateral event', async () => {
        await expect(withdrawTx)
          .to.emit(comet, 'WithdrawCollateral')
          .withArgs(bob.address, alice.address, collateral.address, COLLATERAL_SUPPLY_AMOUNT);
      });

      it('recipient balance increases by withdrawn amount', async () => {
        expect(await collateral.balanceOf(alice.address)).to.equal(aliceBalanceBefore.add(COLLATERAL_SUPPLY_AMOUNT));
      });

      it('bob collateral balance is zero after full withdrawal', async () => {
        expect((await comet.userCollateral(bob.address, collateral.address)).balance).to.equal(0);
      });

      it('total supply is zero after full withdrawal', async () => {
        const totalsCollateral = await comet.totalsCollateral(collateral.address);
        expect(totalsCollateral.totalSupplyAsset).to.equal(0);
      });

      it('gas used is within expected bounds', async () => {
        const receipt = await withdrawTx.wait();
        expect(Number(receipt.gasUsed)).to.be.lessThan(85000);
      });
    });

    describe('edge cases', function () {
      const COLLATERAL_AMOUNT = exp(1, 8);
      const SUPPLY_AMOUNT = exp(100, 6);
      const WITHDRAW_AMOUNT = exp(25, 6);

      it('withdraws 0 collateral successfully', async () => {
        await baseSnapshot.restore();

        await collaterals['COMP'].allocateTo(alice.address, COLLATERAL_AMOUNT);
        await collaterals['COMP'].connect(alice).approve(comet.address, COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(collaterals['COMP'].address, COLLATERAL_AMOUNT);

        const balanceBefore = (await comet.userCollateral(alice.address, collaterals['COMP'].address)).balance;
        const tx = await comet.connect(alice).withdraw(collaterals['COMP'].address, 0);

        await expect(tx)
          .to.emit(comet, 'WithdrawCollateral')
          .withArgs(alice.address, alice.address, collaterals['COMP'].address, 0);

        expect((await comet.userCollateral(alice.address, collaterals['COMP'].address)).balance).to.equal(balanceBefore);
      });

      it('multiple consecutive withdraws in same block', async () => {
        await baseSnapshot.restore();

        await baseToken.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, SUPPLY_AMOUNT);

        await comet.connect(bob).withdraw(baseToken.address, WITHDRAW_AMOUNT);
        expect(await comet.balanceOf(bob.address)).to.equal(exp(75, 6));
        await comet.connect(bob).withdraw(baseToken.address, WITHDRAW_AMOUNT);
        expect(await comet.balanceOf(bob.address)).to.equal(exp(50, 6));

        await comet.connect(bob).withdraw(baseToken.address, WITHDRAW_AMOUNT);
        expect(await comet.balanceOf(bob.address)).to.equal(exp(25, 6));


        await comet.connect(bob).withdraw(baseToken.address, WITHDRAW_AMOUNT);
        expect(await comet.balanceOf(bob.address)).to.equal(0);
      });

      it('withdrawTo zero address sends tokens to zero address (tokens burned)', async () => {
        await baseSnapshot.restore();

        await baseToken.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, SUPPLY_AMOUNT);

        const zeroAddressBalanceBefore = await baseToken.balanceOf(ethers.constants.AddressZero);

        const tx = await comet.connect(bob).withdrawTo(ethers.constants.AddressZero, baseToken.address, SUPPLY_AMOUNT);

        await expect(tx)
          .to.emit(comet, 'Withdraw')
          .withArgs(bob.address, ethers.constants.AddressZero, SUPPLY_AMOUNT);

        expect(await baseToken.balanceOf(ethers.constants.AddressZero)).to.equal(zeroAddressBalanceBefore.add(SUPPLY_AMOUNT));
        expect(await comet.balanceOf(bob.address)).to.equal(0);
      });
    });
  });

  describe('borrow (withdraw without supply)', function () {
    before(async () => {
      await baseSnapshot.restore();
    });

    describe('reverts', function () {
      const BOB_SUPPLY_AMOUNT = exp(100, 6);
      const BOB_LARGE_SUPPLY_AMOUNT = exp(100000, 6);
      const ALICE_COLLATERAL_AMOUNT = exp(1, 18);
      const SMALL_BORROW_AMOUNT = exp(1, 6);
      const LARGE_BORROW_AMOUNT = exp(10000, 6);

      it("can't borrow if there is no collateral supplied", async () => {
        await baseSnapshot.restore();
        
        await baseToken.connect(bob).approve(comet.address, BOB_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, BOB_SUPPLY_AMOUNT);

        await expect(
          comet.connect(alice).withdraw(baseToken.address, SMALL_BORROW_AMOUNT)
        ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
      });

      it("can't borrow if there is not enough collateral", async () => {
        await baseSnapshot.restore();
        
        await baseToken.connect(bob).approve(comet.address, BOB_LARGE_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, BOB_LARGE_SUPPLY_AMOUNT);

        await collaterals['WETH'].allocateTo(alice.address, ALICE_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(collaterals['WETH'].address, ALICE_COLLATERAL_AMOUNT);

        await expect(
          comet.connect(alice).withdraw(baseToken.address, LARGE_BORROW_AMOUNT)
        ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
      });

      it("can't borrow less than minBorrow", async () => {
        const protocol = await makeProtocol({ base: 'USDC', baseBorrowMin: exp(1, 6) });
        const { comet, tokens, users: [alice, bob] } = protocol;
        const USDC = tokens.USDC as FaucetToken;
        const WETH = tokens.WETH as FaucetToken;

        await USDC.allocateTo(bob.address, exp(100, 6));
        await USDC.connect(bob).approve(comet.address, exp(100, 6));
        await comet.connect(bob).supply(USDC.address, exp(100, 6));

        await WETH.allocateTo(alice.address, exp(1, 18));
        await WETH.connect(alice).approve(comet.address, exp(1, 18));
        await comet.connect(alice).supply(WETH.address, exp(1, 18));

        await expect(
          comet.connect(alice).withdraw(USDC.address, exp(0.5, 6))
        ).to.be.revertedWithCustomError(comet, 'BorrowTooSmall');
      });

      it('reverts borrow if collateral oracle returns 0', async () => {
        const { comet, tokens, priceFeeds, users: [alice, bob] } = await makeProtocol({ base: 'USDC' });
        const USDC = tokens.USDC as FaucetToken;
        const WETH = tokens.WETH as FaucetToken;

        await USDC.allocateTo(bob.address, exp(100, 6));
        await USDC.connect(bob).approve(comet.address, exp(100, 6));
        await comet.connect(bob).supply(USDC.address, exp(100, 6));

        await WETH.allocateTo(alice.address, exp(1, 18));
        await WETH.connect(alice).approve(comet.address, exp(1, 18));
        await comet.connect(alice).supply(WETH.address, exp(1, 18));

        await priceFeeds.WETH.setRoundData(1, 0, 0, 0, 1);

        await expect(
          comet.connect(alice).withdraw(USDC.address, exp(1, 6))
        ).to.be.revertedWithCustomError(comet, 'BadPrice');
      });

      it('reverts borrow if base oracle returns 0', async () => {
        const { comet, tokens, priceFeeds, users: [alice, bob] } = await makeProtocol({ base: 'USDC' });
        const USDC = tokens.USDC as FaucetToken;
        const WETH = tokens.WETH as FaucetToken;

        await USDC.allocateTo(bob.address, exp(100, 6));
        await USDC.connect(bob).approve(comet.address, exp(100, 6));
        await comet.connect(bob).supply(USDC.address, exp(100, 6));

        await WETH.allocateTo(alice.address, exp(1, 18));
        await WETH.connect(alice).approve(comet.address, exp(1, 18));
        await comet.connect(alice).supply(WETH.address, exp(1, 18));

        await priceFeeds.USDC.setRoundData(1, 0, 0, 0, 1);

        await expect(
          comet.connect(alice).withdraw(USDC.address, exp(1, 6))
        ).to.be.revertedWithCustomError(comet, 'BadPrice');
      });
    });

    describe('borrow: happy path', function () {
      const BOB_SUPPLY_AMOUNT = exp(100, 6);
      const ALICE_COLLATERAL_AMOUNT = exp(1, 18);
      const BORROW_AMOUNT = exp(10, 6);

      before(async () => {
        await baseSnapshot.restore();
      });

      it('principal from the 1st borrow equals to the requested amount', async () => {
        await baseToken.connect(bob).approve(comet.address, BOB_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, BOB_SUPPLY_AMOUNT);

        await collaterals['WETH'].allocateTo(alice.address, ALICE_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(collaterals['WETH'].address, ALICE_COLLATERAL_AMOUNT);

        await comet.connect(alice).withdraw(baseToken.address, BORROW_AMOUNT);

        const aliceBalance = await baseBalanceOf(comet, alice.address);
        expect(aliceBalance).to.equal(-BORROW_AMOUNT);
      });

      it('borrow balance increases with interest over time (consecutive borrows)', async () => {
        await baseSnapshot.restore();

        await baseToken.connect(bob).approve(comet.address, exp(1000, 6));
        await comet.connect(bob).supply(baseToken.address, exp(1000, 6));

        await collaterals['WETH'].allocateTo(alice.address, exp(10, 18));
        await collaterals['WETH'].connect(alice).approve(comet.address, exp(10, 18));
        await comet.connect(alice).supply(collaterals['WETH'].address, exp(10, 18));

        const borrowAmount1 = exp(100, 6);
        await comet.connect(alice).withdraw(baseToken.address, borrowAmount1);
        const balance1 = await baseBalanceOf(comet, alice.address);
        expect(balance1).to.equal(-borrowAmount1);

        await fastForward(86400);
        await ethers.provider.send('evm_mine', []);

        const balanceAfterTime = await baseBalanceOf(comet, alice.address);
        expect(balanceAfterTime).to.be.lte(balance1);

        const borrowAmount2 = exp(50, 6);
        await comet.connect(alice).withdraw(baseToken.address, borrowAmount2);

        const finalBalance = await baseBalanceOf(comet, alice.address);
        expect(finalBalance).to.be.lte(-(borrowAmount1 + borrowAmount2));
      });

      it('borrows to withdraw if necessary/possible', async () => {
        await baseSnapshot.restore();
        
        const SMALL_SUPPLY = exp(10, 6);
        const SMALL_BORROW = exp(1, 6);
        
        await baseToken.connect(bob).approve(comet.address, SMALL_SUPPLY);
        await comet.connect(bob).supply(baseToken.address, SMALL_SUPPLY);

        await collaterals['WETH'].allocateTo(alice.address, ALICE_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(collaterals['WETH'].address, ALICE_COLLATERAL_AMOUNT);

        const bobUsdcBefore = await baseToken.balanceOf(bob.address);
        await comet.connect(alice).withdrawTo(bob.address, baseToken.address, SMALL_BORROW);

        expect(await baseBalanceOf(comet, alice.address)).to.eq(-SMALL_BORROW);
        expect(await baseToken.balanceOf(bob.address)).to.eq(bobUsdcBefore.add(SMALL_BORROW));
      });
    });
  });

  describe('withdrawTo', function () {
    const SUPPLY_AMOUNT = exp(100, 6);

    before(async () => {
      await baseSnapshot.restore();
    });

    it('withdraws to sender by default', async () => {
      await baseToken.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
      await comet.connect(bob).supply(baseToken.address, SUPPLY_AMOUNT);

      const bobUsdcBefore = await baseToken.balanceOf(bob.address);
      expect(await comet.balanceOf(bob.address)).to.equal(SUPPLY_AMOUNT);

      await comet.connect(bob).withdraw(baseToken.address, SUPPLY_AMOUNT);

      expect(await comet.balanceOf(bob.address)).to.equal(0);
      expect(await baseToken.balanceOf(bob.address)).to.equal(bobUsdcBefore.add(SUPPLY_AMOUNT));
    });
  });

  describe('withdrawFrom', function () {
    const SUPPLY_AMOUNT = exp(1, 8);
    let charlie: SignerWithAddress;
    let withdrawFromSnapshot: SnapshotRestorer;

    before(async () => {
      await baseSnapshot.restore();
      charlie = (await ethers.getSigners())[4];

      await collaterals['COMP'].allocateTo(bob.address, SUPPLY_AMOUNT);
      await collaterals['COMP'].connect(bob).approve(comet.address, SUPPLY_AMOUNT);
      await comet.connect(bob).supply(collaterals['COMP'].address, SUPPLY_AMOUNT);

      withdrawFromSnapshot = await takeSnapshot();
    });

    it('withdraws from src if specified and sender has permission', async () => {
      const aliceBalanceBefore = await collaterals['COMP'].balanceOf(alice.address);
      expect((await comet.userCollateral(bob.address, collaterals['COMP'].address)).balance).to.equal(SUPPLY_AMOUNT);

      await comet.connect(bob).allow(charlie.address, true);
      await comet.connect(charlie).withdrawFrom(bob.address, alice.address, collaterals['COMP'].address, SUPPLY_AMOUNT);

      expect((await comet.userCollateral(bob.address, collaterals['COMP'].address)).balance).to.equal(0);
      expect(await collaterals['COMP'].balanceOf(alice.address)).to.equal(aliceBalanceBefore.add(SUPPLY_AMOUNT));
    });

    it('reverts if src is specified and sender does not have permission', async () => {
      await withdrawFromSnapshot.restore();

      await expect(
        comet.connect(charlie).withdrawFrom(bob.address, alice.address, collaterals['COMP'].address, SUPPLY_AMOUNT)
      ).to.be.revertedWithCustomError(comet, 'Unauthorized');
    });

    it('reverts if withdraw is paused', async () => {
      await withdrawFromSnapshot.restore();

      await comet.connect(pauseGuardian).pause(false, false, true, false, false);
      expect(await comet.isWithdrawPaused()).to.be.true;

      await comet.connect(bob).allow(charlie.address, true);
      await expect(
        comet.connect(charlie).withdrawFrom(bob.address, alice.address, collaterals['COMP'].address, SUPPLY_AMOUNT)
      ).to.be.revertedWithCustomError(comet, 'Paused');

      await comet.connect(pauseGuardian).pause(false, false, false, false, false);
    });
  });

  describe('reentrancy protection', function () {
    const USDC_LIQUIDITY = exp(100, 6);
    const ATTACK_AMOUNT = exp(1, 6);
    const COLLATERAL_SUPPLY = exp(100, 6);
    const ALICE_COLLATERAL_BALANCE = exp(1, 6);

    let evilComet: CometHarnessInterface;
    let USDC: FaucetToken;
    let EVIL: EvilToken;
    let evilAlice: SignerWithAddress;
    let evilBob: SignerWithAddress;
    let reentrancySnapshot: SnapshotRestorer;

    before(async () => {
      const { comet, tokens, users } = await makeProtocol({
        assets: {
          USDC: { decimals: 6 },
          EVIL: {
            decimals: 6,
            initialPrice: 2,
            factory: await ethers.getContractFactory('EvilToken') as EvilToken__factory,
          }
        }
      });
      evilComet = comet;
      USDC = tokens.USDC as FaucetToken;
      EVIL = tokens.EVIL as EvilToken;
      [evilAlice, evilBob] = users;

      await USDC.allocateTo(evilComet.address, USDC_LIQUIDITY);

      // Harness: EvilToken can't be supplied normally - it's malicious and triggers reentrancy
      const totalsCollateral = Object.assign({}, await evilComet.totalsCollateral(EVIL.address), {
        totalSupplyAsset: COLLATERAL_SUPPLY,
      });
      await evilComet.setTotalsCollateral(EVIL.address, totalsCollateral);
      await evilComet.setCollateralBalance(evilAlice.address, EVIL.address, ALICE_COLLATERAL_BALANCE);
      await evilComet.connect(evilAlice).allow(EVIL.address, true);

      reentrancySnapshot = await takeSnapshot();
    });

    it('blocks malicious reentrant transferFrom', async () => {
      const attack = Object.assign({}, await EVIL.getAttack(), {
        attackType: ReentryAttack.TransferFrom,
        destination: evilBob.address,
        asset: USDC.address,
        amount: ATTACK_AMOUNT
      });
      await EVIL.setAttack(attack);

      await expect(
        evilComet.connect(evilAlice).withdraw(EVIL.address, ATTACK_AMOUNT)
      ).to.be.revertedWithCustomError(evilComet, 'ReentrantCallBlocked');

      expect(await USDC.balanceOf(evilComet.address)).to.eq(USDC_LIQUIDITY);
      expect(await baseBalanceOf(evilComet, evilAlice.address)).to.eq(0n);
      expect(await USDC.balanceOf(evilBob.address)).to.eq(0);
    });

    it('blocks malicious reentrant withdrawFrom', async () => {
      await reentrancySnapshot.restore();

      const attack = Object.assign({}, await EVIL.getAttack(), {
        attackType: ReentryAttack.WithdrawFrom,
        destination: evilBob.address,
        asset: USDC.address,
        amount: ATTACK_AMOUNT
      });
      await EVIL.setAttack(attack);

      await expect(
        evilComet.connect(evilAlice).withdraw(EVIL.address, ATTACK_AMOUNT)
      ).to.be.revertedWithCustomError(evilComet, 'ReentrantCallBlocked');

      expect(await USDC.balanceOf(evilComet.address)).to.eq(USDC_LIQUIDITY);
      expect(await baseBalanceOf(evilComet, evilAlice.address)).to.eq(0n);
      expect(await USDC.balanceOf(evilBob.address)).to.eq(0);
    });
  });

  describe('withdraw 24 collaterals', function () {
    const MAX_ASSETS = 24;
    const SUPPLY_COLLATERAL_AMOUNT: bigint = exp(1, 18);

    let comet: CometHarnessInterfaceExtendedAssetList;
    let baseToken: FaucetToken;
    let collaterals: { [symbol: string]: FaucetToken } = {};

    let alice: SignerWithAddress;
    let bob: SignerWithAddress;

    let asset: FaucetToken;
    let withdrawTx: ContractTransaction;

    let snapshot: SnapshotRestorer;

    before(async () => {
      const cometCollaterals = Object.fromEntries(
        Array.from({ length: MAX_ASSETS }, (_, j) => [`ASSET${j}`, {
          decimals: 18,
          initialPrice: 100, // $100 per collateral to allow borrowing
        }])
      );
      const protocol = await makeProtocol({
        base: 'USDC',
        assets: {
          USDC: { decimals: 6, initialPrice: 1 },
          ...cometCollaterals
        },
      });

      comet = protocol.cometWithExtendedAssetList;
      baseToken = protocol.tokens[protocol.base] as FaucetToken;
      for (const asset in protocol.tokens) {
        if (asset === 'USDC') continue;
        collaterals[asset] = protocol.tokens[asset] as FaucetToken;
      }

      [alice, bob] = protocol.users;

      await baseToken.allocateTo(bob.address, exp(100000, 6));
      await baseToken.connect(bob).approve(comet.address, exp(100000, 6));
      await comet.connect(bob).supply(baseToken.address, exp(100000, 6));

      for (let i = 0; i < MAX_ASSETS; i++) {
        const assetToken = collaterals[`ASSET${i}`];
        await assetToken.allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
        await assetToken.connect(alice).approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(assetToken.address, SUPPLY_COLLATERAL_AMOUNT);
      }

      snapshot = await takeSnapshot();
    });

    describe('withdraw collateral', function () {
      for (let i = 0; i < MAX_ASSETS; i++) {
        it(`withdraw collateral with index ${i + 1} is successful`, async () => {
          asset = collaterals[`ASSET${i}`];
          const balanceBefore = await asset.balanceOf(alice.address);
          withdrawTx = await comet.connect(alice).withdraw(asset.address, SUPPLY_COLLATERAL_AMOUNT);
          expect(withdrawTx).to.not.be.reverted;
          expect(await asset.balanceOf(alice.address)).to.equal(balanceBefore.add(SUPPLY_COLLATERAL_AMOUNT));
        });

        it(`WithdrawCollateral event is emitted`, async () => {
          await expect(withdrawTx)
            .to.emit(comet, 'WithdrawCollateral')
            .withArgs(alice.address, alice.address, asset.address, SUPPLY_COLLATERAL_AMOUNT);
        });

        it(`alice collateral balance is zero`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, asset.address)).to.be.equal(0);
        });

        it('comet total supplied collateral amount is zero', async () => {
          expect((await comet.totalsCollateral(asset.address)).totalSupplyAsset).to.be.equal(0);
        });
      }
    });

    describe('borrow with 24 collaterals', function () {
      before(async () => {
        await snapshot.restore();
      });

      it('can borrow when user has 24 different collateral types', async () => {
        const assetList = await comet.getAssetList(alice.address);
        expect(assetList.length).to.equal(MAX_ASSETS);

        const borrowAmount = exp(100, 6);
        const aliceBalanceBefore = await baseToken.balanceOf(alice.address);

        await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

        expect(await baseToken.balanceOf(alice.address)).to.equal(aliceBalanceBefore.add(borrowAmount));
        expect(await baseBalanceOf(comet as unknown as CometHarnessInterface, alice.address)).to.equal(BigInt(-borrowAmount));
      });
    });
  });
});
