import { expect } from 'chai';
import { ethers } from 'ethers';
import { CometContext, scenario } from '../context/CometContext';
import { fundAccount, getUsableCollateralIndices, servicePatch2 } from '../utils';
import { MAX_COLLATERAL_FACTOR, supplyCaps } from '../assetList/shared';
import { exp } from '../../test/helpers';
import { deployMockERC20, deployPriceFeed } from './shared';

// The Configurator side of the asset config functions: the stored configs and the reverts.
// What the asset list and the Comet read after the same calls is in scenario/assetList/CollateralFactorsScenario.ts
// and scenario/assetList/FractionalSupplyCapsScenario.ts

/*//////////////////////////////////////////////////////////////
                            ADD ASSET
//////////////////////////////////////////////////////////////*/

scenario(
  'Configurator#addAsset adds a new asset to the asset configs if called by governor',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const assetConfigsBefore = await configurator.getAssetConfigs(comet.address);
    const newAssetConfig = {
      asset: await deployMockERC20(context, 'asset'),
      priceFeed: await deployPriceFeed(context, 'asset'),
      borrowCollateralFactor: exp(0.75, 18),
      liquidateCollateralFactor: exp(0.8, 18),
      liquidationFactor: exp(0.9, 18),
      supplyCap: exp(1000, 18),
    };

    await configurator.connect(admin.signer).addAsset(comet.address, newAssetConfig);

    // The new config is appended at the end, and the existing ones keep their place and values
    const assetConfigsAfter = await configurator.getAssetConfigs(comet.address);
    expect(assetConfigsAfter.length).to.equal(assetConfigsBefore.length + 1);
    for (const key of Object.keys(newAssetConfig)) {
      expect(assetConfigsAfter[assetConfigsBefore.length][key]).to.equal(newAssetConfig[key]);
    }
    for (let i = 0; i < assetConfigsBefore.length; i++) {
      expect(assetConfigsAfter[i]).to.deep.equal(assetConfigsBefore[i]);
    }
  }
);

scenario(
  'Configurator#addAsset reverts if asset is zero address',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    await expect(configurator.connect(admin.signer).addAsset(comet.address, {
      asset: ethers.constants.AddressZero,
      priceFeed: await deployPriceFeed(context, 'asset'),
      borrowCollateralFactor: exp(0.75, 18),
      liquidateCollateralFactor: exp(0.8, 18),
      liquidationFactor: exp(0.9, 18),
      supplyCap: exp(1000, 18),
    })).to.be.revertedWithCustomError(configurator, 'InvalidAddress');
  }
);

scenario(
  'Configurator#addAsset reverts if called by non-governor',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;

    await expect(configurator.connect(albert.signer).addAsset(comet.address, {
      asset: await deployMockERC20(context, 'asset'),
      priceFeed: await deployPriceFeed(context, 'asset'),
      borrowCollateralFactor: exp(0.75, 18),
      liquidateCollateralFactor: exp(0.8, 18),
      liquidationFactor: exp(0.9, 18),
      supplyCap: exp(1000, 18),
    })).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#addAsset reverts if asset is already in the asset configs',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await (await ctx.getComet()).numAssets()) > 0
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const [existingAssetConfig] = await configurator.getAssetConfigs(comet.address);

    await expect(configurator.connect(admin.signer).addAsset(comet.address, existingAssetConfig))
      .to.be.revertedWithCustomError(configurator, 'AssetAlreadyExists');
  }
);

/*//////////////////////////////////////////////////////////////
                    SET ASSET CONFIG TO ASSET LIST
//////////////////////////////////////////////////////////////*/

// What the asset list reads after setAssetConfigToAssetList is checked in scenario/assetList/AssetListGovernanceScenario.ts;
// here are only the reverts of the Configurator

scenario(
  'Configurator#setAssetConfigToAssetList reverts if called by non-governor',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset } = await comet.getAssetInfo(assetIndex);

    await expect(configurator.connect(albert.signer).setAssetConfigToAssetList(comet.address, asset))
      .to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setAssetConfigToAssetList reverts if asset does not exist',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin, albert } = actors;
    await fundAccount(context.world, admin);

    // Any address that is not a collateral of the market
    await expect(configurator.connect(admin.signer).setAssetConfigToAssetList(comet.address, albert.address))
      .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
  }
);

/*//////////////////////////////////////////////////////////////
                           UPDATE ASSET
//////////////////////////////////////////////////////////////*/

scenario(
  'Configurator#updateAsset succeeds if called by governor',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const assetConfigsBefore = await configurator.getAssetConfigs(comet.address);
    const { asset, priceFeed, liquidateCollateralFactor, liquidationFactor, supplyCap } = assetConfigsBefore[assetIndex];

    // The collateral stops backing new borrows and gets one more wei of cap
    const updatedAssetConfig = {
      asset,
      priceFeed,
      borrowCollateralFactor: 0,
      liquidateCollateralFactor,
      liquidationFactor,
      supplyCap: supplyCap.add(1),
    };

    await configurator.connect(admin.signer).updateAsset(comet.address, updatedAssetConfig);

    // The stored config of the asset is replaced, and the other assets keep theirs
    const assetConfigsAfter = await configurator.getAssetConfigs(comet.address);
    expect(assetConfigsAfter.length).to.equal(assetConfigsBefore.length);
    for (const key of Object.keys(updatedAssetConfig)) {
      expect(assetConfigsAfter[assetIndex][key]).to.equal(updatedAssetConfig[key]);
    }
    for (let i = 0; i < assetConfigsBefore.length; i++) {
      if (i != assetIndex) expect(assetConfigsAfter[i]).to.deep.equal(assetConfigsBefore[i]);
    }
  }
);

scenario(
  'Configurator#updateAsset does not change the asset list',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, assetList, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset, priceFeed, liquidateCollateralFactor, liquidationFactor, supplyCap } =
      (await configurator.getAssetConfigs(comet.address))[assetIndex];
    const assetInfoBefore = await assetList.getAssetInfoByAddress(asset);

    await configurator.connect(admin.signer).updateAsset(comet.address, {
      asset,
      priceFeed,
      borrowCollateralFactor: 0,
      liquidateCollateralFactor,
      liquidationFactor,
      supplyCap: supplyCap.add(1),
    });

    // updateAsset writes only the stored config; the list keeps the old factors and cap until they are pushed to it
    expect(await assetList.getAssetInfoByAddress(asset)).to.deep.equal(assetInfoBefore);
    expect(await comet.getAssetInfo(assetIndex)).to.deep.equal(assetInfoBefore);
  }
);

scenario(
  'Configurator#updateAsset reverts if asset does not exist',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin, albert } = actors;
    await fundAccount(context.world, admin);

    // Any address that is not a collateral of the market
    await expect(configurator.connect(admin.signer).updateAsset(comet.address, {
      asset: albert.address,
      priceFeed: await deployPriceFeed(context, 'asset'),
      borrowCollateralFactor: exp(0.75, 18),
      liquidateCollateralFactor: exp(0.8, 18),
      liquidationFactor: exp(0.9, 18),
      supplyCap: exp(1000, 18),
    })).to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
  }
);

scenario(
  'Configurator#updateAsset reverts if called by non-governor',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const assetConfig = (await configurator.getAssetConfigs(comet.address))[assetIndex];

    await expect(configurator.connect(albert.signer).updateAsset(comet.address, assetConfig))
      .to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

/*//////////////////////////////////////////////////////////////
                      UPDATE ASSET PRICE FEED
//////////////////////////////////////////////////////////////*/

scenario(
  'Configurator#updateAssetPriceFeed updates the price feed if called by governor',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const assetConfigsBefore = await configurator.getAssetConfigs(comet.address);
    const newPriceFeed = await deployPriceFeed(context, 'asset');

    await configurator.connect(admin.signer).updateAssetPriceFeed(comet.address, assetConfigsBefore[assetIndex].asset, newPriceFeed);

    // Only the price feed of the asset changed in the stored configs
    const assetConfigsAfter = await configurator.getAssetConfigs(comet.address);
    expect(assetConfigsAfter[assetIndex].priceFeed).to.equal(newPriceFeed);
    for (const key of ['asset', 'borrowCollateralFactor', 'liquidateCollateralFactor', 'liquidationFactor', 'supplyCap']) {
      expect(assetConfigsAfter[assetIndex][key]).to.equal(assetConfigsBefore[assetIndex][key]);
    }
    for (let i = 0; i < assetConfigsBefore.length; i++) {
      if (i != assetIndex) expect(assetConfigsAfter[i]).to.deep.equal(assetConfigsBefore[i]);
    }
  }
);

scenario(
  'Configurator#updateAssetPriceFeed reverts if asset does not exist',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin, albert } = actors;
    await fundAccount(context.world, admin);

    // Any address that is not a collateral of the market
    await expect(configurator.connect(admin.signer).updateAssetPriceFeed(
      comet.address,
      albert.address,
      await deployPriceFeed(context, 'asset')
    )).to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
  }
);

scenario(
  'Configurator#updateAssetPriceFeed reverts if called by non-governor',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset } = await comet.getAssetInfo(assetIndex);
    const newPriceFeed = await deployPriceFeed(context, 'asset');

    await expect(configurator.connect(albert.signer).updateAssetPriceFeed(comet.address, asset, newPriceFeed))
      .to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#updateAssetPriceFeed reverts if asset is zero address',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    await expect(configurator.connect(admin.signer).updateAssetPriceFeed(
      comet.address,
      ethers.constants.AddressZero,
      await deployPriceFeed(context, 'asset')
    )).to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
  }
);

/*//////////////////////////////////////////////////////////////
                        COLLATERAL FACTORS
//////////////////////////////////////////////////////////////*/

/*//////////////////////////////////////////////////////////////
                          HAPPY CASES
//////////////////////////////////////////////////////////////*/

scenario(
  'Configurator#collateralFactors > stores active collateral (0 <= BCF < LCF < LF <= MAX) for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator }) => {
    // The market's own factors are an active setup, and the storage part the asset list is built from matches them
    const assetConfigs = await configurator.getAssetConfigs(comet.address);
    const storageConfigs = await configurator.getStorageAssetConfig(comet.address);

    for (let i = 0; i < assetConfigs.length; i++) {
      expect(assetConfigs[i].borrowCollateralFactor).to.be.greaterThanOrEqual(0);
      expect(assetConfigs[i].borrowCollateralFactor).to.be.lessThan(assetConfigs[i].liquidateCollateralFactor);
      expect(assetConfigs[i].liquidateCollateralFactor).to.be.lessThan(assetConfigs[i].liquidationFactor);
      expect(assetConfigs[i].liquidationFactor).to.be.lessThanOrEqual(MAX_COLLATERAL_FACTOR);

      expect(storageConfigs[i].borrowCollateralFactor).to.equal(assetConfigs[i].borrowCollateralFactor);
      expect(storageConfigs[i].liquidateCollateralFactor).to.equal(assetConfigs[i].liquidateCollateralFactor);
      expect(storageConfigs[i].liquidationFactor).to.equal(assetConfigs[i].liquidationFactor);
    }
  }
);

scenario(
  'Configurator#collateralFactors > stores soft de-listed collateral (BCF = 0) for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const assetConfigs = await configurator.getAssetConfigs(comet.address);

    for (const { asset } of assetConfigs) {
      await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, asset, 0);
    }

    // Only the borrow collateral factor changed in the stored configs
    const assetConfigsAfter = await configurator.getAssetConfigs(comet.address);
    for (let i = 0; i < assetConfigs.length; i++) {
      expect(assetConfigsAfter[i].borrowCollateralFactor).to.equal(0);
      for (const key of ['asset', 'priceFeed', 'liquidateCollateralFactor', 'liquidationFactor', 'supplyCap']) {
        expect(assetConfigsAfter[i][key]).to.equal(assetConfigs[i][key]);
      }
    }
  }
);

scenario(
  'Configurator#collateralFactors > stores fully de-listed collateral (BCF = LCF = 0) for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const assetConfigs = await configurator.getAssetConfigs(comet.address);

    // The borrow collateral factor goes to zero first, so the liquidate collateral factor can follow
    for (const { asset } of assetConfigs) {
      await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, asset, 0);
      await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, asset, 0);
    }

    // Only the borrow and liquidate collateral factors changed in the stored configs
    const assetConfigsAfter = await configurator.getAssetConfigs(comet.address);
    for (let i = 0; i < assetConfigs.length; i++) {
      expect(assetConfigsAfter[i].borrowCollateralFactor).to.equal(0);
      expect(assetConfigsAfter[i].liquidateCollateralFactor).to.equal(0);
      for (const key of ['asset', 'priceFeed', 'liquidationFactor', 'supplyCap']) {
        expect(assetConfigsAfter[i][key]).to.equal(assetConfigs[i][key]);
      }
    }
  }
);

scenario(
  'Configurator#collateralFactors > stores non-liquidatable collateral (BCF = LCF = LF = 0) for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const assetConfigs = await configurator.getAssetConfigs(comet.address);

    // All three factors go to zero, from the lowest factor up
    for (const { asset } of assetConfigs) {
      await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, asset, 0);
      await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, asset, 0);
      await configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, asset, 0);
    }

    // Only the three factors changed in the stored configs
    const assetConfigsAfter = await configurator.getAssetConfigs(comet.address);
    for (let i = 0; i < assetConfigs.length; i++) {
      expect(assetConfigsAfter[i].borrowCollateralFactor).to.equal(0);
      expect(assetConfigsAfter[i].liquidateCollateralFactor).to.equal(0);
      expect(assetConfigsAfter[i].liquidationFactor).to.equal(0);
      for (const key of ['asset', 'priceFeed', 'supplyCap']) {
        expect(assetConfigsAfter[i][key]).to.equal(assetConfigs[i][key]);
      }
    }
  }
);

scenario(
  'Configurator#collateralFactors > accepts the current value again from each setter for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const assetConfigs = await configurator.getAssetConfigs(comet.address);

    // Writing back the current value goes through
    for (const { asset, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor } of assetConfigs) {
      await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, asset, borrowCollateralFactor);
      await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, asset, liquidateCollateralFactor);
      await configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, asset, liquidationFactor);
    }

    // And the stored configs are unchanged
    expect(await configurator.getAssetConfigs(comet.address)).to.deep.equal(assetConfigs);
  }
);

/*//////////////////////////////////////////////////////////////
                          REVERT CASES
//////////////////////////////////////////////////////////////*/

scenario(
  'Configurator#collateralFactors > revert when the asset is not in the stored configs',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin, albert } = actors;
    await fundAccount(context.world, admin);

    // Any address that is not a collateral of the market
    const asset = albert.address;

    await expect(configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, asset, 0))
      .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
    await expect(configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, asset, 0))
      .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
    await expect(configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, asset, 0))
      .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
  }
);

/*//////////////////////////////////////////////////////////////
                             ACCESS
//////////////////////////////////////////////////////////////*/

// The collateral factor setters of the Configurator are for the governor only. Every call writes back the current
// factors of a usable collateral, which are valid, so a call can only fail on who makes it

scenario(
  'Configurator#collateralFactors > revert when called by a random account',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor } = await comet.getAssetInfo(assetIndex);

    await expect(configurator.connect(albert.signer).updateAssetBorrowCollateralFactor(comet.address, asset, borrowCollateralFactor))
      .to.be.revertedWithCustomError(configurator, 'Unauthorized');
    await expect(configurator.connect(albert.signer).updateAssetLiquidateCollateralFactor(comet.address, asset, liquidateCollateralFactor))
      .to.be.revertedWithCustomError(configurator, 'Unauthorized');
    await expect(configurator.connect(albert.signer).updateAssetLiquidationFactor(comet.address, asset, liquidationFactor))
      .to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#collateralFactors > revert when called by the asset list',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, assetList }, context) => {
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor } = await comet.getAssetInfo(assetIndex);
    const assetListSigner = await context.world.impersonateAddress(assetList.address);
    await fundAccount(context.world, assetListSigner);

    await expect(configurator.connect(assetListSigner).updateAssetBorrowCollateralFactor(comet.address, asset, borrowCollateralFactor))
      .to.be.revertedWithCustomError(configurator, 'Unauthorized');
    await expect(configurator.connect(assetListSigner).updateAssetLiquidateCollateralFactor(comet.address, asset, liquidateCollateralFactor))
      .to.be.revertedWithCustomError(configurator, 'Unauthorized');
    await expect(configurator.connect(assetListSigner).updateAssetLiquidationFactor(comet.address, asset, liquidationFactor))
      .to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

/*//////////////////////////////////////////////////////////////
                          SUPPLY CAPS
//////////////////////////////////////////////////////////////*/

/*//////////////////////////////////////////////////////////////
                          HAPPY CASES
//////////////////////////////////////////////////////////////*/

// Gives every collateral the cap of this scenario and checks that only the cap changed in the stored configs
supplyCaps.forEach(([name, capFor]) => {
  scenario(
    `Configurator#updateAssetSupplyCap > stores a ${name} supply cap`,
    { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
    async ({ comet, configurator, actors }, context) => {
      const { admin } = actors;
      await fundAccount(context.world, admin);

      const assetConfigs = await configurator.getAssetConfigs(comet.address);
      const newSupplyCaps: bigint[] = [];
      for (const assetConfig of assetConfigs) newSupplyCaps.push(await capFor(assetConfig, context));

      for (let i = 0; i < assetConfigs.length; i++) {
        await configurator.connect(admin.signer).updateAssetSupplyCap(comet.address, assetConfigs[i].asset, newSupplyCaps[i]);
      }

      const assetConfigsAfter = await configurator.getAssetConfigs(comet.address);
      const storageConfigsAfter = await configurator.getStorageAssetConfig(comet.address);
      for (let i = 0; i < assetConfigs.length; i++) {
        expect(assetConfigsAfter[i].supplyCap).to.equal(newSupplyCaps[i]);
        expect(storageConfigsAfter[i].supplyCap).to.equal(newSupplyCaps[i]);
        for (const key of ['asset', 'priceFeed', 'borrowCollateralFactor', 'liquidateCollateralFactor', 'liquidationFactor']) {
          expect(assetConfigsAfter[i][key]).to.equal(assetConfigs[i][key]);
        }
      }
    }
  );
});

scenario(
  'Configurator#updateAssetSupplyCap > accepts the current supply cap again for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const assetConfigs = await configurator.getAssetConfigs(comet.address);

    for (const { asset, supplyCap } of assetConfigs) {
      await configurator.connect(admin.signer).updateAssetSupplyCap(comet.address, asset, supplyCap);
    }

    expect(await configurator.getAssetConfigs(comet.address)).to.deep.equal(assetConfigs);
  }
);

/*//////////////////////////////////////////////////////////////
                          REVERT CASES
//////////////////////////////////////////////////////////////*/

scenario(
  'Configurator#updateAssetSupplyCap > reverts when the asset is not in the stored configs',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const { admin, albert } = actors;
    await fundAccount(context.world, admin);

    // Any address that is not a collateral of the market
    await expect(configurator.connect(admin.signer).updateAssetSupplyCap(comet.address, albert.address, 1n))
      .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
  }
);

scenario(
  'Configurator#updateAssetSupplyCap > reverts when called by anyone but the governor',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset, supplyCap } = await comet.getAssetInfo(assetIndex);

    await expect(configurator.connect(albert.signer).updateAssetSupplyCap(comet.address, asset, supplyCap))
      .to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);
