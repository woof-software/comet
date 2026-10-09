import { CometHarnessInterfaceExtendedAssetList__factory, Configurator__factory, CometExtAssetList__factory, CometFactoryWithExtendedAssetList__factory, FaucetToken__factory, PriceFeedWithRevert__factory } from '../build/types/index.js';
import type { CometHarnessInterfaceExtendedAssetList, CometProxyAdmin, Configurator, FaucetToken, NonStandardFaucetFeeToken, PriceFeedWithRevert, SimplePriceFeed } from '../build/types/index.js';
import { expect, exp, ethers, MAX_ASSETS, mulFactor, factorScale, makeConfigurator, ZERO_ADDRESS, takeSnapshot, makeProtocol } from './helpers.js';
import type { SnapshotRestorer, SignerWithAddress } from './helpers.js';
import { encodeBytes32String } from 'ethers';
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
    await configurator.setStoreFrontPriceFactor(await comet.getAddress(), factor);
    await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
  }
  before(async () => {
    const collaterals = Object.fromEntries(Array.from({ length: MAX_ASSETS }, (_, j) => [
      `ASSET${j}`,
      {
        decimals: j < 8 ? 18 : j < 16 ? 8 : 6,
        initialPrice: j > 1 ? 200 : 200 + (10 * j),
        borrowCF: exp(0.75, 18),
        liquidateCF: exp(0.8, 18),
        liquidationFactor: exp(0.6, 18),
      },
    ]));
    const protocol = await makeConfigurator({
      assets: {
        USDC: { decimals: baseTokenDecimals, initialPrice: 1 },
        ...collaterals,
      },
      storeFrontPriceFactor: exp(0.5, 18),
    });
    const cometProxyAddress = await protocol.cometProxyWithExtendedAssetList.getAddress();
    comet = CometHarnessInterfaceExtendedAssetList__factory.connect(cometProxyAddress, protocol.cometWithExtendedAssetList.runner);
    configurator = protocol.configurator;
    configuratorProxyAddress = await protocol.configuratorProxy.getAddress();
    proxyAdmin = protocol.proxyAdmin;
    [alice] = protocol.users;
    baseSymbol = protocol.base;
    baseToken = protocol.tokens[baseSymbol];
    collateralToken = protocol.tokens['ASSET0'];
    tokens = protocol.tokens;
    priceFeeds = protocol.priceFeeds;
    // Upgrade proxy to extended asset list implementation
    const assetListFactory = protocol.assetListFactory;
    configurator = Configurator__factory.connect(configuratorProxyAddress, configurator.runner);
    const CometExtAssetList = await (new CometExtAssetList__factory((await ethers.getSigners())[0])).deploy({
      name32: encodeBytes32String('Test Comet'),
      symbol32: encodeBytes32String('Test Comet'),
    }, await assetListFactory.getAddress());
    await CometExtAssetList.waitForDeployment();
    await configurator.setExtensionDelegate(cometProxyAddress, await CometExtAssetList.getAddress());
    const CometFactoryWithExtendedAssetList = await (new CometFactoryWithExtendedAssetList__factory((await ethers.getSigners())[0])).deploy();
    await CometFactoryWithExtendedAssetList.waitForDeployment();
    await configurator.setFactory(cometProxyAddress, await CometFactoryWithExtendedAssetList.getAddress());
    // Deploy and upgrade to apply changes
    await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
  });
  // ─────────────────────────────────────────────────────────
  //  1. Discount / storefront math
  // ─────────────────────────────────────────────────────────
  describe('discount / storefront math', function () {
    it('returns 0 for zero baseAmount', async () => {
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), 0);
      expect(quote).to.equal(0);
    });
    it('quotes correctly for a positive baseAmount', async () => {
      // ASSET0: price = $200, liquidationFactor = 0.6, storeFrontPriceFactor = 0.5
      // discountFactor = 0.5 * (1 - 0.6) = 0.2
      // assetPriceDiscounted = 200e8 * (1 - 0.2) = 160e8
      // basePrice = 1e8, baseScale = 1e6, assetScale = 1e18
      // quote = 1e8 * 200e6 * 1e18 / 160e8 / 1e6 = 1.25e18
      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
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
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
      // discountFactor = 0 * (1 - 0.6) = 0
      // assetPriceDiscounted = 200e8 * 1 = 200e8
      // quote = 1e8 * 200e6 * 1e18 / 200e8 / 1e6 = 1e18
      expect(quote).to.equal(exp(1, 18));
    });
    it('20% storeFrontPriceFactor', async () => {
      await updateStoreFrontPriceFactor(exp(0.2, 18));
      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
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
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
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
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
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
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
      // discountFactor = 0.8 * (1 - 0.6) = 0.32
      // assetPriceDiscounted = 200e8 * 0.68 = 136e8
      const discountFactor = mulFactor(exp(0.8, 18), factorScale - exp(0.6, 18));
      const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
      const expected = exp(1, 8) * baseAmount * exp(1, 18) / assetPriceDiscounted / exp(1, 6);
      expect(quote).to.equal(expected);
    });
    it('liquidation CF = 0.01% (near-zero like deUSD on USDT market)', async () => {
      const snapshot = await takeSnapshot();
      // liquidationFactor = 0.0001 → discount is nearly the full storeFrontPriceFactor
      // discountFactor = 0.8 * (1 - 0.0001) ≈ 0.79992
      // assetPriceDiscounted = 200e8 * (1 - 0.79992) ≈ 40.016e8
      await configurator.updateAssetLiquidationFactor(await comet.getAddress(), await collateralToken.getAddress(), exp(0.0001, 18));
      await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
      const discountFactor = mulFactor(exp(0.8, 18), factorScale - exp(0.0001, 18));
      const assetPriceDiscounted = mulFactor(exp(200, 8), factorScale - discountFactor);
      const expected = exp(1, 8) * baseAmount * exp(1, 18) / assetPriceDiscounted / exp(1, 6);
      expect(quote).to.equal(expected);
      // With essentially ~50% discount, quote should be roughly 2x the no-discount amount
      expect(quote).to.be.gt(exp(1.99, 18));
      // Restore liquidation factor for collateral for other tests
      await snapshot.restore();
    });
    it('100% storeFrontPriceFactor with normal liquidationFactor', async () => {
      await updateStoreFrontPriceFactor(exp(1, 18));
      const baseAmount = exp(200, baseTokenDecimals);
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
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
    it('division-by-zero panic: storeFrontPriceFactor = 1e18, liquidationFactor = 0', async () => {
      const snapshot = await takeSnapshot();
      // discountFactor = 1e18 * (1 - 0) = 1e18 = FACTOR_SCALE
      // assetPriceDiscounted = assetPrice * (FACTOR_SCALE - FACTOR_SCALE) / FACTOR_SCALE = 0
      // Final division by assetPriceDiscounted = 0 → EVM panics (0x12)
      await updateStoreFrontPriceFactor(exp(1, 18));
      await configurator.updateAssetLiquidationFactor(await comet.getAddress(), await collateralToken.getAddress(), 0);
      await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
      const baseAmount = exp(200, baseTokenDecimals);
      // Solidity division-by-zero causes panic code 0x12
      await expect(comet.quoteCollateral(await collateralToken.getAddress(), baseAmount)).to.be.revertedWithPanic('0x12');
      await snapshot.restore();
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
      const quote = await comet.quoteCollateral(await asset8.getAddress(), 1);
      expect(quote).to.equal(0);
    });
    it('does not overflow for large baseAmount', async () => {
      const baseAmount = exp(1, 15 + baseTokenDecimals); // 1 quadrillion USDC
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
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
      const quote = await comet.quoteCollateral(await asset.getAddress(), baseAmount);
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
      const quote = await comet.quoteCollateral(await asset.getAddress(), baseAmount);
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
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
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
      await configurator.updateAssetLiquidationFactor(await comet.getAddress(), await collateralToken.getAddress(), exp(0.8, 18));
      await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
      const baseAmount = exp(810, baseTokenDecimals);
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
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
        const assetPrice = (await comet.getPrice(assetInfo.priceFeed));
        const assetScale = assetInfo.scale;
        const liquidationFactor = assetInfo.liquidationFactor;
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
        const unsupported = await (new FaucetToken__factory((await ethers.getSigners())[0])).deploy(1e6, 'Unsupported', 18, 'UNSUP');
        await unsupported.waitForDeployment();
        await expect(comet.quoteCollateral(await unsupported.getAddress(), exp(100, baseTokenDecimals))).to.be.revertedWithCustomError(comet, 'BadAsset');
      });
      it('reverts when asset is the base token', async () => {
        await expect(comet.quoteCollateral(await baseToken.getAddress(), exp(100, baseTokenDecimals))).to.be.revertedWithCustomError(comet, 'BadAsset');
      });
      it('reverts for zero address', async () => {
        await expect(comet.quoteCollateral(ZERO_ADDRESS, exp(100, baseTokenDecimals))).to.be.revertedWithCustomError(comet, 'BadAsset');
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
        await configurator.updateAssetPriceFeed(await comet.getAddress(), await collateralToken.getAddress(), await priceFeeds['ASSET0'].getAddress());
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
        await expect(comet.quoteCollateral(await collateralToken.getAddress(), exp(100, baseTokenDecimals))).to.be.revertedWithCustomError(comet, 'BadPrice');
      });
      it('reverts when collateral price feed returns negative price', async () => {
        await priceFeeds['ASSET0'].setRoundData(1, -1 * 10 ** 8, 0, 0, 1);
        await configurator.updateAssetPriceFeed(await comet.getAddress(), await collateralToken.getAddress(), await priceFeeds['ASSET0'].getAddress());
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
        await expect(comet.quoteCollateral(await collateralToken.getAddress(), exp(100, baseTokenDecimals))).to.be.revertedWithCustomError(comet, 'BadPrice');
      });
      it('reverts when base token price feed returns 0', async () => {
        await priceFeeds['USDC'].setRoundData(1, 0, 0, 0, 1);
        await configurator.setBaseTokenPriceFeed(await comet.getAddress(), await priceFeeds['USDC'].getAddress());
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
        await expect(comet.quoteCollateral(await collateralToken.getAddress(), exp(100, baseTokenDecimals))).to.be.revertedWithCustomError(comet, 'BadPrice');
      });
      it('reverts when base token price feed returns negative price', async () => {
        await priceFeeds['USDC'].setRoundData(1, -1 * 10 ** 8, 0, 0, 1);
        await configurator.setBaseTokenPriceFeed(await comet.getAddress(), await priceFeeds['USDC'].getAddress());
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
        await expect(comet.quoteCollateral(await collateralToken.getAddress(), exp(100, baseTokenDecimals))).to.be.revertedWithCustomError(comet, 'BadPrice');
      });
      it('reverts when collateral price feed is broken (reverts)', async () => {
        const factory = new PriceFeedWithRevert__factory((await ethers.getSigners())[0]);
        const brokenPriceFeed = await factory.deploy(exp(1, 8), 8) as PriceFeedWithRevert;
        await brokenPriceFeed.waitForDeployment();
        await configurator.updateAssetPriceFeed(await comet.getAddress(), await collateralToken.getAddress(), await brokenPriceFeed.getAddress());
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
        await expect(comet.quoteCollateral(await collateralToken.getAddress(), exp(100, baseTokenDecimals))).to.be.revertedWithCustomError(brokenPriceFeed, 'Reverted');
      });
      it('reverts when base token price feed is broken (reverts)', async () => {
        const factory = new PriceFeedWithRevert__factory((await ethers.getSigners())[0]);
        const brokenPriceFeed = await factory.deploy(exp(1, 8), 8) as PriceFeedWithRevert;
        await brokenPriceFeed.waitForDeployment();
        await configurator.setBaseTokenPriceFeed(await comet.getAddress(), await brokenPriceFeed.getAddress());
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
        await expect(comet.quoteCollateral(await collateralToken.getAddress(), exp(100, baseTokenDecimals))).to.be.revertedWithCustomError(brokenPriceFeed, 'Reverted');
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
      await configurator.setStoreFrontPriceFactor(await comet.getAddress(), exp(0.5, 18));
      await configurator.updateAssetLiquidationFactor(await comet.getAddress(), await collateralToken.getAddress(), exp(0.6, 18));
      await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
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
      const quoteBefore = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
      // Price drops $200 → $100
      await priceFeeds['ASSET0'].setRoundData(1, exp(100, 8), 0, 0, 1);
      // Quote at $100 — buyer gets more collateral (cheaper asset)
      const quoteAfter = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
      expect(quoteAfter).to.be.gt(quoteBefore);
      // At half the price, buyer should get exactly double
      expect(quoteAfter).to.equal(quoteBefore * 2n);
    });
    it('quote changes when base token price moves between two calls', async () => {
      const baseAmount = exp(200, baseTokenDecimals);
      // Quote at USDC = $1
      const quoteBefore = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
      // USDC price doubles: $1 → $2
      await priceFeeds['USDC'].setRoundData(1, exp(2, 8), 0, 0, 1);
      // Quote at USDC = $2 — each USDC is worth more, so buyer gets more collateral
      const quoteAfter = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
      expect(quoteAfter).to.be.gt(quoteBefore);
      expect(quoteAfter).to.equal(quoteBefore * 2n);
    });
    it('buyCollateral reverts with stale minAmount after price increase', async () => {
      // Setup reserves
      await configurator.setTargetReserves(await comet.getAddress(), exp(1, 18));
      await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
      await collateralToken.allocateTo(await comet.getAddress(), exp(50, collateralTokenDecimals));
      const baseAmount = exp(200, baseTokenDecimals);
      await baseToken.allocateTo(alice.address, baseAmount);
      // Quote at current price ($200)
      const staleQuote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
      // Collateral price rises $200 → $400, making the new quote smaller
      await priceFeeds['ASSET0'].setRoundData(1, exp(400, 8), 0, 0, 1);
      const freshQuote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
      expect(freshQuote).to.be.lt(staleQuote);
      // Buyer uses stale (larger) minAmount — should revert with TooMuchSlippage
      await baseToken.connect(alice).approve(await comet.getAddress(), baseAmount);
      await expect(comet.connect(alice).buyCollateral(await collateralToken.getAddress(), staleQuote, // stale, higher than what the contract will compute now
        baseAmount, alice.address)).to.be.revertedWithCustomError(comet, 'TooMuchSlippage');
    });
    it('same-block: price feed update and query see new price after mine', async () => {
      const baseAmount = exp(200, baseTokenDecimals);
      // Quote before price change
      const quoteBefore = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
      // Disable automine so we can batch the price update into one block
      await ethers.provider.send('evm_setAutomine', [false]);
      await priceFeeds['ASSET0'].setRoundData(1, exp(100, 8), 0, 0, 1);
      // Mine the block containing the price update
      await ethers.provider.send('evm_mine', []);
      await ethers.provider.send('evm_setAutomine', [true]);
      // Post-mine: quote should reflect the new $100 price
      const quoteAfter = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
      // At half the price, buyer should get exactly double
      expect(quoteAfter).to.equal(quoteBefore * 2n);
    });
  });
  // ─────────────────────────────────────────────────────────
  //  6. Different base token price (base != $1)
  // ─────────────────────────────────────────────────────────
  describe('different base token price (base != $1)', function () {
    let snapshot: SnapshotRestorer;
    before(async () => {
      // Reset to known state: storeFrontPriceFactor=0.5, ASSET0=$200, liquidationFactor=0.6, USDC=$1
      await configurator.setStoreFrontPriceFactor(await comet.getAddress(), exp(0.5, 18));
      await configurator.updateAssetLiquidationFactor(await comet.getAddress(), await collateralToken.getAddress(), exp(0.6, 18));
      await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, await comet.getAddress());
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
      const quoteAt1 = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
      // Set USDC price to $3 (simulating a non-unit-price base, e.g. WETH-based market)
      await priceFeeds['USDC'].setRoundData(1, exp(3, 8), 0, 0, 1);
      const quoteAt3 = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
      // basePrice is a multiplicative factor, so 3x price → 3x quote
      expect(quoteAt3).to.equal(quoteAt1 * 3n);
    });
    it('correct quote with WBTC-like base price ($60,000)', async () => {
      // Simulate a WBTC-based market: base token at $60,000
      await priceFeeds['USDC'].setRoundData(1, exp(60000, 8), 0, 0, 1);
      const baseAmount = exp(1, baseTokenDecimals); // 1 unit of base
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
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
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), baseAmount);
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
      await priceFeeds['ASSET0'].setRoundData(1, exp(1000000, 8), 0, 0, 1);
      // assetPriceDiscounted = 1_000_000e8 * 0.8 = 800_000e8
      // quote = 1 * 1 * 1e18 / 800_000e8 / 1e6 = 1e18 / 8e19 = 0 (truncated)
      const quote = await comet.quoteCollateral(await collateralToken.getAddress(), 1);
      expect(quote).to.equal(0);
    });
  });
});

describe('quoteCollateral exact-accounting regressions', function () {
  it('quotes the collateral correctly for a positive base amount', async () => {
    const protocol = await makeProtocol({
      base: 'USDC',
      storeFrontPriceFactor: exp(0.5, 18),
      targetReserves: 100,
      assets: {
        USDC: {
          initial: 1e6,
          decimals: 6,
          initialPrice: 1,
        },
        COMP: {
          initial: 1e7,
          decimals: 18,
          initialPrice: 200,
          liquidationFactor: exp(0.6, 18),
        },
      }
    });
    const { cometWithExtendedAssetList: comet, tokens } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    const baseAmount = exp(200, 6);
    const q0 = await comet.quoteCollateral(compAddress, baseAmount);

    // Store front discount is 0.5 * (1 - 0.6) = 0.2 = 20%
    // Discounted COMP price is 200 * 0.8 = 160
    // 200 USDC should give 200 * (1/160) COMP
    const assetPriceDiscounted = exp(160, 8);
    const basePrice = exp(1, 8);
    const assetScale = exp(1, 18);
    const assetWeiPerUnitBase = assetScale * basePrice / assetPriceDiscounted;
    const baseScale = exp(1, 6);
    expect(q0).to.be.equal(assetWeiPerUnitBase * baseAmount / baseScale);
    expect(q0).to.be.equal(exp(1.25, 18));
  });

  it('quotes the collateral correctly for a zero base amount', async () => {
    const protocol = await makeProtocol({
      base: 'USDC',
      targetReserves: 100,
      assets: {
        USDC: {
          initial: 1e6,
          decimals: 6,
          initialPrice: 1,
        },
        COMP: {
          initial: 1e7,
          decimals: 18,
          initialPrice: 200,
        },
      }
    });
    const { cometWithExtendedAssetList: comet, tokens } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    const baseAmount = 0n;
    const q0 = await comet.quoteCollateral(compAddress, baseAmount);

    expect(q0).to.be.equal(0n);
  });

  it('quotes the collateral at market price when storeFrontPriceFactor is 0%', async () => {
    const protocol = await makeProtocol({
      base: 'USDC',
      storeFrontPriceFactor: exp(0, 18),
      targetReserves: 100,
      assets: {
        USDC: {
          initial: 1e6,
          decimals: 6,
          initialPrice: 1,
        },
        COMP: {
          initial: 1e7,
          decimals: 18,
          initialPrice: 200,
          liquidationFactor: exp(0.6, 18),
        },
      }
    });
    const { cometWithExtendedAssetList: comet, tokens } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    const baseAmount = exp(200, 6);
    const q0 = await comet.quoteCollateral(compAddress, baseAmount);

    // Store front discount is 0 * (1 - 0.6) = 0 = 0%
    // Discounted COMP price is 200 * 1 = 200
    // 200 USDC should give 200 * (1/200) COMP
    const assetPriceDiscounted = exp(200, 8);
    const basePrice = exp(1, 8);
    const assetScale = exp(1, 18);
    const assetWeiPerUnitBase = assetScale * basePrice / assetPriceDiscounted;
    const baseScale = exp(1, 6);
    expect(q0).to.be.equal(assetWeiPerUnitBase * baseAmount / baseScale);
    expect(q0).to.be.equal(exp(1, 18));
  });

  // Should fail before PR 303
  it('properly calculates price without truncating integer during intermediate calculations', async () => {
    const protocol = await makeProtocol({
      base: 'USDC',
      storeFrontPriceFactor: exp(0.5, 18),
      targetReserves: 100,
      assets: {
        USDC: {
          initial: 1e6,
          decimals: 6,
          initialPrice: 1,
        },
        COMP: {
          initial: 1e7,
          decimals: 18,
          initialPrice: 9,
          liquidationFactor: exp(0.8, 18),
        },
      }
    });
    const { cometWithExtendedAssetList: comet, tokens } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    const baseAmount = exp(810, 6);
    const q0 = await comet.quoteCollateral(compAddress, baseAmount);

    // Store front discount is 0.5 * (1 - 0.8) = 0.1 = 10%
    // Discounted COMP price is 9 * 0.9 = 8.1
    // 810 USDC should give 810 / (0.9 * 9) = 100 COMP
    expect(q0).to.be.equal(exp(100, 18));
  });

  it('does not overflow for large amounts', async () => {
    const protocol = await makeProtocol({
      base: 'USDC',
      storeFrontPriceFactor: exp(0.8, 18),
      targetReserves: 100,
      assets: {
        USDC: {
          initial: 1e6,
          decimals: 6,
          initialPrice: 1,
        },
        COMP: {
          initial: 1e7,
          decimals: 18,
          initialPrice: 200,
          liquidationFactor: exp(0.75, 18),
        },
      }
    });
    const { cometWithExtendedAssetList: comet, tokens } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    const baseAmount = exp(1e15, 6); // 1 quadrillion USDC
    const q0 = await comet.quoteCollateral(compAddress, baseAmount);

    // Store front discount is 0.8 * (1 - 0.75) = 0.2 = 20%
    // Discounted COMP price is 200 * 0.8 = 160
    // 1e18 USDC should give 1e15 / (0.8 * 200) = 6.25e12 COMP
    expect(q0).to.be.equal(exp(6.25, 12 + 18));
  });
});
