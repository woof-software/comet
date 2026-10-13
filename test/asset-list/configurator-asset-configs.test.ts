import { ethers, expect, takeSnapshot, SnapshotRestorer } from '../helpers';
import { AssetList, CometInterface, CometProxyAdmin, Configurator, MarketAdminPermissionChecker } from '../../build/types';
import { AssetInfoStructOutput, ImmutableAssetConfigStruct } from '../../build/types/AssetList';
import { AssetConfigStruct, AssetConfigStructOutput } from '../../build/types/Configurator';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { Contract, ContractTransaction } from 'ethers';
import {
  ASSET_DECIMALS,
  MAX_ASSETS,
  deployAssetConfig,
  deployAssetListFixture,
  deployImmutableAssetConfig,
} from './shared';

// The Configurator stores the full config of every asset of a market. Immutable changes (asset, price feed,
// decimals, a new asset) reach the list through deployAssetList and an upgrade of the list proxy; storage changes
// (factors, supply cap) are written to the list by the same call that updates the stored config.
describe('configurator: assets configs management', function () {
  const ZERO = ethers.constants.AddressZero;
  const FACTOR = 10n ** 16n; // 0.01
  const NUM_ASSETS = ASSET_DECIMALS.length;
  const TARGET = 1; // index of the asset the updates are called for
  const IMMUTABLE_KEYS = ['asset', 'decimals', 'priceFeed'] as const;
  const STORAGE_KEYS = ['borrowCollateralFactor', 'liquidateCollateralFactor', 'liquidationFactor', 'supplyCap'] as const;
  const KEYS = [...IMMUTABLE_KEYS, ...STORAGE_KEYS];
  const SETTERS = [
    { field: 'BorrowCollateralFactor', key: 'borrowCollateralFactor', value: 70n * FACTOR },
    { field: 'LiquidateCollateralFactor', key: 'liquidateCollateralFactor', value: 85n * FACTOR },
    { field: 'LiquidationFactor', key: 'liquidationFactor', value: 95n * FACTOR },
    { field: 'SupplyCap', key: 'supplyCap', value: 123_456_789n },
  ] as const;

  let assetList: AssetList;
  let configs: ImmutableAssetConfigStruct[];
  let proxyAdmin: CometProxyAdmin;
  let configurator: Configurator;
  let comet: CometInterface;
  let other: SignerWithAddress;
  let asset: string;

  const storedConfigs = () => configurator.getAssetConfigs(comet.address);
  const listConfigs = () => Promise.all(ASSET_DECIMALS.map((_, i) => assetList.getAssetInfo(i)));
  const upgradeAssetList = () => proxyAdmin.deployAndUpgradeAssetListTo(configurator.address, comet.address);
  const newPriceFeed = async () => (await deployImmutableAssetConfig(18)).priceFeed;
  const without = <T>(items: T[], index: number) => items.filter((_, i) => i != index);

  before(async () => {
    ({
      assetList,
      configs,
      proxyAdmin,
      configurator,
      comet,
      users: [other],
    } = await deployAssetListFixture());
    asset = configs[TARGET].asset;
  });

  describe('add asset: addAsset (step 1) and addAssetToAssetList (step 2)', function () {
    describe('happy path (full flow)', function () {
      let snapshot: SnapshotRestorer;
      let newAssetConfig: AssetConfigStruct;
      let addTx: ContractTransaction;
      let registerTx: ContractTransaction;
      let storedBefore: AssetConfigStructOutput[];
      let storedAfterStep1: AssetConfigStructOutput[];
      let listBefore: AssetInfoStructOutput[];
      let listAfterUpgrade: AssetInfoStructOutput[];
      let lastSlotAfterUpgrade: AssetInfoStructOutput;

      before(async () => {
        snapshot = await takeSnapshot();
        newAssetConfig = await deployAssetConfig(8);
        storedBefore = await storedConfigs();
        listBefore = await listConfigs();

        addTx = await configurator.addAsset(comet.address, newAssetConfig);
        storedAfterStep1 = await storedConfigs();

        await upgradeAssetList();
        listAfterUpgrade = await listConfigs();
        lastSlotAfterUpgrade = await assetList.getAssetInfo(NUM_ASSETS);

        registerTx = await configurator.addAssetToAssetList(comet.address, newAssetConfig.asset);
        await proxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);
      });

      after(async () => await snapshot.restore());

      it('addAsset appends the full config at the index equal to the old length', async () => {
        for (const key of KEYS) expect(storedAfterStep1[storedBefore.length][key]).to.equal(newAssetConfig[key]);
      });

      it('addAsset emits AddAsset on the Configurator', async () => {
        const { args } = (await addTx.wait()).events.find((event) => event.event == 'AddAsset');
        expect(args.cometProxy).to.equal(comet.address);
        for (const key of KEYS) expect(args.assetConfig[key]).to.equal(newAssetConfig[key]);
      });

      it('addAsset leaves the existing configs unchanged', async () => {
        expect(storedAfterStep1.slice(0, storedBefore.length)).to.deep.equal(storedBefore);
      });

      it('getAssetIndex finds the new asset', async () => {
        expect(await configurator.getAssetIndex(comet.address, newAssetConfig.asset)).to.equal(storedBefore.length);
      });

      it('after deployAssetList and the proxy upgrade the new asset is in the last slot of the list', async () => {
        expect(lastSlotAfterUpgrade.asset).to.equal(newAssetConfig.asset);
      });

      it('after the proxy upgrade the factors and caps of the existing assets are still in the list storage', async () => {
        expect(listAfterUpgrade).to.deep.equal(listBefore);
      });

      it('addAssetToAssetList registers the asset in the list with the factors and cap of the stored config', async () => {
        const assetInfo = await assetList.getAssetInfo(NUM_ASSETS);
        for (const key of STORAGE_KEYS) expect(assetInfo[key]).to.equal(newAssetConfig[key]);
      });

      it('addAssetToAssetList emits AddAssetToAssetList on the Configurator', async () => {
        await expect(registerTx)
          .to.emit(configurator, 'AddAssetToAssetList')
          .withArgs(comet.address, assetList.address, newAssetConfig.asset);
      });

      it('after deployAndUpgradeTo the numAssets of the Comet is one higher', async () => {
        expect(await comet.numAssets()).to.equal(NUM_ASSETS + 1);
      });

      it('getAssetInfo of the Comet returns the new asset, with its factors and cap', async () => {
        const assetInfo = await comet.getAssetInfo(NUM_ASSETS);
        expect(assetInfo.asset).to.equal(newAssetConfig.asset);
        for (const key of STORAGE_KEYS) expect(assetInfo[key]).to.equal(newAssetConfig[key]);
      });

      it('step 2 leaves the stored configs unchanged', async () => {
        expect(await storedConfigs()).to.deep.equal(storedAfterStep1);
      });
    });

    describe(`happy path (adding into the last slot, ${MAX_ASSETS} assets in total)`, function () {
      let snapshot: SnapshotRestorer;
      let registerTx: ContractTransaction;

      before(async () => {
        snapshot = await takeSnapshot();
        const added: string[] = [];
        for (let i = NUM_ASSETS; i < MAX_ASSETS; i++) {
          const assetConfig = await deployAssetConfig();
          await configurator.addAsset(comet.address, assetConfig);
          added.push(assetConfig.asset);
        }
        await upgradeAssetList();
        for (const addedAsset of added.slice(0, -1)) await configurator.addAssetToAssetList(comet.address, addedAsset);
        registerTx = await configurator.addAssetToAssetList(comet.address, added[added.length - 1]);
      });

      after(async () => await snapshot.restore());

      it('step 2 succeeds for the asset in the last slot', async () => {
        await expect(registerTx).to.not.be.reverted;
      });

      it(`the list has ${MAX_ASSETS} assets`, async () => {
        expect(await assetList.numAssets()).to.equal(MAX_ASSETS);
      });
    });

    describe('revert when', function () {
      it('step 1: the caller is not the governor', async () => {
        await expect(configurator.connect(other).addAsset(comet.address, await deployAssetConfig()))
          .to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });

      // Step 1 has none of these checks today, so the cases below wait for them

      it.skip('step 1: the asset is already in the stored configs');

      it.skip('step 1: the asset is the zero address');

      it.skip(`step 1: there are already ${MAX_ASSETS} assets`);

      it('step 2: the caller is not the governor', async () => {
        await expect(configurator.connect(other).addAssetToAssetList(comet.address, asset))
          .to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });

      it('step 2: the asset is not in the stored configs', async () => {
        await expect(configurator.addAssetToAssetList(comet.address, other.address))
          .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
      });
    });
  });

  describe('updateAssetPriceFeed', function () {
    describe('happy path (full flow)', function () {
      let snapshot: SnapshotRestorer;
      let tx: ContractTransaction;
      let priceFeed: string;
      let storedBefore: AssetConfigStructOutput[];
      let storedAfter: AssetConfigStructOutput[];
      let listBefore: AssetInfoStructOutput[];
      let listBeforeUpgrade: AssetInfoStructOutput[];
      let cometBeforeUpgrade: AssetInfoStructOutput;
      let listAfter: AssetInfoStructOutput[];

      before(async () => {
        snapshot = await takeSnapshot();
        priceFeed = await newPriceFeed();
        storedBefore = await storedConfigs();
        listBefore = await listConfigs();

        tx = await configurator.updateAssetPriceFeed(comet.address, asset, priceFeed);
        storedAfter = await storedConfigs();
        listBeforeUpgrade = await listConfigs();
        cometBeforeUpgrade = await comet.getAssetInfo(TARGET);

        await upgradeAssetList();
        listAfter = await listConfigs();
      });

      after(async () => await snapshot.restore());

      it('succeeds for the governor', async () => {
        await expect(tx).to.not.be.reverted;
      });

      it('updates the price feed in the stored config', async () => {
        expect(storedAfter[TARGET].priceFeed).to.equal(priceFeed);
      });

      it('leaves the other fields of the stored config unchanged', async () => {
        for (const key of KEYS.filter((k) => k != 'priceFeed')) expect(storedAfter[TARGET][key]).to.equal(storedBefore[TARGET][key]);
      });

      it('emits UpdateAssetPriceFeed with the old and new feeds', async () => {
        await expect(tx)
          .to.emit(configurator, 'UpdateAssetPriceFeed')
          .withArgs(comet.address, asset, storedBefore[TARGET].priceFeed, priceFeed);
      });

      it('before the upgrade the list still reports the old feed', async () => {
        expect(listBeforeUpgrade[TARGET].priceFeed).to.equal(storedBefore[TARGET].priceFeed);
      });

      it('before the upgrade the Comet still reports the old feed', async () => {
        expect(cometBeforeUpgrade.priceFeed).to.equal(storedBefore[TARGET].priceFeed);
      });

      it('after deployAssetList and the proxy upgrade the new feed is visible through the list', async () => {
        expect(listAfter[TARGET].priceFeed).to.equal(priceFeed);
      });

      it('after the proxy upgrade the new feed is visible through the Comet with no redeploy', async () => {
        expect((await comet.getAssetInfo(TARGET)).priceFeed).to.equal(priceFeed);
      });

      it('the factors and cap of the asset are unchanged', async () => {
        for (const key of STORAGE_KEYS) expect(listAfter[TARGET][key]).to.equal(listBefore[TARGET][key]);
      });

      it('the other assets are unchanged in the stored configs', async () => {
        expect(without(storedAfter, TARGET)).to.deep.equal(without(storedBefore, TARGET));
      });

      it('the other assets are unchanged in the list', async () => {
        expect(without(listAfter, TARGET)).to.deep.equal(without(listBefore, TARGET));
      });
    });

    describe('revert when', function () {
      it('the caller is not the governor', async () => {
        await expect(configurator.connect(other).updateAssetPriceFeed(comet.address, asset, ZERO))
          .to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });

      it('the asset is not in the stored configs', async () => {
        await expect(configurator.updateAssetPriceFeed(comet.address, other.address, ZERO))
          .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
      });
    });
  });

  describe('updateAsset', function () {
    describe('happy path (immutable part changed)', function () {
      let snapshot: SnapshotRestorer;
      let tx: ContractTransaction;
      let newConfig: AssetConfigStruct;
      let storedBefore: AssetConfigStructOutput[];
      let storedAfter: AssetConfigStructOutput[];
      let newImplementation: string;

      before(async () => {
        snapshot = await takeSnapshot();
        storedBefore = await storedConfigs();
        newConfig = { ...storedBefore[TARGET], priceFeed: await newPriceFeed() };

        tx = await configurator.updateAsset(comet.address, newConfig);
        storedAfter = await storedConfigs();

        ({ newAssetListImpl: newImplementation } = await configurator.callStatic.deployAssetList(comet.address));
        await upgradeAssetList();
      });

      after(async () => await snapshot.restore());

      it('succeeds for the governor', async () => {
        await expect(tx).to.not.be.reverted;
      });

      it('replaces the stored config of the asset at its index', async () => {
        for (const key of KEYS) expect(storedAfter[TARGET][key]).to.equal(newConfig[key]);
      });

      it('leaves the other assets untouched', async () => {
        expect(without(storedAfter, TARGET)).to.deep.equal(without(storedBefore, TARGET));
      });

      it('emits UpdateAsset with the old and new configs', async () => {
        const { args } = (await tx.wait()).events.find((event) => event.event == 'UpdateAsset');
        expect(args.cometProxy).to.equal(comet.address);
        expect(args.oldAssetConfig).to.deep.equal(storedBefore[TARGET]);
        for (const key of KEYS) expect(args.newAssetConfig[key]).to.equal(newConfig[key]);
      });

      it('deployAssetList deploys a new implementation', async () => {
        expect(newImplementation).to.not.equal(ZERO);
      });

      it('after the proxy upgrade the list shows the new immutable values', async () => {
        expect((await assetList.getAssetInfo(TARGET)).priceFeed).to.equal(newConfig.priceFeed);
      });

      it('after the proxy upgrade the Comet shows the new immutable values', async () => {
        expect((await comet.getAssetInfo(TARGET)).priceFeed).to.equal(newConfig.priceFeed);
      });
    });

    describe('happy path (only the storage part changed)', function () {
      let snapshot: SnapshotRestorer;
      let listBefore: AssetInfoStructOutput[];

      before(async () => {
        snapshot = await takeSnapshot();
        listBefore = await listConfigs();
        await configurator.updateAsset(comet.address, {
          ...(await storedConfigs())[TARGET],
          borrowCollateralFactor: 50n * FACTOR,
          supplyCap: 5,
        });
      });

      after(async () => await snapshot.restore());

      it('deployAssetList returns the zero address', async () => {
        expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(ZERO);
      });

      // Open behaviour: nothing pushes these values to the list, so the stored config and the list disagree
      it('the changed factors and cap do not reach the list', async () => {
        expect(await listConfigs()).to.deep.equal(listBefore);
      });
    });

    describe('revert when', function () {
      it('the caller is not the governor', async () => {
        await expect(configurator.connect(other).updateAsset(comet.address, (await storedConfigs())[TARGET]))
          .to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });

      it('the asset is not in the stored configs', async () => {
        await expect(configurator.updateAsset(comet.address, await deployAssetConfig()))
          .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
      });
    });
  });

  // The market admin exists only in the Optimism variants of the Configurator and the proxy admin, so this block
  // runs on a market built with them
  describe('factors and supply cap: updateAsset<Field> (market with a market admin)', function () {
    let market: { configurator: Configurator, comet: CometInterface, permissionChecker: MarketAdminPermissionChecker };
    let governor: SignerWithAddress;
    let marketAdmin: SignerWithAddress;
    let marketAsset: string;

    const update = (field: string, asset_: string, value: bigint, caller: SignerWithAddress): Promise<ContractTransaction> =>
      (market.configurator.connect(caller) as unknown as Contract)[`updateAsset${field}`](market.comet.address, asset_, value);
    const marketConfigs = () => market.configurator.getAssetConfigs(market.comet.address);

    before(async () => {
      const { configurator, comet, permissionChecker, configs, ...signers } = await deployAssetListFixture(true);
      ({ governor, marketAdmin } = signers);
      market = { configurator, comet, permissionChecker };
      marketAsset = configs[TARGET].asset;
    });

    SETTERS.forEach(({ field, key, value }) => {
      describe(`updateAsset${field}: happy path (full flow)`, function () {
        let snapshot: SnapshotRestorer;
        let tx: ContractTransaction;
        let storedBefore: AssetConfigStructOutput[];
        let storedAfter: AssetConfigStructOutput[];

        before(async () => {
          snapshot = await takeSnapshot();
          storedBefore = await marketConfigs();
          tx = await update(field, marketAsset, value, marketAdmin);
          storedAfter = await marketConfigs();
        });

        after(async () => await snapshot.restore());

        it('succeeds for the governor', async () => {
          await expect(update(field, marketAsset, value, governor)).to.not.be.reverted;
        });

        it('succeeds for the market admin, through the permission checker', async () => {
          await expect(tx).to.not.be.reverted;
        });

        it('updates the field in the stored config', async () => {
          expect(storedAfter[TARGET][key]).to.equal(value);
        });

        it('emits the event with the old and new values', async () => {
          await expect(tx)
            .to.emit(market.configurator, `UpdateAsset${field}`)
            .withArgs(market.comet.address, marketAsset, storedBefore[TARGET][key], value);
        });

        it('changes only the target field of the asset', async () => {
          for (const otherKey of KEYS.filter((k) => k != key)) {
            expect(storedAfter[TARGET][otherKey]).to.equal(storedBefore[TARGET][otherKey]);
          }
        });

        it('changes only the given asset', async () => {
          expect(without(storedAfter, TARGET)).to.deep.equal(without(storedBefore, TARGET));
        });

        it('deployAssetList returns the zero address, so no upgrade is needed', async () => {
          expect((await market.configurator.callStatic.deployAssetList(market.comet.address)).newAssetListImpl).to.equal(ZERO);
        });
      });
    });

    describe('revert when', function () {
      SETTERS.forEach(({ field, value }) => {
        it(`updateAsset${field}: the caller is neither the governor nor the market admin`, async () => {
          await expect(update(field, marketAsset, value, other))
            .to.be.revertedWithCustomError(market.permissionChecker, 'Unauthorized');
        });
      });

      describe('the permission checker is paused', function () {
        let snapshot: SnapshotRestorer;

        before(async () => {
          snapshot = await takeSnapshot();
          await market.permissionChecker.connect(governor).pauseMarketAdmin();
        });

        after(async () => await snapshot.restore());

        SETTERS.forEach(({ field, value }) => {
          it(`updateAsset${field} reverts for the market admin`, async () => {
            await expect(update(field, marketAsset, value, marketAdmin))
              .to.be.revertedWithCustomError(market.permissionChecker, 'MarketAdminIsPaused');
          });
        });
      });

      SETTERS.forEach(({ field, value }) => {
        it(`updateAsset${field}: the asset is not in the stored configs`, async () => {
          await expect(update(field, other.address, value, marketAdmin))
            .to.be.revertedWithCustomError(market.configurator, 'AssetDoesNotExist');
        });
      });
    });
  });
});
