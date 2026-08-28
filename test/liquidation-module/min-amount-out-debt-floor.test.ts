import { ethers, exp, expect, setBalance } from '../helpers';
import {
  CometWithExtendedAssetList__factory,
  CometExtAssetList__factory,
  AssetListFactory__factory,
  SimplePriceFeed__factory,
  FaucetToken__factory,
  OneInchV6Adapter,
  OneInchV6Adapter__factory,
  LiquidationModule,
  LiquidationModule__factory,
} from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('CoreDexAdapter.calculateMinAmountOut — debt floor', function () {
  const WETH_LF = 0.9;                 // WETH liquidationFactor
  const AMOUNT_IN = exp(1, 18);        // seize 1 WETH
  const MARKET = exp(2000, 6);         // 1 WETH @ $2000 = 2000 USDC (oracle market value, base units)
  const DEBT_FLOOR = exp(1800, 6);     // MARKET × LF — the debt this collateral is credited against

  let adapter: OneInchV6Adapter;
  let module: LiquidationModule;
  let multisig: SignerWithAddress;
  let wethAddr: string;

  before(async () => {
    const signers = await ethers.getSigners();
    const [deployer, pauseGuardian] = signers;
    multisig = signers[2];
    const executors = [signers[3].address];
    const pausers = [signers[6].address];

    const governor = await ethers.getImpersonatedSigner('0x6d903f6003cca6255D85CcA4D3B5E5146dC33925');
    await setBalance(governor.address, ethers.utils.parseEther('10'));

    const ZERO = ethers.constants.AddressZero;

    const FaucetTokenFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
    const usdc = await (await FaucetTokenFactory.deploy(exp(1, 6), 'USD Coin', 6, 'USDC')).deployed();
    const weth = await (await FaucetTokenFactory.deploy(exp(1, 18), 'Wrapped Ether', 18, 'WETH')).deployed();
    wethAddr = weth.address;

    const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
    const usdcFeed = await (await PriceFeedFactory.deploy(exp(1, 8), 8)).deployed();
    const wethFeed = await (await PriceFeedFactory.deploy(exp(2000, 8), 8)).deployed();

    const AssetListFactoryFactory = (await ethers.getContractFactory('AssetListFactory')) as AssetListFactory__factory;
    const assetListFactory = await (await AssetListFactoryFactory.deploy()).deployed();
    const CometExtFactory = (await ethers.getContractFactory('CometExtAssetList')) as CometExtAssetList__factory;
    const extensionDelegate = await (await CometExtFactory.deploy(
      { name32: ethers.utils.formatBytes32String('Compound Comet'), symbol32: ethers.utils.formatBytes32String('BASE') },
      assetListFactory.address
    )).deployed();

    // Real 1inch V6 adapter with an Unset route (only the view function is exercised here). Global slippage 500.
    const AdapterFactory = (await ethers.getContractFactory('OneInchV6Adapter')) as OneInchV6Adapter__factory;
    adapter = (await (await AdapterFactory.deploy(deployer.address, deployer.address, weth.address, 500, [
      {
        collateral: weth.address,
        kind: 0, // Unset
        poolKey: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO },
        zeroForOne: false,
        path: [],
      },
    ], [])).deployed()) as OneInchV6Adapter;

    const ModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
    module = await (await ModuleFactory.deploy(
      adapter.address, multisig.address, executors, pausers, BigInt(500)
    )).deployed();

    const CometFactory = (await ethers.getContractFactory('CometWithExtendedAssetList')) as CometWithExtendedAssetList__factory;
    const cometContract = await (await CometFactory.deploy({
      governor: governor.address,
      pauseGuardian: pauseGuardian.address,
      extensionDelegate: extensionDelegate.address,
      liquidationModule: module.address,
      baseToken: usdc.address,
      baseTokenPriceFeed: usdcFeed.address,
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.05, 18),
      supplyPerYearInterestRateSlopeHigh: exp(2, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(0.005, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.1, 18),
      borrowPerYearInterestRateSlopeHigh: exp(3, 18),
      storeFrontPriceFactor: exp(1, 18),
      trackingIndexScale: exp(1, 15),
      baseTrackingSupplySpeed: exp(1, 15),
      baseTrackingBorrowSpeed: exp(1, 15),
      baseMinForRewards: exp(1, 6),
      baseBorrowMin: exp(1, 6),
      targetReserves: 0,
      assetConfigs: [{
        asset: weth.address,
        priceFeed: wethFeed.address,
        decimals: 18,
        borrowCollateralFactor: exp(0.8, 18),
        liquidateCollateralFactor: exp(0.85, 18),
        liquidationFactor: exp(WETH_LF, 18),
        supplyCap: exp(150000, 18),
      }],
    })).deployed();
    await cometContract.initializeStorage(); // binds the adapter to Comet via the module
  });

  it('sanity: the credited-debt constant equals MARKET * LF', async () => {
    expect(DEBT_FLOOR).to.equal(MARKET * BigInt(Math.round(WETH_LF * 10000)) / 10_000n);
  });

  it('loose slippage (> 1 - LF): floor is raised to the credited debt, not the naive market floor', async () => {
    const looseBps = 1200n; // 12% > 1 − LF (10%) → exploitable
    await module.connect(multisig).setSlippageBps(Number(looseBps), wethAddr);

    // The OLD formula would have returned this — BELOW the debt the collateral was credited against.
    const naiveFloor = MARKET * (10_000n - looseBps) / 10_000n; // 1760 USDC
    expect(naiveFloor < DEBT_FLOOR).to.equal(true); // root cause: a swap could underpay by DEBT_FLOOR − naiveFloor

    const minOut = (await adapter.calculateMinAmountOut(wethAddr, AMOUNT_IN)).toBigInt();
    // Fixed: floored at the credited debt, so baseReceived ≥ debt → no reserve write-off.
    expect(minOut).to.equal(DEBT_FLOOR);
    expect(minOut > naiveFloor).to.equal(true);
  });

  it('tight slippage (< 1 - LF): floor stays at the market slippage floor — honest behavior unchanged', async () => {
    const tightBps = 200n; // 2% < 1 − LF (10%)
    await module.connect(multisig).setSlippageBps(Number(tightBps), wethAddr);

    const slippageFloor = MARKET * (10_000n - tightBps) / 10_000n; // 1960 USDC
    expect(slippageFloor > DEBT_FLOOR).to.equal(true);

    const minOut = (await adapter.calculateMinAmountOut(wethAddr, AMOUNT_IN)).toBigInt();
    expect(minOut).to.equal(slippageFloor);
  });
});
