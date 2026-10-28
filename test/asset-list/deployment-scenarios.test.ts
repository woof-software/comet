import { ethers, expect, takeSnapshot, SnapshotRestorer, ZERO_ADDRESS } from '../helpers';
import {
  AssetList,
  AssetListFactoryV2Mock,
  AssetListTypeHashFactoryMock,
  AssetListTypeHashMock,
  AssetListV2Mock,
  CometInterface,
  CometProxyAdmin,
  Configurator,
} from '../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ImmutableAssetConfigStruct, StorageAssetConfigStruct } from '../../build/types/AssetList';
import { deployAssetListFixture, hashConfig } from './shared';
import { AssetInfoStructOutput } from 'build/types/IAssetList';

describe('asset list deployment scenarios', function () {
  let governor: SignerWithAddress;
  let assetList: AssetList; // proxy
  let configs: ImmutableAssetConfigStruct[];
  let storageConfigs: StorageAssetConfigStruct[];
  let proxyAdmin: CometProxyAdmin;
  let configurator: Configurator;
  let comet: CometInterface;
  let cometAssetInfosBefore: AssetInfoStructOutput[]; // what the Comet read for every asset before any upgrade
  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ governor, assetList, configs, storageConfigs, proxyAdmin, configurator, comet } = await deployAssetListFixture());
    cometAssetInfosBefore = await Promise.all(configs.map((_, i) => comet.getAssetInfo(i)));
    snapshot = await takeSnapshot();
  });

  after(async () => await snapshot.restore());

  /*//////////////////////////////////////////////////////////////
                CASE 1: CONFIG UNCHANGED, CODE CHANGED
  //////////////////////////////////////////////////////////////*/

  describe('config unchanged, AssetList code changed', function () {
    let newFactory: AssetListFactoryV2Mock;
    let newImplementation: AssetListV2Mock;
    let newPriceFeed: string;

    before(async () => await snapshot.restore());

    // The configs hash the same, so the Configurator sees nothing to deploy and the manual deploy is needed
    it('sanity check: deployAssetList returns the zero address', async () => {
      expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(ZERO_ADDRESS);
    });

    it('deploys the new factory', async () => {
      newFactory = await (await ethers.getContractFactory('AssetListFactoryV2Mock')).deploy() as AssetListFactoryV2Mock;
    });

    it('deploys the new implementation from the current immutable configs', async () => {
      const immutableConfigs = await configurator.getImmutableAssetConfig(comet.address);
      const address = await newFactory.callStatic.createAssetList(immutableConfigs, configurator.address);
      await newFactory.createAssetList(immutableConfigs, configurator.address);
      newImplementation = await ethers.getContractAt('AssetListV2Mock', address) as AssetListV2Mock;
    });

    it('the new implementation has the configHash of the current list', async () => {
      expect(await newImplementation.configHash()).to.equal(await assetList.configHash());
    });

    it('upgrades the asset list proxy', async () => {
      await proxyAdmin.connect(governor).upgrade(assetList.address, newImplementation.address);
    });

    it('version() answers through the proxy', async () => {
      expect(await newImplementation.attach(assetList.address).version()).to.equal(2);
    });

    it('keeps the factors and supply cap of every asset', async () => {
      for (let i = 0; i < configs.length; i++) {
        const info = await assetList.getAssetInfo(i);
        expect(info.borrowCollateralFactor).to.equal(storageConfigs[i].borrowCollateralFactor);
        expect(info.liquidateCollateralFactor).to.equal(storageConfigs[i].liquidateCollateralFactor);
        expect(info.liquidationFactor).to.equal(storageConfigs[i].liquidationFactor);
        expect(info.supplyCap).to.equal(storageConfigs[i].supplyCap);
      }
    });

    // Looking an asset up by address fails unless it is registered
    it('keeps every asset registered', async () => {
      for (const { asset } of configs) {
        expect((await assetList.getAssetInfoByAddress(asset)).asset).to.equal(asset);
      }
    });

    it('keeps the configurator', async () => {
      expect(await assetList.configurator()).to.equal(configurator.address);
    });

    it('the Comet reads every asset the same way, with no Comet redeploy', async () => {
      for (let i = 0; i < configs.length; i++) {
        expect(await comet.getAssetInfo(i)).to.deep.equal(cometAssetInfosBefore[i]);
      }
    });

    it('sets the new factory on the Configurator', async () => {
      await configurator.connect(governor).setAssetListFactory(comet.address, newFactory.address);
    });

    it('updates the price feed of the first asset', async () => {
      newPriceFeed = (await (await ethers.getContractFactory('SimplePriceFeed')).deploy(10n ** 8n, 8)).address;
      await configurator.connect(governor).updateAssetPriceFeed(comet.address, configs[0].asset, newPriceFeed);
    });

    it('deploys and upgrades through deployAndUpgradeAssetListTo', async () => {
      await proxyAdmin.connect(governor).deployAndUpgradeAssetListTo(configurator.address, comet.address);
    });

    it('the list reads the new price feed', async () => {
      expect((await assetList.getAssetInfo(0)).priceFeed).to.equal(newPriceFeed);
    });

    it('version() still answers through the proxy', async () => {
      expect(await newImplementation.attach(assetList.address).version()).to.equal(2);
    });
  });

  /*//////////////////////////////////////////////////////////////
                       CASE 2: TYPEHASH UPDATED
  //////////////////////////////////////////////////////////////*/

  // AssetListTypeHashMock is a full copy of AssetList with only the TYPEHASH changed, so it has to be kept in sync with
  // contracts/AssetList.sol by hand: after any change there, copy it into the mock as well
  describe('TYPEHASH updated', function () {
    const NEW_TYPEHASH = ethers.utils.id('ImmutableConfigV2[](address asset,address priceFeed)');

    let newFactory: AssetListTypeHashFactoryMock;
    let newImplementation: AssetListTypeHashMock;
    let newPriceFeed: string;

    before(async () => await snapshot.restore());

    // The hash check uses the current list's TYPEHASH, and the configs are unchanged
    it('deployAssetList returns the zero address before the deploy', async () => {
      expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(ZERO_ADDRESS);
    });

    it('deploys the new factory', async () => {
      newFactory = await (await ethers.getContractFactory('AssetListTypeHashFactoryMock')).deploy() as AssetListTypeHashFactoryMock;
    });

    it('deploys the new implementation from the current immutable configs', async () => {
      const immutableConfigs = await configurator.getImmutableAssetConfig(comet.address);
      const address = await newFactory.callStatic.createAssetList(immutableConfigs, configurator.address);
      await newFactory.createAssetList(immutableConfigs, configurator.address);
      newImplementation = await ethers.getContractAt('AssetListTypeHashMock', address) as AssetListTypeHashMock;
    });

    it('the new implementation has the new TYPEHASH', async () => {
      expect(await newImplementation.TYPEHASH()).to.equal(NEW_TYPEHASH);
    });

    it('the new implementation hashes the same configs with the new TYPEHASH', async () => {
      expect(await newImplementation.configHash()).to.equal(hashConfig(configs, NEW_TYPEHASH));
    });

    it('so its configHash differs from the current list', async () => {
      expect(await newImplementation.configHash()).to.not.equal(await assetList.configHash());
    });

    it('upgrades the asset list proxy', async () => {
      await proxyAdmin.connect(governor).upgrade(assetList.address, newImplementation.address);
    });

    it('the proxy reports the new TYPEHASH', async () => {
      expect(await assetList.TYPEHASH()).to.equal(NEW_TYPEHASH);
    });

    it('the proxy reports the new configHash', async () => {
      expect(await assetList.configHash()).to.equal(hashConfig(configs, NEW_TYPEHASH));
    });

    it('keeps the factors and supply cap of every asset', async () => {
      for (let i = 0; i < configs.length; i++) {
        const info = await assetList.getAssetInfo(i);
        expect(info.borrowCollateralFactor).to.equal(storageConfigs[i].borrowCollateralFactor);
        expect(info.liquidateCollateralFactor).to.equal(storageConfigs[i].liquidateCollateralFactor);
        expect(info.liquidationFactor).to.equal(storageConfigs[i].liquidationFactor);
        expect(info.supplyCap).to.equal(storageConfigs[i].supplyCap);
      }
    });

    // Looking an asset up by address fails unless it is registered
    it('keeps every asset registered', async () => {
      for (const { asset } of configs) {
        expect((await assetList.getAssetInfoByAddress(asset)).asset).to.equal(asset);
      }
    });

    it('keeps the configurator', async () => {
      expect(await assetList.configurator()).to.equal(configurator.address);
    });

    it('the Comet reads every asset the same way, with no Comet redeploy', async () => {
      for (let i = 0; i < configs.length; i++) {
        expect(await comet.getAssetInfo(i)).to.deep.equal(cometAssetInfosBefore[i]);
      }
    });

    // The check now hashes with the new TYPEHASH, which matches the new configHash
    it('deployAssetList returns the zero address after the upgrade', async () => {
      expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(ZERO_ADDRESS);
    });

    it('sets the new factory on the Configurator', async () => {
      await configurator.connect(governor).setAssetListFactory(comet.address, newFactory.address);
    });

    it('updates the price feed of the first asset', async () => {
      newPriceFeed = (await (await ethers.getContractFactory('SimplePriceFeed')).deploy(10n ** 8n, 8)).address;
      await configurator.connect(governor).updateAssetPriceFeed(comet.address, configs[0].asset, newPriceFeed);
    });

    it('deploys and upgrades through deployAndUpgradeAssetListTo', async () => {
      await proxyAdmin.connect(governor).deployAndUpgradeAssetListTo(configurator.address, comet.address);
    });

    it('the list reads the new price feed', async () => {
      expect((await assetList.getAssetInfo(0)).priceFeed).to.equal(newPriceFeed);
    });

    it('the new implementation keeps the new TYPEHASH', async () => {
      expect(await assetList.TYPEHASH()).to.equal(NEW_TYPEHASH);
    });

    it('its configHash is the updated configs hashed with the new TYPEHASH', async () => {
      const updatedConfigs = configs.map((config, i) => (i === 0 ? { ...config, priceFeed: newPriceFeed } : config));
      expect(await assetList.configHash()).to.equal(hashConfig(updatedConfigs, NEW_TYPEHASH));
    });
  });
});
