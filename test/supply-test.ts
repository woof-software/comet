import { ethers, event, expect, exp, makeProtocol, portfolio, ReentryAttack, setTotalsBasic, wait, fastForward, defaultAssets, TransactionResponseExt, bumpTotalsCollateral } from './helpers';
import { EvilToken, EvilToken__factory, NonStandardFaucetFeeToken__factory, NonStandardFaucetFeeToken, CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from '../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';

describe('supplyTo', function () {
  it('supplies base from sender if the asset is base', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;

    const _i0 = await USDC.allocateTo(bob.address, 100e6);
    const baseAsB = USDC.connect(bob);
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsBasic();
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const _a0 = await wait(baseAsB.approve(comet.address, 100e6));
    const s0 = await wait(cometAsB.supplyTo(alice.address, USDC.address, 100e6));
    const t1 = await comet.totalsBasic();
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: comet.address,
        amount: BigInt(100e6),
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Supply: {
        from: bob.address,
        dst: alice.address,
        amount: BigInt(100e6),
      }
    });
    expect(event(s0, 2)).to.be.deep.equal({
      Transfer: {
        from: ethers.constants.AddressZero,
        to: alice.address,
        amount: BigInt(100e6),
      }
    });

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.external).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p1.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(t0.totalSupplyBase.add(100e6));
    expect(t1.totalBorrowBase).to.be.equal(t0.totalBorrowBase);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(124000);
  });

  it('supplies max base borrow balance (including accrued) from sender if the asset is base', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;

    await USDC.allocateTo(bob.address, 100e6);
    await setTotalsBasic(comet, {
      totalSupplyBase: 100e6,
      totalBorrowBase: 50e6, // non-zero borrow to accrue interest
    });
    await comet.setBasePrincipal(alice.address, -50e6);
    const baseAsB = USDC.connect(bob);
    const cometAsB = comet.connect(bob);

    // Fast forward to accrue some interest
    await fastForward(86400);
    await ethers.provider.send('evm_mine', []);

    const t0 = await comet.totalsBasic();
    const a0 = await portfolio(protocol, alice.address);
    const b0 = await portfolio(protocol, bob.address);
    await wait(baseAsB.approve(comet.address, 100e6));
    const aliceAccruedBorrowBalance = (await comet.callStatic.borrowBalanceOf(alice.address)).toBigInt();
    const s0 = await wait(cometAsB.supplyTo(alice.address, USDC.address, ethers.constants.MaxUint256));
    const t1 = await comet.totalsBasic();
    const a1 = await portfolio(protocol, alice.address);
    const b1 = await portfolio(protocol, bob.address);

    expect(s0.receipt['events'].length).to.be.equal(2);
    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: comet.address,
        amount: aliceAccruedBorrowBalance,
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Supply: {
        from: bob.address,
        dst: alice.address,
        amount: aliceAccruedBorrowBalance,
      }
    });

    expect(-aliceAccruedBorrowBalance).to.not.equal(exp(-50, 6));
    expect(a0.internal).to.be.deep.equal({ USDC: -aliceAccruedBorrowBalance, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b0.external).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b1.external).to.be.deep.equal({ USDC: exp(100, 6) - aliceAccruedBorrowBalance, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(t0.totalSupplyBase);
    expect(t1.totalBorrowBase).to.be.equal(0n);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(120000);
  });

  it('supply max base should supply 0 if user has no borrow position', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;

    await USDC.allocateTo(bob.address, 100e6);
    const baseAsB = USDC.connect(bob);
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsBasic();
    const a0 = await portfolio(protocol, alice.address);
    const b0 = await portfolio(protocol, bob.address);
    await wait(baseAsB.approve(comet.address, 100e6));
    const s0 = await wait(cometAsB.supplyTo(alice.address, USDC.address, ethers.constants.MaxUint256));
    const t1 = await comet.totalsBasic();
    const a1 = await portfolio(protocol, alice.address);
    const b1 = await portfolio(protocol, bob.address);

    expect(s0.receipt['events'].length).to.be.equal(2);
    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: comet.address,
        amount: 0n,
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Supply: {
        from: bob.address,
        dst: alice.address,
        amount: 0n,
      }
    });

    expect(a0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b0.external).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b1.external).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(t0.totalSupplyBase);
    expect(t1.totalBorrowBase).to.be.equal(t0.totalBorrowBase);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(120000);
  });

  it('does not emit Transfer for 0 mint', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;

    await USDC.allocateTo(bob.address, 100e6);
    await comet.setBasePrincipal(alice.address, -100e6);
    await setTotalsBasic(comet, {
      totalBorrowBase: 100e6,
    });

    const baseAsB = USDC.connect(bob);
    const cometAsB = comet.connect(bob);

    const _a0 = await wait(baseAsB.approve(comet.address, 100e6));
    const s0 = await wait(cometAsB.supplyTo(alice.address, USDC.address, 100e6));
    expect(s0.receipt['events'].length).to.be.equal(2);
    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: comet.address,
        amount: BigInt(100e6),
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Supply: {
        from: bob.address,
        dst: alice.address,
        amount: BigInt(100e6),
      }
    });
  });

  // This is an edge-case that can occur when a user supplies 0 base.
  // When `amount=0` in `supplyBase`, `dstPrincipalNew = principalValue(presentValue(dstPrincipal))`
  // In some cases, `dstPrincipalNew` can actually be less than `dstPrincipal` due to the fact
  // that the principal value and present value functions round down. This breaks our assumption
  // in `repayAndSupplyAmount` that `newPrincipal >= oldPrincipal` MUST be true. In the old code,
  // this would cause `supplyAmount` to be an extremely large number (uint104(-1)), which would
  // later cause an overflow during an addition operation. The new code now explicitly checks
  // this assumption and sets both `repayAmount` and `supplyAmount` to 0 if the assumption is
  // violated.
  it('supplies 0 and does not revert when dstPrincipalNew < dstPrincipal', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice] } = protocol;
    const { USDC } = tokens;

    await comet.setBasePrincipal(alice.address, 99999992291226);
    await setTotalsBasic(comet, {
      totalSupplyBase: 699999944771920,
      baseSupplyIndex: 1000000131467072,
    });

    const s0 = await wait(comet.connect(alice).supply(USDC.address, 0));

    expect(s0.receipt['events'].length).to.be.equal(2);
    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: alice.address,
        to: comet.address,
        amount: BigInt(0),
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Supply: {
        from: alice.address,
        dst: alice.address,
        amount: BigInt(0),
      }
    });
  });

  it('user supply is same as total supply', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [bob] } = protocol;
    const { USDC } = tokens;

    await setTotalsBasic(comet, {
      totalSupplyBase: 100,
      baseSupplyIndex: exp(1.085, 15),
    });

    const _i0 = await USDC.allocateTo(bob.address, 10);
    const baseAsB = USDC.connect(bob);
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsBasic();
    const p0 = await portfolio(protocol, bob.address);
    const _a0 = await wait(baseAsB.approve(comet.address, 10));
    const s0 = await wait(cometAsB.supplyTo(bob.address, USDC.address, 10));
    const t1 = await comet.totalsBasic();
    const p1 = await portfolio(protocol, bob.address);

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p0.external).to.be.deep.equal({ USDC: 10n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p1.internal).to.be.deep.equal({ USDC: 9n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(109);
    expect(t1.totalBorrowBase).to.be.equal(t0.totalBorrowBase);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(124000);
  });

  it('supplies collateral from sender if the asset is collateral', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { COMP } = tokens;

    const _i0 = await COMP.allocateTo(bob.address, 8e8);
    const baseAsB = COMP.connect(bob);
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsCollateral(COMP.address);
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const _a0 = await wait(baseAsB.approve(comet.address, 8e8));
    const s0 = await wait(cometAsB.supplyTo(alice.address, COMP.address, 8e8));
    const t1 = await comet.totalsCollateral(COMP.address);
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: comet.address,
        amount: BigInt(8e8),
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      SupplyCollateral: {
        from: bob.address,
        dst: alice.address,
        asset: COMP.address,
        amount: BigInt(8e8),
      }
    });

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.external).to.be.deep.equal({ USDC: 0n, COMP: exp(8, 8), WETH: 0n, WBTC: 0n });
    expect(p1.internal).to.be.deep.equal({ USDC: 0n, COMP: exp(8, 8), WETH: 0n, WBTC: 0n });
    expect(p1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyAsset).to.be.equal(t0.totalSupplyAsset.add(8e8));
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(153000);
  });

  it('calculates base principal correctly', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;

    await USDC.allocateTo(bob.address, 100e6);
    const baseAsB = USDC.connect(bob);
    const cometAsB = comet.connect(bob);

    const totals0 = await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
    });

    const alice0 = await portfolio(protocol, alice.address);
    const bob0 = await portfolio(protocol, bob.address);
    const aliceBasic0 = await comet.userBasic(alice.address);

    await wait(baseAsB.approve(comet.address, 100e6));
    await wait(cometAsB.supplyTo(alice.address, USDC.address, 100e6));
    const t1 = await comet.totalsBasic();
    const alice1 = await portfolio(protocol, alice.address);
    const bob1 = await portfolio(protocol, bob.address);
    const aliceBasic1 = await comet.userBasic(alice.address);

    expect(alice0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(alice0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(bob0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(bob0.external).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(alice1.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(alice1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(bob1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(bob1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(totals0.totalSupplyBase.add(50e6)); // 100e6 in present value
    expect(t1.totalBorrowBase).to.be.equal(totals0.totalBorrowBase);
    expect(aliceBasic1.principal).to.be.equal(aliceBasic0.principal.add(50e6)); // 100e6 in present value
  });

  it('reverts if supplying collateral exceeds the supply cap', async () => {
    const protocol = await makeProtocol({
      assets: {
        COMP: { initial: 1e7, decimals: 18, supplyCap: 0 },
        USDC: { initial: 1e6, decimals: 6 },
      }
    });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { COMP } = tokens;

    const _i0 = await COMP.allocateTo(bob.address, 8e8);
    const baseAsB = COMP.connect(bob);
    const cometAsB = comet.connect(bob);

    const _a0 = await wait(baseAsB.approve(comet.address, 8e8));
    await expect(cometAsB.supplyTo(alice.address, COMP.address, 8e8)).to.be.revertedWith("custom error 'SupplyCapExceeded()'");
  });

  it('reverts if the asset is neither collateral nor base', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, users: [alice, bob], unsupportedToken: USUP } = protocol;

    const _i0 = await USUP.allocateTo(bob.address, 1);
    const baseAsB = USUP.connect(bob);
    const cometAsB = comet.connect(bob);

    const _a0 = await wait(baseAsB.approve(comet.address, 1));
    await expect(cometAsB.supplyTo(alice.address, USUP.address, 1)).to.be.reverted;
  });

  it('reverts if supply is paused', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [alice, bob] } = protocol;
    const { USDC } = tokens;

    await USDC.allocateTo(bob.address, 1);
    const baseAsB = USDC.connect(bob);
    const cometAsB = comet.connect(bob);

    // Pause supply
    await wait(comet.connect(pauseGuardian).pause(true, false, false, false, false));
    expect(await comet.isSupplyPaused()).to.be.true;

    await wait(baseAsB.approve(comet.address, 1));
    await expect(cometAsB.supplyTo(alice.address, USDC.address, 1)).to.be.revertedWith("custom error 'Paused()'");
  });

  it('reverts if supply max for a collateral asset', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { COMP } = tokens;

    await COMP.allocateTo(bob.address, 100e6);
    const baseAsB = COMP.connect(bob);
    const cometAsB = comet.connect(bob);

    await wait(baseAsB.approve(COMP.address, 100e6));
    await expect(cometAsB.supplyTo(alice.address, COMP.address, ethers.constants.MaxUint256)).to.be.revertedWith("custom error 'InvalidUInt128()'");
  });

  it('supplies base the correct amount in a fee-like situation', async () => {
    const assets = defaultAssets();
    // Add USDT to assets on top of default assets
    assets['USDT'] = {
      initial: 1e6,
      decimals: 6,
      factory: (await ethers.getContractFactory('NonStandardFaucetFeeToken')) as NonStandardFaucetFeeToken__factory,
    };
    const protocol = await makeProtocol({ base: 'USDT', assets: assets });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDT } = tokens;

    // Set fee to 0.1%
    await (USDT as NonStandardFaucetFeeToken).setParams(10, 10);

    const _i0 = await USDT.allocateTo(bob.address, 1000e6);
    const baseAsB = USDT.connect(bob);
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsBasic();
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const _a0 = await wait(baseAsB.approve(comet.address, 1000e6));
    const s0 = await wait(cometAsB.supplyTo(alice.address, USDT.address, 1000e6));
    const t1 = await comet.totalsBasic();
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: comet.address,
        amount: BigInt(999e6),
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Supply: {
        from: bob.address,
        dst: alice.address,
        amount: BigInt(999e6),
      }
    });
    expect(event(s0, 2)).to.be.deep.equal({
      Transfer: {
        from: ethers.constants.AddressZero,
        to: alice.address,
        amount: BigInt(999e6),
      }
    });

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, USDT: 0n });
    expect(p0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, USDT: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, USDT: 0n });
    expect(q0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, USDT: exp(1000, 6) });
    expect(p1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, USDT: exp(999, 6) });
    expect(p1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, USDT: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, USDT: 0n });
    expect(q1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, USDT: 0n });
    expect(t1.totalSupplyBase).to.be.equal(t0.totalSupplyBase.add(999e6));
    expect(t1.totalBorrowBase).to.be.equal(t0.totalBorrowBase);
    // Fee Token logics will cost a bit more gas than standard ERC20 token with no fee calculation
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(151000);
  });

  it('supplies collateral the correct amount in a fee-like situation', async () => {
    const assets = defaultAssets();
    // Add FeeToken Collateral to assets on top of default assets
    assets['FeeToken'] = {
      initial: 1e8,
      decimals: 18,
      factory: (await ethers.getContractFactory('NonStandardFaucetFeeToken')) as NonStandardFaucetFeeToken__factory,
    };

    const protocol = await makeProtocol({ base: 'USDC', assets: assets });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { FeeToken } = tokens;

    // Set fee to 0.1%
    await (FeeToken as NonStandardFaucetFeeToken).setParams(10, 10);

    const _i0 = await FeeToken.allocateTo(bob.address, 2000e8);
    const baseAsB = FeeToken.connect(bob);
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsCollateral(FeeToken.address);
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const _a0 = await wait(baseAsB.approve(comet.address, 2000e8));
    const s0 = await wait(cometAsB.supplyTo(alice.address, FeeToken.address, 2000e8));
    const t1 = await comet.totalsCollateral(FeeToken.address);
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: comet.address,
        amount: BigInt(1998e8),
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      SupplyCollateral: {
        from: bob.address,
        dst: alice.address,
        asset: FeeToken.address,
        amount: BigInt(1998e8),
      }
    });

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, FeeToken: 0n });
    expect(p0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, FeeToken: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, FeeToken: 0n });
    expect(q0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, FeeToken: exp(2000, 8) });
    expect(p1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, FeeToken: exp(1998, 8) });
    expect(p1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, FeeToken: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, FeeToken: 0n });
    expect(q1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n, FeeToken: 0n });
    expect(t1.totalSupplyAsset).to.be.equal(t0.totalSupplyAsset.add(1998e8));
    // Fee Token logics will cost a bit more gas than standard ERC20 token with no fee calculation
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(186000);
  });

  it('blocks reentrancy from exceeding the supply cap', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol({
      assets: {
        USDC: {
          decimals: 6
        },
        EVIL: {
          decimals: 6,
          initialPrice: 2,
          factory: await ethers.getContractFactory('EvilToken') as EvilToken__factory,
          supplyCap: 100e6
        }
      }
    });
    const { EVIL } = <{ EVIL: EvilToken }>tokens;

    const attack = Object.assign({}, await EVIL.getAttack(), {
      attackType: ReentryAttack.SupplyFrom,
      source: alice.address,
      destination: bob.address,
      asset: EVIL.address,
      amount: 75e6,
      maxCalls: 1
    });
    await EVIL.setAttack(attack);

    await comet.connect(alice).allow(EVIL.address, true);
    await wait(EVIL.connect(alice).approve(comet.address, 75e6));
    await EVIL.allocateTo(alice.address, 75e6);
    await expect(
      comet.connect(alice).supplyTo(bob.address, EVIL.address, 75e6)
    ).to.be.revertedWithCustomError(comet, 'ReentrantCallBlocked');
  });
});

describe('supply', function () {
  it('supplies to sender by default', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [bob] } = protocol;
    const { USDC } = tokens;

    const _i0 = await USDC.allocateTo(bob.address, 100e6);
    const baseAsB = USDC.connect(bob);
    const cometAsB = comet.connect(bob);

    const _t0 = await comet.totalsBasic();
    const q0 = await portfolio(protocol, bob.address);
    const _a0 = await wait(baseAsB.approve(comet.address, 100e6));
    const _s0 = await wait(cometAsB.supply(USDC.address, 100e6));
    const _t1 = await comet.totalsBasic();
    const q1 = await portfolio(protocol, bob.address);

    expect(q0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.external).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
  });

  it('reverts if supply is paused', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [bob] } = protocol;
    const { USDC } = tokens;

    await USDC.allocateTo(bob.address, 100e6);
    const baseAsB = USDC.connect(bob);
    const cometAsB = comet.connect(bob);

    // Pause supply
    await wait(comet.connect(pauseGuardian).pause(true, false, false, false, false));
    expect(await comet.isSupplyPaused()).to.be.true;

    await wait(baseAsB.approve(comet.address, 100e6));
    await expect(cometAsB.supply(USDC.address, 100e6)).to.be.revertedWith("custom error 'Paused()'");
  });

});

describe('supplyFrom', function () {
  it('supplies from `from` if specified and sender has permission', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob, charlie] } = protocol;
    const { COMP } = tokens;

    const _i0 = await COMP.allocateTo(bob.address, 7);
    const baseAsB = COMP.connect(bob);
    const cometAsB = comet.connect(bob);
    const cometAsC = comet.connect(charlie);

    const _a0 = await wait(baseAsB.approve(comet.address, 7));
    const _a1 = await wait(cometAsB.allow(charlie.address, true));
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const _s0 = await wait(cometAsC.supplyFrom(bob.address, alice.address, COMP.address, 7));
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p0.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.external).to.be.deep.equal({ USDC: 0n, COMP: 7n, WETH: 0n, WBTC: 0n });
    expect(p1.internal).to.be.deep.equal({ USDC: 0n, COMP: 7n, WETH: 0n, WBTC: 0n });
    expect(p1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.external).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
  });

  it('reverts if `from` is specified and sender does not have permission', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob, charlie] } = protocol;
    const { COMP } = tokens;

    const _i0 = await COMP.allocateTo(bob.address, 7);
    const cometAsC = comet.connect(charlie);

    await expect(cometAsC.supplyFrom(bob.address, alice.address, COMP.address, 7))
      .to.be.revertedWith("custom error 'Unauthorized()'");
  });

  it('reverts if supply is paused', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [alice, bob, charlie] } = protocol;
    const { COMP } = tokens;

    await COMP.allocateTo(bob.address, 7);
    const baseAsB = COMP.connect(bob);
    const cometAsB = comet.connect(bob);
    const cometAsC = comet.connect(charlie);

    // Pause supply
    await wait(comet.connect(pauseGuardian).pause(true, false, false, false, false));
    expect(await comet.isSupplyPaused()).to.be.true;

    await wait(baseAsB.approve(comet.address, 7));
    await wait(cometAsB.allow(charlie.address, true));
    await expect(cometAsC.supplyFrom(bob.address, alice.address, COMP.address, 7)).to.be.revertedWith("custom error 'Paused()'");
  });
});

describe('Minimum collateral supply', function () {
  [6, 8, 18].forEach(runMinimumCollateralSupplyTests);
  [6, 8, 18].forEach(runCollateralOffsetSupplyTests);
});

function runMinimumCollateralSupplyTests(collateralDecimals: number) {
  describe(`Minimum collateral price and amount (${collateralDecimals} decimals)`, function () {
    const SUPPLY_AMOUNT = 1n;

    type SupplyState = Record<string, bigint>;
    type AccountPrefix = 'alice' | 'bob';

    interface SupplyRun {
      before: SupplyState;
      after: SupplyState;
      transaction: TransactionResponseExt;
    }

    interface SupplyCase {
      minimumPrice: bigint;
      control: SupplyRun;
      minimumPriceRun: SupplyRun;
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

    async function readAccountState(account: SignerWithAddress): Promise<SupplyState> {
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

    function prefixState(prefix: string, state: SupplyState): SupplyState {
      return Object.fromEntries(
        Object.entries(state).map(([key, value]) => [
          `${prefix}${key[0].toUpperCase()}${key.slice(1)}`,
          value,
        ])
      );
    }

    async function readSupplyState(): Promise<SupplyState> {
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

    function stateDiff(run: SupplyRun): SupplyState {
      return Object.fromEntries(
        Object.keys(run.before).map((key) => [key, run.after[key] - run.before[key]])
      );
    }

    async function runSupplyScenario(action: () => Promise<ContractTransaction>): Promise<SupplyCase> {
      await collateral.allocateTo(alice.address, 2n * SUPPLY_AMOUNT);
      await collateral.connect(alice).approve(comet.address, SUPPLY_AMOUNT);

      const scenarioSnapshot = await snapshot();
      const controlBefore = await readSupplyState();
      const controlTransaction = await wait(action());
      const controlAfter = await readSupplyState();

      await revert(scenarioSnapshot);

      await priceFeed.setRoundData(0, SUPPLY_AMOUNT, 0, 0, 0);
      const minimumPrice = toBigInt((await priceFeed.latestRoundData())[1]);
      const minimumPriceBefore = await readSupplyState();
      const minimumPriceTransaction = await wait(action());
      const minimumPriceAfter = await readSupplyState();

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

    async function runNormalPriceSupplyScenario(action: () => Promise<ContractTransaction>): Promise<SupplyRun> {
      await collateral.allocateTo(alice.address, SUPPLY_AMOUNT);
      await collateral.connect(alice).approve(comet.address, SUPPLY_AMOUNT);

      const before = await readSupplyState();
      const transaction = await wait(action());
      const after = await readSupplyState();

      return { before, after, transaction };
    }

    async function resetFixture() {
      await revert(initialSnapshot);
      initialSnapshot = await snapshot();
    }

    function shouldSupplyMinimumCollateral(
      destinationPrefix: AccountPrefix,
      destination: () => SignerWithAddress,
      action: () => Promise<ContractTransaction>,
      prepare?: () => Promise<unknown>
    ) {
      context('when supplying 1 raw unit of collateral', function () {
        let run: SupplyRun;

        before(async () => {
          if (prepare) await prepare();
          run = await runNormalPriceSupplyScenario(action);
        });

        after(resetFixture);

        it('increases userCollateral balance by 1', async () => {
          const balanceKey = `${destinationPrefix}CollateralBalance`;
          expect(run.after[balanceKey]).to.equal(run.before[balanceKey] + SUPPLY_AMOUNT);
        });

        it('increases totalSupplyAsset by 1', async () => {
          expect(run.after.totalSupplyAsset).to.equal(run.before.totalSupplyAsset + SUPPLY_AMOUNT);
        });

        it('emits SupplyCollateral with amount 1', async () => {
          expect(event(run.transaction, 1)).to.deep.equal({
            SupplyCollateral: {
              from: alice.address,
              dst: destination().address,
              asset: collateral.address,
              amount: SUPPLY_AMOUNT,
            },
          });
        });

        it('sets the membership bit for the asset offset', async () => {
          const assetsInKey = `${destinationPrefix}AssetsIn`;
          expect(run.after[assetsInKey]).to.equal(run.before[assetsInKey] | assetMask);
        });

        it('debits the supplier by exactly 1 raw unit', async () => {
          expect(run.after.aliceCollateralTokenBalance).to.equal(run.before.aliceCollateralTokenBalance - SUPPLY_AMOUNT);
        });

        it('credits Comet by exactly 1 raw unit', async () => {
          expect(run.after.cometCollateralTokenBalance).to.equal(run.before.cometCollateralTokenBalance + SUPPLY_AMOUNT);
        });

        it('changes only collateral accounting, membership, and collateral token balances', async () => {
          const expectedDiff = Object.fromEntries(
            Object.keys(run.before).map((key) => [key, 0n])
          ) as SupplyState;
          expectedDiff[`${destinationPrefix}AssetsIn`] = assetMask;
          expectedDiff[`${destinationPrefix}CollateralBalance`] = SUPPLY_AMOUNT;
          expectedDiff.totalSupplyAsset = SUPPLY_AMOUNT;
          expectedDiff.aliceCollateralTokenBalance = -SUPPLY_AMOUNT;
          expectedDiff.cometCollateralTokenBalance = SUPPLY_AMOUNT;

          expect(stateDiff(run)).to.deep.equal(expectedDiff);
        });
      });

      context('when supplying 1 raw unit of collateral priced at 1', function () {
        let supplyCase: SupplyCase;

        before(async () => {
          if (prepare) await prepare();
          supplyCase = await runSupplyScenario(action);
        });

        after(resetFixture);

        it('uses the minimum valid collateral price', async () => {
          expect(supplyCase.minimumPrice).to.equal(1n);
        });

        it('credits 1 raw unit to the destination collateral balance', async () => {
          const { before, after } = supplyCase.minimumPriceRun;
          const balanceKey = `${destinationPrefix}CollateralBalance`;
          expect(after[balanceKey]).to.equal(before[balanceKey] + SUPPLY_AMOUNT);
        });

        it('increases total supplied collateral by 1 raw unit', async () => {
          const { before, after } = supplyCase.minimumPriceRun;
          expect(after.totalSupplyAsset).to.equal(before.totalSupplyAsset + SUPPLY_AMOUNT);
        });

        it('emits SupplyCollateral with amount 1', async () => {
          expect(event(supplyCase.minimumPriceRun.transaction, 1)).to.deep.equal({
            SupplyCollateral: {
              from: alice.address,
              dst: destination().address,
              asset: collateral.address,
              amount: SUPPLY_AMOUNT,
            },
          });
        });

        it('sets the destination collateral membership bit', async () => {
          const { before, after } = supplyCase.minimumPriceRun;
          const assetsInKey = `${destinationPrefix}AssetsIn`;
          expect(after[assetsInKey]).to.equal(before[assetsInKey] | assetMask);
        });

        it('debits the supplier by exactly 1 raw unit', async () => {
          const { before, after } = supplyCase.minimumPriceRun;
          expect(after.aliceCollateralTokenBalance).to.equal(before.aliceCollateralTokenBalance - SUPPLY_AMOUNT);
        });

        it('credits Comet by exactly 1 raw unit', async () => {
          const { before, after } = supplyCase.minimumPriceRun;
          expect(after.cometCollateralTokenBalance).to.equal(before.cometCollateralTokenBalance + SUPPLY_AMOUNT);
        });

        it('emits the collateral token Transfer', async () => {
          expect(event(supplyCase.minimumPriceRun.transaction, 0)).to.deep.equal({
            Transfer: {
              from: alice.address,
              to: comet.address,
              amount: SUPPLY_AMOUNT,
            },
          });
        });

        it('produces the same complete state diff as the normal-price control run', async () => {
          expect(stateDiff(supplyCase.minimumPriceRun)).to.deep.equal(stateDiff(supplyCase.control));
        });

        it('changes only collateral accounting, membership, and collateral token balances', async () => {
          const expectedDiff = Object.fromEntries(
            Object.keys(supplyCase.minimumPriceRun.before).map((key) => [key, 0n])
          ) as SupplyState;
          expectedDiff[`${destinationPrefix}AssetsIn`] = assetMask;
          expectedDiff[`${destinationPrefix}CollateralBalance`] = SUPPLY_AMOUNT;
          expectedDiff.totalSupplyAsset = SUPPLY_AMOUNT;
          expectedDiff.aliceCollateralTokenBalance = -SUPPLY_AMOUNT;
          expectedDiff.cometCollateralTokenBalance = SUPPLY_AMOUNT;

          expect(stateDiff(supplyCase.minimumPriceRun)).to.deep.equal(expectedDiff);
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

    describe('supply', function () {
      shouldSupplyMinimumCollateral(
        'alice',
        () => alice,
        () => comet.connect(alice).supply(collateral.address, SUPPLY_AMOUNT)
      );
    });

    describe('supplyTo', function () {
      shouldSupplyMinimumCollateral(
        'bob',
        () => bob,
        () => comet.connect(alice).supplyTo(bob.address, collateral.address, SUPPLY_AMOUNT)
      );
    });

    describe('supplyFrom', function () {
      shouldSupplyMinimumCollateral(
        'bob',
        () => bob,
        () => comet.connect(charlie).supplyFrom(alice.address, bob.address, collateral.address, SUPPLY_AMOUNT),
        () => wait(comet.connect(alice).allow(charlie.address, true))
      );
    });

    context('given totalSupplyAsset equals supplyCap minus 1', function () {
      let supplyCap: bigint;
      let run: SupplyRun;

      before(async () => {
        supplyCap = toBigInt((await comet.getAssetInfoByAddress(collateral.address)).supplyCap);
        await bumpTotalsCollateral(comet, collateral, supplyCap - SUPPLY_AMOUNT);
        run = await runNormalPriceSupplyScenario(
          () => comet.connect(alice).supply(collateral.address, SUPPLY_AMOUNT)
        );
      });

      after(resetFixture);

      it('starts 1 raw unit below the supply cap', async () => {
        expect(run.before.totalSupplyAsset).to.equal(supplyCap - SUPPLY_AMOUNT);
      });

      context('when supplying 1 raw unit', function () {
        it('succeeds', async () => {
          expect(run.transaction.receipt.status).to.equal(1);
        });

        it('makes totalSupplyAsset equal supplyCap', async () => {
          expect(run.after.totalSupplyAsset).to.equal(supplyCap);
        });
      });
    });

    context('given totalSupplyAsset equals supplyCap', function () {
      let supplyCap: bigint;
      let stateBefore: SupplyState;
      let stateAfter: SupplyState;

      before(async () => {
        supplyCap = toBigInt((await comet.getAssetInfoByAddress(collateral.address)).supplyCap);
        await bumpTotalsCollateral(comet, collateral, supplyCap);
        await collateral.allocateTo(alice.address, SUPPLY_AMOUNT);
        await collateral.connect(alice).approve(comet.address, SUPPLY_AMOUNT);

        stateBefore = await readSupplyState();
        await expect(comet.connect(alice).supply(collateral.address, SUPPLY_AMOUNT)).to.be.reverted;
        stateAfter = await readSupplyState();
      });

      after(resetFixture);

      it('starts at the supply cap', async () => {
        expect(stateBefore.totalSupplyAsset).to.equal(supplyCap);
      });

      context('when supplying 1 raw unit', function () {
        it('reverts with SupplyCapExceeded', async () => {
          await expect(
            comet.connect(alice).callStatic.supply(collateral.address, SUPPLY_AMOUNT)
          ).to.be.revertedWith("custom error 'SupplyCapExceeded()'");
        });

        it('leaves all state unchanged', async () => {
          expect(stateAfter).to.deep.equal(stateBefore);
        });
      });
    });
  });
}


function runCollateralOffsetSupplyTests(collateralDecimals: number) {
  describe(`Minimum collateral amount at boundary offsets (${collateralDecimals} decimals)`, function () {
    const SUPPLY_AMOUNT = 1n;
    const ASSET_COUNT = 24;

    type OffsetState = Record<string, bigint>;

    interface OffsetRun {
      offset: bigint;
      before: OffsetState;
      after: OffsetState;
    }

    let comet: CometHarnessInterfaceExtendedAssetList;
    let tokens: Record<string, FaucetToken>;
    let alice: SignerWithAddress;
    let initialSnapshot: string;

    const snapshot = (): Promise<string> => ethers.provider.send('evm_snapshot', []);
    const revert = (id: string): Promise<boolean> => ethers.provider.send('evm_revert', [id]);
    const toBigInt = (value: { toString(): string }): bigint => BigInt(value.toString());

    async function readOffsetState(asset: FaucetToken): Promise<OffsetState> {
      const userBasic = await comet.userBasic(alice.address);
      const userCollateral = await comet.userCollateral(alice.address, asset.address);
      const totalsCollateral = await comet.totalsCollateral(asset.address);

      return {
        assetsIn: toBigInt(userBasic.assetsIn),
        userBasicReserved: toBigInt(userBasic._reserved),
        principal: toBigInt(userBasic.principal),
        collateralBalance: toBigInt(userCollateral.balance),
        totalSupplyAsset: toBigInt(totalsCollateral.totalSupplyAsset),
        aliceTokenBalance: toBigInt(await asset.balanceOf(alice.address)),
        cometTokenBalance: toBigInt(await asset.balanceOf(comet.address)),
      };
    }

    function stateDiff(run: OffsetRun): OffsetState {
      return Object.fromEntries(
        Object.keys(run.before).map((key) => [key, run.after[key] - run.before[key]])
      );
    }

    async function runOffsetSupply(asset: FaucetToken): Promise<OffsetRun> {
      await asset.allocateTo(alice.address, SUPPLY_AMOUNT);
      await asset.connect(alice).approve(comet.address, SUPPLY_AMOUNT);

      const offset = toBigInt((await comet.getAssetInfoByAddress(asset.address)).offset);
      const before = await readOffsetState(asset);
      await wait(comet.connect(alice).supply(asset.address, SUPPLY_AMOUNT));
      const after = await readOffsetState(asset);

      return { offset, before, after };
    }

    async function resetFixture() {
      await revert(initialSnapshot);
      initialSnapshot = await snapshot();
    }

    before(async () => {
      const assets = {};
      for (let i = 0; i < ASSET_COUNT; i++) {
        assets[`ASSET${i}`] = {
          decimals: collateralDecimals,
          initialPrice: 1,
          supplyCap: exp(100, collateralDecimals),
        };
      }
      assets['USDC'] = { decimals: 6, initialPrice: 1 };

      const protocol = await makeProtocol({ base: 'USDC', baseBorrowMin: 0, assets });

      comet = protocol.cometWithExtendedAssetList;
      tokens = protocol.tokens as Record<string, FaucetToken>;
      [alice] = protocol.users;
      initialSnapshot = await snapshot();
    });

    after(async () => {
      await revert(initialSnapshot);
    });

    context('given the asset has a boundary offset', function () {
      context('when the offset is 15 and 1 raw unit is supplied', function () {
        let run: OffsetRun;

        before(async () => {
          run = await runOffsetSupply(tokens.ASSET15);
        });

        after(resetFixture);

        it('uses the asset at offset 15', async () => {
          expect(run.offset).to.equal(15n);
        });

        it('sets bit 15 of assetsIn', async () => {
          expect(run.after.assetsIn).to.equal(run.before.assetsIn | (1n << 15n));
        });

        it('leaves userBasic reserved unchanged', async () => {
          expect(run.after.userBasicReserved).to.equal(run.before.userBasicReserved);
        });

        it('changes only membership, collateral accounting and token balances', async () => {
          expect(stateDiff(run)).to.deep.equal({
            assetsIn: 1n << 15n,
            userBasicReserved: 0n,
            principal: 0n,
            collateralBalance: SUPPLY_AMOUNT,
            totalSupplyAsset: SUPPLY_AMOUNT,
            aliceTokenBalance: -SUPPLY_AMOUNT,
            cometTokenBalance: SUPPLY_AMOUNT,
          });
        });
      });

      context('when the offset is 16 and 1 raw unit is supplied', function () {
        let run: OffsetRun;

        before(async () => {
          run = await runOffsetSupply(tokens.ASSET16);
        });

        after(resetFixture);

        it('uses the asset at offset 16', async () => {
          expect(run.offset).to.equal(16n);
        });

        it('sets bit 0 of userBasic reserved', async () => {
          expect(run.after.userBasicReserved).to.equal(run.before.userBasicReserved | 1n);
        });

        it('leaves assetsIn unchanged', async () => {
          expect(run.after.assetsIn).to.equal(run.before.assetsIn);
        });

        it('changes only membership, collateral accounting and token balances', async () => {
          expect(stateDiff(run)).to.deep.equal({
            assetsIn: 0n,
            userBasicReserved: 1n,
            principal: 0n,
            collateralBalance: SUPPLY_AMOUNT,
            totalSupplyAsset: SUPPLY_AMOUNT,
            aliceTokenBalance: -SUPPLY_AMOUNT,
            cometTokenBalance: SUPPLY_AMOUNT,
          });
        });
      });

      context('when the offset is 23 and 1 raw unit is supplied', function () {
        let run: OffsetRun;

        before(async () => {
          run = await runOffsetSupply(tokens.ASSET23);
        });

        after(resetFixture);

        it('uses the asset at offset 23', async () => {
          expect(run.offset).to.equal(23n);
        });

        it('sets bit 7 of userBasic reserved', async () => {
          expect(run.after.userBasicReserved).to.equal(run.before.userBasicReserved | (1n << 7n));
        });

        it('leaves assetsIn unchanged', async () => {
          expect(run.after.assetsIn).to.equal(run.before.assetsIn);
        });

        it('changes only membership, collateral accounting and token balances', async () => {
          expect(stateDiff(run)).to.deep.equal({
            assetsIn: 0n,
            userBasicReserved: 1n << 7n,
            principal: 0n,
            collateralBalance: SUPPLY_AMOUNT,
            totalSupplyAsset: SUPPLY_AMOUNT,
            aliceTokenBalance: -SUPPLY_AMOUNT,
            cometTokenBalance: SUPPLY_AMOUNT,
          });
        });
      });
    });
  });
}

// MinValues_SupplyBase and MinValues_Repay share the fixture and helpers, so one function registers both trees
[6, 8, 18].forEach(runMinimumBaseSupplyTests);

function runMinimumBaseSupplyTests(baseDecimals: number) {
  describe(`Minimum base amount supply and repay (${baseDecimals} decimals)`, function () {
    const SUPPLY_AMOUNT = 1n;
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

    interface Position {
      baseSupplyIndex?: bigint;
      baseBorrowIndex?: bigint;
      principal?: bigint;
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

    // F1 and F3 for supply, F2 and F3 for borrow (README section 4)
    const principalValueSupply = (presentValue: bigint, index: bigint): bigint => presentValue * BASE_INDEX_SCALE / index;
    const presentValueSupply = (principal: bigint, index: bigint): bigint => principal * index / BASE_INDEX_SCALE;
    const presentValueBorrow = (principal: bigint, index: bigint): bigint => principal * index / BASE_INDEX_SCALE;

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

    function stateDiff(run: { before: BaseState, after: BaseState }): BaseState {
      return Object.fromEntries(
        Object.keys(run.before).map((key) => [key, run.after[key] - run.before[key]])
      );
    }

    function expectedDiff(run: BaseRun, changes: BaseState): BaseState {
      const diff = Object.fromEntries(
        Object.keys(run.before).map((key) => [key, 0n])
      ) as BaseState;
      diff.aliceBaseTokenBalance = -SUPPLY_AMOUNT;
      diff.cometBaseTokenBalance = SUPPLY_AMOUNT;
      return { ...diff, ...changes };
    }

    // Totals mirror the single position, time stays frozen, so supply does not accrue (README 3.6)
    async function openPosition({ baseSupplyIndex = BASE_INDEX_SCALE, baseBorrowIndex = BASE_INDEX_SCALE, principal = 0n }: Position) {
      await setTotalsBasic(comet, {
        baseSupplyIndex,
        baseBorrowIndex,
        totalSupplyBase: principal > 0n ? principal : 0n,
        totalBorrowBase: principal < 0n ? -principal : 0n,
        lastAccrualTime: now,
      });
      await comet.setBasePrincipal(alice.address, principal);
      await base.allocateTo(alice.address, SUPPLY_AMOUNT);
      await base.connect(alice).approve(comet.address, SUPPLY_AMOUNT);
    }

    async function runSupply(): Promise<BaseRun> {
      const before = await readBaseState();
      const transaction = await wait(comet.connect(alice).supply(base.address, SUPPLY_AMOUNT));
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

    describe('Minimum base supply', function () {
      context('given baseSupplyIndex is above the initial index', function () {
        const BASE_SUPPLY_INDEX = exp(1.1, 15);

        context('when supplying 1 raw unit to an account with zero principal', function () {
          let run: BaseRun;

          before(async () => {
            await openPosition({ baseSupplyIndex: BASE_SUPPLY_INDEX });
            run = await runSupply();
          });

          after(resetFixture);

          it('keeps principal at 0', async () => {
            // Because floor of 1e15 over the index is 0 for any index from 1e15 plus 1.
            expect(run.after.alicePrincipal).to.equal(0n);
          });

          it('keeps totalSupplyBase unchanged', async () => {
            expect(run.after.totalSupplyBase).to.equal(run.before.totalSupplyBase);
          });

          it('emits Supply with amount 1', async () => {
            expect(event(run.transaction, 1)).to.deep.equal({
              Supply: {
                from: alice.address,
                dst: alice.address,
                amount: SUPPLY_AMOUNT,
              },
            });
          });

          it('does not emit Transfer from the zero address', async () => {
            expect(eventCount(run.transaction)).to.equal(2);
          });

          it('debits the user by exactly 1 raw unit', async () => {
            expect(run.after.aliceBaseTokenBalance).to.equal(run.before.aliceBaseTokenBalance - SUPPLY_AMOUNT);
          });

          it('credits Comet by exactly 1 raw unit', async () => {
            expect(run.after.cometBaseTokenBalance).to.equal(run.before.cometBaseTokenBalance + SUPPLY_AMOUNT);
          });

          it('reports balanceOf of the user as 0', async () => {
            expect(run.after.aliceBalanceOf).to.equal(0n);
          });

          it('increases getReserves by 1', async () => {
            expect(run.after.baseReserves).to.equal(run.before.baseReserves + SUPPLY_AMOUNT);
          });

          it('changes only token balances and reserves', async () => {
            expect(stateDiff(run)).to.deep.equal(expectedDiff(run, { baseReserves: SUPPLY_AMOUNT }));
          });
        });

        context('when the index is exactly 1e15 plus 1', function () {
          let run: BaseRun;

          before(async () => {
            await openPosition({ baseSupplyIndex: BASE_INDEX_SCALE + 1n });
            run = await runSupply();
          });

          after(resetFixture);

          it('already rounds the 1 raw unit principal to 0', async () => {
            // Boundary pair with SB-01, where the initial index 1e15 gives principal 1
            expect(run.after.alicePrincipal).to.equal(0n);
          });

          it('keeps totalSupplyBase unchanged', async () => {
            expect(run.after.totalSupplyBase).to.equal(run.before.totalSupplyBase);
          });
        });
      });

      context('when supplying 1 raw unit to an account with positive principal', function () {
        const PRINCIPAL = 10n;

        // The step cannot be crossed above the initial index: the principal step is worth more than 1 raw unit
        // and the present value rounds down, so floor(p * Is / S) + 1 < (p + 1) * Is / S for every Is above S.
        // The crossing branch therefore runs at the initial index, the only reachable state where it happens.
        context('given the added unit crosses a principal step', function () {
          let run: BaseRun;

          before(async () => {
            await openPosition({ principal: PRINCIPAL });
            run = await runSupply();
          });

          after(resetFixture);

          it('crosses a principal step', async () => {
            const expected = principalValueSupply(presentValueSupply(PRINCIPAL, BASE_INDEX_SCALE) + SUPPLY_AMOUNT, BASE_INDEX_SCALE);
            expect(expected).to.equal(PRINCIPAL + 1n);
          });

          it('increases principal by 1', async () => {
            expect(run.after.alicePrincipal).to.equal(run.before.alicePrincipal + 1n);
          });

          it('emits Transfer from the zero address', async () => {
            expect(eventArgs(run.transaction, 2, 'Transfer')).to.deep.equal({
              from: ethers.constants.AddressZero,
              to: alice.address,
              amount: SUPPLY_AMOUNT,
            });
          });

          it('changes only the principal, total supply and token balances', async () => {
            expect(stateDiff(run)).to.deep.equal(expectedDiff(run, {
              alicePrincipal: 1n,
              aliceBalanceOf: SUPPLY_AMOUNT,
              totalSupplyBase: 1n,
            }));
          });
        });

        context('given the added unit does not cross a principal step', function () {
          const BASE_SUPPLY_INDEX = exp(1.1, 15);

          let run: BaseRun;

          before(async () => {
            await openPosition({ baseSupplyIndex: BASE_SUPPLY_INDEX, principal: PRINCIPAL });
            run = await runSupply();
          });

          after(resetFixture);

          it('does not cross a principal step', async () => {
            const expected = principalValueSupply(presentValueSupply(PRINCIPAL, BASE_SUPPLY_INDEX) + SUPPLY_AMOUNT, BASE_SUPPLY_INDEX);
            expect(expected).to.equal(PRINCIPAL);
          });

          it('keeps principal unchanged', async () => {
            expect(run.after.alicePrincipal).to.equal(run.before.alicePrincipal);
          });

          it('does not emit Transfer from the zero address', async () => {
            expect(eventCount(run.transaction)).to.equal(2);
          });

          it('increases getReserves by 1', async () => {
            expect(run.after.baseReserves).to.equal(run.before.baseReserves + SUPPLY_AMOUNT);
          });

          it('changes only token balances and reserves', async () => {
            expect(stateDiff(run)).to.deep.equal(expectedDiff(run, { baseReserves: SUPPLY_AMOUNT }));
          });
        });
      });

      context('given the base price is 1', function () {
        let controlPrice: bigint;
        let minimumPrice: bigint;
        let control: BaseRun;
        let minimumPriceRun: BaseRun;
        let sentinelRun: BaseRun;

        before(async () => {
          await openPosition({});

          const scenarioSnapshot = await snapshot();
          controlPrice = toBigInt(await comet.getPrice(basePriceFeed.address));
          control = await runSupply();
          await revert(scenarioSnapshot);

          const minimumPriceSnapshot = await snapshot();
          await basePriceFeed.setRoundData(0, MINIMUM_PRICE, 0, 0, 0);
          minimumPrice = toBigInt(await comet.getPrice(basePriceFeed.address));
          minimumPriceRun = await runSupply();
          await revert(minimumPriceSnapshot);

          // Sentinel from README 3.4: any read of a 0 answer reverts with BadPrice
          await basePriceFeed.setRoundData(0, 0, 0, 0, 0);
          sentinelRun = await runSupply();
        });

        after(resetFixture);

        it('runs the control at the normal base price', async () => {
          expect(controlPrice).to.equal(NORMAL_PRICE);
        });

        it('uses the minimum valid base price', async () => {
          expect(minimumPrice).to.equal(MINIMUM_PRICE);
        });

        context('when supplying 1 raw unit', function () {
          it('produces the same state diff as at the normal base price', async () => {
            expect(stateDiff(minimumPriceRun)).to.deep.equal(stateDiff(control));
          });

          it('does not read the base price feed', async () => {
            // Sentinel check from README section 3.4.
            expect(sentinelRun.after.alicePrincipal).to.equal(SUPPLY_AMOUNT);
          });
        });
      });
    });

    describe('Minimum repay', function () {
      context('given the borrower has a debt above 1 raw unit', function () {
        const BASE_BORROW_INDEX = exp(1.05, 15);

        context('given the repay unit reduces the borrow principal', function () {
          const PRINCIPAL = -10n;

          let run: BaseRun;

          before(async () => {
            await openPosition({ baseBorrowIndex: BASE_BORROW_INDEX, principal: PRINCIPAL });
            run = await runSupply();
          });

          after(resetFixture);

          context('when repaying 1 raw unit', function () {
            it('decreases the principal magnitude by 1', async () => {
              expect(run.after.alicePrincipal).to.equal(PRINCIPAL + 1n);
            });

            it('decreases totalBorrowBase by 1', async () => {
              expect(run.after.totalBorrowBase).to.equal(run.before.totalBorrowBase - 1n);
            });

            it('emits Supply with amount 1', async () => {
              expect(eventArgs(run.transaction, 1, 'Supply').amount).to.equal(SUPPLY_AMOUNT);
            });

            it('debits the user by exactly 1 raw unit', async () => {
              expect(run.after.aliceBaseTokenBalance).to.equal(run.before.aliceBaseTokenBalance - SUPPLY_AMOUNT);
            });

            it('credits Comet by exactly 1 raw unit', async () => {
              expect(run.after.cometBaseTokenBalance).to.equal(run.before.cometBaseTokenBalance + SUPPLY_AMOUNT);
            });

            it('changes only the principal, total borrow and token balances', async () => {
              const debtBefore = presentValueBorrow(-PRINCIPAL, BASE_BORROW_INDEX);
              const debtAfter = presentValueBorrow(-PRINCIPAL - 1n, BASE_BORROW_INDEX);
              expect(stateDiff(run)).to.deep.equal(expectedDiff(run, {
                alicePrincipal: 1n,
                aliceBorrowBalanceOf: debtAfter - debtBefore,
                totalBorrowBase: -1n,
                baseReserves: SUPPLY_AMOUNT + debtAfter - debtBefore,
              }));
            });
          });
        });

        context('given the repay unit is absorbed by borrow rounding', function () {
          // At Ib 1.05e15, p = 20 is absorbed: D = 21 and ceil(20 * 1e15 / 1.05e15) = 20
          const PRINCIPAL = -20n;

          let run: BaseRun;

          before(async () => {
            await openPosition({ baseBorrowIndex: BASE_BORROW_INDEX, principal: PRINCIPAL });
            run = await runSupply();
          });

          after(resetFixture);

          context('when repaying 1 raw unit', function () {
            it('emits Supply with amount 1', async () => {
              expect(eventArgs(run.transaction, 1, 'Supply').amount).to.equal(SUPPLY_AMOUNT);
            });

            it('leaves the principal unchanged', async () => {
              expect(run.after.alicePrincipal).to.equal(run.before.alicePrincipal);
            });

            it('leaves totalBorrowBase unchanged', async () => {
              expect(run.after.totalBorrowBase).to.equal(run.before.totalBorrowBase);
            });

            it('leaves borrowBalanceOf unchanged', async () => {
              expect(run.after.aliceBorrowBalanceOf).to.equal(run.before.aliceBorrowBalanceOf);
            });

            it('debits the user by exactly 1 raw unit', async () => {
              expect(run.after.aliceBaseTokenBalance).to.equal(run.before.aliceBaseTokenBalance - SUPPLY_AMOUNT);
            });

            it('credits Comet by exactly 1 raw unit', async () => {
              expect(run.after.cometBaseTokenBalance).to.equal(run.before.cometBaseTokenBalance + SUPPLY_AMOUNT);
            });

            it('increases getReserves by 1', async () => {
              expect(run.after.baseReserves).to.equal(run.before.baseReserves + SUPPLY_AMOUNT);
            });

            it('changes only token balances and reserves', async () => {
              expect(stateDiff(run)).to.deep.equal(expectedDiff(run, { baseReserves: SUPPLY_AMOUNT }));
            });
          });
        });
      });

      context('given the borrower principal is minus 1', function () {
        context('given baseBorrowIndex is below twice the initial index', function () {
          const BASE_BORROW_INDEX = exp(1.5, 15);

          let run: BaseRun;

          before(async () => {
            await openPosition({ baseBorrowIndex: BASE_BORROW_INDEX, principal: -1n });
            run = await runSupply();
          });

          after(resetFixture);

          context('when repaying 1 raw unit', function () {
            it('sets principal to 0', async () => {
              expect(run.after.alicePrincipal).to.equal(0n);
            });

            it('decreases totalBorrowBase by 1', async () => {
              expect(run.after.totalBorrowBase).to.equal(run.before.totalBorrowBase - 1n);
            });

            it('reports borrowBalanceOf as 0', async () => {
              expect(run.after.aliceBorrowBalanceOf).to.equal(0n);
            });

            it('leaves no dust in the position', async () => {
              expect(run.after.aliceBalanceOf).to.equal(0n);
              expect(run.after.totalBorrowBase).to.equal(0n);
            });

            it('changes only the principal, total borrow and token balances', async () => {
              expect(stateDiff(run)).to.deep.equal(expectedDiff(run, {
                alicePrincipal: 1n,
                aliceBorrowBalanceOf: -1n,
                totalBorrowBase: -1n,
              }));
            });
          });
        });

        context('given baseBorrowIndex is at least twice the initial index', function () {
          const BASE_BORROW_INDEX = 2n * BASE_INDEX_SCALE;

          let run: BaseRun;

          before(async () => {
            await openPosition({ baseBorrowIndex: BASE_BORROW_INDEX, principal: -1n });
            run = await runSupply();
          });

          after(resetFixture);

          context('when repaying 1 raw unit', function () {
            it('leaves principal at minus 1', async () => {
              // RP-02 falls into R1 absorption: D = 2 and ceil(1 * 1e15 / 2e15) = 1
              expect(run.after.alicePrincipal).to.equal(-1n);
            });

            it('increases getReserves by 1', async () => {
              expect(run.after.baseReserves).to.equal(run.before.baseReserves + SUPPLY_AMOUNT);
            });

            it('changes only token balances and reserves', async () => {
              expect(stateDiff(run)).to.deep.equal(expectedDiff(run, { baseReserves: SUPPLY_AMOUNT }));
            });
          });
        });
      });
    });
  });
}
