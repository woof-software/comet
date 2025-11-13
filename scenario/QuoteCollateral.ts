import { expect } from 'chai';
import { scenario } from './context/CometContext';
import { MAX_ASSETS, isValidAssetIndex, usesAssetList } from './utils';

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
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await usesAssetList(ctx),
    },
    async ({ comet, configurator, proxyAdmin, actors }, context) => {
      const { admin } = actors;
      const { asset } = await comet.getAssetInfo(i);
      const QUOTE_AMOUNT = 200n;

      // Get initial asset info and prices
      let assetInfo = await comet.getAssetInfoByAddress(asset);
      const assetPrice = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const baseScale = (await comet.baseScale()).toBigInt();
      const factorScale = (await comet.factorScale()).toBigInt();
      const assetScale = assetInfo.scale.toBigInt();
      const liquidationFactor = assetInfo.liquidationFactor.toBigInt();

      // First quote with discount
      let quoteAmount = (await comet.quoteCollateral(asset, QUOTE_AMOUNT)).toBigInt();

      // Helper function: mulFactor(n, factor) = n * factor / FACTOR_SCALE
      const mulFactor = (n: bigint, factor: bigint): bigint => {
        return (n * factor) / factorScale;
      };

      // discount = storeFrontPriceFactor * (factorScale - liquidationFactor)
      const storeFrontPriceFactor = (await comet.storeFrontPriceFactor()).toBigInt();
      const discountFactor = mulFactor(storeFrontPriceFactor, factorScale - liquidationFactor);
      
      // assetPriceDiscounted = assetPrice * (factorScale - discountFactor)
      const assetPriceDiscounted = mulFactor(assetPrice, factorScale - discountFactor);
      
      // expected quote calculation
      // = (basePrice * QUOTE_AMOUNT * assetScale) / (assetPriceDiscounted * baseScale)
      const expectedQuoteWithDiscount = (basePrice * QUOTE_AMOUNT * assetScale) / (assetPriceDiscounted * baseScale);

      expect(quoteAmount).to.equal(expectedQuoteWithDiscount);

      // Update liquidation factor to 0 to remove discount
      await context.setNextBaseFeeToZero();
      await configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, asset, 0n, { gasPrice: 0 });
      await context.setNextBaseFeeToZero();
      await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

      assetInfo = await comet.getAssetInfoByAddress(asset);
      expect(assetInfo.liquidationFactor).to.equal(0);

      // Second quote without discount
      quoteAmount = (await comet.quoteCollateral(asset, QUOTE_AMOUNT)).toBigInt();

      // When liquidationFactor = 0, no discount is applied, so use assetPrice directly
      // = (basePrice * QUOTE_AMOUNT * assetScale) / (assetPrice * baseScale)
      const expectedQuoteWithoutDiscount = (basePrice * QUOTE_AMOUNT * assetScale) / (assetPrice * baseScale);

      // Verify quote calculation
      expect(quoteAmount).to.equal(expectedQuoteWithoutDiscount);
    }
  );
}

