import { expect } from 'chai';
import { CometContext, scenario } from './context/CometContext';
import {
  MAX_ASSETS,
  deployMockERC20,
  deployPriceFeed,
  executeProposal,
  fundAccount,
  getUsableCollateralIndices,
  matchesDeployment,
  servicePatch2,
} from './utils';
import { CometProxyAdminOptimism, MarketAdminPermissionChecker } from '../build/types';
import { AssetConfigStruct } from '../build/types/Configurator';
import { calldata } from '../src/deploy';
import { exp } from '../test/helpers';

// The governor changes the immutables and upgrades the list in one proposal: the new implementation holds them.
// A factor change after that goes straight to the list proxy storage, with no redeploy
scenario(
  'AssetList governance > governor updates immutables with a redeploy, then a factor with no redeploy',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx),
  },
  async ({ comet, configurator, proxyAdmin, assetList, bridgeReceiver }, context) => {
    const numAssets = await assetList.numAssets();

    // sanity check: the governor owns the proxy admin, so its proposal is the one that upgrades the list
    expect(await proxyAdmin.owner()).to.equal(await comet.governor());

    // We have 2 options to change the immutables:
    // 1. Add a new asset
    // 2. Update price feed for existed asset
    // If the asset list is full, we can only update the price feed for existed asset
    if (numAssets < MAX_ASSETS) {
      const newAssetConfig: AssetConfigStruct = {
        asset: await deployMockERC20(context, 'governorAsset'),
        priceFeed: await deployPriceFeed(context, 'governorAsset'),
        borrowCollateralFactor: exp(0.75, 18),
        liquidateCollateralFactor: exp(0.8, 18),
        liquidationFactor: exp(0.9, 18),
        supplyCap: exp(1000, 18),
      };

      await executeProposal(
        context,
        bridgeReceiver,
        [configurator.address, proxyAdmin.address],
        ['addAsset(address,(address,address,uint64,uint64,uint64,uint128))', 'deployAndUpgradeTo(address,address)'],
        [
          await calldata(configurator.populateTransaction.addAsset(comet.address, newAssetConfig)),
          await calldata(proxyAdmin.populateTransaction.deployAndUpgradeTo(configurator.address, comet.address)),
        ]
      );

      const assetInfo = await assetList.getAssetInfo(numAssets);
      expect(await assetList.numAssets()).to.equal(numAssets + 1);
      expect(assetInfo.asset).to.equal(newAssetConfig.asset);
      expect(assetInfo.priceFeed).to.equal(newAssetConfig.priceFeed);
      expect(assetInfo.scale).to.equal(exp(1, 18));
      expect(assetInfo.borrowCollateralFactor).to.equal(newAssetConfig.borrowCollateralFactor);
      expect(assetInfo.liquidateCollateralFactor).to.equal(newAssetConfig.liquidateCollateralFactor);
      expect(assetInfo.liquidationFactor).to.equal(newAssetConfig.liquidationFactor);
      expect(assetInfo.supplyCap).to.equal(newAssetConfig.supplyCap);
      expect(await assetList.getAssetInfoByAddress(newAssetConfig.asset)).to.deep.equal(assetInfo);
    } else {
      const assetIndex = numAssets - 1;
      const { asset } = await assetList.getAssetInfo(assetIndex);
      const newPriceFeed = await deployPriceFeed(context, 'governorPriceFeed');

      await executeProposal(
        context,
        bridgeReceiver,
        [configurator.address, proxyAdmin.address],
        ['updateAssetPriceFeed(address,address,address)', 'deployAndUpgradeTo(address,address)'],
        [
          await calldata(configurator.populateTransaction.updateAssetPriceFeed(comet.address, asset, newPriceFeed)),
          await calldata(proxyAdmin.populateTransaction.deployAndUpgradeTo(configurator.address, comet.address)),
        ]
      );

      expect((await assetList.getAssetInfo(assetIndex)).priceFeed).to.equal(newPriceFeed);
    }

    // A usable collateral gets its BCF set to 0; with none, the last asset gets its LF set to 1
    const [usableIndex] = await getUsableCollateralIndices(context, 1);
    if (usableIndex !== undefined) {
      const { asset } = await assetList.getAssetInfo(usableIndex);

      await executeProposal(
        context,
        bridgeReceiver,
        [configurator.address],
        ['updateAssetBorrowCollateralFactor(address,address,uint64)'],
        [await calldata(configurator.populateTransaction.updateAssetBorrowCollateralFactor(comet.address, asset, 0))]
      );

      expect((await assetList.getAssetInfo(usableIndex)).borrowCollateralFactor).to.equal(0);
    } else {
      const NEW_LIQUIDATION_FACTOR = exp(1, 18);
      const assetIndex = (await assetList.numAssets()) - 1;
      const { asset } = await assetList.getAssetInfo(assetIndex);

      await executeProposal(
        context,
        bridgeReceiver,
        [configurator.address],
        ['updateAssetLiquidationFactor(address,address,uint64)'],
        [await calldata(configurator.populateTransaction.updateAssetLiquidationFactor(comet.address, asset, NEW_LIQUIDATION_FACTOR))]
      );

      expect((await assetList.getAssetInfo(assetIndex)).liquidationFactor).to.equal(NEW_LIQUIDATION_FACTOR);
    }

    console.log('AAAAAAA');
  }
);

// Only the governor can change the immutables. Once they are changed, the market admin can upgrade the list and the
// Comet to hold them, and change the factors. The market admin exists on Optimism only
scenario(
  'AssetList governance > market admin redeploys the list for immutables updated by governor, then updates a factor',
  {
    filter: async (ctx: CometContext) =>
      await servicePatch2(ctx) && matchesDeployment(ctx, [{ network: 'optimism' }]),
  },
  async ({ comet, configurator, proxyAdmin, assetList, bridgeReceiver }, context) => {
    const ethers = context.world.deploymentManager.hre.ethers;
    const proxyAdminOptimism = await ethers.getContractAt('CometProxyAdminOptimism', proxyAdmin.address) as CometProxyAdminOptimism;
    const marketAdminPermissionChecker = await ethers.getContractAt(
      'MarketAdminPermissionChecker',
      await proxyAdminOptimism.marketAdminPermissionChecker()
    ) as MarketAdminPermissionChecker;
    const marketAdmin = await context.world.impersonateAddress(await marketAdminPermissionChecker.marketAdmin());
    await fundAccount(context.world, marketAdmin);
    const numAssets = await assetList.numAssets();

    // sanity check: the market admin is not the owner, so the upgrade passes on its market admin permission
    expect(marketAdmin.address).to.not.equal(await proxyAdmin.owner());

    // We have 2 options to change the immutables:
    // 1. Add a new asset
    // 2. Update price feed for existed asset
    // If the asset list is full, we can only update the price feed for existed asset
    if (numAssets < MAX_ASSETS) {
      const newAssetConfig: AssetConfigStruct = {
        asset: await deployMockERC20(context, 'marketAdminAsset'),
        priceFeed: await deployPriceFeed(context, 'marketAdminAsset'),
        borrowCollateralFactor: exp(0.75, 18),
        liquidateCollateralFactor: exp(0.8, 18),
        liquidationFactor: exp(0.9, 18),
        supplyCap: exp(1000, 18),
      };

      await executeProposal(
        context,
        bridgeReceiver,
        [configurator.address],
        ['addAsset(address,(address,address,uint64,uint64,uint64,uint128))'],
        [await calldata(configurator.populateTransaction.addAsset(comet.address, newAssetConfig))]
      );
      await proxyAdmin.connect(marketAdmin).deployAndUpgradeTo(configurator.address, comet.address);

      const assetInfo = await assetList.getAssetInfo(numAssets);
      expect(await assetList.numAssets()).to.equal(numAssets + 1);
      expect(assetInfo.asset).to.equal(newAssetConfig.asset);
      expect(assetInfo.priceFeed).to.equal(newAssetConfig.priceFeed);
      expect(assetInfo.scale).to.equal(exp(1, 18));
      expect(assetInfo.borrowCollateralFactor).to.equal(newAssetConfig.borrowCollateralFactor);
      expect(assetInfo.liquidateCollateralFactor).to.equal(newAssetConfig.liquidateCollateralFactor);
      expect(assetInfo.liquidationFactor).to.equal(newAssetConfig.liquidationFactor);
      expect(assetInfo.supplyCap).to.equal(newAssetConfig.supplyCap);
      expect(await assetList.getAssetInfoByAddress(newAssetConfig.asset)).to.deep.equal(assetInfo);
    } else {
      const assetIndex = numAssets - 1;
      const { asset } = await assetList.getAssetInfo(assetIndex);
      const newPriceFeed = await deployPriceFeed(context, 'marketAdminPriceFeed');

      await executeProposal(
        context,
        bridgeReceiver,
        [configurator.address],
        ['updateAssetPriceFeed(address,address,address)'],
        [await calldata(configurator.populateTransaction.updateAssetPriceFeed(comet.address, asset, newPriceFeed))]
      );
      await proxyAdmin.connect(marketAdmin).deployAndUpgradeTo(configurator.address, comet.address);

      expect((await assetList.getAssetInfo(assetIndex)).priceFeed).to.equal(newPriceFeed);
    }

    // A usable collateral gets its BCF set to 0; with none, the last asset gets its LF set to 1
    const [usableIndex] = await getUsableCollateralIndices(context, 1);
    if (usableIndex !== undefined) {
      const { asset } = await assetList.getAssetInfo(usableIndex);

      await configurator.connect(marketAdmin).updateAssetBorrowCollateralFactor(comet.address, asset, 0);

      expect((await assetList.getAssetInfo(usableIndex)).borrowCollateralFactor).to.equal(0);
    } else {
      const NEW_LIQUIDATION_FACTOR = exp(1, 18);
      const assetIndex = (await assetList.numAssets()) - 1;
      const { asset } = await assetList.getAssetInfo(assetIndex);

      await configurator.connect(marketAdmin).updateAssetLiquidationFactor(comet.address, asset, NEW_LIQUIDATION_FACTOR);

      expect((await assetList.getAssetInfo(assetIndex)).liquidationFactor).to.equal(NEW_LIQUIDATION_FACTOR);
    }
  }
);
