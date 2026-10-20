import { expect } from 'chai';
import { ethers } from 'ethers';
import { CometContext, scenario } from '../context/CometContext';
import { FaucetToken } from '../../build/types';
import { exp } from '../../test/helpers';
import { hashConfig } from '../../test/asset-list/shared';
import { fundAccount, servicePatch2 } from '../utils';
import { deployMockERC20, deployPriceFeed } from '../configurator/shared';

// The storage part of a config, for the direct AssetList.setAssetConfig calls
const storageConfig = {
  borrowCollateralFactor: exp(0.75, 18),
  liquidateCollateralFactor: exp(0.8, 18),
  liquidationFactor: exp(0.9, 18),
  supplyCap: exp(1000, 18),
};

// Adding an asset to a live market takes four steps:
//   1. Configurator.addAsset appends the full config to the stored configs.
//   2. Configurator.deployAssetList builds a new list implementation that has the asset in its immutables.
//   3. The list proxy is upgraded to it; CometProxyAdmin.deployAndUpgradeAssetListTo does 2 and 3 together.
//   4. Configurator.setAssetConfigToAssetList registers the asset in the list with the factors and cap of the stored config.

scenario(
  'AssetList#addAsset > adds a new asset through the Configurator and fills the list',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await (await ctx.getComet()).numAssets()) < 23
  },
  async ({ comet, configurator, proxyAdmin, assetList, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const numAssets = await comet.numAssets();
    const storageKeys = ['borrowCollateralFactor', 'liquidateCollateralFactor', 'liquidationFactor', 'supplyCap'];
    const immutableKeys = ['asset', 'decimals', 'priceFeed'];

    // A new collateral with its own 18 decimals token and price feed, active and with a cap of 1000 tokens
    const newAssetConfig = {
      asset: await deployMockERC20(context, 'asset'),
      priceFeed: await deployPriceFeed(context, 'asset'),
      decimals: 18,
      ...storageConfig,
    };
    const { asset } = newAssetConfig;

    const allAssetsInfo = () => Promise.all([...Array(numAssets).keys()].map((i) => assetList.getAssetInfo(i)));

    /* Step 1: addAsset */

    const assetConfigsBeforeAdd = await configurator.getAssetConfigs(comet.address);

    // It emits AddAsset on the Configurator with the full config
    await expect(configurator.connect(admin.signer).addAsset(comet.address, newAssetConfig))
      .to.emit(configurator, 'AddAsset')
      .withArgs(comet.address, Object.values(newAssetConfig));

    const assetConfigsAfterAdd = await configurator.getAssetConfigs(comet.address);

    // It appends the full config at the end of the stored configs and leaves the existing ones unchanged
    expect(assetConfigsAfterAdd.length).to.equal(numAssets + 1);
    for (const key of Object.keys(newAssetConfig)) expect(assetConfigsAfterAdd[numAssets][key]).to.equal(newAssetConfig[key]);
    expect(assetConfigsAfterAdd.slice(0, numAssets)).to.deep.equal(assetConfigsBeforeAdd);

    // getAssetIndex, getImmutableAssetConfig and getStorageAssetConfig all know the new asset
    expect(await configurator.getAssetIndex(comet.address, asset)).to.equal(numAssets);
    
    const immutableConfig = (await configurator.getImmutableAssetConfig(comet.address))[numAssets];
    for (const key of immutableKeys) expect(immutableConfig[key]).to.equal(newAssetConfig[key]);

    const newStorageConfig = (await configurator.getStorageAssetConfig(comet.address))[numAssets];
    for (const key of storageKeys) expect(newStorageConfig[key]).to.equal(newAssetConfig[key]);

    /* Between step 1 and the upgrade */

    // Neither the list nor the Comet knows the asset yet
    expect(await assetList.numAssets()).to.equal(numAssets);
    await expect(assetList.getAssetInfoByAddress(asset)).to.be.revertedWithCustomError(assetList, 'BadAsset');
    expect(await comet.numAssets()).to.equal(numAssets);
    await expect(comet.getAssetInfoByAddress(asset)).to.be.revertedWithCustomError(assetList, 'BadAsset');

    // The hash of the immutable configs changed, so deployAssetList would build a new implementation
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.not.equal(ethers.constants.AddressZero);

    /* Redeploy and upgrade */

    const allAssetsInfoBeforeUpgrade = await allAssetsInfo();
    await proxyAdmin.connect(admin.signer).deployAndUpgradeAssetListTo(configurator.address, comet.address);
    const newImplementation = assetList.attach(await proxyAdmin.getProxyImplementation(assetList.address));
    const upgradedAssetInfo = await assetList.getAssetInfo(numAssets);

    // The new implementation has one more asset, the new one in its last slot, and a configHash matching the configs
    expect(await newImplementation.numAssets()).to.equal(numAssets + 1);
    expect((await newImplementation.getAssetInfo(numAssets)).asset).to.equal(asset);
    expect(await newImplementation.configHash()).to.equal(hashConfig(await configurator.getImmutableAssetConfig(comet.address)));

    // The factors and caps of the existing assets are still in the list storage
    expect(await allAssetsInfo()).to.deep.equal(allAssetsInfoBeforeUpgrade);

    // The list reads the address, price feed and scale of the new asset from the immutables,
    // but the asset is not registered yet, so its factors and cap are zero
    expect(upgradedAssetInfo.asset).to.equal(asset);
    expect(upgradedAssetInfo.priceFeed).to.equal(newAssetConfig.priceFeed);
    expect(upgradedAssetInfo.scale).to.equal(exp(1, 18));
    for (const key of storageKeys) expect(upgradedAssetInfo[key]).to.equal(0);

    // The immutable configs match the list again, so deployAssetList would build nothing
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(ethers.constants.AddressZero);

    /* Step 2: setAssetConfigToAssetList */

    const assetConfigsBeforeStep2 = await configurator.getAssetConfigs(comet.address);
    const allAssetsInfoBeforeStep2 = await allAssetsInfo();
    await expect(configurator.connect(admin.signer).setAssetConfigToAssetList(comet.address, asset))
      .to.emit(configurator, 'SetAssetConfigToAssetList')
      .withArgs(comet.address, assetList.address, asset);
    const assetInfo = await assetList.getAssetInfo(numAssets);

    // The asset gets the factors and cap of its stored config
    for (const key of storageKeys) expect(assetInfo[key]).to.equal(newAssetConfig[key]);

    // getAssetInfoByAddress returns the same values as getAssetInfo, and the offset is the index of the asset
    expect(await assetList.getAssetInfoByAddress(asset)).to.deep.equal(assetInfo);
    expect(assetInfo.offset).to.equal(numAssets);

    // The stored configs and the already registered assets are unchanged
    expect(await configurator.getAssetConfigs(comet.address)).to.deep.equal(assetConfigsBeforeStep2);
    expect(await allAssetsInfo()).to.deep.equal(allAssetsInfoBeforeStep2);

    /* Redeploy the Comet and supply the new asset */

    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);
    expect(await comet.numAssets()).to.equal(numAssets + 1);

    // The mock token has no holders to source it from, so 1 wei is allocated to Albert from its faucet
    const { albert } = actors;
    const supplyAmount = 1n;
    const token = await context.world.deploymentManager.hre.ethers.getContractAt('FaucetToken', asset) as FaucetToken;
    await token.allocateTo(albert.address, supplyAmount);

    const albertBalanceBefore = (await token.balanceOf(albert.address)).toBigInt();
    const cometBalanceBefore = (await token.balanceOf(comet.address)).toBigInt();
    const { totalSupplyAsset: totalSupplyBefore } = await comet.totalsCollateral(asset);

    await token.connect(albert.signer).approve(comet.address, supplyAmount);
    await comet.connect(albert.signer).supply(asset, supplyAmount);

    // The token moved from Albert to the Comet, and the Comet credits Albert with it as collateral
    expect(await token.balanceOf(albert.address)).to.equal(albertBalanceBefore - supplyAmount);
    expect(await token.balanceOf(comet.address)).to.equal(cometBalanceBefore + supplyAmount);
    expect(await comet.collateralBalanceOf(albert.address, asset)).to.equal(supplyAmount);
    expect((await comet.totalsCollateral(asset)).totalSupplyAsset).to.equal(totalSupplyBefore.toBigInt() + supplyAmount);
  }
);

/*//////////////////////////////////////////////////////////////
                             ACCESS
//////////////////////////////////////////////////////////////*/

scenario(
  'AssetList#addAsset > setAssetConfigToAssetList reverts for anyone but the governor',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;
    const asset = await deployMockERC20(context, 'asset');

    await expect(configurator.connect(albert.signer).setAssetConfigToAssetList(comet.address, asset))
      .to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'AssetList#addAsset > AssetList.setAssetConfig reverts when called directly by the governor',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ assetList, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);
    const asset = await deployMockERC20(context, 'asset');

    await expect(assetList.connect(admin.signer).setAssetConfig(asset, storageConfig))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
  }
);

scenario(
  'AssetList#addAsset > AssetList.setAssetConfig reverts when called directly by a random account',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ assetList, actors }, context) => {
    const { albert } = actors;
    const asset = await deployMockERC20(context, 'asset');

    await expect(assetList.connect(albert.signer).setAssetConfig(asset, storageConfig))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
  }
);

scenario(
  'AssetList#addAsset > AssetList.setAssetConfig reverts when called directly by the proxy admin, which never reaches the implementation',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ proxyAdmin, assetList }, context) => {
    const asset = await deployMockERC20(context, 'asset');
    const proxyAdminSigner = await context.world.impersonateAddress(proxyAdmin.address);
    await fundAccount(context.world, proxyAdminSigner);

    await expect(assetList.connect(proxyAdminSigner).setAssetConfig(asset, storageConfig))
      .to.be.revertedWith('TransparentUpgradeableProxy: admin cannot fallback to proxy target');
  }
);
