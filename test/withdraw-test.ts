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

  afterEach(async () => {
    await baseSnapshot.restore();
    baseSnapshot = await takeSnapshot();
  });

  describe('withdraw base asset', function () {
    describe('reverts', function () {
      it('reverts if withdraw is paused', async () => {
        await comet.connect(pauseGuardian).pause(false, false, true, false, false);
        expect(await comet.isWithdrawPaused()).to.be.true;

        await expect(comet.connect(alice).withdraw(baseToken.address, 1)).to.be.revertedWithCustomError(comet, 'Paused');
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });

      it('reverts if withdrawing base exceeds the total supply (harness - artificial state)', async () => {
        // This tests an edge case where balance > actual tokens in contract
        // Must use harness to create this inconsistent state
        await baseToken.allocateTo(comet.address, 100e6);
        await comet.setBasePrincipal(bob.address, 100e6);

        await expect(comet.connect(bob).withdraw(baseToken.address, 100e6)).to.be.reverted;
      });

      it('reverts if the asset is neither collateral nor base', async () => {
        await unsupportedToken.allocateTo(comet.address, 1);

        await expect(comet.connect(bob).withdraw(unsupportedToken.address, 1)).to.be.reverted;
      });

      it('reverts if withdraw max for a collateral asset', async () => {
        const collateral = collaterals['COMP'];
        await collateral.allocateTo(bob.address, 100e6);

        await expect(
          comet.connect(bob).withdraw(collateral.address, ethers.constants.MaxUint256)
        ).to.be.revertedWith("custom error 'InvalidUInt128()'");
      });
    });

    describe('withdraw base: happy path', function () {
      const SUPPLY_AMOUNT: bigint = exp(100, baseTokenDecimals);

      it('emits Transfer event (ERC20) when withdrawing base', async () => {
        const snapshot = await takeSnapshot();

        await baseToken.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, SUPPLY_AMOUNT);

        await expect(comet.connect(bob).withdrawTo(alice.address, baseToken.address, SUPPLY_AMOUNT))
          .to.emit(baseToken, 'Transfer')
          .withArgs(comet.address, alice.address, SUPPLY_AMOUNT);

        await snapshot.restore();
      });

      it('emits Withdraw event when withdrawing base', async () => {
        const snapshot = await takeSnapshot();

        await baseToken.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, SUPPLY_AMOUNT);

        await expect(comet.connect(bob).withdrawTo(alice.address, baseToken.address, SUPPLY_AMOUNT))
          .to.emit(comet, 'Withdraw')
          .withArgs(bob.address, alice.address, SUPPLY_AMOUNT);

        await snapshot.restore();
      });

      it('emits Transfer event (Comet burn) when withdrawing base', async () => {
        const snapshot = await takeSnapshot();

        await baseToken.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, SUPPLY_AMOUNT);

        await expect(comet.connect(bob).withdrawTo(alice.address, baseToken.address, SUPPLY_AMOUNT))
          .to.emit(comet, 'Transfer')
          .withArgs(bob.address, ethers.constants.AddressZero, SUPPLY_AMOUNT);

        await snapshot.restore();
      });

      it('withdraws base from sender with correct state changes', async () => {
        await baseToken.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(baseToken.address, SUPPLY_AMOUNT);

        const bobBalanceBefore = await baseToken.balanceOf(bob.address);
        const aliceBalanceBefore = await baseToken.balanceOf(alice.address);

        const withdrawTx = await comet.connect(bob).withdrawTo(alice.address, baseToken.address, SUPPLY_AMOUNT);
        const receipt = await withdrawTx.wait();

        expect(await comet.balanceOf(bob.address)).to.equal(0);
        expect(await baseToken.balanceOf(alice.address)).to.equal(aliceBalanceBefore.add(SUPPLY_AMOUNT));
        expect(await baseToken.balanceOf(bob.address)).to.equal(bobBalanceBefore);

        const t1 = await comet.totalsBasic();
        expect(t1.totalSupplyBase).to.equal(0n);
        expect(t1.totalBorrowBase).to.equal(0n);
        expect(Number(receipt.gasUsed)).to.be.lessThan(106000);
      });
    });

    describe('withdraw max base', function () {
      it('withdraws max base balance (including accrued) from sender', async () => {
        await baseToken.connect(bob).approve(comet.address, 100e6);
        await comet.connect(bob).supply(baseToken.address, 100e6);

        await collaterals['WETH'].allocateTo(alice.address, exp(10, 18));
        await collaterals['WETH'].connect(alice).approve(comet.address, exp(10, 18));
        await comet.connect(alice).supply(collaterals['WETH'].address, exp(10, 18));
        await comet.connect(alice).withdraw(baseToken.address, 50e6);

        await baseToken.allocateTo(comet.address, 60e6);

        await fastForward(86400);
        await ethers.provider.send('evm_mine', []);

        const bobAccruedBalance = (await comet.callStatic.balanceOf(bob.address)).toBigInt();
        expect(bobAccruedBalance).to.be.gt(exp(100, 6));

        const aliceUsdcBefore = await baseToken.balanceOf(alice.address);
        await comet.connect(bob).withdrawTo(alice.address, baseToken.address, ethers.constants.MaxUint256);

        expect(await comet.balanceOf(bob.address)).to.equal(0);
        expect(await baseToken.balanceOf(alice.address)).to.equal(aliceUsdcBefore.add(bobAccruedBalance));
      });

      it('withdraw max base should withdraw 0 if user has a borrow position', async () => {
        await baseToken.connect(alice).approve(comet.address, exp(200, 6));
        await comet.connect(alice).supply(baseToken.address, exp(200, 6));

        await collaterals['WETH'].allocateTo(bob.address, exp(1, 18));
        await collaterals['WETH'].connect(bob).approve(comet.address, exp(1, 18));
        await comet.connect(bob).supply(collaterals['WETH'].address, exp(1, 18));
        await comet.connect(bob).withdraw(baseToken.address, 100e6);

        const charlieUsdcBefore = await baseToken.balanceOf(alice.address);
        const tx = await comet.connect(bob).withdrawTo(alice.address, baseToken.address, ethers.constants.MaxUint256);
        const receipt = await tx.wait();

        expect(receipt.events.length).to.be.equal(2);
        expect(event({ receipt }, 0)).to.be.deep.equal({
          Transfer: { from: comet.address, to: alice.address, amount: 0n }
        });
        expect(event({ receipt }, 1)).to.be.deep.equal({
          Withdraw: { src: bob.address, to: alice.address, amount: 0n }
        });

        expect(await baseToken.balanceOf(alice.address)).to.equal(charlieUsdcBefore);
        expect(Number(receipt.gasUsed)).to.be.lessThan(121000);
      });

      it('user can withdraw non-less than supplied (accrued interest)', async () => {
        const supplyAmount = exp(100, 6);
        await baseToken.connect(bob).approve(comet.address, supplyAmount);
        await comet.connect(bob).supply(baseToken.address, supplyAmount);

        await collaterals['WETH'].allocateTo(alice.address, exp(10, 18));
        await collaterals['WETH'].connect(alice).approve(comet.address, exp(10, 18));
        await comet.connect(alice).supply(collaterals['WETH'].address, exp(10, 18));
        await comet.connect(alice).withdraw(baseToken.address, exp(50, 6));

        await fastForward(86400);
        await ethers.provider.send('evm_mine', []);

        const balanceAfterAccrual = (await comet.callStatic.balanceOf(bob.address)).toBigInt();
        expect(balanceAfterAccrual).to.be.gte(supplyAmount);

        await baseToken.allocateTo(alice.address, exp(60, 6));
        await baseToken.connect(alice).approve(comet.address, exp(60, 6));
        await comet.connect(alice).supply(baseToken.address, exp(60, 6));

        await comet.connect(bob).withdraw(baseToken.address, balanceAfterAccrual);
        const finalBalance = await comet.callStatic.balanceOf(bob.address);
        expect(finalBalance).to.be.equal(0);
      });
    });

    describe('withdraw with index calculation', function () {
      it('calculates base principal correctly (index math test)', async () => {
        // Harness: need exact index=2e15 to test principal*index math, can't achieve naturally
        await baseToken.allocateTo(comet.address, 100e6);
        await setTotalsBasic(comet, {
          baseSupplyIndex: 2e15,
          totalSupplyBase: 50e6,
        });
        await comet.setBasePrincipal(bob.address, 50e6);

        expect(await comet.balanceOf(bob.address)).to.equal(exp(100, 6));

        const aliceUsdcBefore = await baseToken.balanceOf(alice.address);
        await comet.connect(bob).withdrawTo(alice.address, baseToken.address, 100e6);

        expect(await baseToken.balanceOf(alice.address)).to.equal(aliceUsdcBefore.add(100e6));
        expect(await comet.balanceOf(bob.address)).to.equal(0);
      });
    });

    describe('edge cases', function () {
      it('does not emit Transfer for 0 burn', async () => {
        await baseToken.connect(alice).approve(comet.address, 110e6);
        await comet.connect(alice).supply(baseToken.address, 110e6);

        await collaterals['WETH'].allocateTo(bob.address, exp(1, 18));
        await collaterals['WETH'].connect(bob).approve(comet.address, exp(1, 18));
        await comet.connect(bob).supply(collaterals['WETH'].address, exp(1, 18));

        const tx = await comet.connect(bob).withdrawTo(alice.address, baseToken.address, exp(1, 6));
        const receipt = await tx.wait();

        expect(receipt.events.length).to.be.equal(2);
        expect(event({ receipt }, 0)).to.be.deep.equal({
          Transfer: { from: comet.address, to: alice.address, amount: exp(1, 6) }
        });
        expect(event({ receipt }, 1)).to.be.deep.equal({
          Withdraw: { src: bob.address, to: alice.address, amount: exp(1, 6) }
        });
      });

      it('withdraws 0 but Comet Transfer event amount is 1 (rounding quirk - index math test)', async () => {
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
        await collaterals['WETH'].allocateTo(alice.address, exp(1, 18));
        await collaterals['WETH'].connect(alice).approve(comet.address, exp(1, 18));
        await comet.connect(alice).supply(collaterals['WETH'].address, exp(1, 18));

        const tx = await comet.connect(alice).withdraw(baseToken.address, 0);
        const receipt = await tx.wait();

        expect(event({ receipt }, 0)).to.be.deep.equal({
          Transfer: { from: comet.address, to: alice.address, amount: 0n }
        });
      });
    });
  });

  describe('withdraw collateral', function () {
    describe('reverts', function () {
      it('reverts if withdraw is paused', async () => {
        await comet.connect(pauseGuardian).pause(false, false, true, false, false);
        expect(await comet.isWithdrawPaused()).to.be.true;

        await expect(comet.connect(alice).withdraw(collaterals['COMP'].address, 1)).to.be.revertedWithCustomError(comet, 'Paused');
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });

      it('reverts if withdrawing collateral exceeds the total supply (harness - artificial state)', async () => {
        // This tests an edge case where balance > actual tokens in contract
        // Must use harness to create this inconsistent state
        await collaterals['COMP'].allocateTo(comet.address, 8e8);
        await comet.setCollateralBalance(bob.address, collaterals['COMP'].address, 8e8);

        await expect(comet.connect(bob).withdraw(collaterals['COMP'].address, 8e8)).to.be.reverted;
      });

      it('reverts if collateral withdraw amount is not collateralized', async () => {
        await baseToken.connect(bob).approve(comet.address, exp(200, 6));
        await comet.connect(bob).supply(baseToken.address, exp(200, 6));

        await collaterals['WETH'].allocateTo(alice.address, exp(1, 18));
        await collaterals['WETH'].connect(alice).approve(comet.address, exp(1, 18));
        await comet.connect(alice).supply(collaterals['WETH'].address, exp(1, 18));
        await comet.connect(alice).withdraw(baseToken.address, 100e6);

        await expect(
          comet.connect(alice).withdraw(collaterals['WETH'].address, exp(1, 18))
        ).to.be.revertedWith("custom error 'NotCollateralized()'");
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
      const SUPPLY_AMOUNT: bigint = exp(8, 8);

      it('emits Transfer event (ERC20) when withdrawing collateral', async () => {
        const snapshot = await takeSnapshot();
        const collateral = collaterals['COMP'];

        await collateral.allocateTo(bob.address, SUPPLY_AMOUNT);
        await collateral.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(collateral.address, SUPPLY_AMOUNT);

        await expect(comet.connect(bob).withdrawTo(alice.address, collateral.address, SUPPLY_AMOUNT))
          .to.emit(collateral, 'Transfer')
          .withArgs(comet.address, alice.address, SUPPLY_AMOUNT);

        await snapshot.restore();
      });

      it('emits WithdrawCollateral event when withdrawing collateral', async () => {
        const snapshot = await takeSnapshot();
        const collateral = collaterals['COMP'];

        await collateral.allocateTo(bob.address, SUPPLY_AMOUNT);
        await collateral.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(collateral.address, SUPPLY_AMOUNT);

        await expect(comet.connect(bob).withdrawTo(alice.address, collateral.address, SUPPLY_AMOUNT))
          .to.emit(comet, 'WithdrawCollateral')
          .withArgs(bob.address, alice.address, collateral.address, SUPPLY_AMOUNT);

        await snapshot.restore();
      });

      it('withdraws collateral from sender with correct state changes', async () => {
        const collateral = collaterals['COMP'];

        await collateral.allocateTo(bob.address, SUPPLY_AMOUNT);
        await collateral.connect(bob).approve(comet.address, SUPPLY_AMOUNT);
        await comet.connect(bob).supply(collateral.address, SUPPLY_AMOUNT);

        const aliceBalanceBefore = await collateral.balanceOf(alice.address);

        const withdrawTx = await comet.connect(bob).withdrawTo(alice.address, collateral.address, SUPPLY_AMOUNT);
        const receipt = await withdrawTx.wait();

        expect(await collateral.balanceOf(alice.address)).to.equal(aliceBalanceBefore.add(SUPPLY_AMOUNT));
        const t1 = await comet.totalsCollateral(collateral.address);
        expect(t1.totalSupplyAsset).to.equal(0);

        expect(Number(receipt.gasUsed)).to.be.lessThan(85000);
      });
    });
  });

  describe('borrow (withdraw without supply)', function () {
    describe('reverts', function () {
      it("can't borrow if there is no collateral supplied", async () => {
        await baseToken.connect(bob).approve(comet.address, exp(100, 6));
        await comet.connect(bob).supply(baseToken.address, exp(100, 6));

        await expect(
          comet.connect(alice).withdraw(baseToken.address, exp(1, 6))
        ).to.be.revertedWith("custom error 'NotCollateralized()'");
      });

      it("can't borrow if there is not enough collateral", async () => {
        await baseToken.connect(bob).approve(comet.address, exp(100000, 6));
        await comet.connect(bob).supply(baseToken.address, exp(100000, 6));

        await collaterals['WETH'].allocateTo(alice.address, exp(1, 18));
        await collaterals['WETH'].connect(alice).approve(comet.address, exp(1, 18));
        await comet.connect(alice).supply(collaterals['WETH'].address, exp(1, 18));

        await expect(
          comet.connect(alice).withdraw(baseToken.address, exp(10000, 6))
        ).to.be.revertedWith("custom error 'NotCollateralized()'");
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
        ).to.be.revertedWith("custom error 'BorrowTooSmall()'");
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
      it('principal from the 1st borrow equals to the requested amount', async () => {
        await baseToken.connect(bob).approve(comet.address, exp(100, 6));
        await comet.connect(bob).supply(baseToken.address, exp(100, 6));

        await collaterals['WETH'].allocateTo(alice.address, exp(1, 18));
        await collaterals['WETH'].connect(alice).approve(comet.address, exp(1, 18));
        await comet.connect(alice).supply(collaterals['WETH'].address, exp(1, 18));

        const borrowAmount = exp(10, 6);
        await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

        const aliceBalance = await baseBalanceOf(comet, alice.address);
        expect(aliceBalance).to.equal(-borrowAmount);
      });

      it('principal from the next borrow is re-calculated based on the index (index math test)', async () => {
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
        await baseToken.connect(bob).approve(comet.address, exp(10, 6));
        await comet.connect(bob).supply(baseToken.address, exp(10, 6));

        await collaterals['WETH'].allocateTo(alice.address, exp(1, 18));
        await collaterals['WETH'].connect(alice).approve(comet.address, exp(1, 18));
        await comet.connect(alice).supply(collaterals['WETH'].address, exp(1, 18));

        const bobUsdcBefore = await baseToken.balanceOf(bob.address);
        await comet.connect(alice).withdrawTo(bob.address, baseToken.address, 1e6);

        expect(await baseBalanceOf(comet, alice.address)).to.eq(BigInt(-1e6));
        expect(await baseToken.balanceOf(bob.address)).to.eq(bobUsdcBefore.add(1e6));
      });
    });
  });

  describe('withdrawTo', function () {
    it('withdraws to sender by default', async () => {
      await baseToken.connect(bob).approve(comet.address, 100e6);
      await comet.connect(bob).supply(baseToken.address, 100e6);

      const bobUsdcBefore = await baseToken.balanceOf(bob.address);
      expect(await comet.balanceOf(bob.address)).to.equal(exp(100, 6));

      await comet.connect(bob).withdraw(baseToken.address, 100e6);

      expect(await comet.balanceOf(bob.address)).to.equal(0);
      expect(await baseToken.balanceOf(bob.address)).to.equal(bobUsdcBefore.add(100e6));
    });
  });

  describe('withdrawFrom', function () {
    it('withdraws from src if specified and sender has permission', async () => {
      const charlie = (await ethers.getSigners())[4];
      const supplyAmount = exp(1, 8);

      await collaterals['COMP'].allocateTo(bob.address, supplyAmount);
      await collaterals['COMP'].connect(bob).approve(comet.address, supplyAmount);
      await comet.connect(bob).supply(collaterals['COMP'].address, supplyAmount);

      const aliceBalanceBefore = await collaterals['COMP'].balanceOf(alice.address);
      expect((await comet.userCollateral(bob.address, collaterals['COMP'].address)).balance).to.equal(supplyAmount);

      await comet.connect(bob).allow(charlie.address, true);
      await comet.connect(charlie).withdrawFrom(bob.address, alice.address, collaterals['COMP'].address, supplyAmount);

      expect((await comet.userCollateral(bob.address, collaterals['COMP'].address)).balance).to.equal(0);
      expect(await collaterals['COMP'].balanceOf(alice.address)).to.equal(aliceBalanceBefore.add(supplyAmount));
    });

    it('reverts if src is specified and sender does not have permission', async () => {
      const charlie = (await ethers.getSigners())[4];

      await expect(
        comet.connect(charlie).withdrawFrom(bob.address, alice.address, collaterals['COMP'].address, 7)
      ).to.be.revertedWith("custom error 'Unauthorized()'");
    });

    it('reverts if withdraw is paused', async () => {
      const charlie = (await ethers.getSigners())[4];

      await collaterals['COMP'].allocateTo(comet.address, 7);

      await comet.connect(pauseGuardian).pause(false, false, true, false, false);
      expect(await comet.isWithdrawPaused()).to.be.true;

      await comet.connect(bob).allow(charlie.address, true);
      await expect(
        comet.connect(charlie).withdrawFrom(bob.address, alice.address, collaterals['COMP'].address, 7)
      ).to.be.revertedWith("custom error 'Paused()'");

      await comet.connect(pauseGuardian).pause(false, false, false, false, false);
    });
  });

  describe('reentrancy protection', function () {
    it('blocks malicious reentrant transferFrom', async () => {
      const { comet, tokens, users: [alice, bob] } = await makeProtocol({
        assets: {
          USDC: { decimals: 6 },
          EVIL: {
            decimals: 6,
            initialPrice: 2,
            factory: await ethers.getContractFactory('EvilToken') as EvilToken__factory,
          }
        }
      });
      const { USDC, EVIL } = <{ USDC: FaucetToken, EVIL: EvilToken }>tokens;

      await USDC.allocateTo(comet.address, 100e6);

      const attack = Object.assign({}, await EVIL.getAttack(), {
        attackType: ReentryAttack.TransferFrom,
        destination: bob.address,
        asset: USDC.address,
        amount: 1e6
      });
      await EVIL.setAttack(attack);

      // Harness: EvilToken can't be supplied normally - it's malicious and triggers reentrancy
      const totalsCollateral = Object.assign({}, await comet.totalsCollateral(EVIL.address), {
        totalSupplyAsset: 100e6,
      });
      await comet.setTotalsCollateral(EVIL.address, totalsCollateral);
      await comet.setCollateralBalance(alice.address, EVIL.address, exp(1, 6));
      await comet.connect(alice).allow(EVIL.address, true);

      await expect(
        comet.connect(alice).withdraw(EVIL.address, 1e6)
      ).to.be.revertedWithCustomError(comet, 'ReentrantCallBlocked');

      expect(await USDC.balanceOf(comet.address)).to.eq(100e6);
      expect(await baseBalanceOf(comet, alice.address)).to.eq(0n);
      expect(await USDC.balanceOf(bob.address)).to.eq(0);
    });

    it('blocks malicious reentrant withdrawFrom', async () => {
      const { comet, tokens, users: [alice, bob] } = await makeProtocol({
        assets: {
          USDC: { decimals: 6 },
          EVIL: {
            decimals: 6,
            initialPrice: 2,
            factory: await ethers.getContractFactory('EvilToken') as EvilToken__factory,
          }
        }
      });
      const { USDC, EVIL } = <{ USDC: FaucetToken, EVIL: EvilToken }>tokens;

      await USDC.allocateTo(comet.address, 100e6);

      const attack = Object.assign({}, await EVIL.getAttack(), {
        attackType: ReentryAttack.WithdrawFrom,
        destination: bob.address,
        asset: USDC.address,
        amount: 1e6
      });
      await EVIL.setAttack(attack);

      // Harness: EvilToken can't be supplied normally - it's malicious and triggers reentrancy
      const totalsCollateral = Object.assign({}, await comet.totalsCollateral(EVIL.address), {
        totalSupplyAsset: 100e6,
      });
      await comet.setTotalsCollateral(EVIL.address, totalsCollateral);
      await comet.setCollateralBalance(alice.address, EVIL.address, exp(1, 6));
      await comet.connect(alice).allow(EVIL.address, true);

      await expect(
        comet.connect(alice).withdraw(EVIL.address, 1e6)
      ).to.be.revertedWithCustomError(comet, 'ReentrantCallBlocked');

      expect(await USDC.balanceOf(comet.address)).to.eq(100e6);
      expect(await baseBalanceOf(comet, alice.address)).to.eq(0n);
      expect(await USDC.balanceOf(bob.address)).to.eq(0);
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
