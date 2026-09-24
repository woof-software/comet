import { expect, makeProtocol } from './helpers.js';

describe('updateAssetsIn', function () {
  it("adds asset to user's asset list when initialUserBalance=0 and finalUserBalance>0", async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [user] } = await makeProtocol();
    const compAddress = await tokens['COMP'].getAddress();
    const wethAddress = await tokens['WETH'].getAddress();
    const wbtcAddress = await tokens['WBTC'].getAddress();

    expect(await comet.getAssetList(user.address)).to.be.empty;

    await comet.updateAssetsInExternal(user.address, compAddress, 0, 1);
    expect(await comet.getAssetList(user.address)).to.deep.equal([compAddress]);

    await comet.updateAssetsInExternal(user.address, wethAddress, 0, 100_000);
    expect(await comet.getAssetList(user.address)).to.deep.equal([compAddress, wethAddress]);

    await comet.updateAssetsInExternal(user.address, wbtcAddress, 0, 100_000_000);
    expect(await comet.getAssetList(user.address)).to.deep.equal([
      compAddress,
      wethAddress,
      wbtcAddress,
    ]);
  });

  it('works for up to 12 assets', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users } = await makeProtocol({
      assets: {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
        ASSET4: {},
        ASSET5: {},
        ASSET6: {},
        ASSET7: {},
        ASSET8: {},
        ASSET9: {},
        ASSET10: {},
        ASSET11: {},
        ASSET12: {},
      },
    });
    const [user] = users;
    const asset12address = await tokens['ASSET12'].getAddress();

    await comet.updateAssetsInExternal(user.address, asset12address, 0, 1);
    expect(await comet.getAssetList(user.address)).to.deep.equal([asset12address]);
  });

  it('does not change state when both initialUserBalance and finalUserBalance are 0', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [user] } = await makeProtocol();
    const compAddress = await tokens['COMP'].getAddress();

    expect(await comet.getAssetList(user.address)).to.be.empty;

    await comet.updateAssetsInExternal(user.address, compAddress, 0, 0);

    expect(await comet.getAssetList(user.address)).to.be.empty;
  });

  it('does not change state when both initialUserBalance and finalUserBalance > 0', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [user] } = await makeProtocol();
    const wethAddress = await tokens['WETH'].getAddress();

    // enters asset
    await comet.updateAssetsInExternal(user.address, wethAddress, 0, 100_000);
    expect(await comet.getAssetList(user.address)).to.deep.equal([wethAddress]);

    // still in asset
    await comet.updateAssetsInExternal(user.address, wethAddress, 100_000, 999);
    expect(await comet.getAssetList(user.address)).to.deep.equal([wethAddress]);
  });

  it('removes asset from asset list when initialUserBalance > 0 and finalUserBalance=0', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [user] } = await makeProtocol();
    const compAddress = await tokens['COMP'].getAddress();

    // initially not in asset
    expect(await comet.getAssetList(user.address)).to.be.empty;

    // enters asset
    await comet.updateAssetsInExternal(user.address, compAddress, 0, 1);
    expect(await comet.getAssetList(user.address)).to.deep.equal([compAddress]);

    // leaves asset
    await comet.updateAssetsInExternal(user.address, compAddress, 1, 0);
    expect(await comet.getAssetList(user.address)).to.be.empty;
  });

  it('reverts for non-existent asset address', async () => {
    const { cometWithExtendedAssetList: comet, pauseGuardian, users: [user] } = await makeProtocol();

    const erroneousAssetAddress = pauseGuardian.address;

    await expect(
      comet.updateAssetsInExternal(user.address, erroneousAssetAddress, 0, 100)
    ).to.be.revertedWithCustomError(comet, 'BadAsset');
  });
});
