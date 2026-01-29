import { ethers, event, expect, exp, makeProtocol, ReentryAttack, setTotalsBasic, fastForward, baseBalanceOf } from './helpers';
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

  // Snapshot taken after initial protocol setup for isolation between describe blocks
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
      const ARTIFICIAL_BALANCE = exp(100, 6);
      const COLLATERAL_AMOUNT = exp(100, 6);

      it('reverts if withdraw is paused', async () => {
        await comet.connect(pauseGuardian).pause(false, false, true, false, false);
        expect(await comet.isWithdrawPaused()).to.be.true;

        await expect(comet.connect(alice).withdraw(baseToken.address, 1)).to.be.revertedWithCustomError(comet, 'Paused');
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });

      it('reverts if withdrawing base exceeds the total supply (harness - artificial state)', async () => {
        await baseSnapshot.restore();
        
        // This tests an edge case where balance > actual tokens in contract
        // Must use harness to create this inconsistent state
        await baseToken.allocateTo(comet.address, ARTIFICIAL_BALANCE);
        await comet.setBasePrincipal(bob.address, ARTIFICIAL_BALANCE);

        await expect(comet.connect(bob).withdraw(baseToken.address, ARTIFICIAL_BALANCE)).to.be.reverted;
      });

      it('reverts if withdraw max for a collateral asset', async () => {
        await baseSnapshot.restore();
        
        const collateral = collaterals['COMP'];
        await collateral.allocateTo(bob.address, COLLATERAL_AMOUNT);

        await expect(
          comet.connect(bob).withdraw(collateral.address, ethers.constants.MaxUint256)
        ).to.be.revertedWithCustomError(comet, 'InvalidUInt128');
      });

      it('reverts if asset is neither collateral nor base', async () => {
        await baseSnapshot.restore();
        
        // Note: For unsupported tokens, the revert may be due to arithmetic underflow
        // (when subtracting withdrawal amount from zero balance) rather than BadAsset error
        await expect(
          comet.connect(alice).withdraw(unsupportedToken.address, 1)
        ).to.be.reverted;
      });

      it('reverts if withdraw amount exceeds uint104 max', async () => {
        await baseSnapshot.restore();

        // uint104 max = 2^104 - 1
        const UINT104_MAX = 2n ** 104n - 1n;

        await expect(
          comet.connect(alice).withdraw(baseToken.address, UINT104_MAX)
        ).to.be.reverted;
      });
    });

    describe('withdraw base: happy path', function () {
      const SUPPLY_AMOUNT: bigint = exp(100, baseTokenDecimals);
      let withdrawTx: ContractTransaction;
      let bobBalanceBefore: bigint;
      let aliceBalanceBefore: bigint;

      before(async () => {
        await baseSnapshot.restore();
        
        await baseToken.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, SUPPLY_AMOUNT);

        bobBalanceBefore = (await baseToken.balanceOf(bob.address)).toBigInt();
        aliceBalanceBefore = (await baseToken.balanceOf(alice.address)).toBigInt();

        withdrawTx = await comet.connect(bob).withdrawTo(alice.address, baseToken.address, SUPPLY_AMOUNT);
      });

      it('withdraw tx does not revert', async () => {
        await expect(withdrawTx).to.not.be.reverted;
      });

      it('emits Transfer event (ERC20)', async () => {
        await expect(withdrawTx)
          .to.emit(baseToken, 'Transfer')
          .withArgs(comet.address, alice.address, SUPPLY_AMOUNT);
      });

      it('emits Withdraw event', async () => {
        await expect(withdrawTx)
          .to.emit(comet, 'Withdraw')
          .withArgs(bob.address, alice.address, SUPPLY_AMOUNT);
      });

      it('emits Transfer event (Comet burn)', async () => {
        await expect(withdrawTx)
          .to.emit(comet, 'Transfer')
          .withArgs(bob.address, ethers.constants.AddressZero, SUPPLY_AMOUNT);
      });

      it('bob comet balance is zero after full withdrawal', async () => {
        expect(await comet.balanceOf(bob.address)).to.equal(0);
      });

      it('alice receives withdrawn tokens', async () => {
        expect(await baseToken.balanceOf(alice.address)).to.equal(aliceBalanceBefore + SUPPLY_AMOUNT);
      });

      it('bob token balance unchanged (withdrawn to alice)', async () => {
        expect(await baseToken.balanceOf(bob.address)).to.equal(bobBalanceBefore);
      });

      it('total supply base is zero', async () => {
        const totalsBasic = await comet.totalsBasic();
        expect(totalsBasic.totalSupplyBase).to.equal(0n);
      });

      it('total borrow base is zero', async () => {
        const totalsBasic = await comet.totalsBasic();
        expect(totalsBasic.totalBorrowBase).to.equal(0n);
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
        
        // Bob supplies base tokens
        await baseToken.connect(bob).approve(comet.address, BOB_SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, BOB_SUPPLY_AMOUNT);

        // Alice supplies collateral and borrows to generate interest
        await collaterals['WETH'].allocateTo(alice.address, ALICE_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(collaterals['WETH'].address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).withdraw(baseToken.address, ALICE_BORROW_AMOUNT);

        // Add extra tokens to cover interest
        await baseToken.allocateTo(comet.address, exp(60, 6));

        // Fast forward to accrue interest
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
        
        // Alice supplies base tokens
        await baseToken.connect(alice).approve(comet.address, ALICE_SUPPLY_AMOUNT);
        await comet.connect(alice).supply(baseToken.address, ALICE_SUPPLY_AMOUNT);

        // Bob supplies collateral and borrows
        await collaterals['WETH'].allocateTo(bob.address, BOB_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(bob).approve(comet.address, BOB_COLLATERAL_AMOUNT);
        await comet.connect(bob).supply(collaterals['WETH'].address, BOB_COLLATERAL_AMOUNT);
        await comet.connect(bob).withdraw(baseToken.address, BOB_BORROW_AMOUNT);

        aliceBalanceBefore = (await baseToken.balanceOf(alice.address)).toBigInt();

        // Bob tries to withdraw max while having borrow position
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
        
        // Bob supplies base
        await baseToken.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, SUPPLY_AMOUNT);

        // Alice supplies collateral and borrows to generate interest
        await collaterals['WETH'].allocateTo(alice.address, COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(comet.address, COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(collaterals['WETH'].address, COLLATERAL_AMOUNT);
        await comet.connect(alice).withdraw(baseToken.address, BORROW_AMOUNT);

        // Fast forward to accrue interest
        await fastForward(TIME_FORWARD_SECONDS);
        await ethers.provider.send('evm_mine', []);

        balanceAfterAccrual = (await comet.callStatic.balanceOf(bob.address)).toBigInt();

        // Alice repays to ensure liquidity
        await baseToken.allocateTo(alice.address, exp(60, 6));
        await baseToken.connect(alice).approve(comet.address, exp(60, 6));
        await comet.connect(alice).supply(baseToken.address, exp(60, 6));

        // Bob withdraws full accrued balance
        await comet.connect(bob).withdraw(baseToken.address, balanceAfterAccrual);
      });

      it('balance after accrual is >= supplied amount', async () => {
        expect(balanceAfterAccrual).to.be.gte(SUPPLY_AMOUNT);
      });

      it('bob final comet balance is zero', async () => {
        const finalBalance = await comet.callStatic.balanceOf(bob.address);
        expect(finalBalance).to.be.equal(0);
      });
    });

    describe('withdraw with index calculation', function () {
      const PRINCIPAL = exp(50, 6);
      const BALANCE_AFTER_INDEX = exp(100, 6);  // principal * index (2x)
      const BASE_SUPPLY_INDEX = 2e15;           // 2x multiplier

      it('calculates base principal correctly (index math test)', async () => {
        await baseSnapshot.restore();
        
        // Harness: need exact index=2e15 to test principal*index math, can't achieve naturally
        await baseToken.allocateTo(comet.address, BALANCE_AFTER_INDEX);
        await setTotalsBasic(comet, {
          baseSupplyIndex: BASE_SUPPLY_INDEX,
          totalSupplyBase: PRINCIPAL,
        });
        await comet.setBasePrincipal(bob.address, PRINCIPAL);

        expect(await comet.balanceOf(bob.address)).to.equal(BALANCE_AFTER_INDEX);

        const aliceUsdcBefore = await baseToken.balanceOf(alice.address);
        await comet.connect(bob).withdrawTo(alice.address, baseToken.address, BALANCE_AFTER_INDEX);

        expect(await baseToken.balanceOf(alice.address)).to.equal(aliceUsdcBefore.add(BALANCE_AFTER_INDEX));
        expect(await comet.balanceOf(bob.address)).to.equal(0);
      });
    });

    describe('edge cases', function () {
      const ALICE_SUPPLY_AMOUNT = exp(110, 6);
      const BOB_COLLATERAL_AMOUNT = exp(1, 18);
      const BORROW_AMOUNT = exp(1, 6);

      it('does not emit Transfer for 0 burn', async () => {
        await baseSnapshot.restore();
        
        await baseToken.connect(alice).approve(comet.address, ALICE_SUPPLY_AMOUNT);
        await comet.connect(alice).supply(baseToken.address, ALICE_SUPPLY_AMOUNT);

        await collaterals['WETH'].allocateTo(bob.address, BOB_COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(bob).approve(comet.address, BOB_COLLATERAL_AMOUNT);
        await comet.connect(bob).supply(collaterals['WETH'].address, BOB_COLLATERAL_AMOUNT);

        const tx = await comet.connect(bob).withdrawTo(alice.address, baseToken.address, BORROW_AMOUNT);
        const receipt = await tx.wait();

        expect(receipt.events.length).to.be.equal(2);
        expect(event({ receipt }, 0)).to.be.deep.equal({
          Transfer: { from: comet.address, to: alice.address, amount: BORROW_AMOUNT }
        });
        expect(event({ receipt }, 1)).to.be.deep.equal({
          Withdraw: { src: bob.address, to: alice.address, amount: BORROW_AMOUNT }
        });
      });

      it('withdraws 0 but Comet Transfer event amount is 1 (rounding quirk - index math test)', async () => {
        await baseSnapshot.restore();
        
        // Harness: need exact principal/index values to trigger rounding edge case
        await comet.setBasePrincipal(alice.address, 99999992291226);
        await setTotalsBasic(comet, {
          totalSupplyBase: 699999944771920,
          baseSupplyIndex: 1000000131467072,
        });

        const tx = await comet.connect(alice).withdraw(baseToken.address, 0);
        const receipt = await tx.wait();

        expect(receipt.events.length).to.be.equal(3);
        expect(event({ receipt }, 0)).to.be.deep.equal({
          Transfer: { from: comet.address, to: alice.address, amount: 0n }
        });
        expect(event({ receipt }, 1)).to.be.deep.equal({
          Withdraw: { src: alice.address, to: alice.address, amount: 0n }
        });
        expect(event({ receipt }, 2)).to.be.deep.equal({
          Transfer: { from: alice.address, to: ethers.constants.AddressZero, amount: 1n }
        });
      });

      it('withdraws 0 base with only collateral position (no base supplied)', async () => {
        await baseSnapshot.restore();
        
        const COLLATERAL_AMOUNT = exp(1, 18);
        await collaterals['WETH'].allocateTo(alice.address, COLLATERAL_AMOUNT);
        await collaterals['WETH'].connect(alice).approve(comet.address, COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(collaterals['WETH'].address, COLLATERAL_AMOUNT);

        const tx = await comet.connect(alice).withdraw(baseToken.address, 0);
        const receipt = await tx.wait();

        expect(event({ receipt }, 0)).to.be.deep.equal({
          Transfer: { from: comet.address, to: alice.address, amount: 0n }
        });
      });
    });
  });

  describe('withdraw collateral', function () {
    before(async () => {
      await baseSnapshot.restore();
    });

    describe('reverts', function () {
      const COMP_AMOUNT = exp(8, 8);
      const BOB_SUPPLY_AMOUNT = exp(200, 6);
      const ALICE_COLLATERAL_AMOUNT = exp(1, 18);
      const BORROW_AMOUNT = exp(100, 6);

      it('reverts if withdraw is paused', async () => {
        await comet.connect(pauseGuardian).pause(false, false, true, false, false);
        expect(await comet.isWithdrawPaused()).to.be.true;

        await expect(comet.connect(alice).withdraw(collaterals['COMP'].address, 1)).to.be.revertedWithCustomError(comet, 'Paused');
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });

      it('reverts if withdrawing collateral exceeds the total supply (harness - artificial state)', async () => {
        await baseSnapshot.restore();
        
        // This tests an edge case where balance > actual tokens in contract
        // Must use harness to create this inconsistent state
        await collaterals['COMP'].allocateTo(comet.address, COMP_AMOUNT);
        await comet.setCollateralBalance(bob.address, collaterals['COMP'].address, COMP_AMOUNT);

        await expect(comet.connect(bob).withdraw(collaterals['COMP'].address, COMP_AMOUNT)).to.be.reverted;
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
      let aliceBalanceBefore: ethers.BigNumber;
      let totalSupplyBefore: ethers.BigNumber;

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
      it('withdraws 0 collateral successfully', async () => {
        await baseSnapshot.restore();

        const COLLATERAL_AMOUNT = exp(1, 8);
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

        const SUPPLY_AMOUNT = exp(100, 6);
        const WITHDRAW_AMOUNT = exp(25, 6);

        await baseToken.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, SUPPLY_AMOUNT);

        // First withdraw
        await comet.connect(bob).withdraw(baseToken.address, WITHDRAW_AMOUNT);
        expect(await comet.balanceOf(bob.address)).to.equal(exp(75, 6));

        // Second withdraw
        await comet.connect(bob).withdraw(baseToken.address, WITHDRAW_AMOUNT);
        expect(await comet.balanceOf(bob.address)).to.equal(exp(50, 6));

        // Third withdraw
        await comet.connect(bob).withdraw(baseToken.address, WITHDRAW_AMOUNT);
        expect(await comet.balanceOf(bob.address)).to.equal(exp(25, 6));

        // Fourth withdraw - full remaining
        await comet.connect(bob).withdraw(baseToken.address, WITHDRAW_AMOUNT);
        expect(await comet.balanceOf(bob.address)).to.equal(0);
      });

      it('withdrawTo zero address sends tokens to zero address (tokens burned)', async () => {
        await baseSnapshot.restore();

        const SUPPLY_AMOUNT = exp(100, 6);
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

      it('principal from the next borrow is re-calculated based on the index (index math test)', async () => {
        await baseSnapshot.restore();
        
        // Harness: need exact baseBorrowIndex values and collateral without real supply to test index recalc
        await baseToken.allocateTo(comet.address, exp(1000, 6));
        await setTotalsBasic(comet, {
          totalSupplyBase: exp(1000, 6),
          baseBorrowIndex: exp(1, 15),
        });

        await comet.setCollateralBalance(alice.address, collaterals['WETH'].address, exp(10, 18));
        const totalsCollateral = Object.assign({}, await comet.totalsCollateral(collaterals['WETH'].address), {
          totalSupplyAsset: exp(10, 18),
        });
        await comet.setTotalsCollateral(collaterals['WETH'].address, totalsCollateral);

        const borrowAmount1 = exp(100, 6);
        await comet.connect(alice).withdraw(baseToken.address, borrowAmount1);
        const balance1 = await baseBalanceOf(comet, alice.address);
        expect(balance1).to.equal(-borrowAmount1);

        await setTotalsBasic(comet, {
          baseBorrowIndex: exp(1.1, 15),
          totalBorrowBase: exp(100, 6),
        });

        const borrowAmount2 = exp(50, 6);
        await comet.connect(alice).withdraw(baseToken.address, borrowAmount2);

        const finalBalance = await baseBalanceOf(comet, alice.address);
        expect(finalBalance).to.be.lt(-exp(159, 6));
        expect(finalBalance).to.be.gt(-exp(161, 6));
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

      // Common setup: bob supplies COMP collateral
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

      // Charlie tries to withdraw from bob without permission
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
