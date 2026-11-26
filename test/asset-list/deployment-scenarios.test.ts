import { ethers, exp, expect, hashConfig, makeConfigurator, takeSnapshot, SnapshotRestorer, ZERO_ADDRESS } from '../helpers';
import {
  AssetList,
  AssetListFactoryV2Mock,
  AssetListTypeHashFactoryMock,
  CometProxyAdminOptimism,
  ConfiguratorOptimism,
} from '../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { makeMarketAdmin } from '../marketupdates/market-updates-helper';
import { AssetConfigStruct } from '../../build/types/ConfiguratorOptimism';
import { ContractTransaction } from 'ethers';

// How the asset list of a market is redeployed: CometProxyAdmin.deployAndUpgradeAssetListTo asks
// Configurator.deployAssetList for a new implementation, which is deployed only when the immutable configs no longer
// hash to the configHash of the current list, and upgrades the list proxy to it when there is one
describe('asset list deployment scenarios', function () {
  // AssetListTypeHashMock.TYPEHASH: the same configs under a new type
  const NEW_TYPEHASH = ethers.utils.id('ImmutableConfigV2[](address asset,address priceFeed)');

  let governor: SignerWithAddress;
  let marketAdmin: SignerWithAddress;
  let proxyAdmin: CometProxyAdminOptimism;
  let configurator: ConfiguratorOptimism; // proxy
  let comet: string; // proxy
  let assetList: AssetList; // proxy
  let snapshot: SnapshotRestorer;

  before(async () => {
    const marketAdminSetup = await makeMarketAdmin();
    governor = marketAdminSetup.governorTimelockSigner;
    marketAdmin = marketAdminSetup.marketUpdateTimelockSigner;
    const protocol = await makeConfigurator({
      governor,
      marketAdminPermissionCheckerContract: marketAdminSetup.marketAdminPermissionCheckerContract,
    });
    proxyAdmin = protocol.proxyAdmin;
    configurator = protocol.configurator.attach(protocol.configuratorProxy.address);
    comet = protocol.cometProxyWithExtendedAssetList.address;
    assetList = protocol.assetList;

    // Sanity check: the two callers are different accounts, so the second run doesn't just repeat the first
    expect(governor.address).to.not.equal(marketAdmin.address);
    snapshot = await takeSnapshot();
  });

  // The governor and the market admin run the same logic in deployAndUpgradeAssetListTo, so every case is expected to
  // behave the same way for both of them
  (['governor', 'market admin'] as const).forEach((admin) => runDeployScenarios(admin));

  // Every case runs once per caller of deployAndUpgradeAssetListTo. The signers only exist after the before hook,
  // so a case gets the caller by name and resolves its signer when it runs
  function runDeployScenarios(admin: 'governor' | 'market admin') {
    const adminSigner = (): SignerWithAddress => (admin === 'governor' ? governor : marketAdmin);

    context(`nothing changes (${admin})`, function () {
      let implementationBefore: string;
      let upgradeTx: ContractTransaction;

      before(async () => {
        await snapshot.restore();
        implementationBefore = await proxyAdmin.getProxyImplementation(assetList.address);
      });

      it('sanity check: deployAssetList returns no new implementation', async () => {
        expect((await configurator.callStatic.deployAssetList(comet)).newAssetListImpl).to.equal(ZERO_ADDRESS);
      });

      it('deployAndUpgradeAssetListTo is successful', async () => {
        upgradeTx = await proxyAdmin.connect(adminSigner()).deployAndUpgradeAssetListTo(configurator.address, comet);
        await expect(upgradeTx).to.not.be.reverted;
      });

      it('does not emit AssetListDeployed', async () => {
        await expect(upgradeTx).to.not.emit(configurator, 'AssetListDeployed');
      });

      it('keeps the implementation of the asset list proxy', async () => {
        expect(await proxyAdmin.getProxyImplementation(assetList.address)).to.equal(implementationBefore);
      });
    });

    // Factors and supply caps live in the list storage and are written by the setters, so the immutable configs stay the same
    context(`storage changes (${admin})`, function () {
      let implementationBefore: string;
      let upgradeTx: ContractTransaction;

      before(async () => {
        await snapshot.restore();
        implementationBefore = await proxyAdmin.getProxyImplementation(assetList.address);
        const [firstAssetConfig] = await configurator.getAssetConfigs(comet);
        await configurator.connect(governor).updateAssetSupplyCap(comet, firstAssetConfig.asset, firstAssetConfig.supplyCap.add(1));
      });

      it('sanity check: deployAssetList returns no new implementation', async () => {
        expect((await configurator.callStatic.deployAssetList(comet)).newAssetListImpl).to.equal(ZERO_ADDRESS);
      });

      it('deployAndUpgradeAssetListTo is successful', async () => {
        upgradeTx = await proxyAdmin.connect(adminSigner()).deployAndUpgradeAssetListTo(configurator.address, comet);
        await expect(upgradeTx).to.not.be.reverted;
      });

      it('does not emit AssetListDeployed', async () => {
        await expect(upgradeTx).to.not.emit(configurator, 'AssetListDeployed');
      });

      it('keeps the implementation of the asset list proxy', async () => {
        expect(await proxyAdmin.getProxyImplementation(assetList.address)).to.equal(implementationBefore);
      });
    });

    // A new price feed is part of the immutable configs, so it needs a new implementation
    context(`immutable configs change (${admin})`, function () {
      let newAssetListImpl: string;
      let upgradeTx: ContractTransaction;

      before(async () => {
        await snapshot.restore();
        const newPriceFeed = await (await ethers.getContractFactory('SimplePriceFeed')).deploy(10n ** 8n, 8);
        const [firstAssetConfig] = await configurator.getAssetConfigs(comet);
        await configurator.connect(governor).updateAssetPriceFeed(comet, firstAssetConfig.asset, newPriceFeed.address);
      });

      it('sanity check: deployAssetList returns a new implementation', async () => {
        ({ newAssetListImpl } = await configurator.callStatic.deployAssetList(comet));
        expect(newAssetListImpl).to.not.equal(ZERO_ADDRESS);
      });

      it('deployAndUpgradeAssetListTo is successful', async () => {
        upgradeTx = await proxyAdmin.connect(adminSigner()).deployAndUpgradeAssetListTo(configurator.address, comet);
        await expect(upgradeTx).to.not.be.reverted;
      });

      it('emits AssetListDeployed with the new implementation', async () => {
        await expect(upgradeTx).to.emit(configurator, 'AssetListDeployed').withArgs(comet, assetList.address, newAssetListImpl);
      });

      it('upgrades the asset list proxy to the new implementation', async () => {
        expect(await proxyAdmin.getProxyImplementation(assetList.address)).to.equal(newAssetListImpl);
      });

      it('the configHash of the asset list is the hash of the new immutable configs', async () => {
        const immutableConfigs = await configurator.getImmutableAssetConfig(comet);
        expect(await assetList.configHash()).to.equal(hashConfig(immutableConfigs, await assetList.TYPEHASH()));
      });
    });

    // A new asset adds to the immutable configs, so it needs a new implementation. The upgrade also writes the storage
    // configs of every asset, which registers the new one with its factors and supply cap
    context(`adding new asset (${admin})`, function () {
      const BORROW_CF = exp(0.75, 18);
      const LIQUIDATE_CF = exp(0.8, 18);
      const LIQUIDATION_FACTOR = exp(0.9, 18);
      const SUPPLY_CAP = exp(1000, 18);

      let newAsset: AssetConfigStruct;
      let numAssetsBefore: number;
      let newAssetListImpl: string;
      let upgradeTx: ContractTransaction;

      before(async () => {
        await snapshot.restore();
        numAssetsBefore = await assetList.numAssets();
        const token = await (await ethers.getContractFactory('FaucetToken')).deploy(0, 'New Asset', 18, 'NEW');
        const priceFeed = await (await ethers.getContractFactory('SimplePriceFeed')).deploy(10n ** 8n, 8);
        newAsset = {
          asset: token.address,
          priceFeed: priceFeed.address,
          borrowCollateralFactor: BORROW_CF,
          liquidateCollateralFactor: LIQUIDATE_CF,
          liquidationFactor: LIQUIDATION_FACTOR,
          supplyCap: SUPPLY_CAP,
        };
        await configurator.connect(governor).addAsset(comet, newAsset);
      });

      it('sanity check: deployAssetList returns a new implementation', async () => {
        ({ newAssetListImpl } = await configurator.callStatic.deployAssetList(comet));
        expect(newAssetListImpl).to.not.equal(ZERO_ADDRESS);
      });

      it('deployAndUpgradeAssetListTo is successful', async () => {
        upgradeTx = await proxyAdmin.connect(adminSigner()).deployAndUpgradeAssetListTo(configurator.address, comet);
        await expect(upgradeTx).to.not.be.reverted;
      });

      it('emits AssetListDeployed with the new implementation', async () => {
        await expect(upgradeTx).to.emit(configurator, 'AssetListDeployed').withArgs(comet, assetList.address, newAssetListImpl);
      });

      it('upgrades the asset list proxy to the new implementation', async () => {
        expect(await proxyAdmin.getProxyImplementation(assetList.address)).to.equal(newAssetListImpl);
      });

      it('the configHash of the asset list is the hash of the new immutable configs', async () => {
        const immutableConfigs = await configurator.getImmutableAssetConfig(comet);
        expect(await assetList.configHash()).to.equal(hashConfig(immutableConfigs, await assetList.TYPEHASH()));
      });

      it('the asset list has one more asset', async () => {
        expect(await assetList.numAssets()).to.equal(numAssetsBefore + 1);
      });

      it('the new asset is listed last', async () => {
        expect((await assetList.getAssetInfo(numAssetsBefore)).asset).to.equal(newAsset.asset);
      });

      it('the new asset is registered with its borrow collateral factor', async () => {
        expect((await assetList.getAssetInfoByAddress(newAsset.asset)).borrowCollateralFactor).to.equal(BORROW_CF);
      });

      it('the new asset is registered with its liquidate collateral factor', async () => {
        expect((await assetList.getAssetInfoByAddress(newAsset.asset)).liquidateCollateralFactor).to.equal(LIQUIDATE_CF);
      });

      it('the new asset is registered with its liquidation factor', async () => {
        expect((await assetList.getAssetInfoByAddress(newAsset.asset)).liquidationFactor).to.equal(LIQUIDATION_FACTOR);
      });

      it('the new asset is registered with its supply cap', async () => {
        expect((await assetList.getAssetInfoByAddress(newAsset.asset)).supplyCap).to.equal(SUPPLY_CAP);
      });
    });

    // New AssetList code built from the same immutable configs has the same configHash, so the Configurator can't tell
    // it apart: it is deployed and set by hand, and deployAndUpgradeAssetListTo leaves it in place
    context(`technical update (not config related) (${admin})`, function () {
      let configHashBefore: string;
      let newAssetListImpl: string;
      let upgradeTx: ContractTransaction;

      before(async () => {
        await snapshot.restore();
        configHashBefore = await assetList.configHash();
        const newFactory = await (await ethers.getContractFactory('AssetListFactoryV2Mock')).deploy(configurator.address) as AssetListFactoryV2Mock;
        const immutableConfigs = await configurator.getImmutableAssetConfig(comet);
        newAssetListImpl = await newFactory.callStatic.createAssetList(immutableConfigs);
        await newFactory.createAssetList(immutableConfigs);
        await proxyAdmin.connect(governor).upgrade(assetList.address, newAssetListImpl);
      });

      it('sanity check: the asset list proxy runs the new code', async () => {
        expect(await proxyAdmin.getProxyImplementation(assetList.address)).to.equal(newAssetListImpl);
        expect(await (await ethers.getContractAt('AssetListV2Mock', assetList.address)).version()).to.equal(2);
      });

      it('sanity check: the configHash is the same as before the update', async () => {
        expect(await assetList.configHash()).to.equal(configHashBefore);
      });

      it('sanity check: deployAssetList returns no new implementation', async () => {
        expect((await configurator.callStatic.deployAssetList(comet)).newAssetListImpl).to.equal(ZERO_ADDRESS);
      });

      it('deployAndUpgradeAssetListTo is successful', async () => {
        upgradeTx = await proxyAdmin.connect(adminSigner()).deployAndUpgradeAssetListTo(configurator.address, comet);
        await expect(upgradeTx).to.not.be.reverted;
      });

      it('does not emit AssetListDeployed', async () => {
        await expect(upgradeTx).to.not.emit(configurator, 'AssetListDeployed');
      });

      it('keeps the new implementation of the asset list proxy', async () => {
        expect(await proxyAdmin.getProxyImplementation(assetList.address)).to.equal(newAssetListImpl);
      });
    });

    // AssetListTypeHashMock is a full copy of AssetList with only the TYPEHASH changed, so it has to be kept in sync with
    // contracts/AssetList.sol by hand: after any change there, copy it into the mock as well.
    // The structure of the immutable configs changed, so the same configs hash to a new configHash. The Configurator
    // hashes with the TYPEHASH of the current list, so after the upgrade it sees nothing to deploy
    context(`typehash update (${admin})`, function () {
      let newAssetListImpl: string;
      let upgradeTx: ContractTransaction;

      before(async () => {
        await snapshot.restore();
        const newFactory = await (await ethers.getContractFactory('AssetListTypeHashFactoryMock')).deploy(configurator.address) as AssetListTypeHashFactoryMock;
        const immutableConfigs = await configurator.getImmutableAssetConfig(comet);
        newAssetListImpl = await newFactory.callStatic.createAssetList(immutableConfigs);
        await newFactory.createAssetList(immutableConfigs);
        await proxyAdmin.connect(governor).upgrade(assetList.address, newAssetListImpl);
      });

      it('sanity check: the asset list proxy reports the new TYPEHASH', async () => {
        expect(await assetList.TYPEHASH()).to.equal(NEW_TYPEHASH);
      });

      it('sanity check: the configHash is the immutable configs hashed with the new TYPEHASH', async () => {
        const immutableConfigs = await configurator.getImmutableAssetConfig(comet);
        expect(await assetList.configHash()).to.equal(hashConfig(immutableConfigs, NEW_TYPEHASH));
      });

      it('sanity check: deployAssetList returns no new implementation', async () => {
        expect((await configurator.callStatic.deployAssetList(comet)).newAssetListImpl).to.equal(ZERO_ADDRESS);
      });

      it('deployAndUpgradeAssetListTo is successful', async () => {
        upgradeTx = await proxyAdmin.connect(adminSigner()).deployAndUpgradeAssetListTo(configurator.address, comet);
        await expect(upgradeTx).to.not.be.reverted;
      });

      it('does not emit AssetListDeployed', async () => {
        await expect(upgradeTx).to.not.emit(configurator, 'AssetListDeployed');
      });

      it('keeps the new implementation of the asset list proxy', async () => {
        expect(await proxyAdmin.getProxyImplementation(assetList.address)).to.equal(newAssetListImpl);
      });
    });
  }
});
