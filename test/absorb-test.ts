import { ContractTransaction, BigNumber } from "ethers";
import {
  event,
  expect,
  exp,
  factor,
  defaultAssets,
  makeProtocol,
  mulPrice,
  portfolio,
  totalsAndReserves,
  wait,
  bumpTotalsCollateral,
  setTotalsBasic,
  makeConfigurator,
  takeSnapshot,
  SnapshotRestorer,
} from "./helpers";
import { ethers } from "./helpers";
import {
  CometProxyAdmin,
  CometWithExtendedAssetList,
  Configurator,
  ConfiguratorProxy,
  FaucetToken,
  NonStandardFaucetFeeToken,
  SimplePriceFeed,
} from "build/types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("absorb", function () {
  it("reverts if total borrows underflows", async () => {
    const {
      cometWithExtendedAssetList,
      users: [absorber, underwater],
    } = await makeProtocol();

    const _f0 = await cometWithExtendedAssetList.setBasePrincipal(
      underwater.address,
      -100
    );
    await expect(
      cometWithExtendedAssetList.absorb(absorber.address, [underwater.address])
    ).to.be.revertedWith(
      "code 0x11 (Arithmetic operation underflowed or overflowed outside of an unchecked block)"
    );
  });

  it("absorbs 1 account and pays out the absorber", async () => {
    const params = {
      supplyInterestRateBase: 0,
      supplyInterestRateSlopeLow: 0,
      supplyInterestRateSlopeHigh: 0,
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
      borrowInterestRateSlopeHigh: 0,
    };
    const protocol = await makeProtocol(params);
    const {
      cometWithExtendedAssetList,
      priceFeeds,
      users: [absorber, underwater],
    } = protocol;

    await setTotalsBasic(cometWithExtendedAssetList, { totalBorrowBase: 100n });

    await cometWithExtendedAssetList.setBasePrincipal(underwater.address, -100);

    const r0 = await cometWithExtendedAssetList.getReserves();

    const pA0 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      absorber.address
    );
    const pU0 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater.address
    );

    const a0 = await wait(
      cometWithExtendedAssetList.absorb(absorber.address, [underwater.address])
    );

    const t1 = await cometWithExtendedAssetList.totalsBasic();
    const r1 = await cometWithExtendedAssetList.getReserves();

    const pA1 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      absorber.address
    );
    const pU1 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater.address
    );
    const lA1 = await cometWithExtendedAssetList.liquidatorPoints(
      absorber.address
    );
    const lU1 = await cometWithExtendedAssetList.liquidatorPoints(
      underwater.address
    );

    expect(r0).to.be.equal(100);

    expect(t1.totalSupplyBase).to.be.equal(0);
    expect(t1.totalBorrowBase).to.be.equal(0);
    expect(r1).to.be.equal(0);

    expect(pA0.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pA0.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU0.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: -100n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU0.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });

    expect(pA1.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pA1.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU1.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU1.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });

    expect(lA1.numAbsorbs).to.be.equal(1);
    expect(lA1.numAbsorbed).to.be.equal(1);
    //expect(lA1.approxSpend).to.be.equal(1672498842684n);
    expect(lA1.approxSpend).to.be.lt(
      a0.receipt.gasUsed.mul(a0.receipt.effectiveGasPrice)
    );

    expect(lU1.numAbsorbs).to.be.equal(0);
    expect(lU1.numAbsorbed).to.be.equal(0);
    expect(lU1.approxSpend).to.be.equal(0);

    const [_, usdcPrice] = await priceFeeds["USDC"].latestRoundData();
    const baseScale = await cometWithExtendedAssetList.baseScale();
    expect(event(a0, 0)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater.address,
        basePaidOut: 100n,
        usdValue: mulPrice(100n, usdcPrice, baseScale),
      },
    });
  });

  it("absorbs 2 accounts and pays out the absorber", async () => {
    const params = {
      supplyInterestRateBase: 0,
      supplyInterestRateSlopeLow: 0,
      supplyInterestRateSlopeHigh: 0,
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
      borrowInterestRateSlopeHigh: 0,
    };
    const protocol = await makeProtocol(params);
    const {
      cometWithExtendedAssetList,
      priceFeeds,
      users: [absorber, underwater1, underwater2],
    } = protocol;

    await setTotalsBasic(cometWithExtendedAssetList, {
      totalBorrowBase: 2000n,
    });

    const r0 = await cometWithExtendedAssetList.getReserves();

    await cometWithExtendedAssetList.setBasePrincipal(
      underwater1.address,
      -100
    );
    await cometWithExtendedAssetList.setBasePrincipal(
      underwater2.address,
      -700
    );

    const pA0 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      absorber.address
    );
    const pU1_0 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater1.address
    );
    const pU2_0 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater2.address
    );

    const a0 = await wait(
      cometWithExtendedAssetList.absorb(absorber.address, [
        underwater1.address,
        underwater2.address,
      ])
    );

    const t1 = await cometWithExtendedAssetList.totalsBasic();
    const r1 = await cometWithExtendedAssetList.getReserves();

    const pA1 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      absorber.address
    );
    const pU1_1 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater1.address
    );
    const pU2_1 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater2.address
    );
    const lA1 = await cometWithExtendedAssetList.liquidatorPoints(
      absorber.address
    );
    const _lU1_1 = await cometWithExtendedAssetList.liquidatorPoints(
      underwater1.address
    );
    const _lU2_1 = await cometWithExtendedAssetList.liquidatorPoints(
      underwater2.address
    );

    expect(r0).to.be.equal(2000);

    expect(t1.totalSupplyBase).to.be.equal(0n);
    expect(t1.totalBorrowBase).to.be.equal(1200n);
    expect(r1).to.be.equal(1200);

    expect(pA0.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pA0.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU1_0.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: -100n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU1_0.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU2_0.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: -700n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU2_0.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });

    expect(pA1.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pA1.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU1_1.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU1_1.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU2_1.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU2_1.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });

    expect(lA1.numAbsorbs).to.be.equal(1);
    expect(lA1.numAbsorbed).to.be.equal(2);
    //expect(lA1.approxSpend).to.be.equal(459757131288n);
    expect(lA1.approxSpend).to.be.lt(
      a0.receipt.gasUsed.mul(a0.receipt.effectiveGasPrice)
    );

    const [_, usdcPrice] = await priceFeeds["USDC"].latestRoundData();
    const baseScale = await cometWithExtendedAssetList.baseScale();
    expect(event(a0, 0)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater1.address,
        basePaidOut: 100n,
        usdValue: mulPrice(100n, usdcPrice, baseScale),
      },
    });
    expect(event(a0, 1)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater2.address,
        basePaidOut: 700n,
        usdValue: mulPrice(700n, usdcPrice, baseScale),
      },
    });
  });

  it("absorbs 3 accounts with collateral and pays out the absorber", async () => {
    const params = {
      supplyInterestRateBase: 0,
      supplyInterestRateSlopeLow: 0,
      supplyInterestRateSlopeHigh: 0,
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
      borrowInterestRateSlopeHigh: 0,
    };
    const protocol = await makeProtocol(params);
    const {
      cometWithExtendedAssetList,
      tokens,
      priceFeeds,
      users: [absorber, underwater1, underwater2, underwater3],
    } = protocol;
    const { COMP, WBTC, WETH } = tokens;

    await setTotalsBasic(cometWithExtendedAssetList, {
      totalBorrowBase: exp(3e15, 6),
      totalSupplyBase: exp(4e15, 6),
    });
    await bumpTotalsCollateral(
      cometWithExtendedAssetList,
      COMP,
      exp(1e-6, 18) + exp(10, 18) + exp(10000, 18)
    );
    await bumpTotalsCollateral(
      cometWithExtendedAssetList,
      WETH,
      exp(1, 18) + exp(50, 18)
    );
    await bumpTotalsCollateral(cometWithExtendedAssetList, WBTC, exp(50, 8));

    await cometWithExtendedAssetList.setBasePrincipal(
      underwater1.address,
      -exp(1, 6)
    );
    await cometWithExtendedAssetList.setCollateralBalance(
      underwater1.address,
      COMP.address,
      exp(1e-6, 18)
    );

    await cometWithExtendedAssetList.setBasePrincipal(
      underwater2.address,
      -exp(1, 12)
    );
    await cometWithExtendedAssetList.setCollateralBalance(
      underwater2.address,
      COMP.address,
      exp(10, 18)
    );
    await cometWithExtendedAssetList.setCollateralBalance(
      underwater2.address,
      WETH.address,
      exp(1, 18)
    );

    await cometWithExtendedAssetList.setBasePrincipal(
      underwater3.address,
      -exp(1, 18)
    );
    await cometWithExtendedAssetList.setCollateralBalance(
      underwater3.address,
      COMP.address,
      exp(10000, 18)
    );
    await cometWithExtendedAssetList.setCollateralBalance(
      underwater3.address,
      WETH.address,
      exp(50, 18)
    );
    await cometWithExtendedAssetList.setCollateralBalance(
      underwater3.address,
      WBTC.address,
      exp(50, 8)
    );

    const pP0 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      cometWithExtendedAssetList.address
    );
    const pA0 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      absorber.address
    );
    const pU1_0 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater1.address
    );
    const pU2_0 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater2.address
    );
    const pU3_0 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater3.address
    );
    const cTR0 = await totalsAndReserves({
      ...protocol,
      comet: cometWithExtendedAssetList,
    });

    const a0 = await wait(
      cometWithExtendedAssetList.absorb(absorber.address, [
        underwater1.address,
        underwater2.address,
        underwater3.address,
      ])
    );

    const t1 = await cometWithExtendedAssetList.totalsBasic();

    const pP1 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      cometWithExtendedAssetList.address
    );
    const pA1 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      absorber.address
    );
    const pU1_1 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater1.address
    );
    const pU2_1 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater2.address
    );
    const pU3_1 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater3.address
    );
    const lA1 = await cometWithExtendedAssetList.liquidatorPoints(
      absorber.address
    );
    const _lU1_1 = await cometWithExtendedAssetList.liquidatorPoints(
      underwater1.address
    );
    const _lU2_1 = await cometWithExtendedAssetList.liquidatorPoints(
      underwater2.address
    );
    const _lU3_1 = await cometWithExtendedAssetList.liquidatorPoints(
      underwater3.address
    );
    const cTR1 = await totalsAndReserves({
      ...protocol,
      comet: cometWithExtendedAssetList,
    });

    expect(cTR0.totals).to.be.deep.equal({
      COMP: exp(1, 12) + exp(10, 18) + exp(10000, 18),
      USDC: exp(4e15, 6),
      WBTC: exp(50, 8),
      WETH: exp(1, 18) + exp(50, 18),
    });
    expect(cTR0.reserves).to.be.deep.equal({
      COMP: 0n,
      USDC: -exp(1e15, 6),
      WBTC: 0n,
      WETH: 0n,
    });

    expect(t1.totalSupplyBase).to.be.equal(exp(4e15, 6));
    expect(t1.totalBorrowBase).to.be.equal(
      exp(3e15, 6) - exp(1, 18) - exp(1, 12) - exp(1, 6)
    );
    expect(cTR1.totals).to.be.deep.equal({
      COMP: 0n,
      USDC: exp(4e15, 6),
      WBTC: 0n,
      WETH: 0n,
    });
    expect(cTR1.reserves).to.be.deep.equal({
      COMP: exp(1, 12) + exp(10, 18) + exp(10000, 18),
      USDC: -exp(1e15, 6) - exp(1, 6) - exp(1, 12) - exp(1, 18),
      WBTC: exp(50, 8),
      WETH: exp(1, 18) + exp(50, 18),
    });

    expect(pP0.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pP0.external).to.be.deep.equal({
      COMP: exp(1, 12) + exp(10, 18) + exp(10000, 18),
      USDC: 0n,
      WBTC: exp(50, 8),
      WETH: exp(1, 18) + exp(50, 18),
    });
    expect(pA0.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pA0.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU1_0.internal).to.be.deep.equal({
      COMP: exp(1, 12),
      USDC: -exp(1, 6),
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU1_0.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU2_0.internal).to.be.deep.equal({
      COMP: exp(10, 18),
      USDC: -exp(1, 12),
      WBTC: 0n,
      WETH: exp(1, 18),
    });
    expect(pU2_0.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU3_0.internal).to.be.deep.equal({
      COMP: exp(10000, 18),
      USDC: -exp(1, 18),
      WBTC: exp(50, 8),
      WETH: exp(50, 18),
    });
    expect(pU3_0.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });

    expect(pP1.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pP1.external).to.be.deep.equal({
      COMP: exp(1, 12) + exp(10, 18) + exp(10000, 18),
      USDC: 0n,
      WBTC: exp(50, 8),
      WETH: exp(1, 18) + exp(50, 18),
    });
    expect(pA1.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pA1.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU1_1.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU1_1.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU2_1.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU2_1.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU3_1.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU3_1.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });

    expect(lA1.numAbsorbs).to.be.equal(1);
    expect(lA1.numAbsorbed).to.be.equal(3);
    //expect(lA1.approxSpend).to.be.equal(130651238630n);
    expect(lA1.approxSpend).to.be.lt(
      a0.receipt.gasUsed.mul(a0.receipt.effectiveGasPrice)
    );

    const [_a, usdcPrice] = await priceFeeds["USDC"].latestRoundData();
    const [_b, compPrice] = await priceFeeds["COMP"].latestRoundData();
    const [_c, wbtcPrice] = await priceFeeds["WBTC"].latestRoundData();
    const [_d, wethPrice] = await priceFeeds["WETH"].latestRoundData();
    const baseScale = await cometWithExtendedAssetList.baseScale();
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
      },
    });
    expect(event(a0, 1)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater1.address,
        basePaidOut: exp(1, 6),
        usdValue: mulPrice(exp(1, 6), usdcPrice, baseScale),
      },
    });
    // Underwater account 2
    expect(event(a0, 2)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater2.address,
        asset: COMP.address,
        collateralAbsorbed: exp(10, 18),
        usdValue: mulPrice(exp(10, 18), compPrice, compScale),
      },
    });
    expect(event(a0, 3)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater2.address,
        asset: WETH.address,
        collateralAbsorbed: exp(1, 18),
        usdValue: mulPrice(exp(1, 18), wethPrice, wethScale),
      },
    });
    expect(event(a0, 4)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater2.address,
        basePaidOut: exp(1, 12),
        usdValue: mulPrice(exp(1, 12), usdcPrice, baseScale),
      },
    });
    // Underwater account 3
    expect(event(a0, 5)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater3.address,
        asset: COMP.address,
        collateralAbsorbed: exp(10000, 18),
        usdValue: mulPrice(exp(10000, 18), compPrice, compScale),
      },
    });
    expect(event(a0, 6)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater3.address,
        asset: WETH.address,
        collateralAbsorbed: exp(50, 18),
        usdValue: mulPrice(exp(50, 18), wethPrice, wethScale),
      },
    });
    expect(event(a0, 7)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater3.address,
        asset: WBTC.address,
        collateralAbsorbed: exp(50, 8),
        usdValue: mulPrice(exp(50, 8), wbtcPrice, wbtcScale),
      },
    });
    expect(event(a0, 8)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater3.address,
        basePaidOut: exp(1, 18),
        usdValue: mulPrice(exp(1, 18), usdcPrice, baseScale),
      },
    });
  });

  it("absorbs an account with more than enough collateral to still cover debt", async () => {
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
      }),
    };
    const protocol = await makeProtocol(params);
    const {
      cometWithExtendedAssetList,
      tokens,
      users: [absorber, underwater],
      priceFeeds,
    } = protocol;
    const { COMP, WBTC, WETH } = tokens;

    const finalDebt = 1n;
    const startingDebt =
      finalDebt - (exp(41000, 6) + exp(3000, 6) + exp(175, 6));
    await setTotalsBasic(cometWithExtendedAssetList, {
      totalBorrowBase: -startingDebt,
    });
    await bumpTotalsCollateral(cometWithExtendedAssetList, COMP, exp(1, 18));
    await bumpTotalsCollateral(cometWithExtendedAssetList, WETH, exp(1, 18));
    await bumpTotalsCollateral(cometWithExtendedAssetList, WBTC, exp(1, 8));

    const r0 = await cometWithExtendedAssetList.getReserves();

    await cometWithExtendedAssetList.setBasePrincipal(
      underwater.address,
      startingDebt
    );
    await cometWithExtendedAssetList.setCollateralBalance(
      underwater.address,
      COMP.address,
      exp(1, 18)
    );
    await cometWithExtendedAssetList.setCollateralBalance(
      underwater.address,
      WETH.address,
      exp(1, 18)
    );
    await cometWithExtendedAssetList.setCollateralBalance(
      underwater.address,
      WBTC.address,
      exp(1, 8)
    );

    const pP0 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      cometWithExtendedAssetList.address
    );
    const pA0 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      absorber.address
    );
    const pU0 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater.address
    );

    const a0 = await wait(
      cometWithExtendedAssetList.absorb(absorber.address, [underwater.address])
    );

    const t1 = await cometWithExtendedAssetList.totalsBasic();
    const r1 = await cometWithExtendedAssetList.getReserves();

    const pP1 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      cometWithExtendedAssetList.address
    );
    const pA1 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      absorber.address
    );
    const pU1 = await portfolio(
      { ...protocol, comet: cometWithExtendedAssetList },
      underwater.address
    );
    const lA1 = await cometWithExtendedAssetList.liquidatorPoints(
      absorber.address
    );
    const _lU1 = await cometWithExtendedAssetList.liquidatorPoints(
      underwater.address
    );

    expect(r0).to.be.equal(-startingDebt);
    expect(t1.totalSupplyBase).to.be.equal(finalDebt);
    expect(t1.totalBorrowBase).to.be.equal(0);
    expect(r1).to.be.equal(-finalDebt);

    expect(pP0.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pP0.external).to.be.deep.equal({
      COMP: exp(1, 18),
      USDC: 0n,
      WBTC: exp(1, 8),
      WETH: exp(1, 18),
    });
    expect(pA0.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pA0.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU0.internal).to.be.deep.equal({
      COMP: exp(1, 18),
      USDC: startingDebt,
      WBTC: exp(1, 8),
      WETH: exp(1, 18),
    });
    expect(pU0.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });

    expect(pP1.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pP1.external).to.be.deep.equal({
      COMP: exp(1, 18),
      USDC: 0n,
      WBTC: exp(1, 8),
      WETH: exp(1, 18),
    });
    expect(pA1.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pA1.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU1.internal).to.be.deep.equal({
      COMP: 0n,
      USDC: 1n,
      WBTC: 0n,
      WETH: 0n,
    });
    expect(pU1.external).to.be.deep.equal({
      COMP: 0n,
      USDC: 0n,
      WBTC: 0n,
      WETH: 0n,
    });

    expect(lA1.numAbsorbs).to.be.equal(1);
    expect(lA1.numAbsorbed).to.be.equal(1);
    //expect(lA1.approxSpend).to.be.equal(1672498842684n);
    expect(lA1.approxSpend).to.be.lt(
      a0.receipt.gasUsed.mul(a0.receipt.effectiveGasPrice)
    );

    const [_a, usdcPrice] = await priceFeeds["USDC"].latestRoundData();
    const [_b, compPrice] = await priceFeeds["COMP"].latestRoundData();
    const [_c, wbtcPrice] = await priceFeeds["WBTC"].latestRoundData();
    const [_d, wethPrice] = await priceFeeds["WETH"].latestRoundData();
    const baseScale = await cometWithExtendedAssetList.baseScale();
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
      },
    });
    expect(event(a0, 1)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater.address,
        asset: WETH.address,
        collateralAbsorbed: exp(1, 18),
        usdValue: mulPrice(exp(1, 18), wethPrice, wethScale),
      },
    });
    expect(event(a0, 2)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater.address,
        asset: WBTC.address,
        collateralAbsorbed: exp(1, 8),
        usdValue: mulPrice(exp(1, 8), wbtcPrice, wbtcScale),
      },
    });
    expect(event(a0, 3)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater.address,
        basePaidOut: pU1.internal.USDC - startingDebt,
        usdValue: mulPrice(
          pU1.internal.USDC - startingDebt,
          usdcPrice,
          baseScale
        ),
      },
    });
    expect(event(a0, 4)).to.be.deep.equal({
      Transfer: {
        amount: finalDebt,
        from: ethers.constants.AddressZero,
        to: underwater.address,
      },
    });
  });

  it("reverts if an account is not underwater", async () => {
    const {
      cometWithExtendedAssetList,
      users: [alice, bob],
    } = await makeProtocol();

    expect(await cometWithExtendedAssetList.isLiquidatable(bob.address)).to.be
      .false;

    await expect(
      cometWithExtendedAssetList.absorb(alice.address, [bob.address])
    ).to.be.revertedWith("custom error 'NotLiquidatable()'");
  });

  it.skip("reverts if collateral asset value overflows base balance", async () => {
    // XXX
  });

  it("reverts if absorb is paused", async () => {
    const protocol = await makeProtocol();
    const {
      cometWithExtendedAssetList,
      pauseGuardian,
      users: [alice, bob],
    } = protocol;

    const cometAsB = cometWithExtendedAssetList.connect(bob);

    // Pause transfer
    await wait(
      cometWithExtendedAssetList
        .connect(pauseGuardian)
        .pause(false, false, false, true, false)
    );
    expect(await cometWithExtendedAssetList.isAbsorbPaused()).to.be.true;

    await expect(
      cometAsB.absorb(bob.address, [alice.address])
    ).to.be.revertedWith("custom error 'Paused()'");
  });

  it("updates assetsIn for liquidated account", async () => {
    const {
      cometWithExtendedAssetList,
      users: [absorber, underwater],
      tokens,
    } = await makeProtocol();
    const { COMP, WETH } = tokens;

    await bumpTotalsCollateral(cometWithExtendedAssetList, COMP, exp(1, 18));
    await bumpTotalsCollateral(cometWithExtendedAssetList, WETH, exp(1, 18));

    await cometWithExtendedAssetList.setCollateralBalance(
      underwater.address,
      COMP.address,
      exp(1, 18)
    );
    await cometWithExtendedAssetList.setCollateralBalance(
      underwater.address,
      WETH.address,
      exp(1, 18)
    );

    expect(
      await cometWithExtendedAssetList.getAssetList(underwater.address)
    ).to.deep.equal([COMP.address, WETH.address]);

    const borrowAmount = exp(4000, 6); // borrow of $4k > collateral of $3k + $175
    await cometWithExtendedAssetList.setBasePrincipal(
      underwater.address,
      -borrowAmount
    );
    await setTotalsBasic(cometWithExtendedAssetList, {
      totalBorrowBase: borrowAmount,
    });

    const isLiquidatable = await cometWithExtendedAssetList.isLiquidatable(
      underwater.address
    );

    expect(isLiquidatable).to.be.true;

    await cometWithExtendedAssetList.absorb(absorber.address, [
      underwater.address,
    ]);

    expect(await cometWithExtendedAssetList.getAssetList(underwater.address)).to
      .be.empty;
  });

  it("updates assetsIn for liquidated account in 24 assets", async () => {
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
      reward: "COMP",
    });
    const {
      cometWithExtendedAssetList: comet,
      tokens: { COMP, WETH },
      users: [absorber, underwater],
    } = protocol;

    await bumpTotalsCollateral(comet, COMP, exp(1, 18));
    await bumpTotalsCollateral(comet, WETH, exp(1, 18));

    await comet.setCollateralBalance(
      underwater.address,
      COMP.address,
      exp(1, 18)
    );
    await comet.setCollateralBalance(
      underwater.address,
      WETH.address,
      exp(1, 18)
    );

    for (let i = 3; i < 24; i++) {
      const asset = `ASSET${i}`;
      await bumpTotalsCollateral(comet, protocol.tokens[asset], exp(1, 18));
      await comet.setCollateralBalance(
        underwater.address,
        protocol.tokens[asset].address,
        exp(1, 18)
      );
    }

    expect(await comet.getAssetList(underwater.address)).to.deep.equal([
      COMP.address,
      WETH.address,
      ...Array.from(
        { length: 21 },
        (_, i) => protocol.tokens[`ASSET${i + 3}`].address
      ),
    ]);

    const borrowAmount = exp(4000, 6); // borrow of $4k > collateral of $3k + $175
    await comet.setBasePrincipal(underwater.address, -borrowAmount);
    await setTotalsBasic(comet, { totalBorrowBase: borrowAmount });

    const isLiquidatable = await comet.isLiquidatable(underwater.address);

    expect(isLiquidatable).to.be.true;

    await comet.absorb(absorber.address, [underwater.address]);

    expect(await comet.getAssetList(underwater.address)).to.be.empty;
  });

  describe("absorb semantics across liquidationFactor values", function () {
    // Snapshot
    let snapshot: SnapshotRestorer;

    // Configurator and protocol
    let configurator: Configurator;
    let configuratorProxy: ConfiguratorProxy;
    let proxyAdmin: CometProxyAdmin;
    let cometProxyAddress: string;
    let assetListFactoryAddress: string;
    let cometAsProxy: CometWithExtendedAssetList;

    // Tokens
    let baseToken: FaucetToken | NonStandardFaucetFeeToken;
    let compToken: FaucetToken | NonStandardFaucetFeeToken;

    // Users
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;

    // Price feeds
    let compPriceFeed: SimplePriceFeed;

    // constant
    const aliceCompSupply = exp(1, 18);

    // Liquidation transaction
    let liquidationTx: ContractTransaction;

    // Data before absorption
    let userCollateralBeforeAbsorption: BigNumber;
    let totalsSupplyAssetBeforeAbsorption: BigNumber;

    before(async () => {
      const configuratorAndProtocol = await makeConfigurator({
        base: "USDC",
        storeFrontPriceFactor: exp(0.8, 18),
        assets: {
          USDC: { initial: 1e6, decimals: 6, initialPrice: 1 },
          COMP: {
            initial: 1e7,
            decimals: 18,
            initialPrice: 200,
            liquidationFactor: exp(0.6, 18),
          },
        },
      });
      // Note: Always interact with the proxy address, we'll upgrade implementation later
      cometProxyAddress = configuratorAndProtocol.cometProxy.address;
      const comet = configuratorAndProtocol.cometWithExtendedAssetList.attach(
        cometProxyAddress
      ) as CometWithExtendedAssetList;
      configurator = configuratorAndProtocol.configurator;
      configuratorProxy = configuratorAndProtocol.configuratorProxy;
      proxyAdmin = configuratorAndProtocol.proxyAdmin;
      assetListFactoryAddress =
        configuratorAndProtocol.assetListFactory.address;

      cometAsProxy = comet.attach(cometProxyAddress);

      // Tokens
      baseToken = configuratorAndProtocol.tokens.USDC;
      compToken = configuratorAndProtocol.tokens.COMP;

      compPriceFeed = configuratorAndProtocol.priceFeeds.COMP;

      alice = configuratorAndProtocol.users[0];
      bob = configuratorAndProtocol.users[1];

      // Allocate base token to comet
      await baseToken.allocateTo(cometAsProxy.address, exp(1000, 6));

      // Supply COMP from Alice
      await compToken.allocateTo(alice.address, aliceCompSupply);
      await compToken
        .connect(alice)
        .approve(cometAsProxy.address, aliceCompSupply);
      await cometAsProxy
        .connect(alice)
        .supply(compToken.address, aliceCompSupply);

      // Borrow COMP from Alice
      await cometAsProxy
        .connect(alice)
        .withdraw(baseToken.address, exp(150, 6));

      // Drop COMP price from 200 to 100 to make Alice liquidatable
      await compPriceFeed.setRoundData(
        0, // roundId
        exp(100, 8), // answer
        0, // startedAt
        0, // updatedAt
        0 // answeredInRound
      );

      // Verify Alice is liquidatable
      expect(await cometAsProxy.isLiquidatable(alice.address)).to.be.true;

      // Save data before absorption
      userCollateralBeforeAbsorption = (
        await cometAsProxy.userCollateral(alice.address, compToken.address)
      ).balance;
      totalsSupplyAssetBeforeAbsorption = (
        await cometAsProxy.totalsCollateral(compToken.address)
      ).totalSupplyAsset;

      snapshot = await takeSnapshot();
    });

    describe("liquidation factor > 0", function () {
      it("absorbs undercollateralized account", async () => {
        liquidationTx = await cometAsProxy
          .connect(bob)
          .absorb(bob.address, [alice.address]);

        expect(liquidationTx).to.not.be.reverted;
      });

      it("emits AbsorbCollateral event", async () => {
        const assetInfo = await cometAsProxy.getAssetInfoByAddress(
          compToken.address
        );
        const [_, price] = await compPriceFeed.latestRoundData();
        const expectedUsdValue = mulPrice(
          aliceCompSupply,
          price,
          assetInfo.scale
        );

        expect(liquidationTx)
          .to.emit(cometAsProxy, "AbsorbCollateral")
          .withArgs(
            bob.address,
            alice.address,
            compToken.address,
            aliceCompSupply,
            expectedUsdValue
          );
      });

      it("reduces totalsCollateral totalSupplyAsset for seized asset", async () => {
        // This relies on the prior absorption in this describe
        const totals = await cometAsProxy.totalsCollateral(compToken.address);
        expect(totals.totalSupplyAsset).to.equal(0);
      });

      it("sets user collateral balance to 0", async () => {
        expect(
          (await cometAsProxy.userCollateral(alice.address, compToken.address))
            .balance
        ).to.equal(0);

        await snapshot.restore();
      });
    });

    describe("liquidation factor = 0", function () {
      it("liquidation factor can be updated to 0", async () => {
        const configuratorAsProxy = configurator.attach(
          configuratorProxy.address
        );

        // Ensure upgrades use CometWithExtendedAssetList implementation (match quote-collateral tests)
        // 1) update extension delegate to the AssetList-aware extension
        const CometExtAssetList = await (
          await ethers.getContractFactory("CometExtAssetList")
        ).deploy(
          {
            name32: ethers.utils.formatBytes32String("Compound Comet"),
            symbol32: ethers.utils.formatBytes32String("BASE"),
          },
          assetListFactoryAddress
        );
        await CometExtAssetList.deployed();
        await configuratorAsProxy.setExtensionDelegate(
          cometProxyAddress,
          CometExtAssetList.address
        );
        // 2) switch factory to CometFactoryWithExtendedAssetList
        const CometFactoryWithExtendedAssetList = await (
          await ethers.getContractFactory("CometFactoryWithExtendedAssetList")
        ).deploy();
        await CometFactoryWithExtendedAssetList.deployed();
        await configuratorAsProxy.setFactory(
          cometProxyAddress,
          CometFactoryWithExtendedAssetList.address
        );

        // Update liquidationFactor to 0 and upgrade implementation
        await configuratorAsProxy.updateAssetLiquidationFactor(
          cometProxyAddress,
          compToken.address,
          exp(0, 18)
        );
        await proxyAdmin.deployAndUpgradeTo(
          configuratorProxy.address,
          cometProxyAddress
        );

        expect(
          (await cometAsProxy.getAssetInfoByAddress(compToken.address))
            .liquidationFactor
        ).to.equal(0);
      });

      it("absorbs undercollateralized account with 0 liquidation factor on asset", async () => {
        liquidationTx = await cometAsProxy
          .connect(bob)
          .absorb(bob.address, [alice.address]);

        expect(liquidationTx).to.not.be.reverted;
      });

      it("does not emit AbsorbCollateral event", async () => {
        expect(liquidationTx).to.not.emit(cometAsProxy, "AbsorbCollateral");
      });

      it("does not affect user collateral balance", async () => {
        expect(
          (await cometAsProxy.userCollateral(alice.address, compToken.address))
            .balance
        ).to.equal(userCollateralBeforeAbsorption);
      });

      it("does not affect totalsCollateral totalSupplyAsset", async () => {
        expect(
          (await cometAsProxy.totalsCollateral(compToken.address))
            .totalSupplyAsset
        ).to.equal(totalsSupplyAssetBeforeAbsorption);
      });
    });
  });

  for (let i = 1; i <= 24; i++) {
    it(`skips absorption of asset ${
      i - 1
    } with liquidation factor = 0 with collaterals ${i}`, async () => {
      // Create collaterals: ASSET0, ASSET1, ..., ASSET{i-1}
      const collaterals = Object.fromEntries(
        Array.from({ length: i }, (_, j) => [
          `ASSET${j}`,
          {
            decimals: 18,
            initialPrice: 200,
          },
        ])
      );

      // Create protocol with configurator so we can update liquidationFactor later
      const {
        configurator,
        configuratorProxy,
        proxyAdmin,
        cometWithExtendedAssetList,
        cometProxy,
        tokens,
        users,
        base,
        assetListFactory,
        priceFeeds,
      } = await makeConfigurator({
        assets: { USDC: { decimals: 6, initialPrice: 1 }, ...collaterals },
      });

      const cometAsProxy = cometWithExtendedAssetList.attach(
        cometProxy.address
      ) as CometWithExtendedAssetList;

      const underwater = users[0];
      const absorber = users[1];

      const targetSymbol = `ASSET${i - 1}`;
      const targetToken = tokens[targetSymbol];
      const baseToken = tokens[base];

      // Step 1: Upgrade proxy to CometWithExtendedAssetList implementation
      const configuratorAsProxy = configurator.attach(
        configuratorProxy.address
      );

      // Deploy CometExtAssetList
      const CometExtAssetList = await (
        await ethers.getContractFactory("CometExtAssetList")
      ).deploy(
        {
          name32: ethers.utils.formatBytes32String("Compound Comet"),
          symbol32: ethers.utils.formatBytes32String("BASE"),
        },
        assetListFactory.address
      );
      await CometExtAssetList.deployed();

      // Set extension delegate
      await configuratorAsProxy.setExtensionDelegate(
        cometProxy.address,
        CometExtAssetList.address
      );

      // Deploy CometFactoryWithExtendedAssetList
      const CometFactoryWithExtendedAssetList = await (
        await ethers.getContractFactory("CometFactoryWithExtendedAssetList")
      ).deploy();
      await CometFactoryWithExtendedAssetList.deployed();

      // Set factory
      await configuratorAsProxy.setFactory(
        cometProxy.address,
        CometFactoryWithExtendedAssetList.address
      );

      // Upgrade proxy to new implementation
      await proxyAdmin.deployAndUpgradeTo(
        configuratorProxy.address,
        cometProxy.address
      );

      // Step 2: Supply, borrow, and make liquidatable
      const supplyAmount = exp(1, 18);
      await targetToken.allocateTo(underwater.address, supplyAmount);
      await targetToken
        .connect(underwater)
        .approve(cometAsProxy.address, supplyAmount);
      await cometAsProxy
        .connect(underwater)
        .supply(targetToken.address, supplyAmount);

      const borrowAmount = exp(150, 6);
      await baseToken.allocateTo(cometAsProxy.address, borrowAmount);
      await cometAsProxy
        .connect(underwater)
        .withdraw(baseToken.address, borrowAmount);

      // Drop price of token to make liquidatable
      await priceFeeds[targetSymbol].setRoundData(0, 100, 0, 0, 0);

      expect(await cometAsProxy.isLiquidatable(underwater.address)).to.be.true;

      // Step 3: Update liquidationFactor to 0 for target asset
      await configuratorAsProxy.updateAssetLiquidationFactor(
        cometProxy.address,
        targetToken.address,
        exp(0, 18)
      );

      // Upgrade proxy again after updating liquidationFactor
      await proxyAdmin.deployAndUpgradeTo(
        configuratorProxy.address,
        cometProxy.address
      );

      // Verify liquidationFactor is 0
      expect(
        (await cometAsProxy.getAssetInfoByAddress(targetToken.address))
          .liquidationFactor
      ).to.equal(0);

      // Step 4: Save balances before absorb
      const userCollateralBefore = (
        await cometAsProxy.userCollateral(
          underwater.address,
          targetToken.address
        )
      ).balance;
      const totalsBefore = (
        await cometAsProxy.totalsCollateral(targetToken.address)
      ).totalSupplyAsset;

      expect(userCollateralBefore).to.equal(supplyAmount);
      expect(totalsBefore).to.equal(supplyAmount);

      // Step 5: Absorb should skip this asset (no seizure) and balances remain unchanged
      await cometAsProxy
        .connect(absorber)
        .absorb(absorber.address, [underwater.address]);

      // Verify balances remain unchanged
      expect(
        (
          await cometAsProxy.userCollateral(
            underwater.address,
            targetToken.address
          )
        ).balance
      ).to.equal(userCollateralBefore);
      expect(
        (await cometAsProxy.totalsCollateral(targetToken.address))
          .totalSupplyAsset
      ).to.equal(totalsBefore);
    });
  }

  it("absorbs with mixed liquidation factors and skips zeroed assets", async () => {
    /**
     * This test checks that when there are five collateral assets with mixed liquidation factors,
     * the absorb function only seizes (liquidates) those assets whose liquidationFactor is nonzero,
     * and skips assets whose liquidationFactor is zero (leaving their balances unchanged after absorb).
     * It sets up the protocol, configures various assets, updates some to have zero liquidation factor,
     * and verifies that 'absorb' seizes only the correct collateral, without affecting those set to be skipped.
     */

    // Create 5 collaterals: ASSET0..ASSET4
    const collaterals = Object.fromEntries(
      Array.from({ length: 5 }, (_, j) => [
        `ASSET${j}`,
        {
          decimals: 18,
          initialPrice: 200,
        },
      ])
    );

    // Create protocol with configurator so we can update liquidationFactor later
    const {
      configurator,
      configuratorProxy,
      proxyAdmin,
      cometWithExtendedAssetList,
      cometProxy,
      tokens,
      users,
      base,
      assetListFactory,
      priceFeeds,
    } = await makeConfigurator({
      assets: { USDC: { decimals: 6, initialPrice: 1 }, ...collaterals },
    });

    const cometAsProxy = cometWithExtendedAssetList.attach(
      cometProxy.address
    ) as CometWithExtendedAssetList;

    const underwater = users[0];
    const absorber = users[1];

    const baseToken = tokens[base];

    // Step 1: Upgrade proxy to CometWithExtendedAssetList implementation
    const configuratorAsProxy = configurator.attach(configuratorProxy.address);

    // Deploy CometExtAssetList
    const CometExtAssetList = await (
      await ethers.getContractFactory("CometExtAssetList")
    ).deploy(
      {
        name32: ethers.utils.formatBytes32String("Compound Comet"),
        symbol32: ethers.utils.formatBytes32String("BASE"),
      },
      assetListFactory.address
    );
    await CometExtAssetList.deployed();

    // Set extension delegate
    await configuratorAsProxy.setExtensionDelegate(
      cometProxy.address,
      CometExtAssetList.address
    );

    // Deploy CometFactoryWithExtendedAssetList
    const CometFactoryWithExtendedAssetList = await (
      await ethers.getContractFactory("CometFactoryWithExtendedAssetList")
    ).deploy();
    await CometFactoryWithExtendedAssetList.deployed();

    // Set factory
    await configuratorAsProxy.setFactory(
      cometProxy.address,
      CometFactoryWithExtendedAssetList.address
    );

    // Upgrade proxy to new implementation
    await proxyAdmin.deployAndUpgradeTo(
      configuratorProxy.address,
      cometProxy.address
    );

    // Step 2: Supply, borrow, and make liquidatable
    const supplyAmount = exp(1, 18);
    const targetSymbols = ["ASSET0", "ASSET1", "ASSET2", "ASSET3", "ASSET4"];
    for (const sym of targetSymbols) {
      const token = tokens[sym];
      await token.allocateTo(underwater.address, supplyAmount);
      await token
        .connect(underwater)
        .approve(cometAsProxy.address, supplyAmount);
      await cometAsProxy
        .connect(underwater)
        .supply(token.address, supplyAmount);
    }

    const borrowAmount = exp(500, 6);
    await baseToken.allocateTo(cometAsProxy.address, borrowAmount);
    await cometAsProxy
      .connect(underwater)
      .withdraw(baseToken.address, borrowAmount);

    // Drop price of all tokens to make liquidatable
    for (const sym of targetSymbols) {
      await priceFeeds[sym].setRoundData(0, 100, 0, 0, 0);
    }

    expect(await cometAsProxy.isLiquidatable(underwater.address)).to.be.true;

    // Step 3: Update liquidationFactor to 0 for three assets (ASSET1, ASSET3, ASSET4)
    const zeroLfSymbols = ["ASSET1", "ASSET3", "ASSET4"];
    for (const sym of zeroLfSymbols) {
      await configuratorAsProxy.updateAssetLiquidationFactor(
        cometProxy.address,
        tokens[sym].address,
        exp(0, 18)
      );
    }

    // Upgrade proxy again after updating liquidationFactor
    await proxyAdmin.deployAndUpgradeTo(
      configuratorProxy.address,
      cometProxy.address
    );

    // Step 4: Save balances before absorb for two categories
    // - Should be seized: ASSET0, ASSET2
    // - Should be skipped (unchanged): ASSET1, ASSET3, ASSET4
    const userBefore: Record<string, BigNumber> = {} as any;
    const totalsBefore: Record<string, BigNumber> = {} as any;
    for (const sym of ["ASSET0", "ASSET1", "ASSET2", "ASSET3", "ASSET4"]) {
      userBefore[sym] = (
        await cometAsProxy.userCollateral(
          underwater.address,
          tokens[sym].address
        )
      ).balance;
      totalsBefore[sym] = (
        await cometAsProxy.totalsCollateral(tokens[sym].address)
      ).totalSupplyAsset;
      expect(userBefore[sym]).to.equal(supplyAmount);
      expect(totalsBefore[sym]).to.equal(supplyAmount);
    }

    // Step 5: Absorb - should skip assets with LF = 0
    await cometAsProxy
      .connect(absorber)
      .absorb(absorber.address, [underwater.address]);

    // Verify skipped assets remain unchanged
    for (const sym of ["ASSET1", "ASSET3", "ASSET4"]) {
      expect(
        (
          await cometAsProxy.userCollateral(
            underwater.address,
            tokens[sym].address
          )
        ).balance
      ).to.equal(userBefore[sym]);
      expect(
        (await cometAsProxy.totalsCollateral(tokens[sym].address))
          .totalSupplyAsset
      ).to.equal(totalsBefore[sym]);
    }

    // Verify seized assets set user balance to 0 and reduce totals
    for (const sym of ["ASSET0", "ASSET2"]) {
      expect(
        (
          await cometAsProxy.userCollateral(
            underwater.address,
            tokens[sym].address
          )
        ).balance
      ).to.equal(0);
      expect(
        (await cometAsProxy.totalsCollateral(tokens[sym].address))
          .totalSupplyAsset
      ).to.equal(0);
    }
  });
});
