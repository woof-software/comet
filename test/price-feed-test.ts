import { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from '../build/types';
import { ethers, expect, makeProtocol } from './helpers';

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

    const price = await comet.getPrice(priceFeeds.COMP.address);

    expect(price.toNumber()).to.equal(123450000);
  });

  it('reverts if given a bad priceFeed address', async () => {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();

    // COMP on mainnet (not a legit price feed address)
    const invalidPriceFeedAddress = '0xc00e94cb662c3520282e6f5717214004a7f26888';

    await expect(comet.getPrice(invalidPriceFeedAddress)).to.be.reverted;
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

    await expect(comet.getPrice(priceFeeds.COMP.address)).to.be.revertedWith("custom error 'BadPrice()'");
  });
});

describe('Minimum valid price', function () {
  const MINIMUM_PRICE = 1n;

  let comet: CometHarnessInterfaceExtendedAssetList;
  let basePriceFeed: SimplePriceFeed;
  let collateralPriceFeed: SimplePriceFeed;
  let basePriceFeedAddress: string;
  let collateralPriceFeedAddress: string;
  let initialSnapshot: string;

  const snapshot = (): Promise<string> => ethers.provider.send('evm_snapshot', []);
  const revert = (id: string): Promise<boolean> => ethers.provider.send('evm_revert', [id]);
  const toBigInt = (value: { toString(): string }): bigint => BigInt(value.toString());

  before(async () => {
    const protocol = await makeProtocol({
      base: 'USDC',
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        TOKEN: { decimals: 18, initialPrice: 85_000 },
      },
    });

    comet = protocol.cometWithExtendedAssetList;
    basePriceFeed = protocol.priceFeeds.USDC as SimplePriceFeed;
    collateralPriceFeed = protocol.priceFeeds.TOKEN as SimplePriceFeed;

    // Feeds are resolved through Comet configuration, the same way the protocol reads them
    basePriceFeedAddress = await comet.baseTokenPriceFeed();
    const collateral = protocol.tokens.TOKEN as FaucetToken;
    collateralPriceFeedAddress = (await comet.getAssetInfoByAddress(collateral.address)).priceFeed;

    initialSnapshot = await snapshot();
  });

  after(async () => {
    await revert(initialSnapshot);
  });

  context('given the feed answer is 1', function () {
    before(async () => {
      await basePriceFeed.setRoundData(0, MINIMUM_PRICE, 0, 0, 0);
      await collateralPriceFeed.setRoundData(0, MINIMUM_PRICE, 0, 0, 0);
    });

    context('when reading the base price feed', function () {
      it('uses the configured base price feed', async () => {
        expect(basePriceFeedAddress).to.equal(basePriceFeed.address);
      });

      it('has a feed answer of 1', async () => {
        expect(toBigInt((await basePriceFeed.latestRoundData())[1])).to.equal(MINIMUM_PRICE);
      });

      it('returns 1', async () => {
        expect(toBigInt(await comet.getPrice(basePriceFeedAddress))).to.equal(MINIMUM_PRICE);
      });

      it('does not revert', async () => {
        await expect(comet.getPrice(basePriceFeedAddress)).to.not.be.reverted;
      });
    });

    context('when reading a collateral price feed', function () {
      it('uses the configured collateral price feed', async () => {
        expect(collateralPriceFeedAddress).to.equal(collateralPriceFeed.address);
      });

      it('has a feed answer of 1', async () => {
        expect(toBigInt((await collateralPriceFeed.latestRoundData())[1])).to.equal(MINIMUM_PRICE);
      });

      it('returns 1', async () => {
        expect(toBigInt(await comet.getPrice(collateralPriceFeedAddress))).to.equal(MINIMUM_PRICE);
      });

      it('does not revert', async () => {
        await expect(comet.getPrice(collateralPriceFeedAddress)).to.not.be.reverted;
      });
    });
  });
});
