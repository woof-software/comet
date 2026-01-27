import { EvilToken, EvilToken__factory, FaucetToken, CometHarnessInterface as Comet } from '../build/types';
import { baseBalanceOf, ethers, event, expect, exp, makeProtocol, Protocol, ReentryAttack, setTotalsBasic, wait, fastForward } from './helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers';

describe('withdraw', function () {
  describe('lenders', function () {
    let protocol: Protocol;
    let comet: Comet;
    let tokens: Protocol['tokens'];
    let pauseGuardian: SignerWithAddress;
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let USDC: FaucetToken;
    let WETH: FaucetToken;
    let COMP: FaucetToken;
    let snapshot: SnapshotRestorer;

    before(async () => {
      protocol = await makeProtocol({ base: 'USDC' });
      comet = protocol.comet;
      tokens = protocol.tokens;
      pauseGuardian = protocol.pauseGuardian;
      [alice, bob] = protocol.users;
      USDC = tokens.USDC as FaucetToken;
      WETH = tokens.WETH as FaucetToken;
      COMP = tokens.COMP as FaucetToken;
    });

    beforeEach(async () => {
      snapshot = await takeSnapshot();
    });

    afterEach(async () => {
      await snapshot.restore();
    });

    describe('happy cases', function () {
      it('withdraws base from sender if the asset is base', async () => {
        await USDC.allocateTo(bob.address, 100e6);
        await USDC.connect(bob).approve(comet.address, 100e6);
        await comet.connect(bob).supply(USDC.address, 100e6);

        expect(await comet.balanceOf(bob.address)).to.equal(exp(100, 6));
        const aliceUsdcBefore = await USDC.balanceOf(alice.address);

        await comet.connect(bob).withdrawTo(alice.address, USDC.address, 100e6);

        expect(await comet.balanceOf(bob.address)).to.equal(0);
        expect(await USDC.balanceOf(alice.address)).to.equal(aliceUsdcBefore.add(100e6));
        const t1 = await comet.totalsBasic();
        expect(t1.totalSupplyBase).to.equal(0n);
        expect(t1.totalBorrowBase).to.equal(0n);
      });

      it('withdraws base from sender if the asset is base: events', async () => {
        await USDC.allocateTo(bob.address, 100e6);
        await USDC.connect(bob).approve(comet.address, 100e6);
        await comet.connect(bob).supply(USDC.address, 100e6);

        const s0 = await wait(comet.connect(bob).withdrawTo(alice.address, USDC.address, 100e6));

        expect(event(s0, 0)).to.be.deep.equal({
          Transfer: {
            from: comet.address,
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
            to: ethers.constants.AddressZero,
            amount: BigInt(100e6),
          }
        });
        expect(Number(s0.receipt.gasUsed)).to.be.lessThan(106000);
      });

      it('withdraws max base balance (including accrued) from sender if the asset is base', async () => {
        await USDC.allocateTo(bob.address, 100e6);
        await USDC.connect(bob).approve(comet.address, 100e6);
        await comet.connect(bob).supply(USDC.address, 100e6);

        await WETH.allocateTo(alice.address, exp(10, 18));
        await WETH.connect(alice).approve(comet.address, exp(10, 18));
        await comet.connect(alice).supply(WETH.address, exp(10, 18));
        await comet.connect(alice).withdraw(USDC.address, 50e6);

        await USDC.allocateTo(comet.address, 60e6);

        await fastForward(86400);
        await ethers.provider.send('evm_mine', []);

        const bobAccruedBalance = (await comet.callStatic.balanceOf(bob.address)).toBigInt();
        expect(bobAccruedBalance).to.be.gt(exp(100, 6)); // Interest accrued

        const aliceUsdcBefore = await USDC.balanceOf(alice.address);
        await comet.connect(bob).withdrawTo(alice.address, USDC.address, ethers.constants.MaxUint256);

        expect(await comet.balanceOf(bob.address)).to.equal(0);
        expect(await USDC.balanceOf(alice.address)).to.equal(aliceUsdcBefore.add(bobAccruedBalance));
      });

      it('withdraw max base should withdraw 0 if user has a borrow position', async () => {
        await comet.setBasePrincipal(bob.address, -100e6);
        await comet.setCollateralBalance(bob.address, WETH.address, exp(1, 18));

        const t0 = await comet.totalsBasic();
        const aliceUsdcBefore = await USDC.balanceOf(alice.address);
        const s0 = await wait(comet.connect(bob).withdrawTo(alice.address, USDC.address, ethers.constants.MaxUint256));
        const t1 = await comet.totalsBasic();

        expect(s0.receipt['events'].length).to.be.equal(2);
        expect(event(s0, 0)).to.be.deep.equal({
          Transfer: {
            from: comet.address,
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

        expect(await USDC.balanceOf(alice.address)).to.equal(aliceUsdcBefore);
        expect(t1.totalSupplyBase).to.equal(t0.totalSupplyBase);
        expect(t1.totalBorrowBase).to.equal(t0.totalBorrowBase);
        expect(Number(s0.receipt.gasUsed)).to.be.lessThan(121000);
      });

      it('withdraws collateral from sender if the asset is collateral', async () => {
        await COMP.allocateTo(bob.address, 8e8);
        await COMP.connect(bob).approve(comet.address, 8e8);
        await comet.connect(bob).supply(COMP.address, 8e8);

        const aliceCompBefore = await COMP.balanceOf(alice.address);
        const s0 = await wait(comet.connect(bob).withdrawTo(alice.address, COMP.address, 8e8));
        const t1 = await comet.totalsCollateral(COMP.address);

        expect(event(s0, 0)).to.be.deep.equal({
          Transfer: {
            from: comet.address,
            to: alice.address,
            amount: BigInt(8e8),
          }
        });
        expect(event(s0, 1)).to.be.deep.equal({
          WithdrawCollateral: {
            src: bob.address,
            to: alice.address,
            asset: COMP.address,
            amount: BigInt(8e8),
          }
        });

        expect(await COMP.balanceOf(alice.address)).to.equal(aliceCompBefore.add(8e8));
        expect(t1.totalSupplyAsset).to.equal(0);
        expect(Number(s0.receipt.gasUsed)).to.be.lessThan(85000);
      });

      it('calculates base principal correctly', async () => {
        await USDC.allocateTo(comet.address, 100e6);
        await setTotalsBasic(comet, {
          baseSupplyIndex: 2e15,
          totalSupplyBase: 50e6, // 100e6 in present value
        });
        await comet.setBasePrincipal(bob.address, 50e6); // 100e6 in present value

        expect(await comet.balanceOf(bob.address)).to.equal(exp(100, 6));

        const aliceUsdcBefore = await USDC.balanceOf(alice.address);
        await comet.connect(bob).withdrawTo(alice.address, USDC.address, 100e6);

        expect(await USDC.balanceOf(alice.address)).to.equal(aliceUsdcBefore.add(100e6));
        expect(await comet.balanceOf(bob.address)).to.equal(0);
      });

      it('withdraws to sender by default', async () => {
        await USDC.allocateTo(bob.address, 100e6);
        await USDC.connect(bob).approve(comet.address, 100e6);
        await comet.connect(bob).supply(USDC.address, 100e6);

        const bobUsdcBefore = await USDC.balanceOf(bob.address);
        expect(await comet.balanceOf(bob.address)).to.equal(exp(100, 6));

        await comet.connect(bob).withdraw(USDC.address, 100e6);

        expect(await comet.balanceOf(bob.address)).to.equal(0);
        expect(await USDC.balanceOf(bob.address)).to.equal(bobUsdcBefore.add(100e6));
      });
    });

    describe('reverts', function () {
      it('reverts if withdrawing base exceeds the total supply', async () => {
        await USDC.allocateTo(comet.address, 100e6);
        await comet.setBasePrincipal(bob.address, 100e6);
        const cometAsB = comet.connect(bob);

        await expect(cometAsB.withdrawTo(alice.address, USDC.address, 100e6)).to.be.reverted;
      });

      it('reverts if withdrawing collateral exceeds the total supply', async () => {
        await COMP.allocateTo(comet.address, 8e8);
        await comet.setCollateralBalance(bob.address, COMP.address, 8e8);
        const cometAsB = comet.connect(bob);

        await expect(cometAsB.withdrawTo(alice.address, COMP.address, 8e8)).to.be.reverted;
      });

      it('reverts if the asset is neither collateral nor base', async () => {
        const { unsupportedToken: USUP } = protocol;

        await USUP.allocateTo(comet.address, 1);
        const cometAsB = comet.connect(bob);

        await expect(cometAsB.withdrawTo(alice.address, USUP.address, 1)).to.be.reverted;
      });

      it('reverts if withdraw is paused', async () => {
        await USDC.allocateTo(comet.address, 1);
        const cometAsB = comet.connect(bob);

        // Pause withdraw
        await comet.connect(pauseGuardian).pause(false, false, true, false, false);
        expect(await comet.isWithdrawPaused()).to.be.true;

        await expect(cometAsB.withdrawTo(alice.address, USDC.address, 1)).to.be.revertedWith("custom error 'Paused()'");
      });

      it('reverts if withdraw max for a collateral asset', async () => {
        await COMP.allocateTo(bob.address, 100e6);
        const cometAsB = comet.connect(bob);

        await expect(cometAsB.withdrawTo(alice.address, COMP.address, ethers.constants.MaxUint256)).to.be.revertedWith("custom error 'InvalidUInt128()'");
      });
    });

    describe('edge-cases', function () {
      it('does not emit Transfer for 0 burn', async () => {
        await USDC.allocateTo(alice.address, 110e6);
        await USDC.connect(alice).approve(comet.address, 110e6);
        await comet.connect(alice).supply(USDC.address, 110e6);

        await WETH.allocateTo(bob.address, exp(1, 18));
        await WETH.connect(bob).approve(comet.address, exp(1, 18));
        await comet.connect(bob).supply(WETH.address, exp(1, 18));

        const s0 = await wait(comet.connect(bob).withdrawTo(alice.address, USDC.address, exp(1, 6)));
        expect(s0.receipt['events'].length).to.be.equal(2);
        expect(event(s0, 0)).to.be.deep.equal({
          Transfer: {
            from: comet.address,
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

      // This demonstrates a weird quirk of the present value/principal value rounding down math.
      it('withdraws 0 but Comet Transfer event amount is 1', async () => {
        await comet.setBasePrincipal(alice.address, 99999992291226);
        await setTotalsBasic(comet, {
          totalSupplyBase: 699999944771920,
          baseSupplyIndex: 1000000131467072,
        });

        const s0 = await wait(comet.connect(alice).withdraw(USDC.address, 0));

        expect(s0.receipt['events'].length).to.be.equal(3);
        expect(event(s0, 0)).to.be.deep.equal({
          Transfer: {
            from: comet.address,
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
            to: ethers.constants.AddressZero,
            amount: 1n,
          }
        });
      });

      it.skip('same block withdrawal may end up in 1 wei less because of the rounding error', async () => {
        // wip
      });
    });
  });

  it('user can withdraw non-less than supplied', async () => {
    const { comet, tokens, users: [alice, bob] } = await makeProtocol({ base: 'USDC' });
    const USDC = tokens.USDC as FaucetToken;
    const WETH = tokens.WETH as FaucetToken;

    const supplyAmount = exp(100, 6);
    await USDC.allocateTo(bob.address, supplyAmount);
    await USDC.connect(bob).approve(comet.address, supplyAmount);
    await comet.connect(bob).supply(USDC.address, supplyAmount);

    await WETH.allocateTo(alice.address, exp(10, 18));
    await WETH.connect(alice).approve(comet.address, exp(10, 18));
    await comet.connect(alice).supply(WETH.address, exp(10, 18));
    await comet.connect(alice).withdraw(USDC.address, exp(50, 6));

    await fastForward(86400);
    await ethers.provider.send('evm_mine', []);

    const balanceAfterAccrual = (await comet.callStatic.balanceOf(bob.address)).toBigInt();
    expect(balanceAfterAccrual).to.be.gte(supplyAmount);

    await USDC.allocateTo(alice.address, exp(60, 6));
    await USDC.connect(alice).approve(comet.address, exp(60, 6));
    await comet.connect(alice).supply(USDC.address, exp(60, 6));

    await comet.connect(bob).withdraw(USDC.address, balanceAfterAccrual);
    const finalBalance = await comet.callStatic.balanceOf(bob.address);
    expect(finalBalance).to.be.equal(0);
  });

  describe('borrowers', function () {
    let protocol: Protocol;
    let comet: Comet;
    let tokens: Protocol['tokens'];
    let pauseGuardian: SignerWithAddress;
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let USDC: FaucetToken;
    let WETH: FaucetToken;
    let snapshot: SnapshotRestorer;

    before(async () => {
      protocol = await makeProtocol({ 
        base: 'USDC',
        baseBorrowMin: exp(1, 6)
      });
      comet = protocol.comet;
      tokens = protocol.tokens;
      pauseGuardian = protocol.pauseGuardian;
      [alice, bob] = protocol.users;
      USDC = tokens.USDC as FaucetToken;
      WETH = tokens.WETH as FaucetToken;
    });

    beforeEach(async () => {
      snapshot = await takeSnapshot();
    });

    afterEach(async () => {
      await snapshot.restore();
    });

    describe('general reverts', function () {
      it('reverts with 0 amount (no base asset supplied)', async () => {
        await comet.setCollateralBalance(alice.address, WETH.address, exp(1, 18));
        
        const s0 = await wait(comet.connect(alice).withdraw(USDC.address, 0));
        expect(event(s0, 0)).to.be.deep.equal({
          Transfer: {
            from: comet.address,
            to: alice.address,
            amount: 0n,
          }
        });
      });

      it("user can't borrow if there is no collateral supplied", async () => {
        await USDC.allocateTo(bob.address, exp(100, 6));
        await USDC.connect(bob).approve(comet.address, exp(100, 6));
        await comet.connect(bob).supply(USDC.address, exp(100, 6));

        await expect(
          comet.connect(alice).withdraw(USDC.address, exp(1, 6))
        ).to.be.revertedWith("custom error 'NotCollateralized()'");
      });

      it("user can't borrow if there is not enough collateral", async () => {
        await USDC.allocateTo(bob.address, exp(100000, 6));
        await USDC.connect(bob).approve(comet.address, exp(100000, 6));
        await comet.connect(bob).supply(USDC.address, exp(100000, 6));
        
        await WETH.allocateTo(alice.address, exp(1, 18));
        await WETH.connect(alice).approve(comet.address, exp(1, 18));
        await comet.connect(alice).supply(WETH.address, exp(1, 18));

        await expect(
          comet.connect(alice).withdraw(USDC.address, exp(10000, 6))
        ).to.be.revertedWith("custom error 'NotCollateralized()'");
      });

      it("user can't borrow less than minBorrow", async () => {
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

      it('reverts if collateral withdraw amount is not collateralized', async () => {
        const totalsCollateral = Object.assign({}, await comet.totalsCollateral(WETH.address), {
          totalSupplyAsset: exp(1, 18),
        });
        await comet.setTotalsCollateral(WETH.address, totalsCollateral);

        await comet.setBasePrincipal(alice.address, -100e6);
        await comet.setCollateralBalance(alice.address, WETH.address, exp(1, 18));

        await expect(
          comet.connect(alice).withdraw(WETH.address, exp(1, 18))
        ).to.be.revertedWith("custom error 'NotCollateralized()'");
      });

      it('reverts if withdraw is paused', async () => {
        await USDC.allocateTo(comet.address, 100e6);
        const cometAsB = comet.connect(bob);

        await comet.connect(pauseGuardian).pause(false, false, true, false, false);
        expect(await comet.isWithdrawPaused()).to.be.true;

        await expect(cometAsB.withdraw(USDC.address, 100e6)).to.be.revertedWith("custom error 'Paused()'");
      });
    });

    describe('happy cases', function () {
      it('principal from the 1st borrow equals to the requested amount', async () => {
        await USDC.allocateTo(bob.address, exp(100, 6));
        await USDC.connect(bob).approve(comet.address, exp(100, 6));
        await comet.connect(bob).supply(USDC.address, exp(100, 6));
        
        await WETH.allocateTo(alice.address, exp(1, 18));
        await WETH.connect(alice).approve(comet.address, exp(1, 18));
        await comet.connect(alice).supply(WETH.address, exp(1, 18));

        const borrowAmount = exp(10, 6);
        await comet.connect(alice).withdraw(USDC.address, borrowAmount);

        const aliceBalance = await baseBalanceOf(comet, alice.address);
        expect(aliceBalance).to.equal(-borrowAmount);
      });

      it('principal from the next borrow is re-calculated based on the index', async () => {
        await USDC.allocateTo(comet.address, exp(1000, 6));
        await setTotalsBasic(comet, {
          totalSupplyBase: exp(1000, 6),
          baseBorrowIndex: exp(1, 15), // 1.0
        });

        await comet.setCollateralBalance(alice.address, WETH.address, exp(10, 18));
        const totalsCollateral = Object.assign({}, await comet.totalsCollateral(WETH.address), {
          totalSupplyAsset: exp(10, 18),
        });
        await comet.setTotalsCollateral(WETH.address, totalsCollateral);

        const borrowAmount1 = exp(100, 6);
        await comet.connect(alice).withdraw(USDC.address, borrowAmount1);
        const balance1 = await baseBalanceOf(comet, alice.address);
        expect(balance1).to.equal(-borrowAmount1);

        await setTotalsBasic(comet, {
          baseBorrowIndex: exp(1.1, 15), // 1.1 (10% increase)
          totalBorrowBase: exp(100, 6),
        });

        const borrowAmount2 = exp(50, 6);
        await comet.connect(alice).withdraw(USDC.address, borrowAmount2);

        const finalBalance = await baseBalanceOf(comet, alice.address);
        // With rounding it should be approximately -160e6
        expect(finalBalance).to.be.lt(-exp(159, 6));
        expect(finalBalance).to.be.gt(-exp(161, 6));
      });

      it('borrows to withdraw if necessary/possible', async () => {
        await USDC.allocateTo(bob.address, exp(10, 6));
        await USDC.connect(bob).approve(comet.address, exp(10, 6));
        await comet.connect(bob).supply(USDC.address, exp(10, 6));

        await WETH.allocateTo(alice.address, exp(1, 18));
        await WETH.connect(alice).approve(comet.address, exp(1, 18));
        await comet.connect(alice).supply(WETH.address, exp(1, 18));

        const bobUsdcBefore = await USDC.balanceOf(bob.address);
        await comet.connect(alice).withdrawTo(bob.address, USDC.address, 1e6);

        expect(await baseBalanceOf(comet, alice.address)).to.eq(BigInt(-1e6));
        expect(await USDC.balanceOf(bob.address)).to.eq(bobUsdcBefore.add(1e6));
      });
    });
  });
});

describe('withdraw', function () {
  it('withdraws to sender by default', async () => {
    const { comet, tokens, users: [bob] } = await makeProtocol({ base: 'USDC' });
    const USDC = tokens.USDC as FaucetToken;

    await USDC.allocateTo(bob.address, 100e6);
    await USDC.connect(bob).approve(comet.address, 100e6);
    await comet.connect(bob).supply(USDC.address, 100e6);

    expect(await comet.balanceOf(bob.address)).to.equal(exp(100, 6));
    expect(await USDC.balanceOf(bob.address)).to.equal(0);

    await comet.connect(bob).withdraw(USDC.address, 100e6);

    expect(await comet.balanceOf(bob.address)).to.equal(0);
    expect(await USDC.balanceOf(bob.address)).to.equal(exp(100, 6));
  });

  it('reverts if withdraw is paused', async () => {
    const { comet, tokens, pauseGuardian, users: [bob] } = await makeProtocol({ base: 'USDC' });
    const USDC = tokens.USDC as FaucetToken;
    const cometAsB = comet.connect(bob);

    // Pause withdraw
    await comet.connect(pauseGuardian).pause(false, false, true, false, false);
    expect(await comet.isWithdrawPaused()).to.be.true;

    await expect(cometAsB.withdraw(USDC.address, 100e6)).to.be.revertedWith("custom error 'Paused()'");
  });

  describe('reentrancy', function () {
    it('blocks malicious reentrant transferFrom', async () => {
      const { comet, tokens, users: [alice, bob] } = await makeProtocol({
        assets: {
          USDC: {
            decimals: 6
          },
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

      const totalsCollateral = Object.assign({}, await comet.totalsCollateral(EVIL.address), {
        totalSupplyAsset: 100e6,
      });
      await comet.setTotalsCollateral(EVIL.address, totalsCollateral);

      await comet.setCollateralBalance(alice.address, EVIL.address, exp(1, 6));
      await comet.connect(alice).allow(EVIL.address, true);

      // In callback, EVIL token calls transferFrom(alice.address, bob.address, 1e6)
      await expect(
        comet.connect(alice).withdraw(EVIL.address, 1e6)
      ).to.be.revertedWithCustomError(comet, 'ReentrantCallBlocked');

      // no USDC transferred
      expect(await USDC.balanceOf(comet.address)).to.eq(100e6);
      expect(await baseBalanceOf(comet, alice.address)).to.eq(0n);
      expect(await USDC.balanceOf(alice.address)).to.eq(0);
      expect(await baseBalanceOf(comet, bob.address)).to.eq(0n);
      expect(await USDC.balanceOf(bob.address)).to.eq(0);
    });

    it('blocks malicious reentrant withdrawFrom', async () => {
      const { comet, tokens, users: [alice, bob] } = await makeProtocol({
        assets: {
          USDC: {
            decimals: 6
          },
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

      const totalsCollateral = Object.assign({}, await comet.totalsCollateral(EVIL.address), {
        totalSupplyAsset: 100e6,
      });
      await comet.setTotalsCollateral(EVIL.address, totalsCollateral);

      await comet.setCollateralBalance(alice.address, EVIL.address, exp(1, 6));

      await comet.connect(alice).allow(EVIL.address, true);

      // in callback, EvilToken attempts to withdraw USDC to bob's address
      await expect(
        comet.connect(alice).withdraw(EVIL.address, 1e6)
      ).to.be.revertedWithCustomError(comet, 'ReentrantCallBlocked');

      // no USDC transferred
      expect(await USDC.balanceOf(comet.address)).to.eq(100e6);
      expect(await baseBalanceOf(comet, alice.address)).to.eq(0n);
      expect(await USDC.balanceOf(alice.address)).to.eq(0);
      expect(await baseBalanceOf(comet, bob.address)).to.eq(0n);
      expect(await USDC.balanceOf(bob.address)).to.eq(0);
    });
  });
});

describe('withdrawFrom', function () {
  it('withdraws from src if specified and sender has permission', async () => {
    const { comet, tokens, users: [alice, bob, charlie] } = await makeProtocol();
    const COMP = tokens.COMP as FaucetToken;

    await COMP.allocateTo(comet.address, 7);
    const t0 = Object.assign({}, await comet.totalsCollateral(COMP.address), {
      totalSupplyAsset: 7,
    });
    await comet.setTotalsCollateral(COMP.address, t0);
    await comet.setCollateralBalance(bob.address, COMP.address, 7);

    expect((await comet.userCollateral(bob.address, COMP.address)).balance).to.equal(7);
    expect(await COMP.balanceOf(alice.address)).to.equal(0);

    await comet.connect(bob).allow(charlie.address, true);
    await comet.connect(charlie).withdrawFrom(bob.address, alice.address, COMP.address, 7);

    expect((await comet.userCollateral(bob.address, COMP.address)).balance).to.equal(0);
    expect(await COMP.balanceOf(alice.address)).to.equal(7);
  });

  it('reverts if src is specified and sender does not have permission', async () => {
    const { comet, tokens, users: [alice, bob, charlie] } = await makeProtocol();
    const COMP = tokens.COMP as FaucetToken;

    await expect(comet.connect(charlie).withdrawFrom(bob.address, alice.address, COMP.address, 7))
      .to.be.revertedWith("custom error 'Unauthorized()'");
  });

  it('reverts if withdraw is paused', async () => {
    const { comet, tokens, pauseGuardian, users: [alice, bob, charlie] } = await makeProtocol();
    const COMP = tokens.COMP as FaucetToken;

    await COMP.allocateTo(comet.address, 7);

    // Pause withdraw
    await comet.connect(pauseGuardian).pause(false, false, true, false, false);
    expect(await comet.isWithdrawPaused()).to.be.true;

    await comet.connect(bob).allow(charlie.address, true);
    await expect(comet.connect(charlie).withdrawFrom(bob.address, alice.address, COMP.address, 7))
      .to.be.revertedWith("custom error 'Paused()'");
  });
});
