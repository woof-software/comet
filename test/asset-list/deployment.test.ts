import { ethers, expect } from '../helpers';
import { AssetList, AssetList__factory, CometProxyAdmin, Configurator } from '../../build/types';
import { AssetInfoStructOutput, ImmutableAssetConfigStruct, StorageAssetConfigStruct } from '../../build/types/AssetList';
import {
  ASSET_DECIMALS,
  MAX_ASSETS,
  MAX_ASSET_DECIMALS,
  deployAssetListFixture,
  deployAssetListProxy,
  deployImmutableAssetConfig,
  deployImmutableAssetConfigs,
  hashConfig,
} from './shared';

// The AssetList constructor takes the immutable part of the asset configs (asset, decimals, price feed), checks it
// and packs each asset into its own pair of immutables. It also fixes the number of assets and the hash of the
// configs. Factors and supply caps are not part of it: they are set later, when a proxy is initialized.
describe('asset list deployment: constructor', function () {
  const ZERO = ethers.constants.AddressZero;

  let AssetListContractFactory: AssetList__factory;
  let assetList: AssetList; // the implementation, not initialized
  let configs: ImmutableAssetConfigStruct[];
  let configurator: Configurator;

  before(async () => {
    ({ AssetListContractFactory, assetListImplementation: assetList, configs, configurator } = await deployAssetListFixture());
  });

  describe('happy path', function () {
    it('deploys with the list of immutable configs', async () => {
      expect((await assetList.deployTransaction.wait()).status).to.equal(1);
    });

    it('sets numAssets to the number of configs', async () => {
      expect(await assetList.numAssets()).to.equal(configs.length);
    });

    it('sets configHash to the hash of the immutable configs', async () => {
      expect(await assetList.configHash()).to.equal(hashConfig(configs));
    });

    it('sets the configurator', async () => {
      expect(await assetList.configurator()).to.equal(configurator.address);
    });

    it('the implementation cannot be initialized', async () => {
      await expect(assetList.initialize([])).to.be.revertedWith('Initializable: contract is already initialized');
    });

    // Both ends of the allowed decimals are among the fixture assets
    const notes = { 0: ', the smallest', [MAX_ASSET_DECIMALS]: ', the largest whose scale fits in uint64' };

    ASSET_DECIMALS.forEach((decimals, i) => {
      describe(`asset #${i} (${decimals} decimals${notes[decimals] ?? ''})`, function () {
        let assetInfo: AssetInfoStructOutput;

        before(async () => {
          assetInfo = await assetList.getAssetInfo(i);
        });

        it('stores the asset', async () => {
          expect(assetInfo.asset).to.equal(configs[i].asset);
        });

        it('stores the price feed', async () => {
          expect(assetInfo.priceFeed).to.equal(configs[i].priceFeed);
        });

        it(`has offset ${i}`, async () => {
          expect(assetInfo.offset).to.equal(i);
        });

        it(`has scale 10 ** ${decimals}`, async () => {
          expect(assetInfo.scale).to.equal(10n ** BigInt(decimals));
        });
      });
    });
  });

  describe('happy path (same configs in a different order)', function () {
    let reorderedConfigs: ImmutableAssetConfigStruct[];
    let reorderedAssetList: AssetList;

    before(async () => {
      reorderedConfigs = [...configs].reverse();
      reorderedAssetList = await AssetListContractFactory.deploy(reorderedConfigs, configurator.address);
      await reorderedAssetList.deployed();
    });

    it('sets configHash to the hash of the reordered configs', async () => {
      expect(await reorderedAssetList.configHash()).to.equal(hashConfig(reorderedConfigs));
    });

    it('gives a different configHash than the original order', async () => {
      expect(await reorderedAssetList.configHash()).to.not.equal(await assetList.configHash());
    });
  });

  describe(`happy path (${MAX_ASSETS} assets, all slots)`, function () {
    let fullConfigs: ImmutableAssetConfigStruct[];
    let fullAssetList: AssetList;
    let assetInfos: AssetInfoStructOutput[];

    before(async () => {
      fullConfigs = await deployImmutableAssetConfigs(Array(MAX_ASSETS).fill(18));
      fullAssetList = await AssetListContractFactory.deploy(fullConfigs, configurator.address);
      await fullAssetList.deployed();

      assetInfos = [];
      for (let i = 0; i < MAX_ASSETS; i++) assetInfos.push(await fullAssetList.getAssetInfo(i));
    });

    it(`sets numAssets to ${MAX_ASSETS}`, async () => {
      expect(await fullAssetList.numAssets()).to.equal(MAX_ASSETS);
    });

    for (let i = 0; i < MAX_ASSETS; i++) {
      it(`slot #${i} holds its asset`, async () => {
        expect(assetInfos[i].asset).to.equal(fullConfigs[i].asset);
      });

      it(`slot #${i} holds its price feed`, async () => {
        expect(assetInfos[i].priceFeed).to.equal(fullConfigs[i].priceFeed);
      });

      it(`slot #${i} has offset ${i}`, async () => {
        expect(assetInfos[i].offset).to.equal(i);
      });

      it(`slot #${i} has scale 10 ** 18`, async () => {
        expect(assetInfos[i].scale).to.equal(10n ** 18n);
      });
    }
  });

  describe('revert when', function () {
    it('the list of configs is empty', async () => {
      await expect(AssetListContractFactory.deploy([], configurator.address)).to.be.revertedWithCustomError(assetList, 'NoAssets');
    });

    it(`there are more than ${MAX_ASSETS} configs`, async () => {
      await expect(AssetListContractFactory.deploy(Array(MAX_ASSETS + 1).fill(configs[0]), configurator.address))
        .to.be.revertedWithCustomError(assetList, 'TooManyAssets');
    });

    it('a price feed does not have 8 decimals', async () => {
      const badPriceFeedConfig = await deployImmutableAssetConfig(18, 18);
      await expect(AssetListContractFactory.deploy([configs[0], badPriceFeedConfig], configurator.address))
        .to.be.revertedWithCustomError(assetList, 'PriceFeedDecimalsNotMatched');
    });

    it('the config decimals differ from the token decimals', async () => {
      await expect(AssetListContractFactory.deploy([configs[0], { ...configs[1], decimals: 9 }], configurator.address))
        .to.be.revertedWithCustomError(assetList, 'AssetDecimalsNotMatched');
    });

    it(`an asset has more than ${MAX_ASSET_DECIMALS} decimals`, async () => {
      const tooManyDecimalsConfig = await deployImmutableAssetConfig(MAX_ASSET_DECIMALS + 1);
      await expect(AssetListContractFactory.deploy([configs[0], tooManyDecimalsConfig], configurator.address))
        .to.be.revertedWithCustomError(assetList, 'MaxAssetDecimalsExceeds');
    });

    it('an asset inside the list is the zero address', async () => {
      await expect(AssetListContractFactory.deploy([configs[0], { ...configs[1], asset: ZERO }, configs[2]], configurator.address))
        .to.be.revertedWithCustomError(assetList, 'ZeroAddress');
    });

    it('the configurator is the zero address', async () => {
      await expect(AssetListContractFactory.deploy(configs, ZERO))
        .to.be.revertedWithCustomError(assetList, 'ZeroConfigurator');
    });

    it('a price feed inside the list is the zero address', async () => {
      await expect(AssetListContractFactory.deploy([configs[0], { ...configs[1], priceFeed: ZERO }, configs[2]], configurator.address))
        .to.be.revertedWithCustomError(assetList, 'ZeroAddress');
    });
  });
});

// AssetList.initialize stores the factors and the supply cap of every asset the implementation was built from.
// The configurator is already fixed by the implementation's constructor. It runs once, through the constructor
// data of the proxy; the implementation itself stays uninitialized.
describe('asset list deployment: initialize', function () {
  const MAX_COLLATERAL_FACTOR = 10n ** 18n;

  let AssetListContractFactory: AssetList__factory;
  let assetListImplementation: AssetList;
  let assetList: AssetList;
  let configs: ImmutableAssetConfigStruct[];
  let storageConfigs: StorageAssetConfigStruct[];
  let proxyAdmin: CometProxyAdmin;
  let configurator: Configurator;

  // Initializes a new proxy of the fixture implementation with one asset's factors replaced.
  const initializeWithFactors = (factors: Partial<StorageAssetConfigStruct>) =>
    deployAssetListProxy(
      assetListImplementation,
      proxyAdmin.address,
      storageConfigs.map((config, i) => (i == storageConfigs.length - 1 ? { ...config, ...factors } : config))
    );

  before(async () => {
    ({
      AssetListContractFactory,
      assetListImplementation,
      assetList,
      configs,
      storageConfigs,
      proxyAdmin,
      configurator,
    } = await deployAssetListFixture());
  });

  describe('happy path (through the proxy constructor data)', function () {
    it('the proxy sees the configurator of the implementation', async () => {
      expect(await assetList.configurator()).to.equal(configurator.address);
    });

    it('the implementation holds the same configurator, as an immutable', async () => {
      expect(await assetListImplementation.configurator()).to.equal(configurator.address);
    });

    it('stores no asset config in the implementation', async () => {
      await expect(assetListImplementation.getAssetInfoByAddress(configs[0].asset))
        .to.be.revertedWithCustomError(assetList, 'BadAsset');
    });

    ASSET_DECIMALS.forEach((decimals, i) => {
      describe(`asset #${i} (${decimals} decimals)`, function () {
        let assetInfo: AssetInfoStructOutput;

        before(async () => {
          assetInfo = await assetList.getAssetInfo(i);
        });

        it('stores the borrow collateral factor', async () => {
          expect(assetInfo.borrowCollateralFactor).to.equal(storageConfigs[i].borrowCollateralFactor);
        });

        it('stores the liquidate collateral factor', async () => {
          expect(assetInfo.liquidateCollateralFactor).to.equal(storageConfigs[i].liquidateCollateralFactor);
        });

        it('stores the liquidation factor', async () => {
          expect(assetInfo.liquidationFactor).to.equal(storageConfigs[i].liquidationFactor);
        });

        it('stores the supply cap', async () => {
          expect(assetInfo.supplyCap).to.equal(storageConfigs[i].supplyCap);
        });

        it('returns the same asset info by address', async () => {
          expect(await assetList.getAssetInfoByAddress(configs[i].asset)).to.deep.equal(assetInfo);
        });
      });
    });
  });

  describe('happy path (liquidation factor at the maximum)', function () {
    it('stores the liquidation factor', async () => {
      const maxFactorAssetList = await initializeWithFactors({ liquidationFactor: MAX_COLLATERAL_FACTOR });
      expect((await maxFactorAssetList.getAssetInfo(storageConfigs.length - 1)).liquidationFactor)
        .to.equal(MAX_COLLATERAL_FACTOR);
    });
  });

  describe('revert when', function () {
    it('there are fewer storage configs than assets', async () => {
      await expect(
        deployAssetListProxy(assetListImplementation, proxyAdmin.address, storageConfigs.slice(1))
      ).to.be.revertedWithCustomError(assetList, 'StorageConfigsLengthMismatch');
    });

    it('there are more storage configs than assets', async () => {
      await expect(
        deployAssetListProxy(
          assetListImplementation,
          proxyAdmin.address,
          [...storageConfigs, storageConfigs[0]]
        )
      ).to.be.revertedWithCustomError(assetList, 'StorageConfigsLengthMismatch');
    });

    it('the same asset is listed twice', async () => {
      // The constructor does not check for duplicates, so they surface when the assets are registered
      const duplicatesImplementation = await AssetListContractFactory.deploy([configs[0], configs[0]], configurator.address);
      await expect(
        deployAssetListProxy(
          duplicatesImplementation,
          proxyAdmin.address,
          [storageConfigs[0], storageConfigs[0]]
        )
      ).to.be.revertedWithCustomError(assetList, 'AssetAlreadyAdded');
    });
  });
});
