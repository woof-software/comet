import { DEFAULT_MAX_SUPPORTED_UTILIZATION, ethers, exp, expect, makeProtocol, ONE, TARGET_HEALTH_FACTOR } from './helpers';
import {
  AssetList__factory,
  AssetListFactory__factory,
  CometHarnessExtendedAssetList__factory,
  CometHarnessInterfaceExtendedAssetList,
  FaucetToken__factory,
  SimplePriceFeed__factory,
} from '../build/types';

describe('constructor', function () {
  it('sets the baseBorrowMin', async function () {
    const { cometWithExtendedAssetList: comet } = await makeProtocol({
      baseBorrowMin: exp(100, 6)
    });
    expect(await comet.baseBorrowMin()).to.eq(exp(100, 6));
  });

  it('sets the targetHealthFactor', async function () {
    const { cometWithExtendedAssetList: comet } = await makeProtocol({ targetHealthFactor: exp(1.2, 18) });
    expect(await comet.targetHealthFactor()).to.eq(exp(1.2, 18));
  });

  it('allows a targetHealthFactor equal to the minimum', async function () {
    const { cometWithExtendedAssetList: comet } = await makeProtocol({ targetHealthFactor: ONE });
    expect(await comet.targetHealthFactor()).to.eq(ONE);
  });

  it('reverts if the targetHealthFactor is below the minimum', async function () {
    await expect(makeProtocol({ targetHealthFactor: ONE - 1n })).to.be.revertedWith("custom error 'BadHealthFactor()'");
  });

  it('verifies asset scales', async function () {
    const FaucetFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
    const token = await FaucetFactory.deploy(1e6, 'EVIL', 18, 'EVIL');
    await token.deployed();

    const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
    const priceFeed = await PriceFeedFactory.deploy(exp(1, 8), 8);
    await priceFeed.deployed();

    // The asset list reads the decimals from the token itself, so the scale follows the token's own decimals
    const configs = [{ asset: token.address, priceFeed: priceFeed.address }];
    const configurator = (await ethers.getSigners())[0].address;
    const AssetListFactory = (await ethers.getContractFactory('AssetListFactory')) as AssetListFactory__factory;
    const assetListFactory = await AssetListFactory.deploy(configurator);
    await assetListFactory.deployed();
    const assetListAddress = await assetListFactory.callStatic.createAssetList(configs);
    await assetListFactory.createAssetList(configs);
    const assetList = AssetList__factory.connect(assetListAddress, ethers.provider);

    expect((await assetList.getAssetInfo(0)).scale).to.equal(10n ** BigInt(await token.decimals()));
  });

  it('reverts if baseTokenPriceFeed does not have 8 decimals', async () => {
    await expect(
      makeProtocol({
        assets: {
          USDC: {
            priceFeedDecimals: 18,
          },
          COMP: {},
        },
      })
    ).to.be.revertedWith("custom error 'BadDecimals()'");
  });

  it('reverts if asset has a price feed that does not have 8 decimals', async () => {
    await expect(
      makeProtocol({
        assets: {
          USDC: {},
          COMP: {
            initial: 1e7,
            decimals: 18,
            initialPrice: 1.2345,
            priceFeedDecimals: 18,
          },
        },
      })
    ).to.be.revertedWith("custom error 'PriceFeedDecimalsNotMatched()'");
  });

  it('reverts if base token has fewer than 6 decimals', async () => {
    await expect(
      makeProtocol({
        assets: {
          USDC: {
            decimals: 5,
          },
          COMP: {},
        },
      })
    ).to.be.revertedWith("custom error 'BadDecimals()'");
  });

  it('reverts if base token has more than 18 decimals', async () => {
    await expect(
      makeProtocol({
        assets: {
          USDC: {
            decimals: 19,
          },
          COMP: {},
        },
      })
    ).to.be.revertedWith("custom error 'BadDecimals()'");
  });

  // Comet reads its collateral from the asset list, so it can't be built from a configuration without one.
  // Only the base token decimals and the store front price factor are checked before it, so the base token is
  // the only real contract; every other field is arbitrary
  it('reverts if the asset list is the zero address', async () => {
    const FaucetFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
    const baseToken = await FaucetFactory.deploy(1e6, 'USDC', 6, 'USDC');
    await baseToken.deployed();

    const [governor, pauseGuardian, baseTokenPriceFeed, extensionDelegate] = await ethers.getSigners();
    const CometFactory = (await ethers.getContractFactory('CometHarnessExtendedAssetList')) as CometHarnessExtendedAssetList__factory;
    await expect(CometFactory.deploy({
      governor: governor.address,
      pauseGuardian: pauseGuardian.address,
      baseToken: baseToken.address,
      baseTokenPriceFeed: baseTokenPriceFeed.address,
      extensionDelegate: extensionDelegate.address,
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.05, 18),
      supplyPerYearInterestRateSlopeHigh: exp(2, 18),
      supplyPerYearInterestRateBase: 0,
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.1, 18),
      borrowPerYearInterestRateSlopeHigh: exp(3, 18),
      borrowPerYearInterestRateBase: exp(0.01, 18),
      storeFrontPriceFactor: exp(0.5, 18),
      trackingIndexScale: exp(1, 15),
      baseTrackingSupplySpeed: 0,
      baseTrackingBorrowSpeed: 0,
      baseMinForRewards: exp(1, 6),
      baseBorrowMin: exp(1, 6),
      targetReserves: 0,
      maxSupportedUtilization: DEFAULT_MAX_SUPPORTED_UTILIZATION,
      targetHealthFactor: TARGET_HEALTH_FACTOR,
      assetList: ethers.constants.AddressZero,
    })).to.be.revertedWithCustomError(CometFactory, 'ZeroAssetList');
  });

  it('reverts if initializeStorage is called after initialization', async () => {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();
    await expect(
      comet.initializeStorage()
    ).to.be.revertedWith("custom error 'AlreadyInitialized()'");
  });

  it('is not possible to create a perSecondInterestRateSlopeLow above FACTOR_SCALE', async () => {
    const uint64Max = BigInt(2 ** 64) - 1n;

    const { cometWithExtendedAssetList: comet } = await makeProtocol({
      supplyInterestRateSlopeLow: uint64Max,
      borrowInterestRateSlopeLow: uint64Max
    });

    // max value of interestRateSlopeLow should result in a value less than FACTOR_SCALE
    expect(await comet.supplyPerSecondInterestRateBase()).to.be.lt(exp(1, 18));
    expect(await comet.borrowPerSecondInterestRateBase()).to.be.lt(exp(1, 18));

    // exceeding the max value of interestRateSlopeLow should overflow
    await expect(
      makeProtocol({
        supplyInterestRateSlopeLow: uint64Max + 1n
      })
    ).to.be.rejectedWith('value out-of-bounds'); // ethers.js error
    await expect(
      makeProtocol({
        borrowInterestRateSlopeLow: uint64Max + 1n
      })
    ).to.be.rejectedWith('value out-of-bounds'); // ethers.js error
  });

  describe('max supported utilization', function () {
    const uint64Max = 2n ** 64n - 1n;
    const utilizationBelow100Percent = exp(0.8, 18);

    let cometBelowFullUtilization: CometHarnessInterfaceExtendedAssetList;
    let cometAtUint64Max: CometHarnessInterfaceExtendedAssetList;

    before(async function () {
      cometBelowFullUtilization = (await makeProtocol({ maxSupportedUtilization: utilizationBelow100Percent })).cometWithExtendedAssetList;
      cometAtUint64Max = (await makeProtocol({ maxSupportedUtilization: uint64Max })).cometWithExtendedAssetList;
    });

    it('allows maxSupportedUtilization below 100%', async function () {
      expect(await cometBelowFullUtilization.maxSupportedUtilization()).to.eq(utilizationBelow100Percent);
    });

    it('allows maxSupportedUtilization equal to uint64 max', async function () {
      expect(await cometAtUint64Max.maxSupportedUtilization()).to.eq(uint64Max);
    });
  });
});
