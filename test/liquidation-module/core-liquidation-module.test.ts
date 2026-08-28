import { ethers, exp, expect, setBalance } from '../helpers';
import {
  CometInterface,
  CometWithExtendedAssetList__factory,
  CometExtAssetList__factory,
  AssetListFactory__factory,
  SimplePriceFeed__factory,
  FaucetToken__factory,
  OneInchV6Adapter__factory,
  LiquidationModule,
  LiquidationModule__factory,
} from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('core liquidation module', function () {
  let comet: CometInterface;
  let liquidationModule: LiquidationModule;

  let governor: SignerWithAddress;
  let alice: SignerWithAddress;

  before(async () => {
    const signers = await ethers.getSigners();
    const [deployer, pauseGuardian] = signers;
    const multisig = signers[2];
    const executors = [signers[3].address, signers[4].address, signers[5].address];
    const pauserSigners = [signers[6], signers[7], signers[8]];
    const pausers = pauserSigners.map((s) => s.address);
    alice = signers[9];

    governor = await ethers.getImpersonatedSigner('0x6d903f6003cca6255D85CcA4D3B5E5146dC33925');
    await setBalance(governor.address, ethers.utils.parseEther('10'));

    const ZERO = ethers.constants.AddressZero;

    // Mock market tokens: USDC base + a single WETH collateral
    const FaucetTokenFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
    const usdc = await FaucetTokenFactory.deploy(exp(1, 6), 'USD Coin', 6, 'USDC');
    await usdc.deployed();
    const weth = await FaucetTokenFactory.deploy(exp(1, 18), 'Wrapped Ether', 18, 'WETH');
    await weth.deployed();

    const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
    const usdcFeed = await PriceFeedFactory.deploy(exp(1, 8), 8);
    await usdcFeed.deployed();
    const wethFeed = await PriceFeedFactory.deploy(exp(2000, 8), 8);
    await wethFeed.deployed();

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

    // DEX adapter with unset route per collateral
    const AdapterFactory = (await ethers.getContractFactory('OneInchV6Adapter')) as OneInchV6Adapter__factory;
    const adapter = await AdapterFactory.deploy(deployer.address, deployer.address, weth.address, 500, [
      {
        collateral: weth.address,
        kind: 0, // Unset
        poolKey: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO },
        zeroForOne: false,
        path: [],
      },
    ], []);
    await adapter.deployed();

    // Liquidation module
    const LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
    liquidationModule = await LiquidationModuleFactory.deploy(
      adapter.address,
      multisig.address,
      executors,
      pausers,
      BigInt(500)
    );
    await liquidationModule.deployed();

    // Comet (the real implementation, not the test harness)
    const CometFactory = (await ethers.getContractFactory('CometWithExtendedAssetList')) as CometWithExtendedAssetList__factory;
    const cometContract = await CometFactory.deploy({
      governor: governor.address,
      pauseGuardian: pauseGuardian.address,
      extensionDelegate: extensionDelegate.address,
      liquidationModule: liquidationModule.address,
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
      assetConfigs: [
        {
          asset: weth.address,
          priceFeed: wethFeed.address,
          decimals: 18,
          borrowCollateralFactor: exp(0.8, 18),
          liquidateCollateralFactor: exp(0.85, 18),
          liquidationFactor: exp(0.9, 18),
          supplyCap: exp(150000, 18),
        },
      ],
    });
    await cometContract.deployed();
    await cometContract.initializeStorage();
    comet = (await ethers.getContractAt('CometInterface', cometContract.address)) as CometInterface;
  });

  context('constructor', function () {
    context('happy path', function () {
      it('sets COMET to the provided comet address', async () => {
        expect(await liquidationModule.comet()).to.equal(comet.address);
      });

      it('sets ASSET_LIST to the comet asset list', async () => {
        const cometInterface = await ethers.getContractAt('ICometInterface', comet.address);
        expect(await liquidationModule.assetList()).to.equal(await cometInterface.assetList());
      });

      it('sets NUM_ASSETS to the comet asset count', async () => {
        expect(await liquidationModule.numAssets()).to.equal(await comet.numAssets());
      });

      it('sets BASE_SCALE to the comet base scale', async () => {
        expect(await liquidationModule.baseScale()).to.equal(await comet.baseScale());
      });

      it('enables partial liquidation by default', async () => {
        expect(await liquidationModule.partialLiquidationEnabled()).to.be.true;
      });

      // TARGET_HEALTH_FACTOR is a constant 105e16 = 1.05e18 (105%).
      it('exposes a target health factor of 105%', async () => {
        expect(await liquidationModule.TARGET_HEALTH_FACTOR()).to.equal(exp(1.05, 18));
      });
    });
  });

  context('absorb', function () {
    context('revert when', function () {
      it('caller is not the comet', async () => {
        // sanity check 
        expect(await liquidationModule.comet()).to.not.equal(alice.address);

        await expect(liquidationModule.connect(alice).absorb(alice.address, alice.address))
          .to.be.revertedWithCustomError(liquidationModule, 'OnlyComet');
      });
    });
  });
});
