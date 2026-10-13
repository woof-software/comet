import { expect, exp, takeSnapshot, SnapshotRestorer } from '../helpers';
import { AssetList, AssetList__factory, CometProxyAdmin, Configurator, CometInterface } from '../../build/types';
import { AssetInfoStructOutput, ImmutableAssetConfigStruct } from '../../build/types/AssetList';
import { BigNumberish, Contract, ContractTransaction } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import {
  ASSET_DECIMALS,
  BORROW_CF,
  LIQUIDATE_CF,
  LIQUIDATION_FACTOR,
  MAX_ASSETS,
  SUPPLY_CAP,
  deployAssetListFixture,
  deployAssetListProxy,
  deployImmutableAssetConfigs,
} from './shared';

// AssetList checks the order of the collateral factors in initialize and in every factor setter:
// BCF below LCF unless BCF is zero, LCF below LF unless LCF is zero, and LF at most 1e18
describe.only('asset list factors validation', function () {
  const MAX_COLLATERAL_FACTOR = exp(1, 18);
  const TARGET = 0; // index of the fixture asset the revert cases call the setters for
  // Decimals of the collaterals each new asset list in the initialize cases holds: the fixture decimals, repeated
  const DECIMALS = Array.from({ length: MAX_ASSETS }, (_, i) => ASSET_DECIMALS[i % ASSET_DECIMALS.length]);

  type Factors = { borrowCollateralFactor: bigint, liquidateCollateralFactor: bigint, liquidationFactor: bigint };
  const factors = (borrowCollateralFactor: bigint, liquidateCollateralFactor: bigint, liquidationFactor: bigint): Factors =>
    ({ borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor });

  let AssetListContractFactory: AssetList__factory;
  let assetList: AssetList;
  let proxyAdmin: CometProxyAdmin;
  let configurator: Configurator;
  let comet: CometInterface;
  let governor: SignerWithAddress;
  let asset: string;
  let snapshot: SnapshotRestorer;
  let immutableConfigs: ImmutableAssetConfigStruct[]; // MAX_ASSETS collaterals
  let implementation: AssetList; // built from `immutableConfigs`, shared by every new asset list
  let assets: string[]; // every asset of the fixture market

  before(async () => {
    ({ AssetListContractFactory, assetList, proxyAdmin, configurator, comet, governor } = await deployAssetListFixture());
    asset = (await assetList.getAssetInfo(TARGET)).asset;
    assets = (await configurator.getAssetConfigs(comet.address)).map((config) => config.asset);
    immutableConfigs = await deployImmutableAssetConfigs(DECIMALS);
    implementation = await AssetListContractFactory.deploy(immutableConfigs);
  });

  // A new asset list of MAX_ASSETS collaterals, deployed the way a market gets one: the implementation holds the
  // immutable part of the configs, and the proxy is initialized with the factors, which is where they are validated.
  // Every collateral gets `f`, or with `index` only that collateral does and the rest keep the fixture factors
  async function deployAssetListWith(f: Factors, index?: number): Promise<AssetList> {
    const fixtureFactors = factors(BORROW_CF, LIQUIDATE_CF, LIQUIDATION_FACTOR);
    return deployAssetListProxy(
      implementation,
      proxyAdmin.address,
      DECIMALS.map((decimals, i) => ({
        ...(index === undefined || i === index ? f : fixtureFactors),
        supplyCap: SUPPLY_CAP * 10n ** BigInt(decimals),
      })),
      configurator.address
    );
  }

  const update = (field: string, value: bigint, asset_ = asset): Promise<ContractTransaction> =>
    (configurator.connect(governor) as unknown as Contract)[`updateAsset${field}`](comet.address, asset_, value);

  // Moves a fixture asset to `f` through the Configurator, one setter at a time. Every step must pass validation,
  // so BCF goes to zero first and comes last, and LCF and LF are set in whichever order keeps LCF below LF
  async function setFactors(asset_: string, f: Factors): Promise<void> {
    await update('BorrowCollateralFactor', 0n, asset_);
    if (f.liquidateCollateralFactor < LIQUIDATION_FACTOR) {
      await update('LiquidateCollateralFactor', f.liquidateCollateralFactor, asset_);
      await update('LiquidationFactor', f.liquidationFactor, asset_);
    } else {
      await update('LiquidationFactor', f.liquidationFactor, asset_);
      await update('LiquidateCollateralFactor', f.liquidateCollateralFactor, asset_);
    }
    await update('BorrowCollateralFactor', f.borrowCollateralFactor, asset_);
  }

  function expectFactors(assetInfo: Record<keyof Factors, BigNumberish>, f: Factors): void {
    expect(assetInfo.borrowCollateralFactor).to.equal(f.borrowCollateralFactor);
    expect(assetInfo.liquidateCollateralFactor).to.equal(f.liquidateCollateralFactor);
    expect(assetInfo.liquidationFactor).to.equal(f.liquidationFactor);
  }

  // The fixture asset starts at BORROW_CF, LIQUIDATE_CF, LIQUIDATION_FACTOR (0.75, 0.8, 0.9)
  const HAPPY_CASES = [
    { name: 'active collateral: BCF > 0, LCF > BCF, LF > LCF', factors: factors(BORROW_CF, LIQUIDATE_CF, LIQUIDATION_FACTOR) },
    { name: 'soft de-listed collateral: BCF = 0, LCF > 0, LF > LCF', factors: factors(0n, LIQUIDATE_CF, LIQUIDATION_FACTOR) },
    { name: 'fully de-listed collateral: BCF = 0, LCF = 0, LF > 0', factors: factors(0n, 0n, LIQUIDATION_FACTOR) },
    { name: 'non-liquidatable collateral: BCF = 0, LCF = 0, LF = 0', factors: factors(0n, 0n, 0n) },
    { name: 'liquidation factor at maximum: LF = 1e18', factors: factors(BORROW_CF, LIQUIDATE_CF, MAX_COLLATERAL_FACTOR) },
  ];

  /*//////////////////////////////////////////////////////////////
                              INITIALIZE
  //////////////////////////////////////////////////////////////*/

  describe('initialize', function () {
    for (const { name, factors: f } of HAPPY_CASES) {
      context(name, function () {
        let newAssetList: AssetList;

        it('deploys the asset list', async () => {
          newAssetList = await deployAssetListWith(f);
        });

        it('stores the factors of every collateral', async () => {
          for (let i = 0; i < MAX_ASSETS; i++) {
            expectFactors(await newAssetList.getAssetInfo(i), f);
          }
        });
      });
    }
  });

  /*//////////////////////////////////////////////////////////////
                                SETTERS
  //////////////////////////////////////////////////////////////*/

  // The full flow through the Configurator: updateAsset<Field> updates the stored config and calls the asset list setter
  describe('setters', function () {
    for (const { name, factors: f } of HAPPY_CASES) {
      context(name, function () {
        before(async () => {
          snapshot = await takeSnapshot();
          for (const asset_ of assets) await setFactors(asset_, f);
        });

        after(async () => await snapshot.restore());

        it('updates the stored config of every collateral', async () => {
          for (const config of await configurator.getAssetConfigs(comet.address)) expectFactors(config, f);
        });

        it('updates the asset list for every collateral', async () => {
          for (let i = 0; i < assets.length; i++) expectFactors(await assetList.getAssetInfo(i), f);
        });
      });
    }
  });

  /*//////////////////////////////////////////////////////////////
                         SAME VALUE VIA SETTERS
  //////////////////////////////////////////////////////////////*/

  // Setting a factor to the value it already has keeps the order valid, so the setter accepts it and nothing changes
  describe('same value via setters', function () {
    const fixtureFactors = factors(BORROW_CF, LIQUIDATE_CF, LIQUIDATION_FACTOR);
    const SAME_VALUE_CASES = [
      { name: 'same BCF', field: 'BorrowCollateralFactor', value: BORROW_CF },
      { name: 'same LCF', field: 'LiquidateCollateralFactor', value: LIQUIDATE_CF },
      { name: 'same LF', field: 'LiquidationFactor', value: LIQUIDATION_FACTOR },
    ];

    for (const { name, field, value } of SAME_VALUE_CASES) {
      context(name, function () {
        before(async () => (snapshot = await takeSnapshot()));

        after(async () => await snapshot.restore());

        it('accepts the setter for every collateral', async () => {
          for (const asset_ of assets) {
            await expect(update(field, value, asset_)).to.not.be.reverted;
          }
        });

        it('keeps the stored config of every collateral', async () => {
          for (const config of await configurator.getAssetConfigs(comet.address)) expectFactors(config, fixtureFactors);
        });

        it('keeps the asset list for every collateral', async () => {
          for (let i = 0; i < assets.length; i++) expectFactors(await assetList.getAssetInfo(i), fixtureFactors);
        });
      });
    }
  });

  /*//////////////////////////////////////////////////////////////
                              REVERT CASES
  //////////////////////////////////////////////////////////////*/

  // Each context's factors differ from the fixture factors (0.75, 0.8, 0.9) in one field only,
  // so the setter case is the one Configurator call that sets that field.
  // Both run for every collateral, one at a time, to show every index is validated the same way
  describe('revert cases', function () {
    context('BCF equals LCF when both are non-zero', function () {
      const BORROW_CF = exp(0.8, 18);
      const LIQUIDATE_CF = BORROW_CF;
      const LIQUIDATION_FACTOR = exp(0.9, 18);

      it('reverts on initialize for every collateral', async () => {
        for (let i = 0; i < MAX_ASSETS; i++) {
          await expect(deployAssetListWith(factors(BORROW_CF, LIQUIDATE_CF, LIQUIDATION_FACTOR), i)).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        }
      });

      it('reverts on the setter for every collateral', async () => {
        for (const asset_ of assets) {
          await expect(update('BorrowCollateralFactor', BORROW_CF, asset_)).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        }
      });
    });

    context('BCF exceeds LCF', function () {
      const LIQUIDATE_CF = exp(0.8, 18);
      const BORROW_CF = LIQUIDATE_CF + 1n;
      const LIQUIDATION_FACTOR = exp(0.9, 18);

      it('reverts on initialize for every collateral', async () => {
        for (let i = 0; i < MAX_ASSETS; i++) {
          await expect(deployAssetListWith(factors(BORROW_CF, LIQUIDATE_CF, LIQUIDATION_FACTOR), i)).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        }
      });

      it('reverts on the setter for every collateral', async () => {
        for (const asset_ of assets) {
          await expect(update('BorrowCollateralFactor', BORROW_CF, asset_)).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        }
      });
    });

    context('BCF is non-zero but LCF is zero', function () {
      const BORROW_CF = exp(0.75, 18);
      const LIQUIDATE_CF = 0n;
      const LIQUIDATION_FACTOR = exp(0.9, 18);

      it('reverts on initialize for every collateral', async () => {
        for (let i = 0; i < MAX_ASSETS; i++) {
          await expect(deployAssetListWith(factors(BORROW_CF, LIQUIDATE_CF, LIQUIDATION_FACTOR), i)).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        }
      });

      it('reverts on the setter for every collateral', async () => {
        for (const asset_ of assets) {
          await expect(update('LiquidateCollateralFactor', LIQUIDATE_CF, asset_)).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        }
      });
    });

    context('LCF equals LF when both are non-zero', function () {
      const BORROW_CF = exp(0.75, 18);
      const LIQUIDATE_CF = exp(0.9, 18);
      const LIQUIDATION_FACTOR = exp(0.9, 18);

      it('reverts on initialize for every collateral', async () => {
        for (let i = 0; i < MAX_ASSETS; i++) {
          await expect(deployAssetListWith(factors(BORROW_CF, LIQUIDATE_CF, LIQUIDATION_FACTOR), i)).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
        }
      });

      it('reverts on the setter for every collateral', async () => {
        for (const asset_ of assets) {
          await expect(update('LiquidateCollateralFactor', LIQUIDATE_CF, asset_)).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
        }
      });
    });

    context('LCF exceeds LF', function () {
      const BORROW_CF = exp(0.75, 18);
      const LIQUIDATION_FACTOR = exp(0.9, 18);
      const LIQUIDATE_CF = LIQUIDATION_FACTOR + 1n;

      it('reverts on initialize for every collateral', async () => {
        for (let i = 0; i < MAX_ASSETS; i++) {
          await expect(deployAssetListWith(factors(BORROW_CF, LIQUIDATE_CF, LIQUIDATION_FACTOR), i)).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
        }
      });

      it('reverts on the setter for every collateral', async () => {
        for (const asset_ of assets) {
          await expect(update('LiquidateCollateralFactor', LIQUIDATE_CF, asset_)).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
        }
      });
    });

    context('LCF is non-zero but LF is zero', function () {
      const BORROW_CF = exp(0.75, 18);
      const LIQUIDATE_CF = exp(0.8, 18);
      const LIQUIDATION_FACTOR = 0n;

      it('reverts on initialize for every collateral', async () => {
        for (let i = 0; i < MAX_ASSETS; i++) {
          await expect(deployAssetListWith(factors(BORROW_CF, LIQUIDATE_CF, LIQUIDATION_FACTOR), i)).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
        }
      });

      it('reverts on the setter for every collateral', async () => {
        for (const asset_ of assets) {
          await expect(update('LiquidationFactor', LIQUIDATION_FACTOR, asset_)).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
        }
      });
    });

    context('LF exceeds MAX_COLLATERAL_FACTOR', function () {
      const BORROW_CF = exp(0.75, 18);
      const LIQUIDATE_CF = exp(0.8, 18);
      const LIQUIDATION_FACTOR = MAX_COLLATERAL_FACTOR + 1n;

      it('reverts on initialize for every collateral', async () => {
        for (let i = 0; i < MAX_ASSETS; i++) {
          await expect(deployAssetListWith(factors(BORROW_CF, LIQUIDATE_CF, LIQUIDATION_FACTOR), i)).to.be.revertedWithCustomError(assetList, 'LiqPenaltyTooHigh');
        }
      });

      it('reverts on the setter for every collateral', async () => {
        for (const asset_ of assets) {
          await expect(update('LiquidationFactor', LIQUIDATION_FACTOR, asset_)).to.be.revertedWithCustomError(assetList, 'LiqPenaltyTooHigh');
        }
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                         FULL PRECISION FACTORS
  //////////////////////////////////////////////////////////////*/

  context('full precision factors', function () {
    // Factors are stored as given, with all 18 decimals, so factors one wei apart are still strictly ordered
    const factor = 123456000000000000n;

    context('LCF one wei above BCF', function () {
      let assetInfo: AssetInfoStructOutput;

      before(async () => {
        const newAssetList = await deployAssetListWith(factors(factor, factor + 1n, LIQUIDATION_FACTOR));
        assetInfo = await newAssetList.getAssetInfo(0);
      });

      it('stores borrowCollateralFactor', () => {
        expect(assetInfo.borrowCollateralFactor).to.equal(factor);
      });

      it('stores liquidateCollateralFactor one wei above borrowCollateralFactor', () => {
        expect(assetInfo.liquidateCollateralFactor).to.equal(factor + 1n);
      });
    });

    context('LF one wei above LCF', function () {
      let assetInfo: AssetInfoStructOutput;

      before(async () => {
        const newAssetList = await deployAssetListWith(factors(0n, factor, factor + 1n));
        assetInfo = await newAssetList.getAssetInfo(0);
      });

      it('stores liquidateCollateralFactor', () => {
        expect(assetInfo.liquidateCollateralFactor).to.equal(factor);
      });

      it('stores liquidationFactor one wei above liquidateCollateralFactor', () => {
        expect(assetInfo.liquidationFactor).to.equal(factor + 1n);
      });
    });
  });
});
