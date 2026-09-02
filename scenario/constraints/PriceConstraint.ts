import { Constraint } from '../../plugins/scenario';
import { CometContext } from '../context/CometContext';
import { expect } from 'chai';
import { Requirements } from './Requirements';
import { getAssetFromName } from '../utils';

export class PriceConstraint<T extends CometContext, R extends Requirements> implements Constraint<T, R> {
  async solve(requirements: R, _initialContext: T) {
    return async function (ctx: T): Promise<T> {
      const prices = requirements.prices;
      if (prices !== undefined) {
        const assetPriceMap: Record<string, bigint> = {};
        for (const [assetAlias, price] of Object.entries(prices)) {
          const cometAsset = await getAssetFromName(assetAlias, ctx);
          // `prices` are dollar figures; scale to the feed's 8 decimals. Round first — many prices
          // land just off an integer in floats (e.g. 0.14035087 * 1e8 = 14035086.999999998).
          assetPriceMap[cometAsset.address] = BigInt(Math.round(Number(price) * 1e8));
        }
        await ctx.changePriceFeeds(assetPriceMap);
      }
      return ctx;
    };
  }

  async check(requirements: R, context: T) {
    const prices = requirements.prices;
    if (prices !== undefined) {
      const comet = await context.getComet();
      const baseToken = await comet.baseToken();

      for (const [assetAlias, price] of Object.entries(prices)) {
        const cometAsset = await getAssetFromName(assetAlias, context);
        if (cometAsset.address === baseToken) {
          const baseTokenPriceFeed = await comet.baseTokenPriceFeed();
          const cometPrice = await comet.getPrice(baseTokenPriceFeed);
          expect(cometPrice).to.eq(price * 1e8);
        } else {
          const assetInfo = await comet.getAssetInfoByAddress(cometAsset.address);
          const cometPrice = await comet.getPrice(assetInfo.priceFeed);
          expect(cometPrice).to.eq(price * 1e8);
        }
      }
    }
  }
}