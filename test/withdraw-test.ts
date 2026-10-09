import { ethers, expect, exp, makeProtocol, defaultAssets, ReentryAttack, setTotalsBasic, fastForward, baseBalanceOf, takeSnapshot, MAX_ASSETS, event, portfolio, wait } from './helpers.js';
import type { SnapshotRestorer, SignerWithAddress } from './helpers.js';
import { EvilToken__factory, NonStandardFaucetFeeToken__factory } from '../build/types/index.js';
import type { EvilToken, NonStandardFaucetFeeToken, CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from '../build/types/index.js';
import { MaxUint256, ZeroAddress } from 'ethers';
import type { ContractTransactionResponse } from 'ethers';
describe('withdraw', function () {
  const baseTokenDecimals = 6;
  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken;
  let collaterals: {
        [symbol: string]: FaucetToken;
    };
  let priceFeeds: {
        [symbol: string]: SimplePriceFeed;
    };
  let unsupportedToken: FaucetToken;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;
  let baseSnapshot: SnapshotRestorer;
  before(async function () {
    const protocol = await makeProtocol({ base: 'USDC' });
    comet = protocol.cometWithExtendedAssetList;
    baseToken = protocol.tokens[protocol.base] as FaucetToken;
    collaterals = Object.fromEntries(Object.entries(protocol.tokens).filter(([symbol]) => symbol !== protocol.base)) as {
            [symbol: string]: FaucetToken;
        };
    priceFeeds = protocol.priceFeeds;
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
        await expect(comet.connect(alice).withdraw(await baseToken.getAddress(), 1)).to.be.revertedWithCustomError(comet, 'Paused');
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });
      it('reverts if withdrawing more than available liquidity', async () => {
        const snapshot = await takeSnapshot();
        await baseToken.connect(alice).approve(await comet.getAddress(), SUPPLY_AMOUNT);
        await comet.connect(alice).supply(await baseToken.getAddress(), SUPPLY_AMOUNT);
        await collaterals['WETH'].allocateTo(bob.address, COLLATERAL_SUPPLY);
        await collaterals['WETH'].connect(bob).approve(await comet.getAddress(), COLLATERAL_SUPPLY);
        await comet.connect(bob).supply(await collaterals['WETH'].getAddress(), COLLATERAL_SUPPLY);
        await comet.connect(bob).withdraw(await baseToken.getAddress(), BORROW_AMOUNT);
        await expect(comet.connect(alice).withdraw(await baseToken.getAddress(), SUPPLY_AMOUNT)).to.be.revertedWith('ERC20: transfer amount exceeds balance');
        await snapshot.restore();
      });
      it('reverts if withdraw max for a collateral asset', async () => {
        const snapshot = await takeSnapshot();
        const collateral = collaterals['COMP'];
        await collateral.allocateTo(bob.address, COLLATERAL_AMOUNT);
        await expect(comet.connect(bob).withdraw(await collateral.getAddress(), MaxUint256)).to.be.revertedWithCustomError(comet, 'InvalidUInt128');
        await snapshot.restore();
      });
      it('reverts if asset is neither collateral nor base (arithmetic underflow)', async () => {
        await expect(comet.connect(alice).withdraw(await unsupportedToken.getAddress(), 1)).to.be.revertedWithPanic(0x11); // Arithmetic underflow
      });
      it('reverts if borrow amount exceeds collateral backing', async () => {
        await expect(comet.connect(alice).withdraw(await baseToken.getAddress(), exp(1000, baseTokenDecimals))).to.be.revertedWithCustomError(comet, 'NotCollateralized');
      });
    });
    describe('withdraw base: happy path', function () {
      const SUPPLY_AMOUNT: bigint = exp(100, baseTokenDecimals);
      let withdrawTx: ContractTransactionResponse;
      let bobTokenBalanceBefore: bigint;
      let bobCometBalanceBefore: bigint;
      let totalSupplyBaseBefore: bigint;
      before(async () => {
        await baseSnapshot.restore();
        await baseToken.connect(bob).approve(await comet.getAddress(), SUPPLY_AMOUNT);
        await comet.connect(bob).supply(await baseToken.getAddress(), SUPPLY_AMOUNT);
        bobTokenBalanceBefore = (await baseToken.balanceOf(bob.address));
        bobCometBalanceBefore = (await comet.balanceOf(bob.address));
        totalSupplyBaseBefore = (await comet.totalsBasic()).totalSupplyBase;
        withdrawTx = await comet.connect(bob).withdraw(await baseToken.getAddress(), SUPPLY_AMOUNT);
      });
      it('bob comet balance before withdraw equals supply amount', async () => {
        expect(bobCometBalanceBefore).to.equal(SUPPLY_AMOUNT);
      });
      it('total supply base before withdraw equals supply amount', async () => {
        expect(totalSupplyBaseBefore).to.equal(SUPPLY_AMOUNT);
      });
      it('withdraw tx does not revert', async () => {
        await expect(withdrawTx).to.not.revert(ethers);
      });
      it('emits Transfer event (ERC20)', async () => {
        await expect(withdrawTx)
          .to.emit(baseToken, 'Transfer')
          .withArgs(await comet.getAddress(), bob.address, SUPPLY_AMOUNT);
      });
      it('emits Withdraw event', async () => {
        await expect(withdrawTx)
          .to.emit(comet, 'Withdraw')
          .withArgs(bob.address, bob.address, SUPPLY_AMOUNT);
      });
      it('emits Transfer event (Comet burn)', async () => {
        await expect(withdrawTx)
          .to.emit(comet, 'Transfer')
          .withArgs(bob.address, ZeroAddress, SUPPLY_AMOUNT);
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
        if (!receipt)
          throw new Error('Transaction receipt not found');
        expect(Number(receipt.gasUsed)).to.be.lessThan(106000);
      });
    });
    describe('max withdraw + full accrued balance', function () {
      const BOB_SUPPLY_AMOUNT = exp(100, 6);
      const ALICE_COLLATERAL_AMOUNT = exp(10, 18);
      const ALICE_BORROW_AMOUNT = exp(50, 6);
      const TIME_FORWARD_SECONDS = 86400; // 24 hours
      let accrualSnapshot: SnapshotRestorer;
      before(async () => {
        await baseSnapshot.restore();
        await baseToken.connect(bob).approve(await comet.getAddress(), BOB_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(await baseToken.getAddress(), BOB_SUPPLY_AMOUNT);
        await collaterals['WETH'].allocateTo(alice.address, ALICE_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(await comet.getAddress(), ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(await collaterals['WETH'].getAddress(), ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).withdraw(await baseToken.getAddress(), ALICE_BORROW_AMOUNT);
        accrualSnapshot = await takeSnapshot();
      });
      describe('withdraw max base with accrued interest', function () {
        let withdrawTx: ContractTransactionResponse;
        let bobAccruedBalance: bigint;
        let aliceBalanceBefore: bigint;
        before(async () => {
          await accrualSnapshot.restore();
          await baseToken.allocateTo(await comet.getAddress(), exp(60, 6));
          await fastForward(TIME_FORWARD_SECONDS);
          await ethers.provider.send('evm_mine', []);
          bobAccruedBalance = (await comet.balanceOf.staticCall(bob.address));
          aliceBalanceBefore = (await baseToken.balanceOf(alice.address));
          withdrawTx = await comet.connect(bob).withdrawTo(alice.address, await baseToken.getAddress(), MaxUint256);
        });
        it('bob balance after accrual is greater than supplied amount', async () => {
          expect(bobAccruedBalance).to.be.gt(BOB_SUPPLY_AMOUNT);
        });
        it('withdraw tx does not revert', async () => {
          await expect(withdrawTx).to.not.revert(ethers);
        });
        it('bob comet balance is zero after max withdrawal', async () => {
          expect(await comet.balanceOf(bob.address)).to.equal(0);
        });
        it('alice receives full accrued balance', async () => {
          expect(await baseToken.balanceOf(alice.address)).to.equal(aliceBalanceBefore + bobAccruedBalance);
        });
      });
      describe('user can withdraw full accrued balance (interest test)', function () {
        let balanceAfterAccrual: bigint;
        before(async () => {
          await accrualSnapshot.restore();
          await fastForward(TIME_FORWARD_SECONDS);
          await ethers.provider.send('evm_mine', []);
          balanceAfterAccrual = (await comet.balanceOf.staticCall(bob.address));
          await baseToken.allocateTo(alice.address, exp(60, 6));
          await baseToken.connect(alice).approve(await comet.getAddress(), exp(60, 6));
          await comet.connect(alice).supply(await baseToken.getAddress(), exp(60, 6));
          await comet.connect(bob).withdraw(await baseToken.getAddress(), balanceAfterAccrual);
        });
        it('balance after accrual is >= supplied amount', async () => {
          expect(balanceAfterAccrual).to.be.gte(BOB_SUPPLY_AMOUNT);
        });
        it('bob final comet balance is zero', async () => {
          const finalBalance = await comet.balanceOf.staticCall(bob.address);
          expect(finalBalance).to.be.equal(0);
        });
      });
      describe('withdraw to different recipient after interest accrual', function () {
        let balanceAfterAccrual: bigint;
        before(async () => {
          await accrualSnapshot.restore();
          await fastForward(TIME_FORWARD_SECONDS);
          await ethers.provider.send('evm_mine', []);
          balanceAfterAccrual = (await comet.balanceOf.staticCall(bob.address));
          await baseToken.allocateTo(alice.address, exp(60, 6));
          await baseToken.connect(alice).approve(await comet.getAddress(), exp(60, 6));
          await comet.connect(alice).supply(await baseToken.getAddress(), exp(60, 6));
        });
        it('bob accrued balance is >= supplied amount', async () => {
          expect(balanceAfterAccrual).to.be.gte(BOB_SUPPLY_AMOUNT);
        });
        it('alice receives full accrued balance and bob comet balance is zero', async () => {
          const aliceBalanceBefore = await baseToken.balanceOf(alice.address);
          await comet.connect(bob).withdrawTo(alice.address, await baseToken.getAddress(), balanceAfterAccrual);
          expect(await baseToken.balanceOf(alice.address)).to.equal((aliceBalanceBefore + BigInt(balanceAfterAccrual)));
          expect(await comet.balanceOf(bob.address)).to.equal(0);
        });
      });
    });
    describe('withdraw max base with borrow position (edge case)', function () {
      const ALICE_SUPPLY_AMOUNT = exp(200, 6);
      const BOB_COLLATERAL_AMOUNT = exp(1, 18);
      const BOB_BORROW_AMOUNT = exp(100, 6);
      let withdrawTx: ContractTransactionResponse;
      let aliceBalanceBefore: bigint;
      before(async () => {
        await baseSnapshot.restore();
        await baseToken.connect(alice).approve(await comet.getAddress(), ALICE_SUPPLY_AMOUNT);
        await comet.connect(alice).supply(await baseToken.getAddress(), ALICE_SUPPLY_AMOUNT);
        await collaterals['WETH'].allocateTo(bob.address, BOB_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(bob).approve(await comet.getAddress(), BOB_COLLATERAL_AMOUNT);
        await comet.connect(bob).supply(await collaterals['WETH'].getAddress(), BOB_COLLATERAL_AMOUNT);
        await comet.connect(bob).withdraw(await baseToken.getAddress(), BOB_BORROW_AMOUNT);
        aliceBalanceBefore = (await baseToken.balanceOf(alice.address));
        withdrawTx = await comet.connect(bob).withdrawTo(alice.address, await baseToken.getAddress(), MaxUint256);
      });
      it('emits Transfer event with 0 amount (no tokens transferred)', async () => {
        await expect(withdrawTx)
          .to.emit(baseToken, 'Transfer')
          .withArgs(await comet.getAddress(), alice.address, 0);
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
        if (!receipt)
          throw new Error('Transaction receipt not found');
        expect(Number(receipt.gasUsed)).to.be.lessThan(121000);
      });
    });
    describe('edge cases', function () {
      describe('borrow without base supply (no Transfer burn event)', function () {
        const ALICE_SUPPLY_AMOUNT = exp(110, 6);
        const BOB_COLLATERAL_AMOUNT = exp(1, 18);
        const BORROW_AMOUNT = exp(1, 6);
        let withdrawTx: ContractTransactionResponse;
        before(async () => {
          await baseSnapshot.restore();
          await baseToken.connect(alice).approve(await comet.getAddress(), ALICE_SUPPLY_AMOUNT);
          await comet.connect(alice).supply(await baseToken.getAddress(), ALICE_SUPPLY_AMOUNT);
          await collaterals['WETH'].allocateTo(bob.address, BOB_COLLATERAL_AMOUNT);
          await collaterals['WETH'].connect(bob).approve(await comet.getAddress(), BOB_COLLATERAL_AMOUNT);
          await comet.connect(bob).supply(await collaterals['WETH'].getAddress(), BOB_COLLATERAL_AMOUNT);
          withdrawTx = await comet.connect(bob).withdrawTo(alice.address, await baseToken.getAddress(), BORROW_AMOUNT);
        });
        it('emits exactly 2 events (no Transfer burn)', async () => {
          const receipt = await withdrawTx.wait();
          if (!receipt)
            throw new Error('Transaction receipt not found');
          expect(receipt.logs.length).to.be.equal(2);
        });
        it('emits Transfer event (ERC20)', async () => {
          await expect(withdrawTx)
            .to.emit(baseToken, 'Transfer')
            .withArgs(await comet.getAddress(), alice.address, BORROW_AMOUNT);
        });
        it('emits Withdraw event', async () => {
          await expect(withdrawTx)
            .to.emit(comet, 'Withdraw')
            .withArgs(bob.address, alice.address, BORROW_AMOUNT);
        });
      });
      describe('rounding quirk - withdraw 0 emits Transfer of 1 (harness)', function () {
        let withdrawTx: ContractTransactionResponse;
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
          withdrawTx = await comet.connect(alice).withdraw(await baseToken.getAddress(), 0);
        });
        it('emits exactly 3 events', async () => {
          const receipt = await withdrawTx.wait();
          if (!receipt)
            throw new Error('Transaction receipt not found');
          expect(receipt.logs.length).to.be.equal(3);
        });
        it('emits Transfer event with 0 amount (ERC20)', async () => {
          await expect(withdrawTx)
            .to.emit(baseToken, 'Transfer')
            .withArgs(await comet.getAddress(), alice.address, 0);
        });
        it('emits Withdraw event with 0 amount', async () => {
          await expect(withdrawTx)
            .to.emit(comet, 'Withdraw')
            .withArgs(alice.address, alice.address, 0);
        });
        it('emits Transfer burn event with amount 1 (rounding)', async () => {
          await expect(withdrawTx)
            .to.emit(comet, 'Transfer')
            .withArgs(alice.address, ZeroAddress, 1);
        });
      });
      describe('withdraw 0 with collateral only position', function () {
        const COLLATERAL_AMOUNT = exp(1, 18);
        it('withdraws 0 base with only collateral position (no base supplied)', async () => {
          await baseSnapshot.restore();
          await collaterals['WETH'].allocateTo(alice.address, COLLATERAL_AMOUNT);
          await collaterals['WETH'].connect(alice).approve(await comet.getAddress(), COLLATERAL_AMOUNT);
          await comet.connect(alice).supply(await collaterals['WETH'].getAddress(), COLLATERAL_AMOUNT);
          const tx = await comet.connect(alice).withdraw(await baseToken.getAddress(), 0);
          await expect(tx)
            .to.emit(baseToken, 'Transfer')
            .withArgs(await comet.getAddress(), alice.address, 0);
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
        await expect(comet.connect(alice).withdraw(await collaterals['COMP'].getAddress(), 1)).to.be.revertedWithCustomError(comet, 'Paused');
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });
      it('reverts if withdrawing more collateral than supplied', async () => {
        await baseSnapshot.restore();
        await collaterals['WETH'].allocateTo(alice.address, COLLATERAL_SUPPLY);
        await collaterals['WETH'].connect(alice).approve(await comet.getAddress(), COLLATERAL_SUPPLY);
        await comet.connect(alice).supply(await collaterals['WETH'].getAddress(), COLLATERAL_SUPPLY);
        await expect(comet.connect(alice).withdraw(await collaterals['WETH'].getAddress(), COLLATERAL_SUPPLY + 1n)).to.be.revertedWithPanic(0x11);
      });
      it('reverts if collateral withdraw amount is not collateralized', async () => {
        await baseSnapshot.restore();
        await baseToken.connect(bob).approve(await comet.getAddress(), BOB_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(await baseToken.getAddress(), BOB_SUPPLY_AMOUNT);
        await collaterals['WETH'].allocateTo(alice.address, ALICE_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(await comet.getAddress(), ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(await collaterals['WETH'].getAddress(), ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).withdraw(await baseToken.getAddress(), BORROW_AMOUNT);
        // alice has 1 WETH as collateral and borrowed 100 USDC
        // Withdrawing all WETH leaves 0 weighted collateral, but debt = 100 USDC ($100)
        // 0 < 100 → NotCollateralized
        await expect(comet.connect(alice).withdraw(await collaterals['WETH'].getAddress(), ALICE_COLLATERAL_AMOUNT)).to.be.revertedWithCustomError(comet, 'NotCollateralized');
      });
      describe('oracle reverts (with borrow position)', function () {
        const ALICE_WETH_SUPPLY = exp(2, 18);
        let oracleSnapshot: SnapshotRestorer;
        before(async () => {
          await baseSnapshot.restore();
          await baseToken.connect(bob).approve(await comet.getAddress(), BOB_SUPPLY_AMOUNT);
          await comet.connect(bob).supply(await baseToken.getAddress(), BOB_SUPPLY_AMOUNT);
          await collaterals['WETH'].allocateTo(alice.address, ALICE_WETH_SUPPLY);
          await collaterals['WETH'].connect(alice).approve(await comet.getAddress(), ALICE_WETH_SUPPLY);
          await comet.connect(alice).supply(await collaterals['WETH'].getAddress(), ALICE_WETH_SUPPLY);
          await comet.connect(alice).withdraw(await baseToken.getAddress(), BORROW_AMOUNT);
          oracleSnapshot = await takeSnapshot();
        });
        it('reverts collateral withdraw if collateral oracle returns 0', async () => {
          await priceFeeds.WETH.setRoundData(1, 0, 0, 0, 1);
          await expect(comet.connect(alice).withdraw(await collaterals['WETH'].getAddress(), exp(1, 18))).to.be.revertedWithCustomError(comet, 'BadPrice');
        });
        it('reverts collateral withdraw if base oracle returns 0', async () => {
          await oracleSnapshot.restore();
          await priceFeeds.USDC.setRoundData(1, 0, 0, 0, 1);
          await expect(comet.connect(alice).withdraw(await collaterals['WETH'].getAddress(), exp(1, 18))).to.be.revertedWithCustomError(comet, 'BadPrice');
        });
      });
    });
    describe('withdraw collateral: happy path', function () {
      const COLLATERAL_SUPPLY_AMOUNT: bigint = exp(8, 8);
      let collateral: FaucetToken;
      let withdrawTx: ContractTransactionResponse;
      let aliceBalanceBefore: bigint;
      let totalSupplyBefore: bigint;
      before(async () => {
        await baseSnapshot.restore();
        collateral = collaterals['COMP'];
        await collateral.allocateTo(bob.address, COLLATERAL_SUPPLY_AMOUNT);
        await collateral.connect(bob).approve(await comet.getAddress(), COLLATERAL_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(await collateral.getAddress(), COLLATERAL_SUPPLY_AMOUNT);
        aliceBalanceBefore = await collateral.balanceOf(alice.address);
        totalSupplyBefore = (await comet.totalsCollateral(await collateral.getAddress())).totalSupplyAsset;
      });
      it('bob collateral balance before withdraw equals supply amount', async () => {
        expect((await comet.userCollateral(bob.address, await collateral.getAddress())).balance).to.equal(COLLATERAL_SUPPLY_AMOUNT);
      });
      it('total supply before withdraw equals supply amount', async () => {
        expect(totalSupplyBefore).to.equal(COLLATERAL_SUPPLY_AMOUNT);
      });
      it('withdraw collateral does not revert', async () => {
        withdrawTx = await comet.connect(bob).withdrawTo(alice.address, await collateral.getAddress(), COLLATERAL_SUPPLY_AMOUNT);
        expect(withdrawTx).to.not.revert(ethers);
      });
      it('emits Transfer event (ERC20)', async () => {
        await expect(withdrawTx)
          .to.emit(collateral, 'Transfer')
          .withArgs(await comet.getAddress(), alice.address, COLLATERAL_SUPPLY_AMOUNT);
      });
      it('emits WithdrawCollateral event', async () => {
        await expect(withdrawTx)
          .to.emit(comet, 'WithdrawCollateral')
          .withArgs(bob.address, alice.address, await collateral.getAddress(), COLLATERAL_SUPPLY_AMOUNT);
      });
      it('recipient balance increases by withdrawn amount', async () => {
        expect(await collateral.balanceOf(alice.address)).to.equal((aliceBalanceBefore + BigInt(COLLATERAL_SUPPLY_AMOUNT)));
      });
      it('bob collateral balance is zero after full withdrawal', async () => {
        expect((await comet.userCollateral(bob.address, await collateral.getAddress())).balance).to.equal(0);
      });
      it('total supply is zero after full withdrawal', async () => {
        const totalsCollateral = await comet.totalsCollateral(await collateral.getAddress());
        expect(totalsCollateral.totalSupplyAsset).to.equal(0);
      });
      it('gas used is within expected bounds', async () => {
        const receipt = await withdrawTx.wait();
        if (!receipt)
          throw new Error('Transaction receipt not found');
        expect(Number(receipt.gasUsed)).to.be.lessThan(87000);
      });
    });
    describe('edge cases', function () {
      const COLLATERAL_AMOUNT = exp(1, 8);
      const SUPPLY_AMOUNT = exp(100, 6);
      const WITHDRAW_AMOUNT = exp(25, 6);
      it('withdraws 0 collateral successfully', async () => {
        await baseSnapshot.restore();
        await collaterals['COMP'].allocateTo(alice.address, COLLATERAL_AMOUNT);
        await collaterals['COMP'].connect(alice).approve(await comet.getAddress(), COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(await collaterals['COMP'].getAddress(), COLLATERAL_AMOUNT);
        const balanceBefore = (await comet.userCollateral(alice.address, await collaterals['COMP'].getAddress())).balance;
        const tx = await comet.connect(alice).withdraw(await collaterals['COMP'].getAddress(), 0);
        await expect(tx)
          .to.emit(comet, 'WithdrawCollateral')
          .withArgs(alice.address, alice.address, await collaterals['COMP'].getAddress(), 0);
        expect((await comet.userCollateral(alice.address, await collaterals['COMP'].getAddress())).balance).to.equal(balanceBefore);
      });
      it('multiple consecutive withdraws in same block', async () => {
        await baseSnapshot.restore();
        await baseToken.connect(bob).approve(await comet.getAddress(), SUPPLY_AMOUNT);
        await comet.connect(bob).supply(await baseToken.getAddress(), SUPPLY_AMOUNT);
        await comet.connect(bob).withdraw(await baseToken.getAddress(), WITHDRAW_AMOUNT);
        expect(await comet.balanceOf(bob.address)).to.equal(exp(75, 6));
        await comet.connect(bob).withdraw(await baseToken.getAddress(), WITHDRAW_AMOUNT);
        expect(await comet.balanceOf(bob.address)).to.equal(exp(50, 6));
        await comet.connect(bob).withdraw(await baseToken.getAddress(), WITHDRAW_AMOUNT);
        expect(await comet.balanceOf(bob.address)).to.equal(exp(25, 6));
        await comet.connect(bob).withdraw(await baseToken.getAddress(), WITHDRAW_AMOUNT);
        expect(await comet.balanceOf(bob.address)).to.equal(0);
      });
      it('withdrawTo zero address sends tokens to zero address (tokens burned)', async () => {
        await baseSnapshot.restore();
        await baseToken.connect(bob).approve(await comet.getAddress(), SUPPLY_AMOUNT);
        await comet.connect(bob).supply(await baseToken.getAddress(), SUPPLY_AMOUNT);
        const zeroAddressBalanceBefore = await baseToken.balanceOf(ZeroAddress);
        const tx = await comet.connect(bob).withdrawTo(ZeroAddress, await baseToken.getAddress(), SUPPLY_AMOUNT);
        await expect(tx)
          .to.emit(comet, 'Withdraw')
          .withArgs(bob.address, ZeroAddress, SUPPLY_AMOUNT);
        expect(await baseToken.balanceOf(ZeroAddress)).to.equal((zeroAddressBalanceBefore + BigInt(SUPPLY_AMOUNT)));
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
        await baseToken.connect(bob).approve(await comet.getAddress(), BOB_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(await baseToken.getAddress(), BOB_SUPPLY_AMOUNT);
        await expect(comet.connect(alice).withdraw(await baseToken.getAddress(), SMALL_BORROW_AMOUNT)).to.be.revertedWithCustomError(comet, 'NotCollateralized');
      });
      it("can't borrow if there is not enough collateral", async () => {
        await baseSnapshot.restore();
        await baseToken.connect(bob).approve(await comet.getAddress(), BOB_LARGE_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(await baseToken.getAddress(), BOB_LARGE_SUPPLY_AMOUNT);
        await collaterals['WETH'].allocateTo(alice.address, ALICE_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(await comet.getAddress(), ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(await collaterals['WETH'].getAddress(), ALICE_COLLATERAL_AMOUNT);
        const collateralValueUsd = Number(ALICE_COLLATERAL_AMOUNT) / 1e18 * 3000;
        const borrowValueUsd = Number(LARGE_BORROW_AMOUNT) / 1e6;
        expect(borrowValueUsd).to.be.gt(collateralValueUsd);
        await expect(comet.connect(alice).withdraw(await baseToken.getAddress(), LARGE_BORROW_AMOUNT)).to.be.revertedWithCustomError(comet, 'NotCollateralized');
      });
      describe('reverts with collateral supplied', function () {
        let borrowRevertSnapshot: SnapshotRestorer;
        before(async () => {
          await baseSnapshot.restore();
          await baseToken.connect(bob).approve(await comet.getAddress(), BOB_SUPPLY_AMOUNT);
          await comet.connect(bob).supply(await baseToken.getAddress(), BOB_SUPPLY_AMOUNT);
          await collaterals['WETH'].allocateTo(alice.address, ALICE_COLLATERAL_AMOUNT);
          await collaterals['WETH'].connect(alice).approve(await comet.getAddress(), ALICE_COLLATERAL_AMOUNT);
          await comet.connect(alice).supply(await collaterals['WETH'].getAddress(), ALICE_COLLATERAL_AMOUNT);
          borrowRevertSnapshot = await takeSnapshot();
        });
        it("can't borrow less than minBorrow", async () => {
          const borrowAmount = exp(0.5, 6);
          const baseBorrowMin = await comet.baseBorrowMin();
          expect(borrowAmount).to.be.lt(baseBorrowMin);
          await expect(comet.connect(alice).withdraw(await baseToken.getAddress(), borrowAmount)).to.be.revertedWithCustomError(comet, 'BorrowTooSmall');
        });
        it('reverts borrow if collateral oracle returns 0', async () => {
          await borrowRevertSnapshot.restore();
          await priceFeeds.WETH.setRoundData(1, 0, 0, 0, 1);
          await expect(comet.connect(alice).withdraw(await baseToken.getAddress(), SMALL_BORROW_AMOUNT)).to.be.revertedWithCustomError(comet, 'BadPrice');
        });
        it('reverts borrow if base oracle returns 0', async () => {
          await borrowRevertSnapshot.restore();
          await priceFeeds.USDC.setRoundData(1, 0, 0, 0, 1);
          await expect(comet.connect(alice).withdraw(await baseToken.getAddress(), SMALL_BORROW_AMOUNT)).to.be.revertedWithCustomError(comet, 'BadPrice');
        });
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
        const collateralValueUsd = Number(ALICE_COLLATERAL_AMOUNT) / 1e18 * 3000;
        const borrowValueUsd = Number(BORROW_AMOUNT) / 1e6;
        expect(collateralValueUsd).to.be.gt(borrowValueUsd);
        await baseToken.connect(bob).approve(await comet.getAddress(), BOB_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(await baseToken.getAddress(), BOB_SUPPLY_AMOUNT);
        await collaterals['WETH'].allocateTo(alice.address, ALICE_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(await comet.getAddress(), ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(await collaterals['WETH'].getAddress(), ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).withdraw(await baseToken.getAddress(), BORROW_AMOUNT);
        const aliceBalance = await baseBalanceOf(comet, alice.address);
        expect(aliceBalance).to.equal(-BORROW_AMOUNT);
      });
      it('borrow balance increases with interest over time (consecutive borrows)', async () => {
        await baseSnapshot.restore();
        await baseToken.connect(bob).approve(await comet.getAddress(), exp(1000, 6));
        await comet.connect(bob).supply(await baseToken.getAddress(), exp(1000, 6));
        await collaterals['WETH'].allocateTo(alice.address, exp(10, 18));
        await collaterals['WETH'].connect(alice).approve(await comet.getAddress(), exp(10, 18));
        await comet.connect(alice).supply(await collaterals['WETH'].getAddress(), exp(10, 18));
        const borrowAmount1 = exp(100, 6);
        await comet.connect(alice).withdraw(await baseToken.getAddress(), borrowAmount1);
        const balance1 = await baseBalanceOf(comet, alice.address);
        expect(balance1).to.equal(-borrowAmount1);
        await fastForward(86400);
        await ethers.provider.send('evm_mine', []);
        const balanceAfterTime = await baseBalanceOf(comet, alice.address);
        expect(balanceAfterTime).to.be.lte(balance1);
        const borrowAmount2 = exp(50, 6);
        await comet.connect(alice).withdraw(await baseToken.getAddress(), borrowAmount2);
        const finalBalance = await baseBalanceOf(comet, alice.address);
        expect(finalBalance).to.be.lte(-(borrowAmount1 + borrowAmount2));
      });
      it('borrows to withdraw if necessary/possible', async () => {
        await baseSnapshot.restore();
        const SMALL_SUPPLY = exp(10, 6);
        const SMALL_BORROW = exp(1, 6);
        await baseToken.connect(bob).approve(await comet.getAddress(), SMALL_SUPPLY);
        await comet.connect(bob).supply(await baseToken.getAddress(), SMALL_SUPPLY);
        await collaterals['WETH'].allocateTo(alice.address, ALICE_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(await comet.getAddress(), ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(await collaterals['WETH'].getAddress(), ALICE_COLLATERAL_AMOUNT);
        const bobUsdcBefore = await baseToken.balanceOf(bob.address);
        await comet.connect(alice).withdrawTo(bob.address, await baseToken.getAddress(), SMALL_BORROW);
        expect(await baseBalanceOf(comet, alice.address)).to.eq(-SMALL_BORROW);
        expect(await baseToken.balanceOf(bob.address)).to.eq((bobUsdcBefore + BigInt(SMALL_BORROW)));
      });
    });
  });
  describe('withdrawTo', function () {
    const SUPPLY_AMOUNT = exp(100, 6);
    before(async () => {
      await baseSnapshot.restore();
    });
    it('withdraws to sender by default', async () => {
      await baseToken.connect(bob).approve(await comet.getAddress(), SUPPLY_AMOUNT);
      await comet.connect(bob).supply(await baseToken.getAddress(), SUPPLY_AMOUNT);
      const bobUsdcBefore = await baseToken.balanceOf(bob.address);
      expect(await comet.balanceOf(bob.address)).to.equal(SUPPLY_AMOUNT);
      await comet.connect(bob).withdraw(await baseToken.getAddress(), SUPPLY_AMOUNT);
      expect(await comet.balanceOf(bob.address)).to.equal(0);
      expect(await baseToken.balanceOf(bob.address)).to.equal((bobUsdcBefore + BigInt(SUPPLY_AMOUNT)));
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
      await collaterals['COMP'].connect(bob).approve(await comet.getAddress(), SUPPLY_AMOUNT);
      await comet.connect(bob).supply(await collaterals['COMP'].getAddress(), SUPPLY_AMOUNT);
      withdrawFromSnapshot = await takeSnapshot();
    });
    it('withdraws from src if specified and sender has permission', async () => {
      const aliceBalanceBefore = await collaterals['COMP'].balanceOf(alice.address);
      expect((await comet.userCollateral(bob.address, await collaterals['COMP'].getAddress())).balance).to.equal(SUPPLY_AMOUNT);
      await comet.connect(bob).allow(charlie.address, true);
      await comet.connect(charlie).withdrawFrom(bob.address, alice.address, await collaterals['COMP'].getAddress(), SUPPLY_AMOUNT);
      expect((await comet.userCollateral(bob.address, await collaterals['COMP'].getAddress())).balance).to.equal(0);
      expect(await collaterals['COMP'].balanceOf(alice.address)).to.equal((aliceBalanceBefore + BigInt(SUPPLY_AMOUNT)));
    });
    it('reverts if src is specified and sender does not have permission', async () => {
      await withdrawFromSnapshot.restore();
      await expect(comet.connect(charlie).withdrawFrom(bob.address, alice.address, await collaterals['COMP'].getAddress(), SUPPLY_AMOUNT)).to.be.revertedWithCustomError(comet, 'Unauthorized');
    });
    it('reverts if withdraw is paused', async () => {
      await withdrawFromSnapshot.restore();
      await comet.connect(pauseGuardian).pause(false, false, true, false, false);
      expect(await comet.isWithdrawPaused()).to.be.true;
      await comet.connect(bob).allow(charlie.address, true);
      await expect(comet.connect(charlie).withdrawFrom(bob.address, alice.address, await collaterals['COMP'].getAddress(), SUPPLY_AMOUNT)).to.be.revertedWithCustomError(comet, 'Paused');
      await comet.connect(pauseGuardian).pause(false, false, false, false, false);
    });
  });
  describe('reentrancy protection', function () {
    const USDC_LIQUIDITY = exp(100, 6);
    const ATTACK_AMOUNT = exp(1, 6);
    const COLLATERAL_SUPPLY = exp(100, 6);
    const ALICE_COLLATERAL_BALANCE = exp(1, 6);
    let evilComet: CometHarnessInterfaceExtendedAssetList;
    let USDC: FaucetToken;
    let EVIL: EvilToken;
    let evilAlice: SignerWithAddress;
    let evilBob: SignerWithAddress;
    let reentrancySnapshot: SnapshotRestorer;
    before(async () => {
      const { cometWithExtendedAssetList: comet, tokens, users } = await makeProtocol({
        assets: {
          USDC: { decimals: 6 },
          EVIL: {
            decimals: 6,
            initialPrice: 2,
            factory: new EvilToken__factory((await ethers.getSigners())[0]),
          }
        }
      });
      evilComet = comet;
      USDC = tokens.USDC as FaucetToken;
      EVIL = tokens.EVIL as EvilToken;
      [evilAlice, evilBob] = users;
      await USDC.allocateTo(await evilComet.getAddress(), USDC_LIQUIDITY);
      // Harness: EvilToken can't be supplied normally - it's malicious and triggers reentrancy
      const currentTotalsCollateral = await evilComet.totalsCollateral(await EVIL.getAddress());
      const totalsCollateral = { totalSupplyAsset: COLLATERAL_SUPPLY, _reserved: currentTotalsCollateral._reserved };
      await evilComet.setTotalsCollateral(await EVIL.getAddress(), totalsCollateral);
      await evilComet.setCollateralBalance(evilAlice.address, await EVIL.getAddress(), ALICE_COLLATERAL_BALANCE);
      await evilComet.connect(evilAlice).allow(await EVIL.getAddress(), true);
      reentrancySnapshot = await takeSnapshot();
    });
    it('blocks malicious reentrant transferFrom', async () => {
      const currentAttack = await EVIL.getAttack();
      const attack = { source: currentAttack.source, maxCalls: currentAttack.maxCalls,
        attackType: ReentryAttack.TransferFrom,
        destination: evilBob.address,
        asset: await USDC.getAddress(),
        amount: ATTACK_AMOUNT };
      await EVIL.setAttack(attack);
      await expect(evilComet.connect(evilAlice).withdraw(await EVIL.getAddress(), ATTACK_AMOUNT)).to.be.revertedWithCustomError(evilComet, 'ReentrantCallBlocked');
      expect(await USDC.balanceOf(await evilComet.getAddress())).to.eq(USDC_LIQUIDITY);
      expect(await baseBalanceOf(evilComet, evilAlice.address)).to.eq(0n);
      expect(await USDC.balanceOf(evilBob.address)).to.eq(0);
    });
    it('blocks malicious reentrant withdrawFrom', async () => {
      await reentrancySnapshot.restore();
      const currentAttack = await EVIL.getAttack();
      const attack = { source: currentAttack.source, maxCalls: currentAttack.maxCalls,
        attackType: ReentryAttack.WithdrawFrom,
        destination: evilBob.address,
        asset: await USDC.getAddress(),
        amount: ATTACK_AMOUNT };
      await EVIL.setAttack(attack);
      await expect(evilComet.connect(evilAlice).withdraw(await EVIL.getAddress(), ATTACK_AMOUNT)).to.be.revertedWithCustomError(evilComet, 'ReentrantCallBlocked');
      expect(await USDC.balanceOf(await evilComet.getAddress())).to.eq(USDC_LIQUIDITY);
      expect(await baseBalanceOf(evilComet, evilAlice.address)).to.eq(0n);
      expect(await USDC.balanceOf(evilBob.address)).to.eq(0);
    });
  });
  describe('non-standard tokens', function () {
    describe('USDT-like token (no return value)', function () {
      let nstComet: CometHarnessInterfaceExtendedAssetList;
      let alice: SignerWithAddress;
      let bob: SignerWithAddress;
      let usdt: NonStandardFaucetFeeToken;
      let nonStdCollateral: NonStandardFaucetFeeToken;
      const USDT_AMOUNT = exp(100, 6);
      const NON_STD_COLLATERAL_AMOUNT = exp(1, 18);
      before(async function () {
        const assets = defaultAssets();
        assets['USDT'] = {
          initial: 1e6,
          decimals: 6,
          factory: new NonStandardFaucetFeeToken__factory((await ethers.getSigners())[0]),
        };
        assets['NonStdCollateral'] = {
          initial: 1e8,
          decimals: 18,
          factory: new NonStandardFaucetFeeToken__factory((await ethers.getSigners())[0]),
        };
        const protocol = await makeProtocol({ base: 'USDT', assets: assets });
        nstComet = protocol.cometWithExtendedAssetList;
        [alice, bob] = protocol.users;
        const tokens = protocol.tokens;
        usdt = tokens['USDT'] as NonStandardFaucetFeeToken;
        nonStdCollateral = tokens['NonStdCollateral'] as NonStandardFaucetFeeToken;
        await usdt.allocateTo(bob.address, USDT_AMOUNT);
        await usdt.connect(bob).approve(await nstComet.getAddress(), USDT_AMOUNT);
        await nstComet.connect(bob).supply(await usdt.getAddress(), USDT_AMOUNT);
        await nonStdCollateral.allocateTo(alice.address, NON_STD_COLLATERAL_AMOUNT);
        await nonStdCollateral.connect(alice).approve(await nstComet.getAddress(), NON_STD_COLLATERAL_AMOUNT);
        await nstComet.connect(alice).supply(await nonStdCollateral.getAddress(), NON_STD_COLLATERAL_AMOUNT);
      });
      it('can withdraw base token - non-standard ERC20 (without return interface)', async () => {
        const bobBalanceBefore = await usdt.balanceOf(bob.address);
        await nstComet.connect(bob).withdraw(await usdt.getAddress(), USDT_AMOUNT);
        expect(await usdt.balanceOf(bob.address)).to.equal((bobBalanceBefore + BigInt(USDT_AMOUNT)));
        expect(await nstComet.balanceOf(bob.address)).to.equal(0);
      });
      it('can withdraw collateral - non-standard ERC20 (without return interface)', async () => {
        const aliceBalanceBefore = await nonStdCollateral.balanceOf(alice.address);
        await nstComet.connect(alice).withdraw(await nonStdCollateral.getAddress(), NON_STD_COLLATERAL_AMOUNT);
        expect(await nonStdCollateral.balanceOf(alice.address)).to.equal((aliceBalanceBefore + BigInt(NON_STD_COLLATERAL_AMOUNT)));
        expect((await nstComet.userCollateral(alice.address, await nonStdCollateral.getAddress())).balance).to.equal(0);
      });
    });
    describe('fee-on-transfer token', function () {
      const BASE_TOKEN_AMOUNT = exp(100, 6);
      const COLLATERAL_TOKEN_AMOUNT = exp(1, 18);
      const NUMERATOR = 10;
      const DENOMINATOR = 10000;
      let feeComet: CometHarnessInterfaceExtendedAssetList;
      let feeBaseToken: NonStandardFaucetFeeToken;
      let feeCollateral: NonStandardFaucetFeeToken;
      let alice: SignerWithAddress;
      let bob: SignerWithAddress;
      before(async function () {
        const assets = defaultAssets();
        assets['USDT'] = {
          initial: 1e6,
          decimals: 6,
          factory: new NonStandardFaucetFeeToken__factory((await ethers.getSigners())[0]),
        };
        assets['FeeCollateral'] = {
          initial: 1e8,
          decimals: 18,
          factory: new NonStandardFaucetFeeToken__factory((await ethers.getSigners())[0]),
        };
        const protocol = await makeProtocol({ base: 'USDT', assets: assets });
        feeComet = protocol.cometWithExtendedAssetList;
        feeBaseToken = protocol.tokens['USDT'] as NonStandardFaucetFeeToken;
        feeCollateral = protocol.tokens['FeeCollateral'] as NonStandardFaucetFeeToken;
        [alice, bob] = protocol.users;
        await feeBaseToken.setParams(NUMERATOR, exp(100, 18));
        await feeCollateral.setParams(NUMERATOR, exp(100, 18));
        await feeBaseToken.allocateTo(bob.address, BASE_TOKEN_AMOUNT);
        await feeBaseToken.connect(bob).approve(await feeComet.getAddress(), BASE_TOKEN_AMOUNT);
        await feeComet.connect(bob).supply(await feeBaseToken.getAddress(), BASE_TOKEN_AMOUNT);
        await feeCollateral.allocateTo(alice.address, COLLATERAL_TOKEN_AMOUNT);
        await feeCollateral.connect(alice).approve(await feeComet.getAddress(), COLLATERAL_TOKEN_AMOUNT);
        await feeComet.connect(alice).supply(await feeCollateral.getAddress(), COLLATERAL_TOKEN_AMOUNT);
      });
      it('withdraws base token with fee-on-transfer (fee deducted on transfer out)', async () => {
        const bobPrincipal = (await feeComet.userBasic(bob.address)).principal;
        const bobBalanceBefore = await feeBaseToken.balanceOf(bob.address);
        const withdrawTx = await feeComet.connect(bob).withdraw(await feeBaseToken.getAddress(), bobPrincipal);
        expect(withdrawTx).to.not.revert(ethers);
        const fee = ((BigInt(bobPrincipal) * BigInt(NUMERATOR)) / BigInt(DENOMINATOR));
        const expectedReceived = (BigInt(bobPrincipal) - BigInt(fee));
        expect(await feeBaseToken.balanceOf(bob.address)).to.equal((bobBalanceBefore + BigInt(expectedReceived)));
      });
      it('withdraws collateral with fee-on-transfer (fee deducted on transfer out)', async () => {
        const aliceCollateral = (await feeComet.userCollateral(alice.address, await feeCollateral.getAddress())).balance;
        const aliceBalanceBefore = await feeCollateral.balanceOf(alice.address);
        const withdrawTx = await feeComet.connect(alice).withdraw(await feeCollateral.getAddress(), aliceCollateral);
        expect(withdrawTx).to.not.revert(ethers);
        const fee = ((BigInt(aliceCollateral) * BigInt(NUMERATOR)) / BigInt(DENOMINATOR));
        const expectedReceived = (BigInt(aliceCollateral) - BigInt(fee));
        expect(await feeCollateral.balanceOf(alice.address)).to.equal((aliceBalanceBefore + BigInt(expectedReceived)));
        expect((await feeComet.userCollateral(alice.address, await feeCollateral.getAddress())).balance).to.equal(0);
      });
    });
  });
  describe('withdraw 24 collaterals', function () {
    const SUPPLY_COLLATERAL_AMOUNT: bigint = exp(1, 18);
    let comet: CometHarnessInterfaceExtendedAssetList;
    let baseToken: FaucetToken;
    let collaterals: {
            [symbol: string]: FaucetToken;
        } = {};
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let dave: SignerWithAddress;
    let withdrawTxs: ContractTransactionResponse[] = [];
    let alicePrincipalBefore: bigint;
    let snapshot: SnapshotRestorer;
    before(async () => {
      const cometCollaterals = Object.fromEntries(Array.from({ length: MAX_ASSETS }, (_, j) => [`ASSET${j}`, {
        decimals: 18,
        initialPrice: 100,
      }]));
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
        if (asset === 'USDC')
          continue;
        collaterals[asset] = protocol.tokens[asset] as FaucetToken;
      }
      [alice, bob, dave] = protocol.users;
      await baseToken.allocateTo(bob.address, exp(100000, 6));
      await baseToken.connect(bob).approve(await comet.getAddress(), exp(100000, 6));
      await comet.connect(bob).supply(await baseToken.getAddress(), exp(100000, 6));
      for (let i = 0; i < MAX_ASSETS; i++) {
        const assetToken = collaterals[`ASSET${i}`];
        await assetToken.allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
        await assetToken.connect(alice).approve(await comet.getAddress(), SUPPLY_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(await assetToken.getAddress(), SUPPLY_COLLATERAL_AMOUNT);
        await assetToken.allocateTo(dave.address, SUPPLY_COLLATERAL_AMOUNT);
        await assetToken.connect(dave).approve(await comet.getAddress(), SUPPLY_COLLATERAL_AMOUNT);
        await comet.connect(dave).supply(await assetToken.getAddress(), SUPPLY_COLLATERAL_AMOUNT);
      }
      alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;
      snapshot = await takeSnapshot();
    });
    describe('withdraw', function () {
      this.afterAll(async () => snapshot.restore());
      it('each collateral withdraw is successful', async () => {
        for (const asset of Object.values(collaterals)) {
          const balanceBefore = await asset.balanceOf(alice.address);
          const withdrawTx = await comet.connect(alice).withdraw(await asset.getAddress(), SUPPLY_COLLATERAL_AMOUNT);
          expect(withdrawTx).to.not.revert(ethers);
          expect(await asset.balanceOf(alice.address)).to.equal((balanceBefore + BigInt(SUPPLY_COLLATERAL_AMOUNT)));
          withdrawTxs.push(withdrawTx);
        }
      });
      it('WithdrawCollateral event is emitted for each collateral', async () => {
        const assets = Object.values(collaterals);
        for (let i = 0; i < assets.length; i++) {
          await expect(withdrawTxs[i])
            .to.emit(comet, 'WithdrawCollateral')
            .withArgs(alice.address, alice.address, await assets[i].getAddress(), SUPPLY_COLLATERAL_AMOUNT);
        }
        withdrawTxs = [];
      });
      it('each collateral balance is zero after withdrawal', async () => {
        for (const asset of Object.values(collaterals)) {
          expect(await comet.collateralBalanceOf(alice.address, await asset.getAddress())).to.be.equal(0);
        }
      });
      it('alice asset list is empty after all withdrawals', async () => {
        const assetList = await comet.getAssetList(alice.address);
        expect(assetList.length).to.equal(0);
      });
      it('each collateral comet total supplied collateral amount decreased by alice withdrawal', async () => {
        for (const asset of Object.values(collaterals)) {
          expect((await comet.totalsCollateral(await asset.getAddress())).totalSupplyAsset).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      });
      it('alice principal is not changed', async () => {
        expect((await comet.userBasic(alice.address)).principal).to.be.equal(alicePrincipalBefore);
      });
    });
    describe('withdrawTo', function () {
      before(async () => {
        await comet.connect(alice).allow(dave.address, true);
      });
      this.afterAll(async () => snapshot.restore());
      it('each collateral withdrawTo is successful', async () => {
        for (const asset of Object.values(collaterals)) {
          const balanceBefore = await asset.balanceOf(dave.address);
          const withdrawToTx = await comet.connect(alice).withdrawTo(dave.address, await asset.getAddress(), SUPPLY_COLLATERAL_AMOUNT);
          expect(withdrawToTx).to.not.revert(ethers);
          expect(await asset.balanceOf(dave.address)).to.equal((balanceBefore + BigInt(SUPPLY_COLLATERAL_AMOUNT)));
          withdrawTxs.push(withdrawToTx);
        }
      });
      it('WithdrawCollateral event is emitted for each collateral', async () => {
        const assets = Object.values(collaterals);
        for (let i = 0; i < assets.length; i++) {
          await expect(withdrawTxs[i])
            .to.emit(comet, 'WithdrawCollateral')
            .withArgs(alice.address, dave.address, await assets[i].getAddress(), SUPPLY_COLLATERAL_AMOUNT);
        }
        withdrawTxs = [];
      });
      it('each collateral balance for alice is zero', async () => {
        for (const asset of Object.values(collaterals)) {
          expect(await comet.collateralBalanceOf(alice.address, await asset.getAddress())).to.be.equal(0);
        }
      });
      it('alice asset list is empty after all withdrawals', async () => {
        const assetList = await comet.getAssetList(alice.address);
        expect(assetList.length).to.equal(0);
      });
      it('each collateral comet total supplied collateral amount decreased by alice withdrawal', async () => {
        for (const asset of Object.values(collaterals)) {
          expect((await comet.totalsCollateral(await asset.getAddress())).totalSupplyAsset).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      });
      it('alice principal is not changed', async () => {
        expect((await comet.userBasic(alice.address)).principal).to.be.equal(alicePrincipalBefore);
      });
    });
    describe('withdrawFrom', function () {
      before(async () => {
        await comet.connect(alice).allow(dave.address, true);
      });
      this.afterAll(async () => snapshot.restore());
      it('each collateral withdrawFrom is successful', async () => {
        for (const asset of Object.values(collaterals)) {
          const balanceBefore = await asset.balanceOf(alice.address);
          const withdrawFromTx = await comet.connect(dave).withdrawFrom(alice.address, alice.address, await asset.getAddress(), SUPPLY_COLLATERAL_AMOUNT);
          expect(withdrawFromTx).to.not.revert(ethers);
          expect(await asset.balanceOf(alice.address)).to.equal((balanceBefore + BigInt(SUPPLY_COLLATERAL_AMOUNT)));
          withdrawTxs.push(withdrawFromTx);
        }
      });
      it('WithdrawCollateral event is emitted for each collateral', async () => {
        const assets = Object.values(collaterals);
        for (let i = 0; i < assets.length; i++) {
          await expect(withdrawTxs[i])
            .to.emit(comet, 'WithdrawCollateral')
            .withArgs(alice.address, alice.address, await assets[i].getAddress(), SUPPLY_COLLATERAL_AMOUNT);
        }
      });
      it('each collateral balance for alice is zero', async () => {
        for (const asset of Object.values(collaterals)) {
          expect(await comet.collateralBalanceOf(alice.address, await asset.getAddress())).to.be.equal(0);
        }
      });
      it('alice asset list is empty after all withdrawals', async () => {
        const assetList = await comet.getAssetList(alice.address);
        expect(assetList.length).to.equal(0);
      });
      it('each collateral comet total supplied collateral amount decreased by alice withdrawal', async () => {
        for (const asset of Object.values(collaterals)) {
          expect((await comet.totalsCollateral(await asset.getAddress())).totalSupplyAsset).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      });
      it('alice principal is not changed', async () => {
        expect((await comet.userBasic(alice.address)).principal).to.be.equal(alicePrincipalBefore);
      });
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
        await comet.connect(alice).withdraw(await baseToken.getAddress(), borrowAmount);
        expect(await baseToken.balanceOf(alice.address)).to.equal((aliceBalanceBefore + BigInt(borrowAmount)));
        expect(await baseBalanceOf(comet as unknown as CometHarnessInterfaceExtendedAssetList, alice.address)).to.equal(BigInt(-borrowAmount));
      });
    });
  });
});

describe('withdrawTo exact-accounting regressions', function () {
  it('withdraws base from sender if the asset is base', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;
    const cometAddress = await comet.getAddress();
    const usdcAddress = await USDC.getAddress();

    const _i0 = await USDC.allocateTo(cometAddress, 100e6);
    await setTotalsBasic(comet, {
      totalSupplyBase: 100e6,
    });

    const _i1 = await comet.setBasePrincipal(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const s0 = await wait(cometAsB.withdrawTo(alice.address, usdcAddress, 100e6));
    const t1 = await comet.totalsBasic();
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: cometAddress,
        to: alice.address,
        amount: BigInt(100e6),
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Withdraw: {
        src: bob.address,
        to: alice.address,
        amount: BigInt(100e6),
      }
    });
    expect(event(s0, 2)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: ZeroAddress,
        amount: BigInt(100e6),
      }
    });

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p1.external).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(0n);
    expect(t1.totalBorrowBase).to.be.equal(0n);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(106000);
  });

  it('does not emit Transfer for 0 burn', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC, WETH } = tokens;
    const cometAddress = await comet.getAddress();
    const usdcAddress = await USDC.getAddress();
    const wethAddress = await WETH.getAddress();

    await USDC.allocateTo(cometAddress, 110e6);
    await setTotalsBasic(comet, {
      totalSupplyBase: 100e6,
    });
    await comet.setCollateralBalance(bob.address, wethAddress, exp(1, 18));
    const cometAsB = comet.connect(bob);

    const s0 = await wait(cometAsB.withdrawTo(alice.address, usdcAddress, exp(1, 6)));
    expect(s0.receipt.logs.length).to.be.equal(2);
    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: cometAddress,
        to: alice.address,
        amount: exp(1, 6),
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Withdraw: {
        src: bob.address,
        to: alice.address,
        amount: exp(1, 6),
      }
    });
  });

  it('withdraws max base balance (including accrued) from sender if the asset is base', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;
    const cometAddress = await comet.getAddress();
    const usdcAddress = await USDC.getAddress();

    await USDC.allocateTo(cometAddress, 110e6);
    await setTotalsBasic(comet, {
      totalSupplyBase: 100e6,
      totalBorrowBase: 50e6, // non-zero borrow to accrue interest
    });
    await comet.setBasePrincipal(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    // Fast forward to accrue some interest
    await fastForward(86400);
    await ethers.provider.send('evm_mine', []);

    const a0 = await portfolio(protocol, alice.address);
    const b0 = await portfolio(protocol, bob.address);
    const bobAccruedBalance = await comet.balanceOf.staticCall(bob.address);
    const s0 = await wait(cometAsB.withdrawTo(alice.address, usdcAddress, MaxUint256));
    const t1 = await comet.totalsBasic();
    const a1 = await portfolio(protocol, alice.address);
    const b1 = await portfolio(protocol, bob.address);

    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: cometAddress,
        to: alice.address,
        amount: bobAccruedBalance,
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Withdraw: {
        src: bob.address,
        to: alice.address,
        amount: bobAccruedBalance,
      }
    });
    expect(event(s0, 2)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: ZeroAddress,
        amount: bobAccruedBalance,
      }
    });

    expect(a0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b0.internal).to.be.deep.equal({ USDC: bobAccruedBalance, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a1.external).to.be.deep.equal({ USDC: bobAccruedBalance, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(0n);
    expect(t1.totalBorrowBase).to.be.equal(exp(50, 6));
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(115000);
  });

  it('withdraw max base should withdraw 0 if user has a borrow position', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC, WETH } = tokens;
    const cometAddress = await comet.getAddress();
    const usdcAddress = await USDC.getAddress();
    const wethAddress = await WETH.getAddress();

    await comet.setBasePrincipal(bob.address, -100e6);
    await comet.setCollateralBalance(bob.address, wethAddress, exp(1, 18));
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsBasic();
    const a0 = await portfolio(protocol, alice.address);
    const b0 = await portfolio(protocol, bob.address);
    const s0 = await wait(cometAsB.withdrawTo(alice.address, usdcAddress, MaxUint256));
    const t1 = await comet.totalsBasic();
    const a1 = await portfolio(protocol, alice.address);
    const b1 = await portfolio(protocol, bob.address);

    expect(s0.receipt.logs.length).to.be.equal(2);
    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: cometAddress,
        to: alice.address,
        amount: 0n,
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Withdraw: {
        src: bob.address,
        to: alice.address,
        amount: 0n,
      }
    });

    expect(a0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b0.internal).to.be.deep.equal({ USDC: exp(-100, 6), COMP: 0n, WETH: exp(1, 18), WBTC: 0n });
    expect(b0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b1.internal).to.be.deep.equal({ USDC: exp(-100, 6), COMP: 0n, WETH: exp(1, 18), WBTC: 0n });
    expect(b1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(t0.totalSupplyBase);
    expect(t1.totalBorrowBase).to.be.equal(t0.totalBorrowBase);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(121000);
  });

  // This demonstrates a weird quirk of the present value/principal value rounding down math.
  it('withdraws 0 but Comet Transfer event amount is 1', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice] } = protocol;
    const { USDC } = tokens;
    const cometAddress = await comet.getAddress();
    const usdcAddress = await USDC.getAddress();

    await comet.setBasePrincipal(alice.address, 99999992291226);
    await setTotalsBasic(comet, {
      totalSupplyBase: 699999944771920,
      baseSupplyIndex: 1000000131467072,
    });

    const s0 = await wait(comet.connect(alice).withdraw(usdcAddress, 0));

    expect(s0.receipt.logs.length).to.be.equal(3);
    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: cometAddress,
        to: alice.address,
        amount: 0n,
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Withdraw: {
        src: alice.address,
        to: alice.address,
        amount: 0n,
      }
    });
    // Weird quirk of round down behavior where `withdrawAmount` is 1 even though
    // `amount` is 0. So no base leaves Comet (which is expected)
    expect(event(s0, 2)).to.be.deep.equal({
      Transfer: {
        from: alice.address,
        to: ZeroAddress,
        amount: 1n,
      }
    });
  });

  it('withdraws collateral from sender if the asset is collateral', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { COMP } = tokens;
    const cometAddress = await comet.getAddress();
    const compAddress = await COMP.getAddress();

    const t0 = {
      totalSupplyAsset: 8e8,
      _reserved: 0,
    };
    const _i0 = await COMP.allocateTo(cometAddress, 8e8);
    const _b0 = await wait(comet.setTotalsCollateral(compAddress, t0));

    const _i1 = await comet.setCollateralBalance(bob.address, compAddress, 8e8);
    const cometAsB = comet.connect(bob);

    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const s0 = await wait(cometAsB.withdrawTo(alice.address, compAddress, 8e8));
    const t1 = await comet.totalsCollateral(compAddress);
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: cometAddress,
        to: alice.address,
        amount: BigInt(8e8),
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      WithdrawCollateral: {
        src: bob.address,
        to: alice.address,
        asset: compAddress,
        amount: BigInt(8e8),
      }
    });

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: 0n, COMP: exp(8, 8), WETH: 0n, WBTC: 0n });
    expect(q0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p1.external).to.be.deep.equal({ USDC: 0n, COMP: exp(8, 8), WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyAsset).to.be.equal(0n);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(87000);
  });

  it('calculates base principal correctly', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;
    const cometAddress = await comet.getAddress();
    const usdcAddress = await USDC.getAddress();

    await USDC.allocateTo(cometAddress, 100e6);
    const _totals0 = await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
      totalSupplyBase: 50e6, // 100e6 in present value
    });

    await comet.setBasePrincipal(bob.address, 50e6); // 100e6 in present value
    const cometAsB = comet.connect(bob);

    const alice0 = await portfolio(protocol, alice.address);
    const bob0 = await portfolio(protocol, bob.address);

    await wait(cometAsB.withdrawTo(alice.address, usdcAddress, 100e6));
    const totals1 = await comet.totalsBasic();
    const alice1 = await portfolio(protocol, alice.address);
    const bob1 = await portfolio(protocol, bob.address);

    expect(alice0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(alice0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(bob0.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(bob0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(alice1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(alice1.external).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(bob1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(bob1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(totals1.totalSupplyBase).to.be.equal(0n);
    expect(totals1.totalBorrowBase).to.be.equal(0n);
  });

  it('reverts if withdrawing base exceeds the total supply', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;
    const cometAddress = await comet.getAddress();
    const usdcAddress = await USDC.getAddress();

    const _i0 = await USDC.allocateTo(cometAddress, 100e6);
    const _i1 = await comet.setBasePrincipal(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    await expect(cometAsB.withdrawTo(alice.address, usdcAddress, 100e6)).to.revert(ethers);
  });

  it('reverts if withdrawing collateral exceeds the total supply', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { COMP } = tokens;
    const cometAddress = await comet.getAddress();
    const compAddress = await COMP.getAddress();

    const _i0 = await COMP.allocateTo(cometAddress, 8e8);
    const _i1 = await comet.setCollateralBalance(bob.address, compAddress, 8e8);
    const cometAsB = comet.connect(bob);

    await expect(cometAsB.withdrawTo(alice.address, compAddress, 8e8)).to.revert(ethers);
  });

  it('reverts if the asset is neither collateral nor base', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, users: [alice, bob], unsupportedToken: USUP } = protocol;
    const cometAddress = await comet.getAddress();
    const unsupportedTokenAddress = await USUP.getAddress();

    const _i0 = await USUP.allocateTo(cometAddress, 1);
    const cometAsB = comet.connect(bob);

    await expect(cometAsB.withdrawTo(alice.address, unsupportedTokenAddress, 1)).to.revert(ethers);
  });

  it('reverts if withdraw is paused', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [alice, bob] } = protocol;
    const { USDC } = tokens;
    const cometAddress = await comet.getAddress();
    const usdcAddress = await USDC.getAddress();

    await USDC.allocateTo(cometAddress, 1);
    const cometAsB = comet.connect(bob);

    // Pause withdraw
    await wait(comet.connect(pauseGuardian).pause(false, false, true, false, false));
    expect(await comet.isWithdrawPaused()).to.be.true;

    await expect(cometAsB.withdrawTo(alice.address, usdcAddress, 1))
      .to.be.revertedWithCustomError(comet, 'Paused');
  });

  it('reverts if withdraw max for a collateral asset', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    await COMP.allocateTo(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    await expect(cometAsB.withdrawTo(alice.address, compAddress, MaxUint256))
      .to.be.revertedWithCustomError(comet, 'InvalidUInt128');
  });

  it('borrows to withdraw if necessary/possible', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol();
    const { WETH, USDC } = tokens;
    const cometAddress = await comet.getAddress();
    const usdcAddress = await USDC.getAddress();
    const wethAddress = await WETH.getAddress();

    await USDC.allocateTo(cometAddress, 1e6);
    await comet.setCollateralBalance(alice.address, wethAddress, exp(1, 18));

    let t0 = await comet.totalsBasic();
    await setTotalsBasic(comet, {
      baseBorrowIndex: t0.baseBorrowIndex * 2n,
    });

    await comet.connect(alice).withdrawTo(bob.address, usdcAddress, 1e6);

    expect(await baseBalanceOf(comet, alice.address)).to.eq(BigInt(-1e6));
    expect(await USDC.balanceOf(bob.address)).to.eq(1e6);
  });
});

describe('withdraw', function () {
  it('withdraws to sender by default', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [bob] } = protocol;
    const { USDC } = tokens;
    const cometAddress = await comet.getAddress();
    const usdcAddress = await USDC.getAddress();

    const _i0 = await USDC.allocateTo(cometAddress, 100e6);
    const _t0 = await setTotalsBasic(comet, {
      totalSupplyBase: 100e6,
    });

    const _i1 = await comet.setBasePrincipal(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    const q0 = await portfolio(protocol, bob.address);
    const _s0 = await wait(cometAsB.withdraw(usdcAddress, 100e6));
    const _t1 = await comet.totalsBasic();
    const q1 = await portfolio(protocol, bob.address);

    expect(q0.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.external).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
  });

  it('reverts if withdraw is paused', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [bob] } = protocol;
    const { USDC } = tokens;
    const cometAddress = await comet.getAddress();
    const usdcAddress = await USDC.getAddress();

    await USDC.allocateTo(cometAddress, 100e6);
    const cometAsB = comet.connect(bob);

    // Pause withdraw
    await wait(comet.connect(pauseGuardian).pause(false, false, true, false, false));
    expect(await comet.isWithdrawPaused()).to.be.true;

    await expect(cometAsB.withdraw(usdcAddress, 100e6))
      .to.be.revertedWithCustomError(comet, 'Paused');
  });

  it('reverts if withdraw amount is less than baseBorrowMin', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice] } = await makeProtocol({
      baseBorrowMin: exp(1, 6)
    });
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    await expect(
      comet.connect(alice).withdraw(usdcAddress, exp(.5, 6))
    ).to.be.revertedWithCustomError(comet, 'BorrowTooSmall');
  });

  it('reverts if base withdraw amount is not collateralzed', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice] } = await makeProtocol();
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    await expect(
      comet.connect(alice).withdraw(usdcAddress, exp(1, 6))
    ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
  });

  it('reverts if collateral withdraw amount is not collateralized', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice] } = await makeProtocol();
    const { WETH } = tokens;
    const wethAddress = await WETH.getAddress();

    const totalsCollateral = {
      totalSupplyAsset: exp(1, 18),
      _reserved: 0,
    };
    await wait(comet.setTotalsCollateral(wethAddress, totalsCollateral));

    // user has a borrow, but with collateral to cover
    await comet.setBasePrincipal(alice.address, -100e6);
    await comet.setCollateralBalance(alice.address, wethAddress, exp(1, 18));

    // reverts if withdraw would leave borrow uncollateralized
    await expect(
      comet.connect(alice).withdraw(wethAddress, exp(1, 18))
    ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
  });

  describe('reentrancy', function () {
    it('blocks malicious reentrant transferFrom', async () => {
      const [deployer] = await ethers.getSigners();
      const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol({
        assets: {
          USDC: {
            decimals: 6
          },
          EVIL: {
            decimals: 6,
            initialPrice: 2,
            factory: new EvilToken__factory(deployer),
          }
        }
      });
      const { USDC, EVIL } = <{ USDC: FaucetToken, EVIL: EvilToken }>tokens;
      const cometAddress = await comet.getAddress();
      const usdcAddress = await USDC.getAddress();
      const evilAddress = await EVIL.getAddress();

      await USDC.allocateTo(cometAddress, 100e6);

      const attack = {
        attackType: ReentryAttack.TransferFrom,
        source: evilAddress,
        destination: bob.address,
        asset: usdcAddress,
        amount: 1e6,
        maxCalls: MaxUint256,
      };
      await EVIL.setAttack(attack);

      const totalsCollateral = {
        totalSupplyAsset: 100e6,
        _reserved: 0,
      };
      await comet.setTotalsCollateral(evilAddress, totalsCollateral);

      await comet.setCollateralBalance(alice.address, evilAddress, exp(1, 6));
      await comet.connect(alice).allow(evilAddress, true);

      // In callback, EVIL token calls transferFrom(alice.address, bob.address, 1e6)
      await expect(
        comet.connect(alice).withdraw(evilAddress, 1e6)
      ).to.be.revertedWithCustomError(comet, 'ReentrantCallBlocked');

      // no USDC transferred
      expect(await USDC.balanceOf(cometAddress)).to.eq(100_000_000n);
      expect(await baseBalanceOf(comet, alice.address)).to.eq(0n);
      expect(await USDC.balanceOf(alice.address)).to.eq(0n);
      expect(await baseBalanceOf(comet, bob.address)).to.eq(0n);
      expect(await USDC.balanceOf(bob.address)).to.eq(0n);
    });

    it('blocks malicious reentrant withdrawFrom', async () => {
      const [deployer] = await ethers.getSigners();
      const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol({
        assets: {
          USDC: {
            decimals: 6
          },
          EVIL: {
            decimals: 6,
            initialPrice: 2,
            factory: new EvilToken__factory(deployer),
          }
        }
      });
      const { USDC, EVIL } = <{ USDC: FaucetToken, EVIL: EvilToken }>tokens;
      const cometAddress = await comet.getAddress();
      const usdcAddress = await USDC.getAddress();
      const evilAddress = await EVIL.getAddress();

      await USDC.allocateTo(cometAddress, 100e6);

      const attack = {
        attackType: ReentryAttack.WithdrawFrom,
        source: evilAddress,
        destination: bob.address,
        asset: usdcAddress,
        amount: 1e6,
        maxCalls: MaxUint256,
      };
      await EVIL.setAttack(attack);

      const totalsCollateral = {
        totalSupplyAsset: 100e6,
        _reserved: 0,
      };
      await comet.setTotalsCollateral(evilAddress, totalsCollateral);

      await comet.setCollateralBalance(alice.address, evilAddress, exp(1, 6));

      await comet.connect(alice).allow(evilAddress, true);

      // in callback, EvilToken attempts to withdraw USDC to bob's address
      await expect(
        comet.connect(alice).withdraw(evilAddress, 1e6)
      ).to.be.revertedWithCustomError(comet, 'ReentrantCallBlocked');

      // no USDC transferred
      expect(await USDC.balanceOf(cometAddress)).to.eq(100_000_000n);
      expect(await baseBalanceOf(comet, alice.address)).to.eq(0n);
      expect(await USDC.balanceOf(alice.address)).to.eq(0n);
      expect(await baseBalanceOf(comet, bob.address)).to.eq(0n);
      expect(await USDC.balanceOf(bob.address)).to.eq(0n);
    });
  });

});

describe('withdrawFrom', function () {
  it('withdraws from src if specified and sender has permission', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob, charlie] } = protocol;
    const { COMP } = tokens;
    const cometAddress = await comet.getAddress();
    const compAddress = await COMP.getAddress();

    const t0 = {
      totalSupplyAsset: 7,
      _reserved: 0,
    };
    const _i0 = await COMP.allocateTo(cometAddress, 7);
    const _b0 = await wait(comet.setTotalsCollateral(compAddress, t0));

    const _i1 = await comet.setCollateralBalance(bob.address, compAddress, 7);

    const cometAsB = comet.connect(bob);
    const cometAsC = comet.connect(charlie);

    const _a1 = await wait(cometAsB.allow(charlie.address, true));
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const _s0 = await wait(cometAsC.withdrawFrom(bob.address, alice.address, compAddress, 7));
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: 0n, COMP: 7n, WETH: 0n, WBTC: 0n });
    expect(q0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p1.external).to.be.deep.equal({ USDC: 0n, COMP: 7n, WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
  });

  it('reverts if src is specified and sender does not have permission', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob, charlie] } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    const cometAsC = comet.connect(charlie);

    await expect(cometAsC.withdrawFrom(bob.address, alice.address, compAddress, 7))
      .to.be.revertedWithCustomError(comet, 'Unauthorized');
  });

  it('reverts if withdraw is paused', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [alice, bob, charlie] } = protocol;
    const { COMP } = tokens;
    const cometAddress = await comet.getAddress();
    const compAddress = await COMP.getAddress();

    await COMP.allocateTo(cometAddress, 7);
    const cometAsB = comet.connect(bob);
    const cometAsC = comet.connect(charlie);

    // Pause withdraw
    await wait(comet.connect(pauseGuardian).pause(false, false, true, false, false));
    expect(await comet.isWithdrawPaused()).to.be.true;

    await wait(cometAsB.allow(charlie.address, true));
    await expect(cometAsC.withdrawFrom(bob.address, alice.address, compAddress, 7))
      .to.be.revertedWithCustomError(comet, 'Paused');
  });
});
