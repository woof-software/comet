import { expect } from 'chai';
import { CometContext, scenario } from '../context/CometContext';
import { fundAccount, getUsableCollateralIndices, servicePatch2 } from '../utils';
import { validateAssetInfos } from './shared';

// The highest liquidation factor the asset list accepts: a factor of one
const MAX_COLLATERAL_FACTOR = 10n ** 18n;

/*//////////////////////////////////////////////////////////////
                          HAPPY CASES
//////////////////////////////////////////////////////////////*/

scenario(
  'Comet#assetList > accepts active collateral (0 <= BCF < LCF < LF <= MAX) for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator }, context) => {
    // The market's own factors are an active setup
    const assetConfigs = await configurator.getAssetConfigs(comet.address);

    for (const assetConfig of assetConfigs) {
      expect(assetConfig.borrowCollateralFactor).to.be.greaterThanOrEqual(0);
      expect(assetConfig.borrowCollateralFactor).to.be.lessThan(assetConfig.liquidateCollateralFactor);
      expect(assetConfig.liquidateCollateralFactor).to.be.lessThan(assetConfig.liquidationFactor);
      expect(assetConfig.liquidationFactor).to.be.lessThanOrEqual(MAX_COLLATERAL_FACTOR);
    }

    await validateAssetInfos(context, assetConfigs);
  }
);

scenario(
  'Comet#assetList > accepts soft de-listed collateral (BCF = 0, 0 < LCF < LF <= MAX) for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator }, context) => {
    const { admin } = context.actors;
    await fundAccount(context.world, admin);

    // Every collateral stops backing new borrows but keeps its liquidation factors
    const assetConfigs = (await configurator.getAssetConfigs(comet.address)).map(assetConfig => ({
      ...assetConfig,
      borrowCollateralFactor: 0n,
    }));

    for (const assetConfig of assetConfigs) {
      await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, 0n);

      expect(assetConfig.liquidateCollateralFactor).to.be.greaterThan(0);
      expect(assetConfig.liquidateCollateralFactor).to.be.lessThan(assetConfig.liquidationFactor);
      expect(assetConfig.liquidationFactor).to.be.lessThanOrEqual(MAX_COLLATERAL_FACTOR);
    }

    await validateAssetInfos(context, assetConfigs);
  }
);

scenario(
  'Comet#assetList > accepts fully de-listed collateral (BCF = LCF = 0, 0 < LF <= MAX) for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator }, context) => {
    const { admin } = context.actors;
    await fundAccount(context.world, admin);

    // Every collateral stops counting toward borrowing and liquidation limits but can still be seized.
    // The borrow collateral factor goes to zero first, so the liquidate collateral factor can follow
    const assetConfigs = (await configurator.getAssetConfigs(comet.address)).map(assetConfig => ({
      ...assetConfig,
      borrowCollateralFactor: 0n,
      liquidateCollateralFactor: 0n,
    }));

    for (const assetConfig of assetConfigs) {
      await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, 0n);
      await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, assetConfig.asset, 0n);

      expect(assetConfig.liquidationFactor).to.be.greaterThan(0);
      expect(assetConfig.liquidationFactor).to.be.lessThanOrEqual(MAX_COLLATERAL_FACTOR);
    }

    await validateAssetInfos(context, assetConfigs);
  }
);

scenario(
  'Comet#assetList > accepts non-liquidatable collateral (BCF = LCF = LF = 0) for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator }, context) => {
    const { admin } = context.actors;
    await fundAccount(context.world, admin);

    // Every collateral has all three factors at zero, set from the lowest factor up
    const assetConfigs = (await configurator.getAssetConfigs(comet.address)).map(assetConfig => ({
      ...assetConfig,
      borrowCollateralFactor: 0n,
      liquidateCollateralFactor: 0n,
      liquidationFactor: 0n,
    }));

    for (const assetConfig of assetConfigs) {
      await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, 0n);
      await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, assetConfig.asset, 0n);
      await configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, assetConfig.asset, 0n);
    }

    await validateAssetInfos(context, assetConfigs);
  }
);

scenario(
  'Comet#assetList > accepts the current value again from each setter for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator }, context) => {
    const { admin } = context.actors;
    await fundAccount(context.world, admin);

    // The current factors are valid by definition, so writing each of them back must go through and change nothing
    const assetConfigs = await configurator.getAssetConfigs(comet.address);

    for (const { asset, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor } of assetConfigs) {
      await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, asset, borrowCollateralFactor);
      await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, asset, liquidateCollateralFactor);
      await configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, asset, liquidationFactor);
    }

    expect(await configurator.getAssetConfigs(comet.address)).to.deep.equal(assetConfigs);
    await validateAssetInfos(context, assetConfigs);
  }
);

/*//////////////////////////////////////////////////////////////
                          REVERT CASES
//////////////////////////////////////////////////////////////*/

// The asset list stores factors in full, so one wei past the neighbouring factor is already a break

scenario(
  'Comet#assetList > reverts on BCF above LCF for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, assetList }, context) => {
    const { admin } = context.actors;
    await fundAccount(context.world, admin);

    const assetConfigs = await configurator.getAssetConfigs(comet.address);

    // One collateral at a time gets a borrow collateral factor above its liquidate collateral factor
    for (const assetConfig of assetConfigs) {
      await expect(configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
        comet.address,
        assetConfig.asset,
        assetConfig.liquidateCollateralFactor.add(1)
      )).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
    }
  }
);

scenario(
  'Comet#assetList > reverts on LCF above LF for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, assetList }, context) => {
    const { admin } = context.actors;
    await fundAccount(context.world, admin);

    const assetConfigs = await configurator.getAssetConfigs(comet.address);

    // One collateral at a time gets a liquidate collateral factor above its liquidation factor
    for (const assetConfig of assetConfigs) {
      await expect(configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(
        comet.address,
        assetConfig.asset,
        assetConfig.liquidationFactor.add(1)
      )).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
    }
  }
);

scenario(
  'Comet#assetList > reverts on LF above MAX for each collateral',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, assetList }, context) => {
    const { admin } = context.actors;
    await fundAccount(context.world, admin);

    const assetConfigs = await configurator.getAssetConfigs(comet.address);

    // One collateral at a time gets a liquidation factor just above the maximum
    for (const assetConfig of assetConfigs) {
      await expect(configurator.connect(admin.signer).updateAssetLiquidationFactor(
        comet.address,
        assetConfig.asset,
        MAX_COLLATERAL_FACTOR + 1n
      )).to.be.revertedWithCustomError(assetList, 'LiqPenaltyTooHigh');
    }
  }
);

/*//////////////////////////////////////////////////////////////
                             ACCESS
//////////////////////////////////////////////////////////////*/
// The collateral factor setters of the asset list are for the Configurator only. Every call writes back the current
// factors of a usable collateral, which are valid, so a call can only fail on who makes it

scenario(
  'AssetList#collateralFactorSetters > revert when called directly by the governor',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, assetList, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor } = await comet.getAssetInfo(assetIndex);

    await expect(assetList.connect(admin.signer).setBorrowCollateralFactor(asset, borrowCollateralFactor))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
    await expect(assetList.connect(admin.signer).setLiquidateCollateralFactor(asset, liquidateCollateralFactor))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
    await expect(assetList.connect(admin.signer).setLiquidationFactor(asset, liquidationFactor))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
  }
);

scenario(
  'AssetList#collateralFactorSetters > revert when called directly by a random account',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, assetList, actors }, context) => {
    const { albert } = actors;
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor } = await comet.getAssetInfo(assetIndex);

    await expect(assetList.connect(albert.signer).setBorrowCollateralFactor(asset, borrowCollateralFactor))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
    await expect(assetList.connect(albert.signer).setLiquidateCollateralFactor(asset, liquidateCollateralFactor))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
    await expect(assetList.connect(albert.signer).setLiquidationFactor(asset, liquidationFactor))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
  }
);

scenario(
  'AssetList#collateralFactorSetters > revert when called directly by the proxy admin, which never reaches the implementation',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, assetList, proxyAdmin }, context) => {
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor } = await comet.getAssetInfo(assetIndex);
    const proxyAdminSigner = await context.world.impersonateAddress(proxyAdmin.address);
    await fundAccount(context.world, proxyAdminSigner);
    const adminFallbackError = 'TransparentUpgradeableProxy: admin cannot fallback to proxy target';

    await expect(assetList.connect(proxyAdminSigner).setBorrowCollateralFactor(asset, borrowCollateralFactor))
      .to.be.revertedWith(adminFallbackError);
    await expect(assetList.connect(proxyAdminSigner).setLiquidateCollateralFactor(asset, liquidateCollateralFactor))
      .to.be.revertedWith(adminFallbackError);
    await expect(assetList.connect(proxyAdminSigner).setLiquidationFactor(asset, liquidationFactor))
      .to.be.revertedWith(adminFallbackError);
  }
);

// The configurator is set in the storage of the proxy by initialize, so the implementation has none of its own
scenario(
  'AssetList#collateralFactorSetters > revert when the configurator calls the implementation instead of the proxy',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, assetList, proxyAdmin }, context) => {
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor } = await comet.getAssetInfo(assetIndex);
    const implementation = assetList.attach(await proxyAdmin.getProxyImplementation(assetList.address));
    const configuratorSigner = await context.world.impersonateAddress(configurator.address);
    await fundAccount(context.world, configuratorSigner);

    await expect(implementation.connect(configuratorSigner).setBorrowCollateralFactor(asset, borrowCollateralFactor))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
    await expect(implementation.connect(configuratorSigner).setLiquidateCollateralFactor(asset, liquidateCollateralFactor))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
    await expect(implementation.connect(configuratorSigner).setLiquidationFactor(asset, liquidationFactor))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
  }
);
