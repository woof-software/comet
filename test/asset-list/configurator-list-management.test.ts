import { ethers, expect, takeSnapshot, SnapshotRestorer } from '../helpers';
import {
  AssetList,
  AssetList__factory,
  AssetListFactory,
  CometInterface,
  CometProxyAdmin,
  CometWithExtendedAssetList,
  Configurator,
  FaucetToken,
} from '../../build/types';
import { AssetInfoStructOutput, ImmutableAssetConfigStruct, StorageAssetConfigStruct } from '../../build/types/AssetList';
import { ConfigurationStructOutput } from '../../build/types/Configurator';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import {
  ASSET_DECIMALS,
  deployAssetConfig,
  deployAssetListFixture,
  deployAssetListProxy,
  deployImmutableAssetConfig,
  hashConfig,
} from './shared';

// The Configurator keeps, per Comet proxy, the factory that builds asset list implementations and the asset list
// proxy the market reads from. An immutable change (asset, price feed, a new asset) goes: update the
// stored config -> deployAssetList -> upgrade the list proxy through the proxy admin.
describe('configurator: asset list management', function () {
  const ZERO = ethers.constants.AddressZero;
  const STORAGE_KEYS = ['borrowCollateralFactor', 'liquidateCollateralFactor', 'liquidationFactor', 'supplyCap'] as const;

  let AssetListContractFactory: AssetList__factory;
  let assetList: AssetList;
  let configs: ImmutableAssetConfigStruct[];
  let storageConfigs: StorageAssetConfigStruct[];
  let assetListFactory: AssetListFactory;
  let proxyAdmin: CometProxyAdmin;
  let configurator: Configurator;
  let comet: CometInterface;
  let baseToken: FaucetToken;
  let other: SignerWithAddress;
  let otherMarket: string; // a Comet proxy address the Configurator is given configs for; nothing is deployed there
  let asset: string;

  const listConfigs = (list = assetList) => Promise.all(ASSET_DECIMALS.map((_, i) => list.getAssetInfo(i)));
  const newPriceFeed = async () => (await deployImmutableAssetConfig(18)).priceFeed;
  const cometAssetList = async () =>
    ((await ethers.getContractAt('CometWithExtendedAssetList', comet.address)) as CometWithExtendedAssetList).assetList();

  before(async () => {
    let otherMarketSigner: SignerWithAddress;
    ({
      AssetListContractFactory,
      assetList,
      configs,
      storageConfigs,
      assetListFactory,
      proxyAdmin,
      configurator,
      comet,
      baseToken,
      users: [other, otherMarketSigner],
    } = await deployAssetListFixture());
    otherMarket = otherMarketSigner.address;
    asset = configs[0].asset;
  });

  describe('setAssetListFactory', function () {
    describe('happy path (full flow)', function () {
      let snapshot: SnapshotRestorer;
      let newFactory: AssetListFactory;
      let firstTx: ContractTransaction;
      let tx: ContractTransaction;
      let deployTx: ContractTransaction;
      let priceFeed: string;

      before(async () => {
        snapshot = await takeSnapshot();
        // Another market, with its own factory and a list still to deploy
        firstTx = await configurator.setAssetListFactory(otherMarket, assetListFactory.address);
        await configurator.addAsset(otherMarket, await deployAssetConfig());

        newFactory = (await (await ethers.getContractFactory('AssetListFactory')).deploy()) as AssetListFactory;
        tx = await configurator.setAssetListFactory(comet.address, newFactory.address);
        // An immutable change, so that deployAssetList has a list to deploy
        priceFeed = await newPriceFeed();
        await configurator.updateAssetPriceFeed(comet.address, asset, priceFeed);
        deployTx = await proxyAdmin.deployAndUpgradeAssetListTo(configurator.address, comet.address);
      });

      after(async () => await snapshot.restore());

      it('succeeds for the governor', async () => {
        await expect(tx).to.not.be.reverted;
      });

      it('stores the factory', async () => {
        expect(await configurator.cometAssetListFactories(comet.address)).to.equal(newFactory.address);
      });

      it('deployAssetList deploys through the factory, which emits AssetListCreated', async () => {
        await expect(deployTx).to.emit(newFactory, 'AssetListCreated');
      });

      it('the list proxy upgraded to the result works', async () => {
        expect((await assetList.getAssetInfo(0)).priceFeed).to.equal(priceFeed);
      });

      it('emits SetAssetListFactory with the previous factory as the old one', async () => {
        await expect(tx)
          .to.emit(configurator, 'SetAssetListFactory')
          .withArgs(comet.address, assetListFactory.address, newFactory.address);
      });

      it('emits SetAssetListFactory with the zero address as the old one for the first factory of a market', async () => {
        await expect(firstTx)
          .to.emit(configurator, 'SetAssetListFactory')
          .withArgs(otherMarket, ZERO, assetListFactory.address);
      });

      it('the overwritten factory is not used by the next deployAssetList', async () => {
        await expect(deployTx).to.not.emit(assetListFactory, 'AssetListCreated');
      });

      it('leaves the factory of another market unchanged', async () => {
        expect(await configurator.cometAssetListFactories(otherMarket)).to.equal(assetListFactory.address);
      });

      it('deployAssetList of another market still uses its own factory', async () => {
        await expect(configurator.deployAssetList(otherMarket)).to.emit(assetListFactory, 'AssetListCreated');
      });
    });

    describe('revert when', function () {
      it('the caller is not the governor', async () => {
        await expect(configurator.connect(other).setAssetListFactory(comet.address, assetListFactory.address))
          .to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });

      it('the factory is the zero address', async () => {
        await expect(configurator.setAssetListFactory(comet.address, ZERO))
          .to.be.revertedWithCustomError(configurator, 'InvalidAddress');
      });
    });
  });

  describe('deployAssetList', function () {
    // setConfiguration sets a market's asset list only once, so the fixture market can't go back to having none.
    // The first list is built for another market with the same asset configs and no list yet, then used by the Comet
    describe('happy path (first list: no asset list set for the market)', function () {
      let snapshot: SnapshotRestorer;
      let tx: ContractTransaction;
      let newImplementation: string;
      let newList: AssetList;

      before(async () => {
        snapshot = await takeSnapshot();
        await configurator.setConfiguration(otherMarket, {
          ...(await configurator.getConfiguration(comet.address)),
          assetList: ZERO,
        });
        await configurator.setAssetListFactory(otherMarket, assetListFactory.address);
        for (let i = 0; i < configs.length; i++) {
          await configurator.addAsset(otherMarket, { ...configs[i], ...storageConfigs[i] });
        }
        ({ newAssetListImpl: newImplementation } = await configurator.callStatic.deployAssetList(otherMarket));
        tx = await configurator.deployAssetList(otherMarket);
        newList = await deployAssetListProxy(
          AssetListContractFactory.attach(newImplementation),
          proxyAdmin.address,
          await configurator.getStorageAssetConfig(otherMarket)
        );
        await configurator.updateAssetList(comet.address, newList.address);
        await proxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);
      });

      after(async () => await snapshot.restore());

      it('deploys an implementation, with no list proxy to report', async () => {
        await expect(tx).to.emit(configurator, 'AssetListDeployed').withArgs(otherMarket, ZERO, newImplementation);
      });

      it('a proxy of it initialized with getStorageAssetConfig holds the factors and caps of every asset', async () => {
        const assetInfos = await listConfigs(newList);
        for (let i = 0; i < storageConfigs.length; i++) {
          for (const key of STORAGE_KEYS) expect(assetInfos[i][key]).to.equal(storageConfigs[i][key]);
        }
      });

      it('after updateAssetList and deployAndUpgradeTo the Comet points at the new list', async () => {
        expect(await cometAssetList()).to.equal(newList.address);
      });

      it('the Comet reads every asset through it', async () => {
        expect(await Promise.all(ASSET_DECIMALS.map((_, i) => comet.getAssetInfo(i)))).to.deep.equal(await listConfigs(newList));
      });
    });

    describe('happy path (immutable change, called by anyone)', function () {
      let snapshot: SnapshotRestorer;
      let tx: ContractTransaction;
      let priceFeed: string;
      let returned: { assetListProxy: string, newAssetListImpl: string };
      let newImplementation: AssetList;
      let listBefore: AssetInfoStructOutput[];
      let listAfter: AssetInfoStructOutput[];
      let configurationBefore: ConfigurationStructOutput;

      before(async () => {
        snapshot = await takeSnapshot();
        priceFeed = await newPriceFeed();
        await configurator.updateAssetPriceFeed(comet.address, asset, priceFeed);
        listBefore = await listConfigs();
        configurationBefore = await configurator.getConfiguration(comet.address);

        returned = await configurator.connect(other).callStatic.deployAssetList(comet.address);
        tx = await configurator.connect(other).deployAssetList(comet.address);
        newImplementation = AssetListContractFactory.attach(returned.newAssetListImpl);
      });

      after(async () => await snapshot.restore());

      it('succeeds for any caller', async () => {
        await expect(tx).to.not.be.reverted;
      });

      it('returns the list proxy of the market', async () => {
        expect(returned.assetListProxy).to.equal(assetList.address);
      });

      it('returns a new implementation', async () => {
        expect(returned.newAssetListImpl).to.not.equal(ZERO);
      });

      it('emits AssetListDeployed', async () => {
        await expect(tx)
          .to.emit(configurator, 'AssetListDeployed')
          .withArgs(comet.address, assetList.address, returned.newAssetListImpl);
      });

      it('the configHash of the implementation equals the hash of getImmutableAssetConfig', async () => {
        const immutableConfigs = await configurator.getImmutableAssetConfig(comet.address);
        expect(await newImplementation.configHash()).to.equal(hashConfig(immutableConfigs));
      });

      it('the numAssets of the implementation equals the number of stored configs', async () => {
        expect(await newImplementation.numAssets()).to.equal((await configurator.getAssetConfigs(comet.address)).length);
      });

      it('changes no Configurator state: the asset list of the market stays the same', async () => {
        expect(await configurator.getConfiguration(comet.address)).to.deep.equal(configurationBefore);
      });

      describe('after the list proxy is upgraded to it', function () {
        before(async () => {
          await proxyAdmin.upgrade(assetList.address, newImplementation.address);
          listAfter = await listConfigs();
        });

        it('the new price feed is visible through the list', async () => {
          expect(listAfter[0].priceFeed).to.equal(priceFeed);
        });

        it('the new price feed is visible through the Comet', async () => {
          expect((await comet.getAssetInfo(0)).priceFeed).to.equal(priceFeed);
        });

        it('the factors and caps are unchanged', async () => {
          for (let i = 0; i < listAfter.length; i++) {
            for (const key of STORAGE_KEYS) expect(listAfter[i][key]).to.equal(listBefore[i][key]);
          }
        });
      });
    });

    describe('happy path (current list without configHash, an old list)', function () {
      let snapshot: SnapshotRestorer;
      let tx: ContractTransaction;
      let newImplementation: string;

      before(async () => {
        snapshot = await takeSnapshot();
        // Any contract with no configHash stands for an old list
        await configurator.updateAssetList(comet.address, baseToken.address);
        ({ newAssetListImpl: newImplementation } = await configurator.callStatic.deployAssetList(comet.address));
        tx = await configurator.deployAssetList(comet.address);
      });

      after(async () => await snapshot.restore());

      it('returns a new implementation', async () => {
        expect(newImplementation).to.not.equal(ZERO);
      });

      it('deploys it', async () => {
        await expect(tx)
          .to.emit(configurator, 'AssetListDeployed')
          .withArgs(comet.address, baseToken.address, newImplementation);
      });
    });

    describe('happy path (no immutable change)', function () {
      let tx: ContractTransaction;

      before(async () => {
        tx = await configurator.connect(other).deployAssetList(comet.address);
      });

      it('returns the zero address', async () => {
        expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(ZERO);
      });

      it('emits nothing and deploys nothing', async () => {
        expect((await tx.wait()).logs).to.be.empty;
      });
    });

    describe('happy path (storage-only change: factors and cap)', function () {
      let snapshot: SnapshotRestorer;

      before(async () => {
        snapshot = await takeSnapshot();
        await configurator.updateAssetBorrowCollateralFactor(comet.address, asset, 1);
        await configurator.updateAssetLiquidateCollateralFactor(comet.address, asset, 2);
        await configurator.updateAssetLiquidationFactor(comet.address, asset, 3);
        await configurator.updateAssetSupplyCap(comet.address, asset, 4);
      });

      after(async () => await snapshot.restore());

      it('still returns the zero address', async () => {
        expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(ZERO);
      });
    });

    describe('revert when', function () {
      let snapshot: SnapshotRestorer;

      before(async () => {
        snapshot = await takeSnapshot();
        // A market with the configs of the fixture market, but no factory and no asset list
        for (let i = 0; i < configs.length; i++) {
          await configurator.addAsset(otherMarket, { ...configs[i], ...storageConfigs[i] });
        }
      });

      after(async () => await snapshot.restore());

      it('no factory is set and a deploy is needed', async () => {
        await expect(configurator.deployAssetList(otherMarket)).to.be.revertedWithCustomError(configurator, 'InvalidAddress');
      });

      it('but returns the zero address with no factory set when the hash matches', async () => {
        await configurator.updateAssetList(otherMarket, assetList.address);
        expect((await configurator.callStatic.deployAssetList(otherMarket)).newAssetListImpl).to.equal(ZERO);
      });
    });
  });

  describe('updateAssetList', function () {
    describe('happy path (full flow)', function () {
      const cap = 42;
      let snapshot: SnapshotRestorer;
      let tx: ContractTransaction;
      let newList: AssetList;
      let oldListBefore: AssetInfoStructOutput[];

      before(async () => {
        snapshot = await takeSnapshot();
        // A new list proxy, deployed and initialized from the stored configs
        newList = await deployAssetListProxy(
          await AssetListContractFactory.deploy(await configurator.getImmutableAssetConfig(comet.address), configurator.address),
          proxyAdmin.address,
          await configurator.getStorageAssetConfig(comet.address)
        );
        oldListBefore = await listConfigs();
        tx = await configurator.updateAssetList(comet.address, newList.address);
        await proxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);
      });

      after(async () => await snapshot.restore());

      it('succeeds for the governor', async () => {
        await expect(tx).to.not.be.reverted;
      });

      it('points the configuration of the market at the new list', async () => {
        expect((await configurator.getConfiguration(comet.address)).assetList).to.equal(newList.address);
      });

      it('after deployAndUpgradeTo the asset list of the Comet is the new proxy', async () => {
        expect(await cometAssetList()).to.equal(newList.address);
      });

      it('the Comet reads every asset through it', async () => {
        expect(await Promise.all(ASSET_DECIMALS.map((_, i) => comet.getAssetInfo(i)))).to.deep.equal(await listConfigs(newList));
      });

      it('emits UpdateAssetList', async () => {
        await expect(tx).to.emit(configurator, 'UpdateAssetList').withArgs(comet.address, assetList.address, newList.address);
      });

      it('deployAssetList compares against the new list and returns the zero address', async () => {
        expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(ZERO);
      });

      describe('a storage setter after it', function () {
        before(async () => {
          await configurator.updateAssetSupplyCap(comet.address, asset, cap);
        });

        it('writes to the new list', async () => {
          expect((await newList.getAssetInfo(0)).supplyCap).to.equal(cap);
        });

        it('leaves the old list untouched', async () => {
          expect(await listConfigs()).to.deep.equal(oldListBefore);
        });
      });
    });

    describe('revert when', function () {
      it('the caller is not the governor', async () => {
        await expect(configurator.connect(other).updateAssetList(comet.address, assetList.address))
          .to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });

      it('the asset list is the zero address', async () => {
        await expect(configurator.updateAssetList(comet.address, ZERO))
          .to.be.revertedWithCustomError(configurator, 'InvalidAddress');
      });
    });
  });
});
