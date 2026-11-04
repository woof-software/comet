import { expect } from 'chai';
import { utils } from 'ethers';
import { scenario } from '../context/CometContext';
import { calldata } from '../../src/deploy';
import {
  executeProposal,
  getMinimumBorrowAmounts,
  getUsableCollateralIndices,
  isAssetListMigrationRequired,
  matchesDeployment,
  supportsMarketAdminPermissionChecker,
} from '../utils';
import {
  AssetList,
  CometProxyAdmin,
  CometWithExtendedAssetList,
  Configurator,
  ConfiguratorV1,
  ERC20,
} from '../../build/types';

// The slot a transparent proxy keeps its admin in (EIP-1967)
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

// The named fields of a struct returned by ethers, without the numeric duplicates
function namedFields(struct: object): string[] {
  return Object.keys(struct).filter((key) => isNaN(Number(key)));
}

// Moves a live market from the V1 Configurator, which keeps the asset configs inside the Configuration, to the
// asset list: the Configurator is upgraded and migrated, an asset list is deployed for the market, and the Comet is
// rebuilt on it. Runs on every live base whose asset list does not support ConfigHash yet, one market per run.
scenario(
  'Configurator migration to the asset list (V1 → Intermediate → Configurator)',
  {
    filter: async (ctx) =>
      matchesDeployment(ctx, [{ network: 'mainnet' }, { network: 'arbitrum' }, { network: 'base' }, { network: 'optimism' }]) &&
      await isAssetListMigrationRequired(ctx) &&
      // The borrow position needs a collateral that can be supplied; a wound-down market has none
      (await getUsableCollateralIndices(ctx, 1)).length > 0,
  },
  async ({ comet, configurator: liveConfigurator, proxyAdmin: liveProxyAdmin, actors, bridgeReceiver }, context) => {
    const dm = context.world.deploymentManager;
    const ethers = dm.hre.ethers;
    // The context's contracts carry the ABI of the live implementations, so the new functions are read through the
    // current ABIs at the same addresses. ConfiguratorOptimism has every function used here, so one type serves both
    const configurator = (await ethers.getContractAt('Configurator', liveConfigurator.address)) as Configurator;
    const proxyAdmin = (await ethers.getContractAt('CometProxyAdmin', liveProxyAdmin.address)) as CometProxyAdmin;
    const { albert } = actors;

    /*//////////////////////////////////////////////////////////////
                        STEP 1: SNAPSHOT THE MARKET
    //////////////////////////////////////////////////////////////*/

    // Albert supplies collateral and borrows base against it, so the upgrades below run under a live borrow position.
    // It is opened before the snapshot, as it changes the market totals
    const baseToken = context.getAssetByAddress(await comet.baseToken());
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);
    const { collateralAsset, supplyAmount, borrowAmount } = await getMinimumBorrowAmounts(context, collateralIndex);
    await context.sourceTokens(supplyAmount, collateralAsset.address, albert.address);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: collateralAsset.address, amount: supplyAmount });
    await context.sourceTokens(borrowAmount, baseToken.address, comet.address);
    await comet.connect(albert.signer).withdraw(baseToken.address, borrowAmount);

    const borrowBalanceBefore = await comet.borrowBalanceOf(albert.address);
    const balanceBefore = await comet.balanceOf(albert.address);
    const collateralBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
    const { principal: principalBefore } = await comet.userBasic(albert.address);

    // The V1 Configurator returns the asset configs as part of the Configuration
    const configuratorV1 = (await ethers.getContractAt('ConfiguratorV1', configurator.address)) as ConfiguratorV1;
    const v1Configuration = await configuratorV1.getConfiguration(comet.address);
    const v1AssetConfigs = v1Configuration.assetConfigs;

    const numAssetsBefore = await comet.numAssets();
    const assetInfosBefore = [];
    for (let i = 0; i < numAssetsBefore; i++) assetInfosBefore.push(await comet.getAssetInfo(i));
    const assets = assetInfosBefore.map((info) => info.asset);

    // Only stored values are compared: a view like getReserves accrues interest with time,
    // and the proposals below let time pass
    const totalsBasicBefore = await comet.totalsBasic();
    const baseBalanceBefore = await baseToken.balanceOf(comet.address);
    const totalsCollateralBefore = await Promise.all(assets.map((asset) => comet.totalsCollateral(asset)));
    const collateralReservesBefore = await Promise.all(assets.map((asset) => comet.getCollateralReserves(asset)));

    /*//////////////////////////////////////////////////////////////
                     STEP 2: DEPLOY THE NEW CONTRACTS
    //////////////////////////////////////////////////////////////*/

    // A Configurator that stores the market admin permission checker has its own storage layout, so its own versions
    const withMarketAdmin = await supportsMarketAdminPermissionChecker(context);
    const configuratorIntermediate = await dm.deploy(
      'test:configuratorIntermediate',
      withMarketAdmin ? 'migration/ConfiguratorIntermediateOptimism.sol' : 'migration/ConfiguratorIntermediate.sol',
      [],
      true
    );
    const configuratorImplementation = await dm.deploy(
      'test:configuratorImplementation',
      withMarketAdmin ? 'marketupdates/ConfiguratorOptimism.sol' : 'Configurator.sol',
      [],
      true
    );
    const assetListFactory = await dm.deploy('test:assetListFactory', 'test/assetList/AssetListFactory.sol', [], true);
    const cometFactory = await dm.deploy('test:cometFactory', 'test/CometFactoryWithExtendedAssetList.sol', [], true);

    /*//////////////////////////////////////////////////////////////
          STEP 3: PROPOSAL 1, CONFIGURATOR UPGRADE AND MIGRATION
    //////////////////////////////////////////////////////////////*/

    // The Configurator proxy is upgraded by its own admin
    const configuratorAdmin = proxyAdmin.attach(
      utils.getAddress('0x' + (await ethers.provider.getStorageAt(configurator.address, ADMIN_SLOT)).slice(26))
    );
    const intermediate = await ethers.getContractAt('ConfiguratorIntermediate', configurator.address);

    await executeProposal(
      context,
      bridgeReceiver,
      [configuratorAdmin.address, configurator.address, configuratorAdmin.address, configurator.address],
      [
        'upgrade(address,address)',
        'migrateAssetConfig(address[])',
        'upgrade(address,address)',
        'setAssetListFactory(address,address)',
      ],
      [
        await calldata(configuratorAdmin.populateTransaction.upgrade(configurator.address, configuratorIntermediate.address)),
        await calldata(intermediate.populateTransaction.migrateAssetConfig([comet.address])),
        await calldata(configuratorAdmin.populateTransaction.upgrade(configurator.address, configuratorImplementation.address)),
        await calldata(configurator.populateTransaction.setAssetListFactory(comet.address, assetListFactory.address)),
      ]
    );

    // The asset configs moved to their own mapping, in their original order with every field but decimals unchanged.
    // The migration rebuilds each config field by field, so every field is checked to catch one dropped or swapped
    const storedAssetConfigs = await configurator.getAssetConfigs(comet.address);
    expect(storedAssetConfigs.length).to.equal(v1AssetConfigs.length);
    for (let i = 0; i < v1AssetConfigs.length; i++) {
      expect(namedFields(storedAssetConfigs[i])).to.deep.equal(namedFields(v1AssetConfigs[i]).filter((field) => field !== 'decimals'));
      for (const field of namedFields(storedAssetConfigs[i])) {
        expect(storedAssetConfigs[i][field], `asset ${i} ${field}`).to.deep.equal(v1AssetConfigs[i][field]);
      }
      // Decimals are dropped because the asset list reads them from the token, so the V1 value must be the token's
      const token = (await ethers.getContractAt('ERC20', v1AssetConfigs[i].asset)) as ERC20;
      expect(await token.decimals(), `asset ${i} decimals`).to.equal(v1AssetConfigs[i].decimals);
    }

    // Clearing the old array zeroed the slot the new Configuration reads as assetList; every other field is kept
    const configuration = await configurator.getConfiguration(comet.address);
    expect(configuration.assetList).to.equal(ethers.constants.AddressZero);
    for (const field of namedFields(configuration).filter((field) => field !== 'assetList')) {
      expect(configuration[field], field).to.deep.equal(v1Configuration[field]);
    }

    /*//////////////////////////////////////////////////////////////
             STEP 4: DEPLOY AND INITIALIZE THE ASSET LIST
    //////////////////////////////////////////////////////////////*/

    // The market has no list yet and deployAssetList only redeploys an existing one, so the first implementation
    // comes straight from the factory, built from the migrated immutable configs
    const immutableConfigs = await configurator.getImmutableAssetConfig(comet.address);
    const newAssetListImpl = await assetListFactory.callStatic.createAssetList(immutableConfigs, configurator.address);
    await (await assetListFactory.createAssetList(immutableConfigs, configurator.address)).wait();
    const assetListImplementation = (await ethers.getContractAt('AssetList', newAssetListImpl)) as AssetList;

    // The proxy is owned by the Comet's proxy admin, so later deploys can upgrade it, and is initialized on creation
    const assetListProxy = await dm.deploy(
      'test:assetList',
      'vendor/proxy/transparent/TransparentUpgradeableProxy.sol',
      [
        newAssetListImpl,
        proxyAdmin.address,
        assetListImplementation.interface.encodeFunctionData('initialize', [
          await configurator.getStorageAssetConfig(comet.address),
        ]),
      ],
      true
    );
    const assetList = assetListImplementation.attach(assetListProxy.address);

    // The list was built from the market's immutable configs
    const encodedImmutableConfigs = utils.defaultAbiCoder.encode(
      ['tuple(address asset, address priceFeed)[]'],
      [immutableConfigs]
    );
    expect(await assetList.configHash()).to.equal(
      utils.keccak256(utils.hexConcat([await assetList.TYPEHASH(), encodedImmutableConfigs]))
    );
    expect(await assetList.configurator()).to.equal(configurator.address);

    // Every asset reads back exactly as the Configurator stores it
    for (let i = 0; i < storedAssetConfigs.length; i++) {
      const info = await assetList.getAssetInfo(i);
      const stored = storedAssetConfigs[i];
      expect(info.asset).to.equal(stored.asset);
      expect(info.priceFeed).to.equal(stored.priceFeed);
      expect(info.scale).to.equal(10n ** BigInt(v1AssetConfigs[i].decimals));
      expect(info.borrowCollateralFactor).to.equal(stored.borrowCollateralFactor);
      expect(info.liquidateCollateralFactor).to.equal(stored.liquidateCollateralFactor);
      expect(info.liquidationFactor).to.equal(stored.liquidationFactor);
      expect(info.supplyCap).to.equal(stored.supplyCap);
    }

    /*//////////////////////////////////////////////////////////////
             STEP 5: PROPOSAL 2, SWITCH THE MARKET TO THE LIST
    //////////////////////////////////////////////////////////////*/

    // setConfiguration sets the list proxy once, for a market that has none yet; the configuration read after the
    // migration is still the stored one
    await executeProposal(
      context,
      bridgeReceiver,
      [configurator.address, configurator.address, proxyAdmin.address],
      [
        configurator.interface.getFunction('setConfiguration').format(),
        'setFactory(address,address)',
        'deployAndUpgradeTo(address,address)',
      ],
      [
        await calldata(configurator.populateTransaction.setConfiguration(comet.address, { ...configuration, assetList: assetList.address })),
        await calldata(configurator.populateTransaction.setFactory(comet.address, cometFactory.address)),
        await calldata(proxyAdmin.populateTransaction.deployAndUpgradeTo(configurator.address, comet.address)),
      ]
    );

    const extendedComet = (await ethers.getContractAt('CometWithExtendedAssetList', comet.address)) as CometWithExtendedAssetList;
    expect(await extendedComet.assetList()).to.equal(assetList.address);
    expect(await comet.numAssets()).to.equal(numAssetsBefore);

    for (let i = 0; i < numAssetsBefore; i++) {
      const info = await comet.getAssetInfo(i);
      expect(info).to.deep.equal(await assetList.getAssetInfo(i));

      // The factors must read back exactly as before: a stored factor with more than 4 decimals was read rounded
      // down by the old packing, so a mismatch here names a factor the market really ran on a different value.
      // Only the cap keeps the old truncation, to whole tokens
      const before = assetInfosBefore[i];
      const scale = info.scale.toBigInt();
      const label = `asset ${i} (${info.asset})`;
      expect(before.asset).to.equal(info.asset);
      expect(before.priceFeed).to.equal(info.priceFeed);
      expect(before.scale).to.equal(info.scale);
      expect(before.offset).to.equal(info.offset);
      expect(before.borrowCollateralFactor, `${label} borrowCollateralFactor`).to.equal(info.borrowCollateralFactor);
      expect(before.liquidateCollateralFactor, `${label} liquidateCollateralFactor`).to.equal(info.liquidateCollateralFactor);
      expect(before.liquidationFactor, `${label} liquidationFactor`).to.equal(info.liquidationFactor);
      expect(before.supplyCap).to.equal(info.supplyCap.toBigInt() - info.supplyCap.toBigInt() % scale);
    }

    // The upgrade moved no funds and changed no accounting
    expect(await comet.totalsBasic()).to.deep.equal(totalsBasicBefore);
    expect(await baseToken.balanceOf(comet.address)).to.equal(baseBalanceBefore);
    for (let i = 0; i < assets.length; i++) {
      expect(await comet.totalsCollateral(assets[i])).to.deep.equal(totalsCollateralBefore[i]);
      expect(await comet.getCollateralReserves(assets[i])).to.equal(collateralReservesBefore[i]);
    }

    // The list now matches the immutable configs, so there is nothing to deploy
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(
      ethers.constants.AddressZero
    );

    /*//////////////////////////////////////////////////////////////
                           STEP 6: SMOKE TEST
    //////////////////////////////////////////////////////////////*/

    // The borrow position opened before the upgrades is intact. The stored principal is still the debt as it was,
    // so it stays negative and unchanged; the borrow balance only grew by the interest accrued while the proposals ran
    const { principal: principalAfter } = await comet.userBasic(albert.address);
    expect(principalAfter).to.equal(principalBefore);
    expect(principalAfter).to.be.lessThan(0);
    expect(await comet.borrowBalanceOf(albert.address)).to.be.greaterThanOrEqual(borrowBalanceBefore);
    expect(await comet.balanceOf(albert.address)).to.equal(balanceBefore);
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.equal(collateralBalanceBefore);

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // A factor change through governance reaches the Comet with no redeploy, at a precision the old packing could not hold
    const newBorrowCollateralFactor = (await comet.getAssetInfo(collateralIndex)).borrowCollateralFactor.toBigInt() - 1n;
    await executeProposal(
      context,
      bridgeReceiver,
      [configurator.address],
      ['updateAssetBorrowCollateralFactor(address,address,uint64)'],
      [
        await calldata(
          configurator.populateTransaction.updateAssetBorrowCollateralFactor(
            comet.address,
            collateralAsset.address,
            newBorrowCollateralFactor
          )
        ),
      ]
    );
    expect((await comet.getAssetInfo(collateralIndex)).borrowCollateralFactor).to.equal(newBorrowCollateralFactor);

    // The factor lives in list storage, so the immutable configs are still unchanged
    expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(
      ethers.constants.AddressZero
    );
  }
);
