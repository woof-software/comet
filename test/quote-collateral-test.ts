import { CometHarnessInterfaceExtendedAssetList, CometProxyAdmin, Configurator, ConfiguratorProxy, FaucetToken, NonStandardFaucetFeeToken, PriceFeedWithRevert, PriceFeedWithRevert__factory, SimplePriceFeed } from 'build/types';
import { AssetInfoStructOutput } from 'build/types/CometHarnessInterfaceExtendedAssetList';
import { expect, exp, ethers, MAX_ASSETS, mulFactor, factorScale, makeConfigurator, ZERO_ADDRESS, SnapshotRestorer, takeSnapshot } from './helpers';
import { BigNumber } from 'ethers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('quoteCollateral', function () {
  // Constants
  const baseTokenDecimals = 6;
  const collateralTokenDecimals = 18;
  // Configurator and protocol
  let comet: CometHarnessInterfaceExtendedAssetList;
  let configurator: Configurator;
  let configuratorProxyAddress: string;
  let proxyAdmin: CometProxyAdmin;
  // Tokens
  let baseSymbol: string;
  let baseToken: FaucetToken | NonStandardFaucetFeeToken;
  let collateralToken: FaucetToken | NonStandardFaucetFeeToken;
  let tokens: Record<string, FaucetToken | NonStandardFaucetFeeToken>;
  // Price feeds
  let priceFeeds: Record<string, SimplePriceFeed>;
  // Users
  let alice: SignerWithAddress;

  async function updateStoreFrontPriceFactor(factor: bigint) {
    await configurator.setStoreFrontPriceFactor(comet.address, factor);
    await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);
  }

  before(async () => {
    const collaterals = Object.fromEntries(
      Array.from({ length: MAX_ASSETS }, (_, j) => [
        `ASSET${j}`,
        {
          decimals: j < 8 ? 18 : j < 16 ? 8 : 6,
          initialPrice: j > 1 ? 200 : 200 + (10 * j),
          borrowCF: exp(0.75, 18),
          liquidateCF: exp(0.8, 18),
          liquidationFactor: exp(0.6, 18),
        },
      ])
    );
    const protocol = await makeConfigurator({
      assets: {
        USDC: { decimals: baseTokenDecimals, initialPrice: 1 },
        ...collaterals,
      },
      storeFrontPriceFactor: exp(0.5, 18),
    });
    const cometProxyAddress = protocol.cometProxyWithExtendedAssetList.address;
    comet = protocol.cometWithExtendedAssetList.attach(cometProxyAddress);
    configurator = protocol.configurator;
    configuratorProxyAddress = protocol.configuratorProxy.address;
    proxyAdmin = protocol.proxyAdmin;
    [alice] = protocol.users;
    baseSymbol = protocol.base;
    baseToken = protocol.tokens[baseSymbol];
    collateralToken = protocol.tokens['ASSET0'];
    tokens = protocol.tokens;
    priceFeeds = protocol.priceFeeds;

    // Upgrade proxy to extended asset list implementation
    const assetListFactory = protocol.assetListFactory;
    configurator = configurator.attach(configuratorProxyAddress);
    const CometExtAssetList = await (
      await ethers.getContractFactory('CometExtAssetList')
    ).deploy(
      {
        name32: ethers.utils.formatBytes32String('Test Comet'),
        symbol32: ethers.utils.formatBytes32String('Test Comet'),
      },
      assetListFactory.address
    );
    await CometExtAssetList.deployed();
    await configurator.setExtensionDelegate(cometProxyAddress, CometExtAssetList.address);
    const CometFactoryWithExtendedAssetList = await (await ethers.getContractFactory('CometFactoryWithExtendedAssetList')).deploy();
    await CometFactoryWithExtendedAssetList.deployed();
    await configurator.setFactory(cometProxyAddress, CometFactoryWithExtendedAssetList.address);

    // Deploy and upgrade to apply changes
    await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);
  });

  // ─────────────────────────────────────────────────────────
  //  1. Discount / storefront math
  // ─────────────────────────────────────────────────────────
  describe('discount / storefront math', function () {
    it('returns 0 for zero baseAmount', async () => {
      const quote = await comet.quoteCollateral(collateralToken.address, 0);
      expect(quote).to.equal(0);
    });

    it('quotes correctly for a positive baseAmount', async () => {
      // ASSET0: price = $200, liquidationFactor = 0.6, storeFrontPriceFactor = 0.5
      // discountFactor = 0.5 * (1 - 0.6) = 0.2
      // assetPriceDiscounted = 200e8 * (1 - 0.2) = 160e8
      // basePrice = 1e8, baseScale = 1e6, assetScale = 1e18
      // quote = 1e8 * 200e6 * 1e18 / 160e8 / 1e6 = 1.25e18
      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

      const basePrice = exp(1, 8);
      const assetPrice = exp(200, 8);
      const assetScale = exp(1, collateralTokenDecimals);
      const baseScale = exp(1, baseTokenDecimals);
      const discountFactor = mulFactor(exp(0.5, 18), factorScale - exp(0.6, 18));
      const assetPriceDiscounted = mulFactor(assetPrice, factorScale - discountFactor);
      const expected = basePrice * baseAmount * assetScale / assetPriceDiscounted / baseScale;

      expect(quote).to.equal(expected);
      expect(quote).to.equal(exp(1.25, 18));
    });

    it('no discount when storeFrontPriceFactor = 0', async () => {
      // Set storeFrontPriceFactor to 0 via configurator
      await updateStoreFrontPriceFactor(0n);
      
      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // discountFactor = 0 * (1 - 0.6) = 0
      // assetPriceDiscounted = 200e8 * 1 = 200e8
      // quote = 1e8 * 200e6 * 1e18 / 200e8 / 1e6 = 1e18
      expect(quote).to.equal(exp(1, 18));
    });

    it('20% storeFrontPriceFactor', async () => {
      await updateStoreFrontPriceFactor(exp(0.2, 18));

      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // discountFactor = 0.2 * (1 - 0.6) = 0.08
      // assetPriceDiscounted = 200e8 * 0.92 = 184e8
      const discountFactor = mulFactor(exp(0.2, 18), factorScale - exp(0.6, 18));
      const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
      const expected = exp(1, 8) * baseAmount * exp(1, 18) / assetPriceDiscounted / exp(1, 6);
      expect(quote).to.equal(expected);
    });

    it('40% storeFrontPriceFactor', async () => {
      await updateStoreFrontPriceFactor(exp(0.4, 18));

      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // discountFactor = 0.4 * (1 - 0.6) = 0.16
      // assetPriceDiscounted = 200e8 * 0.84 = 168e8
      const discountFactor = mulFactor(exp(0.4, 18), factorScale - exp(0.6, 18));
      const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
      const expected = exp(1, 8) * baseAmount * exp(1, 18) / assetPriceDiscounted / exp(1, 6);
      expect(quote).to.equal(expected);
    });

    it('60% storeFrontPriceFactor', async () => {
      await updateStoreFrontPriceFactor(exp(0.6, 18));

      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // discountFactor = 0.6 * (1 - 0.6) = 0.24
      // assetPriceDiscounted = 200e8 * 0.76 = 152e8
      const discountFactor = mulFactor(exp(0.6, 18), factorScale - exp(0.6, 18));
      const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
      const expected = exp(1, 8) * baseAmount * exp(1, 18) / assetPriceDiscounted / exp(1, 6);
      expect(quote).to.equal(expected);
    });

    it('80% storeFrontPriceFactor', async () => {
      await updateStoreFrontPriceFactor(exp(0.8, 18));

      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // discountFactor = 0.8 * (1 - 0.6) = 0.32
      // assetPriceDiscounted = 200e8 * 0.68 = 136e8
      const discountFactor = mulFactor(exp(0.8, 18), factorScale - exp(0.6, 18));
      const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
      const expected = exp(1, 8) * baseAmount * exp(1, 18) / assetPriceDiscounted / exp(1, 6);
      expect(quote).to.equal(expected);
    });

    describe('temporary liquidationFactor overrides', function () {
      let snapshot: SnapshotRestorer;

      beforeEach(async () => {
        snapshot = await takeSnapshot();
      });

      afterEach(async () => {
        await snapshot.restore();
      });

      it('liquidation CF = 0.01% (near-zero like deUSD on USDT market)', async () => {
        // liquidationFactor = 0.0001 → discount is nearly the full storeFrontPriceFactor
        // discountFactor = 0.8 * (1 - 0.0001) ≈ 0.79992
        // assetPriceDiscounted = 200e8 * (1 - 0.79992) ≈ 40.016e8
        await updateStoreFrontPriceFactor(exp(0.8, 18));
        await configurator.updateAssetLiquidationFactor(comet.address, collateralToken.address, exp(0.0001, 18));
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);

        const baseAmount = exp(200, baseTokenDecimals);
        const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

        const discountFactor = mulFactor(exp(0.8, 18), factorScale - exp(0.0001, 18));
        const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
        const expected = exp(1, 8) * baseAmount * exp(1, 18) / assetPriceDiscounted / exp(1, 6);
        expect(quote).to.equal(expected);
        // With essentially ~50% discount, quote should be roughly 2x the no-discount amount
        expect(quote).to.be.gt(exp(1.99, 18));
      });

      it('no discount when liquidationFactor = 0 (storeFrontPriceFactor = 1e18)', async () => {
        await updateStoreFrontPriceFactor(exp(1, 18));
        await configurator.updateAssetLiquidationFactor(comet.address, collateralToken.address, 0);
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);

        const baseAmount = exp(200, baseTokenDecimals);
        const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

        // No discount applied: assetPriceDiscounted = assetPrice = 200e8
        // quote = 1e8 * 200e6 * 1e18 / 200e8 / 1e6 = 1e18
        expect(quote).to.equal(exp(1, 18));
      });
    });

    it('100% storeFrontPriceFactor with normal liquidationFactor', async () => {
      await updateStoreFrontPriceFactor(exp(1, 18));

      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // discountFactor = 1.0 * (1 - 0.6) = 0.4
      // assetPriceDiscounted = 200e8 * (1 - 0.4) = 200e8 * 0.6 = 120e8 (non-zero, safe)
      // quote = 1e8 * 200e6 * 1e18 / 120e8 / 1e6 ≈ 1.666...e18
      const discountFactor = mulFactor(exp(1, 18), factorScale - exp(0.6, 18));
      const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
      const expected = exp(1, 8) * baseAmount * exp(1, 18) / assetPriceDiscounted / exp(1, 6);
      expect(quote).to.equal(expected);
      // At maximum discount the buyer gets more collateral per base
      expect(quote).to.be.gt(exp(1.66, 18));
    });
  });

  // ─────────────────────────────────────────────────────────
  //  2. Rounding and precision
  // ─────────────────────────────────────────────────────────
  describe('rounding and precision', function () {
    before(async () => {
      // Set storeFrontPriceFactor to 0.5 for consistent rounding tests (some tests above change it)
      await updateStoreFrontPriceFactor(exp(0.5, 18));
    });
    it('dust baseAmount rounds down to 0 (no revert)', async () => {
      // ASSET8: decimals=8, price=$200, discountedPrice=160e8
      // baseAmount=1 (1 wei of USDC):
      // quote = 1e8 * 1 * 1e8 / 160e8 / 1e6 = 1e16 / 1.6e10 / 1e6 = 0 (truncated)
      const asset8 = tokens['ASSET8'];
      const quote = await comet.quoteCollateral(asset8.address, 1);
      expect(quote).to.equal(0);
    });

    it('does not overflow for large baseAmount', async () => {
      const baseAmount = exp(1, 15 + baseTokenDecimals); // 1 quadrillion USDC
      const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // discountFactor = 0.5 * (1 - 0.6) = 0.2
      // assetPriceDiscounted = 200e8 * 0.8 = 160e8
      // quote = 1e8 * 1e21 * 1e18 / 160e8 / 1e6 = 6.25e12 * 1e18 = 6.25e30
      const discountFactor = mulFactor(exp(0.5, 18), factorScale - exp(0.6, 18));
      const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
      const expected = exp(1, 8) * baseAmount * exp(1, 18) / assetPriceDiscounted / exp(1, 6);
      expect(quote).to.equal(expected);
    });

    it('correctly scales for 6-decimal collateral', async () => {
      // ASSET16 has decimals=6
      const asset = tokens['ASSET16'];
      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(asset.address, baseAmount);

      // assetScale = 1e6, baseScale = 1e6, basePrice = 1e8, assetPrice = 200e8
      // discountFactor = 0.5 * (1 - 0.6) = 0.2
      // assetPriceDiscounted = 200e8 * 0.8 = 160e8
      // quote = 1e8 * 200e6 * 1e6 / 160e8 / 1e6 = 1.25
      const discountFactor = mulFactor(exp(0.5, 18), factorScale - exp(0.6, 18));
      const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
      const expected = exp(1, 8) * baseAmount * exp(1, 6) / assetPriceDiscounted / exp(1, 6);
      expect(quote).to.equal(expected);
      expect(quote).to.equal(exp(1.25, 6));
    });

    it('correctly scales for 8-decimal collateral', async () => {
      // ASSET8 has decimals=8
      const asset = tokens['ASSET8'];
      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(asset.address, baseAmount);

      // assetScale = 1e8
      // quote = 1e8 * 200e6 * 1e8 / 160e8 / 1e6 = 1.25e8
      const discountFactor = mulFactor(exp(0.5, 18), factorScale - exp(0.6, 18));
      const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
      const expected = exp(1, 8) * baseAmount * exp(1, 8) / assetPriceDiscounted / exp(1, 6);
      expect(quote).to.equal(expected);
      expect(quote).to.equal(exp(1.25, 8));
    });

    it('correctly scales for 18-decimal collateral', async () => {
      // ASSET0 has decimals=18
      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // quote = 1e8 * 200e6 * 1e18 / 160e8 / 1e6 = 1.25e18
      const discountFactor = mulFactor(exp(0.5, 18), factorScale - exp(0.6, 18));
      const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
      const expected = exp(1, 8) * baseAmount * exp(1, 18) / assetPriceDiscounted / exp(1, 6);
      expect(quote).to.equal(expected);
      expect(quote).to.equal(exp(1.25, 18));
    });

    it('intermediate multiplication does not truncate (precision test)', async () => {
      // Use a collateral price that would cause truncation if division happened first
      // Set ASSET0 price to $9, storeFrontPriceFactor = 0.5, liquidationFactor = 0.8
      await priceFeeds['ASSET0'].setRoundData(1, exp(9, 8), 0, 0, 1);
      await configurator.updateAssetLiquidationFactor(comet.address, collateralToken.address, exp(0.8, 18));
      await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);

      const baseAmount = exp(810, baseTokenDecimals);
      const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // discountFactor = 0.5 * (1 - 0.8) = 0.1
      // assetPriceDiscounted = 9e8 * 0.9 = 8.1e8
      // quote = 1e8 * 810e6 * 1e18 / 8.1e8 / 1e6 = 100e18
      expect(quote).to.equal(exp(100, 18));
    });
  });

  // ─────────────────────────────────────────────────────────
  //  3. 24 collaterals test
  // ─────────────────────────────────────────────────────────
  describe('24 collaterals support', function () {
    it('comet supports 24 collateral assets', async () => {
      expect(await comet.numAssets()).to.equal(MAX_ASSETS);
      expect(await comet.numAssets()).to.equal(24);
      expect(await comet.getAssetInfo(MAX_ASSETS - 1)).to.not.be.undefined;
    });

    it('quoteCollateral works correctly for each of 24 collateral assets', async () => {
      const baseAmount = exp(200, baseTokenDecimals);
      const basePrice = exp(1, 8);
      const baseScale = exp(1, baseTokenDecimals);

      for (let i = 0; i < MAX_ASSETS; i++) {
        const assetInfo = await comet.getAssetInfo(i);
        const assetPrice = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();
        const assetScale = assetInfo.scale.toBigInt();
        const liquidationFactor = assetInfo.liquidationFactor.toBigInt();

        const discountFactor = mulFactor(exp(0.5, 18), factorScale - liquidationFactor);
        const assetPriceDiscounted = mulFactor(assetPrice, factorScale - discountFactor);
        const expected = basePrice * baseAmount * assetScale / assetPriceDiscounted / baseScale;

        const quote = await comet.quoteCollateral(assetInfo.asset, baseAmount);
        expect(quote).to.equal(expected, `quoteCollateral mismatch for ASSET${i}`);
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  //  4. Reverts
  // ─────────────────────────────────────────────────────────
  describe('reverts', function () {
    describe('invalid / unsupported asset', function () {
      it('reverts for an unsupported token address', async () => {
        const unsupported = await (await ethers.getContractFactory('FaucetToken')).deploy(1e6, 'Unsupported', 18, 'UNSUP');
        await unsupported.deployed();
        await expect(
          comet.quoteCollateral(unsupported.address, exp(100, baseTokenDecimals))
        ).to.be.revertedWithCustomError(comet, 'BadAsset');
      });

      it('reverts when asset is the base token', async () => {
        await expect(
          comet.quoteCollateral(baseToken.address, exp(100, baseTokenDecimals))
        ).to.be.revertedWithCustomError(comet, 'BadAsset');
      });

      it('reverts for zero address', async () => {
        await expect(
          comet.quoteCollateral(ZERO_ADDRESS, exp(100, baseTokenDecimals))
        ).to.be.revertedWithCustomError(comet, 'BadAsset');
      });
    });

    describe('price feed behavior', function () {
      let snapshot: SnapshotRestorer;
      this.beforeEach(async () => {
        // Take a snapshot before the price feed tests to restore from after each test
        snapshot = await takeSnapshot();
      });

      this.afterEach(async () => {
        // Restore to clean state after each test
        await snapshot.restore();
      });

      it('reverts when collateral price feed returns 0', async () => {
        await priceFeeds['ASSET0'].setRoundData(1, 0, 0, 0, 1);
        await configurator.updateAssetPriceFeed(comet.address, collateralToken.address, priceFeeds['ASSET0'].address);
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);

        await expect(
          comet.quoteCollateral(collateralToken.address, exp(100, baseTokenDecimals))
        ).to.be.revertedWithCustomError(comet, 'BadPrice');
      });

      it('reverts when collateral price feed returns negative price', async () => {
        await priceFeeds['ASSET0'].setRoundData(1, -1 * 10 ** 8, 0, 0, 1);
        await configurator.updateAssetPriceFeed(comet.address, collateralToken.address, priceFeeds['ASSET0'].address);
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);

        await expect(
          comet.quoteCollateral(collateralToken.address, exp(100, baseTokenDecimals))
        ).to.be.revertedWithCustomError(comet, 'BadPrice');
      });

      it('reverts when base token price feed returns 0', async () => {
        await priceFeeds['USDC'].setRoundData(1, 0, 0, 0, 1);
        await configurator.setBaseTokenPriceFeed(comet.address, priceFeeds['USDC'].address);
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);

        await expect(
          comet.quoteCollateral(collateralToken.address, exp(100, baseTokenDecimals))
        ).to.be.revertedWithCustomError(comet, 'BadPrice');
      });

      it('reverts when base token price feed returns negative price', async () => {
        await priceFeeds['USDC'].setRoundData(1, -1 * 10 ** 8, 0, 0, 1);
        await configurator.setBaseTokenPriceFeed(comet.address, priceFeeds['USDC'].address);
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);

        await expect(
          comet.quoteCollateral(collateralToken.address, exp(100, baseTokenDecimals))
        ).to.be.revertedWithCustomError(comet, 'BadPrice');
      });

      it('reverts when collateral price feed is broken (reverts)', async () => {
        const factory = await ethers.getContractFactory('PriceFeedWithRevert');
        const brokenPriceFeed = await factory.deploy(exp(1, 8), 8) as PriceFeedWithRevert;
        await brokenPriceFeed.deployed();

        await configurator.updateAssetPriceFeed(comet.address, collateralToken.address, brokenPriceFeed.address);
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);

        await expect(
          comet.quoteCollateral(collateralToken.address, exp(100, baseTokenDecimals))
        ).to.be.revertedWithCustomError(brokenPriceFeed, 'Reverted');
      });

      it('reverts when base token price feed is broken (reverts)', async () => {
        const factory = await ethers.getContractFactory('PriceFeedWithRevert');
        const brokenPriceFeed = await factory.deploy(exp(1, 8), 8) as PriceFeedWithRevert;
        await brokenPriceFeed.deployed();

        await configurator.setBaseTokenPriceFeed(comet.address, brokenPriceFeed.address);
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);

        await expect(
          comet.quoteCollateral(collateralToken.address, exp(100, baseTokenDecimals))
        ).to.be.revertedWithCustomError(brokenPriceFeed, 'Reverted');
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  //  5. Price changes between quoteCollateral calls
  // ─────────────────────────────────────────────────────────
  describe('price changes between quoteCollateral calls', function () {
    let snapshot: SnapshotRestorer;

    before(async () => {
      // Reset to known state: storeFrontPriceFactor=0.5, ASSET0=$200, USDC=$1
      await configurator.setStoreFrontPriceFactor(comet.address, exp(0.5, 18));
      await configurator.updateAssetLiquidationFactor(comet.address, collateralToken.address, exp(0.6, 18));
      await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);
      await priceFeeds['ASSET0'].setRoundData(1, exp(200, 8), 0, 0, 1);
      await priceFeeds['USDC'].setRoundData(1, exp(1, 8), 0, 0, 1);
    });

    beforeEach(async () => {
      snapshot = await takeSnapshot();
    });

    afterEach(async () => {
      await snapshot.restore();
    });

    it('quote changes when collateral price moves between two calls', async () => {
      const baseAmount = exp(200, baseTokenDecimals);

      // Quote at $200
      const quoteBefore = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // Price drops $200 → $100
      await priceFeeds['ASSET0'].setRoundData(1, exp(100, 8), 0, 0, 1);

      // Quote at $100 — buyer gets more collateral (cheaper asset)
      const quoteAfter = await comet.quoteCollateral(collateralToken.address, baseAmount);

      expect(quoteAfter).to.be.gt(quoteBefore);
      // At half the price, buyer should get exactly double
      expect(quoteAfter).to.equal(quoteBefore.toBigInt() * 2n);
    });

    it('quote changes when base token price moves between two calls', async () => {
      const baseAmount = exp(200, baseTokenDecimals);

      // Quote at USDC = $1
      const quoteBefore = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // USDC price doubles: $1 → $2
      await priceFeeds['USDC'].setRoundData(1, exp(2, 8), 0, 0, 1);

      // Quote at USDC = $2 — each USDC is worth more, so buyer gets more collateral
      const quoteAfter = await comet.quoteCollateral(collateralToken.address, baseAmount);

      expect(quoteAfter).to.be.gt(quoteBefore);
      expect(quoteAfter).to.equal(quoteBefore.toBigInt() * 2n);
    });

    it('buyCollateral reverts with stale minAmount after price increase', async () => {
      // Setup reserves
      await configurator.setTargetReserves(comet.address, exp(1, 18));
      await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);
      await collateralToken.allocateTo(comet.address, exp(50, collateralTokenDecimals));

      const baseAmount = exp(200, baseTokenDecimals);
      await baseToken.allocateTo(alice.address, baseAmount);

      // Quote at current price ($200)
      const staleQuote = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // Collateral price rises $200 → $400, making the new quote smaller
      await priceFeeds['ASSET0'].setRoundData(1, exp(400, 8), 0, 0, 1);

      const freshQuote = await comet.quoteCollateral(collateralToken.address, baseAmount);
      expect(freshQuote).to.be.lt(staleQuote);

      // Buyer uses stale (larger) minAmount — should revert with TooMuchSlippage
      await baseToken.connect(alice).approve(comet.address, baseAmount);
      await expect(
        comet.connect(alice).buyCollateral(
          collateralToken.address,
          staleQuote, // stale, higher than what the contract will compute now
          baseAmount,
          alice.address
        )
      ).to.be.revertedWithCustomError(comet, 'TooMuchSlippage');
    });

    it('same-block: price feed update and query see new price after mine', async () => {
      const baseAmount = exp(200, baseTokenDecimals);

      // Quote before price change
      const quoteBefore = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // Disable automine so we can batch the price update into one block
      await ethers.provider.send('evm_setAutomine', [false]);
      await priceFeeds['ASSET0'].setRoundData(1, exp(100, 8), 0, 0, 1);

      // Mine the block containing the price update
      await ethers.provider.send('evm_mine', []);
      await ethers.provider.send('evm_setAutomine', [true]);

      // Post-mine: quote should reflect the new $100 price
      const quoteAfter = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // At half the price, buyer should get exactly double
      expect(quoteAfter).to.equal(quoteBefore.toBigInt() * 2n);
    });
  });

  // ─────────────────────────────────────────────────────────
  //  6. Different base token price (base != $1)
  // ─────────────────────────────────────────────────────────
  describe('different base token price (base != $1)', function () {
    let snapshot: SnapshotRestorer;

    before(async () => {
      // Reset to known state: storeFrontPriceFactor=0.5, ASSET0=$200, liquidationFactor=0.6, USDC=$1
      await configurator.setStoreFrontPriceFactor(comet.address, exp(0.5, 18));
      await configurator.updateAssetLiquidationFactor(comet.address, collateralToken.address, exp(0.6, 18));
      await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);
      await priceFeeds['ASSET0'].setRoundData(1, exp(200, 8), 0, 0, 1);
      await priceFeeds['USDC'].setRoundData(1, exp(1, 8), 0, 0, 1);
    });

    beforeEach(async () => {
      snapshot = await takeSnapshot();
    });

    afterEach(async () => {
      await snapshot.restore();
    });

    it('quote scales linearly with base token price', async () => {
      const baseAmount = exp(200, baseTokenDecimals);

      // Quote at USDC = $1
      const quoteAt1 = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // Set USDC price to $3 (simulating a non-unit-price base, e.g. WETH-based market)
      await priceFeeds['USDC'].setRoundData(1, exp(3, 8), 0, 0, 1);
      const quoteAt3 = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // basePrice is a multiplicative factor, so 3x price → 3x quote
      expect(quoteAt3).to.equal(quoteAt1.toBigInt() * 3n);
    });

    it('correct quote with WBTC-like base price ($60,000)', async () => {
      // Simulate a WBTC-based market: base token at $60,000
      await priceFeeds['USDC'].setRoundData(1, exp(60000, 8), 0, 0, 1);

      const baseAmount = exp(1, baseTokenDecimals); // 1 unit of base
      const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // ASSET0: price $200, liquidationFactor 0.6, storeFrontPriceFactor 0.5
      // discountFactor = 0.5 * 0.4 = 0.2
      // assetPriceDiscounted = 200e8 * 0.8 = 160e8
      // quote = 60000e8 * 1e6 * 1e18 / 160e8 / 1e6 = 375e18
      const discountFactor = mulFactor(exp(0.5, 18), factorScale - exp(0.6, 18));
      const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
      const expected = exp(60000, 8) * baseAmount * exp(1, 18) / assetPriceDiscounted / exp(1, 6);
      expect(quote).to.equal(expected);
      expect(quote).to.equal(exp(375, 18));
    });

    it('correct quote with WETH-like base price ($3,000)', async () => {
      // Simulate a WETH-based market: base token at $3,000
      await priceFeeds['USDC'].setRoundData(1, exp(3000, 8), 0, 0, 1);

      const baseAmount = exp(10, baseTokenDecimals); // 10 units of base
      const quote = await comet.quoteCollateral(collateralToken.address, baseAmount);

      // quote = 3000e8 * 10e6 * 1e18 / 160e8 / 1e6 = 187.5e18
      const discountFactor = mulFactor(exp(0.5, 18), factorScale - exp(0.6, 18));
      const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
      const expected = exp(3000, 8) * baseAmount * exp(1, 18) / assetPriceDiscounted / exp(1, 6);
      expect(quote).to.equal(expected);
      expect(quote).to.equal(exp(187.5, 18));
    });

    it('quote truncates to zero when base token price is very small and baseAmount is small', async () => {
      // Edge case: very cheap base token with small amount
      // Set base price to smallest valid: 1 (= 1e-8 USD)
      await priceFeeds['USDC'].setRoundData(1, 1, 0, 0, 1);
      // Raise collateral price so the denominator dominates
      await priceFeeds['ASSET0'].setRoundData(1, exp(1_000_000, 8), 0, 0, 1);

      // assetPriceDiscounted = 1_000_000e8 * 0.8 = 800_000e8
      // quote = 1 * 1 * 1e18 / 800_000e8 / 1e6 = 1e18 / 8e19 = 0 (truncated)
      const quote = await comet.quoteCollateral(collateralToken.address, 1);
      expect(quote).to.equal(0);
    });
  });

  /*
   * This test suite was written after the USDM incident, when a token price feed was removed from Chainlink.
   * The incident revealed that when a price feed becomes unavailable, the protocol cannot calculate the USD value
   * of collateral (e.g., during absorption when trying to getPrice() for a delisted asset).
   *
   * The solution was to set the asset's liquidationFactor to 0 for delisted collateral. This affects both:
   * - Absorption: Assets with liquidationFactor = 0 are skipped (cannot calculate their USD value)
   * - quoteCollateral: When liquidationFactor = 0, the store front discount becomes 0, and quoteCollateral
   *   quotes at market price without any discount (see quoteCollateral() in CometHarnessInterfaceExtendedAssetList.sol)
   *
   * This test suite verifies that quoteCollateral behaves correctly when liquidationFactor is set to 0:
   * - It should quote at market price (no discount) when liquidationFactor = 0
   * - It should handle the transition from liquidationFactor > 0 to liquidationFactor = 0 correctly
   * - It should work correctly for all assets in the protocol, even when at the maximum asset limit
   */
  describe('quote without discount', function () {
    // This describe block tests quoteCollateral behavior when liquidationFactor = 0 (no discount scenario).
    // It verifies that:
    // 1. quoteCollateral correctly quotes at market price when liquidationFactor > 0 (with discount)
    // 2. After setting liquidationFactor to 0, quoteCollateral quotes at market price (no discount)
    // 3. The transition between states works correctly for all assets, including at MAX_ASSETS limit

    // Snapshot
    let snapshot: SnapshotRestorer;

    // Contracts
    let comet: CometHarnessInterfaceExtendedAssetList;
    let configurator: Configurator;
    let configuratorProxy: ConfiguratorProxy;
    let proxyAdmin: CometProxyAdmin;
    let cometProxyAddress: string;
    let assetListFactoryAddress: string;

    // Constants
    const QUOTE_AMOUNT = exp(200, 6);

    // Variables
    let quoteAmount: BigNumber;
    let quoteCollateralToken: FaucetToken | NonStandardFaucetFeeToken;
    let tokens: Record<string, FaucetToken | NonStandardFaucetFeeToken>;

    // Quote calculations data
    let assetInfo: AssetInfoStructOutput;
    let assetPrice: BigNumber;
    let basePrice: BigNumber;
    let baseScale: BigNumber;

    before(async () => {
      const collaterals = Object.fromEntries(
        Array.from({ length: MAX_ASSETS }, (_, j) => [
          `ASSET${j}`,
          {
            decimals: 18,
            initialPrice: 200,
            liquidationFactor: exp(0.6, 18),
          },
        ])
      );
      const configuratorAndProtocol = await makeConfigurator({ assets: { USDC: { decimals: 6, initialPrice: 1 }, ...collaterals }});

      cometProxyAddress = configuratorAndProtocol.cometProxyWithExtendedAssetList.address;
      comet = configuratorAndProtocol.cometWithExtendedAssetList.attach(cometProxyAddress) as CometHarnessInterfaceExtendedAssetList;
      configurator = configuratorAndProtocol.configurator;
      configuratorProxy = configuratorAndProtocol.configuratorProxy;
      proxyAdmin = configuratorAndProtocol.proxyAdmin;
      tokens = configuratorAndProtocol.tokens;
      assetListFactoryAddress = configuratorAndProtocol.assetListFactory.address;
      quoteCollateralToken = tokens[`ASSET1`];
      configurator = configurator.attach(configuratorProxy.address);

      const CometExtAssetList = await (
        await ethers.getContractFactory('CometExtAssetList')
      ).deploy(
        {
          name32: ethers.utils.formatBytes32String('Compound Comet'),
          symbol32: ethers.utils.formatBytes32String('BASE'),
        },
        assetListFactoryAddress
      );
      await CometExtAssetList.deployed();
      await configurator.setExtensionDelegate(cometProxyAddress, CometExtAssetList.address);
      const CometFactoryWithExtendedAssetList = await (await ethers.getContractFactory('CometFactoryWithExtendedAssetList')).deploy();
      await CometFactoryWithExtendedAssetList.deployed();
      await configurator.setFactory(cometProxyAddress, CometFactoryWithExtendedAssetList.address);
      await proxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxyAddress);

      // Culculation data
      assetInfo = await comet.getAssetInfoByAddress(quoteCollateralToken.address);
      assetPrice = await comet.getPrice(assetInfo.priceFeed);
      basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      baseScale = await comet.baseScale();

      snapshot = await takeSnapshot();
    });

    it('quotes with discount if liquidationFactor > 0', async () => {
      // Ensure liquidationFactor is not zero (discount present)
      expect(assetInfo.liquidationFactor).to.not.eq(0);

      quoteAmount = await comet.quoteCollateral(quoteCollateralToken.address, QUOTE_AMOUNT);
    });

    it('computes expected discount and matches contract value', async () => {
      // discount = storeFrontPriceFactor * (1e18 - liquidationFactor)
      const discountFactor = mulFactor((await comet.storeFrontPriceFactor()).toBigInt(), BigNumber.from(factorScale).sub(assetInfo.liquidationFactor).toBigInt());
      // assetPriceDiscounted = assetPrice * (1e18 - discount)
      const assetPriceDiscounted = mulFactor(assetPrice.toBigInt(), BigNumber.from(factorScale).sub(discountFactor).toBigInt());
      // expected quote calculation
      const expectedQuoteWithDiscount = basePrice.mul(QUOTE_AMOUNT).mul(assetInfo.scale).div(assetPriceDiscounted).div(baseScale);

      expect(quoteAmount).to.eq(expectedQuoteWithDiscount);
    });

    it('update liquidationFactor to 0 to remove discount', async () => {
      await configurator.updateAssetLiquidationFactor(cometProxyAddress, quoteCollateralToken.address, exp(0, 18));

      await proxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxyAddress);
    });

    it('liquidation factor becomes 0 after upgrade', async () => {
      assetInfo = await comet.getAssetInfoByAddress(quoteCollateralToken.address);
      expect(assetInfo.liquidationFactor).to.eq(0);
    });

    it('quotes with discount if liquidationFactor = 0', async () => {
      quoteAmount = await comet.quoteCollateral(quoteCollateralToken.address, QUOTE_AMOUNT);

      // Expected quote calculation
      const expectedQuoteWithoutDiscount = basePrice.mul(QUOTE_AMOUNT).mul(assetInfo.scale).div(assetPrice).div(baseScale);

      // Verify quote calculation
      expect(quoteAmount).to.eq(expectedQuoteWithoutDiscount);

      await snapshot.restore();
    });

    for (let i = 1; i <= MAX_ASSETS; i++) {
      it(`quotes with discount for asset ${i}`, async () => {
        const asset = tokens[`ASSET${i - 1}`];

        // First quote with discount
        quoteAmount = await comet.quoteCollateral(asset.address, QUOTE_AMOUNT);

        // discount = storeFrontPriceFactor * (1e18 - liquidationFactor)
        assetInfo = await comet.getAssetInfoByAddress(asset.address);
        const discountFactor = mulFactor((await comet.storeFrontPriceFactor()).toBigInt(), BigNumber.from(factorScale).sub(assetInfo.liquidationFactor).toBigInt());
        // assetPriceDiscounted = assetPrice * (1e18 - discount)
        const assetPriceDiscounted = mulFactor(assetPrice.toBigInt(), BigNumber.from(factorScale).sub(discountFactor).toBigInt());
        // expected quote calculation
        const expectedQuoteWithDiscount = basePrice.mul(QUOTE_AMOUNT).mul(assetInfo.scale).div(assetPriceDiscounted).div(baseScale);

        expect(quoteAmount).to.eq(expectedQuoteWithDiscount);

        // Update liquidation factor to 0 to remove discount
        await configurator.updateAssetLiquidationFactor(cometProxyAddress, asset.address, exp(0, 18));
        await proxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxyAddress);

        assetInfo = await comet.getAssetInfoByAddress(asset.address);
        expect(assetInfo.liquidationFactor).to.eq(0);

        // Second quote without discount
        quoteAmount = await comet.quoteCollateral(asset.address, QUOTE_AMOUNT);

        const expectedQuoteWithoutDiscount = basePrice.mul(QUOTE_AMOUNT).mul(assetInfo.scale).div(assetPrice).div(baseScale);

        // Verify quote calculation
        expect(quoteAmount).to.eq(expectedQuoteWithoutDiscount);
      });
    }

    
    describe('edge cases', function () {
      describe('revert on price feed side', function () {
        /*
        * Edge cases around price feeds and quoteCollateral.
        *
        * These tests simulate a governance action that replaces the collateral asset's price feed
        * with a feed that always reverts on `latestRoundData` (PriceFeedWithRevert). This mirrors
        * the "price feed paralysis" scenario exercised in the absorb tests, but focused on
        * `quoteCollateral`:
        *
        * 1. With the normal price feed, quoteCollateral should succeed for the target collateral.
        * 2. After governance updates the asset's price feed to PriceFeedWithRevert, quoteCollateral
        *    should revert with the `Reverted` custom error, since it calls getPrice(asset.priceFeed).
        * 3. When governance restores the original (non-reverting) price feed, quoteCollateral should
        *    succeed again, showing that the paralysis is solely caused by the reverting feed.
        */
        let priceFeedWithRevert: PriceFeedWithRevert;
        let originalPriceFeed: string;
        let targetAsset: FaucetToken | NonStandardFaucetFeeToken;

        before(async () => {
        // Start from the common baseline state for this suite
          await snapshot.restore();

          targetAsset = quoteCollateralToken;

          // Record the current (normal) price feed for the quoted asset
          const assetInfoBefore = await comet.getAssetInfoByAddress(targetAsset.address);
          originalPriceFeed = assetInfoBefore.priceFeed;

          // Deploy a price feed that always reverts on latestRoundData
          const PriceFeedWithRevertFactory = (await ethers.getContractFactory('PriceFeedWithRevert')) as PriceFeedWithRevert__factory;
          priceFeedWithRevert = await PriceFeedWithRevertFactory.deploy(100, 8);
          await priceFeedWithRevert.deployed();
        });

        it('quoteCollateral works with the normal price feed', async () => {
        // Sanity check: initial call should not revert
          const quote = await comet.quoteCollateral(targetAsset.address, QUOTE_AMOUNT);
          expect(quote).to.be.gt(0);
        });

        it('governance updates collateral price feed to a reverting implementation', async () => {
          await configurator.updateAssetPriceFeed(cometProxyAddress, targetAsset.address, priceFeedWithRevert.address);
          await proxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxyAddress);
        });

        it('price feed for quoted asset is now the reverting implementation', async () => {
          const assetInfoAfter = await comet.getAssetInfoByAddress(targetAsset.address);
          expect(assetInfoAfter.priceFeed).to.equal(priceFeedWithRevert.address);
        });

        it('quoteCollateral reverts when collateral price feed reverts', async () => {
          await expect(
            comet.quoteCollateral(targetAsset.address, QUOTE_AMOUNT)
          ).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
        });

        it('governance restores the normal collateral price feed', async () => {
          await configurator.updateAssetPriceFeed(cometProxyAddress, targetAsset.address, originalPriceFeed);
          await proxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxyAddress);
        });

        it('price feed for quoted asset is restored to the normal implementation', async () => {
          const assetInfoAfter = await comet.getAssetInfoByAddress(targetAsset.address);
          expect(assetInfoAfter.priceFeed).to.equal(originalPriceFeed);
        });

        it('quoteCollateral works again after restoring the normal price feed', async () => {
          const quote = await comet.quoteCollateral(targetAsset.address, QUOTE_AMOUNT);
          expect(quote).to.be.gt(0);
        });
      });
    });
  });
});
