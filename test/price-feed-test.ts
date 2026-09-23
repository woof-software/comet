import { ethers, expect, makeProtocol } from './helpers.js';

describe('getPrice', function () {
  it('returns price data for assets, with 8 decimals', async () => {
    const { cometWithExtendedAssetList: comet, priceFeeds } = await makeProtocol({
      assets: {
        USDC: {},
        COMP: {
          initial: 1e7,
          decimals: 18,
          initialPrice: 1.2345,
        },
      },
    });

    const price = await comet.getPrice(await priceFeeds.COMP.getAddress());

    expect(price).to.equal(123450000n);
  });

  it('reverts if given a bad priceFeed address', async () => {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();

    // COMP on mainnet (not a legit price feed address)
    const invalidPriceFeedAddress = '0xc00e94cb662c3520282e6f5717214004a7f26888';

    await expect(comet.getPrice(invalidPriceFeedAddress)).to.revert(ethers);
  });

  it('reverts if price feed returns negative value', async () => {
    const { cometWithExtendedAssetList: comet, priceFeeds } = await makeProtocol({
      assets: {
        USDC: {},
        COMP: {
          initial: 1e7,
          decimals: 18,
          initialPrice: -1,
        },
      },
    });

    await expect(comet.getPrice(await priceFeeds.COMP.getAddress())).to.be.revertedWithCustomError(
      comet,
      'BadPrice'
    );
  });
});
