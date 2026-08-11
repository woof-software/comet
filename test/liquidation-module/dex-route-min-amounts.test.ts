import hre from 'hardhat';
import {
  ethers,
  expect,
  exp,
  setErc20Balance,
  setBalance,
  takeSnapshot,
  SnapshotRestorer,
  TOKENS,
  MARKETS,
  buildRoutesFromList,
  CORE_ROUTER,
  REDUNDANT_ROUTER,
  SLIPPAGE_BPS,
  fetch1inchSwapData,
  CHAIN_ID,
  ONEINCH_SLIPPAGE_PCT,
  AMM_PROTOCOLS,
} from '../helpers';
import {
  CometInterface,
  CometWithExtendedAssetList__factory,
  CometExtAssetList__factory,
  AssetListFactory__factory,
  LiquidationModule,
  LiquidationModule__factory,
  OneInchV6Adapter,
  OneInchV6Adapter__factory,
  ERC20,
  ERC20__factory,
  SimplePriceFeed__factory,
  SimplePriceFeed,
} from '../../build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber } from 'ethers';

describe('liquidation module dex route min amounts', function () {
  this.timeout(600_000);

  const INCENTIVE_BPS = BigInt(500); // 5%
  // Collateral info: address, decimals, initial price, minimum amount (~10 cents worth)
  const COLLATERAL_SPECS: [string, number, bigint, bigint][] = [
    [TOKENS.WBTC.address, 8, 5_882_352_941_176n, exp(0.0000016, 8)],
    [TOKENS.WETH.address, 18, 156_250_000_000n, exp(0.000061, 18)],
    [TOKENS.WSTETH.address, 18, 156_250_000_000n, exp(0.000061, 18)],
    [TOKENS.UNI.address, 18, 273_972_602n, exp(0.033, 18)],
    [TOKENS.LINK.address, 18, 714_285_714n, exp(0.013, 18)],
    [TOKENS.COMP.address, 18, 1_538_461_538n, exp(0.0063, 18)],
    [TOKENS.tBTC.address, 18, 5_882_352_941_176n, exp(0.0000016, 18)],
    [TOKENS.weETH.address, 18, 156_250_000_000n, exp(0.000061, 18)],
    [TOKENS.rsETH.address, 18, 156_250_000_000n, exp(0.000061, 18)],
    [TOKENS.cbETH.address, 18, 156_250_000_000n, exp(0.000061, 18)],
    [TOKENS.ETHx.address, 18, 156_250_000_000n, exp(0.000061, 18)],
    [TOKENS.ezETH.address, 18, 156_250_000_000n, exp(0.000061, 18)],
    [TOKENS.rswETH.address, 18, 156_250_000_000n, exp(0.000061, 18)],
    [TOKENS.rETH.address, 18, 156_250_000_000n, exp(0.000061, 18)],
    [TOKENS.osETH.address, 18, 156_250_000_000n, exp(0.000061, 18)],
    [TOKENS.USDT.address, 6, 100_000_000n, exp(0.1, 6)],
    [TOKENS.USDS.address, 18, 100_000_000n, exp(0.1, 18)],
    [TOKENS.mETH.address, 18, 156_250_000_000n, exp(0.000061, 18)],
    [TOKENS.SKY.address, 18, 5_263_157n, exp(1.84, 18)],
    [TOKENS.sUSDS.address, 18, 100_000_000n, exp(0.11, 18)],
    [TOKENS.wUSDM.address, 18, 100_000_000n, exp(0.1, 18)],
    [TOKENS.sFRAX.address, 18, 100_000_000n, exp(0.11, 18)],
    [TOKENS.XAUt.address, 6, 400_000_000_000n, exp(0.000025, 6)],
    [TOKENS.pumpBTC.address, 8, 5_882_352_941_176n, exp(0.0000016, 8)],
  ];
  // Addresses only, for building the adapter's routes.
  const COLLATERALS = COLLATERAL_SPECS.map(([addr]) => addr);
  // Initial (8-decimal) price per collateral.
  const initialPriceOf = new Map<string, bigint>(COLLATERAL_SPECS.map(([addr, , price]) => [addr, price]));
  const droppedPrice = (addr: string) => (initialPriceOf.get(addr)! * 4n) / 5n;
  const infoByAddress = new Map(Object.values(TOKENS).map((info) => [info.address, info] as const));

  let comet: CometInterface;
  let adapter: OneInchV6Adapter;
  let liquidationModule: LiquidationModule;

  let feeds: Map<string, SimplePriceFeed>;
  let tokens: Map<string, ERC20>;
  let usdc: ERC20; // base token

  let governor: SignerWithAddress;
  let executor: SignerWithAddress;
  let borrower: SignerWithAddress;
  let lender: SignerWithAddress;
  let absorber: SignerWithAddress;

  let snapshot: SnapshotRestorer;

  type PlanItem = { asset: string, seizedAmount: BigNumber, seizedValue: BigNumber };

  before(async () => {
    // Fork mainnet so the real tokens and the Uniswap V4 / 1inch routers exist.
    await hre.network.provider.request({
      method: 'hardhat_reset',
      params: [{ forking: { jsonRpcUrl: process.env.MAINNET_QUICKNODE_LINK } }],
    });

    // The Comet governor must be the hardcoded DAO.
    governor = await ethers.getImpersonatedSigner('0x6d903f6003cca6255D85CcA4D3B5E5146dC33925');
    await setBalance(governor.address, ethers.utils.parseEther('10'));

    const usdcRoutesNoUni = Object.fromEntries(
      Object.entries(MARKETS.usdc.routes).filter(
        ([addr]) => addr.toLowerCase() !== TOKENS.UNI.address.toLowerCase()
      )
    );
    const routes = buildRoutesFromList(COLLATERALS, usdcRoutesNoUni);

    const AdapterFactory = (await ethers.getContractFactory('OneInchV6Adapter')) as OneInchV6Adapter__factory;
    adapter = await AdapterFactory.deploy(
      CORE_ROUTER,
      REDUNDANT_ROUTER,
      TOKENS.WETH.address,
      SLIPPAGE_BPS,
      routes,
      []
    );
    await adapter.deployed();

    const signers = await ethers.getSigners();
    const pauseGuardian = signers[1];
    executor = signers[2];
    const executors = [signers[2].address, signers[3].address, signers[4].address];
    const pausers = [signers[5].address, signers[6].address, signers[7].address];
    const multisig = signers[8];
    [borrower, lender, absorber] = [signers[9], signers[10], signers[11]];

    const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
    const usdcFeed = await PriceFeedFactory.deploy(exp(1, 8), 8);
    await usdcFeed.deployed();

    feeds = new Map();
    tokens = new Map();
    for (const [asset, , price] of COLLATERAL_SPECS) {
      const feed = await PriceFeedFactory.deploy(price, 8);
      await feed.deployed();
      feeds.set(asset, feed);
      tokens.set(asset, ERC20__factory.connect(asset, ethers.provider));
    }
    const assetConfigs = COLLATERAL_SPECS.map(([asset, decimals]) => ({
      asset,
      priceFeed: feeds.get(asset)!.address,
      decimals,
      borrowCollateralFactor: exp(0.8, 18),
      liquidateCollateralFactor: exp(0.85, 18),
      liquidationFactor: exp(0.9, 18),
      supplyCap: exp(150000, decimals),
    }));

    // Asset list factory + extension delegate
    const AssetListFactoryFactory = (await ethers.getContractFactory('AssetListFactory')) as AssetListFactory__factory;
    const assetListFactory = await AssetListFactoryFactory.deploy();
    await assetListFactory.deployed();
    const CometExtFactory = (await ethers.getContractFactory('CometExtAssetList')) as CometExtAssetList__factory;
    const extensionDelegate = await CometExtFactory.deploy(
      {
        name32: ethers.utils.formatBytes32String('Compound Comet'),
        symbol32: ethers.utils.formatBytes32String('📈BASE'),
      },
      assetListFactory.address
    );
    await extensionDelegate.deployed();

    // Keeper liquidation module, bound to the adapter deployed above.
    const LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
    liquidationModule = await LiquidationModuleFactory.deploy(
      adapter.address,
      multisig.address,
      executors,
      pausers,
      INCENTIVE_BPS
    );
    await liquidationModule.deployed();

    // Zero-interest Comet over the real tokens.
    const CometFactory = (await ethers.getContractFactory('CometWithExtendedAssetList')) as CometWithExtendedAssetList__factory;
    const cometContract = await CometFactory.deploy({
      governor: governor.address,
      pauseGuardian: pauseGuardian.address,
      extensionDelegate: extensionDelegate.address,
      liquidationModule: liquidationModule.address,
      baseToken: TOKENS.USDC.address,
      baseTokenPriceFeed: usdcFeed.address,
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0, 18),
      supplyPerYearInterestRateSlopeLow: exp(0, 18),
      supplyPerYearInterestRateSlopeHigh: exp(0, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(0, 18),
      borrowPerYearInterestRateSlopeLow: exp(0, 18),
      borrowPerYearInterestRateSlopeHigh: exp(0, 18),
      storeFrontPriceFactor: exp(1, 18),
      trackingIndexScale: exp(1, 15),
      baseTrackingSupplySpeed: exp(1, 15),
      baseTrackingBorrowSpeed: exp(1, 15),
      baseMinForRewards: exp(1, 6),
      baseBorrowMin: 0,
      targetReserves: 0,
      assetConfigs,
    });
    await cometContract.deployed();
    await cometContract.initializeStorage();
    comet = (await ethers.getContractAt('CometInterface', cometContract.address)) as CometInterface;

    usdc = ERC20__factory.connect(TOKENS.USDC.address, ethers.provider);
  });

  // Supplies `amount` of base liquidity from the lender so the borrower can draw USDC.
  const supplyBase = async (amount: bigint) => {
    await setErc20Balance(TOKENS.USDC.address, lender.address, amount, TOKENS.USDC.slot);
    await usdc.connect(lender).approve(comet.address, ethers.constants.MaxUint256);
    await comet.connect(lender).supply(TOKENS.USDC.address, amount);
  };

  // Borrower supplies a real collateral amount.
  const supplyCollateral = async (token: ERC20, info: { address: string, slot: number | string }, amount: bigint) => {
    await setErc20Balance(info.address, borrower.address, amount, info.slot);
    await token.connect(borrower).approve(comet.address, ethers.constants.MaxUint256);
    await comet.connect(borrower).supply(info.address, amount);
  };

  context('Low-values collaterals, either absorbed or swapped', function () {
    // 24 collaterals at ~10 cents each ≈ $2.2 total. Borrow into the bad-debt band — above the ~$1.60 the
    // position can cover after a 20% drop, below the ~$1.78 BCF cap — so every collateral is seized.
    const LENDER_USDC = exp(10, 6);
    const BORROW_USDC = exp(1.69, 6);
    // Collaterals with swap routes
    const ROUTED = [TOKENS.WBTC.address, TOKENS.WETH.address, TOKENS.WSTETH.address, TOKENS.LINK.address];
    const isRouted = (asset: string) => ROUTED.some((a) => a.toLowerCase() === asset.toLowerCase());

    let plan: PlanItem[];
    let swapData: string[];
    let borrowBefore: bigint;
    const collateralBefore = new Map<string, bigint>();
    const cometBalanceBefore = new Map<string, bigint>();
    const reservesBefore = new Map<string, bigint>();

    let tx: Awaited<ReturnType<LiquidationModule['liquidate']>>;

    before(async () => {
      snapshot = await takeSnapshot();

      // Price every collateral at its real price, then supply its tiny ~10-cent amount.
      for (const [asset, , price] of COLLATERAL_SPECS) {
        await feeds.get(asset)!.setRoundData(0, price, 0, 0, 0);
      }
      await supplyBase(LENDER_USDC);
      for (const [asset, , , minAmount] of COLLATERAL_SPECS) {
        await supplyCollateral(tokens.get(asset)!, infoByAddress.get(asset)!, minAmount);
      }
      await comet.connect(borrower).withdraw(TOKENS.USDC.address, BORROW_USDC);

      // Crash every collateral 20%. The debt now exceeds the position's seizable value (bad debt), so every
      // collateral is seized — routed ones swapped, the rest swept back to Comet.
      for (const [asset] of COLLATERAL_SPECS) {
        await feeds.get(asset)!.setRoundData(0, droppedPrice(asset), 0, 0, 0);
      }
      await comet.accrueAccount(borrower.address);

      plan = await liquidationModule.seizurePlan(borrower.address);
      // Quote the routed collaterals on 1inch; pass empty calldata for the route-less ones so the adapter's
      // redundant path finds no route and sweeps them back to Comet.
      swapData = await Promise.all(
        plan.map((s) =>
          isRouted(s.asset)
            ? fetch1inchSwapData({
              chainId: CHAIN_ID,
              src: s.asset,
              dst: TOKENS.USDC.address,
              amount: s.seizedAmount.toString(),
              from: adapter.address,
              slippage: ONEINCH_SLIPPAGE_PCT,
              protocols: AMM_PROTOCOLS,
            })
            : Promise.resolve('0x')
        )
      );

      borrowBefore = (await comet.borrowBalanceOf(borrower.address)).toBigInt();
      for (const s of plan) {
        collateralBefore.set(s.asset, (await comet.collateralBalanceOf(borrower.address, s.asset)).toBigInt());
        cometBalanceBefore.set(
          s.asset,
          (await ERC20__factory.connect(s.asset, ethers.provider).balanceOf(comet.address)).toBigInt()
        );
        reservesBefore.set(s.asset, (await comet.getCollateralReserves(s.asset)).toBigInt());
      }
    });

    after(async () => await snapshot.restore());

    it('plans a seizure for every collateral', () => {
      expect(plan.length).to.equal(COLLATERAL_SPECS.length);
    });

    it('liquidates the whole position through the DEX route', async () => {
      tx = await liquidationModule
        .connect(executor)
        .liquidate(absorber.address, borrower.address, swapData);
      await tx.wait();
    });

    it('falls back to absorbing the route-less collaterals', async () => {
      await expect(tx).to.emit(adapter, 'RedundantSwapFailed');
    });

    it('seizes the planned amount from the borrower for every collateral', async () => {
      for (const s of plan) {
        const after = (await comet.collateralBalanceOf(borrower.address, s.asset)).toBigInt();
        expect(collateralBefore.get(s.asset)! - after).to.equal(s.seizedAmount.toBigInt());
      }
    });

    it('swaps routed collaterals out of Comet and absorbs route-less ones as reserves', async () => {
      for (const s of plan) {
        const cometAfter = (await ERC20__factory.connect(s.asset, ethers.provider).balanceOf(comet.address)).toBigInt();
        const reservesAfter = (await comet.getCollateralReserves(s.asset)).toBigInt();
        if (isRouted(s.asset)) {
          // Sold: the tokens left Comet and reserves are unchanged.
          expect(cometBalanceBefore.get(s.asset)! - cometAfter).to.equal(s.seizedAmount.toBigInt());
          expect(reservesAfter - reservesBefore.get(s.asset)!).to.equal(0n);
        } else {
          // Swept back: Comet's token balance is unchanged (out then back) and it becomes protocol reserves.
          expect(cometBalanceBefore.get(s.asset)! - cometAfter).to.equal(0n);
          expect(reservesAfter - reservesBefore.get(s.asset)!).to.equal(s.seizedAmount.toBigInt());
        }
      }
    });

    it('clears the borrower debt', async () => {
      expect((await comet.borrowBalanceOf(borrower.address)).toBigInt()).to.be.lessThan(borrowBefore);
      expect(await liquidationModule.isLiquidatable(borrower.address)).to.be.false;
    });

    it('leaves no collateral or base stranded on the adapter or the module', async () => {
      for (const [asset] of COLLATERAL_SPECS) {
        const token = tokens.get(asset)!;
        expect((await token.balanceOf(adapter.address)).toBigInt()).to.equal(0n);
        expect((await token.balanceOf(liquidationModule.address)).toBigInt()).to.equal(0n);
      }
      expect((await usdc.balanceOf(adapter.address)).toBigInt()).to.equal(0n);
      expect((await usdc.balanceOf(liquidationModule.address)).toBigInt()).to.equal(0n);
    });
  });
});