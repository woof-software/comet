import { expect, exp, makeProtocol } from './helpers';

describe('asset info', function () {
  it('initializes protocol', async () => {
    const { cometWithExtendedAssetList : comet, tokens } = await makeProtocol({
      assets: {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
      },
      reward: 'ASSET1',
    });

    const cometNumAssets = await comet.numAssets();
    const cometMaxAssets = await comet.maxAssets();
    expect(cometMaxAssets).to.be.equal(24);
    expect(cometNumAssets).to.be.equal(3);

    // makeProtocol builds the asset list with its default factors, so every asset info must match them
    const symbols = ['ASSET1', 'ASSET2', 'ASSET3'];
    for (let i = 0; i < symbols.length; i++) {
      const assetInfo = await comet.getAssetInfo(i);
      expect(assetInfo.asset).to.be.equal(tokens[symbols[i]].address);
      expect(assetInfo.borrowCollateralFactor).to.equal(exp(0.75, 18));
      expect(assetInfo.liquidateCollateralFactor).to.equal(exp(0.8, 18));
      expect(assetInfo.liquidationFactor).to.equal(exp(0.9, 18));
    }
  });

  it('reverts if too many assets are passed', async () => {
    const assets = { USDC: {} };
    for (let i = 0; i < 25; i++) assets[`ASSET${i}`] = {};
    await expect(makeProtocol({ assets })).to.be.revertedWith("custom error 'TooManyAssets()'");
  });

  it('reverts if index is greater than numAssets', async () => {
    const { cometWithExtendedAssetList : comet } = await makeProtocol();
    await expect(comet.getAssetInfo(3)).to.be.revertedWith("custom error 'BadAsset()'");
  });

  it('reverts if collateral factors are out of range', async () => {
    await expect(makeProtocol({
      assets: {
        USDC: {},
        ASSET1: {borrowCF: exp(0.9, 18), liquidateCF: exp(0.9, 18)},
        ASSET2: {},
      },
    })).to.be.revertedWith("custom error 'BorrowCFTooLarge()'");

    await expect(makeProtocol({
      assets: {
        USDC: {},
        ASSET1: {borrowCF: exp(0.99, 18), liquidateCF: exp(1.1, 18)},
        ASSET2: {},
      },
    })).to.be.revertedWith("custom error 'LiquidateCFTooLarge()'");
  });
});
