import { ethers, expect, takeSnapshot, SnapshotRestorer } from '../helpers';
import { AssetList, CometInterface, CometProxyAdmin, Configurator } from '../../build/types';
import { ImmutableAssetConfigStruct } from '../../build/types/AssetList';
import { AssetConfigStruct } from '../../build/types/Configurator';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { Contract, ContractTransaction } from 'ethers';
import {
  deployAssetConfig,
  deployAssetListFixture,
  impersonate,
} from './shared';

// Who may call the storage setters, and when they revert: Configurator.updateAsset<Field> is for the governor only,
// the matching setter of the asset list is for the Configurator only, and both reject an asset the list does not hold.
// The happy paths are in collateral-factors.test.ts and supply-cap.test.ts
describe('asset list setters: access and reverts', function () {
  const ZERO = ethers.constants.AddressZero;
  const FACTOR = 10n ** 16n; // 0.01
  const TARGET = 1; // index of the asset the setters are called for
  const SETTERS = [
    { field: 'BorrowCollateralFactor', key: 'borrowCollateralFactor', listSetter: 'setBorrowCollateralFactor', value: 70n * FACTOR },
    { field: 'LiquidateCollateralFactor', key: 'liquidateCollateralFactor', listSetter: 'setLiquidateCollateralFactor', value: 85n * FACTOR },
    { field: 'LiquidationFactor', key: 'liquidationFactor', listSetter: 'setLiquidationFactor', value: 95n * FACTOR },
    { field: 'SupplyCap', key: 'supplyCap', listSetter: 'setSupplyCap', value: 123_456_789n },
  ] as const;

  let assetList: AssetList;
  let configs: ImmutableAssetConfigStruct[];
  let proxyAdmin: CometProxyAdmin;
  let configurator: Configurator;
  let comet: CometInterface;
  let governor: SignerWithAddress;
  let other: SignerWithAddress;
  let asset: string;

  const update = (field: string, cometProxy: string, asset_: string, value: bigint | number, caller = governor): Promise<ContractTransaction> =>
    (configurator.connect(caller) as unknown as Contract)[`updateAsset${field}`](cometProxy, asset_, value);

  before(async () => {
    ({
      assetList,
      configs,
      proxyAdmin,
      configurator,
      comet,
      governor,
      users: [other],
    } = await deployAssetListFixture());
    asset = configs[TARGET].asset;
  });

  describe('access', function () {
    SETTERS.forEach(({ field, value }) => {
      it(`updateAsset${field} reverts for anyone but the governor`, async () => {
        await expect(update(field, comet.address, asset, value, other))
          .to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });
    });

    // The setters of the asset list itself are for the Configurator only
    SETTERS.forEach(({ listSetter, value }) => {
      it(`AssetList.${listSetter} reverts when called directly by the governor`, async () => {
        await expect(assetList.connect(governor)[listSetter](asset, value))
          .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
      });

      it(`AssetList.${listSetter} reverts when called directly by a random account`, async () => {
        await expect(assetList.connect(other)[listSetter](asset, value))
          .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
      });

      it(`AssetList.${listSetter} reverts when called directly by the proxy admin, which never reaches the implementation`, async () => {
        await expect(assetList.connect(await impersonate(proxyAdmin.address))[listSetter](asset, value))
          .to.be.revertedWith('TransparentUpgradeableProxy: admin cannot fallback to proxy target');
      });
    });
  });

  describe('revert when', function () {
    SETTERS.forEach(({ field, value }) => {
      it(`updateAsset${field}: the asset is not in the stored configs`, async () => {
        await expect(update(field, comet.address, other.address, value))
          .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
      });

      it(`updateAsset${field}: the asset is the zero address`, async () => {
        await expect(update(field, comet.address, ZERO, value))
          .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
      });
    });

    describe('the asset is in the stored configs but not in the immutables of the list (list not upgraded yet)', function () {
      let snapshot: SnapshotRestorer;
      let newAssetConfig: AssetConfigStruct;

      before(async () => {
        snapshot = await takeSnapshot();
        newAssetConfig = await deployAssetConfig();
        await configurator.addAsset(comet.address, newAssetConfig);
      });

      after(async () => await snapshot.restore());

      SETTERS.forEach(({ field, value }) => {
        it(`updateAsset${field} reverts with AssetNotFound of the list`, async () => {
          await expect(update(field, comet.address, newAssetConfig.asset, value))
            .to.be.revertedWithCustomError(assetList, 'AssetNotFound');
        });
      });
    });

    describe('the asset is in the immutables of the list but not added to it yet', function () {
      let snapshot: SnapshotRestorer;
      let newAssetConfig: AssetConfigStruct;

      before(async () => {
        snapshot = await takeSnapshot();
        newAssetConfig = await deployAssetConfig();
        await configurator.addAsset(comet.address, newAssetConfig);
        await proxyAdmin.deployAndUpgradeAssetListTo(configurator.address, comet.address);
      });

      after(async () => await snapshot.restore());

      SETTERS.forEach(({ field, value }) => {
        it(`updateAsset${field} reverts with AssetNotFound of the list`, async () => {
          await expect(update(field, comet.address, newAssetConfig.asset, value))
            .to.be.revertedWithCustomError(assetList, 'AssetNotFound');
        });
      });
    });

    describe('the asset list is not set for the Comet proxy', function () {
      let snapshot: SnapshotRestorer;
      let newAssetConfig: AssetConfigStruct;

      before(async () => {
        snapshot = await takeSnapshot();
        newAssetConfig = await deployAssetConfig();
        // A Comet proxy the Configurator has asset configs for, but no configuration, so no asset list
        await configurator.addAsset(other.address, newAssetConfig);
      });

      after(async () => await snapshot.restore());

      SETTERS.forEach(({ field, value }) => {
        it(`updateAsset${field} reverts`, async () => {
          await expect(update(field, other.address, newAssetConfig.asset, value)).to.be.reverted;
        });
      });
    });
  });
});
