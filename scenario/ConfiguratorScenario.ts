import { scenario } from './context/CometContext';
import { fundAccount, getUsableCollateralIndices, hasModule, MAX_ASSETS } from './utils';
import { expect } from 'chai';
import { constants } from 'ethers';
import { LiquidationModule__factory } from '../build/types';

scenario('upgrade governor', {}, async ({ comet, configurator, timelock, actors }, context, world) => {
  const { admin, albert } = actors;
  await fundAccount(world, admin);

  expect(await comet.governor()).to.equal(timelock.address);
  expect((await configurator.getConfiguration(comet.address)).governor).to.equal(timelock.address);

  await configurator.connect(admin.signer).setGovernor(comet.address, albert.address);

  // The upgrade builds a new Comet implementation, whose constructor claims a liquidation module, and a
  // module can only be claimed once. The one behind this proxy is taken, so the market gets a new one.
  await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
  await admin.deployAndUpgradeTo(configurator.address, comet.address);

  expect(await comet.governor()).to.equal(albert.address);
  expect((await configurator.getConfiguration(comet.address)).governor).to.be.equal(albert.address);
});

scenario(
  'add assets',
  {
    // A Comet holds at most MAX_ASSETS collaterals, so a market already at the limit has no room for
    // the one this scenario adds.
    filter: async (ctx) => (await getUsableCollateralIndices(ctx)).length < MAX_ASSETS,
  },
  async ({ comet, configurator, actors }, context, world) => {
    const { admin } = actors;
    await fundAccount(world, admin);
    let numAssets = await comet.numAssets();
    const collateralAssets = await Promise.all(Array(numAssets).fill(0).map((_, i) => comet.getAssetInfo(i)));
    const contextAssets = Object.values(collateralAssets).map((asset) => asset.asset); // grab asset address
    expect(collateralAssets.map(a => a.asset)).to.have.members(contextAssets);

    // Add new asset and deploy + upgrade
    const newAsset = await comet.getAssetInfo(0);
    const newAssetDecimals = Math.log10(Number(newAsset.scale.toString()));
    const newAssetConfig = {
      asset: newAsset.asset,
      priceFeed: newAsset.priceFeed,
      decimals: newAssetDecimals.toString(),
      borrowCollateralFactor: (0.8e18).toString(),
      liquidateCollateralFactor: (0.9e18).toString(),
      liquidationFactor: (0.95e18).toString(),
      supplyCap: (1000000e8).toString(),
    };
    await configurator.connect(admin.signer).addAsset(comet.address, newAssetConfig);

    // A new implementation needs a module of its own; the one in place has already been claimed.
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    // Verify new asset is added
    numAssets = await comet.numAssets();
    const updatedCollateralAssets = await Promise.all(Array(numAssets).fill(0).map((_, i) => comet.getAssetInfo(i)));
    const updatedContextAssets = Object.values(updatedCollateralAssets).map((asset) => asset.asset); // grab asset address
    expect(updatedCollateralAssets.length).to.equal(collateralAssets.length + 1);
    expect(updatedCollateralAssets.map(a => a.asset)).to.have.members(updatedContextAssets);
  });

scenario(
  'reverts if configurator is not called by admin',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;
    await expect(configurator.connect(albert.signer).setGovernor(comet.address, albert.address))
      .to.be.revertedWithCustomError(configurator, 'Unauthorized');
  });

scenario.skip('reverts if proxy is not upgraded by ProxyAdmin', {}, async () => {
  // XXX
});


scenario.skip('fallbacks to implementation if called by non-admin', {}, async () => {
  // XXX
});

scenario.skip('transfer admin of configurator', {}, async () => {
  // XXX
});

/*//////////////////////////////////////////////////////////////
                        LIQUIDATION MODULE
//////////////////////////////////////////////////////////////*/

scenario(
  'liquidation module can be updated',
  { filter: async (context) => await hasModule(context) },
  async ({ comet, configurator, actors }, _context, world) => {
    const { admin, albert, betty, charles } = actors;
    const scenarioEthers = world.deploymentManager.hre.ethers;
    const [deployer] = await scenarioEthers.getSigners();
    await Promise.all([deployer, admin].map((account) => fundAccount(world, account)));

    const configurationBefore = await configurator.getConfiguration(comet.address);
    const liquidationModuleBefore = LiquidationModule__factory.connect(
      configurationBefore.liquidationModule,
      scenarioEthers.provider
    );
    const LiquidationModuleFactory = (await scenarioEthers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
    const liquidationModule = await LiquidationModuleFactory.deploy(
      await liquidationModuleBefore.dexAdapter(),
      betty.address,
      [albert.address],
      [charles.address],
      await liquidationModuleBefore.incentiveBps()
    );
    await liquidationModule.deployed();

    await configurator.connect(admin.signer).setLiquidationModule(comet.address, liquidationModule.address);

    expect((await configurator.getConfiguration(comet.address)).liquidationModule).to.equal(liquidationModule.address);
  }
);

scenario(
  'reverts when a non-governor updates the liquidation module',
  { filter: async (context) => await hasModule(context) },
  async ({ comet, configurator, actors }) => {
    const { albert, betty } = actors;

    await expect(configurator.connect(albert.signer).setLiquidationModule(comet.address, betty.address))
      .to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'reverts when liquidation module is set to the zero address',
  { filter: async (context) => await hasModule(context) },
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    await expect(configurator.connect(admin.signer).setLiquidationModule(comet.address, constants.AddressZero))
      .to.be.revertedWithCustomError(configurator, 'InvalidAddress');
  }
);

scenario(
  'setConfiguration allows a zero liquidation module and reverts on comet during deployment',
  { filter: async (context) => await hasModule(context) },
  async ({ comet, configurator, actors }, _context, world) => {
    const { admin } = actors;
    await fundAccount(world, admin);
    const existingConfiguration = await configurator.getConfiguration(comet.address);
    const existingLiquidationModule = await comet.liquidationModule();
    const configurationWithZeroLiquidationModule = {
      ...existingConfiguration,
      liquidationModule: constants.AddressZero,
    };

    await configurator.connect(admin.signer).setConfiguration(comet.address, configurationWithZeroLiquidationModule);

    expect((await configurator.getConfiguration(comet.address)).liquidationModule).to.equal(constants.AddressZero);
    expect(await comet.liquidationModule()).to.equal(existingLiquidationModule);

    // guard on comet against zero liquidation module
    await expect(configurator.connect(admin.signer)['deploy(address)'](comet.address))
      .to.be.revertedWithCustomError(comet, 'ZeroAddress');
  }
);
