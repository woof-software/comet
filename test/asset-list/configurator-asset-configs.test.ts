import { ethers, expect, takeSnapshot, SnapshotRestorer } from '../helpers';
import { AssetList, CometInterface, CometProxyAdmin, Configurator } from '../../build/types';
import { AssetInfoStructOutput, ImmutableAssetConfigStruct } from '../../build/types/AssetList';
import { AssetConfigStruct, AssetConfigStructOutput } from '../../build/types/Configurator';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import {
  ASSET_DECIMALS,
  MAX_ASSETS,
  deployAssetConfig,
  deployAssetListFixture,
  deployImmutableAssetConfig,
} from './shared';

// The Configurator stores the full config of every asset of a market. An immutable change (asset, price feed, a new
// asset) reaches the list through a list upgrade, which deploys a new implementation and writes the storage configs
// (factors, supply cap) of all assets in the same call, registering a new asset. The per-field factor and cap setters
// write to the list at once.
describe('configurator: assets configs management', function () {
  const ZERO = ethers.constants.AddressZero;
  const NUM_ASSETS = ASSET_DECIMALS.length;
  const TARGET = 1; // index of the asset the updates are called for
  const IMMUTABLE_KEYS = ['asset', 'priceFeed'] as const;
  const STORAGE_KEYS = ['borrowCollateralFactor', 'liquidateCollateralFactor', 'liquidationFactor', 'supplyCap'] as const;
  const KEYS = [...IMMUTABLE_KEYS, ...STORAGE_KEYS];

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

  context('add asset: addAsset (step 1) and the list upgrade (step 2)', function () {
    context('happy path (full flow)', function () {
      let snapshot: SnapshotRestorer;
      let newAssetConfig: AssetConfigStruct;
      let addTx: ContractTransaction;
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

      it('the upgrade registers the asset in the list with the factors and cap of the stored config', async () => {
        for (const key of STORAGE_KEYS) expect(lastSlotAfterUpgrade[key]).to.equal(newAssetConfig[key]);
      });

      it('the upgrade makes the asset findable by its address', async () => {
        expect(await assetList.getAssetInfoByAddress(newAssetConfig.asset)).to.deep.equal(lastSlotAfterUpgrade);
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

    context(`happy path (adding into the last slot, ${MAX_ASSETS} assets in total)`, function () {
      let snapshot: SnapshotRestorer;
      let upgradeTx: ContractTransaction;
      let lastAsset: string;

      before(async () => {
        snapshot = await takeSnapshot();
        const added: string[] = [];
        for (let i = NUM_ASSETS; i < MAX_ASSETS; i++) {
          const assetConfig = await deployAssetConfig();
          await configurator.addAsset(comet.address, assetConfig);
          added.push(assetConfig.asset);
        }
        upgradeTx = await upgradeAssetList();
        lastAsset = added[added.length - 1];
      });

      after(async () => await snapshot.restore());

      it('step 2 succeeds', async () => {
        await expect(upgradeTx).to.not.be.reverted;
      });

      it('the asset in the last slot is registered at its index', async () => {
        expect((await assetList.getAssetInfoByAddress(lastAsset)).offset).to.equal(MAX_ASSETS - 1);
      });

      it(`the list has ${MAX_ASSETS} assets`, async () => {
        expect(await assetList.numAssets()).to.equal(MAX_ASSETS);
      });
    });

    context('revert when', function () {
      it('step 1: the caller is not the governor', async () => {
        await expect(configurator.connect(other).addAsset(comet.address, await deployAssetConfig()))
          .to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });

      it('step 1: the asset is already in the stored configs', async () => {
        await expect(configurator.addAsset(comet.address, (await storedConfigs())[TARGET]))
          .to.be.revertedWithCustomError(configurator, 'AssetAlreadyExists');
      });

      it('step 2: the caller is not the proxy admin owner', async () => {
        await expect(proxyAdmin.connect(other).deployAndUpgradeAssetListTo(configurator.address, comet.address))
          .to.be.revertedWithCustomError(proxyAdmin, 'OwnableUnauthorizedAccount').withArgs(other.address);
      });
    });
  });

  context('updateAssetPriceFeed', function () {
    context('happy path (full flow)', function () {
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

    context('revert when', function () {
      it('the caller is not the governor', async () => {
        await expect(configurator.connect(other).updateAssetPriceFeed(comet.address, asset, ZERO))
          .to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });

      it('the asset is not in the stored configs', async () => {
        await expect(configurator.updateAssetPriceFeed(comet.address, other.address, await newPriceFeed()))
          .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
      });

      it('the new price feed is the zero address', async () => {
        await expect(configurator.updateAssetPriceFeed(comet.address, asset, ZERO))
          .to.be.revertedWithCustomError(configurator, 'InvalidAddress');
      });
    });
  });
});
