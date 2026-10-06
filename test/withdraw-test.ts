import { EvilToken, EvilToken__factory, FaucetToken, CometHarnessInterfaceExtendedAssetList, SimplePriceFeed } from '../build/types';
import { baseBalanceOf, ethers, event, expect, exp, makeProtocol, portfolio, ReentryAttack, setTotalsBasic, wait, fastForward, TransactionResponseExt } from './helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';

describe('withdrawTo', function () {
  it('withdraws base from sender if the asset is base', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;

    const _i0 = await USDC.allocateTo(comet.address, 100e6);
    await setTotalsBasic(comet, {
      totalSupplyBase: 100e6,
    });

    const _i1 = await comet.setBasePrincipal(bob.address, 100e6);
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

  it('does not emit Transfer for 0 burn', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC, WETH } = tokens;

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

  it('withdraws max base balance (including accrued) from sender if the asset is base', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;

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
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC, WETH } = tokens;

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

  // This demonstrates a weird quirk of the present value/principal value rounding down math.
  it('withdraws 0 but Comet Transfer event amount is 1', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice] } = protocol;
    const { USDC } = tokens;

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

  it('withdraws collateral from sender if the asset is collateral', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { COMP } = tokens;

    const _i0 = await COMP.allocateTo(comet.address, 8e8);
    const t0 = Object.assign({}, await comet.totalsCollateral(COMP.address), {
      totalSupplyAsset: 8e8,
    });
    const _b0 = await wait(comet.setTotalsCollateral(COMP.address, t0));

    const _i1 = await comet.setCollateralBalance(bob.address, COMP.address, 8e8);
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
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(87000);
  });

  it('calculates base principal correctly', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;

    await USDC.allocateTo(comet.address, 100e6);
    const _totals0 = await setTotalsBasic(comet, {
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

  it('reverts if withdrawing base exceeds the total supply', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;

    const _i0 = await USDC.allocateTo(comet.address, 100e6);
    const _i1 = await comet.setBasePrincipal(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    await expect(cometAsB.withdrawTo(alice.address, USDC.address, 100e6)).to.be.reverted;
  });

  it('reverts if withdrawing collateral exceeds the total supply', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { COMP } = tokens;

    const _i0 = await COMP.allocateTo(comet.address, 8e8);
    const _i1 = await comet.setCollateralBalance(bob.address, COMP.address, 8e8);
    const cometAsB = comet.connect(bob);

    await expect(cometAsB.withdrawTo(alice.address, COMP.address, 8e8)).to.be.reverted;
  });

  it('reverts if the asset is neither collateral nor base', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, users: [alice, bob], unsupportedToken: USUP } = protocol;

    const _i0 = await USUP.allocateTo(comet.address, 1);
    const cometAsB = comet.connect(bob);

    await expect(cometAsB.withdrawTo(alice.address, USUP.address, 1)).to.be.reverted;
  });

  it('reverts if withdraw is paused', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [alice, bob] } = protocol;
    const { USDC } = tokens;

    await USDC.allocateTo(comet.address, 1);
    const cometAsB = comet.connect(bob);

    // Pause withdraw
    await wait(comet.connect(pauseGuardian).pause(false, false, true, false, false));
    expect(await comet.isWithdrawPaused()).to.be.true;

    await expect(cometAsB.withdrawTo(alice.address, USDC.address, 1)).to.be.revertedWith("custom error 'Paused()'");
  });

  it('reverts if withdraw max for a collateral asset', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { COMP } = tokens;

    await COMP.allocateTo(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    await expect(cometAsB.withdrawTo(alice.address, COMP.address, ethers.constants.MaxUint256)).to.be.revertedWith("custom error 'InvalidUInt128()'");
  });

  it('borrows to withdraw if necessary/possible', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol();
    const { WETH, USDC } = tokens;

    await USDC.allocateTo(comet.address, 1e6);
    await comet.setCollateralBalance(alice.address, WETH.address, exp(1, 18));

    let t0 = await comet.totalsBasic();
    await setTotalsBasic(comet, {
      baseBorrowIndex: t0.baseBorrowIndex.mul(2),
    });

    await comet.connect(alice).withdrawTo(bob.address, USDC.address, 1e6);

    expect(await baseBalanceOf(comet, alice.address)).to.eq(BigInt(-1e6));
    expect(await USDC.balanceOf(bob.address)).to.eq(1e6);
  });
});

describe('withdraw', function () {
  it('withdraws to sender by default', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [bob] } = protocol;
    const { USDC } = tokens;

    const _i0 = await USDC.allocateTo(comet.address, 100e6);
    const _t0 = await setTotalsBasic(comet, {
      totalSupplyBase: 100e6,
    });

    const _i1 = await comet.setBasePrincipal(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    const q0 = await portfolio(protocol, bob.address);
    const _s0 = await wait(cometAsB.withdraw(USDC.address, 100e6));
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

    await USDC.allocateTo(comet.address, 100e6);
    const cometAsB = comet.connect(bob);

    // Pause withdraw
    await wait(comet.connect(pauseGuardian).pause(false, false, true, false, false));
    expect(await comet.isWithdrawPaused()).to.be.true;

    await expect(cometAsB.withdraw(USDC.address, 100e6)).to.be.revertedWith("custom error 'Paused()'");
  });

  it('reverts if withdraw amount is less than baseBorrowMin', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice] } = await makeProtocol({
      baseBorrowMin: exp(1, 6)
    });
    const { USDC } = tokens;

    await expect(
      comet.connect(alice).withdraw(USDC.address, exp(.5, 6))
    ).to.be.revertedWith("custom error 'BorrowTooSmall()'");
  });

  it('reverts if base withdraw amount is not collateralzed', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice] } = await makeProtocol();
    const { USDC } = tokens;

    await expect(
      comet.connect(alice).withdraw(USDC.address, exp(1, 6))
    ).to.be.revertedWith("custom error 'NotCollateralized()'");
  });

  it('reverts if collateral withdraw amount is not collateralized', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice] } = await makeProtocol();
    const { WETH } = tokens;

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

  describe('reentrancy', function () {
    it('blocks malicious reentrant transferFrom', async () => {
      const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol({
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
      const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol({
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
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob, charlie] } = protocol;
    const { COMP } = tokens;

    const _i0 = await COMP.allocateTo(comet.address, 7);
    const t0 = Object.assign({}, await comet.totalsCollateral(COMP.address), {
      totalSupplyAsset: 7,
    });
    const _b0 = await wait(comet.setTotalsCollateral(COMP.address, t0));

    const _i1 = await comet.setCollateralBalance(bob.address, COMP.address, 7);

    const cometAsB = comet.connect(bob);
    const cometAsC = comet.connect(charlie);

    const _a1 = await wait(cometAsB.allow(charlie.address, true));
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const _s0 = await wait(cometAsC.withdrawFrom(bob.address, alice.address, COMP.address, 7));
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

    const cometAsC = comet.connect(charlie);

    await expect(cometAsC.withdrawFrom(bob.address, alice.address, COMP.address, 7))
      .to.be.revertedWith("custom error 'Unauthorized()'");
  });

  it('reverts if withdraw is paused', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [alice, bob, charlie] } = protocol;
    const { COMP } = tokens;

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

[6, 8, 18].forEach(runMinimumCollateralWithdrawTests);

function runMinimumCollateralWithdrawTests(collateralDecimals: number) {
  describe(`Minimum collateral price and amount withdrawals (${collateralDecimals} decimals)`, function () {
    const WITHDRAW_AMOUNT = 1n;

    type WithdrawState = Record<string, bigint>;
    type AccountPrefix = 'alice' | 'bob';

    interface WithdrawRun {
      before: WithdrawState;
      after: WithdrawState;
      transaction: TransactionResponseExt;
    }

    interface WithdrawCase {
      minimumPrice: bigint;
      control: WithdrawRun;
      minimumPriceRun: WithdrawRun;
    }

    let comet: CometHarnessInterfaceExtendedAssetList;
    let collateral: FaucetToken;
    let base: FaucetToken;
    let priceFeed: SimplePriceFeed;
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let charlie: SignerWithAddress;
    let assetMask: bigint;
    let initialSnapshot: string;

    const snapshot = (): Promise<string> => ethers.provider.send('evm_snapshot', []);
    const revert = (id: string): Promise<boolean> => ethers.provider.send('evm_revert', [id]);
    const toBigInt = (value: { toString(): string }): bigint => BigInt(value.toString());

    async function readAccountState(account: SignerWithAddress): Promise<WithdrawState> {
      const userBasic = await comet.userBasic(account.address);
      const userCollateral = await comet.userCollateral(account.address, collateral.address);
      const liquidatorPoints = await comet.liquidatorPoints(account.address);

      return {
        principal: toBigInt(userBasic.principal),
        baseTrackingIndex: toBigInt(userBasic.baseTrackingIndex),
        baseTrackingAccrued: toBigInt(userBasic.baseTrackingAccrued),
        assetsIn: toBigInt(userBasic.assetsIn),
        userBasicReserved: toBigInt(userBasic._reserved),
        collateralBalance: toBigInt(userCollateral.balance),
        userCollateralReserved: toBigInt(userCollateral._reserved),
        collateralTokenBalance: toBigInt(await collateral.balanceOf(account.address)),
        baseTokenBalance: toBigInt(await base.balanceOf(account.address)),
        liquidatorNumAbsorbs: toBigInt(liquidatorPoints.numAbsorbs),
        liquidatorNumAbsorbed: toBigInt(liquidatorPoints.numAbsorbed),
        liquidatorApproxSpend: toBigInt(liquidatorPoints.approxSpend),
        liquidatorReserved: toBigInt(liquidatorPoints._reserved),
      };
    }

    function prefixState(prefix: string, state: WithdrawState): WithdrawState {
      return Object.fromEntries(
        Object.entries(state).map(([key, value]) => [
          `${prefix}${key[0].toUpperCase()}${key.slice(1)}`,
          value,
        ])
      );
    }

    async function readWithdrawState(): Promise<WithdrawState> {
      const [aliceState, bobState, charlieState, totalsBasic, totalsCollateral] = await Promise.all([
        readAccountState(alice),
        readAccountState(bob),
        readAccountState(charlie),
        comet.totalsBasic(),
        comet.totalsCollateral(collateral.address),
      ]);

      return {
        ...prefixState('alice', aliceState),
        ...prefixState('bob', bobState),
        ...prefixState('charlie', charlieState),
        baseSupplyIndex: toBigInt(totalsBasic.baseSupplyIndex),
        baseBorrowIndex: toBigInt(totalsBasic.baseBorrowIndex),
        trackingSupplyIndex: toBigInt(totalsBasic.trackingSupplyIndex),
        trackingBorrowIndex: toBigInt(totalsBasic.trackingBorrowIndex),
        totalSupplyBase: toBigInt(totalsBasic.totalSupplyBase),
        totalBorrowBase: toBigInt(totalsBasic.totalBorrowBase),
        lastAccrualTime: toBigInt(totalsBasic.lastAccrualTime),
        pauseFlags: toBigInt(totalsBasic.pauseFlags),
        totalSupplyAsset: toBigInt(totalsCollateral.totalSupplyAsset),
        totalsCollateralReserved: toBigInt(totalsCollateral._reserved),
        cometCollateralTokenBalance: toBigInt(await collateral.balanceOf(comet.address)),
        collateralTokenSupply: toBigInt(await collateral.totalSupply()),
        cometBaseTokenBalance: toBigInt(await base.balanceOf(comet.address)),
        baseTokenSupply: toBigInt(await base.totalSupply()),
        baseReserves: toBigInt(await comet.getReserves()),
        collateralReserves: toBigInt(await comet.getCollateralReserves(collateral.address)),
      };
    }

    function stateDiff(run: WithdrawRun): WithdrawState {
      return Object.fromEntries(
        Object.keys(run.before).map((key) => [key, run.after[key] - run.before[key]])
      );
    }

    async function runWithdrawScenario(action: () => Promise<ContractTransaction>): Promise<WithdrawCase> {
      await collateral.allocateTo(comet.address, WITHDRAW_AMOUNT);
      const totalsCollateral = Object.assign({}, await comet.totalsCollateral(collateral.address), {
        totalSupplyAsset: WITHDRAW_AMOUNT,
      });
      await comet.setTotalsCollateral(collateral.address, totalsCollateral);
      await comet.setCollateralBalance(alice.address, collateral.address, WITHDRAW_AMOUNT);

      const scenarioSnapshot = await snapshot();
      const controlBefore = await readWithdrawState();
      const controlTransaction = await wait(action());
      const controlAfter = await readWithdrawState();

      await revert(scenarioSnapshot);

      await priceFeed.setRoundData(0, WITHDRAW_AMOUNT, 0, 0, 0);
      const minimumPrice = toBigInt((await priceFeed.latestRoundData())[1]);
      const minimumPriceBefore = await readWithdrawState();
      const minimumPriceTransaction = await wait(action());
      const minimumPriceAfter = await readWithdrawState();

      return {
        minimumPrice,
        control: {
          before: controlBefore,
          after: controlAfter,
          transaction: controlTransaction,
        },
        minimumPriceRun: {
          before: minimumPriceBefore,
          after: minimumPriceAfter,
          transaction: minimumPriceTransaction,
        },
      };
    }

    async function runNormalPriceWithdrawScenario(
      action: () => Promise<ContractTransaction>,
      collateralBalance: bigint
    ): Promise<WithdrawRun> {
      await collateral.allocateTo(comet.address, collateralBalance);
      const totalsCollateral = Object.assign({}, await comet.totalsCollateral(collateral.address), {
        totalSupplyAsset: collateralBalance,
      });
      await comet.setTotalsCollateral(collateral.address, totalsCollateral);
      await comet.setCollateralBalance(alice.address, collateral.address, collateralBalance);

      const before = await readWithdrawState();
      const transaction = await wait(action());
      const after = await readWithdrawState();

      return { before, after, transaction };
    }

    async function resetFixture() {
      await revert(initialSnapshot);
      initialSnapshot = await snapshot();
    }

    function shouldWithdrawMinimumCollateral(
      destinationPrefix: AccountPrefix,
      destination: () => SignerWithAddress,
      action: () => Promise<ContractTransaction>,
      prepare?: () => Promise<unknown>
    ) {
      context('given the collateral balance is 1', function () {
        let run: WithdrawRun;

        before(async () => {
          if (prepare) await prepare();
          run = await runNormalPriceWithdrawScenario(action, WITHDRAW_AMOUNT);
        });

        after(resetFixture);

        context('when withdrawing 1 raw unit', function () {
          it('sets the balance to 0', async () => {
            expect(run.after.aliceCollateralBalance).to.equal(0n);
          });

          it('clears the membership bit', async () => {
            expect(run.after.aliceAssetsIn & assetMask).to.equal(0n);
          });

          it('decreases totalSupplyAsset by 1', async () => {
            expect(run.after.totalSupplyAsset).to.equal(run.before.totalSupplyAsset - WITHDRAW_AMOUNT);
          });

          it('emits WithdrawCollateral with amount 1', async () => {
            expect(event(run.transaction, 1)).to.deep.equal({
              WithdrawCollateral: {
                src: alice.address,
                to: destination().address,
                asset: collateral.address,
                amount: WITHDRAW_AMOUNT,
              },
            });
          });

          it('debits Comet by exactly 1 raw unit', async () => {
            expect(run.after.cometCollateralTokenBalance).to.equal(run.before.cometCollateralTokenBalance - WITHDRAW_AMOUNT);
          });

          it('credits the recipient by exactly 1 raw unit', async () => {
            const balanceKey = `${destinationPrefix}CollateralTokenBalance`;
            expect(run.after[balanceKey]).to.equal(run.before[balanceKey] + WITHDRAW_AMOUNT);
          });

          it('changes only collateral accounting, membership, and collateral token balances', async () => {
            const expectedDiff = Object.fromEntries(
              Object.keys(run.before).map((key) => [key, 0n])
            ) as WithdrawState;
            expectedDiff.aliceAssetsIn = -assetMask;
            expectedDiff.aliceCollateralBalance = -WITHDRAW_AMOUNT;
            expectedDiff.totalSupplyAsset = -WITHDRAW_AMOUNT;
            expectedDiff.cometCollateralTokenBalance = -WITHDRAW_AMOUNT;
            expectedDiff[`${destinationPrefix}CollateralTokenBalance`] = WITHDRAW_AMOUNT;

            expect(stateDiff(run)).to.deep.equal(expectedDiff);
          });
        });
      });

      context('given the collateral balance is above 1', function () {
        const COLLATERAL_BALANCE = 2n;

        let run: WithdrawRun;

        before(async () => {
          if (prepare) await prepare();
          run = await runNormalPriceWithdrawScenario(action, COLLATERAL_BALANCE);
        });

        after(resetFixture);

        context('when withdrawing 1 raw unit', function () {
          it('decreases the balance by 1', async () => {
            expect(run.after.aliceCollateralBalance).to.equal(COLLATERAL_BALANCE - WITHDRAW_AMOUNT);
          });

          it('keeps the membership bit', async () => {
            // The bit is cleared only on a full exit.
            expect(run.after.aliceAssetsIn & assetMask).to.equal(assetMask);
          });

          it('changes only collateral accounting and collateral token balances', async () => {
            const expectedDiff = Object.fromEntries(
              Object.keys(run.before).map((key) => [key, 0n])
            ) as WithdrawState;
            expectedDiff.aliceCollateralBalance = -WITHDRAW_AMOUNT;
            expectedDiff.totalSupplyAsset = -WITHDRAW_AMOUNT;
            expectedDiff.cometCollateralTokenBalance = -WITHDRAW_AMOUNT;
            expectedDiff[`${destinationPrefix}CollateralTokenBalance`] = WITHDRAW_AMOUNT;

            expect(stateDiff(run)).to.deep.equal(expectedDiff);
          });
        });
      });

      context('when withdrawing a 1 raw unit position priced at 1 without debt', function () {
        let withdrawCase: WithdrawCase;

        before(async () => {
          if (prepare) await prepare();
          withdrawCase = await runWithdrawScenario(action);
        });

        after(resetFixture);

        it('uses the minimum valid collateral price', async () => {
          expect(withdrawCase.minimumPrice).to.equal(1n);
        });

        it('removes 1 raw unit from the source collateral balance', async () => {
          const { before, after } = withdrawCase.minimumPriceRun;
          expect(after.aliceCollateralBalance).to.equal(before.aliceCollateralBalance - WITHDRAW_AMOUNT);
        });

        it('clears the source collateral membership bit', async () => {
          const { before, after } = withdrawCase.minimumPriceRun;
          expect(after.aliceAssetsIn).to.equal(before.aliceAssetsIn & ~assetMask);
        });

        it('decreases total supplied collateral by 1 raw unit', async () => {
          const { before, after } = withdrawCase.minimumPriceRun;
          expect(after.totalSupplyAsset).to.equal(before.totalSupplyAsset - WITHDRAW_AMOUNT);
        });

        it('emits WithdrawCollateral with amount 1', async () => {
          expect(event(withdrawCase.minimumPriceRun.transaction, 1)).to.deep.equal({
            WithdrawCollateral: {
              src: alice.address,
              to: destination().address,
              asset: collateral.address,
              amount: WITHDRAW_AMOUNT,
            },
          });
        });

        it('debits Comet by exactly 1 raw unit', async () => {
          const { before, after } = withdrawCase.minimumPriceRun;
          expect(after.cometCollateralTokenBalance).to.equal(before.cometCollateralTokenBalance - WITHDRAW_AMOUNT);
        });

        it('credits the recipient by exactly 1 raw unit', async () => {
          const { before, after } = withdrawCase.minimumPriceRun;
          const balanceKey = `${destinationPrefix}CollateralTokenBalance`;
          expect(after[balanceKey]).to.equal(before[balanceKey] + WITHDRAW_AMOUNT);
        });

        it('emits the collateral token Transfer', async () => {
          expect(event(withdrawCase.minimumPriceRun.transaction, 0)).to.deep.equal({
            Transfer: {
              from: comet.address,
              to: destination().address,
              amount: WITHDRAW_AMOUNT,
            },
          });
        });

        it('produces the same complete state diff as the normal-price control run', async () => {
          expect(stateDiff(withdrawCase.minimumPriceRun)).to.deep.equal(stateDiff(withdrawCase.control));
        });

        it('changes only collateral accounting, membership, and collateral token balances', async () => {
          const expectedDiff = Object.fromEntries(
            Object.keys(withdrawCase.minimumPriceRun.before).map((key) => [key, 0n])
          ) as WithdrawState;
          expectedDiff.aliceAssetsIn = -assetMask;
          expectedDiff.aliceCollateralBalance = -WITHDRAW_AMOUNT;
          expectedDiff.totalSupplyAsset = -WITHDRAW_AMOUNT;
          expectedDiff.cometCollateralTokenBalance = -WITHDRAW_AMOUNT;
          expectedDiff[`${destinationPrefix}CollateralTokenBalance`] = WITHDRAW_AMOUNT;

          expect(stateDiff(withdrawCase.minimumPriceRun)).to.deep.equal(expectedDiff);
        });
      });
    }

    before(async () => {
      const protocol = await makeProtocol({
        base: 'USDC',
        baseBorrowMin: 0,
        assets: {
          USDC: { decimals: 6, initialPrice: 1 },
          TOKEN: {
            decimals: collateralDecimals,
            initialPrice: 85_000,
            borrowCF: exp(0.8, 18),
            liquidateCF: exp(0.85, 18),
            liquidationFactor: exp(0.9, 18),
            supplyCap: exp(100, collateralDecimals),
          },
        },
      });

      comet = protocol.cometWithExtendedAssetList;
      collateral = protocol.tokens.TOKEN as FaucetToken;
      base = protocol.tokens.USDC as FaucetToken;
      priceFeed = protocol.priceFeeds.TOKEN as SimplePriceFeed;
      [alice, bob, charlie] = protocol.users;

      const assetInfo = await comet.getAssetInfoByAddress(collateral.address);
      assetMask = 1n << toBigInt(assetInfo.offset);
      initialSnapshot = await snapshot();
    });

    after(async () => {
      await revert(initialSnapshot);
    });

    describe('withdraw', function () {
      shouldWithdrawMinimumCollateral(
        'alice',
        () => alice,
        () => comet.connect(alice).withdraw(collateral.address, WITHDRAW_AMOUNT)
      );
    });

    describe('withdrawTo', function () {
      shouldWithdrawMinimumCollateral(
        'bob',
        () => bob,
        () => comet.connect(alice).withdrawTo(bob.address, collateral.address, WITHDRAW_AMOUNT)
      );
    });

    describe('withdrawFrom', function () {
      shouldWithdrawMinimumCollateral(
        'bob',
        () => bob,
        () => comet.connect(charlie).withdrawFrom(alice.address, bob.address, collateral.address, WITHDRAW_AMOUNT),
        () => wait(comet.connect(alice).allow(charlie.address, true))
      );
    });
  });
}

[6, 8, 18].forEach(runMinimumBaseWithdrawTests);

function runMinimumBaseWithdrawTests(baseDecimals: number) {
  describe(`Minimum base amount withdrawals (${baseDecimals} decimals)`, function () {
    const WITHDRAW_AMOUNT = 1n;
    const NORMAL_PRICE = exp(1, 8);
    const MINIMUM_PRICE = 1n;
    const BASE_INDEX_SCALE = exp(1, 15);

    type BaseState = Record<string, bigint>;
    type EventArgs = Record<string, bigint | string>;

    interface BaseRun {
      before: BaseState;
      after: BaseState;
      transaction: TransactionResponseExt;
    }

    let comet: CometHarnessInterfaceExtendedAssetList;
    let base: FaucetToken;
    let basePriceFeed: SimplePriceFeed;
    let alice: SignerWithAddress;
    let now: bigint;
    let initialSnapshot: string;

    const snapshot = (): Promise<string> => ethers.provider.send('evm_snapshot', []);
    const revert = (id: string): Promise<boolean> => ethers.provider.send('evm_revert', [id]);
    const toBigInt = (value: { toString(): string }): bigint => BigInt(value.toString());
    const eventCount = (transaction: TransactionResponseExt): number => transaction.receipt['events'].length;
    const eventArgs = (transaction: TransactionResponseExt, index: number, name: string): EventArgs =>
      (event(transaction, index) as Record<string, EventArgs>)[name];

    async function readBaseState(): Promise<BaseState> {
      const [userBasic, totalsBasic] = await Promise.all([
        comet.userBasic(alice.address),
        comet.totalsBasic(),
      ]);

      return {
        alicePrincipal: toBigInt(userBasic.principal),
        aliceBaseTrackingIndex: toBigInt(userBasic.baseTrackingIndex),
        aliceBaseTrackingAccrued: toBigInt(userBasic.baseTrackingAccrued),
        aliceAssetsIn: toBigInt(userBasic.assetsIn),
        aliceUserBasicReserved: toBigInt(userBasic._reserved),
        aliceBalanceOf: toBigInt(await comet.balanceOf(alice.address)),
        aliceBorrowBalanceOf: toBigInt(await comet.borrowBalanceOf(alice.address)),
        aliceBaseTokenBalance: toBigInt(await base.balanceOf(alice.address)),
        baseSupplyIndex: toBigInt(totalsBasic.baseSupplyIndex),
        baseBorrowIndex: toBigInt(totalsBasic.baseBorrowIndex),
        trackingSupplyIndex: toBigInt(totalsBasic.trackingSupplyIndex),
        trackingBorrowIndex: toBigInt(totalsBasic.trackingBorrowIndex),
        totalSupplyBase: toBigInt(totalsBasic.totalSupplyBase),
        totalBorrowBase: toBigInt(totalsBasic.totalBorrowBase),
        lastAccrualTime: toBigInt(totalsBasic.lastAccrualTime),
        cometBaseTokenBalance: toBigInt(await base.balanceOf(comet.address)),
        baseTokenSupply: toBigInt(await base.totalSupply()),
        baseReserves: toBigInt(await comet.getReserves()),
      };
    }

    function stateDiff(run: BaseRun): BaseState {
      return Object.fromEntries(
        Object.keys(run.before).map((key) => [key, run.after[key] - run.before[key]])
      );
    }

    // Totals mirror the single position, time stays frozen, so withdraw does not accrue (README 3.6)
    async function openSupplyPosition(principal: bigint) {
      await base.allocateTo(comet.address, principal);
      await setTotalsBasic(comet, { totalSupplyBase: principal, lastAccrualTime: now });
      await comet.setBasePrincipal(alice.address, principal);
    }

    // The SB-02 state: 1 raw unit supplied above the initial index, rounded to principal 0
    async function supplyRoundedAway() {
      await setTotalsBasic(comet, { baseSupplyIndex: exp(1.1, 15), lastAccrualTime: now });
      await base.allocateTo(alice.address, WITHDRAW_AMOUNT);
      await base.connect(alice).approve(comet.address, WITHDRAW_AMOUNT);
      await wait(comet.connect(alice).supply(base.address, WITHDRAW_AMOUNT));
    }

    async function runWithdraw(amount: bigint | typeof ethers.constants.MaxUint256): Promise<BaseRun> {
      const before = await readBaseState();
      const transaction = await wait(comet.connect(alice).withdraw(base.address, amount));
      const after = await readBaseState();
      return { before, after, transaction };
    }

    async function resetFixture() {
      await revert(initialSnapshot);
      initialSnapshot = await snapshot();
    }

    before(async () => {
      const protocol = await makeProtocol({
        base: 'USDC',
        baseBorrowMin: 0,
        assets: {
          USDC: { decimals: baseDecimals, initialPrice: 1 },
          TOKEN: { decimals: 18, initialPrice: 1 },
        },
      });

      comet = protocol.cometWithExtendedAssetList;
      base = protocol.tokens.USDC as FaucetToken;
      basePriceFeed = protocol.priceFeeds.USDC as SimplePriceFeed;
      [alice] = protocol.users;

      now = toBigInt(await comet.getNow());
      await comet.setNow(now);
      await setTotalsBasic(comet, { lastAccrualTime: now });

      initialSnapshot = await snapshot();
    });

    after(async () => {
      await revert(initialSnapshot);
    });

    context('given principal is 1 at the initial index', function () {
      let run: BaseRun;

      before(async () => {
        await openSupplyPosition(WITHDRAW_AMOUNT);
        run = await runWithdraw(WITHDRAW_AMOUNT);
      });

      after(resetFixture);

      it('uses the initial base supply index', async () => {
        expect(run.before.baseSupplyIndex).to.equal(BASE_INDEX_SCALE);
      });

      context('when withdrawing 1 raw unit', function () {
        it('sets principal to 0', async () => {
          expect(run.after.alicePrincipal).to.equal(0n);
        });

        it('decreases totalSupplyBase by 1', async () => {
          expect(run.after.totalSupplyBase).to.equal(run.before.totalSupplyBase - WITHDRAW_AMOUNT);
        });

        it('emits Withdraw with amount 1', async () => {
          expect(event(run.transaction, 1)).to.deep.equal({
            Withdraw: {
              src: alice.address,
              to: alice.address,
              amount: WITHDRAW_AMOUNT,
            },
          });
        });

        it('emits Transfer to the zero address with amount 1', async () => {
          expect(event(run.transaction, 2)).to.deep.equal({
            Transfer: {
              from: alice.address,
              to: ethers.constants.AddressZero,
              amount: WITHDRAW_AMOUNT,
            },
          });
        });

        it('debits Comet by exactly 1 raw unit', async () => {
          expect(run.after.cometBaseTokenBalance).to.equal(run.before.cometBaseTokenBalance - WITHDRAW_AMOUNT);
        });

        it('credits the user by exactly 1 raw unit', async () => {
          expect(run.after.aliceBaseTokenBalance).to.equal(run.before.aliceBaseTokenBalance + WITHDRAW_AMOUNT);
        });

        it('leaves no dust in the position', async () => {
          expect(run.after.aliceBalanceOf).to.equal(0n);
          expect(run.after.aliceBorrowBalanceOf).to.equal(0n);
        });

        it('changes only the principal, total supply and base token balances', async () => {
          const expectedDiff = Object.fromEntries(
            Object.keys(run.before).map((key) => [key, 0n])
          ) as BaseState;
          expectedDiff.alicePrincipal = -WITHDRAW_AMOUNT;
          expectedDiff.aliceBalanceOf = -WITHDRAW_AMOUNT;
          expectedDiff.aliceBaseTokenBalance = WITHDRAW_AMOUNT;
          expectedDiff.totalSupplyBase = -WITHDRAW_AMOUNT;
          expectedDiff.cometBaseTokenBalance = -WITHDRAW_AMOUNT;

          expect(stateDiff(run)).to.deep.equal(expectedDiff);
        });
      });
    });

    context('given principal is 0 after a 1 raw unit deposit rounded away', function () {
      let reservesBeforeDeposit: bigint;
      let run: BaseRun;

      before(async () => {
        reservesBeforeDeposit = toBigInt(await comet.getReserves());
        await supplyRoundedAway();
        run = await runWithdraw(ethers.constants.MaxUint256.toBigInt());
      });

      after(resetFixture);

      it('starts from principal 0', async () => {
        expect(run.before.alicePrincipal).to.equal(0n);
      });

      context('when withdrawing the maximum amount', function () {
        it('resolves the amount to 0', async () => {
          // The maximum resolves to balanceOf, which is 0 after the rounded deposit
          expect(run.before.aliceBalanceOf).to.equal(0n);
        });

        it('transfers 0 tokens', async () => {
          expect(eventArgs(run.transaction, 0, 'Transfer').amount).to.equal(0n);
          expect(run.after.aliceBaseTokenBalance).to.equal(run.before.aliceBaseTokenBalance);
        });

        it('still emits Withdraw with amount 0', async () => {
          // The event is emitted unconditionally, unlike the Transfer pair.
          expect(event(run.transaction, 1)).to.deep.equal({
            Withdraw: {
              src: alice.address,
              to: alice.address,
              amount: 0n,
            },
          });
        });

        it('emits no Transfer to the zero address', async () => {
          expect(eventCount(run.transaction)).to.equal(2);
        });

        it('leaves the deposited unit in getReserves', async () => {
          expect(run.after.baseReserves).to.equal(reservesBeforeDeposit + WITHDRAW_AMOUNT);
        });
      });
    });

    context('when withdrawing 1 raw unit at principal 0 after a rounded deposit', function () {
      context('given the base price is 1 and no collateral', function () {
        let run: BaseRun;

        before(async () => {
          await supplyRoundedAway();
          await basePriceFeed.setRoundData(0, MINIMUM_PRICE, 0, 0, 0);
          run = await runWithdraw(WITHDRAW_AMOUNT);
        });

        after(resetFixture);

        it('opens a borrow of 1 instead of returning the deposit', async () => {
          // Links the SB-02 divergence with the BR-04 undervaluation.
          expect(run.after.alicePrincipal).to.equal(-1n);
          expect(run.after.aliceBorrowBalanceOf).to.equal(1n);
        });

        it('pays out the deposited unit as borrowed base', async () => {
          expect(run.after.aliceBaseTokenBalance).to.equal(run.before.aliceBaseTokenBalance + WITHDRAW_AMOUNT);
        });
      });

      context('given the normal base price and no collateral', function () {
        if (baseDecimals < 18) {
          context(`given base decimals are ${baseDecimals}`, function () {
            before(async () => {
              await supplyRoundedAway();
            });

            after(resetFixture);

            it('uses the normal base price', async () => {
              expect(toBigInt(await comet.getPrice(basePriceFeed.address))).to.equal(NORMAL_PRICE);
            });

            it('reverts with NotCollateralized', async () => {
              await expect(
                comet.connect(alice).callStatic.withdraw(base.address, WITHDRAW_AMOUNT)
              ).to.be.revertedWith("custom error 'NotCollateralized()'");
            });
          });
        } else {
          context('given base decimals are 18', function () {
            let run: BaseRun;

            before(async () => {
              await supplyRoundedAway();
              run = await runWithdraw(WITHDRAW_AMOUNT);
            });

            after(resetFixture);

            it('also opens a borrow of 1', async () => {
              // F5 of 1 raw unit truncates to 0 even at the normal price.
              expect(run.after.alicePrincipal).to.equal(-1n);
              expect(run.after.aliceBorrowBalanceOf).to.equal(1n);
            });
          });
        }
      });
    });

    context('given the base price is 1 and principal is positive', function () {
      const PRINCIPAL = 10n;

      let minimumPrice: bigint;
      let minimumPriceRun: BaseRun;
      let sentinelRun: BaseRun;

      before(async () => {
        await openSupplyPosition(PRINCIPAL);

        const scenarioSnapshot = await snapshot();
        await basePriceFeed.setRoundData(0, MINIMUM_PRICE, 0, 0, 0);
        minimumPrice = toBigInt(await comet.getPrice(basePriceFeed.address));
        minimumPriceRun = await runWithdraw(WITHDRAW_AMOUNT);
        await revert(scenarioSnapshot);

        // Sentinel from README 3.4: any read of a 0 answer reverts with BadPrice
        await basePriceFeed.setRoundData(0, 0, 0, 0, 0);
        sentinelRun = await runWithdraw(WITHDRAW_AMOUNT);
      });

      after(resetFixture);

      it('uses the minimum valid base price', async () => {
        expect(minimumPrice).to.equal(MINIMUM_PRICE);
      });

      context('when withdrawing', function () {
        it('succeeds and keeps principal positive', async () => {
          expect(minimumPriceRun.after.alicePrincipal).to.equal(PRINCIPAL - WITHDRAW_AMOUNT);
        });

        it('does not read the base price feed', async () => {
          // Sentinel check from README section 3.4.
          expect(sentinelRun.after.alicePrincipal).to.equal(PRINCIPAL - WITHDRAW_AMOUNT);
        });
      });
    });
  });
}

[6, 8, 18].forEach((baseDecimals) =>
  [6, 8, 18].forEach((collateralDecimals) => runMinimumBorrowTests(baseDecimals, collateralDecimals))
);

function runMinimumBorrowTests(baseDecimals: number, collateralDecimals: number) {
  describe(`Minimum base amount borrows (base ${baseDecimals} decimals, collateral ${collateralDecimals} decimals)`, function () {
    const BORROW_AMOUNT = 1n;
    const NORMAL_PRICE = exp(1, 8);
    const MINIMUM_PRICE = 1n;
    const FACTOR_SCALE = exp(1, 18);
    const BASE_INDEX_SCALE = exp(1, 15);
    const BORROW_CF = exp(0.8, 18);
    const baseScale = exp(1, baseDecimals);
    const collateralScale = exp(1, collateralDecimals);

    type BorrowState = Record<string, bigint>;

    interface BorrowRun {
      before: BorrowState;
      after: BorrowState;
      transaction: TransactionResponseExt;
    }

    interface Position {
      debt?: bigint;
      collateralBalance?: bigint;
      baseBorrowIndex?: bigint;
      cometBase?: bigint;
    }

    interface EntryPoint {
      name: string;
      call: (amount: bigint) => Promise<unknown>;
    }

    let comet: CometHarnessInterfaceExtendedAssetList;
    let base: FaucetToken;
    let collateral: FaucetToken;
    let basePriceFeed: SimplePriceFeed;
    let collateralPriceFeed: SimplePriceFeed;
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let assetMask: bigint;
    let now: bigint;
    let initialSnapshot: string;

    const snapshot = (): Promise<string> => ethers.provider.send('evm_snapshot', []);
    const revert = (id: string): Promise<boolean> => ethers.provider.send('evm_revert', [id]);
    const toBigInt = (value: { toString(): string }): bigint => BigInt(value.toString());

    // F4: value and borrow contribution of a collateral balance
    const collateralValue = (balance: bigint, price: bigint): bigint => balance * price / collateralScale;
    const contribution = (balance: bigint, price: bigint): bigint => collateralValue(balance, price) * BORROW_CF / FACTOR_SCALE;

    // F4 + F5: liquidity as computed by isBorrowCollateralized for a single collateral asset.
    // BigInt division truncates toward zero, same as signedMulPrice in Solidity.
    function liquidity(debt: bigint, basePrice: bigint, balance: bigint, collateralPrice: bigint): bigint {
      return (-debt * basePrice) / baseScale + contribution(balance, collateralPrice);
    }

    // BR-04 runs through both entry points of a base borrow (static calls, no state change)
    const entryPoints: EntryPoint[] = [
      {
        name: 'withdraw',
        call: (amount) => comet.connect(alice).callStatic.withdraw(base.address, amount),
      },
      {
        name: 'transferAsset',
        call: (amount) => comet.connect(alice).callStatic.transferAsset(bob.address, base.address, amount),
      },
    ];

    async function readBorrowState(): Promise<BorrowState> {
      const [userBasic, userCollateral, bobBasic, totalsBasic, totalsCollateral] = await Promise.all([
        comet.userBasic(alice.address),
        comet.userCollateral(alice.address, collateral.address),
        comet.userBasic(bob.address),
        comet.totalsBasic(),
        comet.totalsCollateral(collateral.address),
      ]);

      return {
        alicePrincipal: toBigInt(userBasic.principal),
        aliceBaseTrackingIndex: toBigInt(userBasic.baseTrackingIndex),
        aliceBaseTrackingAccrued: toBigInt(userBasic.baseTrackingAccrued),
        aliceAssetsIn: toBigInt(userBasic.assetsIn),
        aliceUserBasicReserved: toBigInt(userBasic._reserved),
        aliceCollateralBalance: toBigInt(userCollateral.balance),
        aliceBorrowBalanceOf: toBigInt(await comet.borrowBalanceOf(alice.address)),
        aliceBaseTokenBalance: toBigInt(await base.balanceOf(alice.address)),
        aliceCollateralTokenBalance: toBigInt(await collateral.balanceOf(alice.address)),
        bobPrincipal: toBigInt(bobBasic.principal),
        baseSupplyIndex: toBigInt(totalsBasic.baseSupplyIndex),
        baseBorrowIndex: toBigInt(totalsBasic.baseBorrowIndex),
        trackingSupplyIndex: toBigInt(totalsBasic.trackingSupplyIndex),
        trackingBorrowIndex: toBigInt(totalsBasic.trackingBorrowIndex),
        totalSupplyBase: toBigInt(totalsBasic.totalSupplyBase),
        totalBorrowBase: toBigInt(totalsBasic.totalBorrowBase),
        lastAccrualTime: toBigInt(totalsBasic.lastAccrualTime),
        totalSupplyAsset: toBigInt(totalsCollateral.totalSupplyAsset),
        cometBaseTokenBalance: toBigInt(await base.balanceOf(comet.address)),
        cometCollateralTokenBalance: toBigInt(await collateral.balanceOf(comet.address)),
        baseReserves: toBigInt(await comet.getReserves()),
        collateralReserves: toBigInt(await comet.getCollateralReserves(collateral.address)),
      };
    }

    function stateDiff(run: BorrowRun): BorrowState {
      return Object.fromEntries(
        Object.keys(run.before).map((key) => [key, run.after[key] - run.before[key]])
      );
    }

    // Debt is set at the initial borrow index, time stays frozen, so the borrow does not accrue (README 3.6)
    async function openPosition({ debt = 0n, collateralBalance = 0n, baseBorrowIndex = BASE_INDEX_SCALE, cometBase = 0n }: Position) {
      await setTotalsBasic(comet, { baseBorrowIndex, totalBorrowBase: debt, lastAccrualTime: now });
      await comet.setBasePrincipal(alice.address, -debt);
      if (collateralBalance > 0n) {
        const totalsCollateral = Object.assign({}, await comet.totalsCollateral(collateral.address), {
          totalSupplyAsset: collateralBalance,
        });
        await collateral.allocateTo(comet.address, collateralBalance);
        await comet.setTotalsCollateral(collateral.address, totalsCollateral);
        await comet.setCollateralBalance(alice.address, collateral.address, collateralBalance);
      }
      if (cometBase > 0n) await base.allocateTo(comet.address, cometBase);
    }

    async function runBorrow(amount: bigint): Promise<BorrowRun> {
      const before = await readBorrowState();
      const transaction = await wait(comet.connect(alice).withdraw(base.address, amount));
      const after = await readBorrowState();
      return { before, after, transaction };
    }

    async function resetFixture() {
      await revert(initialSnapshot);
      initialSnapshot = await snapshot();
    }

    before(async () => {
      const protocol = await makeProtocol({
        base: 'USDC',
        baseBorrowMin: 0,
        assets: {
          USDC: { decimals: baseDecimals, initialPrice: 1 },
          TOKEN: {
            decimals: collateralDecimals,
            initialPrice: 1,
            borrowCF: BORROW_CF,
            liquidateCF: exp(0.85, 18),
            liquidationFactor: exp(0.9, 18),
            supplyCap: exp(1000, collateralDecimals),
          },
        },
      });

      comet = protocol.cometWithExtendedAssetList;
      base = protocol.tokens.USDC as FaucetToken;
      collateral = protocol.tokens.TOKEN as FaucetToken;
      basePriceFeed = protocol.priceFeeds.USDC as SimplePriceFeed;
      collateralPriceFeed = protocol.priceFeeds.TOKEN as SimplePriceFeed;
      [alice, bob] = protocol.users;

      const assetInfo = await comet.getAssetInfoByAddress(collateral.address);
      assetMask = 1n << toBigInt(assetInfo.offset);

      now = toBigInt(await comet.getNow());
      await comet.setNow(now);
      await setTotalsBasic(comet, { lastAccrualTime: now });

      initialSnapshot = await snapshot();
    });

    after(async () => {
      await revert(initialSnapshot);
    });

    context('when borrowing 1 raw unit of base', function () {
      context('given the account holds collateral covering the debt value', function () {
        context('given baseBorrowIndex equals the initial index', function () {
          let run: BorrowRun;

          before(async () => {
            await openPosition({ collateralBalance: collateralScale, cometBase: BORROW_AMOUNT });
            run = await runBorrow(BORROW_AMOUNT);
          });

          after(resetFixture);

          it('sets principal to minus 1', async () => {
            expect(run.after.alicePrincipal).to.equal(-BORROW_AMOUNT);
          });

          it('increases totalBorrowBase by 1', async () => {
            expect(run.after.totalBorrowBase).to.equal(run.before.totalBorrowBase + BORROW_AMOUNT);
          });

          it('reports borrowBalanceOf as 1', async () => {
            expect(run.after.aliceBorrowBalanceOf).to.equal(BORROW_AMOUNT);
          });

          it('emits Withdraw with amount 1', async () => {
            expect(event(run.transaction, 1)).to.deep.equal({
              Withdraw: {
                src: alice.address,
                to: alice.address,
                amount: BORROW_AMOUNT,
              },
            });
          });

          it('debits Comet by exactly 1 raw unit', async () => {
            expect(run.after.cometBaseTokenBalance).to.equal(run.before.cometBaseTokenBalance - BORROW_AMOUNT);
          });

          it('credits the user by exactly 1 raw unit', async () => {
            expect(run.after.aliceBaseTokenBalance).to.equal(run.before.aliceBaseTokenBalance + BORROW_AMOUNT);
          });

          it('changes only the principal, total borrow and base token balances', async () => {
            const expectedDiff = Object.fromEntries(
              Object.keys(run.before).map((key) => [key, 0n])
            ) as BorrowState;
            expectedDiff.alicePrincipal = -BORROW_AMOUNT;
            expectedDiff.aliceBorrowBalanceOf = BORROW_AMOUNT;
            expectedDiff.aliceBaseTokenBalance = BORROW_AMOUNT;
            expectedDiff.totalBorrowBase = BORROW_AMOUNT;
            expectedDiff.cometBaseTokenBalance = -BORROW_AMOUNT;

            expect(stateDiff(run)).to.deep.equal(expectedDiff);
          });
        });

        context('given baseBorrowIndex is above the initial index', function () {
          const BASE_BORROW_INDEX = 2n * BASE_INDEX_SCALE;

          let run: BorrowRun;

          before(async () => {
            await openPosition({
              collateralBalance: collateralScale,
              baseBorrowIndex: BASE_BORROW_INDEX,
              cometBase: BORROW_AMOUNT,
            });
            run = await runBorrow(BORROW_AMOUNT);
          });

          after(resetFixture);

          it('sets principal to minus 1', async () => {
            // Because borrow principal rounds up, the debt cannot disappear.
            expect(run.after.alicePrincipal).to.equal(-BORROW_AMOUNT);
          });

          it('reports borrowBalanceOf as the present value of principal 1', async () => {
            // From Ib of 2e15 the user receives 1 raw unit and immediately owes 2.
            expect(run.after.aliceBorrowBalanceOf).to.equal(BORROW_AMOUNT * BASE_BORROW_INDEX / BASE_INDEX_SCALE);
          });
        });
      });

      context('given the account holds no collateral', function () {
        if (baseDecimals < 18) {
          context(`given base decimals are ${baseDecimals}`, function () {
            before(async () => {
              await openPosition({ cometBase: BORROW_AMOUNT });
            });

            after(resetFixture);

            it('has a negative liquidity', async () => {
              // The debt value per F5 is minus 100 and minus 1 respectively.
              expect(liquidity(BORROW_AMOUNT, NORMAL_PRICE, 0n, NORMAL_PRICE)).to.equal(-(NORMAL_PRICE / baseScale));
            });

            it('reverts with NotCollateralized', async () => {
              await expect(
                comet.connect(alice).callStatic.withdraw(base.address, BORROW_AMOUNT)
              ).to.be.revertedWith("custom error 'NotCollateralized()'");
            });
          });
        } else {
          context('given base decimals are 18', function () {
            let run: BorrowRun;

            before(async () => {
              await openPosition({ cometBase: BORROW_AMOUNT });
              run = await runBorrow(BORROW_AMOUNT);
            });

            after(resetFixture);

            it('succeeds with no collateral at all', async () => {
              // F5 of 1 raw unit truncates to 0, so liquidity is 0 and the check passes.
              expect(run.after.alicePrincipal).to.equal(-BORROW_AMOUNT);
            });
          });
        }
      });
    });

    context('given 1 raw unit of collateral at the normal collateral price', function () {
      // At price 1e8 and borrowCF 0.8: 6 dec 100 and 80, 8 dec 1 and 0, 18 dec 0 and 0.
      const EXPECTED_F4: Record<number, { value: bigint, contribution: bigint }> = {
        6: { value: 100n, contribution: 80n },
        8: { value: 1n, contribution: 0n },
        18: { value: 0n, contribution: 0n },
      };

      it('has the expected collateral value and borrow contribution', async () => {
        expect(collateralValue(1n, NORMAL_PRICE)).to.equal(EXPECTED_F4[collateralDecimals].value);
        expect(contribution(1n, NORMAL_PRICE)).to.equal(EXPECTED_F4[collateralDecimals].contribution);
      });

      if (collateralDecimals === 8) {
        context('given collateral decimals are 8', function () {
          it('has nonzero value and zero contribution', async () => {
            expect(collateralValue(1n, NORMAL_PRICE)).to.be.gt(0n);
            expect(contribution(1n, NORMAL_PRICE)).to.equal(0n);
          });
        });
      }

      context('given the account debt is at its borrow limit', function () {
        // Expected outcome is precomputed per decimals, not asserted as always true or false.
        const EXPECTED_SUCCESS: Record<number, Record<number, boolean>> = {
          6: { 6: false, 8: false, 18: false },
          8: { 6: true, 8: false, 18: false },
          18: { 6: true, 8: false, 18: false },
        };
        const COLLATERAL_BALANCE = collateralScale;
        const limitContribution = contribution(COLLATERAL_BALANCE, NORMAL_PRICE);
        // Largest debt whose value per F5 does not exceed the contribution
        const DEBT = ((limitContribution + 1n) * baseScale - 1n) / NORMAL_PRICE;
        const expectedSuccess = liquidity(DEBT + BORROW_AMOUNT, NORMAL_PRICE, COLLATERAL_BALANCE + 1n, NORMAL_PRICE) >= 0n;

        let collateralizedAtLimit: boolean;
        let borrowSucceeded: boolean;
        let borrowError: string;

        before(async () => {
          await openPosition({ debt: DEBT, collateralBalance: COLLATERAL_BALANCE, cometBase: BORROW_AMOUNT });
          collateralizedAtLimit = await comet.isBorrowCollateralized(alice.address);

          await collateral.allocateTo(alice.address, 1n);
          await collateral.connect(alice).approve(comet.address, 1n);
          await wait(comet.connect(alice).supply(collateral.address, 1n));

          try {
            await wait(comet.connect(alice).withdraw(base.address, BORROW_AMOUNT));
            borrowSucceeded = true;
          } catch (error) {
            borrowSucceeded = false;
            borrowError = error.message;
          }
        });

        after(resetFixture);

        it('is collateralized at the limit', async () => {
          expect(collateralizedAtLimit).to.be.true;
        });

        it('has no margin left for 1 more raw unit of debt without the new collateral', async () => {
          expect(liquidity(DEBT + BORROW_AMOUNT, NORMAL_PRICE, COLLATERAL_BALANCE, NORMAL_PRICE)).to.be.lt(0n);
        });

        context('when borrowing 1 more raw unit after supplying the 1 raw unit of collateral', function () {
          it('precomputes the outcome from the remaining margin plus contribution', async () => {
            expect(expectedSuccess).to.equal(EXPECTED_SUCCESS[baseDecimals][collateralDecimals]);
          });

          it('succeeds only if the remaining margin plus contribution covers the value of 1 raw unit of debt', async () => {
            expect(borrowSucceeded).to.equal(expectedSuccess);
          });

          if (!EXPECTED_SUCCESS[baseDecimals][collateralDecimals]) {
            it('reverts with NotCollateralized', async () => {
              expect(borrowError).to.include('NotCollateralized');
            });
          }
        });
      });
    });

    context('given the collateral price is 1', function () {
      context('when borrowing at the normal base price against 1 raw unit of collateral only', function () {
        context('given the new debt is at least baseScale', function () {
          let stateBefore: BorrowState;
          let stateAfter: BorrowState;

          before(async () => {
            await openPosition({ collateralBalance: 1n, cometBase: baseScale });
            await collateralPriceFeed.setRoundData(0, MINIMUM_PRICE, 0, 0, 0);

            stateBefore = await readBorrowState();
            await expect(comet.connect(alice).withdraw(base.address, baseScale)).to.be.reverted;
            stateAfter = await readBorrowState();
          });

          after(resetFixture);

          it('has zero borrow contribution', async () => {
            // The contribution per F4 is 0 for every decimals combination.
            expect(contribution(1n, MINIMUM_PRICE)).to.equal(0n);
          });

          it('reverts with NotCollateralized', async () => {
            await expect(
              comet.connect(alice).callStatic.withdraw(base.address, baseScale)
            ).to.be.revertedWith("custom error 'NotCollateralized()'");
          });

          it('leaves all state unchanged', async () => {
            expect(stateAfter).to.deep.equal(stateBefore);
          });
        });

        if (baseDecimals === 18) {
          context('given the new debt is 1 raw unit and base decimals are 18', function () {
            let run: BorrowRun;

            before(async () => {
              await openPosition({ collateralBalance: 1n, cometBase: BORROW_AMOUNT });
              await collateralPriceFeed.setRoundData(0, MINIMUM_PRICE, 0, 0, 0);
              run = await runBorrow(BORROW_AMOUNT);
            });

            after(resetFixture);

            it('succeeds', async () => {
              // F5 truncates the debt value to 0, so the loop returns early on liquidity 0.
              expect(run.after.alicePrincipal).to.equal(-BORROW_AMOUNT);
            });

            it('keeps the collateral position', async () => {
              expect(run.after.aliceAssetsIn & assetMask).to.equal(assetMask);
            });
          });
        }
      });
    });

    context('given the base price is 1', function () {
      context('given the account has no collateral', function () {
        context('when the new debt is baseScale minus 1', function () {
          before(async () => {
            await openPosition({ cometBase: baseScale });
            await basePriceFeed.setRoundData(0, MINIMUM_PRICE, 0, 0, 0);
          });

          after(resetFixture);

          entryPoints.forEach(({ name, call }) => {
            it(`succeeds via ${name}`, async () => {
              await expect(call(baseScale - 1n)).to.not.be.reverted;
            });
          });
        });

        context('when the new debt is baseScale minus 1 in the control run at the normal base price', function () {
          before(async () => {
            await openPosition({ cometBase: baseScale });
          });

          after(resetFixture);

          entryPoints.forEach(({ name, call }) => {
            it(`reverts with NotCollateralized via ${name}`, async () => {
              await expect(call(baseScale - 1n)).to.be.revertedWith("custom error 'NotCollateralized()'");
            });
          });
        });

        context('when the new debt is baseScale', function () {
          before(async () => {
            await openPosition({ cometBase: baseScale });
            await basePriceFeed.setRoundData(0, MINIMUM_PRICE, 0, 0, 0);
          });

          after(resetFixture);

          entryPoints.forEach(({ name, call }) => {
            it(`reverts with NotCollateralized via ${name}`, async () => {
              await expect(call(baseScale)).to.be.revertedWith("custom error 'NotCollateralized()'");
            });
          });
        });

        context('when the new debt is baseScale plus 1', function () {
          before(async () => {
            await openPosition({ cometBase: baseScale + 1n });
            await basePriceFeed.setRoundData(0, MINIMUM_PRICE, 0, 0, 0);
          });

          after(resetFixture);

          entryPoints.forEach(({ name, call }) => {
            it(`reverts with NotCollateralized via ${name}`, async () => {
              await expect(call(baseScale + 1n)).to.be.revertedWith("custom error 'NotCollateralized()'");
            });
          });
        });
      });

      context('given the account holds collateral with a known contribution C', function () {
        // 1 whole token priced at 100: value 100, contribution floor(100 * 0.8) = 80
        const COLLATERAL_PRICE = 100n;
        const CONTRIBUTION = 80n;
        const DEBT_AT_C = (CONTRIBUTION + 1n) * baseScale - 1n;
        const DEBT_ABOVE_C = (CONTRIBUTION + 1n) * baseScale;

        before(async () => {
          await openPosition({ collateralBalance: collateralScale, cometBase: DEBT_ABOVE_C });
          await collateralPriceFeed.setRoundData(0, COLLATERAL_PRICE, 0, 0, 0);
          await basePriceFeed.setRoundData(0, MINIMUM_PRICE, 0, 0, 0);
        });

        after(resetFixture);

        it('has a borrow contribution C of 80', async () => {
          expect(contribution(collateralScale, COLLATERAL_PRICE)).to.equal(CONTRIBUTION);
        });

        context('when the new debt value is compared with C', function () {
          it('values the largest debt at C and the next raw unit above C', async () => {
            expect(DEBT_AT_C * MINIMUM_PRICE / baseScale).to.equal(CONTRIBUTION);
            expect(DEBT_ABOVE_C * MINIMUM_PRICE / baseScale).to.equal(CONTRIBUTION + 1n);
          });

          entryPoints.forEach(({ name, call }) => {
            it(`succeeds when the debt value is at most C via ${name}`, async () => {
              await expect(call(DEBT_AT_C)).to.not.be.reverted;
            });

            it(`reverts with NotCollateralized when the debt value exceeds C via ${name}`, async () => {
              await expect(call(DEBT_ABOVE_C)).to.be.revertedWith("custom error 'NotCollateralized()'");
            });
          });
        });
      });
    });
  });
}
