import { MaxUint256, ZeroAddress } from 'ethers';

import { baseBalanceOf, ethers, event, expect, exp, makeProtocol, portfolio, setTotalsBasic, wait, fastForward } from './helpers.js';

describe('transfer', function () {
  it('transfers base from sender if the asset is base', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = protocol;
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    const _i0 = await comet.setBasePrincipal(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsBasic();
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const s0 = await wait(cometAsB.transferAsset(alice.address, usdcAddress, 100e6));
    const t1 = await comet.totalsBasic();
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: ZeroAddress,
        amount: BigInt(100e6),
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Transfer: {
        from: ZeroAddress,
        to: alice.address,
        amount: BigInt(100e6),
      }
    });

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p1.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(t0.totalSupplyBase);
    expect(t1.totalBorrowBase).to.be.equal(t0.totalBorrowBase);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(90000);
  });

  it('does not emit Transfer if 0 mint/burn', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = protocol;
    const { USDC, WETH } = tokens;
    const usdcAddress = await USDC.getAddress();
    const wethAddress = await WETH.getAddress();

    await comet.setCollateralBalance(bob.address, wethAddress, exp(1, 18));
    await comet.setBasePrincipal(alice.address, -100e6);
    await setTotalsBasic(comet, {
      totalSupplyBase: 100e6,
      totalBorrowBase: 100e6,
    });

    const cometAsB = comet.connect(bob);

    const s0 = await wait(cometAsB.transferAsset(alice.address, usdcAddress, 100e6));

    expect(s0.receipt.logs.length).to.be.equal(0);
  });

  it('transfers max base balance (including accrued) from sender if the asset is base', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;
    const cometAddress = await comet.getAddress();
    const usdcAddress = await USDC.getAddress();

    await USDC.allocateTo(cometAddress, 100e6);
    await setTotalsBasic(comet, {
      totalSupplyBase: 100e6,
      totalBorrowBase: 50e6, // non-zero borrow to accrue interest
    });
    await comet.setBasePrincipal(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    // Fast forward to accrue some interest
    await fastForward(86400);
    await ethers.provider.send('evm_mine', []);

    const t0 = await comet.totalsBasic();
    const a0 = await portfolio(protocol, alice.address);
    const b0 = await portfolio(protocol, bob.address);
    const bobAccruedBalance = await comet.balanceOf.staticCall(bob.address);
    const s0 = await wait(cometAsB.transferAsset(alice.address, usdcAddress, MaxUint256));
    const t1 = await comet.totalsBasic();
    const a1 = await portfolio(protocol, alice.address);
    const b1 = await portfolio(protocol, bob.address);

    // additional 1 wei burned, amount to clear bob gets alice to same balance - 1
    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: ZeroAddress,
        amount: bobAccruedBalance,
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Transfer: {
        from: ZeroAddress,
        to: alice.address,
        amount: bobAccruedBalance - 1n,
      }
    });

    // Hitting the rounding down behavior in this specific case (which is favorable to the protocol)
    expect(a0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b0.internal).to.be.deep.equal({ USDC: bobAccruedBalance, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a1.internal).to.be.deep.equal({ USDC: bobAccruedBalance - 1n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(t0.totalSupplyBase - 1n);
    expect(t1.totalBorrowBase).to.be.equal(t0.totalBorrowBase);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(105000);
  });

  it('transfer max base should transfer 0 if user has a borrow position', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC, WETH } = tokens;
    const usdcAddress = await USDC.getAddress();
    const wethAddress = await WETH.getAddress();

    await comet.setBasePrincipal(bob.address, -100e6);
    await comet.setCollateralBalance(bob.address, wethAddress, exp(1, 18));
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsBasic();
    const a0 = await portfolio(protocol, alice.address);
    const b0 = await portfolio(protocol, bob.address);
    const s0 = await wait(cometAsB.transferAsset(alice.address, usdcAddress, MaxUint256));
    const t1 = await comet.totalsBasic();
    const a1 = await portfolio(protocol, alice.address);
    const b1 = await portfolio(protocol, bob.address);

    expect(s0.receipt.logs.length).to.be.equal(0);
    expect(a0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b0.internal).to.be.deep.equal({ USDC: exp(-100, 6), COMP: 0n, WETH: exp(1, 18), WBTC: 0n });
    expect(a1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b1.internal).to.be.deep.equal({ USDC: exp(-100, 6), COMP: 0n, WETH: exp(1, 18), WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(t0.totalSupplyBase);
    expect(t1.totalBorrowBase).to.be.equal(t0.totalBorrowBase);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(105000);
  });

  it('transfers collateral from sender if the asset is collateral', async () => {
    const protocol = await makeProtocol();
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    const _i0 = await comet.setCollateralBalance(bob.address, compAddress, 8e8);
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsCollateral(compAddress);
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const s0 = await wait(cometAsB.transferAsset(alice.address, compAddress, 8e8));
    const t1 = await comet.totalsCollateral(compAddress);
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(event(s0, 0)).to.be.deep.equal({
      TransferCollateral: {
        from: bob.address,
        to: alice.address,
        asset: compAddress,
        amount: BigInt(8e8),
      }
    });

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: 0n, COMP: exp(8, 8), WETH: 0n, WBTC: 0n });
    expect(p1.internal).to.be.deep.equal({ USDC: 0n, COMP: exp(8, 8), WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyAsset).to.be.equal(t0.totalSupplyAsset);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(95000);
  });

  it('calculates base principal correctly', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    await comet.setBasePrincipal(bob.address, 50e6); // 100e6 in present value
    const cometAsB = comet.connect(bob);

    const totals0 = await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
    });

    const alice0 = await portfolio(protocol, alice.address);
    const bob0 = await portfolio(protocol, bob.address);

    await wait(cometAsB.transferAsset(alice.address, usdcAddress, 100e6));
    const totals1 = await comet.totalsBasic();
    const alice1 = await portfolio(protocol, alice.address);
    const bob1 = await portfolio(protocol, bob.address);

    expect(alice0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(bob0.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(alice1.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(bob1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(totals1.totalSupplyBase).to.be.equal(totals0.totalSupplyBase);
    expect(totals1.totalBorrowBase).to.be.equal(totals0.totalBorrowBase);
  });

  it('reverts if the asset is neither collateral nor base', async () => {
    const protocol = await makeProtocol();
    const {
      cometWithExtendedAssetList: comet,
      users: [alice, bob],
      unsupportedToken: USUP,
    } = protocol;

    const cometAsB = comet.connect(bob);
    const unsupportedTokenAddress = await USUP.getAddress();

    await expect(cometAsB.transferAsset(alice.address, unsupportedTokenAddress, 1)).to.revert(ethers);
  });

  it('reverts if transfer is paused', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [alice, bob] } = protocol;
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    const cometAsB = comet.connect(bob);

    // Pause transfer
    await wait(comet.connect(pauseGuardian).pause(false, true, false, false, false));
    expect(await comet.isTransferPaused()).to.be.true;

    await expect(cometAsB.transferAsset(alice.address, usdcAddress, 1))
      .to.be.revertedWithCustomError(comet, 'Paused');
  });

  it('reverts if transfer max for a collateral asset', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    await COMP.allocateTo(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    await expect(cometAsB.transferAsset(alice.address, compAddress, MaxUint256))
      .to.be.revertedWithCustomError(comet, 'InvalidUInt128');
  });

  it('borrows base if collateralized', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol();
    const { WETH, USDC } = tokens;
    const usdcAddress = await USDC.getAddress();
    const wethAddress = await WETH.getAddress();

    await comet.setCollateralBalance(alice.address, wethAddress, exp(1, 18));

    let t0 = await comet.totalsBasic();
    await setTotalsBasic(comet, {
      baseBorrowIndex: t0.baseBorrowIndex * 2n,
    });

    await comet.connect(alice).transferAsset(bob.address, usdcAddress, 100e6);

    expect(await baseBalanceOf(comet, alice.address)).to.eq(BigInt(-100e6));
  });

  it('cant borrow less than the minimum', async () => {
    const protocol = await makeProtocol();
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = protocol;
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    const cometAsB = comet.connect(bob);

    const amount = (await comet.baseBorrowMin()) - 1n;
    await expect(cometAsB.transferAsset(alice.address, usdcAddress, amount))
      .to.be.revertedWithCustomError(comet, 'BorrowTooSmall');
  });

  it('reverts on self-transfer of base token', async () => {
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice],
    } = await makeProtocol({ base: 'USDC' });
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    await expect(
      comet.connect(alice).transferAsset(alice.address, usdcAddress, 100)
    ).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
  });

  it('reverts on self-transfer of collateral', async () => {
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice],
    } = await makeProtocol();
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    await expect(
      comet.connect(alice).transferAsset(alice.address, compAddress, 100)
    ).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
  });

  it('reverts if transferring base results in an under collateralized borrow', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol();
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    await expect(
      comet.connect(alice).transferAsset(bob.address, usdcAddress, 100e6)
    ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
  });

  it('reverts if transferring collateral results in an under collateralized borrow', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol();
    const { WETH } = tokens;
    const wethAddress = await WETH.getAddress();

    // user has a borrow, but with collateral to cover
    await comet.setBasePrincipal(alice.address, -100e6);
    await comet.setCollateralBalance(alice.address, wethAddress, exp(1, 18));

    // reverts if transfer would leave the borrow uncollateralized
    await expect(
      comet.connect(alice).transferAsset(bob.address, wethAddress, exp(1, 18))
    ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
  });
});

describe('transferFrom', function () {
  it('transfers from src if specified and sender has permission', async () => {
    const protocol = await makeProtocol();
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob, charlie],
    } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    const _i0 = await comet.setCollateralBalance(bob.address, compAddress, 7);
    const cometAsB = comet.connect(bob);
    const cometAsC = comet.connect(charlie);

    const _a1 = await wait(cometAsB.allow(charlie.address, true));
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const _s0 = await wait(cometAsC.transferAssetFrom(bob.address, alice.address, compAddress, 7));
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: 0n, COMP: 7n, WETH: 0n, WBTC: 0n });
    expect(p1.internal).to.be.deep.equal({ USDC: 0n, COMP: 7n, WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
  });

  it('reverts if src is specified and sender does not have permission', async () => {
    const protocol = await makeProtocol();
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob, charlie],
    } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    const _i0 = await comet.setCollateralBalance(bob.address, compAddress, 7);
    const cometAsC = comet.connect(charlie);

    await expect(
      cometAsC.transferAssetFrom(bob.address, alice.address, compAddress, 7)
    ).to.be.revertedWithCustomError(comet, 'Unauthorized');
  });

  it('reverts on transfer of base token from address to itself', async () => {
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = await makeProtocol({ base: 'USDC' });
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    await comet.connect(bob).allow(alice.address, true);

    await expect(
      comet.connect(alice).transferAssetFrom(bob.address, bob.address, usdcAddress, 100)
    ).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
  });

  it('reverts on transfer of collateral from address to itself', async () => {
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = await makeProtocol();
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    await comet.connect(bob).allow(alice.address, true);

    await expect(
      comet.connect(alice).transferAssetFrom(bob.address, bob.address, compAddress, 100)
    ).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
  });

  it('reverts if transfer is paused', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [alice, bob, charlie] } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    await comet.setCollateralBalance(bob.address, compAddress, 7);
    const cometAsB = comet.connect(bob);
    const cometAsC = comet.connect(charlie);

    // Pause transfer
    await wait(comet.connect(pauseGuardian).pause(false, true, false, false, false));
    expect(await comet.isTransferPaused()).to.be.true;

    await wait(cometAsB.allow(charlie.address, true));
    await expect(cometAsC.transferAssetFrom(bob.address, alice.address, compAddress, 7))
      .to.be.revertedWithCustomError(comet, 'Paused');
  });
});
