import { expect } from 'chai';
import { constants, utils } from 'ethers';
import { CometContext, CometProperties, scenario } from '../context/CometContext';
import { executeProposal, fundAccount, servicePatch2 } from '../utils';
import { getConfigForScenario } from '../utils/scenarioHelper';
import { isAssetListMigrationRequired } from '../utils/versionControl';
import CometActor from '../context/CometActor';
import { AssetList, AssetListFactory, CometWithExtendedAssetList, FaucetToken } from '../../build/types';
import { AssetInfoStructOutput } from '../../build/types/CometInterface';
import { calldata } from '../../src/deploy';
import { exp } from '../../test/helpers';
import { hashConfig } from '../../test/asset-list/shared';
import { deployMockERC20, deployPriceFeed } from '../configurator/shared';

// EIP-1967 implementation slot of the asset list proxy
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ASSET_INFO_KEYS = [
  'offset', 'asset', 'priceFeed', 'scale', 'borrowCollateralFactor', 'liquidateCollateralFactor', 'liquidationFactor', 'supplyCap',
];

// What a proposal that leaves the asset list alone must not change: the list itself, every asset the Comet reads from
// it, the market totals and the positions of the actors. Positions are read as stored, so accrued interest does not count
async function snapshotMarket(context: CometContext, { comet, actors }: CometProperties) {
  const ethers = context.world.deploymentManager.hre.ethers;
  const assetListAddress = await (comet as unknown as CometWithExtendedAssetList).assetList();
  const assetList = (await ethers.getContractAt('AssetList', assetListAddress)) as AssetList;
  const numAssets = await comet.numAssets();
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

scenario(
  'AssetList governance > point a Comet at a different asset-list proxy',
  {
    filter: async (ctx: CometContext) => !(await isAssetListMigrationRequired(ctx)),
    cometBalances: async (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).supplyBase },
      betty: { $asset0: getConfigForScenario(ctx).supplyCollateral },
    }),
  },
  async (properties, context) => {
    const { comet, configurator, proxyAdmin, actors } = properties;
    const { charles } = actors;
    const ethers = context.world.deploymentManager.hre.ethers;
    const assetIndex = await firstListedAssetIndex(properties);

    const before = await snapshotMarket(context, properties);
    const oldAssetList = (await ethers.getContractAt('AssetList', before.assetList)) as AssetList;
    const oldListAssetInfos = await Promise.all(before.assetInfos.map((_, i) => oldAssetList.getAssetInfo(i)));

    // Anyone may build the list; the proxy is initialized in its constructor, so it is never left uninitialized
    await fundAccount(context.world, charles);
    const assetListFactory = (await ethers.getContractAt(
      'AssetListFactory',
      await configurator.cometAssetListFactories(comet.address),
      charles.signer
    )) as AssetListFactory;
    const receipt = await (await assetListFactory.createAssetList(await configurator.getImmutableAssetConfig(comet.address), configurator.address)).wait();
    const newImplementation = receipt.events.find((event) => event.event === 'AssetListCreated').args.assetList;
    const proxy = await (await ethers.getContractFactory(
      'contracts/vendor/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy',
      charles.signer
    )).deploy(
      newImplementation,
      proxyAdmin.address,
      oldAssetList.interface.encodeFunctionData('initialize', [
        await configurator.getStorageAssetConfig(comet.address),
      ])
    );
    await proxy.deployed();
    const newAssetList = (await ethers.getContractAt('AssetList', proxy.address)) as AssetList;

    expect(await Promise.all(before.assetInfos.map((_, i) => newAssetList.getAssetInfo(i)))).to.deep.equal(oldListAssetInfos);
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(constants.AddressZero);

    await executeProposal(
      context,
      properties.bridgeReceiver,
      [configurator.address, proxyAdmin.address],
      ['updateAssetList(address,address)', 'deployAndUpgradeTo(address,address)'],
      [
        await calldata(configurator.populateTransaction.updateAssetList(comet.address, newAssetList.address)),
        await calldata(proxyAdmin.populateTransaction.deployAndUpgradeTo(configurator.address, comet.address)),
      ]
    );

    const after = await snapshotMarket(context, properties);

    expect((await configurator.getConfiguration(comet.address)).assetList).to.equal(newAssetList.address);
    expect(after.assetList).to.equal(newAssetList.address);

    expect(after.numAssets).to.equal(before.numAssets);
    expect(after.assetInfos).to.deep.equal(before.assetInfos);

    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(constants.AddressZero);

    // The old list keeps its implementation, hash and assets
    expect(utils.getAddress(utils.hexDataSlice(await ethers.provider.getStorageAt(oldAssetList.address, IMPLEMENTATION_SLOT), 12)))
      .to.equal(before.assetListImplementation);
    expect(await oldAssetList.configHash()).to.equal(before.configHash);
    expect(await Promise.all(before.assetInfos.map((_, i) => oldAssetList.getAssetInfo(i)))).to.deep.equal(oldListAssetInfos);

    expect(after.totalsBasic).to.deep.equal(before.totalsBasic);
    expect(after.totalsCollateral).to.deep.equal(before.totalsCollateral);
    expect(after.userBasic).to.deep.equal(before.userBasic);
    expect(after.userCollateral).to.deep.equal(before.userCollateral);

    // Supply and borrow work against the new list
    await borrowAgainst(context, properties, charles, assetIndex);
    expect(await comet.borrowBalanceOf(charles.address)).to.be.gt(0);

    // The factor setters write to the list the Comet now reads
    const { borrowCollateralFactor } = before.assetInfos[assetIndex];
    const newBorrowCF = borrowCollateralFactor.mul(9).div(10);
    await executeProposal(
      context,
      properties.bridgeReceiver,
      [configurator.address],
      ['updateAssetBorrowCollateralFactor(address,address,uint64)'],
      [await calldata(configurator.populateTransaction.updateAssetBorrowCollateralFactor(
        comet.address,
        before.assetInfos[assetIndex].asset,
        newBorrowCF
      ))]
    );

    expect((await newAssetList.getAssetInfo(assetIndex)).borrowCollateralFactor).to.equal(newBorrowCF);
    expect((await comet.getAssetInfo(assetIndex)).borrowCollateralFactor).to.equal(newBorrowCF);
    expect((await oldAssetList.getAssetInfo(assetIndex)).borrowCollateralFactor).to.equal(borrowCollateralFactor);
  }
);

scenario(
  'AssetList governance > replace an asset config, asset list upgraded and storage part pushed',
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

    // The price feed is the only immutable field that can change: the asset is how updateAsset finds the config.
    // Every field of the storage part changes; the factors keep their order, and the
    // actor's twice-needed collateral still backs the borrow
    const newConfig = {
      asset: oldConfig.asset,
      priceFeed: newFeed,
      borrowCollateralFactor: oldConfig.borrowCollateralFactor.mul(9).div(10),
      liquidateCollateralFactor: oldConfig.liquidateCollateralFactor.mul(9).div(10),
      liquidationFactor: oldConfig.liquidationFactor.mul(9).div(10),
      supplyCap: oldConfig.supplyCap.add(before.assetInfos[assetIndex].scale),
    };

    // deployAndUpgradeTo upgrades the list to an implementation with the new feed, then redeploys the Comet; the
    // upgrade keeps the old factors and cap in the proxy storage, so setAssetConfigToAssetList writes the new ones
    const fromBlock = await ethers.provider.getBlockNumber();
    await executeProposal(
      context,
      properties.bridgeReceiver,
      [configurator.address, proxyAdmin.address, configurator.address],
      [
        'updateAsset(address,(address,address,uint64,uint64,uint64,uint128))',
        'deployAndUpgradeTo(address,address)',
        'setAssetConfigToAssetList(address,address)',
      ],
      [
        await calldata(configurator.populateTransaction.updateAsset(comet.address, newConfig)),
        await calldata(proxyAdmin.populateTransaction.deployAndUpgradeTo(configurator.address, comet.address)),
        await calldata(configurator.populateTransaction.setAssetConfigToAssetList(comet.address, newConfig.asset)),
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

    const updateEvents = await configurator.queryFilter(configurator.filters.UpdateAsset(comet.address), fromBlock + 1);
    expect(updateEvents.length).to.equal(1);
    expect(updateEvents[0].args.oldAssetConfig.priceFeed).to.equal(oldConfig.priceFeed);
    expect(updateEvents[0].args.newAssetConfig.priceFeed).to.equal(newFeed);
    expect(updateEvents[0].args.oldAssetConfig.borrowCollateralFactor).to.equal(oldConfig.borrowCollateralFactor);
    expect(updateEvents[0].args.newAssetConfig.borrowCollateralFactor).to.equal(newConfig.borrowCollateralFactor);
    const setEvents = await configurator.queryFilter(
      configurator.filters.SetAssetConfigToAssetList(comet.address, assetList.address, newConfig.asset),
      fromBlock + 1
    );
    expect(setEvents.length).to.equal(1);

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
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(constants.AddressZero);

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