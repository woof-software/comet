import { MaxUint256, ZeroAddress } from 'ethers';

import { EvilToken__factory } from '../build/types/index.js';
import type { EvilToken, FaucetToken } from '../build/types/index.js';
import { baseBalanceOf, ethers, event, expect, exp, makeProtocol, portfolio, ReentryAttack, setTotalsBasic, wait, fastForward } from './helpers.js';

describe('withdrawTo', function () {
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
