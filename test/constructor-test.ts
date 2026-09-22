import { encodeBytes32String } from 'ethers';
import type { Contract } from 'ethers';

import { CometHarnessExtendedAssetList__factory } from '../build/types/index.js';
import { ethers, exp, expect, makeProtocol, ONE } from './helpers.js';

const cometErrors = {
  interface: CometHarnessExtendedAssetList__factory.createInterface(),
};

describe('constructor', function () {
  it('sets the baseBorrowMin', async function () {
    const { cometWithExtendedAssetList: comet } = await makeProtocol({
      baseBorrowMin: exp(100, 6)
    });
    expect(await comet.baseBorrowMin()).to.eq(exp(100, 6));
  });

  it('verifies asset scales', async function () {
    const [governor, pauseGuardian] = await ethers.getSigners();

    // extension delegate
    const AssetListFactory = await ethers.getContractFactory('AssetListFactory');
    const assetListFactory = await AssetListFactory.deploy();
    await assetListFactory.waitForDeployment();

    const CometExtFactory = await ethers.getContractFactory('CometExtAssetList');
    const extensionDelegate = await CometExtFactory.deploy({
      name32: encodeBytes32String('Compound Comet'),
      symbol32: encodeBytes32String('📈BASE')
    }, await assetListFactory.getAddress());
    await extensionDelegate.waitForDeployment();

    // tokens
    const assets = {
      USDC: { decimals: 6 },
      EVIL: {
        decimals: 18,
        packedDecimals: 19,
      }
    };
    const FaucetFactory = await ethers.getContractFactory('FaucetToken');
    const tokens: Record<string, Contract> = {};
    for (const symbol in assets) {
      const config = assets[symbol];
      const decimals = config.decimals;
      const token = (tokens[symbol] = await FaucetFactory.deploy(1e6, symbol, decimals, symbol));
      await token.waitForDeployment();
    }

    // price feeds
    const priceFeeds: Record<string, Contract> = {};
    const PriceFeedFactory = await ethers.getContractFactory('SimplePriceFeed');
    for (const asset in assets) {
      const priceFeed = await PriceFeedFactory.deploy(exp(1, 8), 8);
      await priceFeed.waitForDeployment();
      priceFeeds[asset] = priceFeed;
    }

    const CometFactory = await ethers.getContractFactory('CometHarnessExtendedAssetList');
    await expect(CometFactory.deploy({
      governor: await governor.getAddress(),
      pauseGuardian: await pauseGuardian.getAddress(),
      extensionDelegate: await extensionDelegate.getAddress(),
      baseToken: await tokens['USDC'].getAddress(),
      baseTokenPriceFeed: await priceFeeds['USDC'].getAddress(),
      supplyKink: exp(8, 17),
      supplyPerYearInterestRateBase: exp(5, 15),
      supplyPerYearInterestRateSlopeLow: exp(1, 17),
      supplyPerYearInterestRateSlopeHigh: exp(3, 18),
      borrowKink: exp(8, 17),
      borrowPerYearInterestRateBase: exp(5, 15),
      borrowPerYearInterestRateSlopeLow: exp(1, 17),
      borrowPerYearInterestRateSlopeHigh: exp(3, 18),
      storeFrontPriceFactor: exp(1, 18),
      trackingIndexScale: exp(1, 15),
      baseTrackingSupplySpeed: exp(1, 15),
      baseTrackingBorrowSpeed: exp(1, 15),
      baseMinForRewards: exp(1, 6),
      baseBorrowMin: exp(1, 6),
      targetReserves: 0,
      assetConfigs: [{
        asset: await tokens['EVIL'].getAddress(),
        priceFeed: await priceFeeds['EVIL'].getAddress(),
        decimals: assets['EVIL'].packedDecimals, // <-- packed decimals differ from deployed token's decimals
        borrowCollateralFactor: ONE - 1n,
        liquidateCollateralFactor: ONE,
        liquidationFactor: ONE,
        supplyCap: exp(100, 18),
      }],
    })).to.be.revertedWithCustomError(CometFactory, 'BadDecimals');
  });

  it('reverts if baseTokenPriceFeed does not have 8 decimals', async () => {
    await expect(
      makeProtocol({
        assets: {
          USDC: {
            priceFeedDecimals: 18,
          },
        },
      })
    ).to.be.revertedWithCustomError(cometErrors, 'BadDecimals');
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
    ).to.be.revertedWithCustomError(cometErrors, 'BadDecimals');
  });

  it('reverts if base token has fewer than 6 decimals', async () => {
    await expect(
      makeProtocol({
        assets: {
          USDC: {
            decimals: 5,
          },
        },
      })
    ).to.be.revertedWithCustomError(cometErrors, 'BadDecimals');
  });

  it('reverts if base token has more than 18 decimals', async () => {
    await expect(
      makeProtocol({
        assets: {
          USDC: {
            decimals: 19,
          },
        },
      })
    ).to.be.revertedWithCustomError(cometErrors, 'BadDecimals');
  });

  it('reverts if initializeStorage is called after initialization', async () => {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();
    await expect(
      comet.initializeStorage()
    ).to.be.revertedWithCustomError(comet, 'AlreadyInitialized');
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
});
