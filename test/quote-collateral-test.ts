import {
  CometProxyAdmin,
  CometWithExtendedAssetList,
  Configurator,
  ConfiguratorProxy,
  FaucetToken,
  NonStandardFaucetFeeToken,
} from 'build/types';
import {
  expect,
  exp,
  makeProtocol,
  makeConfigurator,
  factorScale,
  mulFactor,
  ethers,
} from './helpers';
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

  describe('without discount', function () {
    let comet: CometWithExtendedAssetList;
    let configurator: Configurator;
    let configuratorProxy: ConfiguratorProxy;
    let proxyAdmin: CometProxyAdmin;
    let cometProxyAddress: string;
    let assetListFactoryAddress: string;

    const QUOTE_AMOUNT = exp(200, 6);

    let quoteWithoutDiscount: BigNumber;
    let quoteCollateralToken: FaucetToken | NonStandardFaucetFeeToken;

    // Quote calculations data
    let assetInfo: AssetInfoStructOutput;
    let assetPrice: BigNumber;
    let basePrice: BigNumber;
    let baseScale: BigNumber;

    before(async () => {
      const configuratorAndProtocol = await makeConfigurator({
        base: 'USDC',
        storeFrontPriceFactor: exp(0.8, 18),
        assets: {
          USDC: { initial: 1e6, decimals: 6, initialPrice: 1 },
          COMP: {
            initial: 1e7,
            decimals: 18,
            initialPrice: 200,
            liquidationFactor: exp(0.6, 18),
          },
        },
      });
      // Note: Always interact with the proxy address, we'll upgrade implementation later
      cometProxyAddress = configuratorAndProtocol.cometProxy.address;
      comet = configuratorAndProtocol.cometWithExtendedAssetList.attach(
        cometProxyAddress
      ) as CometWithExtendedAssetList;
      configurator = configuratorAndProtocol.configurator;
      configuratorProxy = configuratorAndProtocol.configuratorProxy;
      proxyAdmin = configuratorAndProtocol.proxyAdmin;
      const tokens = configuratorAndProtocol.tokens;
      assetListFactoryAddress =
        configuratorAndProtocol.assetListFactory.address;
      quoteCollateralToken = tokens.COMP;

      // Culculation data
      assetInfo = await comet.getAssetInfoByAddress(
        quoteCollateralToken.address
      );
      assetPrice = await comet.getPrice(assetInfo.priceFeed);
      basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      baseScale = await comet.baseScale();
    });

    it('quotes with discount if liquidationFactor > 0', async () => {
      // Ensure liquidationFactor is not zero (discount present)
      expect(assetInfo.liquidationFactor).to.not.eq(0);

      quoteWithoutDiscount = await comet.quoteCollateral(
        quoteCollateralToken.address,
        QUOTE_AMOUNT
      );
    });

    it('computes expected discount and matches contract value', async () => {
      // discount = storeFrontPriceFactor * (1e18 - liquidationFactor)
      const discountFactor = mulFactor(
        await comet.storeFrontPriceFactor(),
        BigNumber.from(factorScale).sub(assetInfo.liquidationFactor)
      );
      // assetPriceDiscounted = assetPrice * (1e18 - discount)
      const assetPriceDiscounted = mulFactor(
        assetPrice,
        BigNumber.from(factorScale).sub(discountFactor)
      );
      // expected quote calculation
      const expectedQuoteWithoutDiscount = basePrice
        .mul(QUOTE_AMOUNT)
        .mul(assetInfo.scale)
        .div(assetPriceDiscounted)
        .div(baseScale);

      expect(quoteWithoutDiscount).to.eq(expectedQuoteWithoutDiscount);
    });

    it('update liquidationFactor to 0 to remove discount', async () => {
      const configuratorAsProxy = configurator.attach(
        configuratorProxy.address
      );
      // Update the proxy's config
      await configuratorAsProxy.updateAssetLiquidationFactor(
        cometProxyAddress,
        quoteCollateralToken.address,
        exp(0, 18)
      );
      // Ensure upgrades use CometWithExtendedAssetList implementation
      // 1) update extension delegate to the AssetList-aware extension
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
      await configuratorAsProxy.setExtensionDelegate(
        cometProxyAddress,
        CometExtAssetList.address
      );

      // 2) switch factory to CometFactoryWithExtendedAssetList
      const CometFactoryWithExtendedAssetList = await (
        await ethers.getContractFactory('CometFactoryWithExtendedAssetList')
      ).deploy();
      await CometFactoryWithExtendedAssetList.deployed();
      await configuratorAsProxy.setFactory(
        cometProxyAddress,
        CometFactoryWithExtendedAssetList.address
      );

      // 3) Upgrade the proxy to the new implementation produced by the extended factory
      await proxyAdmin.deployAndUpgradeTo(
        configuratorProxy.address,
        cometProxyAddress
      );

      // Check liquidationFactor is 0
      assetInfo = await comet.getAssetInfoByAddress(
        quoteCollateralToken.address
      );
      expect(assetInfo.liquidationFactor).to.eq(0);
    });

    it('quotes with discount if liquidationFactor = 0', async () => {
      quoteWithoutDiscount = await comet.quoteCollateral(
        quoteCollateralToken.address,
        QUOTE_AMOUNT
      );

      // Expected quote calculation
      const expectedQuoteWithoutDiscount = basePrice
        .mul(QUOTE_AMOUNT)
        .mul(assetInfo.scale)
        .div(assetPrice)
        .div(baseScale);

      // Verify quote calculation
      expect(quoteWithoutDiscount).to.eq(expectedQuoteWithoutDiscount);
    });
  });
});
