import { ethers, expect, takeSnapshot, SnapshotRestorer } from '../helpers';
import { AssetList, AssetList__factory, CometInterface, CometProxyAdmin, Configurator, FaucetToken } from '../../build/types';
import { AssetInfoStructOutput, ImmutableAssetConfigStruct } from '../../build/types/AssetList';
import { AssetConfigStruct, AssetConfigStructOutput } from '../../build/types/Configurator';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { Contract, ContractTransaction } from 'ethers';
import {
  ASSET_DECIMALS,
  BORROW_CF,
  LIQUIDATE_CF,
  deployAssetConfig,
  deployAssetListFixture,
  impersonate,
} from './shared';

// Configurator.updateAsset<Field>(cometProxy, asset, value) does the whole change in one call: it updates the field
// in the stored config, emits its event with the old and new values, and calls the matching setter of the asset list.
describe('asset list setters', function () {
  const ZERO = ethers.constants.AddressZero;
  const FACTOR = 10n ** 16n; // 0.01
  const MAX_UINT128 = 2n ** 128n - 1n;
  const TARGET = 1; // index of the asset the setters are called for
  const SETTERS = [
    { field: 'BorrowCollateralFactor', key: 'borrowCollateralFactor', listSetter: 'setBorrowCollateralFactor', value: 70n * FACTOR },
    { field: 'LiquidateCollateralFactor', key: 'liquidateCollateralFactor', listSetter: 'setLiquidateCollateralFactor', value: 85n * FACTOR },
    { field: 'LiquidationFactor', key: 'liquidationFactor', listSetter: 'setLiquidationFactor', value: 95n * FACTOR },
    { field: 'SupplyCap', key: 'supplyCap', listSetter: 'setSupplyCap', value: 123_456_789n },
  ] as const;
  const KEYS = SETTERS.map(({ key }) => key);

  let AssetListContractFactory: AssetList__factory;
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
  const storedConfigs = () => configurator.getAssetConfigs(comet.address);
  const listConfigs = () => Promise.all(ASSET_DECIMALS.map((_, i) => assetList.getAssetInfo(i)));

  before(async () => {
    ({
      AssetListContractFactory,
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

  describe('Storage config setters', function () {
    SETTERS.forEach(({ field, key, value }) => {
      describe(`updateAsset${field}: happy path`, function () {
        let snapshot: SnapshotRestorer;
        let tx: ContractTransaction;
        let storedBefore: AssetConfigStructOutput[];
        let storedAfter: AssetConfigStructOutput[];
        let listBefore: AssetInfoStructOutput[];
        let listAfter: AssetInfoStructOutput[];

        before(async () => {
          snapshot = await takeSnapshot();
          storedBefore = await storedConfigs();
          listBefore = await listConfigs();
          tx = await update(field, comet.address, asset, value);
          storedAfter = await storedConfigs();
          listAfter = await listConfigs();
        });

        after(async () => await snapshot.restore());

        it('succeeds for the governor', async () => {
          await expect(tx).to.not.be.reverted;
        });

        it('updates the field in the stored config', async () => {
          expect(storedAfter[TARGET][key]).to.equal(value);
        });

        it(`emits UpdateAsset${field} on the Configurator with the old and new values`, async () => {
          await expect(tx)
            .to.emit(configurator, `UpdateAsset${field}`)
            .withArgs(comet.address, asset, storedBefore[TARGET][key], value);
        });

        it('shows the new value through getAssetInfo of the list', async () => {
          expect(listAfter[TARGET][key]).to.equal(value);
        });

        it('shows the new value through getAssetInfoByAddress of the list', async () => {
          expect((await assetList.getAssetInfoByAddress(asset))[key]).to.equal(value);
        });

        it('shows the new value through the Comet with no redeploy', async () => {
          expect((await comet.getAssetInfo(TARGET))[key]).to.equal(value);
        });

        it('leaves the other fields of the asset unchanged in the stored config', async () => {
          for (const otherKey of KEYS.filter((k) => k != key)) {
            expect(storedAfter[TARGET][otherKey]).to.equal(storedBefore[TARGET][otherKey]);
          }
        });

        it('leaves the other fields of the asset unchanged in the list', async () => {
          for (const otherKey of KEYS.filter((k) => k != key)) {
            expect(listAfter[TARGET][otherKey]).to.equal(listBefore[TARGET][otherKey]);
          }
        });

        it('does not affect the other assets in the stored configs', async () => {
          expect(storedAfter.filter((_, i) => i != TARGET)).to.deep.equal(storedBefore.filter((_, i) => i != TARGET));
        });

        it('does not affect the other assets in the list', async () => {
          expect(listAfter.filter((_, i) => i != TARGET)).to.deep.equal(listBefore.filter((_, i) => i != TARGET));
        });

        it('leaves deployAssetList returning the zero address, as only storage changed', async () => {
          expect((await configurator.callStatic.deployAssetList(comet.address)).newAssetListImpl).to.equal(ZERO);
        });
      });

      describe(`updateAsset${field}: happy path (setting the current value again)`, function () {
        let snapshot: SnapshotRestorer;
        let tx: ContractTransaction;
        let current: bigint;

        before(async () => {
          snapshot = await takeSnapshot();
          current = (await storedConfigs())[TARGET][key].toBigInt();
          tx = await update(field, comet.address, asset, current);
        });

        after(async () => await snapshot.restore());

        it('succeeds', async () => {
          await expect(tx).to.not.be.reverted;
        });

        it('emits the event with the old value equal to the new one', async () => {
          await expect(tx).to.emit(configurator, `UpdateAsset${field}`).withArgs(comet.address, asset, current, current);
        });
      });

      describe(`updateAsset${field}: happy path (list proxy upgraded to a new implementation)`, function () {
        let snapshot: SnapshotRestorer;

        before(async () => {
          snapshot = await takeSnapshot();
          await update(field, comet.address, asset, value);
          const newImplementation = await AssetListContractFactory.deploy(configs);
          await proxyAdmin.upgrade(assetList.address, newImplementation.address);
        });

        after(async () => await snapshot.restore());

        it('keeps the value, because it lives in the proxy storage', async () => {
          expect((await assetList.getAssetInfo(TARGET))[key]).to.equal(value);
        });
      });
    });
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
        it(`updateAsset${field} reverts with BadAsset of the list`, async () => {
          await expect(update(field, comet.address, newAssetConfig.asset, value))
            .to.be.revertedWithCustomError(assetList, 'BadAsset');
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
        it(`updateAsset${field} reverts with BadAsset of the list`, async () => {
          await expect(update(field, comet.address, newAssetConfig.asset, value))
            .to.be.revertedWithCustomError(assetList, 'BadAsset');
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

  // The factor checks run in the asset list and a failed one reverts the whole call. Only the cases that depend on
  // the order of calls are here; the fixture asset starts at 0.75 / 0.8 / 0.9
  describe('validation: order of calls', function () {
    describe('raising borrowCF above the current liquidateCF', function () {
      let snapshot: SnapshotRestorer;

      before(async () => (snapshot = await takeSnapshot()));
      after(async () => await snapshot.restore());

      it('reverts with BorrowCFTooLarge when borrowCF is raised first', async () => {
        await expect(update('BorrowCollateralFactor', comet.address, asset, LIQUIDATE_CF + FACTOR))
          .to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      });

      it('succeeds after liquidateCF is raised first', async () => {
        await update('LiquidateCollateralFactor', comet.address, asset, LIQUIDATE_CF + 2n * FACTOR);
        await expect(update('BorrowCollateralFactor', comet.address, asset, LIQUIDATE_CF + FACTOR)).to.not.be.reverted;
      });
    });

    describe('lowering liquidateCF to or below the current borrowCF', function () {
      let snapshot: SnapshotRestorer;

      before(async () => (snapshot = await takeSnapshot()));
      after(async () => await snapshot.restore());

      it('reverts with BorrowCFTooLarge when liquidateCF is lowered to borrowCF first', async () => {
        await expect(update('LiquidateCollateralFactor', comet.address, asset, BORROW_CF))
          .to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      });

      it('reverts with BorrowCFTooLarge when liquidateCF is lowered below borrowCF first', async () => {
        await expect(update('LiquidateCollateralFactor', comet.address, asset, BORROW_CF - FACTOR))
          .to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      });

      it('succeeds after borrowCF is lowered first', async () => {
        await update('BorrowCollateralFactor', comet.address, asset, BORROW_CF - 2n * FACTOR);
        await expect(update('LiquidateCollateralFactor', comet.address, asset, BORROW_CF - FACTOR)).to.not.be.reverted;
      });
    });

    describe('lowering liquidationFactor to or below the current liquidateCF', function () {
      let snapshot: SnapshotRestorer;

      before(async () => (snapshot = await takeSnapshot()));
      after(async () => await snapshot.restore());

      it('reverts with LiquidateCFTooLarge when liquidationFactor is lowered to liquidateCF first', async () => {
        await expect(update('LiquidationFactor', comet.address, asset, LIQUIDATE_CF))
          .to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      });

      it('reverts with LiquidateCFTooLarge when liquidationFactor is lowered below liquidateCF first', async () => {
        await expect(update('LiquidationFactor', comet.address, asset, LIQUIDATE_CF - FACTOR))
          .to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      });

      it('succeeds after liquidateCF is lowered first', async () => {
        await update('LiquidateCollateralFactor', comet.address, asset, LIQUIDATE_CF - 2n * FACTOR);
        await expect(update('LiquidationFactor', comet.address, asset, LIQUIDATE_CF - FACTOR)).to.not.be.reverted;
      });
    });
  });

  describe('setter SupplyCap', function () {
    [
      ['zero, which stops new supply', 0n],
      ['the maximum of uint128', MAX_UINT128],
    ].forEach(([name, cap]: [string, bigint]) => {
      describe(`happy path (${name})`, function () {
        let snapshot: SnapshotRestorer;
        let tx: ContractTransaction;

        before(async () => {
          snapshot = await takeSnapshot();
          tx = await update('SupplyCap', comet.address, asset, cap);
        });

        after(async () => await snapshot.restore());

        it('succeeds', async () => {
          await expect(tx).to.not.be.reverted;
        });

        it('stores the value in the stored config', async () => {
          expect((await storedConfigs())[TARGET].supplyCap).to.equal(cap);
        });

        it('stores the value in the list', async () => {
          expect((await assetList.getAssetInfo(TARGET)).supplyCap).to.equal(cap);
        });
      });
    });

    [
      ['soft de-listed asset: borrowCF = 0, liquidateCF > 0', ['BorrowCollateralFactor']],
      ['fully de-listed asset: borrowCF = liquidateCF = 0', ['BorrowCollateralFactor', 'LiquidateCollateralFactor']],
    ].forEach(([name, zeroedFactors]: [string, string[]]) => {
      describe(`happy path (${name})`, function () {
        const cap = 777n;
        let snapshot: SnapshotRestorer;
        let tx: ContractTransaction;
        let listBefore: AssetInfoStructOutput;

        before(async () => {
          snapshot = await takeSnapshot();
          for (const field of zeroedFactors) await update(field, comet.address, asset, 0);
          listBefore = await assetList.getAssetInfo(TARGET);
          tx = await update('SupplyCap', comet.address, asset, cap);
        });

        after(async () => await snapshot.restore());

        it('succeeds', async () => {
          await expect(tx).to.not.be.reverted;
        });

        it('stores the supply cap in the list', async () => {
          expect((await assetList.getAssetInfo(TARGET)).supplyCap).to.equal(cap);
        });

        it('does not touch the collateral factors', async () => {
          const listAfter = await assetList.getAssetInfo(TARGET);
          for (const key of KEYS.filter((k) => k != 'supplyCap')) expect(listAfter[key]).to.equal(listBefore[key]);
        });
      });
    });

    describe('happy path (value is stored as given, not scaled)', function () {
      const cap = 1_000_000_007n; // not a multiple of the asset scale
      let snapshot: SnapshotRestorer;

      before(async () => {
        snapshot = await takeSnapshot();
        await update('SupplyCap', comet.address, asset, cap);
      });

      after(async () => await snapshot.restore());

      it('the stored config returns exactly the value', async () => {
        expect((await storedConfigs())[TARGET].supplyCap).to.equal(cap);
      });

      it('getAssetInfo of the list returns exactly the value', async () => {
        expect((await assetList.getAssetInfo(TARGET)).supplyCap).to.equal(cap);
      });

      it('the Comet returns exactly the value', async () => {
        expect((await comet.getAssetInfo(TARGET)).supplyCap).to.equal(cap);
      });
    });

    describe('happy path (the Comet enforces the new cap)', function () {
      const cap = 1000n;
      let snapshot: SnapshotRestorer;
      let token: FaucetToken;

      before(async () => {
        snapshot = await takeSnapshot();
        await update('SupplyCap', comet.address, asset, cap);
        token = (await ethers.getContractAt('FaucetToken', asset)) as FaucetToken;
        await token.allocateTo(other.address, cap + 1n);
        await token.connect(other).approve(comet.address, cap + 1n);
      });

      after(async () => await snapshot.restore());

      it('supplying up to the cap succeeds', async () => {
        await expect(comet.connect(other).supply(asset, cap)).to.not.be.reverted;
      });

      it('supplying one unit more reverts with SupplyCapExceeded', async () => {
        await expect(comet.connect(other).supply(asset, 1)).to.be.revertedWithCustomError(comet, 'SupplyCapExceeded');
      });
    });
  });
});
