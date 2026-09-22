import { ZeroAddress } from 'ethers';
import type { Contract } from 'ethers';

import { ethers, expect, exp, makeProtocol, ONE } from './helpers.js';
import { CometHarnessExtendedAssetList__factory } from '../build/types/index.js';

const cometErrors = {
  interface: CometHarnessExtendedAssetList__factory.createInterface(),
};

describe('asset info', function () {
  it('initializes protocol', async () => {
    const { cometWithExtendedAssetList : comet, tokens } = await makeProtocol({
      assets: {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
      },
      reward: 'ASSET1',
    });

    const cometNumAssets = await comet.numAssets();
    const cometMaxAssets = await comet.maxAssets();
    expect(cometMaxAssets).to.be.equal(24);
    expect(cometNumAssets).to.be.equal(3);

    const assetInfo00 = await comet.getAssetInfo(0);
    expect(assetInfo00.asset).to.be.equal(await tokens['ASSET1'].getAddress());
    expect(assetInfo00.borrowCollateralFactor).to.equal(ONE - exp(1, 14));
    expect(assetInfo00.liquidateCollateralFactor).to.equal(ONE);

    const assetInfo01 = await comet.getAssetInfo(1);
    expect(assetInfo01.asset).to.be.equal(await tokens['ASSET2'].getAddress());
    expect(assetInfo01.borrowCollateralFactor).to.equal(ONE - exp(1, 14));
    expect(assetInfo01.liquidateCollateralFactor).to.equal(ONE);

    const assetInfo02 = await comet.getAssetInfo(2);
    expect(assetInfo02.asset).to.be.equal(await tokens['ASSET3'].getAddress());
    expect(assetInfo02.borrowCollateralFactor).to.equal(ONE - exp(1, 14));
    expect(assetInfo02.liquidateCollateralFactor).to.equal(ONE);
  });

  it('reverts if too many assets are passed', async () => {
    const priceFeeds: Record<string, Contract> = {};
    const assets = {
      USDC: {},
      ASSET1: {},
      ASSET2: {},
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
      ASSET24: {},
      ASSET25: {},
    };
    const base = 'USDC';
    const PriceFeedFactory = await ethers.getContractFactory('SimplePriceFeed');
    for (const asset in assets) {
      const initialPrice = exp(assets[asset].initialPrice || 1, 8);
      const priceFeedDecimals = assets[asset].priceFeedDecimals || 8;
      const priceFeed = await PriceFeedFactory.deploy(initialPrice, priceFeedDecimals);
      await priceFeed.waitForDeployment();
      priceFeeds[asset] = priceFeed;
    }
    const FaucetFactory = await ethers.getContractFactory('FaucetToken');
    const tokens: Record<string, Contract> = {};
    for (const symbol in assets) {
      const config = assets[symbol];
      const decimals = config.decimals || 18;
      const initial = config.initial || 1e6;
      const name = config.name || symbol;
      const factory = config.factory || FaucetFactory;
      const token = (tokens[symbol] = await factory.deploy(initial, name, decimals, symbol));
      await token.waitForDeployment();
    }
    const assetConfigs = [];
    for (const symbol of Object.keys(assets)) {
      if (symbol !== base) {
        assetConfigs.push({
          asset: await tokens[symbol].getAddress(),
          priceFeed: await priceFeeds[symbol].getAddress(),
          decimals: 18,
          borrowCollateralFactor: ONE - 1n,
          liquidateCollateralFactor: ONE,
          liquidationFactor: ONE,
          supplyCap: exp(100, 18),
        });
      }
    }

    const config = {
      governor: ZeroAddress,
      pauseGuardian: ZeroAddress,
      extensionDelegate: ZeroAddress,
      baseToken: await tokens[base].getAddress(),
      baseTokenPriceFeed: await priceFeeds[base].getAddress(),
      supplyKink: 0,
      supplyPerYearInterestRateBase: 0,
      supplyPerYearInterestRateSlopeLow: 0,
      supplyPerYearInterestRateSlopeHigh: 0,
      borrowKink: 0,
      borrowPerYearInterestRateBase: 0,
      borrowPerYearInterestRateSlopeLow: 0,
      borrowPerYearInterestRateSlopeHigh: 0,
      storeFrontPriceFactor: 8,
      trackingIndexScale: 0,
      baseTrackingSupplySpeed: 0,
      baseTrackingBorrowSpeed: 0,
      baseMinForRewards: 0,
      baseBorrowMin: 0,
      targetReserves: 0,
      assetConfigs,
    };
    const CometFactory = await ethers.getContractFactory('CometHarnessExtendedAssetList');
    await expect(
      CometFactory.deploy(config)
    ).to.be.revertedWithCustomError(CometFactory, 'TooManyAssets');
  });

  it('reverts if index is greater than numAssets', async () => {
    const { cometWithExtendedAssetList : comet } = await makeProtocol();
    await expect(comet.getAssetInfo(3)).to.be.revertedWithCustomError(comet, 'BadAsset');
  });

  it('reverts if collateral factors are out of range', async () => {
    await expect(makeProtocol({
      assets: {
        USDC: {},
        ASSET1: {borrowCF: exp(0.9, 18), liquidateCF: exp(0.9, 18)},
        ASSET2: {},
      },
    })).to.be.revertedWithCustomError(cometErrors, 'BorrowCFTooLarge');

    // check descaled factors
    await expect(makeProtocol({
      assets: {
        USDC: {},
        ASSET1: {borrowCF: exp(0.9, 18), liquidateCF: exp(0.9, 18) + 1n},
        ASSET2: {},
      },
    })).to.be.revertedWithCustomError(cometErrors, 'BorrowCFTooLarge');

    await expect(makeProtocol({
      assets: {
        USDC: {},
        ASSET1: {borrowCF: exp(0.99, 18), liquidateCF: exp(1.1, 18)},
        ASSET2: {},
      },
    })).to.be.revertedWithCustomError(cometErrors, 'LiquidateCFTooLarge');
  });
});
