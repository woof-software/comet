import { scenario } from './context/CometContext';
import { CometContext } from './context/CometContext';
import { AssetList, AssetListFactory } from '../build/types';
import { AssetConfigStruct } from '../build/types/AssetList';
import { expect } from 'chai';
import { supportsExtendedPause } from './utils';

// The highest liquidation factor the asset list accepts: a factor of one
const MAX_COLLATERAL_FACTOR = 10n ** 18n;

// The smallest factor difference the asset list can store: one unit of the fourth decimal digit.
// Revert cases move the broken factor a full step past its neighbour, so the break survives the asset list's rounding.
const PRECISION_STEP = 10n ** 14n;

// Reads the asset configs the market runs on, so every case below is derived from the market itself
async function getAssetConfigs(context: CometContext): Promise<AssetConfigStruct[]> {
  const comet = await context.getComet();
  const configurator = await context.getConfigurator();
  const { assetConfigs } = await configurator.getConfiguration(comet.address);

  return assetConfigs.map(({ asset, priceFeed, decimals, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor, supplyCap }) => ({
    asset, priceFeed, decimals, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor, supplyCap,
  }));
}

// The factory the market's own asset list came from
async function getAssetListFactory(context: CometContext): Promise<AssetListFactory> {
  const ethers = context.world.deploymentManager.hre.ethers;
  const comet = await context.getComet();
  const cometExt = await ethers.getContractAt('CometExtAssetList', comet.address);
  return await ethers.getContractAt('AssetListFactory', await cometExt.assetListFactory()) as AssetListFactory;
}

// Deploys a new asset list from the given configs through the market's factory
async function createAssetList(context: CometContext, assetConfigs: AssetConfigStruct[]): Promise<AssetList> {
  const ethers = context.world.deploymentManager.hre.ethers;
  const assetListFactory = await getAssetListFactory(context);
  const assetListAddress = await assetListFactory.callStatic.createAssetList(assetConfigs);
  await assetListFactory.createAssetList(assetConfigs);
  return await ethers.getContractAt('AssetList', assetListAddress) as AssetList;
}

// Every collateral of the asset list must read back exactly as it was configured
async function validateAssetInfos(assetList: AssetList, assetConfigs: AssetConfigStruct[]) {
  expect(await assetList.numAssets()).to.equal(assetConfigs.length);

  for (let i = 0; i < assetConfigs.length; i++) {
    const assetInfo = await assetList.getAssetInfo(i);
    expect(assetInfo.asset).to.equal(assetConfigs[i].asset);
    expect(assetInfo.priceFeed).to.equal(assetConfigs[i].priceFeed);
    expect(assetInfo.borrowCollateralFactor).to.equal(assetConfigs[i].borrowCollateralFactor);
    expect(assetInfo.liquidateCollateralFactor).to.equal(assetConfigs[i].liquidateCollateralFactor);
    expect(assetInfo.liquidationFactor).to.equal(assetConfigs[i].liquidationFactor);
  }
}

const toBigInt = (value): bigint => BigInt(value.toString());

/*//////////////////////////////////////////////////////////////
                        COLLATERAL FACTORS
//////////////////////////////////////////////////////////////*/

/*//////////////////////////////////////////////////////////////
                          HAPPY CASES
//////////////////////////////////////////////////////////////*/

scenario(
  'Comet#assetList > accepts active collateral (0 < BCF < LCF < LF <= MAX) for each collateral',
  { filter: async (ctx: CometContext) => await supportsExtendedPause(ctx) },
  async (_properties, context) => {
    // The market's own factors are an active setup
    const assetConfigs = await getAssetConfigs(context);

    for (const assetConfig of assetConfigs) {
      const collateralBCF = toBigInt(assetConfig.borrowCollateralFactor);
      const collateralLCF = toBigInt(assetConfig.liquidateCollateralFactor);
      const collateralLF = toBigInt(assetConfig.liquidationFactor);

      expect(collateralBCF > 0n).to.be.true;
      expect(collateralBCF < collateralLCF).to.be.true;
      expect(collateralLCF < collateralLF).to.be.true;
      expect(collateralLF <= MAX_COLLATERAL_FACTOR).to.be.true;
    }

    const assetList = await createAssetList(context, assetConfigs);
    await validateAssetInfos(assetList, assetConfigs);
  }
);

scenario(
  'Comet#assetList > accepts soft de-listed collateral (BCF = 0, 0 < LCF < LF <= MAX) for each collateral',
  { filter: async (ctx: CometContext) => await supportsExtendedPause(ctx) },
  async (_properties, context) => {
    // Every collateral stops backing new borrows but keeps its liquidation factors
    const assetConfigs = (await getAssetConfigs(context)).map(assetConfig => ({
      ...assetConfig,
      borrowCollateralFactor: 0n,
    }));

    for (const assetConfig of assetConfigs) {
      const collateralBCF = toBigInt(assetConfig.borrowCollateralFactor);
      const collateralLCF = toBigInt(assetConfig.liquidateCollateralFactor);
      const collateralLF = toBigInt(assetConfig.liquidationFactor);

      expect(collateralBCF).to.equal(0n);
      expect(collateralLCF > 0n).to.be.true;
      expect(collateralLCF < collateralLF).to.be.true;
      expect(collateralLF <= MAX_COLLATERAL_FACTOR).to.be.true;
    }

    const assetList = await createAssetList(context, assetConfigs);
    await validateAssetInfos(assetList, assetConfigs);
  }
);

scenario(
  'Comet#assetList > accepts fully de-listed collateral (BCF = LCF = 0, 0 < LF <= MAX) for each collateral',
  { filter: async (ctx: CometContext) => await supportsExtendedPause(ctx) },
  async (_properties, context) => {
    // Every collateral stops counting toward borrowing and liquidation limits but can still be seized
    const assetConfigs = (await getAssetConfigs(context)).map(assetConfig => ({
      ...assetConfig,
      borrowCollateralFactor: 0n,
      liquidateCollateralFactor: 0n,
    }));

    for (const assetConfig of assetConfigs) {
      const collateralBCF = toBigInt(assetConfig.borrowCollateralFactor);
      const collateralLCF = toBigInt(assetConfig.liquidateCollateralFactor);
      const collateralLF = toBigInt(assetConfig.liquidationFactor);

      expect(collateralBCF).to.equal(0n);
      expect(collateralLCF).to.equal(0n);
      expect(collateralLF > 0n).to.be.true;
      expect(collateralLF <= MAX_COLLATERAL_FACTOR).to.be.true;
    }

    const assetList = await createAssetList(context, assetConfigs);
    await validateAssetInfos(assetList, assetConfigs);
  }
);

scenario(
  'Comet#assetList > accepts non-liquidatable collateral (BCF = LCF = LF = 0) for each collateral',
  { filter: async (ctx: CometContext) => await supportsExtendedPause(ctx) },
  async (_properties, context) => {
    // Every collateral has all three factors at zero
    const assetConfigs = (await getAssetConfigs(context)).map(assetConfig => ({
      ...assetConfig,
      borrowCollateralFactor: 0n,
      liquidateCollateralFactor: 0n,
      liquidationFactor: 0n,
    }));

    for (const assetConfig of assetConfigs) {
      expect(toBigInt(assetConfig.borrowCollateralFactor)).to.equal(0n);
      expect(toBigInt(assetConfig.liquidateCollateralFactor)).to.equal(0n);
      expect(toBigInt(assetConfig.liquidationFactor)).to.equal(0n);
    }

    const assetList = await createAssetList(context, assetConfigs);
    await validateAssetInfos(assetList, assetConfigs);
  }
);

/*//////////////////////////////////////////////////////////////
                          REVERT CASES
//////////////////////////////////////////////////////////////*/

scenario(
  'Comet#assetList > reverts on BCF above LCF for each collateral',
  { filter: async (ctx: CometContext) => await supportsExtendedPause(ctx) },
  async (_properties, context) => {
    // The comet declares the factor errors the asset list reverts with
    const comet = await context.getComet();
    const assetConfigs = await getAssetConfigs(context);
    const assetListFactory = await getAssetListFactory(context);

    // The unchanged market configs are accepted, so any revert below comes from the broken collateral
    await assetListFactory.callStatic.createAssetList(assetConfigs);

    // One collateral at a time gets a borrow collateral factor above its liquidate collateral factor,
    // while every other collateral keeps its valid config
    for (let i = 0; i < assetConfigs.length; i++) {
      const brokenConfigs = assetConfigs.map((assetConfig, j) => (j !== i ? assetConfig : {
        ...assetConfig,
        borrowCollateralFactor: toBigInt(assetConfig.liquidateCollateralFactor) + PRECISION_STEP,
      }));

      await expect(assetListFactory.createAssetList(brokenConfigs)).to.be.revertedWithCustomError(comet, 'BorrowCFTooLarge');
    }
  }
);

scenario(
  'Comet#assetList > reverts on LCF above LF for each collateral',
  { filter: async (ctx: CometContext) => await supportsExtendedPause(ctx) },
  async (_properties, context) => {
    // The comet declares the factor errors the asset list reverts with
    const comet = await context.getComet();
    const assetConfigs = await getAssetConfigs(context);
    const assetListFactory = await getAssetListFactory(context);

    // The unchanged market configs are accepted, so any revert below comes from the broken collateral
    await assetListFactory.callStatic.createAssetList(assetConfigs);

    // One collateral at a time gets a liquidate collateral factor above its liquidation factor,
    // while every other collateral keeps its valid config
    for (let i = 0; i < assetConfigs.length; i++) {
      const brokenConfigs = assetConfigs.map((assetConfig, j) => (j !== i ? assetConfig : {
        ...assetConfig,
        liquidateCollateralFactor: toBigInt(assetConfig.liquidationFactor) + PRECISION_STEP,
      }));

      await expect(assetListFactory.createAssetList(brokenConfigs)).to.be.revertedWithCustomError(comet, 'LiquidateCFTooLarge');
    }
  }
);

scenario(
  'Comet#assetList > reverts on LF above MAX for each collateral',
  { filter: async (ctx: CometContext) => await supportsExtendedPause(ctx) },
  async (_properties, context) => {
    // The comet declares the factor errors the asset list reverts with
    const comet = await context.getComet();
    const assetConfigs = await getAssetConfigs(context);
    const assetListFactory = await getAssetListFactory(context);

    // The unchanged market configs are accepted, so any revert below comes from the broken collateral
    await assetListFactory.callStatic.createAssetList(assetConfigs);

    // One collateral at a time gets a liquidation factor just above the maximum,
    // while every other collateral keeps its valid config
    for (let i = 0; i < assetConfigs.length; i++) {
      const brokenConfigs = assetConfigs.map((assetConfig, j) => (j !== i ? assetConfig : {
        ...assetConfig,
        liquidationFactor: MAX_COLLATERAL_FACTOR + 1n,
      }));

      await expect(assetListFactory.createAssetList(brokenConfigs)).to.be.revertedWithCustomError(comet, 'LiqPenaltyTooHigh');
    }
  }
);
