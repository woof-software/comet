import { expect } from 'chai';
import { constants, utils } from 'ethers';
import { CometContext, CometProperties, scenario } from '../context/CometContext';
import { MAX_ASSETS, executeProposal, fundAccount, servicePatch2 } from '../utils';
import { getConfigForScenario } from '../utils/scenarioHelper';
import { isAssetListMigrationRequired } from '../utils/versionControl';
import CometActor from '../context/CometActor';
import { AssetList, CometWithExtendedAssetList, FaucetToken } from '../../build/types';
import { AssetInfoStructOutput } from '../../build/types/CometInterface';
import { calldata } from '../../src/deploy';
import { exp } from '../../test/helpers';
import { hashConfig } from '../../test/asset-list/shared';
import { deployMockERC20, deployPriceFeed } from '../configurator/shared';

// EIP-1967 implementation and admin slots of a proxy
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const ASSET_INFO_KEYS = [
  'offset', 'asset', 'priceFeed', 'scale', 'borrowCollateralFactor', 'liquidateCollateralFactor', 'liquidationFactor', 'supplyCap',
];

// What a proposal that leaves the asset list alone must not change: the list itself, every asset the Comet reads from
// it, the market totals and the positions of the actors. Positions are read as stored, so accrued interest does not count.
// numAssets limits the read to the first assets, so the assets of before can be compared after a new one is added
async function snapshotMarket(context: CometContext, { comet, actors }: CometProperties, numAssets?: number) {
  const ethers = context.world.deploymentManager.hre.ethers;
  const assetListAddress = await (comet as unknown as CometWithExtendedAssetList).assetList();
  const assetList = (await ethers.getContractAt('AssetList', assetListAddress)) as AssetList;
  numAssets = numAssets ?? await comet.numAssets();
  const assetInfos = await Promise.all([...Array(numAssets).keys()].map((i) => comet.getAssetInfo(i)));
  const assets = assetInfos.map(({ asset }) => asset);
  const accounts = [actors.albert.address, actors.betty.address];

  return {
    assetList: assetListAddress,
    assetListImplementation: utils.getAddress(
      utils.hexDataSlice(await ethers.provider.getStorageAt(assetListAddress, IMPLEMENTATION_SLOT), 12)
    ),
    configHash: await assetList.configHash(),
    numAssets,
    assetInfos,
    totalsBasic: await comet.totalsBasic(),
    totalsCollateral: await Promise.all(assets.map((asset) => comet.totalsCollateral(asset))),
    userBasic: await Promise.all(accounts.map((account) => comet.userBasic(account))),
    userCollateral: await Promise.all(
      accounts.flatMap((account) => assets.map((asset) => comet.userCollateral(account, asset)))
    ),
    liquidity: await Promise.all(
      accounts.map(async (account) => [await comet.isBorrowCollateralized(account), await comet.isLiquidatable(account)])
    ),
  };
}

// The asset a scenario changes: the first one that is not delisted, so it can still back a borrow
async function firstListedAssetIndex({ comet }: CometProperties): Promise<number> {
  const numAssets = await comet.numAssets();
  for (let i = 0; i < numAssets; i++) {
    if ((await comet.getAssetInfo(i)).borrowCollateralFactor.gt(0)) return i;
  }
  throw new Error('The market has no listed asset');
}

// The actor borrows the minimum against twice the collateral it needs, in the given asset; the base to lend comes from
// the supply the scenario requires
async function borrowAgainst(context: CometContext, { comet }: CometProperties, actor: CometActor, assetIndex: number) {
  const { asset, priceFeed, scale, borrowCollateralFactor } = await comet.getAssetInfo(assetIndex);
  const borrowAmount = (await comet.baseBorrowMin()).toBigInt();
  const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
  const collateralAmount = 2n * borrowAmount * basePrice * scale.toBigInt() * 10n ** 18n /
    ((await comet.baseScale()).toBigInt() * (await comet.getPrice(priceFeed)).toBigInt() * borrowCollateralFactor.toBigInt());

  const collateral = context.getAssetByAddress(asset);
  await context.sourceTokens(collateralAmount, collateral, actor);
  await collateral.approve(actor, comet.address);
  await actor.safeSupplyAsset({ asset, amount: collateralAmount });
  await actor.withdrawAsset({ asset: await comet.baseToken(), amount: borrowAmount });
}

// Every field of every asset except the given ones of the given asset
function expectAssetInfosEqualExcept(actual: AssetInfoStructOutput[], expected: AssetInfoStructOutput[], index: number, keys: string[]) {
  expect(actual.length).to.equal(expected.length);
  expected.forEach((assetInfo, i) => {
    for (const field of ASSET_INFO_KEYS.filter((field) => i !== index || !keys.includes(field))) {
      expect(actual[i][field], `${field} of asset ${i}`).to.equal(assetInfo[field]);
    }
  });
}

scenario(
  'AssetList governance > change a Comet parameter, asset list unchanged',
  {
    filter: async (ctx: CometContext) => !(await isAssetListMigrationRequired(ctx)),
    cometBalances: async (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).supplyBase },
      betty: { $asset0: getConfigForScenario(ctx).supplyCollateral },
    }),
  },
  async (properties, context) => {
    const { comet, configurator, proxyAdmin } = properties;

    const kinkBefore = (await comet.borrowKink()).toBigInt();
    const newKink = kinkBefore * 9n / 10n;
    const cometImplementationBefore = await proxyAdmin.getProxyImplementation(comet.address);
    const before = await snapshotMarket(context, properties);

    // The asset configs in the Configurator match the list, so no new list is needed
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(constants.AddressZero);

    const ethers = context.world.deploymentManager.hre.ethers;
    const fromBlock = await ethers.provider.getBlockNumber();
    await executeProposal(
      context,
      properties.bridgeReceiver,
      [configurator.address, proxyAdmin.address],
      ['setBorrowKink(address,uint64)', 'deployAndUpgradeTo(address,address)'],
      [
        await calldata(configurator.populateTransaction.setBorrowKink(comet.address, newKink)),
        await calldata(proxyAdmin.populateTransaction.deployAndUpgradeTo(configurator.address, comet.address)),
      ]
    );

    const after = await snapshotMarket(context, properties);

    expect(await comet.borrowKink()).to.equal(newKink);
    expect(await proxyAdmin.getProxyImplementation(comet.address)).to.not.equal(cometImplementationBefore);

    expect(after.assetList).to.equal(before.assetList);
    expect(after.assetListImplementation).to.equal(before.assetListImplementation);
    expect(after.configHash).to.equal(before.configHash);

    // With no new implementation the proxy admin does not call the list proxy at all, so it emits no Upgraded
    const listUpgrades = await ethers.provider.getLogs({
      address: before.assetList,
      topics: [utils.id('Upgraded(address)')],
      fromBlock: fromBlock + 1,
    });
    expect(listUpgrades).to.be.empty;

    expect(after.numAssets).to.equal(before.numAssets);
    expect(after.assetInfos).to.deep.equal(before.assetInfos);

    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(constants.AddressZero);

    expect(after.totalsBasic).to.deep.equal(before.totalsBasic);
    expect(after.totalsCollateral).to.deep.equal(before.totalsCollateral);
    expect(after.userBasic).to.deep.equal(before.userBasic);
    expect(after.userCollateral).to.deep.equal(before.userCollateral);
  }
);

scenario(
  'AssetList governance > change a price feed, asset list upgraded',
  {
    filter: async (ctx: CometContext) => !(await isAssetListMigrationRequired(ctx)),
    cometBalances: async (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).supplyBase },
    }),
  },
  async (properties, context) => {
    const { comet, configurator, proxyAdmin, actors } = properties;
    const { albert, betty } = actors;
    const ethers = context.world.deploymentManager.hre.ethers;
    const assetIndex = await firstListedAssetIndex(properties);
    const { asset, priceFeed: oldFeed } = await comet.getAssetInfo(assetIndex);
    const oldPrice = (await comet.getPrice(oldFeed)).toBigInt();

    // The borrow rests on the asset whose feed changes
    await borrowAgainst(context, properties, betty, assetIndex);

    const assetList = (await ethers.getContractAt(
      'AssetList',
      await (comet as unknown as CometWithExtendedAssetList).assetList()
    )) as AssetList;
    const cometImplementationBefore = await proxyAdmin.getProxyImplementation(comet.address);
    const before = await snapshotMarket(context, properties);
    const pricesBefore = await Promise.all(before.assetInfos.map(({ priceFeed }) => comet.getPrice(priceFeed)));

    // Same price as the current feed, so no position is affected
    const newFeed = (await context.world.deploymentManager.deploy(
      'assetListScenario:priceFeed',
      'pricefeeds/ConstantPriceFeed.sol',
      [8, oldPrice],
      true
    )).address;

    await executeProposal(
      context,
      properties.bridgeReceiver,
      [configurator.address],
      ['updateAssetPriceFeed(address,address,address)'],
      [await calldata(configurator.populateTransaction.updateAssetPriceFeed(comet.address, asset, newFeed))]
    );

    expect((await configurator.getAssetConfigs(comet.address))[assetIndex].priceFeed).to.equal(newFeed);
    expect((await assetList.getAssetInfo(assetIndex)).priceFeed).to.equal(oldFeed);
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.not.equal(constants.AddressZero);

    // Anyone may deploy the new implementation
    await fundAccount(context.world, albert);
    const receipt = await (await configurator.connect(albert.signer).deployAssetList(comet.address)).wait();
    const deployed = receipt.events.find((event) => event.event === 'AssetListDeployed');
    expect(deployed, 'AssetListDeployed is emitted').to.not.be.undefined;
    const newImplementation = deployed.args.newAssetListImpl;

    await executeProposal(
      context,
      properties.bridgeReceiver,
      [proxyAdmin.address],
      ['upgrade(address,address)'],
      [await calldata(proxyAdmin.populateTransaction.upgrade(assetList.address, newImplementation))]
    );

    const after = await snapshotMarket(context, properties);

    expect(after.assetListImplementation).to.equal(newImplementation);
    expect(after.configHash).to.not.equal(before.configHash);
    expect(after.configHash).to.equal(utils.keccak256(utils.hexConcat([
      await assetList.TYPEHASH(),
      utils.defaultAbiCoder.encode(
        ['tuple(address asset, address priceFeed)[]'],
        [await configurator.getImmutableAssetConfig(comet.address)]
      ),
    ])));

    // Only the feed of the asset changes; the factors and caps stay in the proxy storage, and the Comet is not redeployed
    expect(await proxyAdmin.getProxyImplementation(comet.address)).to.equal(cometImplementationBefore);
    const listAssetInfos = await Promise.all(before.assetInfos.map((_, i) => assetList.getAssetInfo(i)));
    for (const assetInfos of [after.assetInfos, listAssetInfos]) {
      expect(assetInfos[assetIndex].priceFeed).to.equal(newFeed);
      expectAssetInfosEqualExcept(assetInfos, before.assetInfos, assetIndex, ['priceFeed']);
    }

    expect(await comet.getPrice(newFeed)).to.equal(oldPrice);
    const pricesAfter = await Promise.all(after.assetInfos.map(({ priceFeed }) => comet.getPrice(priceFeed)));
    expect(pricesAfter).to.deep.equal(pricesBefore);

    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(constants.AddressZero);

    expect(after.userCollateral).to.deep.equal(before.userCollateral);
    expect(after.liquidity).to.deep.equal(before.liquidity);
  }
);

scenario(
  'AssetList governance > change a supply cap, no upgrade',
  {
    filter: async (ctx: CometContext) => !(await isAssetListMigrationRequired(ctx)),
  },
  async (properties, context) => {
    const { comet, configurator, proxyAdmin, actors } = properties;
    const { albert } = actors;
    const ethers = context.world.deploymentManager.hre.ethers;
    const assetIndex = await firstListedAssetIndex(properties);
    const { asset, scale } = await comet.getAssetInfo(assetIndex);
    const assetList = (await ethers.getContractAt(
      'AssetList',
      await (comet as unknown as CometWithExtendedAssetList).assetList()
    )) as AssetList;

    const cometImplementationBefore = await proxyAdmin.getProxyImplementation(comet.address);
    const before = await snapshotMarket(context, properties);
    const capBefore = before.assetInfos[assetIndex].supplyCap;
    const { totalSupplyAsset } = await comet.totalsCollateral(asset);

    // The new cap leaves room for exactly one supply of the actor
    const amount = BigInt(getConfigForScenario(context).supplyCollateral) * scale.toBigInt();
    const newCap = totalSupplyAsset.toBigInt() + amount;

    const fromBlock = await ethers.provider.getBlockNumber();
    await executeProposal(
      context,
      properties.bridgeReceiver,
      [configurator.address],
      ['updateAssetSupplyCap(address,address,uint128)'],
      [await calldata(configurator.populateTransaction.updateAssetSupplyCap(comet.address, asset, newCap))]
    );
    const after = await snapshotMarket(context, properties);

    expect((await configurator.getAssetConfigs(comet.address))[assetIndex].supplyCap).to.equal(newCap);
    expect((await assetList.getAssetInfo(assetIndex)).supplyCap).to.equal(newCap);
    expect((await comet.getAssetInfo(assetIndex)).supplyCap).to.equal(newCap);

    // The list emits no events of its own; the Configurator does
    const events = await configurator.queryFilter(configurator.filters.UpdateAssetSupplyCap(comet.address, asset), fromBlock + 1);
    expect(events.length).to.equal(1);
    expect(events[0].args.oldSupplyCap).to.equal(capBefore);
    expect(events[0].args.newSupplyCap).to.equal(newCap);

    expect(after.assetListImplementation).to.equal(before.assetListImplementation);
    expect(await proxyAdmin.getProxyImplementation(comet.address)).to.equal(cometImplementationBefore);
    expect(after.configHash).to.equal(before.configHash);
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(constants.AddressZero);

    const collateral = context.getAssetByAddress(asset);
    await context.sourceTokens(amount + 1n, collateral, albert);
    await collateral.approve(albert, comet.address);
    await albert.supplyAsset({ asset, amount });
    expect((await comet.totalsCollateral(asset)).totalSupplyAsset).to.equal(newCap);
    await expect(albert.supplyAsset({ asset, amount: 1n })).to.be.revertedWithCustomError(comet, 'SupplyCapExceeded');

    expectAssetInfosEqualExcept(after.assetInfos, before.assetInfos, assetIndex, ['supplyCap']);
  }
);

// setConfiguration sets the list proxy only once, so governance cannot move a live market to another list proxy:
// the list is changed only by upgrading the proxy the market already has
scenario(
  'AssetList governance > a Comet cannot be pointed at a different asset-list proxy',
  {
    filter: async (ctx: CometContext) => !(await isAssetListMigrationRequired(ctx)),
  },
  async (properties, context) => {
    const { comet, configurator, actors } = properties;
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const before = await snapshotMarket(context, properties);
    const configuration = await configurator.getConfiguration(comet.address);
    // Any other address stands for the new list proxy: the call reverts before reading it
    const otherAssetList = context.world.deploymentManager.hre.ethers.Wallet.createRandom().address;

    await expect(
      configurator.connect(admin.signer).setConfiguration(comet.address, { ...configuration, assetList: otherAssetList })
    ).to.be.revertedWithCustomError(configurator, 'ConfigurationAlreadyExists');

    expect((await configurator.getConfiguration(comet.address)).assetList).to.equal(before.assetList);
    const after = await snapshotMarket(context, properties);
    expect(after.assetList).to.equal(before.assetList);
    expect(after.assetInfos).to.deep.equal(before.assetInfos);
  }
);

scenario(
  'AssetList governance > change a price feed and the factors and cap of an asset in one proposal',
  {
    filter: async (ctx: CometContext) => !(await isAssetListMigrationRequired(ctx)),
    cometBalances: async (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).supplyBase },
    }),
  },
  async (properties, context) => {
    const { comet, configurator, proxyAdmin, actors } = properties;
    const { betty } = actors;
    const ethers = context.world.deploymentManager.hre.ethers;
    const assetIndex = await firstListedAssetIndex(properties);

    // The borrow rests on the asset whose config changes
    await borrowAgainst(context, properties, betty, assetIndex);

    const cometImplementationBefore = await proxyAdmin.getProxyImplementation(comet.address);
    const before = await snapshotMarket(context, properties);
    const pricesBefore = await Promise.all(before.assetInfos.map(({ priceFeed }) => comet.getPrice(priceFeed)));
    const assetList = (await ethers.getContractAt('AssetList', before.assetList)) as AssetList;
    const oldConfig = (await configurator.getAssetConfigs(comet.address))[assetIndex];
    const oldPrice = (await comet.getPrice(oldConfig.priceFeed)).toBigInt();

    // Same price as the current feed, so no position is affected
    const newFeed = (await context.world.deploymentManager.deploy(
      'assetListScenario:priceFeed',
      'pricefeeds/ConstantPriceFeed.sol',
      [8, oldPrice],
      true
    )).address;

    // The price feed is the only immutable field that changes. Every field of the storage part changes; the factors
    // keep their order, and the actor's twice-needed collateral still backs the borrow
    const newConfig = {
      asset: oldConfig.asset,
      priceFeed: newFeed,
      borrowCollateralFactor: oldConfig.borrowCollateralFactor.mul(9).div(10),
      liquidateCollateralFactor: oldConfig.liquidateCollateralFactor.mul(9).div(10),
      liquidationFactor: oldConfig.liquidationFactor.mul(9).div(10),
      supplyCap: oldConfig.supplyCap.add(before.assetInfos[assetIndex].scale),
    };

    // The factor and cap setters write to the list at once. Each new factor is checked against the other two current
    // ones, so lowering them goes borrow, liquidate, liquidation. The new feed reaches the list with deployAndUpgradeTo,
    // which upgrades the list to a new implementation and writes the storage configs of all assets in the same call,
    // then redeploys the Comet
    const { asset } = newConfig;
    const fromBlock = await ethers.provider.getBlockNumber();
    await executeProposal(
      context,
      properties.bridgeReceiver,
      [configurator.address, configurator.address, configurator.address, configurator.address, configurator.address, proxyAdmin.address],
      [
        'updateAssetPriceFeed(address,address,address)',
        'updateAssetBorrowCollateralFactor(address,address,uint64)',
        'updateAssetLiquidateCollateralFactor(address,address,uint64)',
        'updateAssetLiquidationFactor(address,address,uint64)',
        'updateAssetSupplyCap(address,address,uint128)',
        'deployAndUpgradeTo(address,address)',
      ],
      [
        await calldata(configurator.populateTransaction.updateAssetPriceFeed(comet.address, asset, newConfig.priceFeed)),
        await calldata(configurator.populateTransaction.updateAssetBorrowCollateralFactor(comet.address, asset, newConfig.borrowCollateralFactor)),
        await calldata(configurator.populateTransaction.updateAssetLiquidateCollateralFactor(comet.address, asset, newConfig.liquidateCollateralFactor)),
        await calldata(configurator.populateTransaction.updateAssetLiquidationFactor(comet.address, asset, newConfig.liquidationFactor)),
        await calldata(configurator.populateTransaction.updateAssetSupplyCap(comet.address, asset, newConfig.supplyCap)),
        await calldata(proxyAdmin.populateTransaction.deployAndUpgradeTo(configurator.address, comet.address)),
      ]
    );

    const after = await snapshotMarket(context, properties);
    const storageKeys = ['borrowCollateralFactor', 'liquidateCollateralFactor', 'liquidationFactor', 'supplyCap'];
    const changedKeys = ['priceFeed', ...storageKeys];

    const storedConfig = (await configurator.getAssetConfigs(comet.address))[assetIndex];
    for (const key of Object.keys(newConfig)) {
      expect(storedConfig[key], `stored ${key}`).to.equal(newConfig[key]);
    }

    // The list is upgraded to the implementation the Configurator deployed, whose hash covers the new feed
    const deployedEvents = await configurator.queryFilter(configurator.filters.AssetListDeployed(comet.address), fromBlock + 1);
    expect(deployedEvents.length).to.equal(1);
    expect(after.assetList).to.equal(before.assetList);
    expect(after.assetListImplementation).to.not.equal(before.assetListImplementation);
    expect(after.assetListImplementation).to.equal(deployedEvents[0].args.newAssetListImpl);
    expect(after.configHash).to.equal(utils.keccak256(utils.hexConcat([
      await assetList.TYPEHASH(),
      utils.defaultAbiCoder.encode(
        ['tuple(address asset, address priceFeed)[]'],
        [await configurator.getImmutableAssetConfig(comet.address)]
      ),
    ])));
    expect(await proxyAdmin.getProxyImplementation(comet.address)).to.not.equal(cometImplementationBefore);
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(constants.AddressZero);

    const listAssetInfos = await Promise.all(before.assetInfos.map((_, i) => assetList.getAssetInfo(i)));
    for (const assetInfos of [after.assetInfos, listAssetInfos]) {
      for (const key of changedKeys) {
        expect(assetInfos[assetIndex][key], key).to.equal(newConfig[key]);
      }
      expectAssetInfosEqualExcept(assetInfos, before.assetInfos, assetIndex, changedKeys);
    }

    // The Configurator and the list agree on every asset again
    const storageConfigs = await configurator.getStorageAssetConfig(comet.address);
    storageConfigs.forEach((storageConfig, i) => {
      for (const key of storageKeys) {
        expect(listAssetInfos[i][key], `${key} of asset ${i}`).to.equal(storageConfig[key]);
      }
    });

    const feedEvents = await configurator.queryFilter(configurator.filters.UpdateAssetPriceFeed(comet.address, asset), fromBlock + 1);
    expect(feedEvents.length).to.equal(1);
    expect(feedEvents[0].args.oldPriceFeed).to.equal(oldConfig.priceFeed);
    expect(feedEvents[0].args.newPriceFeed).to.equal(newFeed);

    expect(await comet.getPrice(newFeed)).to.equal(oldPrice);
    const pricesAfter = await Promise.all(after.assetInfos.map(({ priceFeed }) => comet.getPrice(priceFeed)));
    expect(pricesAfter).to.deep.equal(pricesBefore);

    expect(after.totalsBasic).to.deep.equal(before.totalsBasic);
    expect(after.totalsCollateral).to.deep.equal(before.totalsCollateral);
    expect(after.userBasic).to.deep.equal(before.userBasic);
    expect(after.userCollateral).to.deep.equal(before.userCollateral);
    expect(after.liquidity).to.deep.equal(before.liquidity);
  }
);

// The factors and cap of the new asset
const storageConfig = {
  borrowCollateralFactor: exp(0.75, 18),
  liquidateCollateralFactor: exp(0.8, 18),
  liquidationFactor: exp(0.9, 18),
  supplyCap: exp(1000, 18),
};

// Adding an asset to a live market takes two steps:
//   1. Configurator.addAsset appends the full config to the stored configs.
//   2. CometProxyAdmin.deployAndUpgradeAssetListTo builds a new list implementation that has the asset in its
//      immutables, upgrades the list proxy to it, and in the same call writes the storage configs of all assets,
//      which registers the new asset with the factors and cap of its stored config.

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
    const immutableKeys = ['asset', 'priceFeed'];

    // A new collateral with its own 18 decimals token and price feed, active and with a cap of 1000 tokens
    const newAssetConfig = {
      asset: await deployMockERC20(context, 'asset'),
      priceFeed: await deployPriceFeed(context, 'asset'),
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
    await expect(assetList.getAssetInfoByAddress(asset)).to.be.revertedWithCustomError(assetList, 'AssetNotFound');
    expect(await comet.numAssets()).to.equal(numAssets);
    await expect(comet.getAssetInfoByAddress(asset)).to.be.revertedWithCustomError(assetList, 'AssetNotFound');

    // The hash of the immutable configs changed, so deployAssetList would build a new implementation
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.not.equal(constants.AddressZero);

    /* Step 2: redeploy and upgrade the list */

    const assetConfigsBeforeUpgrade = await configurator.getAssetConfigs(comet.address);
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

    // The list reads the address, price feed and scale of the new asset from the immutables, and the upgrade
    // registered it with the factors and cap of its stored config
    expect(upgradedAssetInfo.asset).to.equal(asset);
    expect(upgradedAssetInfo.priceFeed).to.equal(newAssetConfig.priceFeed);
    expect(upgradedAssetInfo.scale).to.equal(exp(1, 18));
    for (const key of storageKeys) expect(upgradedAssetInfo[key]).to.equal(newAssetConfig[key]);

    // getAssetInfoByAddress returns the same values as getAssetInfo, and the offset is the index of the asset
    expect(await assetList.getAssetInfoByAddress(asset)).to.deep.equal(upgradedAssetInfo);
    expect(upgradedAssetInfo.offset).to.equal(numAssets);

    // The stored configs are unchanged
    expect(await configurator.getAssetConfigs(comet.address)).to.deep.equal(assetConfigsBeforeUpgrade);

    // The immutable configs match the list again, so deployAssetList would build nothing
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(constants.AddressZero);

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
                 INVARIANTS OF THE UPGRADE FLOW
//////////////////////////////////////////////////////////////*/

// A list upgrade writes the factors and caps the Configurator stores over every asset of the list. If the two ever
// disagree, the next upgrade (a new asset, a new price feed) silently changes the factors of the other assets
scenario(
  'AssetList invariant > the Configurator stores the same configs the list holds',
  {
    filter: async (ctx: CometContext) => !(await isAssetListMigrationRequired(ctx)),
  },
  async ({ comet, configurator, assetList }) => {
    const immutableConfigs = await configurator.getImmutableAssetConfig(comet.address);
    const storageConfigs = await configurator.getStorageAssetConfig(comet.address);
    const numAssets = await assetList.numAssets();
    expect(immutableConfigs.length).to.equal(numAssets);
    expect(storageConfigs.length).to.equal(numAssets);

    for (let i = 0; i < numAssets; i++) {
      const assetInfo = await assetList.getAssetInfo(i);
      for (const key of ['asset', 'priceFeed']) {
        expect(assetInfo[key], `${key} of asset ${i}`).to.equal(immutableConfigs[i][key]);
      }
      for (const key of ['borrowCollateralFactor', 'liquidateCollateralFactor', 'liquidationFactor', 'supplyCap']) {
        expect(assetInfo[key], `${key} of asset ${i}`).to.equal(storageConfigs[i][key]);
      }
    }

    // The hash agrees too, so a deploy now builds no new list
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(constants.AddressZero);
  }
);

// The proxy admin upgrades the list proxy on every list change, so it must be the list proxy's admin as well as the
// Comet proxy's; otherwise every proposal that changes the list reverts
scenario(
  'AssetList invariant > the list proxy has the same admin as the Comet proxy',
  {
    filter: async (ctx: CometContext) => !(await isAssetListMigrationRequired(ctx)),
  },
  async ({ comet, proxyAdmin, assetList }, context) => {
    const provider = context.world.deploymentManager.hre.ethers.provider;
    const adminOf = async (proxy: string) => utils.getAddress(utils.hexDataSlice(await provider.getStorageAt(proxy, ADMIN_SLOT), 12));

    expect(await adminOf(comet.address)).to.equal(proxyAdmin.address);
    expect(await adminOf(assetList.address)).to.equal(proxyAdmin.address);
  }
);

// setAssetConfigs is reached only through the proxy admin's upgradeAndCall: the proxy blocks plain calls from its admin,
// and every other caller is not the admin
scenario(
  'AssetList#setAssetConfigs > reverts for every direct caller',
  {
    filter: async (ctx: CometContext) => !(await isAssetListMigrationRequired(ctx)),
  },
  async ({ comet, configurator, proxyAdmin, assetList, actors }, context) => {
    const { admin, albert } = actors;
    const storageConfigs = await configurator.getStorageAssetConfig(comet.address);
    const impersonate = async (address: string) => {
      const signer = await context.world.impersonateAddress(address);
      await fundAccount(context.world, signer);
      return signer;
    };

    await fundAccount(context.world, admin);
    await expect(assetList.connect(admin.signer).setAssetConfigs(storageConfigs))
      .to.be.revertedWithCustomError(assetList, 'OnlyProxyAdmin');

    await expect(assetList.connect(await impersonate(configurator.address)).setAssetConfigs(storageConfigs))
      .to.be.revertedWithCustomError(assetList, 'OnlyProxyAdmin');

    await expect(assetList.connect(albert.signer).setAssetConfigs(storageConfigs))
      .to.be.revertedWithCustomError(assetList, 'OnlyProxyAdmin');

    await expect(assetList.connect(await impersonate(proxyAdmin.address)).setAssetConfigs(storageConfigs))
      .to.be.revertedWith('TransparentUpgradeableProxy: admin cannot fallback to proxy target');
  }
);

/*//////////////////////////////////////////////////////////////
                  FACTOR AND ASSET CHANGES
//////////////////////////////////////////////////////////////*/

// The factor setters write to the list at once: the Comet reads the new factors with no redeploy and no list upgrade
scenario(
  'AssetList governance > change the collateral factors, no upgrade',
  {
    filter: async (ctx: CometContext) => !(await isAssetListMigrationRequired(ctx)),
    cometBalances: async (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).supplyBase },
      betty: { $asset0: getConfigForScenario(ctx).supplyCollateral },
    }),
  },
  async (properties, context) => {
    const { comet, configurator, proxyAdmin } = properties;
    const assetIndex = await firstListedAssetIndex(properties);

    const cometImplementationBefore = await proxyAdmin.getProxyImplementation(comet.address);
    const before = await snapshotMarket(context, properties);
    const { asset, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor } = before.assetInfos[assetIndex];

    // All three go down by a tenth, so they keep their order. Each new factor is checked against the other two current
    // ones, so lowering them goes borrow, liquidate, liquidation
    const newFactors = {
      borrowCollateralFactor: borrowCollateralFactor.mul(9).div(10),
      liquidateCollateralFactor: liquidateCollateralFactor.mul(9).div(10),
      liquidationFactor: liquidationFactor.mul(9).div(10),
    };

    await executeProposal(
      context,
      properties.bridgeReceiver,
      [configurator.address, configurator.address, configurator.address],
      [
        'updateAssetBorrowCollateralFactor(address,address,uint64)',
        'updateAssetLiquidateCollateralFactor(address,address,uint64)',
        'updateAssetLiquidationFactor(address,address,uint64)',
      ],
      [
        await calldata(configurator.populateTransaction.updateAssetBorrowCollateralFactor(comet.address, asset, newFactors.borrowCollateralFactor)),
        await calldata(configurator.populateTransaction.updateAssetLiquidateCollateralFactor(comet.address, asset, newFactors.liquidateCollateralFactor)),
        await calldata(configurator.populateTransaction.updateAssetLiquidationFactor(comet.address, asset, newFactors.liquidationFactor)),
      ]
    );

    const after = await snapshotMarket(context, properties);
    const changedKeys = Object.keys(newFactors);

    for (const key of changedKeys) {
      expect(after.assetInfos[assetIndex][key], key).to.equal(newFactors[key]);
      expect((await configurator.getAssetConfigs(comet.address))[assetIndex][key], `stored ${key}`).to.equal(newFactors[key]);
    }
    expectAssetInfosEqualExcept(after.assetInfos, before.assetInfos, assetIndex, changedKeys);

    // Nothing was deployed or upgraded
    expect(await proxyAdmin.getProxyImplementation(comet.address)).to.equal(cometImplementationBefore);
    expect(after.assetListImplementation).to.equal(before.assetListImplementation);
    expect(after.configHash).to.equal(before.configHash);

    expect(after.totalsBasic).to.deep.equal(before.totalsBasic);
    expect(after.totalsCollateral).to.deep.equal(before.totalsCollateral);
    expect(after.userBasic).to.deep.equal(before.userBasic);
    expect(after.userCollateral).to.deep.equal(before.userCollateral);
  }
);

// Adding an asset upgrades the list and redeploys the Comet; every position, total and asset of before stays as it was
scenario(
  'AssetList governance > add an asset, existing positions unchanged',
  {
    filter: async (ctx: CometContext) =>
      !(await isAssetListMigrationRequired(ctx)) && (await (await ctx.getComet()).numAssets()) < MAX_ASSETS,
    cometBalances: async (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).supplyBase },
    }),
  },
  async (properties, context) => {
    const { comet, configurator, proxyAdmin, actors } = properties;
    const { betty } = actors;

    // A borrow rests on a listed asset, so the snapshot holds a position with collateral, a debt and assetsIn bits
    await borrowAgainst(context, properties, betty, await firstListedAssetIndex(properties));
    const before = await snapshotMarket(context, properties);

    const newAssetConfig = {
      asset: await deployMockERC20(context, 'positionsAsset'),
      priceFeed: await deployPriceFeed(context, 'positionsAsset'),
      ...storageConfig,
    };

    await executeProposal(
      context,
      properties.bridgeReceiver,
      [configurator.address, proxyAdmin.address],
      ['addAsset(address,(address,address,uint64,uint64,uint64,uint128))', 'deployAndUpgradeTo(address,address)'],
      [
        await calldata(configurator.populateTransaction.addAsset(comet.address, newAssetConfig)),
        await calldata(proxyAdmin.populateTransaction.deployAndUpgradeTo(configurator.address, comet.address)),
      ]
    );

    // The new asset is the last one, registered with its stored factors and cap
    expect(await comet.numAssets()).to.equal(before.numAssets + 1);
    const newAssetInfo = await comet.getAssetInfo(before.numAssets);
    for (const key of Object.keys(newAssetConfig)) expect(newAssetInfo[key], key).to.equal(newAssetConfig[key]);

    // Everything of before, read over the same assets, is unchanged
    const after = await snapshotMarket(context, properties, before.numAssets);
    expect(after.assetList).to.equal(before.assetList);
    expect(after.assetListImplementation).to.not.equal(before.assetListImplementation);
    expect(after.assetInfos).to.deep.equal(before.assetInfos);
    expect(after.totalsBasic).to.deep.equal(before.totalsBasic);
    expect(after.totalsCollateral).to.deep.equal(before.totalsCollateral);
    expect(after.userBasic).to.deep.equal(before.userBasic);
    expect(after.userCollateral).to.deep.equal(before.userCollateral);
    expect(after.liquidity).to.deep.equal(before.liquidity);

    // The new asset holds nothing of anyone yet
    expect((await comet.totalsCollateral(newAssetConfig.asset)).totalSupplyAsset).to.equal(0);
    expect(await comet.collateralBalanceOf(betty.address, newAssetConfig.asset)).to.equal(0);
  }
);

// addAsset does not check the factors: the list rejects a bad config only at the upgrade, and the upgrade reverts as a
// whole. In one proposal the addAsset reverts with it; done apart, the bad config stays stored and cannot be fixed
scenario(
  'AssetList governance > a new asset with bad factors makes the upgrade revert',
  {
    filter: async (ctx: CometContext) =>
      !(await isAssetListMigrationRequired(ctx)) && (await (await ctx.getComet()).numAssets()) < MAX_ASSETS,
  },
  async (properties, context) => {
    const { comet, configurator, proxyAdmin, assetList, actors } = properties;
    const { admin } = actors;
    await fundAccount(context.world, admin);

    const cometImplementationBefore = await proxyAdmin.getProxyImplementation(comet.address);
    const before = await snapshotMarket(context, properties);

    // The borrow collateral factor equals the liquidate collateral factor, which the list rejects
    const badAssetConfig = {
      asset: await deployMockERC20(context, 'badFactorsAsset'),
      priceFeed: await deployPriceFeed(context, 'badFactorsAsset'),
      ...storageConfig,
      borrowCollateralFactor: storageConfig.liquidateCollateralFactor,
    };
    await configurator.connect(admin.signer).addAsset(comet.address, badAssetConfig);

    await expect(proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address))
      .to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');

    // Neither the list nor the Comet changed
    const after = await snapshotMarket(context, properties);
    expect(await proxyAdmin.getProxyImplementation(comet.address)).to.equal(cometImplementationBefore);
    expect(after.assetListImplementation).to.equal(before.assetListImplementation);
    expect(after.configHash).to.equal(before.configHash);
    expect(after.numAssets).to.equal(before.numAssets);
    expect(after.assetInfos).to.deep.equal(before.assetInfos);

    // The bad config stays stored, and the factor setters cannot fix it: they write to the list, which does not hold
    // the asset yet. So the asset must be added in the same proposal as the upgrade
    expect((await configurator.getAssetConfigs(comet.address))[before.numAssets].asset).to.equal(badAssetConfig.asset);
    await expect(
      configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, badAssetConfig.asset, 0)
    ).to.be.revertedWithCustomError(assetList, 'AssetNotFound');
  }
);
