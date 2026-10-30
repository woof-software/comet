import { expect } from 'chai';
import { ethers } from 'ethers';
import { CometContext, scenario } from '../context/CometContext';
import { AssetList } from '../../build/types';
import { fundAccount, getUsableCollateralIndices, servicePatch2 } from '../utils';
import { hashConfig } from '../../test/asset-list/shared';
import { deployPriceFeed } from './shared';

// The asset list functions of the Configurator: which factory builds the asset list of a Comet, building a new
// implementation from the stored configs, and pointing the Comet's configuration to an asset list.
// They exist only on the upgraded Configurator, which comes with the service patch 2 Comet

async function deployAssetListFactory(context: CometContext): Promise<string> {
  const assetListFactory = await context.world.deploymentManager.deploy(
    'test:assetListFactory',
    'test/assetList/AssetListFactory.sol',
    []
  );

  return assetListFactory.address;
}

/*//////////////////////////////////////////////////////////////
                         SET ASSET LIST FACTORY
//////////////////////////////////////////////////////////////*/

scenario(
  'Configurator#setAssetListFactory sets a new asset list factory if called by governor',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const newAssetListFactory = await deployAssetListFactory(context);

    await configurator.connect(admin.signer).setAssetListFactory(comet.address, newAssetListFactory);

    expect(await configurator.cometAssetListFactories(comet.address)).to.equal(newAssetListFactory);
  }
);

scenario(
  'Configurator#setAssetListFactory sets the same asset list factory again if called by governor',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const assetListFactory = await configurator.cometAssetListFactories(comet.address);

    await configurator.connect(admin.signer).setAssetListFactory(comet.address, assetListFactory);

    expect(await configurator.cometAssetListFactories(comet.address)).to.equal(assetListFactory);
  }
);

scenario(
  'Configurator#setAssetListFactory reverts if called by non-governor',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const newAssetListFactory = ethers.Wallet.createRandom().address;

    await expect(
      configurator.connect(albert.signer).setAssetListFactory(comet.address, newAssetListFactory)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setAssetListFactory reverts if asset list factory is zero address',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    await expect(
      configurator.connect(admin.signer).setAssetListFactory(comet.address, ethers.constants.AddressZero)
    ).to.be.revertedWithCustomError(configurator, 'InvalidAddress');
  }
);

/*//////////////////////////////////////////////////////////////
                           DEPLOY ASSET LIST
//////////////////////////////////////////////////////////////*/

scenario(
  'Configurator#deployAssetList can be called by anyone and deploys a new asset list implementation',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin, albert } = actors;
    await fundAccount(context.world, admin);

    // A new price feed changes the immutable configs, so there is something to deploy
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset } = await comet.getAssetInfo(assetIndex);
    const newPriceFeed = await deployPriceFeed(context, 'asset');
    await configurator.connect(admin.signer).updateAssetPriceFeed(comet.address, asset, newPriceFeed);

    // Albert is neither the governor nor the market admin
    const { newAssetListImpl } = await configurator.connect(albert.signer).callStatic.deployAssetList(comet.address);
    await configurator.connect(albert.signer).deployAssetList(comet.address);

    // The new implementation holds the immutable configs of the Configurator, the new price feed among them
    const newImplementation = await context.world.deploymentManager.hre.ethers.getContractAt(
      'AssetList',
      newAssetListImpl
    ) as AssetList;
    const immutableConfigs = await configurator.getImmutableAssetConfig(comet.address);
    expect(await newImplementation.numAssets()).to.equal(immutableConfigs.length);
    expect(await newImplementation.configHash()).to.equal(hashConfig(immutableConfigs));
    expect((await newImplementation.getAssetInfo(assetIndex)).priceFeed).to.equal(newPriceFeed);
  }
);

scenario(
  'Configurator#deployAssetList returns a new implementation when the configs differ from the asset list',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset } = await comet.getAssetInfo(assetIndex);
    await configurator.connect(admin.signer).updateAssetPriceFeed(comet.address, asset, await deployPriceFeed(context, 'asset'));

    // The hash of the configs no longer matches the one of the asset list
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl)
      .to.not.equal(ethers.constants.AddressZero);
  }
);

scenario(
  'Configurator#deployAssetList returns the zero address when the configs match the asset list',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, assetList }) => {
    const { assetListProxy, newAssetListImpl } = await configurator.callStatic.deployAssetList(comet.address);

    // Nothing changed since the asset list was built, so there is nothing to deploy
    expect(assetListProxy).to.equal(assetList.address);
    expect(newAssetListImpl).to.equal(ethers.constants.AddressZero);
  }
);

scenario(
  'Configurator#deployAssetList reverts if the market has no asset list proxy',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ configurator, actors }) => {
    const { albert } = actors;

    // deployAssetList only redeploys an existing list, and a Comet proxy the Configurator knows nothing about has none
    await expect(configurator.callStatic.deployAssetList(albert.address))
      .to.be.revertedWithCustomError(configurator, 'AssetListNotSet');
  }
);
