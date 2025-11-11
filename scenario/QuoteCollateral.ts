import { scenario } from './context/CometContext';
import { exp, expect, factorScale, mulFactor } from '../test/helpers';
import { MAX_ASSETS, isValidAssetIndex } from './utils';
import { BigNumber } from 'ethers';

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#quoteCollateral > quotes with discount for asset ${i}`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i),
    },
    async ({ comet, configurator, proxyAdmin, actors }, context) => {
      const { admin } = actors;
      const { asset } = await comet.getAssetInfo(i);
      const QUOTE_AMOUNT = exp(200, 6);

      // Get initial asset info and prices
      let assetInfo = await comet.getAssetInfoByAddress(asset);
      const assetPrice = await comet.getPrice(assetInfo.priceFeed);
      const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      const baseScale = await comet.baseScale();

      // First quote with discount
      let quoteAmount = await comet.quoteCollateral(asset, QUOTE_AMOUNT);

      // discount = storeFrontPriceFactor * (1e18 - liquidationFactor)
      const storeFrontPriceFactor = await comet.storeFrontPriceFactor();
      const discountFactor = mulFactor(storeFrontPriceFactor, BigNumber.from(factorScale).sub(assetInfo.liquidationFactor));
      // assetPriceDiscounted = assetPrice * (1e18 - discount)
      const assetPriceDiscounted = mulFactor(assetPrice, BigNumber.from(factorScale).sub(discountFactor));
      // expected quote calculation
      const expectedQuoteWithDiscount = basePrice.mul(QUOTE_AMOUNT).mul(assetInfo.scale).div(assetPriceDiscounted).div(baseScale);

      expect(quoteAmount).to.eq(expectedQuoteWithDiscount);

      // Update liquidation factor to 0 to remove discount
      await context.setNextBaseFeeToZero();
      await configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, asset, exp(0, 18), { gasPrice: 0 });
      await context.setNextBaseFeeToZero();
      await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

      assetInfo = await comet.getAssetInfoByAddress(asset);
      expect(assetInfo.liquidationFactor).to.eq(0);

      // Second quote without discount
      quoteAmount = await comet.quoteCollateral(asset, QUOTE_AMOUNT);

      const expectedQuoteWithoutDiscount = basePrice.mul(QUOTE_AMOUNT).mul(assetInfo.scale).div(assetPrice).div(baseScale);

      // Verify quote calculation
      expect(quoteAmount).to.eq(expectedQuoteWithoutDiscount);
    }
  );
}

