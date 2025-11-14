import { expect } from 'chai';
import { CometContext, scenario } from './context/CometContext';
import { MAX_ASSETS, isValidAssetIndex, usesAssetList } from './utils';
import { Contract } from 'ethers';
import { debug } from '../plugins/deployment_manager/Utils';

/**
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
 *
 * Note: This test only runs on Comet deployments that use the extended asset list feature (CometExtAssetList),
 * as the quoteCollateral behavior with liquidationFactor = 0 is specific to that implementation. The test
 * filters deployments using the usesAssetList() utility function to ensure compatibility.
 */
for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#quoteCollateral > quotes with discount for asset ${i}`,
    {
      filter: async (ctx: CometContext) => await isValidAssetIndex(ctx, i) && await usesAssetList(ctx)
    },
    async ({ comet, configurator, proxyAdmin, actors }, context) => {
      const { admin } = actors;
      const { asset } = await comet.getAssetInfo(i);

      // Get baseScale first to calculate proper QUOTE_AMOUNT
      const baseScale = (await comet.baseScale()).toBigInt();
      // QUOTE_AMOUNT should be in base token units (e.g., 10000 * baseScale for 10000 base tokens)
      const QUOTE_AMOUNT = BigInt(10000) * baseScale;
      
      // Get initial asset info and prices
      let assetInfo = await comet.getAssetInfoByAddress(asset);
      const assetPrice = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const factorScale = (await comet.factorScale()).toBigInt();
      const assetScale = assetInfo.scale.toBigInt();
      const liquidationFactor = assetInfo.liquidationFactor.toBigInt();

      // console.log(`[Asset ${i}] Initial values:`);
      // console.log(`  assetPrice: ${assetPrice}`);
      // console.log(`  basePrice: ${basePrice}`);
      // console.log(`  baseScale: ${baseScale}`);
      // console.log(`  factorScale: ${factorScale}`);
      // console.log(`  assetScale: ${assetScale}`);
      // console.log(`  liquidationFactor: ${liquidationFactor}`);
      // console.log(`  QUOTE_AMOUNT: ${QUOTE_AMOUNT}`);

      // First quote with discount
      const quoteAmount = (await comet.quoteCollateral(asset, QUOTE_AMOUNT)).toBigInt();
      // console.log(`[Asset ${i}] First quote (with discount): ${quoteAmount}`);

      // discount = storeFrontPriceFactor * (factorScale - liquidationFactor)
      const storeFrontPriceFactor = (await comet.storeFrontPriceFactor()).toBigInt();
      // console.log(`[Asset ${i}] storeFrontPriceFactor: ${storeFrontPriceFactor}`);
      
      const discountFactor = storeFrontPriceFactor * (factorScale - liquidationFactor) / factorScale;
      // console.log(`[Asset ${i}] discountFactor: ${discountFactor}`);
      
      // assetPriceDiscounted = assetPrice * (factorScale - discountFactor)
      const assetPriceDiscounted = assetPrice * (factorScale - discountFactor) / factorScale;
      // console.log(`[Asset ${i}] assetPriceDiscounted: ${assetPriceDiscounted}`); 
      
      // expected quote calculation
      const expectedQuoteWithDiscount = (basePrice * QUOTE_AMOUNT * assetScale) / assetPriceDiscounted / baseScale;
      // console.log(`[Asset ${i}] expectedQuoteWithDiscount calculation: (${basePrice} * ${QUOTE_AMOUNT} * ${assetScale}) / ${assetPriceDiscounted} / ${baseScale} = ${expectedQuoteWithDiscount}`);

      expect(quoteAmount).to.equal(expectedQuoteWithDiscount);

      // Update liquidation factor to 0 to remove discount
      // Set up factory for extended asset list support
      const signer = await context.world.deploymentManager.getSigner();
      const cometWithAssetListFactory = new Contract(comet.address,
        [
          'function assetListFactory() view returns (address)'
        ], signer);
      const assetListFactoryAddress = await cometWithAssetListFactory.assetListFactory();
      const CometExtAssetList = await (
        await context.world.deploymentManager.hre.ethers.getContractFactory('CometExtAssetList')
      ).deploy(
        {
          name32: context.world.deploymentManager.hre.ethers.utils.formatBytes32String('Compound Comet'),
          symbol32: context.world.deploymentManager.hre.ethers.utils.formatBytes32String('BASE'),
        },
        assetListFactoryAddress
      );
      await CometExtAssetList.deployed();
      await context.setNextBaseFeeToZero();
      await configurator.connect(admin.signer).setExtensionDelegate(comet.address, CometExtAssetList.address, { gasPrice: 0 });
      const CometFactoryWithExtendedAssetList = await (await context.world.deploymentManager.hre.ethers.getContractFactory('CometFactoryWithExtendedAssetList')).deploy();
      await CometFactoryWithExtendedAssetList.deployed();
      await context.setNextBaseFeeToZero();
      await configurator.connect(admin.signer).setFactory(comet.address, CometFactoryWithExtendedAssetList.address, { gasPrice: 0 });
      
      await context.setNextBaseFeeToZero();
      await configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, asset, 0n, { gasPrice: 0 });
      await context.setNextBaseFeeToZero();
      await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

      assetInfo = await comet.getAssetInfoByAddress(asset);
      expect(assetInfo.liquidationFactor).to.equal(0);

      // Second quote without discount
      const quoteAmountWithoutDiscount = (await comet.quoteCollateral(asset, QUOTE_AMOUNT)).toBigInt();
      // console.log(`[Asset ${i}] Second quote (without discount): ${quoteAmountWithoutDiscount}`);

      // When liquidationFactor = 0, no discount is applied, so use assetPrice directly
      const expectedQuoteWithoutDiscount = (basePrice * QUOTE_AMOUNT * assetInfo.scale.toBigInt()) / assetPrice / baseScale;
      // console.log(`[Asset ${i}] expectedQuoteWithoutDiscount calculation: (${basePrice} * ${QUOTE_AMOUNT} * ${assetInfo.scale.toBigInt()}) / ${assetPrice} / ${baseScale} = ${expectedQuoteWithoutDiscount}`);

      // Log values for debugging
      console.log(`[Asset ${i}] Final comparison:`);
      console.log(`  quoteAmountWithoutDiscount: ${quoteAmountWithoutDiscount}`);
      console.log(`  expectedQuoteWithDiscount: ${expectedQuoteWithDiscount}`);
      console.log(`  expectedQuoteWithoutDiscount: ${expectedQuoteWithoutDiscount}`);
      debug(`[Asset ${i}] Debug mode: quoteAmountWithoutDiscount=${quoteAmountWithoutDiscount}, expectedQuoteWithDiscount=${expectedQuoteWithDiscount}`);

      // Verify quote calculation
      // expect(quoteAmountWithoutDiscount).to.equal(expectedQuoteWithoutDiscount);
      expect(quoteAmountWithoutDiscount).to.equal(expectedQuoteWithoutDiscount);
    }
  );
}

