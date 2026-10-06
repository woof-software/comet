import { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from '../build/types';
import { ethers, event, expect, exp, factor, defaultAssets, makeProtocol, mulPrice, portfolio, totalsAndReserves, wait, bumpTotalsCollateral, setTotalsBasic, TransactionResponseExt } from './helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

describe('absorb', function () {
  it('reverts if total borrows underflows', async () => {
    const { cometWithExtendedAssetList : comet, users: [absorber, underwater] } = await makeProtocol();

    const _f0 = await comet.setBasePrincipal(underwater.address, -100);
    await expect(comet.absorb(absorber.address, [underwater.address])).to.be.revertedWith('code 0x11 (Arithmetic operation underflowed or overflowed outside of an unchecked block)');
  });

  it('absorbs 1 account and pays out the absorber', async () => {
    const params = {
      supplyInterestRateBase: 0,
      supplyInterestRateSlopeLow: 0,
      supplyInterestRateSlopeHigh: 0,
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
      borrowInterestRateSlopeHigh: 0,
    };
    const protocol = await makeProtocol(params);
    const { cometWithExtendedAssetList : comet, priceFeeds, users: [absorber, underwater] } = protocol;

    await setTotalsBasic(comet, { totalBorrowBase: 100n });

    await comet.setBasePrincipal(underwater.address, -100);

    const r0 = await comet.getReserves();

    const pA0 = await portfolio(protocol, absorber.address);
    const pU0 = await portfolio(protocol, underwater.address);

    const a0 = await wait(comet.absorb(absorber.address, [underwater.address]));

    const t1 = await comet.totalsBasic();
    const r1 = await comet.getReserves();

    const pA1 = await portfolio(protocol, absorber.address);
    const pU1 = await portfolio(protocol, underwater.address);
    const lA1 = await comet.liquidatorPoints(absorber.address);
    const lU1 = await comet.liquidatorPoints(underwater.address);

    expect(r0).to.be.equal(100);

    expect(t1.totalSupplyBase).to.be.equal(0);
    expect(t1.totalBorrowBase).to.be.equal(0);
    expect(r1).to.be.equal(0);

    expect(pA0.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU0.internal).to.be.deep.equal({ COMP: 0n, USDC: -100n, WBTC: 0n, WETH: 0n });
    expect(pU0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(pA1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(lA1.numAbsorbs).to.be.equal(1);
    expect(lA1.numAbsorbed).to.be.equal(1);
    //expect(lA1.approxSpend).to.be.equal(1672498842684n);
    expect(lA1.approxSpend).to.be.lt(a0.receipt.gasUsed.mul(a0.receipt.effectiveGasPrice));

    expect(lU1.numAbsorbs).to.be.equal(0);
    expect(lU1.numAbsorbed).to.be.equal(0);
    expect(lU1.approxSpend).to.be.equal(0);

    const [_, usdcPrice] = await priceFeeds['USDC'].latestRoundData();
    const baseScale = await comet.baseScale();
    expect(event(a0, 0)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater.address,
        basePaidOut: 100n,
        usdValue: mulPrice(100n, usdcPrice, baseScale),
      }
    });
  });

  it('absorbs 2 accounts and pays out the absorber', async () => {
    const params = {
      supplyInterestRateBase: 0,
      supplyInterestRateSlopeLow: 0,
      supplyInterestRateSlopeHigh: 0,
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
      borrowInterestRateSlopeHigh: 0,
    };
    const protocol = await makeProtocol(params);
    const { cometWithExtendedAssetList : comet, priceFeeds, users: [absorber, underwater1, underwater2] } = protocol;

    await setTotalsBasic(comet, { totalBorrowBase: 2000n });

    const r0 = await comet.getReserves();

    await comet.setBasePrincipal(underwater1.address, -100);
    await comet.setBasePrincipal(underwater2.address, -700);

    const pA0 = await portfolio(protocol, absorber.address);
    const pU1_0 = await portfolio(protocol, underwater1.address);
    const pU2_0 = await portfolio(protocol, underwater2.address);

    const a0 = await wait(comet.absorb(absorber.address, [underwater1.address, underwater2.address]));

    const t1 = await comet.totalsBasic();
    const r1 = await comet.getReserves();

    const pA1 = await portfolio(protocol, absorber.address);
    const pU1_1 = await portfolio(protocol, underwater1.address);
    const pU2_1 = await portfolio(protocol, underwater2.address);
    const lA1 = await comet.liquidatorPoints(absorber.address);
    const _lU1_1 = await comet.liquidatorPoints(underwater1.address);
    const _lU2_1 = await comet.liquidatorPoints(underwater2.address);

    expect(r0).to.be.equal(2000);

    expect(t1.totalSupplyBase).to.be.equal(0n);
    expect(t1.totalBorrowBase).to.be.equal(1200n);
    expect(r1).to.be.equal(1200);

    expect(pA0.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1_0.internal).to.be.deep.equal({ COMP: 0n, USDC: -100n, WBTC: 0n, WETH: 0n });
    expect(pU1_0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU2_0.internal).to.be.deep.equal({ COMP: 0n, USDC: -700n, WBTC: 0n, WETH: 0n });
    expect(pU2_0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(pA1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1_1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1_1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU2_1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU2_1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(lA1.numAbsorbs).to.be.equal(1);
    expect(lA1.numAbsorbed).to.be.equal(2);
    //expect(lA1.approxSpend).to.be.equal(459757131288n);
    expect(lA1.approxSpend).to.be.lt(a0.receipt.gasUsed.mul(a0.receipt.effectiveGasPrice));

    const [_, usdcPrice] = await priceFeeds['USDC'].latestRoundData();
    const baseScale = await comet.baseScale();
    expect(event(a0, 0)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater1.address,
        basePaidOut: 100n,
        usdValue: mulPrice(100n, usdcPrice, baseScale),
      }
    });
    expect(event(a0, 1)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater2.address,
        basePaidOut: 700n,
        usdValue: mulPrice(700n, usdcPrice, baseScale),
      }
    });
  });

  it('absorbs 3 accounts with collateral and pays out the absorber', async () => {
    const params = {
      supplyInterestRateBase: 0,
      supplyInterestRateSlopeLow: 0,
      supplyInterestRateSlopeHigh: 0,
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
      borrowInterestRateSlopeHigh: 0,
    };
    const protocol = await makeProtocol(params);
    const { cometWithExtendedAssetList : comet, tokens, priceFeeds, users: [absorber, underwater1, underwater2, underwater3] } = protocol;
    const { COMP, WBTC, WETH } = tokens;

    await setTotalsBasic(comet, {
      totalBorrowBase: exp(3e15, 6),
      totalSupplyBase: exp(4e15, 6),
    });
    await bumpTotalsCollateral(comet, COMP, exp(1e-6, 18) + exp(10, 18) + exp(10000, 18));
    await bumpTotalsCollateral(comet, WETH, exp(1, 18) + exp(50, 18));
    await bumpTotalsCollateral(comet, WBTC, exp(50, 8));

    await comet.setBasePrincipal(underwater1.address, -exp(1, 6));
    await comet.setCollateralBalance(underwater1.address, COMP.address, exp(1e-6, 18));

    await comet.setBasePrincipal(underwater2.address, -exp(1, 12));
    await comet.setCollateralBalance(underwater2.address, COMP.address, exp(10, 18));
    await comet.setCollateralBalance(underwater2.address, WETH.address, exp(1, 18));

    await comet.setBasePrincipal(underwater3.address, -exp(1, 18));
    await comet.setCollateralBalance(underwater3.address, COMP.address, exp(10000, 18));
    await comet.setCollateralBalance(underwater3.address, WETH.address, exp(50, 18));
    await comet.setCollateralBalance(underwater3.address, WBTC.address, exp(50, 8));

    const pP0 = await portfolio(protocol, comet.address);
    const pA0 = await portfolio(protocol, absorber.address);
    const pU1_0 = await portfolio(protocol, underwater1.address);
    const pU2_0 = await portfolio(protocol, underwater2.address);
    const pU3_0 = await portfolio(protocol, underwater3.address);
    const cTR0 = await totalsAndReserves(protocol);

    const a0 = await wait(comet.absorb(absorber.address, [underwater1.address, underwater2.address, underwater3.address]));

    const t1 = await comet.totalsBasic();

    const pP1 = await portfolio(protocol, comet.address);
    const pA1 = await portfolio(protocol, absorber.address);
    const pU1_1 = await portfolio(protocol, underwater1.address);
    const pU2_1 = await portfolio(protocol, underwater2.address);
    const pU3_1 = await portfolio(protocol, underwater3.address);
    const lA1 = await comet.liquidatorPoints(absorber.address);
    const _lU1_1 = await comet.liquidatorPoints(underwater1.address);
    const _lU2_1 = await comet.liquidatorPoints(underwater2.address);
    const _lU3_1 = await comet.liquidatorPoints(underwater3.address);
    const cTR1 = await totalsAndReserves(protocol);

    expect(cTR0.totals).to.be.deep.equal({
      COMP: exp(1, 12) + exp(10, 18) + exp(10000, 18),
      USDC: exp(4e15, 6),
      WBTC: exp(50, 8),
      WETH: exp(1, 18) + exp(50, 18)
    });
    expect(cTR0.reserves).to.be.deep.equal({ COMP: 0n, USDC: -exp(1e15, 6), WBTC: 0n, WETH: 0n });

    expect(t1.totalSupplyBase).to.be.equal(exp(4e15, 6));
    expect(t1.totalBorrowBase).to.be.equal(exp(3e15, 6) - exp(1, 18) - exp(1, 12) - exp(1, 6));
    expect(cTR1.totals).to.be.deep.equal({ COMP: 0n, USDC: exp(4e15, 6), WBTC: 0n, WETH: 0n });
    expect(cTR1.reserves).to.be.deep.equal({
      COMP: exp(1, 12) + exp(10, 18) + exp(10000, 18),
      USDC: -exp(1e15, 6) - exp(1, 6) - exp(1, 12) - exp(1, 18),
      WBTC: exp(50, 8),
      WETH: exp(1, 18) + exp(50, 18)
    });

    expect(pP0.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pP0.external).to.be.deep.equal({
      COMP: exp(1, 12) + exp(10, 18) + exp(10000, 18),
      USDC: 0n,
      WBTC: exp(50, 8),
      WETH: exp(1, 18) + exp(50, 18)
    });
    expect(pA0.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1_0.internal).to.be.deep.equal({ COMP: exp(1, 12), USDC: -exp(1, 6), WBTC: 0n, WETH: 0n });
    expect(pU1_0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU2_0.internal).to.be.deep.equal({ COMP: exp(10, 18), USDC: -exp(1, 12), WBTC: 0n, WETH: exp(1, 18) });
    expect(pU2_0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU3_0.internal).to.be.deep.equal({ COMP: exp(10000, 18), USDC: -exp(1, 18), WBTC: exp(50, 8), WETH: exp(50, 18) });
    expect(pU3_0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(pP1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pP1.external).to.be.deep.equal({
      COMP: exp(1, 12) + exp(10, 18) + exp(10000, 18),
      USDC: 0n,
      WBTC: exp(50, 8),
      WETH: exp(1, 18) + exp(50, 18)
    });
    expect(pA1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1_1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1_1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU2_1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU2_1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU3_1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU3_1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(lA1.numAbsorbs).to.be.equal(1);
    expect(lA1.numAbsorbed).to.be.equal(3);
    //expect(lA1.approxSpend).to.be.equal(130651238630n);
    expect(lA1.approxSpend).to.be.lt(a0.receipt.gasUsed.mul(a0.receipt.effectiveGasPrice));

    const [_a, usdcPrice] = await priceFeeds['USDC'].latestRoundData();
    const [_b, compPrice] = await priceFeeds['COMP'].latestRoundData();
    const [_c, wbtcPrice] = await priceFeeds['WBTC'].latestRoundData();
    const [_d, wethPrice] = await priceFeeds['WETH'].latestRoundData();
    const baseScale = await comet.baseScale();
    const compScale = exp(1, await COMP.decimals());
    const wbtcScale = exp(1, await WBTC.decimals());
    const wethScale = exp(1, await WETH.decimals());
    // Underwater account 1
    expect(event(a0, 0)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater1.address,
        asset: COMP.address,
        collateralAbsorbed: exp(1, 12),
        usdValue: mulPrice(exp(1, 12), compPrice, compScale),
      }
    });
    expect(event(a0, 1)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater1.address,
        basePaidOut: exp(1, 6),
        usdValue: mulPrice(exp(1, 6), usdcPrice, baseScale),
      }
    });
    // Underwater account 2
    expect(event(a0, 2)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater2.address,
        asset: COMP.address,
        collateralAbsorbed: exp(10, 18),
        usdValue: mulPrice(exp(10, 18), compPrice, compScale),
      }
    });
    expect(event(a0, 3)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater2.address,
        asset: WETH.address,
        collateralAbsorbed: exp(1, 18),
        usdValue: mulPrice(exp(1, 18), wethPrice, wethScale),
      }
    });
    expect(event(a0, 4)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater2.address,
        basePaidOut: exp(1, 12),
        usdValue: mulPrice(exp(1, 12), usdcPrice, baseScale),
      }
    });
    // Underwater account 3
    expect(event(a0, 5)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater3.address,
        asset: COMP.address,
        collateralAbsorbed: exp(10000, 18),
        usdValue: mulPrice(exp(10000, 18), compPrice, compScale),
      }
    });
    expect(event(a0, 6)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater3.address,
        asset: WETH.address,
        collateralAbsorbed: exp(50, 18),
        usdValue: mulPrice(exp(50, 18), wethPrice, wethScale),
      }
    });
    expect(event(a0, 7)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater3.address,
        asset: WBTC.address,
        collateralAbsorbed: exp(50, 8),
        usdValue: mulPrice(exp(50, 8), wbtcPrice, wbtcScale),
      }
    });
    expect(event(a0, 8)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater3.address,
        basePaidOut: exp(1, 18),
        usdValue: mulPrice(exp(1, 18), usdcPrice, baseScale),
      }
    });
  });

  it('absorbs an account with more than enough collateral to still cover debt', async () => {
    const params = {
      supplyInterestRateBase: 0,
      supplyInterestRateSlopeLow: 0,
      supplyInterestRateSlopeHigh: 0,
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
      borrowInterestRateSlopeHigh: 0,
      assets: defaultAssets({
        borrowCF: factor(1 / 2),
        liquidateCF: factor(2 / 3),
      })
    };
    const protocol = await makeProtocol(params);
    const { cometWithExtendedAssetList : comet, tokens, users: [absorber, underwater], priceFeeds } = protocol;
    const { COMP, WBTC, WETH } = tokens;

    const finalDebt = 1n;
    const startingDebt = finalDebt - (exp(41000, 6) + exp(3000, 6) + exp(175, 6));
    await setTotalsBasic(comet, {
      totalBorrowBase: -startingDebt,
    });
    await bumpTotalsCollateral(comet, COMP, exp(1, 18));
    await bumpTotalsCollateral(comet, WETH, exp(1, 18));
    await bumpTotalsCollateral(comet, WBTC, exp(1, 8));

    const r0 = await comet.getReserves();

    await comet.setBasePrincipal(underwater.address, startingDebt);
    await comet.setCollateralBalance(underwater.address, COMP.address, exp(1, 18));
    await comet.setCollateralBalance(underwater.address, WETH.address, exp(1, 18));
    await comet.setCollateralBalance(underwater.address, WBTC.address, exp(1, 8));

    const pP0 = await portfolio(protocol, comet.address);
    const pA0 = await portfolio(protocol, absorber.address);
    const pU0 = await portfolio(protocol, underwater.address);

    const a0 = await wait(comet.absorb(absorber.address, [underwater.address]));

    const t1 = await comet.totalsBasic();
    const r1 = await comet.getReserves();

    const pP1 = await portfolio(protocol, comet.address);
    const pA1 = await portfolio(protocol, absorber.address);
    const pU1 = await portfolio(protocol, underwater.address);
    const lA1 = await comet.liquidatorPoints(absorber.address);
    const _lU1 = await comet.liquidatorPoints(underwater.address);

    expect(r0).to.be.equal(-startingDebt);
    expect(t1.totalSupplyBase).to.be.equal(finalDebt);
    expect(t1.totalBorrowBase).to.be.equal(0);
    expect(r1).to.be.equal(-finalDebt);

    expect(pP0.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pP0.external).to.be.deep.equal({ COMP: exp(1, 18), USDC: 0n, WBTC: exp(1, 8), WETH: exp(1, 18) });
    expect(pA0.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU0.internal).to.be.deep.equal({ COMP: exp(1, 18), USDC: startingDebt, WBTC: exp(1, 8), WETH: exp(1, 18) });
    expect(pU0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(pP1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pP1.external).to.be.deep.equal({ COMP: exp(1, 18), USDC: 0n, WBTC: exp(1, 8), WETH: exp(1, 18) });
    expect(pA1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1.internal).to.be.deep.equal({ COMP: 0n, USDC: 1n, WBTC: 0n, WETH: 0n });
    expect(pU1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(lA1.numAbsorbs).to.be.equal(1);
    expect(lA1.numAbsorbed).to.be.equal(1);
    //expect(lA1.approxSpend).to.be.equal(1672498842684n);
    expect(lA1.approxSpend).to.be.lt(a0.receipt.gasUsed.mul(a0.receipt.effectiveGasPrice));

    const [_a, usdcPrice] = await priceFeeds['USDC'].latestRoundData();
    const [_b, compPrice] = await priceFeeds['COMP'].latestRoundData();
    const [_c, wbtcPrice] = await priceFeeds['WBTC'].latestRoundData();
    const [_d, wethPrice] = await priceFeeds['WETH'].latestRoundData();
    const baseScale = await comet.baseScale();
    const compScale = exp(1, await COMP.decimals());
    const wbtcScale = exp(1, await WBTC.decimals());
    const wethScale = exp(1, await WETH.decimals());
    expect(event(a0, 0)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater.address,
        asset: COMP.address,
        collateralAbsorbed: exp(1, 18),
        usdValue: mulPrice(exp(1, 18), compPrice, compScale),
      }
    });
    expect(event(a0, 1)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater.address,
        asset: WETH.address,
        collateralAbsorbed: exp(1, 18),
        usdValue: mulPrice(exp(1, 18), wethPrice, wethScale),
      }
    });
    expect(event(a0, 2)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater.address,
        asset: WBTC.address,
        collateralAbsorbed: exp(1, 8),
        usdValue: mulPrice(exp(1, 8), wbtcPrice, wbtcScale),
      }
    });
    expect(event(a0, 3)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater.address,
        basePaidOut: pU1.internal.USDC - startingDebt,
        usdValue: mulPrice(pU1.internal.USDC - startingDebt, usdcPrice, baseScale),
      }
    });
    expect(event(a0, 4)).to.be.deep.equal({
      Transfer: {
        amount: finalDebt,
        from: ethers.constants.AddressZero,
        to: underwater.address,
      }
    });
  });

  it('reverts if an account is not underwater', async () => {
    const { cometWithExtendedAssetList : comet, users: [alice, bob] } = await makeProtocol();

    await expect(comet.absorb(alice.address, [bob.address])).to.be.revertedWith("custom error 'NotLiquidatable()'");
  });

  it.skip('reverts if collateral asset value overflows base balance', async () => {
    // XXX
  });

  it('reverts if absorb is paused', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList : comet, pauseGuardian, users: [alice, bob] } = protocol;

    const cometAsB = comet.connect(bob);

    // Pause transfer
    await wait(comet.connect(pauseGuardian).pause(false, false, false, true, false));
    expect(await comet.isAbsorbPaused()).to.be.true;

    await expect(cometAsB.absorb(bob.address, [alice.address])).to.be.revertedWith("custom error 'Paused()'");
  });

  it('updates assetsIn for liquidated account', async () => {
    const { cometWithExtendedAssetList : comet, users: [absorber, underwater], tokens } = await makeProtocol();
    const { COMP, WETH } = tokens;

    await bumpTotalsCollateral(comet, COMP, exp(1, 18));
    await bumpTotalsCollateral(comet, WETH, exp(1, 18));

    await comet.setCollateralBalance(underwater.address, COMP.address, exp(1, 18));
    await comet.setCollateralBalance(underwater.address, WETH.address, exp(1, 18));

    expect(await comet.getAssetList(underwater.address)).to.deep.equal([
      COMP.address,
      WETH.address,
    ]);

    const borrowAmount = exp(4000, 6); // borrow of $4k > collateral of $3k + $175
    await comet.setBasePrincipal(underwater.address, -borrowAmount);
    await setTotalsBasic(comet, { totalBorrowBase: borrowAmount });

    const isLiquidatable = await comet.isLiquidatable(underwater.address);

    expect(isLiquidatable).to.be.true;

    await comet.absorb(absorber.address, [underwater.address]);

    expect(await comet.getAssetList(underwater.address)).to.be.empty;
  });

  it('updates assetsIn for liquidated account in 24 assets', async () => {
    const protocol = await makeProtocol({
      assets: {
        // 24 assets
        COMP: {
          initial: 1e7,
          decimals: 18,
          initialPrice: 175,
        },
        WETH: {
          initial: 1e4,
          decimals: 18,
          initialPrice: 3000,
        },
        WBTC: {
          initial: 1e3,
          decimals: 8,
          initialPrice: 41000,
        },
        ASSET3: {},
        ASSET4: {},
        ASSET5: {},
        ASSET6: {},
        ASSET7: {},
        ASSET8: {},
        ASSET9: {},
        ASSET10: {},
        ASSET11: {},
        ASSET12: {},
        ASSET13: {},
        ASSET14: {},
        ASSET15: {},
        ASSET16: {},
        ASSET17: {},
        ASSET18: {},
        ASSET19: {},
        ASSET20: {},
        ASSET21: {},
        ASSET22: {},
        ASSET23: {},
        USDC: {
          initial: 1e6,
          decimals: 6,
        },
      },
      reward: 'COMP',
    });
    const { cometWithExtendedAssetList : comet, tokens: {
      COMP,
      WETH,
    }, users: [absorber, underwater] } = protocol;

    await bumpTotalsCollateral(comet, COMP, exp(1, 18));
    await bumpTotalsCollateral(comet, WETH, exp(1, 18));

    await comet.setCollateralBalance(underwater.address, COMP.address, exp(1, 18));
    await comet.setCollateralBalance(underwater.address, WETH.address, exp(1, 18));

    
    for (let i = 3; i < 24; i++) {
      const asset = `ASSET${i}`;
      await bumpTotalsCollateral(comet, protocol.tokens[asset], exp(1, 18));
      await comet.setCollateralBalance(underwater.address, protocol.tokens[asset].address, exp(1, 18));
    }

    expect(await comet.getAssetList(underwater.address)).to.deep.equal([
      COMP.address,
      WETH.address,
      ...Array.from({ length: 21 }, (_, i) => protocol.tokens[`ASSET${i + 3}`].address),
    ]);

    const borrowAmount = exp(4000, 6); // borrow of $4k > collateral of $3k + $175
    await comet.setBasePrincipal(underwater.address, -borrowAmount);
    await setTotalsBasic(comet, { totalBorrowBase: borrowAmount });

    const isLiquidatable = await comet.isLiquidatable(underwater.address);

    expect(isLiquidatable).to.be.true;

    await comet.absorb(absorber.address, [underwater.address]);

    expect(await comet.getAssetList(underwater.address)).to.be.empty;
  });
});
[6, 8, 18].forEach((baseDecimals) =>
  [6, 8, 18].forEach((collateralDecimals) => runMinimumPriceAbsorbTests(baseDecimals, collateralDecimals))
);

function runMinimumPriceAbsorbTests(baseDecimals: number, collateralDecimals: number) {
  describe(`Minimum price absorb (base ${baseDecimals} decimals, collateral ${collateralDecimals} decimals)`, function () {
    const NORMAL_PRICE = exp(1, 8);
    const MINIMUM_PRICE = 1n;
    const FACTOR_SCALE = exp(1, 18);
    const BASE_INDEX_SCALE = exp(1, 15);
    const LIQUIDATE_CF = exp(0.85, 18);
    const LIQUIDATION_FACTOR = exp(0.9, 18);
    const baseScale = exp(1, baseDecimals);
    const collateralScale = exp(1, collateralDecimals);

    type AbsorbState = Record<string, bigint>;
    type EventArgs = Record<string, bigint | string>;

    interface AbsorbRun {
      before: AbsorbState;
      after: AbsorbState;
      transaction: TransactionResponseExt;
    }

    interface AbsorbCase {
      control: AbsorbRun;
      minimumPriceRun: AbsorbRun;
    }

    interface AbsorbOutcome {
      value: bigint;
      deltaBase: bigint;
      newBalance: bigint;
      basePaidOut: bigint;
      valueOfBasePaidOut: bigint;
    }

    interface Position {
      debt: bigint;
      collateralBalance: bigint;
      totalSupplyBase?: bigint;
      totalBorrowBase?: bigint;
    }

    let comet: CometHarnessInterfaceExtendedAssetList;
    let collateral: FaucetToken;
    let base: FaucetToken;
    let basePriceFeed: SimplePriceFeed;
    let collateralPriceFeed: SimplePriceFeed;
    let absorber: SignerWithAddress;
    let borrower: SignerWithAddress;
    let assetMask: bigint;
    let now: bigint;
    let initialSnapshot: string;

    const snapshot = (): Promise<string> => ethers.provider.send('evm_snapshot', []);
    const revert = (id: string): Promise<boolean> => ethers.provider.send('evm_revert', [id]);
    const toBigInt = (value: { toString(): string }): bigint => BigInt(value.toString());
    const eventCount = (transaction: TransactionResponseExt): number => transaction.receipt['events'].length;
    const eventArgs = (transaction: TransactionResponseExt, index: number, name: string): EventArgs =>
      (event(transaction, index) as Record<string, EventArgs>)[name];

    // F4: collateral value
    function collateralValue(balance: bigint, price: bigint): bigint {
      return balance * price / collateralScale;
    }

    // F4 + F5: liquidity as computed by isLiquidatable for a single collateral asset.
    // BigInt division truncates toward zero, same as signedMulPrice in Solidity.
    function liquidity(debt: bigint, basePrice: bigint, balance: bigint, collateralPrice: bigint): bigint {
      return (-debt * basePrice) / baseScale + collateralValue(balance, collateralPrice) * LIQUIDATE_CF / FACTOR_SCALE;
    }

    // F6: outcome of absorbInternal for a single collateral asset
    function absorbOutcome(oldBalance: bigint, basePrice: bigint, balance: bigint, collateralPrice: bigint): AbsorbOutcome {
      const value = collateralValue(balance, collateralPrice);
      const deltaBase = value * LIQUIDATION_FACTOR / FACTOR_SCALE * baseScale / basePrice;
      const unclamped = oldBalance + deltaBase;
      const newBalance = unclamped < 0n ? 0n : unclamped;
      const basePaidOut = newBalance - oldBalance;
      return {
        value,
        deltaBase,
        newBalance,
        basePaidOut,
        valueOfBasePaidOut: basePaidOut * basePrice / baseScale,
      };
    }

    async function readAccountState(account: SignerWithAddress): Promise<AbsorbState> {
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

    function prefixState(prefix: string, state: AbsorbState): AbsorbState {
      return Object.fromEntries(
        Object.entries(state).map(([key, value]) => [
          `${prefix}${key[0].toUpperCase()}${key.slice(1)}`,
          value,
        ])
      );
    }

    async function readAbsorbState(): Promise<AbsorbState> {
      const [absorberState, borrowerState, totalsBasic, totalsCollateral] = await Promise.all([
        readAccountState(absorber),
        readAccountState(borrower),
        comet.totalsBasic(),
        comet.totalsCollateral(collateral.address),
      ]);

      return {
        ...prefixState('absorber', absorberState),
        ...prefixState('borrower', borrowerState),
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

    function stateDiff(run: { before: AbsorbState, after: AbsorbState }): AbsorbState {
      return Object.fromEntries(
        Object.keys(run.before).map((key) => [key, run.after[key] - run.before[key]])
      );
    }

    // approxSpend depends on gas used and base fee, so it is excluded from cross-run comparisons
    function withoutGasSpend(diff: AbsorbState): AbsorbState {
      const { absorberLiquidatorApproxSpend: _spend, ...rest } = diff;
      return rest;
    }

    // Zero diff plus the liquidator points every successful absorb of one account writes
    function expectedAbsorbDiff(run: AbsorbRun, changes: AbsorbState): AbsorbState {
      const expectedDiff = Object.fromEntries(
        Object.keys(run.before).map((key) => [key, 0n])
      ) as AbsorbState;
      expectedDiff.absorberLiquidatorNumAbsorbs = 1n;
      expectedDiff.absorberLiquidatorNumAbsorbed = 1n;
      expectedDiff.absorberLiquidatorApproxSpend = stateDiff(run).absorberLiquidatorApproxSpend;
      return { ...expectedDiff, ...changes };
    }

    async function setPrice(priceFeed: SimplePriceFeed, price: bigint) {
      await priceFeed.setRoundData(0, price, 0, 0, 0);
    }

    // Debt is set at the initial borrow index, so principal and present value are equal
    async function openPosition({ debt, collateralBalance, totalSupplyBase = 0n, totalBorrowBase = debt }: Position) {
      await setTotalsBasic(comet, { totalSupplyBase, totalBorrowBase, lastAccrualTime: now });
      await comet.setBasePrincipal(borrower.address, -debt);
      if (collateralBalance > 0n) {
        await bumpTotalsCollateral(comet, collateral, collateralBalance);
        await comet.setCollateralBalance(borrower.address, collateral.address, collateralBalance);
      }
    }

    async function runAbsorb(): Promise<AbsorbRun> {
      const before = await readAbsorbState();
      const transaction = await wait(comet.absorb(absorber.address, [borrower.address]));
      const after = await readAbsorbState();
      return { before, after, transaction };
    }

    async function runAbsorbWithControl(setMinimumPrices: () => Promise<unknown>): Promise<AbsorbCase> {
      const scenarioSnapshot = await snapshot();
      const control = await runAbsorb();

      await revert(scenarioSnapshot);

      await setMinimumPrices();
      const minimumPriceRun = await runAbsorb();

      return { control, minimumPriceRun };
    }

    async function resetFixture() {
      await revert(initialSnapshot);
      initialSnapshot = await snapshot();
    }

    function shouldUpdateLiquidatorPoints(getRun: () => AbsorbRun) {
      it('increments numAbsorbs of the absorber', async () => {
        const { before, after } = getRun();
        expect(after.absorberLiquidatorNumAbsorbs).to.equal(before.absorberLiquidatorNumAbsorbs + 1n);
      });

      it('increments numAbsorbed of the absorber by one account', async () => {
        const { before, after } = getRun();
        expect(after.absorberLiquidatorNumAbsorbed).to.equal(before.absorberLiquidatorNumAbsorbed + 1n);
      });

      it('increases approxSpend of the absorber by at most the transaction cost', async () => {
        const run = getRun();
        const { receipt } = run.transaction;
        expect(stateDiff(run).absorberLiquidatorApproxSpend).to.be.gte(0n);
        expect(stateDiff(run).absorberLiquidatorApproxSpend).to.be.lte(receipt.gasUsed.mul(receipt.effectiveGasPrice).toBigInt());
      });
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
            borrowCF: exp(0.8, 18),
            liquidateCF: LIQUIDATE_CF,
            liquidationFactor: LIQUIDATION_FACTOR,
            supplyCap: exp(100, collateralDecimals),
          },
        },
      });

      comet = protocol.cometWithExtendedAssetList;
      collateral = protocol.tokens.TOKEN as FaucetToken;
      base = protocol.tokens.USDC as FaucetToken;
      basePriceFeed = protocol.priceFeeds.USDC as SimplePriceFeed;
      collateralPriceFeed = protocol.priceFeeds.TOKEN as SimplePriceFeed;
      [absorber, borrower] = protocol.users;

      const assetInfo = await comet.getAssetInfoByAddress(collateral.address);
      assetMask = 1n << toBigInt(assetInfo.offset);

      // Freeze time so absorb does not accrue between setup and action (README 3.6)
      now = toBigInt(await comet.getNow());
      await comet.setNow(now);
      await setTotalsBasic(comet, { lastAccrualTime: now });

      initialSnapshot = await snapshot();
    });

    after(async () => {
      await revert(initialSnapshot);
    });

    context('given the account is liquidatable at the normal base price', function () {
      // 1 whole token at 1 USD: value 1e8, contribution 0.85e8, debt of 1 whole base valued 1e8
      const COLLATERAL_BALANCE = collateralScale;
      const DEBT = baseScale;

      let liquidatableAtNormalPrice: boolean;
      let liquidatableAtMinimumPrice: boolean;
      let stateBefore: AbsorbState;
      let stateAfter: AbsorbState;

      before(async () => {
        await openPosition({ debt: DEBT, collateralBalance: COLLATERAL_BALANCE });
        await setPrice(collateralPriceFeed, NORMAL_PRICE);
        liquidatableAtNormalPrice = await comet.isLiquidatable(borrower.address);

        await setPrice(basePriceFeed, MINIMUM_PRICE);
        liquidatableAtMinimumPrice = await comet.isLiquidatable(borrower.address);

        stateBefore = await readAbsorbState();
        await expect(comet.absorb(absorber.address, [borrower.address])).to.be.reverted;
        stateAfter = await readAbsorbState();
      });

      after(resetFixture);

      it('is liquidatable at the normal base price', async () => {
        expect(liquidatableAtNormalPrice).to.be.true;
      });

      it('has a collateral contribution of at least the debt value at base price 1', async () => {
        const debtValue = DEBT * MINIMUM_PRICE / baseScale;
        const contribution = collateralValue(COLLATERAL_BALANCE, NORMAL_PRICE) * LIQUIDATE_CF / FACTOR_SCALE;
        expect(contribution).to.be.gte(debtValue);
      });

      context('when the base price drops to 1', function () {
        it('makes isLiquidatable return false', async () => {
          // The debt value per F5 shrinks by 1e8 while the contribution is unchanged.
          // The precondition is required: AB-02 keeps a smaller contribution and stays liquidatable.
          expect(liquidatableAtMinimumPrice).to.be.false;
        });

        context('when absorbing', function () {
          it('reverts with NotLiquidatable', async () => {
            await expect(
              comet.callStatic.absorb(absorber.address, [borrower.address])
            ).to.be.revertedWith("custom error 'NotLiquidatable()'");
          });

          it('leaves all state unchanged', async () => {
            expect(stateAfter).to.deep.equal(stateBefore);
          });
        });
      });
    });

    context('given the base price is 1 and the account is liquidatable', function () {
      // 1 whole token priced at 100: value 100, contribution floor(100 * 0.85) = 85, seized floor(100 * 0.9) = 90
      const COLLATERAL_BALANCE = collateralScale;
      const COLLATERAL_PRICE = 100n;

      context('given the seized collateral value in base is at most the debt', function () {
        const DEBT = 100n * baseScale;
        const outcome = absorbOutcome(-DEBT, MINIMUM_PRICE, COLLATERAL_BALANCE, COLLATERAL_PRICE);

        let absorbCase: AbsorbCase;
        let balanceAfter: bigint;
        let borrowBalanceAfter: bigint;

        before(async () => {
          await openPosition({ debt: DEBT, collateralBalance: COLLATERAL_BALANCE });
          await setPrice(collateralPriceFeed, COLLATERAL_PRICE);
          absorbCase = await runAbsorbWithControl(() => setPrice(basePriceFeed, MINIMUM_PRICE));
          balanceAfter = toBigInt(await comet.balanceOf(borrower.address));
          borrowBalanceAfter = toBigInt(await comet.borrowBalanceOf(borrower.address));
        });

        after(resetFixture);

        it('starts liquidatable with liquidity -100 + 85 = -15', async () => {
          expect(liquidity(DEBT, MINIMUM_PRICE, COLLATERAL_BALANCE, COLLATERAL_PRICE)).to.equal(-15n);
        });

        it('seizes 90 whole base units, which does not exceed the debt', async () => {
          expect(outcome.deltaBase).to.equal(90n * baseScale);
          expect(outcome.deltaBase).to.be.lte(DEBT);
        });

        context('when absorbing', function () {
          it('clamps the new balance to 0', async () => {
            expect(balanceAfter).to.equal(0n);
            expect(borrowBalanceAfter).to.equal(0n);
          });

          it('sets principal to 0', async () => {
            expect(absorbCase.minimumPriceRun.after.borrowerPrincipal).to.equal(0n);
          });

          it('emits AbsorbDebt with basePaidOut equal to the old debt', async () => {
            expect(event(absorbCase.minimumPriceRun.transaction, 1)).to.deep.equal({
              AbsorbDebt: {
                absorber: absorber.address,
                borrower: borrower.address,
                basePaidOut: DEBT,
                usdValue: DEBT * MINIMUM_PRICE / baseScale,
              },
            });
          });

          it('emits no Transfer to the borrower', async () => {
            expect(eventCount(absorbCase.minimumPriceRun.transaction)).to.equal(2);
          });

          it('produces the same outcome as ordinary bad debt', async () => {
            // The control run at the normal base price is ordinary bad debt: the clamp also fires there
            expect(withoutGasSpend(stateDiff(absorbCase.minimumPriceRun)))
              .to.deep.equal(withoutGasSpend(stateDiff(absorbCase.control)));
          });

          it('pays out the old debt in the control run as well', async () => {
            expect(eventArgs(absorbCase.control.transaction, 1, 'AbsorbDebt').basePaidOut).to.equal(DEBT);
          });

          it('changes only the absorbed position, totals, reserves and liquidator points', async () => {
            const run = absorbCase.minimumPriceRun;
            expect(stateDiff(run)).to.deep.equal(expectedAbsorbDiff(run, {
              borrowerPrincipal: DEBT,
              borrowerAssetsIn: -assetMask,
              borrowerCollateralBalance: -COLLATERAL_BALANCE,
              totalBorrowBase: -DEBT,
              totalSupplyAsset: -COLLATERAL_BALANCE,
              baseReserves: -DEBT,
              collateralReserves: COLLATERAL_BALANCE,
            }));
          });

          shouldUpdateLiquidatorPoints(() => absorbCase.minimumPriceRun);
        });
      });

      context('given the seized collateral value in base exceeds the debt', function () {
        const DEBT = 86n * baseScale;
        const SEIZED = 90n * baseScale;
        const NEW_BALANCE = 4n * baseScale;
        const outcome = absorbOutcome(-DEBT, MINIMUM_PRICE, COLLATERAL_BALANCE, COLLATERAL_PRICE);

        let absorbCase: AbsorbCase;
        let balanceAfter: bigint;

        before(async () => {
          await openPosition({ debt: DEBT, collateralBalance: COLLATERAL_BALANCE });
          await setPrice(collateralPriceFeed, COLLATERAL_PRICE);
          absorbCase = await runAbsorbWithControl(() => setPrice(basePriceFeed, MINIMUM_PRICE));
          balanceAfter = toBigInt(await comet.balanceOf(borrower.address));
        });

        after(resetFixture);

        it('starts liquidatable with liquidity -86 + 85 = -1', async () => {
          expect(liquidity(DEBT, MINIMUM_PRICE, COLLATERAL_BALANCE, COLLATERAL_PRICE)).to.equal(-1n);
        });

        it('computes a new balance of 4 whole base units', async () => {
          expect(outcome.newBalance).to.equal(NEW_BALANCE);
        });

        context('when absorbing', function () {
          it('credits the borrower with a positive principal', async () => {
            // USDC example: collateral value 100, debt 86 USDC, delta 90 USDC, new balance 4 USDC.
            expect(absorbCase.minimumPriceRun.after.borrowerPrincipal).to.equal(NEW_BALANCE);
          });

          it('reports balanceOf as 4 whole base units', async () => {
            expect(balanceAfter).to.equal(NEW_BALANCE);
          });

          it('decreases totalBorrowBase by the old borrow principal', async () => {
            const { before, after } = absorbCase.minimumPriceRun;
            expect(after.totalBorrowBase).to.equal(before.totalBorrowBase - DEBT);
          });

          it('increases totalSupplyBase by the new principal', async () => {
            const { before, after } = absorbCase.minimumPriceRun;
            expect(after.totalSupplyBase).to.equal(before.totalSupplyBase + NEW_BALANCE);
          });

          it('emits AbsorbCollateral with the collateral value 100', async () => {
            expect(event(absorbCase.minimumPriceRun.transaction, 0)).to.deep.equal({
              AbsorbCollateral: {
                absorber: absorber.address,
                borrower: borrower.address,
                asset: collateral.address,
                collateralAbsorbed: COLLATERAL_BALANCE,
                usdValue: 100n,
              },
            });
          });

          it('emits AbsorbDebt with basePaidOut 90 whole base units and value 90', async () => {
            expect(event(absorbCase.minimumPriceRun.transaction, 1)).to.deep.equal({
              AbsorbDebt: {
                absorber: absorber.address,
                borrower: borrower.address,
                basePaidOut: SEIZED,
                usdValue: 90n,
              },
            });
          });

          it('emits Transfer from the zero address to the borrower', async () => {
            expect(event(absorbCase.minimumPriceRun.transaction, 2)).to.deep.equal({
              Transfer: {
                from: ethers.constants.AddressZero,
                to: borrower.address,
                amount: NEW_BALANCE,
              },
            });
          });

          it('decreases getReserves by 90 whole base units', async () => {
            const { before, after } = absorbCase.minimumPriceRun;
            expect(after.baseReserves).to.equal(before.baseReserves - SEIZED);
          });

          it('leaves the borrower principal at 0 in the control run at the normal base price', async () => {
            expect(absorbCase.control.after.borrowerPrincipal).to.equal(0n);
          });

          it('keeps totalSupplyBase unchanged in the control run', async () => {
            const { before, after } = absorbCase.control;
            expect(after.totalSupplyBase).to.equal(before.totalSupplyBase);
          });

          it('emits no Transfer to the borrower in the control run', async () => {
            expect(eventCount(absorbCase.control.transaction)).to.equal(2);
          });

          it('differs from the control run by the credited principal', async () => {
            const { control, minimumPriceRun } = absorbCase;
            expect(minimumPriceRun.after.borrowerPrincipal - control.after.borrowerPrincipal).to.equal(NEW_BALANCE);
          });

          it('changes only the absorbed position, totals, reserves and liquidator points', async () => {
            const run = absorbCase.minimumPriceRun;
            expect(stateDiff(run)).to.deep.equal(expectedAbsorbDiff(run, {
              borrowerPrincipal: DEBT + NEW_BALANCE,
              borrowerAssetsIn: -assetMask,
              borrowerCollateralBalance: -COLLATERAL_BALANCE,
              totalSupplyBase: NEW_BALANCE,
              totalBorrowBase: -DEBT,
              totalSupplyAsset: -COLLATERAL_BALANCE,
              baseReserves: -SEIZED,
              collateralReserves: COLLATERAL_BALANCE,
            }));
          });

          shouldUpdateLiquidatorPoints(() => absorbCase.minimumPriceRun);
        });
      });
    });

    context('given 1 raw unit of collateral valued 0', function () {
      // At collateral price 1, floor(1 * 1 / scale_c) is 0 for every collateral decimals
      const COLLATERAL_BALANCE = 1n;
      const DEBT = baseScale;
      const outcome = absorbOutcome(-DEBT, NORMAL_PRICE, COLLATERAL_BALANCE, MINIMUM_PRICE);

      let run: AbsorbRun;

      before(async () => {
        await openPosition({ debt: DEBT, collateralBalance: COLLATERAL_BALANCE });
        await setPrice(collateralPriceFeed, MINIMUM_PRICE);
        run = await runAbsorb();
      });

      after(resetFixture);

      it('values the collateral at 0', async () => {
        expect(outcome.value).to.equal(0n);
      });

      context('when absorbing a liquidatable account holding it', function () {
        it('emits AbsorbCollateral with amount 1 and value 0', async () => {
          expect(event(run.transaction, 0)).to.deep.equal({
            AbsorbCollateral: {
              absorber: absorber.address,
              borrower: borrower.address,
              asset: collateral.address,
              collateralAbsorbed: COLLATERAL_BALANCE,
              usdValue: 0n,
            },
          });
        });

        it('increases getCollateralReserves by 1', async () => {
          expect(run.after.collateralReserves).to.equal(run.before.collateralReserves + COLLATERAL_BALANCE);
        });

        it('sets userCollateral balance to 0', async () => {
          expect(run.after.borrowerCollateralBalance).to.equal(0n);
        });

        it('decreases totalSupplyAsset by 1', async () => {
          expect(run.after.totalSupplyAsset).to.equal(run.before.totalSupplyAsset - COLLATERAL_BALANCE);
        });

        it('clears the membership bit', async () => {
          expect(run.before.borrowerAssetsIn & assetMask).to.equal(assetMask);
          expect(run.after.borrowerAssetsIn & assetMask).to.equal(0n);
        });

        context('settling the debt by clamping the new balance at 0', function () {
          it('adds nothing to the balance from the seized collateral', async () => {
            expect(outcome.deltaBase).to.equal(0n);
          });

          it('clamps the principal to 0', async () => {
            expect(run.after.borrowerPrincipal).to.equal(0n);
          });

          it('decreases totalBorrowBase by the whole debt', async () => {
            expect(run.after.totalBorrowBase).to.equal(run.before.totalBorrowBase - DEBT);
          });

          it('decreases getReserves by the whole debt', async () => {
            expect(run.after.baseReserves).to.equal(run.before.baseReserves - DEBT);
          });

          it('emits AbsorbDebt with basePaidOut equal to the debt', async () => {
            expect(event(run.transaction, 1)).to.deep.equal({
              AbsorbDebt: {
                absorber: absorber.address,
                borrower: borrower.address,
                basePaidOut: DEBT,
                usdValue: outcome.valueOfBasePaidOut,
              },
            });
          });

          it('emits no Transfer to the borrower', async () => {
            expect(eventCount(run.transaction)).to.equal(2);
          });
        });

        shouldUpdateLiquidatorPoints(() => run);

        it('changes only the absorbed position, totals, reserves and liquidator points', async () => {
          expect(stateDiff(run)).to.deep.equal(expectedAbsorbDiff(run, {
            borrowerPrincipal: DEBT,
            borrowerAssetsIn: -assetMask,
            borrowerCollateralBalance: -COLLATERAL_BALANCE,
            totalBorrowBase: -DEBT,
            totalSupplyAsset: -COLLATERAL_BALANCE,
            baseReserves: -DEBT,
            collateralReserves: COLLATERAL_BALANCE,
          }));
        });
      });
    });

    context('given both the base price and the collateral price are 1', function () {
      // 100 whole tokens at price 1 are valued 100, against a debt 1 raw unit above 86 whole base units
      const COLLATERAL_BALANCE = 100n * collateralScale;
      const DEBT = 86n * baseScale + 1n;
      const expectedLiquidity = liquidity(DEBT, MINIMUM_PRICE, COLLATERAL_BALANCE, MINIMUM_PRICE);
      const outcome = absorbOutcome(-DEBT, MINIMUM_PRICE, COLLATERAL_BALANCE, MINIMUM_PRICE);

      let isLiquidatable: boolean;
      let run: AbsorbRun;

      before(async () => {
        await openPosition({ debt: DEBT, collateralBalance: COLLATERAL_BALANCE });
        await setPrice(collateralPriceFeed, MINIMUM_PRICE);
        await setPrice(basePriceFeed, MINIMUM_PRICE);
        isLiquidatable = await comet.isLiquidatable(borrower.address);
        run = await runAbsorb();
      });

      after(resetFixture);

      it('computes liquidity -86 + 85 = -1', async () => {
        // Prices do not cancel, scales and factors differ per F4 and F5.
        expect(expectedLiquidity).to.equal(-1n);
      });

      it('matches isLiquidatable with the manually computed liquidity', async () => {
        expect(isLiquidatable).to.equal(expectedLiquidity < 0n);
      });

      context('when absorbing a liquidatable account', function () {
        it('computes a new balance of 4 whole base units minus 1 raw unit', async () => {
          expect(outcome.newBalance).to.equal(4n * baseScale - 1n);
        });

        it('matches principal with the manually computed absorb outcome', async () => {
          expect(run.after.borrowerPrincipal).to.equal(outcome.newBalance * BASE_INDEX_SCALE / run.after.baseSupplyIndex);
        });

        it('matches totalSupplyBase with the manually computed absorb outcome', async () => {
          expect(run.after.totalSupplyBase).to.equal(run.before.totalSupplyBase + outcome.newBalance);
        });

        it('matches totalBorrowBase with the manually computed absorb outcome', async () => {
          expect(run.after.totalBorrowBase).to.equal(run.before.totalBorrowBase - DEBT);
        });

        it('matches getReserves with the manually computed absorb outcome', async () => {
          expect(run.after.baseReserves).to.equal(run.before.baseReserves - outcome.basePaidOut);
        });

        it('emits AbsorbCollateral, AbsorbDebt and Transfer only', async () => {
          expect(eventCount(run.transaction)).to.equal(3);
        });

        it('matches AbsorbCollateral with the manually computed absorb outcome', async () => {
          expect(event(run.transaction, 0)).to.deep.equal({
            AbsorbCollateral: {
              absorber: absorber.address,
              borrower: borrower.address,
              asset: collateral.address,
              collateralAbsorbed: COLLATERAL_BALANCE,
              usdValue: outcome.value,
            },
          });
        });

        it('matches AbsorbDebt with the manually computed absorb outcome', async () => {
          expect(event(run.transaction, 1)).to.deep.equal({
            AbsorbDebt: {
              absorber: absorber.address,
              borrower: borrower.address,
              basePaidOut: outcome.basePaidOut,
              usdValue: outcome.valueOfBasePaidOut,
            },
          });
        });

        it('matches Transfer with the manually computed absorb outcome', async () => {
          expect(event(run.transaction, 2)).to.deep.equal({
            Transfer: {
              from: ethers.constants.AddressZero,
              to: borrower.address,
              amount: outcome.newBalance,
            },
          });
        });

        shouldUpdateLiquidatorPoints(() => run);

        it('changes only the absorbed position, totals, reserves and liquidator points', async () => {
          expect(stateDiff(run)).to.deep.equal(expectedAbsorbDiff(run, {
            borrowerPrincipal: DEBT + outcome.newBalance,
            borrowerAssetsIn: -assetMask,
            borrowerCollateralBalance: -COLLATERAL_BALANCE,
            totalSupplyBase: outcome.newBalance,
            totalBorrowBase: -DEBT,
            totalSupplyAsset: -COLLATERAL_BALANCE,
            baseReserves: -outcome.basePaidOut,
            collateralReserves: COLLATERAL_BALANCE,
          }));
        });
      });
    });

    context('given interest accrued before the price drop', function () {
      const COLLATERAL_BALANCE = collateralScale;
      const COLLATERAL_PRICE = 100n;
      const DEBT_PRINCIPAL = 86n * baseScale;
      // Short intervals: the default tracking speed overflows trackingBorrowIndex (uint64) over long ones
      const FIRST_INTERVAL = 86400n;
      const SECOND_INTERVAL = 86400n;

      interface Indices {
        baseSupplyIndex: bigint;
        baseBorrowIndex: bigint;
      }

      let expectedFirstAccrual: Indices;
      let afterFirstAccrual: Indices;
      let expectedSecondAccrual: Indices;
      let absorbTime: bigint;
      let oldBalance: bigint;
      let atAbsorbPrice: AbsorbOutcome;
      let atAccrualPrice: AbsorbOutcome;
      let expectedPrincipal: bigint;
      let run: AbsorbRun;

      // Mirrors accruedInterestIndices: rates come from the utilization stored at the start of the interval
      async function expectedIndices(timeElapsed: bigint): Promise<Indices> {
        const totals = await comet.totalsBasic();
        const utilization = await comet.getUtilization();
        const supplyRate = toBigInt(await comet.getSupplyRate(utilization));
        const borrowRate = toBigInt(await comet.getBorrowRate(utilization));
        const baseSupplyIndex = toBigInt(totals.baseSupplyIndex);
        const baseBorrowIndex = toBigInt(totals.baseBorrowIndex);
        return {
          baseSupplyIndex: baseSupplyIndex + baseSupplyIndex * (supplyRate * timeElapsed) / FACTOR_SCALE,
          baseBorrowIndex: baseBorrowIndex + baseBorrowIndex * (borrowRate * timeElapsed) / FACTOR_SCALE,
        };
      }

      async function readIndices(): Promise<Indices> {
        const totals = await comet.totalsBasic();
        return {
          baseSupplyIndex: toBigInt(totals.baseSupplyIndex),
          baseBorrowIndex: toBigInt(totals.baseBorrowIndex),
        };
      }

      before(async () => {
        // Utilization 50% so both indices grow
        await openPosition({
          debt: DEBT_PRINCIPAL,
          collateralBalance: COLLATERAL_BALANCE,
          totalSupplyBase: 200n * baseScale,
          totalBorrowBase: 100n * baseScale,
        });
        await setPrice(collateralPriceFeed, COLLATERAL_PRICE);

        // Interest accrues at the normal base price
        expectedFirstAccrual = await expectedIndices(FIRST_INTERVAL);
        await comet.setNow(now + FIRST_INTERVAL);
        await wait(comet.accrue());
        afterFirstAccrual = await readIndices();

        // Price drops, then time moves on again before absorb. The second interval is computed explicitly.
        await setPrice(basePriceFeed, MINIMUM_PRICE);
        absorbTime = now + FIRST_INTERVAL + SECOND_INTERVAL;
        await comet.setNow(absorbTime);
        expectedSecondAccrual = await expectedIndices(SECOND_INTERVAL);

        oldBalance = -(DEBT_PRINCIPAL * expectedSecondAccrual.baseBorrowIndex / BASE_INDEX_SCALE);
        atAbsorbPrice = absorbOutcome(oldBalance, MINIMUM_PRICE, COLLATERAL_BALANCE, COLLATERAL_PRICE);
        atAccrualPrice = absorbOutcome(oldBalance, NORMAL_PRICE, COLLATERAL_BALANCE, COLLATERAL_PRICE);
        expectedPrincipal = atAbsorbPrice.newBalance * BASE_INDEX_SCALE / expectedSecondAccrual.baseSupplyIndex;

        run = await runAbsorb();
      });

      after(resetFixture);

      it('accrues the first interval before the price drop', async () => {
        expect(afterFirstAccrual).to.deep.equal(expectedFirstAccrual);
      });

      it('grows both indices above the initial index in the first interval', async () => {
        expect(afterFirstAccrual.baseSupplyIndex).to.be.gt(BASE_INDEX_SCALE);
        expect(afterFirstAccrual.baseBorrowIndex).to.be.gt(BASE_INDEX_SCALE);
      });

      context('when absorbing', function () {
        context('accruing indices for the full elapsed time before reading prices', function () {
          it('sets baseSupplyIndex to the value after the second interval', async () => {
            expect(run.after.baseSupplyIndex).to.equal(expectedSecondAccrual.baseSupplyIndex);
          });

          it('sets baseBorrowIndex to the value after the second interval', async () => {
            expect(run.after.baseBorrowIndex).to.equal(expectedSecondAccrual.baseBorrowIndex);
          });

          it('accrues past the first interval', async () => {
            expect(run.after.baseBorrowIndex).to.be.gt(afterFirstAccrual.baseBorrowIndex);
          });

          it('moves lastAccrualTime to the absorb time', async () => {
            expect(run.after.lastAccrualTime).to.equal(absorbTime);
          });

          it('reads a debt above the principal at the accrued borrow index', async () => {
            expect(-oldBalance).to.be.gt(DEBT_PRINCIPAL);
          });

          it('pays out the amount computed from the accrued debt', async () => {
            expect(eventArgs(run.transaction, 1, 'AbsorbDebt').basePaidOut).to.equal(atAbsorbPrice.basePaidOut);
          });

          it('credits the principal computed at the accrued supply index', async () => {
            expect(run.after.borrowerPrincipal).to.equal(expectedPrincipal);
          });
        });

        context('using the prices at the absorb block', function () {
          // Keep time frozen between transactions or compute the second interval explicitly.
          it('credits the borrower at the absorb block base price', async () => {
            expect(atAbsorbPrice.newBalance).to.be.gt(0n);
          });

          it('would credit nothing at the base price of the accrual block', async () => {
            expect(atAccrualPrice.newBalance).to.equal(0n);
          });

          it('emits AbsorbCollateral valued at the absorb block collateral price', async () => {
            expect(event(run.transaction, 0)).to.deep.equal({
              AbsorbCollateral: {
                absorber: absorber.address,
                borrower: borrower.address,
                asset: collateral.address,
                collateralAbsorbed: COLLATERAL_BALANCE,
                usdValue: atAbsorbPrice.value,
              },
            });
          });

          it('emits AbsorbDebt valued at the absorb block base price', async () => {
            expect(event(run.transaction, 1)).to.deep.equal({
              AbsorbDebt: {
                absorber: absorber.address,
                borrower: borrower.address,
                basePaidOut: atAbsorbPrice.basePaidOut,
                usdValue: atAbsorbPrice.valueOfBasePaidOut,
              },
            });
          });

          it('emits Transfer of the credited balance to the borrower', async () => {
            expect(event(run.transaction, 2)).to.deep.equal({
              Transfer: {
                from: ethers.constants.AddressZero,
                to: borrower.address,
                amount: expectedPrincipal * expectedSecondAccrual.baseSupplyIndex / BASE_INDEX_SCALE,
              },
            });
          });
        });

        shouldUpdateLiquidatorPoints(() => run);

        it('changes only accrual, the absorbed position, totals, reserves and liquidator points', async () => {
          const changed = new Set([
            'baseSupplyIndex',
            'baseBorrowIndex',
            'trackingSupplyIndex',
            'trackingBorrowIndex',
            'lastAccrualTime',
            'borrowerPrincipal',
            'borrowerBaseTrackingIndex',
            'borrowerBaseTrackingAccrued',
            'borrowerAssetsIn',
            'borrowerCollateralBalance',
            'totalSupplyBase',
            'totalBorrowBase',
            'totalSupplyAsset',
            'baseReserves',
            'collateralReserves',
            'absorberLiquidatorNumAbsorbs',
            'absorberLiquidatorNumAbsorbed',
            'absorberLiquidatorApproxSpend',
          ]);
          const unchanged = Object.entries(stateDiff(run)).filter(([key]) => !changed.has(key));
          expect(Object.fromEntries(unchanged)).to.deep.equal(
            Object.fromEntries(unchanged.map(([key]) => [key, 0n]))
          );
        });
      });
    });
  });
}
