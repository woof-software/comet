import { ethers, expect, takeSnapshot, SnapshotRestorer } from '../helpers';
import { AssetList, AssetList__factory, CometInterface, CometProxyAdmin, Configurator } from '../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { StorageAssetConfigStruct } from '../../build/types/AssetList';
import { BORROW_CF, LIQUIDATE_CF, LIQUIDATION_FACTOR, MAX_ASSETS, deployAssetListFixture, deployAssetListProxy, deployImmutableAssetConfigs } from './shared';

describe('supply cap', function () {
  // The largest value the uint128 supply cap field can hold
  const MAX_UINT128 = 2n ** 128n - 1n;

  let AssetListContractFactory: AssetList__factory;
  let assetList: AssetList; // the fixture market's asset list
  let assets: string[]; // every asset of the fixture market
  let proxyAdmin: CometProxyAdmin;
  let configurator: Configurator;
  let comet: CometInterface;
  let governor: SignerWithAddress;
  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ AssetListContractFactory, assetList, proxyAdmin, configurator, comet, governor } = await deployAssetListFixture());
    assets = (await configurator.getAssetConfigs(comet.address)).map((config) => config.asset);
    snapshot = await takeSnapshot();
  });

  // The factors every collateral is initialized with, and the given cap
  const storageConfig = (supplyCap: bigint): StorageAssetConfigStruct => ({
    borrowCollateralFactor: BORROW_CF,
    liquidateCollateralFactor: LIQUIDATE_CF,
    liquidationFactor: LIQUIDATION_FACTOR,
    supplyCap,
  });

  // The list of token decimals to test
  const tokenDecimals = [6n, 8n, 12n, 18n];

  // Run the tests for each token decimals
  tokenDecimals.forEach(decimals => describe(`token with ${decimals} decimals`, () => runSupplyCapTests(decimals)));

  function runSupplyCapTests(decimals: bigint) {
    const oneToken = 10n ** decimals;

    // A regular cap every collateral starts with; each flow swaps in its own cap
    const normalSupplyCap = oneToken * 1_000_000n;

    const SUPPLY_CAPS = [
      { name: '1 wei supply cap', supplyCap: 1n },
      { name: 'cap one wei below a whole token unit', supplyCap: oneToken - 1n },
      { name: '0.5 token cap', supplyCap: oneToken / 2n },
      { name: '10.5 token cap', supplyCap: oneToken * 21n / 2n },
      { name: 'uint128 max cap', supplyCap: MAX_UINT128 },
      { name: 'zero cap', supplyCap: 0n },
    ];

    // MAX_ASSETS collaterals with the same decimals, shared by every asset list of this block
    let implementation: AssetList;

    before(async () => {
      implementation = await AssetListContractFactory.deploy(
        await deployImmutableAssetConfigs(Array(MAX_ASSETS).fill(Number(decimals)))
      );
    });

    after(async () => await snapshot.restore());

    /*//////////////////////////////////////////////////////////////
                              INITIALIZE
    //////////////////////////////////////////////////////////////*/

    describe('initialize', function () {
      // Creates an asset list where every collateral has the cap, then checks each collateral reads it back
      for (const { name, supplyCap } of SUPPLY_CAPS) {
        context(name, function () {
          let newAssetList: AssetList;

          it('creates the asset list', async () => {
            newAssetList = await deployAssetListProxy(
              implementation,
              proxyAdmin.address,
              Array(MAX_ASSETS).fill(storageConfig(supplyCap)),
              configurator.address
            );
          });

          it('returns the configured supply cap for every collateral', async () => {
            for (let i = 0; i < MAX_ASSETS; i++) {
              expect((await newAssetList.getAssetInfo(i)).supplyCap).to.equal(supplyCap);
            }
          });
        });
      }

      // A cap above uint128 max, set on one collateral at a time, must make the list's ABI decoder revert with no reason.
      // ethers won't encode it as uint128, so initialize is sent raw with the cap encoded as uint256 (same 32-byte layout)
      // to a proxy deployed without initialize data.
      Array.from({ length: MAX_ASSETS }).forEach((_, i) => {
        context(`uint128 max + 1 cap on collateral ${i}`, function () {
          it('reverts on initialize', async () => {
            const proxy = await (await ethers.getContractFactory('TransparentUpgradeableProxy')).deploy(
              implementation.address,
              proxyAdmin.address,
              '0x'
            );
            const storageConfigs = Array.from({ length: MAX_ASSETS }, (_, j) =>
              storageConfig(j === i ? MAX_UINT128 + 1n : normalSupplyCap)
            );
            const data = AssetListContractFactory.interface.getSighash('initialize') + ethers.utils.defaultAbiCoder.encode(
              ['tuple(uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint256 supplyCap)[]', 'address'],
              [storageConfigs, configurator.address]
            ).slice(2);
            const [signer] = await ethers.getSigners();

            await expect(signer.sendTransaction({ to: proxy.address, data, gasLimit: 30_000_000 })).to.be.revertedWithoutReason();
          });
        });
      });
    });

    /*//////////////////////////////////////////////////////////////
                         SETTER VIA CONFIGURATOR
    //////////////////////////////////////////////////////////////*/

    // The full flow on the fixture market: updateAssetSupplyCap updates the stored config and calls the asset list setter
    describe('setter via configurator', function () {
      for (const { name, supplyCap } of SUPPLY_CAPS) {
        context(name, function () {
          let setterSnapshot: SnapshotRestorer;

          before(async () => {
            setterSnapshot = await takeSnapshot();
            for (const asset of assets) {
              await configurator.connect(governor).updateAssetSupplyCap(comet.address, asset, supplyCap);
            }
          });

          after(async () => await setterSnapshot.restore());

          it('updates the stored config of every collateral', async () => {
            for (const config of await configurator.getAssetConfigs(comet.address)) {
              expect(config.supplyCap).to.equal(supplyCap);
            }
          });

          it('updates the asset list for every collateral', async () => {
            for (let i = 0; i < assets.length; i++) {
              expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(supplyCap);
            }
          });
        });
      }
    });

    /*//////////////////////////////////////////////////////////////
                           SAME VALUE VIA SETTER
    //////////////////////////////////////////////////////////////*/

    // Setting a cap to the value it already has is accepted and changes nothing
    describe('same value via setter', function () {
      let setterSnapshot: SnapshotRestorer;
      let currentCaps: bigint[];

      before(async () => {
        setterSnapshot = await takeSnapshot();
        currentCaps = (await configurator.getAssetConfigs(comet.address)).map((config) => config.supplyCap.toBigInt());
      });

      after(async () => await setterSnapshot.restore());

      it('accepts the setter for every collateral', async () => {
        for (let i = 0; i < assets.length; i++) {
          await expect(configurator.connect(governor).updateAssetSupplyCap(comet.address, assets[i], currentCaps[i])).to.not.be.reverted;
        }
      });

      it('keeps the stored config of every collateral', async () => {
        const configs = await configurator.getAssetConfigs(comet.address);
        for (let i = 0; i < assets.length; i++) {
          expect(configs[i].supplyCap).to.equal(currentCaps[i]);
        }
      });

      it('keeps the asset list for every collateral', async () => {
        for (let i = 0; i < assets.length; i++) {
          expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(currentCaps[i]);
        }
      });
    });
  }
});
