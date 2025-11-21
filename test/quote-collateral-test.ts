import { CometProxyAdmin, CometWithExtendedAssetList, Configurator, ConfiguratorProxy, FaucetToken, NonStandardFaucetFeeToken } from 'build/types';
import { expect, exp, makeProtocol, makeConfigurator, factorScale, mulFactor, ethers, MAX_ASSETS, SnapshotRestorer, takeSnapshot } from './helpers';
import { BigNumber } from 'ethers';
import { AssetInfoStructOutput } from 'build/types/CometWithExtendedAssetList';

describe('quoteCollateral', function () {
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
      },
    });
    const { comet, tokens } = protocol;
    const { COMP } = tokens;

    const baseAmount = exp(200, 6);
    const q0 = await comet.quoteCollateral(COMP.address, baseAmount);

    // Store front discount is 0.5 * (1 - 0.6) = 0.2 = 20%
    // Discounted COMP price is 200 * 0.8 = 160
    // 200 USDC should give 200 * (1/160) COMP
    const assetPriceDiscounted = exp(160, 8);
    const basePrice = exp(1, 8);
    const assetScale = exp(1, 18);
    const assetWeiPerUnitBase = (assetScale * basePrice) / assetPriceDiscounted;
    const baseScale = exp(1, 6);
    expect(q0).to.be.equal((assetWeiPerUnitBase * baseAmount) / baseScale);
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
      },
    });
    const { comet, tokens } = protocol;
    const { COMP } = tokens;

    const baseAmount = 0n;
    const q0 = await comet.quoteCollateral(COMP.address, baseAmount);

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
      },
    });
    const { comet, tokens } = protocol;
    const { COMP } = tokens;

    const baseAmount = exp(200, 6);
    const q0 = await comet.quoteCollateral(COMP.address, baseAmount);

    // Store front discount is 0 * (1 - 0.6) = 0 = 0%
    // Discounted COMP price is 200 * 1 = 200
    // 200 USDC should give 200 * (1/200) COMP
    const assetPriceDiscounted = exp(200, 8);
    const basePrice = exp(1, 8);
    const assetScale = exp(1, 18);
    const assetWeiPerUnitBase = (assetScale * basePrice) / assetPriceDiscounted;
    const baseScale = exp(1, 6);
    expect(q0).to.be.equal((assetWeiPerUnitBase * baseAmount) / baseScale);
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
      },
    });
    const { comet, tokens } = protocol;
    const { COMP } = tokens;

    const baseAmount = exp(810, 6);
    const q0 = await comet.quoteCollateral(COMP.address, baseAmount);

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
      },
    });
    const { comet, tokens } = protocol;
    const { COMP } = tokens;

    const baseAmount = exp(1e15, 6); // 1 quadrillion USDC
    const q0 = await comet.quoteCollateral(COMP.address, baseAmount);

    // Store front discount is 0.8 * (1 - 0.75) = 0.2 = 20%
    // Discounted COMP price is 200 * 0.8 = 160
    // 1e18 USDC should give 1e15 / (0.8 * 200) = 6.25e12 COMP
    expect(q0).to.be.equal(exp(6.25, 12 + 18));
  });

  /*
   * This test suite was written after the USDM incident, when a token price feed was removed from Chainlink.
   * The incident revealed that when a price feed becomes unavailable, the protocol cannot calculate the USD value
   * of collateral (e.g., during absorption when trying to getPrice() for a delisted asset).
   *
   * The solution was to set the asset's liquidationFactor to 0 for delisted collateral. This affects both:
   * - Absorption: Assets with liquidationFactor = 0 are skipped (cannot calculate their USD value)
   * - quoteCollateral: When liquidationFactor = 0, the store front discount becomes 0, and quoteCollateral
   *   quotes at market price without any discount (see quoteCollateral() in CometWithExtendedAssetList.sol)
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
    let comet: CometWithExtendedAssetList;
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
      const configuratorAndProtocol = await makeConfigurator({
        assets: { USDC: { decimals: 6, initialPrice: 1 }, ...collaterals }, withMockAssetListFactory: true
      });

      cometProxyAddress = configuratorAndProtocol.cometProxy.address;
      comet = configuratorAndProtocol.cometWithExtendedAssetList.attach(cometProxyAddress) as CometWithExtendedAssetList;
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
      const discountFactor = mulFactor(await comet.storeFrontPriceFactor(), BigNumber.from(factorScale).sub(assetInfo.liquidationFactor));
      // assetPriceDiscounted = assetPrice * (1e18 - discount)
      const assetPriceDiscounted = mulFactor(assetPrice, BigNumber.from(factorScale).sub(discountFactor));
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
        const discountFactor = mulFactor(await comet.storeFrontPriceFactor(), BigNumber.from(factorScale).sub(assetInfo.liquidationFactor));
        // assetPriceDiscounted = assetPrice * (1e18 - discount)
        const assetPriceDiscounted = mulFactor(assetPrice, BigNumber.from(factorScale).sub(discountFactor));
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
  });
});
