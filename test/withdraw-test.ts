import { EvilToken, EvilToken__factory, FaucetToken, CometHarnessInterface as Comet } from '../build/types';
import { baseBalanceOf, ethers, event, expect, exp, makeProtocol, portfolio, Protocol, ReentryAttack, setTotalsBasic, wait, fastForward } from './helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

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

    beforeEach(async () => {
      protocol = await makeProtocol({ base: 'USDC' });
      comet = protocol.comet;
      tokens = protocol.tokens;
      pauseGuardian = protocol.pauseGuardian;
      [alice, bob] = protocol.users;
      USDC = tokens.USDC as FaucetToken;
      WETH = tokens.WETH as FaucetToken;
      COMP = tokens.COMP as FaucetToken;
    });

    describe('happy cases', function () {
      it('withdraws base from sender if the asset is base', async () => {
        await USDC.allocateTo(comet.address, 100e6);
        await setTotalsBasic(comet, {
          totalSupplyBase: 100e6,
        });

        await comet.setBasePrincipal(bob.address, 100e6);
        const cometAsB = comet.connect(bob);

        const p0 = await portfolio(protocol, alice.address);
        const q0 = await portfolio(protocol, bob.address);
        const s0 = await wait(cometAsB.withdrawTo(alice.address, USDC.address, 100e6));
        const t1 = await comet.totalsBasic();
        const p1 = await portfolio(protocol, alice.address);
        const q1 = await portfolio(protocol, bob.address);

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

      it('withdraws max base balance (including accrued) from sender if the asset is base', async () => {
        await USDC.allocateTo(comet.address, 110e6);
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
        const bobAccruedBalance = (await comet.callStatic.balanceOf(bob.address)).toBigInt();
        const s0 = await wait(cometAsB.withdrawTo(alice.address, USDC.address, ethers.constants.MaxUint256));
        const t1 = await comet.totalsBasic();
        const a1 = await portfolio(protocol, alice.address);
        const b1 = await portfolio(protocol, bob.address);

        expect(event(s0, 0)).to.be.deep.equal({
          Transfer: {
            from: comet.address,
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
            to: ethers.constants.AddressZero,
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
        await comet.setBasePrincipal(bob.address, -100e6);
        await comet.setCollateralBalance(bob.address, WETH.address, exp(1, 18));
        const cometAsB = comet.connect(bob);

        const t0 = await comet.totalsBasic();
        const a0 = await portfolio(protocol, alice.address);
        const b0 = await portfolio(protocol, bob.address);
        const s0 = await wait(cometAsB.withdrawTo(alice.address, USDC.address, ethers.constants.MaxUint256));
        const t1 = await comet.totalsBasic();
        const a1 = await portfolio(protocol, alice.address);
        const b1 = await portfolio(protocol, bob.address);

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

      it('withdraws collateral from sender if the asset is collateral', async () => {
        await COMP.allocateTo(comet.address, 8e8);
        const t0 = Object.assign({}, await comet.totalsCollateral(COMP.address), {
          totalSupplyAsset: 8e8,
        });
        await wait(comet.setTotalsCollateral(COMP.address, t0));

        await comet.setCollateralBalance(bob.address, COMP.address, 8e8);
        const cometAsB = comet.connect(bob);

        const p0 = await portfolio(protocol, alice.address);
        const q0 = await portfolio(protocol, bob.address);
        const s0 = await wait(cometAsB.withdrawTo(alice.address, COMP.address, 8e8));
        const t1 = await comet.totalsCollateral(COMP.address);
        const p1 = await portfolio(protocol, alice.address);
        const q1 = await portfolio(protocol, bob.address);

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

        expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
        expect(p0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
        expect(q0.internal).to.be.deep.equal({ USDC: 0n, COMP: exp(8, 8), WETH: 0n, WBTC: 0n });
        expect(q0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
        expect(p1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
        expect(p1.external).to.be.deep.equal({ USDC: 0n, COMP: exp(8, 8), WETH: 0n, WBTC: 0n });
        expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
        expect(q1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
        expect(t1.totalSupplyAsset).to.be.equal(0n);
        expect(Number(s0.receipt.gasUsed)).to.be.lessThan(85000);
      });

      it('calculates base principal correctly', async () => {
        await USDC.allocateTo(comet.address, 100e6);
        await setTotalsBasic(comet, {
          baseSupplyIndex: 2e15,
          totalSupplyBase: 50e6, // 100e6 in present value
        });

        await comet.setBasePrincipal(bob.address, 50e6); // 100e6 in present value
        const cometAsB = comet.connect(bob);

        const alice0 = await portfolio(protocol, alice.address);
        const bob0 = await portfolio(protocol, bob.address);

        await wait(cometAsB.withdrawTo(alice.address, USDC.address, 100e6));
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

      it('withdraws to sender by default', async () => {
        await USDC.allocateTo(comet.address, 100e6);
        await setTotalsBasic(comet, {
          totalSupplyBase: 100e6,
        });

        await comet.setBasePrincipal(bob.address, 100e6);
        const cometAsB = comet.connect(bob);

        const q0 = await portfolio(protocol, bob.address);
        await wait(cometAsB.withdraw(USDC.address, 100e6));
        const q1 = await portfolio(protocol, bob.address);

        expect(q0.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
        expect(q0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
        expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
        expect(q1.external).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
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
        await wait(comet.connect(pauseGuardian).pause(false, false, true, false, false));
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
        await USDC.allocateTo(comet.address, 110e6);
        await setTotalsBasic(comet, {
          totalSupplyBase: 100e6,
        });
        await comet.setCollateralBalance(bob.address, WETH.address, exp(1, 18));
        const cometAsB = comet.connect(bob);

        const s0 = await wait(cometAsB.withdrawTo(alice.address, USDC.address, exp(1, 6)));
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
        // TODO: recreate conditions
        // supply from alice
        // catch the Supply event with 0 amount
      });
    });
  });

  // TODO: extend into testcase assuming no illiquidity from over-utilization
  it('user can withdraw non-less than supplied', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { comet, tokens, users: [, bob] } = protocol;
    const USDC = tokens.USDC as FaucetToken;

    const supplyAmount = exp(100, 6);
    // Allocate extra tokens to Comet to cover accrued interest
    await USDC.allocateTo(comet.address, exp(10, 6));
    await USDC.allocateTo(bob.address, supplyAmount);
    await USDC.connect(bob).approve(comet.address, supplyAmount);
    await comet.connect(bob).supply(USDC.address, supplyAmount);

    // Fast forward to accrue some interest
    await setTotalsBasic(comet, {
      totalBorrowBase: exp(50, 6), // need borrows for interest to accrue
    });
    await fastForward(86400);
    await ethers.provider.send('evm_mine', []);

    const balanceAfterAccrual = (await comet.callStatic.balanceOf(bob.address)).toBigInt();
    expect(balanceAfterAccrual).to.be.gte(supplyAmount);

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

    beforeEach(async () => {
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

    describe('general reverts', function () {
      it('reverts with 0 amount (no base asset supplied)', async () => {
        // User has collateral but tries to borrow 0
        await comet.setCollateralBalance(alice.address, WETH.address, exp(1, 18));
        
        // Borrowing 0 should effectively be a no-op but not revert
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
        await USDC.allocateTo(comet.address, exp(100, 6));
        await setTotalsBasic(comet, {
          totalSupplyBase: exp(100, 6),
        });

        await expect(
          comet.connect(alice).withdraw(USDC.address, exp(1, 6))
        ).to.be.revertedWith("custom error 'NotCollateralized()'");
      });

      it("user can't borrow if there is not enough collateral", async () => {
        await USDC.allocateTo(comet.address, exp(100000, 6));
        await setTotalsBasic(comet, {
          totalSupplyBase: exp(100000, 6),
        });
        
        // Supply small amount of collateral (1 WETH @ $3000)
        await comet.setCollateralBalance(alice.address, WETH.address, exp(1, 18));
        const totalsCollateral = Object.assign({}, await comet.totalsCollateral(WETH.address), {
          totalSupplyAsset: exp(1, 18),
        });
        await comet.setTotalsCollateral(WETH.address, totalsCollateral);

        // Try to borrow more than collateral allows (way more than $3000 worth)
        await expect(
          comet.connect(alice).withdraw(USDC.address, exp(10000, 6))
        ).to.be.revertedWith("custom error 'NotCollateralized()'");
      });

      it("user can't borrow less than minBorrow", async () => {
        await USDC.allocateTo(comet.address, exp(100, 6));
        await setTotalsBasic(comet, {
          totalSupplyBase: exp(100, 6),
        });
        
        // Supply collateral
        await comet.setCollateralBalance(alice.address, WETH.address, exp(1, 18));
        const totalsCollateral = Object.assign({}, await comet.totalsCollateral(WETH.address), {
          totalSupplyAsset: exp(1, 18),
        });
        await comet.setTotalsCollateral(WETH.address, totalsCollateral);

        // baseBorrowMin is set to 1e6, try to borrow less
        await expect(
          comet.connect(alice).withdraw(USDC.address, exp(0.5, 6))
        ).to.be.revertedWith("custom error 'BorrowTooSmall()'");
      });

      it('reverts if collateral withdraw amount is not collateralized', async () => {
        const totalsCollateral = Object.assign({}, await comet.totalsCollateral(WETH.address), {
          totalSupplyAsset: exp(1, 18),
        });
        await wait(comet.setTotalsCollateral(WETH.address, totalsCollateral));

        // user has a borrow, but with collateral to cover
        await comet.setBasePrincipal(alice.address, -100e6);
        await comet.setCollateralBalance(alice.address, WETH.address, exp(1, 18));

        // reverts if withdraw would leave borrow uncollateralized
        await expect(
          comet.connect(alice).withdraw(WETH.address, exp(1, 18))
        ).to.be.revertedWith("custom error 'NotCollateralized()'");
      });

      it('reverts if withdraw is paused', async () => {
        await USDC.allocateTo(comet.address, 100e6);
        const cometAsB = comet.connect(bob);

        // Pause withdraw
        await wait(comet.connect(pauseGuardian).pause(false, false, true, false, false));
        expect(await comet.isWithdrawPaused()).to.be.true;

        await expect(cometAsB.withdraw(USDC.address, 100e6)).to.be.revertedWith("custom error 'Paused()'");
      });
    });

    describe('happy cases', function () {
      it('principal from the 1st borrow equals to the requested amount', async () => {
        await USDC.allocateTo(comet.address, exp(100, 6));
        await setTotalsBasic(comet, {
          totalSupplyBase: exp(100, 6),
        });
        
        // Supply collateral
        await comet.setCollateralBalance(alice.address, WETH.address, exp(1, 18));
        const totalsCollateral = Object.assign({}, await comet.totalsCollateral(WETH.address), {
          totalSupplyAsset: exp(1, 18),
        });
        await comet.setTotalsCollateral(WETH.address, totalsCollateral);

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
        
        // Supply collateral
        await comet.setCollateralBalance(alice.address, WETH.address, exp(10, 18));
        const totalsCollateral = Object.assign({}, await comet.totalsCollateral(WETH.address), {
          totalSupplyAsset: exp(10, 18),
        });
        await comet.setTotalsCollateral(WETH.address, totalsCollateral);

        // First borrow
        const borrowAmount1 = exp(100, 6);
        await comet.connect(alice).withdraw(USDC.address, borrowAmount1);
        const balance1 = await baseBalanceOf(comet, alice.address);
        expect(balance1).to.equal(-borrowAmount1);

        // Simulate index increase (interest accrual)
        await setTotalsBasic(comet, {
          baseBorrowIndex: exp(1.1, 15), // 1.1 (10% increase)
          totalBorrowBase: exp(100, 6),
        });

        // Second borrow
        const borrowAmount2 = exp(50, 6);
        await comet.connect(alice).withdraw(USDC.address, borrowAmount2);
        
        // Total owed should be first borrow * 1.1 + second borrow
        // = 100 * 1.1 + 50 = 160
        const finalBalance = await baseBalanceOf(comet, alice.address);
        // With rounding it should be approximately -160e6
        expect(finalBalance).to.be.lt(-exp(159, 6));
        expect(finalBalance).to.be.gt(-exp(161, 6));
      });

      it('borrows to withdraw if necessary/possible', async () => {
        await USDC.allocateTo(comet.address, 1e6);
        await comet.setCollateralBalance(alice.address, WETH.address, exp(1, 18));

        const t0 = await comet.totalsBasic();
        await setTotalsBasic(comet, {
          baseBorrowIndex: t0.baseBorrowIndex.mul(2),
        });

        await comet.connect(alice).withdrawTo(bob.address, USDC.address, 1e6);

        expect(await baseBalanceOf(comet, alice.address)).to.eq(BigInt(-1e6));
        expect(await USDC.balanceOf(bob.address)).to.eq(1e6);
      });
    });
  });
});

describe('withdraw', function () {
  it('withdraws to sender by default', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { comet, tokens, users: [bob] } = protocol;
    const USDC = tokens.USDC as FaucetToken;

    await USDC.allocateTo(comet.address, 100e6);
    await setTotalsBasic(comet, {
      totalSupplyBase: 100e6,
    });

    await comet.setBasePrincipal(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    const q0 = await portfolio(protocol, bob.address);
    await wait(cometAsB.withdraw(USDC.address, 100e6));
    const q1 = await portfolio(protocol, bob.address);

    expect(q0.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.external).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
  });

  it('reverts if withdraw is paused', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { comet, tokens, pauseGuardian, users: [bob] } = protocol;
    const USDC = tokens.USDC as FaucetToken;

    await USDC.allocateTo(comet.address, 100e6);
    const cometAsB = comet.connect(bob);

    // Pause withdraw
    await wait(comet.connect(pauseGuardian).pause(false, false, true, false, false));
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
    const protocol = await makeProtocol();
    const { comet, tokens, users: [alice, bob, charlie] } = protocol;
    const COMP = tokens.COMP as FaucetToken;

    await COMP.allocateTo(comet.address, 7);
    const t0 = Object.assign({}, await comet.totalsCollateral(COMP.address), {
      totalSupplyAsset: 7,
    });
    await wait(comet.setTotalsCollateral(COMP.address, t0));

    await comet.setCollateralBalance(bob.address, COMP.address, 7);

    const cometAsB = comet.connect(bob);
    const cometAsC = comet.connect(charlie);

    await wait(cometAsB.allow(charlie.address, true));
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    await wait(cometAsC.withdrawFrom(bob.address, alice.address, COMP.address, 7));
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
    const { comet, tokens, users: [alice, bob, charlie] } = protocol;
    const COMP = tokens.COMP as FaucetToken;
    const cometAsC = comet.connect(charlie);

    await expect(cometAsC.withdrawFrom(bob.address, alice.address, COMP.address, 7))
      .to.be.revertedWith("custom error 'Unauthorized()'");
  });

  it('reverts if withdraw is paused', async () => {
    const protocol = await makeProtocol();
    const { comet, tokens, pauseGuardian, users: [alice, bob, charlie] } = protocol;
    const COMP = tokens.COMP as FaucetToken;

    await COMP.allocateTo(comet.address, 7);
    const cometAsB = comet.connect(bob);
    const cometAsC = comet.connect(charlie);

    // Pause withdraw
    await wait(comet.connect(pauseGuardian).pause(false, false, true, false, false));
    expect(await comet.isWithdrawPaused()).to.be.true;

    await wait(cometAsB.allow(charlie.address, true));
    await expect(cometAsC.withdrawFrom(bob.address, alice.address, COMP.address, 7)).to.be.revertedWith("custom error 'Paused()'");
  });
});
