import { ethers, expect, takeSnapshot, SnapshotRestorer } from '../helpers';
import { AssetList, AssetList__factory, CometInterface, CometProxyAdmin, Configurator, FaucetToken } from '../../build/types';
import { AssetInfoStructOutput, ImmutableAssetConfigStruct, StorageAssetConfigStruct } from '../../build/types/AssetList';
import { AssetConfigStruct, AssetConfigStructOutput } from '../../build/types/Configurator';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import {
  ASSET_DECIMALS,
  LIQUIDATE_CF,
  MAX_ASSETS,
  deployAssetConfig,
  deployAssetListFixture,
  deployImmutableAssetConfig,
  hashConfig,
  impersonate,
} from './shared';

// Adding an asset to a live market takes four steps:
//   1. Configurator.addAsset appends the full config to the stored configs.
//   2. Configurator.deployAssetList builds a new list implementation that has the asset in its immutables.
//   3. The list proxy is upgraded to it; CometProxyAdmin.deployAndUpgradeAssetListTo does 2 and 3 together.
//   4. Configurator.setAssetConfigToAssetList registers the asset in the list with the factors and cap of the stored config.
describe('asset list add asset: full flow through the Configurator', function () {
  const ZERO = ethers.constants.AddressZero;
  const FACTOR = 10n ** 16n; // 0.01
  const MAX_COLLATERAL_FACTOR = 10n ** 18n;
  const NUM_ASSETS = ASSET_DECIMALS.length; // assets of the fixture; also the index the new asset gets
  const NEW_ASSET_DECIMALS = 8;
  const IMMUTABLE_KEYS = ['asset', 'decimals', 'priceFeed'] as const;
  const STORAGE_KEYS = ['borrowCollateralFactor', 'liquidateCollateralFactor', 'liquidationFactor', 'supplyCap'] as const;

  let AssetListContractFactory: AssetList__factory;
  let assetList: AssetList;
  let configs: ImmutableAssetConfigStruct[];
  let storageConfigs: StorageAssetConfigStruct[];
  let proxyAdmin: CometProxyAdmin;
  let configurator: Configurator;
  let comet: CometInterface;
  let governor: SignerWithAddress;
  let other: SignerWithAddress;
  let newAssetConfig: AssetConfigStruct;
  let asset: string;

  const storedConfigs = () => configurator.getAssetConfigs(comet.address);
  const listConfigs = () => Promise.all(ASSET_DECIMALS.map((_, i) => assetList.getAssetInfo(i)));
  const upgradeAssetList = () => proxyAdmin.deployAndUpgradeAssetListTo(configurator.address, comet.address);

  before(async () => {
    ({
      AssetListContractFactory,
      assetList,
      configs,
      storageConfigs,
      proxyAdmin,
      configurator,
      comet,
      governor,
      users: [other],
    } = await deployAssetListFixture());
    newAssetConfig = await deployAssetConfig(NEW_ASSET_DECIMALS);
    asset = newAssetConfig.asset;
  });

  describe('step 1: addAsset', function () {
    let tx: ContractTransaction;
    let storedBefore: AssetConfigStructOutput[];
    let storedAfter: AssetConfigStructOutput[];

    before(async () => {
      storedBefore = await storedConfigs();
      tx = await configurator.addAsset(comet.address, newAssetConfig);
      storedAfter = await storedConfigs();
    });

    it('succeeds for the governor', async () => {
      await expect(tx).to.not.be.reverted;
    });

    it('appends the full config at the end of the stored configs', async () => {
      expect(storedAfter.length).to.equal(NUM_ASSETS + 1);
      for (const key of [...IMMUTABLE_KEYS, ...STORAGE_KEYS]) expect(storedAfter[NUM_ASSETS][key]).to.equal(newAssetConfig[key]);
    });

    it('emits AddAsset on the Configurator with the full config', async () => {
      const { args } = (await tx.wait()).events.find((event) => event.event == 'AddAsset');
      expect(args.cometProxy).to.equal(comet.address);
      for (const key of [...IMMUTABLE_KEYS, ...STORAGE_KEYS]) expect(args.assetConfig[key]).to.equal(newAssetConfig[key]);
    });

    it('leaves the existing configs unchanged', async () => {
      expect(storedAfter.slice(0, NUM_ASSETS)).to.deep.equal(storedBefore);
    });

    it('makes getAssetIndex return the new index', async () => {
      expect(await configurator.getAssetIndex(comet.address, asset)).to.equal(NUM_ASSETS);
    });

    it('includes the new asset in getImmutableAssetConfig', async () => {
      const immutableConfig = (await configurator.getImmutableAssetConfig(comet.address))[NUM_ASSETS];
      for (const key of IMMUTABLE_KEYS) expect(immutableConfig[key]).to.equal(newAssetConfig[key]);
    });

    it('includes the new asset in getStorageAssetConfig', async () => {
      const storageConfig = (await configurator.getStorageAssetConfig(comet.address))[NUM_ASSETS];
      for (const key of STORAGE_KEYS) expect(storageConfig[key]).to.equal(newAssetConfig[key]);
    });
  });

  describe('between step 1 and the upgrade', function () {
    it('the list still has the same number of assets', async () => {
      expect(await assetList.numAssets()).to.equal(NUM_ASSETS);
    });

    it('the list does not know the asset', async () => {
      await expect(assetList.getAssetInfoByAddress(asset)).to.be.revertedWithCustomError(assetList, 'BadAsset');
    });

    it('the Comet still has the same number of assets', async () => {
      expect(await comet.numAssets()).to.equal(NUM_ASSETS);
    });

    it('the Comet does not know the asset', async () => {
      await expect(comet.getAssetInfoByAddress(asset)).to.be.revertedWithCustomError(assetList, 'BadAsset');
    });

    it('deployAssetList returns a non-zero address, as the hash of the configs changed', async () => {
      expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.not.equal(ZERO);
    });
  });

  describe('redeploy and upgrade', function () {
    let tx: ContractTransaction;
    let listBefore: AssetInfoStructOutput[];
    let newImplementation: AssetList;
    let assetInfo: AssetInfoStructOutput;

    before(async () => {
      listBefore = await listConfigs();
      tx = await upgradeAssetList();
      newImplementation = AssetListContractFactory.attach(await proxyAdmin.getProxyImplementation(assetList.address));
      assetInfo = await assetList.getAssetInfo(NUM_ASSETS);
    });

    it('succeeds through the proxy admin', async () => {
      await expect(tx).to.not.be.reverted;
    });

    it('the new implementation has one more asset', async () => {
      expect(await newImplementation.numAssets()).to.equal(NUM_ASSETS + 1);
    });

    it('the new implementation has the asset in its last slot', async () => {
      expect((await newImplementation.getAssetInfo(NUM_ASSETS)).asset).to.equal(asset);
    });

    it('the new implementation has a configHash matching getImmutableAssetConfig', async () => {
      const immutableConfigs = await configurator.getImmutableAssetConfig(comet.address);
      expect(await newImplementation.configHash()).to.equal(hashConfig(immutableConfigs));
    });

    it('the factors and caps of the existing assets are still in the list storage', async () => {
      expect(await listConfigs()).to.deep.equal(listBefore);
    });

    it('getAssetInfo returns the address of the new asset', async () => {
      expect(assetInfo.asset).to.equal(asset);
    });

    it('getAssetInfo returns the price feed of the new asset', async () => {
      expect(assetInfo.priceFeed).to.equal(newAssetConfig.priceFeed);
    });

    it('getAssetInfo returns the scale of the new asset', async () => {
      expect(assetInfo.scale).to.equal(10n ** BigInt(NEW_ASSET_DECIMALS));
    });

    it('getAssetInfo returns zero factors and cap for the new asset, as it is not registered yet', async () => {
      for (const key of STORAGE_KEYS) expect(assetInfo[key]).to.equal(0);
    });

    it('deployAssetList returns the zero address again', async () => {
      expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(ZERO);
    });
  });

  describe('step 2: setAssetConfigToAssetList', function () {
    let tx: ContractTransaction;
    let storedBefore: AssetConfigStructOutput[];
    let listBefore: AssetInfoStructOutput[];
    let assetInfo: AssetInfoStructOutput;

    before(async () => {
      storedBefore = await storedConfigs();
      listBefore = await listConfigs();
      tx = await configurator.setAssetConfigToAssetList(comet.address, asset);
      assetInfo = await assetList.getAssetInfo(NUM_ASSETS);
    });

    it('succeeds for the governor', async () => {
      await expect(tx).to.not.be.reverted;
    });

    STORAGE_KEYS.forEach((key) => {
      it(`registers the asset with the ${key} of the stored config`, async () => {
        expect(assetInfo[key]).to.equal(newAssetConfig[key]);
      });
    });

    it('emits SetAssetConfigToAssetList on the Configurator', async () => {
      await expect(tx).to.emit(configurator, 'SetAssetConfigToAssetList').withArgs(comet.address, assetList.address, asset);
    });

    it('makes the asset list emit nothing', async () => {
      expect((await tx.wait()).logs.filter((log) => log.address == assetList.address)).to.be.empty;
    });

    it('getAssetInfoByAddress returns the same values as getAssetInfo', async () => {
      expect(await assetList.getAssetInfoByAddress(asset)).to.deep.equal(assetInfo);
    });

    it('the offset equals the index of the asset', async () => {
      expect(assetInfo.offset).to.equal(NUM_ASSETS);
    });

    it('leaves the stored configs unchanged', async () => {
      expect(await storedConfigs()).to.deep.equal(storedBefore);
    });

    it('does not change the already registered assets', async () => {
      expect(await listConfigs()).to.deep.equal(listBefore);
    });
  });

  describe(`step 2 (list filled to ${MAX_ASSETS} assets)`, function () {
    let snapshot: SnapshotRestorer;
    let lastAsset: string;

    before(async () => {
      snapshot = await takeSnapshot();
      const addedAssets: string[] = [];
      for (let i = NUM_ASSETS + 1; i < MAX_ASSETS; i++) {
        const assetConfig = await deployAssetConfig();
        await configurator.addAsset(comet.address, assetConfig);
        addedAssets.push(assetConfig.asset);
      }
      await upgradeAssetList();
      for (const addedAsset of addedAssets) await configurator.setAssetConfigToAssetList(comet.address, addedAsset);
      lastAsset = addedAssets[addedAssets.length - 1];
    });

    after(async () => await snapshot.restore());

    it('the list has all slots taken', async () => {
      expect(await assetList.numAssets()).to.equal(MAX_ASSETS);
    });

    it('the offset of the asset in the last slot equals its index', async () => {
      expect((await assetList.getAssetInfoByAddress(lastAsset)).offset).to.equal(MAX_ASSETS - 1);
    });
  });

  describe('after the Comet redeploy', function () {
    before(async () => {
      await proxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);
    });

    it('the Comet has one more asset', async () => {
      expect(await comet.numAssets()).to.equal(NUM_ASSETS + 1);
    });

    it('getAssetInfo of the Comet returns the new asset', async () => {
      expect((await comet.getAssetInfo(NUM_ASSETS)).asset).to.equal(asset);
    });

    it('supplying the new asset works up to its cap', async () => {
      const token = (await ethers.getContractAt('FaucetToken', asset)) as FaucetToken;
      await token.allocateTo(other.address, newAssetConfig.supplyCap);
      await token.connect(other).approve(comet.address, newAssetConfig.supplyCap);
      await expect(comet.connect(other).supply(asset, newAssetConfig.supplyCap)).to.not.be.reverted;
    });
  });

  describe('additional checks after adding new asset', function () {
    describe('the four setter flows on the new asset', function () {
      let snapshot: SnapshotRestorer;
      let assetInfo: AssetInfoStructOutput;

      before(async () => {
        snapshot = await takeSnapshot();
        await configurator.updateAssetBorrowCollateralFactor(comet.address, asset, 70n * FACTOR);
        await configurator.updateAssetLiquidateCollateralFactor(comet.address, asset, 85n * FACTOR);
        await configurator.updateAssetLiquidationFactor(comet.address, asset, 95n * FACTOR);
        await configurator.updateAssetSupplyCap(comet.address, asset, 123);
        assetInfo = await assetList.getAssetInfo(NUM_ASSETS);
      });

      after(async () => await snapshot.restore());

      it('updateAssetBorrowCollateralFactor reaches the list', async () => {
        expect(assetInfo.borrowCollateralFactor).to.equal(70n * FACTOR);
      });

      it('updateAssetLiquidateCollateralFactor reaches the list', async () => {
        expect(assetInfo.liquidateCollateralFactor).to.equal(85n * FACTOR);
      });

      it('updateAssetLiquidationFactor reaches the list', async () => {
        expect(assetInfo.liquidationFactor).to.equal(95n * FACTOR);
      });

      it('updateAssetSupplyCap reaches the list', async () => {
        expect(assetInfo.supplyCap).to.equal(123);
      });
    });

    describe('de-listed configs', function () {
      let snapshot: SnapshotRestorer;
      let softDelisted: AssetConfigStruct;
      let fullyDelisted: AssetConfigStruct;

      before(async () => {
        snapshot = await takeSnapshot();
        softDelisted = await deployAssetConfig(18, { borrowCollateralFactor: 0 });
        fullyDelisted = await deployAssetConfig(18, { borrowCollateralFactor: 0, liquidateCollateralFactor: 0 });
        await configurator.addAsset(comet.address, softDelisted);
        await configurator.addAsset(comet.address, fullyDelisted);
        await upgradeAssetList();
      });

      after(async () => await snapshot.restore());

      it('a soft de-listed config (borrowCF = 0, liquidateCF > 0) is added to the list', async () => {
        await expect(configurator.setAssetConfigToAssetList(comet.address, softDelisted.asset)).to.not.be.reverted;
      });

      it('a fully de-listed config (borrowCF = liquidateCF = 0) is added to the list', async () => {
        await expect(configurator.setAssetConfigToAssetList(comet.address, fullyDelisted.asset)).to.not.be.reverted;
      });
    });
  });

  describe('access', function () {
    it('step 1 reverts for anyone but the governor', async () => {
      await expect(configurator.connect(other).addAsset(comet.address, newAssetConfig))
        .to.be.revertedWithCustomError(configurator, 'Unauthorized');
    });

    it('step 2 reverts for anyone but the governor', async () => {
      await expect(configurator.connect(other).setAssetConfigToAssetList(comet.address, asset))
        .to.be.revertedWithCustomError(configurator, 'Unauthorized');
    });

    // AssetList.setAssetConfig itself is for the Configurator only

    it('AssetList.setAssetConfig reverts when called directly by the governor', async () => {
      await expect(assetList.connect(governor).setAssetConfig(asset, storageConfigs[0]))
        .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
    });

    it('AssetList.setAssetConfig reverts when called directly by a random account', async () => {
      await expect(assetList.connect(other).setAssetConfig(asset, storageConfigs[0]))
        .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
    });

    it('AssetList.setAssetConfig reverts when called directly by the proxy admin, which never reaches the implementation', async () => {
      await expect(assetList.connect(await impersonate(proxyAdmin.address)).setAssetConfig(asset, storageConfigs[0]))
        .to.be.revertedWith('TransparentUpgradeableProxy: admin cannot fallback to proxy target');
    });
  });

  describe('revert when', function () {
    let snapshot: SnapshotRestorer;

    beforeEach(async () => (snapshot = await takeSnapshot()));
    afterEach(async () => await snapshot.restore());

    // Redeploy: the AssetList constructor rejects the config, and the error passes through deployAssetList

    it('redeploy: the price feed of the new config does not have 8 decimals', async () => {
      const { priceFeed } = await deployImmutableAssetConfig(18, 18);
      await configurator.addAsset(comet.address, await deployAssetConfig(18, { priceFeed }));
      await expect(configurator.deployAssetList(comet.address)).to.be.revertedWithCustomError(assetList, 'PriceFeedDecimalsNotMatched');
    });

    it('redeploy: the decimals of the new config differ from the token decimals', async () => {
      await configurator.addAsset(comet.address, await deployAssetConfig(18, { decimals: 9 }));
      await expect(configurator.deployAssetList(comet.address)).to.be.revertedWithCustomError(assetList, 'AssetDecimalsNotMatched');
    });

    it('redeploy: the new asset has more than 19 decimals', async () => {
      await configurator.addAsset(comet.address, await deployAssetConfig(20));
      await expect(configurator.deployAssetList(comet.address)).to.be.revertedWithCustomError(assetList, 'MaxAssetDecimalsExceeds');
    });

    it('step 1: the asset is already in the stored configs', async () => {
      await expect(configurator.addAsset(comet.address, { ...(await storedConfigs())[0] }))
        .to.be.revertedWithCustomError(configurator, 'AssetAlreadyExists');
    });

    it('step 2: the asset is not in the stored configs', async () => {
      await expect(configurator.setAssetConfigToAssetList(comet.address, other.address))
        .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
    });

    it('step 2: the asset is the zero address', async () => {
      await expect(configurator.setAssetConfigToAssetList(comet.address, ZERO))
        .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
    });

    it('step 2: AssetList.setAssetConfig is called by the Configurator with the zero address', async () => {
      await expect(assetList.connect(await impersonate(configurator.address)).setAssetConfig(ZERO, storageConfigs[0]))
        .to.be.revertedWithCustomError(assetList, 'AssetNotInImmutables');
    });

    it('step 2: the list proxy is not upgraded yet, so the asset is not in the immutables', async () => {
      const assetConfig = await deployAssetConfig();
      await configurator.addAsset(comet.address, assetConfig);
      await expect(configurator.setAssetConfigToAssetList(comet.address, assetConfig.asset))
        .to.be.revertedWithCustomError(assetList, 'AssetNotInImmutables');
    });

    // Step 1 does not check the factors, so a bad stored config is rejected only by the list, at step 2
    ([
      ['borrowCF equal to liquidateCF', { borrowCollateralFactor: LIQUIDATE_CF }, 'BorrowCFTooLarge'],
      ['borrowCF above liquidateCF', { borrowCollateralFactor: LIQUIDATE_CF + FACTOR }, 'BorrowCFTooLarge'],
      ['borrowCF above zero with liquidateCF = 0', { liquidateCollateralFactor: 0 }, 'BorrowCFTooLarge'],
      [
        'liquidateCF above 1e18',
        { liquidateCollateralFactor: MAX_COLLATERAL_FACTOR + 1n, liquidationFactor: MAX_COLLATERAL_FACTOR },
        'LiquidateCFTooLarge',
      ],
      ['liquidationFactor above 1e18', { liquidationFactor: MAX_COLLATERAL_FACTOR + 1n }, 'LiqPenaltyTooHigh'],
    ] as [string, Partial<AssetConfigStruct>, string][]).forEach(([name, factors, error]) => {
      it(`step 2: the stored config has ${name}`, async () => {
        const assetConfig = await deployAssetConfig(18, factors);
        await configurator.addAsset(comet.address, assetConfig);
        await upgradeAssetList();
        await expect(configurator.setAssetConfigToAssetList(comet.address, assetConfig.asset))
          .to.be.revertedWithCustomError(assetList, error);
      });
    });

    it('step 2: the asset list is not set for the Comet proxy', async () => {
      // A Comet proxy the Configurator has asset configs for, but no configuration, so no asset list
      const assetConfig = await deployAssetConfig();
      await configurator.addAsset(other.address, assetConfig);
      await expect(configurator.setAssetConfigToAssetList(other.address, assetConfig.asset)).to.be.reverted;
    });
  });
  
  // Step 2 on an asset that is already registered replaces its whole storage config with the stored one
  describe('step 2 on an asset already registered', function () {
    const UPDATED = {
      borrowCollateralFactor: 50n * FACTOR,
      liquidateCollateralFactor: 60n * FACTOR,
      liquidationFactor: 70n * FACTOR,
      supplyCap: 123n,
    };

    let snapshot: SnapshotRestorer;

    before(async () => (snapshot = await takeSnapshot()));
    after(async () => await snapshot.restore());

    context('registered by initialize', function () {
      let configuratorAssetConfigsBefore: AssetConfigStructOutput[];
      let assetListAssetConfigsBefore: AssetInfoStructOutput[];

      before(async () => {
        configuratorAssetConfigsBefore = await storedConfigs();
        assetListAssetConfigsBefore = await Promise.all(
          [...Array(await assetList.numAssets()).keys()].map((i) => assetList.getAssetInfo(i))
        );
      });

      it('updates the stored config', async () => {
        await configurator.updateAsset(comet.address, { ...configuratorAssetConfigsBefore[0], ...UPDATED });
      });

      it('before step 2 the list still reads the old factors and supply cap', async () => {
        const info = await assetList.getAssetInfo(0);
        for (const key of STORAGE_KEYS) expect(info[key]).to.equal(assetListAssetConfigsBefore[0][key]);
      });

      it('step 2 succeeds', async () => {
        await expect(configurator.setAssetConfigToAssetList(comet.address, configs[0].asset))
          .to.emit(configurator, 'SetAssetConfigToAssetList')
          .withArgs(comet.address, assetList.address, configs[0].asset);
      });

      it('the list reads the new factors and supply cap', async () => {
        const info = await assetList.getAssetInfo(0);
        for (const key of STORAGE_KEYS) expect(info[key]).to.equal(UPDATED[key]);
      });

      it('the Comet reads the new factors and supply cap', async () => {
        const info = await comet.getAssetInfo(0);
        for (const key of STORAGE_KEYS) expect(info[key]).to.equal(UPDATED[key]);
      });
    });

    context('registered by an earlier step 2', function () {
      let configuratorAssetConfigsBefore: AssetConfigStructOutput[];
      let assetListAssetConfigsBefore: AssetInfoStructOutput[];

      before(async () => {
        configuratorAssetConfigsBefore = await storedConfigs();
        assetListAssetConfigsBefore = await Promise.all(
          [...Array(await assetList.numAssets()).keys()].map((i) => assetList.getAssetInfo(i))
        );
      });

      it('updates the stored config', async () => {
        await configurator.updateAsset(comet.address, { ...configuratorAssetConfigsBefore[NUM_ASSETS], ...UPDATED });
      });

      it('before step 2 the list still reads the old factors and supply cap', async () => {
        const info = await assetList.getAssetInfo(NUM_ASSETS);
        for (const key of STORAGE_KEYS) expect(info[key]).to.equal(assetListAssetConfigsBefore[NUM_ASSETS][key]);
      });

      it('step 2 succeeds', async () => {
        await expect(configurator.setAssetConfigToAssetList(comet.address, asset))
          .to.emit(configurator, 'SetAssetConfigToAssetList')
          .withArgs(comet.address, assetList.address, asset);
      });

      it('the list reads the new factors and supply cap', async () => {
        const info = await assetList.getAssetInfoByAddress(asset);
        for (const key of STORAGE_KEYS) expect(info[key]).to.equal(UPDATED[key]);
      });

      it('the Comet reads the new factors and supply cap', async () => {
        const info = await comet.getAssetInfo(NUM_ASSETS);
        for (const key of STORAGE_KEYS) expect(info[key]).to.equal(UPDATED[key]);
      });
    });
  });
});
