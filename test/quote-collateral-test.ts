import { CometHarnessInterfaceExtendedAssetList, CometProxyAdmin, Configurator, FaucetToken, NonStandardFaucetFeeToken, PriceFeedWithRevert, SimplePriceFeed } from 'build/types';
import { expect, exp, ethers, MAX_ASSETS, mulFactor, factorScale, makeConfigurator, wait, ZERO_ADDRESS, SnapshotRestorer, takeSnapshot } from './helpers';
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
  let bob: SignerWithAddress;

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
    const cometProxyAddress = protocol.cometProxy.address;
    comet = protocol.cometWithExtendedAssetList.attach(cometProxyAddress);
    configurator = protocol.configurator;
    configuratorProxyAddress = protocol.configuratorProxy.address;
    proxyAdmin = protocol.proxyAdmin;
    [alice, bob] = protocol.users;
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

    it('liquidation CF = 0.01% (near-zero like deUSD on USDT market)', async () => {
      const snapshot = await takeSnapshot();
      // liquidationFactor = 0.0001 → discount is nearly the full storeFrontPriceFactor
      // discountFactor = 0.8 * (1 - 0.0001) ≈ 0.79992
      // assetPriceDiscounted = 200e8 * (1 - 0.79992) ≈ 40.016e8
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
      // Restore liquidation factor for collateral for other tests
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
  //  4. Integration with buyCollateral
  // ─────────────────────────────────────────────────────────
  describe('integration with buyCollateral', function () {
    const baseAmount = exp(200, baseTokenDecimals);
    before(async () => {
      await configurator.setStoreFrontPriceFactor(comet.address, exp(0.8, 18));
      await configurator.setTargetReserves(comet.address, exp(1, 18));
      await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);

      // Supply collateral to comet so it has reserves available to sell
      const collateralReserveAmount = exp(50, collateralTokenDecimals);
      await collateralToken.allocateTo(comet.address, collateralReserveAmount); 
    
      // Set a known price for collateral
      await priceFeeds['ASSET0'].setRoundData(1, exp(200, 8), 0, 0, 1);
      await baseToken.allocateTo(alice.address, baseAmount * 2n);
    });

    it('buyCollateral transfers collateralAmount consistent with quoteCollateral', async () => {
      // Compute expected collateral amount via quoteCollateral
      const expectedCollateral = await comet.quoteCollateral(collateralToken.address, baseAmount);
      // Record balances before
      const aliceCollateralBefore = await collateralToken.balanceOf(alice.address);
      const aliceBaseBefore = await baseToken.balanceOf(alice.address);

      // Approve and buy
      await baseToken.connect(alice).approve(comet.address, baseAmount);
      await wait(
        comet.connect(alice).buyCollateral(collateralToken.address, 0, baseAmount, alice.address)
      );

      // Verify that alice received exactly the amount quoted
      const aliceCollateralAfter = await collateralToken.balanceOf(alice.address);
      const aliceBaseAfter = await baseToken.balanceOf(alice.address);

      expect(aliceCollateralAfter.sub(aliceCollateralBefore).toBigInt()).to.equal(expectedCollateral);
      expect(aliceBaseBefore.sub(aliceBaseAfter).toBigInt()).to.equal(baseAmount);
    });

    it('buyCollateral emits correct BuyCollateral event matching quoteCollateral', async () => {
      const expectedCollateral = await comet.quoteCollateral(collateralToken.address, baseAmount);

      await baseToken.connect(alice).approve(comet.address, baseAmount);
      await expect(
        comet.connect(alice).buyCollateral(collateralToken.address, 0, baseAmount, alice.address)
      ).to.emit(comet, 'BuyCollateral')
        .withArgs(alice.address, collateralToken.address, baseAmount, expectedCollateral);
    });

    describe('liquidation circle: supply → borrow → price drop → absorb → quote → buyCollateral', function () {
      const SUPPLY_BASE = exp(1000, baseTokenDecimals);
      const SUPPLY_COLLATERAL = exp(10, collateralTokenDecimals); // 10 ASSET0 @ $200 = $2000
      // borrowCF = 0.75, so max borrow = 10 * 200 * 0.75 = $1500; borrow $1000
      const BORROW_AMOUNT = exp(1000, baseTokenDecimals);

      it('create new supply position', async () => {
        // 1. Alice supplies base so there is liquidity to borrow
        await baseToken.allocateTo(alice.address, SUPPLY_BASE);
        await baseToken.connect(alice).approve(comet.address, SUPPLY_BASE);
        await comet.connect(alice).supply(baseToken.address, SUPPLY_BASE);

        expect(await comet.balanceOf(alice.address)).to.equal(SUPPLY_BASE);
      });

      it('create new borrow position', async () => {
        // 2. Bob supplies collateral and borrows base
        await collateralToken.allocateTo(bob.address, SUPPLY_COLLATERAL);
        await collateralToken.connect(bob).approve(comet.address, SUPPLY_COLLATERAL);
        await comet.connect(bob).supply(collateralToken.address, SUPPLY_COLLATERAL);
        await comet.connect(bob).withdraw(baseToken.address, BORROW_AMOUNT);

        expect((await comet.userBasic(bob.address)).principal).to.be.lt(0);
        expect(await comet.isLiquidatable(bob.address)).to.be.false;
      });

      it('make borrow position liquidatable', async () => {
        // 3. Collateral price drops drastically: $200 → $50
        // liquidateCF = 0.8, weighted collateral = 10 * 50 * 0.8 = $400 < $1000 debt → liquidatable
        await priceFeeds['ASSET0'].setRoundData(1, exp(50, 8), 0, 0, 1);
        expect(await comet.isLiquidatable(bob.address)).to.be.true;
      });

      it('liquidate borrow position', async () => {
        // 4. Absorb bob — his collateral moves to protocol reserves
        const collateralReservesBefore = await comet.getCollateralReserves(collateralToken.address);
        const absorber = (await ethers.getSigners())[5];
        await comet.connect(absorber).absorb(absorber.address, [bob.address]);

        // Bob's principal is zeroed out, collateral seized
        expect((await comet.userBasic(bob.address)).principal).to.equal(0);
        expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.equal(0);

        // Collateral reserves increased by bob's collateral
        const collateralReservesAfter = await comet.getCollateralReserves(collateralToken.address);
        expect(collateralReservesAfter.sub(collateralReservesBefore)).to.equal(SUPPLY_COLLATERAL);
      });

      it('quote of absorbed collateral remains accurate for buyCollateral', async () => {
        // 5. Quote the absorbed collateral — should work at new $50 price
        const buyBaseAmount = exp(100, baseTokenDecimals);
        const expectedCollateral = await comet.quoteCollateral(collateralToken.address, buyBaseAmount);
        expect(expectedCollateral).to.be.gt(0);

        // Hand-verify the quote at $50 collateral price
        // discountFactor = 0.8 * (1 - 0.6) = 0.2
        // assetPriceDiscounted = 50e8 * 0.8 = 40e8
        // quote = 1e8 * 100e6 * 1e18 / 40e8 / 1e6 = 2.5e18
        const discountFactor = mulFactor(exp(0.8, 18), factorScale - exp(0.8, 18));
        const assetPriceDiscounted = mulFactor(exp(50, 8), factorScale - discountFactor);
        const expectedManual = exp(1, 8) * buyBaseAmount * exp(1, 18) / assetPriceDiscounted / exp(1, 6);
        expect(expectedCollateral).to.equal(expectedManual);

        // 6. Buy the collateral from reserves
        await baseToken.allocateTo(alice.address, buyBaseAmount);
        await baseToken.connect(alice).approve(comet.address, buyBaseAmount);

        const aliceCollateralBefore = await collateralToken.balanceOf(alice.address);
        await expect(
          comet.connect(alice).buyCollateral(collateralToken.address, 0, buyBaseAmount, alice.address)
        ).to.emit(comet, 'BuyCollateral')
          .withArgs(alice.address, collateralToken.address, buyBaseAmount, expectedCollateral);

        const aliceCollateralAfter = await collateralToken.balanceOf(alice.address);
        expect(aliceCollateralAfter.sub(aliceCollateralBefore).toBigInt()).to.equal(expectedCollateral);
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  //  5. Reverts
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

    describe('integration with buyCollateral', function () {
      it('buyCollateral reverts with TooMuchSlippage when minAmount exceeds quote', async () => {
        await configurator.setTargetReserves(comet.address, exp(1, 18));
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);

        const collateralReserveAmount = exp(10, collateralTokenDecimals);
        await collateralToken.allocateTo(comet.address, collateralReserveAmount);

        const baseAmount = exp(200, baseTokenDecimals);
        await baseToken.allocateTo(alice.address, baseAmount);

        const expectedCollateral = await comet.quoteCollateral(collateralToken.address, baseAmount);

        await baseToken.connect(alice).approve(comet.address, baseAmount);
        // Set minAmount to be 1 more than the quote
        await expect(
          comet.connect(alice).buyCollateral(
            collateralToken.address,
            expectedCollateral.toBigInt() + 1n,
            baseAmount,
            alice.address
          )
        ).to.be.revertedWithCustomError(comet, 'TooMuchSlippage');
      });
    });
  });
});
