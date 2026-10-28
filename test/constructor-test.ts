import { ethers, exp, expect, makeProtocol } from './helpers';
import {
  AssetList__factory,
  AssetListFactory__factory,
  FaucetToken__factory,
  SimplePriceFeed__factory,
} from '../build/types';

describe('constructor', function () {
  it('sets the baseBorrowMin', async function () {
    const { cometWithExtendedAssetList: comet } = await makeProtocol({
      baseBorrowMin: exp(100, 6)
    });
    expect(await comet.baseBorrowMin()).to.eq(exp(100, 6));
  });

  it('verifies asset scales', async function () {
    const AssetListFactory = (await ethers.getContractFactory('AssetListFactory')) as AssetListFactory__factory;
    const assetListFactory = await AssetListFactory.deploy();
    await assetListFactory.deployed();

    const FaucetFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
    const token = await FaucetFactory.deploy(1e6, 'EVIL', 18, 'EVIL');
    await token.deployed();

    const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
    const priceFeed = await PriceFeedFactory.deploy(exp(1, 8), 8);
    await priceFeed.deployed();

    // The asset list reads the decimals from the token itself, so the scale follows the token's own decimals
    const configs = [{ asset: token.address, priceFeed: priceFeed.address }];
    const configurator = (await ethers.getSigners())[0].address;
    const assetListAddress = await assetListFactory.callStatic.createAssetList(configs, configurator);
    await (await assetListFactory.createAssetList(configs, configurator)).wait();
    const assetList = AssetList__factory.connect(assetListAddress, ethers.provider);

    expect((await assetList.getAssetInfo(0)).scale).to.equal(10n ** BigInt(await token.decimals()));
  });

  it('reverts if baseTokenPriceFeed does not have 8 decimals', async () => {
    await expect(
      makeProtocol({
        assets: {
          USDC: {
            priceFeedDecimals: 18,
          },
          COMP: {},
        },
      })
    ).to.be.revertedWith("custom error 'BadDecimals()'");
  });

  it('reverts if asset has a price feed that does not have 8 decimals', async () => {
    await expect(
      makeProtocol({
        assets: {
          USDC: {},
          COMP: {
            initial: 1e7,
            decimals: 18,
            initialPrice: 1.2345,
            priceFeedDecimals: 18,
          },
        },
      })
    ).to.be.revertedWith("custom error 'PriceFeedDecimalsNotMatched()'");
  });

  it('reverts if base token has fewer than 6 decimals', async () => {
    await expect(
      makeProtocol({
        assets: {
          USDC: {
            decimals: 5,
          },
          COMP: {},
        },
      })
    ).to.be.revertedWith("custom error 'BadDecimals()'");
  });

  it('reverts if base token has more than 18 decimals', async () => {
    await expect(
      makeProtocol({
        assets: {
          USDC: {
            decimals: 19,
          },
          COMP: {},
        },
      })
    ).to.be.revertedWith("custom error 'BadDecimals()'");
  });

  it('reverts if initializeStorage is called after initialization', async () => {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();
    await expect(
      comet.initializeStorage()
    ).to.be.revertedWith("custom error 'AlreadyInitialized()'");
  });

  it('is not possible to create a perSecondInterestRateSlopeLow above FACTOR_SCALE', async () => {
    const uint64Max = BigInt(2 ** 64) - 1n;

    const { cometWithExtendedAssetList: comet } = await makeProtocol({
      supplyInterestRateSlopeLow: uint64Max,
      borrowInterestRateSlopeLow: uint64Max
    });

    // max value of interestRateSlopeLow should result in a value less than FACTOR_SCALE
    expect(await comet.supplyPerSecondInterestRateBase()).to.be.lt(exp(1, 18));
    expect(await comet.borrowPerSecondInterestRateBase()).to.be.lt(exp(1, 18));

    // exceeding the max value of interestRateSlopeLow should overflow
    await expect(
      makeProtocol({
        supplyInterestRateSlopeLow: uint64Max + 1n
      })
    ).to.be.rejectedWith('value out-of-bounds'); // ethers.js error
    await expect(
      makeProtocol({
        borrowInterestRateSlopeLow: uint64Max + 1n
      })
    ).to.be.rejectedWith('value out-of-bounds'); // ethers.js error
  });
});
