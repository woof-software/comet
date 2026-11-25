import { MAX_ASSETS, MAX_UINT128, SignerWithAddress, ethers, exp, expect, factorScale, makeConfigurator, takeSnapshot, SnapshotRestorer } from '../helpers';
import { AssetList, AssetList__factory, CometProxyAdminOptimism, ConfiguratorOptimism } from '../../build/types';
import { AssetConfigStruct, StorageAssetConfigStructOutput } from '../../build/types/ConfiguratorOptimism';
import { AssetInfoStructOutput } from '../../build/types/AssetList';

// The storage setters of the asset list: only the Configurator may call them, for an asset the list holds.
// The Configurator reaches them through updateAsset<Field>, which writes its own stored config first
describe('asset list setters', function () {
  // The max asset decimals whose scale (10 to the power of the decimals) fits in uint64
  const MAX_ASSET_DECIMALS = 19;

  // The first collaterals of the market, one per decimals worth testing: both ends of the allowed decimals,
  // 0 (scale 1) and MAX_ASSET_DECIMALS, and the common ones in between
  const DIFFERENT_DECIMALS_COLLATERALS: { symbol: string, decimals: number }[] = [
    { symbol: 'WETH', decimals: 18 },
    { symbol: 'WBTC', decimals: 8 },
    { symbol: 'USDT', decimals: 6 },
    { symbol: 'NODEC', decimals: 0 },
    { symbol: 'MAXDEC', decimals: MAX_ASSET_DECIMALS },
  ];
  const DIFFERENT_DECIMALS_COLLATERALS_COUNT = DIFFERENT_DECIMALS_COLLATERALS.length;

  // The market's collateral assets, in the order they are listed. They fill every slot but one, which is left for the
  // asset the add-asset flows add
  const COLLATERALS: { symbol: string, decimals: number }[] = [
    ...DIFFERENT_DECIMALS_COLLATERALS,
    // The rest fill every slot left but the last one
    ...Array.from({ length: MAX_ASSETS - 1 - DIFFERENT_DECIMALS_COLLATERALS_COUNT }, (_, j) => ({
      symbol: `ASSET${j + DIFFERENT_DECIMALS_COLLATERALS_COUNT}`,
      decimals: 18,
    })),
  ];

  // The market: USDC as the base asset, then the collaterals
  const ASSETS = {
    USDC: { decimals: 6, initialPrice: 1 },
    ...Object.fromEntries(COLLATERALS.map(({ symbol, decimals }) => [symbol, { decimals }])),
  };

  let governor: SignerWithAddress;
  let user: SignerWithAddress; // holds no role
  let proxyAdmin: CometProxyAdminOptimism;
  let configurator: ConfiguratorOptimism; // proxy
  let comet: string; // proxy
  let assetList: AssetList; // proxy
  let snapshot: SnapshotRestorer;

  before(async () => {
    const protocol = await makeConfigurator({ base: 'USDC', assets: ASSETS });
    governor = protocol.governor;
    [user] = protocol.users;
    proxyAdmin = protocol.proxyAdmin;
    configurator = protocol.configurator.attach(protocol.configuratorProxy.address);
    comet = protocol.cometProxyWithExtendedAssetList.address;
    assetList = protocol.assetList;
    snapshot = await takeSnapshot();
  });

  /*//////////////////////////////////////////////////////////////
                     BORROW COLLATERAL FACTOR
  //////////////////////////////////////////////////////////////*/

  context('BCF can be updated', function () {
    const NEW_BORROW_CF = exp(0.7, 18);

    it('updateAssetBorrowCollateralFactor is successful for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetBorrowCollateralFactor(comet, asset, NEW_BORROW_CF)).to.not.be.reverted;
      }
    });

    it('every asset has the new borrow collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).borrowCollateralFactor).to.equal(NEW_BORROW_CF);
      }
    });
  });

  context('BCF can be updated to zero', function () {
    const NEW_BORROW_CF = 0n;

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetBorrowCollateralFactor is successful for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetBorrowCollateralFactor(comet, asset, NEW_BORROW_CF)).to.not.be.reverted;
      }
    });

    it('every asset has the new borrow collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).borrowCollateralFactor).to.equal(NEW_BORROW_CF);
      }
    });
  });

  context('revert when BCF is set equal to LCF', function () {
    const LIQUIDATE_CF = exp(0.8, 18);
    const NEW_BORROW_CF = LIQUIDATE_CF;

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetBorrowCollateralFactor reverts with BorrowCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetBorrowCollateralFactor(comet, asset, NEW_BORROW_CF))
          .to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      }
    });
  });

  context('revert when BCF is set above LCF', function () {
    const LIQUIDATE_CF = exp(0.8, 18);
    const NEW_BORROW_CF = LIQUIDATE_CF + 1n;

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetBorrowCollateralFactor reverts with BorrowCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetBorrowCollateralFactor(comet, asset, NEW_BORROW_CF))
          .to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      }
    });
  });

  /*//////////////////////////////////////////////////////////////
                   LIQUIDATE COLLATERAL FACTOR
  //////////////////////////////////////////////////////////////*/

  context('LCF can be updated', function () {
    const NEW_LIQUIDATE_CF = exp(0.85, 18);

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetLiquidateCollateralFactor is successful for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidateCollateralFactor(comet, asset, NEW_LIQUIDATE_CF)).to.not.be.reverted;
      }
    });

    it('every asset has the new liquidate collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidateCollateralFactor).to.equal(NEW_LIQUIDATE_CF);
      }
    });
  });

  context('LCF can be updated to zero when BCF is zero', function () {
    const BORROW_CF = 0n;
    const NEW_LIQUIDATE_CF = 0n;

    before(async () => {
      await snapshot.restore();
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await configurator.connect(governor).updateAssetBorrowCollateralFactor(comet, asset, BORROW_CF);
      }
    });

    it('sanity check: every asset has the borrow collateral factor of zero', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).borrowCollateralFactor).to.equal(BORROW_CF);
      }
    });

    it('updateAssetLiquidateCollateralFactor is successful for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidateCollateralFactor(comet, asset, NEW_LIQUIDATE_CF)).to.not.be.reverted;
      }
    });

    it('every asset has the new liquidate collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidateCollateralFactor).to.equal(NEW_LIQUIDATE_CF);
      }
    });
  });

  context('revert when LCF is set equal to BCF', function () {
    const BORROW_CF = exp(0.75, 18);
    const NEW_LIQUIDATE_CF = BORROW_CF;

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetLiquidateCollateralFactor reverts with BorrowCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidateCollateralFactor(comet, asset, NEW_LIQUIDATE_CF))
          .to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      }
    });
  });

  context('revert when LCF is set below BCF', function () {
    const BORROW_CF = exp(0.75, 18);
    const NEW_LIQUIDATE_CF = BORROW_CF - 1n;

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetLiquidateCollateralFactor reverts with BorrowCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidateCollateralFactor(comet, asset, NEW_LIQUIDATE_CF))
          .to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      }
    });
  });

  context('revert when LCF is set to zero while BCF is non-zero', function () {
    const NEW_LIQUIDATE_CF = 0n;

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetLiquidateCollateralFactor reverts with BorrowCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidateCollateralFactor(comet, asset, NEW_LIQUIDATE_CF))
          .to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      }
    });
  });

  context('revert when LCF is set equal to LF', function () {
    const LIQUIDATION_FACTOR = exp(0.9, 18);
    const NEW_LIQUIDATE_CF = LIQUIDATION_FACTOR;

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetLiquidateCollateralFactor reverts with LiquidateCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidateCollateralFactor(comet, asset, NEW_LIQUIDATE_CF))
          .to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      }
    });
  });

  context('revert when LCF is set above LF', function () {
    const LIQUIDATION_FACTOR = exp(0.9, 18);
    const NEW_LIQUIDATE_CF = LIQUIDATION_FACTOR + 1n;

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetLiquidateCollateralFactor reverts with LiquidateCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidateCollateralFactor(comet, asset, NEW_LIQUIDATE_CF))
          .to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      }
    });
  });

  /*//////////////////////////////////////////////////////////////
                        LIQUIDATION FACTOR
  //////////////////////////////////////////////////////////////*/

  context('LF can be updated', function () {
    const NEW_LIQUIDATION_FACTOR = exp(0.95, 18);

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetLiquidationFactor is successful for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidationFactor(comet, asset, NEW_LIQUIDATION_FACTOR)).to.not.be.reverted;
      }
    });

    it('every asset has the new liquidation factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidationFactor).to.equal(NEW_LIQUIDATION_FACTOR);
      }
    });
  });

  context('LF can be updated to the maximum, 1e18', function () {
    const NEW_LIQUIDATION_FACTOR = factorScale;

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetLiquidationFactor is successful for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidationFactor(comet, asset, NEW_LIQUIDATION_FACTOR)).to.not.be.reverted;
      }
    });

    it('every asset has the new liquidation factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidationFactor).to.equal(NEW_LIQUIDATION_FACTOR);
      }
    });
  });

  context('LF can be updated to zero when BCF and LCF are zero', function () {
    const BORROW_CF = 0n;
    const LIQUIDATE_CF = 0n;
    const NEW_LIQUIDATION_FACTOR = 0n;

    before(async () => {
      await snapshot.restore();
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await configurator.connect(governor).updateAssetBorrowCollateralFactor(comet, asset, BORROW_CF);
        await configurator.connect(governor).updateAssetLiquidateCollateralFactor(comet, asset, LIQUIDATE_CF);
      }
    });

    it('sanity check: every asset has the borrow collateral factor of zero', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).borrowCollateralFactor).to.equal(BORROW_CF);
      }
    });

    it('sanity check: every asset has the liquidate collateral factor of zero', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidateCollateralFactor).to.equal(LIQUIDATE_CF);
      }
    });

    it('updateAssetLiquidationFactor is successful for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidationFactor(comet, asset, NEW_LIQUIDATION_FACTOR)).to.not.be.reverted;
      }
    });

    it('every asset has the new liquidation factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidationFactor).to.equal(NEW_LIQUIDATION_FACTOR);
      }
    });
  });

  context('revert when LF is set equal to LCF', function () {
    const LIQUIDATE_CF = exp(0.8, 18);
    const NEW_LIQUIDATION_FACTOR = LIQUIDATE_CF;

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetLiquidationFactor reverts with LiquidateCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidationFactor(comet, asset, NEW_LIQUIDATION_FACTOR))
          .to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      }
    });
  });

  context('revert when LF is set below LCF', function () {
    const LIQUIDATE_CF = exp(0.8, 18);
    const NEW_LIQUIDATION_FACTOR = LIQUIDATE_CF - 1n;

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetLiquidationFactor reverts with LiquidateCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidationFactor(comet, asset, NEW_LIQUIDATION_FACTOR))
          .to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      }
    });
  });

  context('revert when LF is set to zero while LCF is non-zero', function () {
    const NEW_LIQUIDATION_FACTOR = 0n;

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetLiquidationFactor reverts with LiquidateCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidationFactor(comet, asset, NEW_LIQUIDATION_FACTOR))
          .to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      }
    });
  });

  context('revert when LF is set above the maximum, 1e18', function () {
    const NEW_LIQUIDATION_FACTOR = factorScale + 1n;

    before(async () => {
      await snapshot.restore();
    });

    it('updateAssetLiquidationFactor reverts with LiqPenaltyTooHigh for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidationFactor(comet, asset, NEW_LIQUIDATION_FACTOR))
          .to.be.revertedWithCustomError(assetList, 'LiqPenaltyTooHigh');
      }
    });
  });

  /*//////////////////////////////////////////////////////////////
                             SUPPLY CAP
  //////////////////////////////////////////////////////////////*/

  // The collaterals with different decimals come first in the list, so asset i of the list is collateral i of them
  context('supply cap can be updated to 1 wei', function () {
    // Every collateral gets the cap in its own token units
    const NEW_SUPPLY_CAPS = DIFFERENT_DECIMALS_COLLATERALS.map(() => 1n);

    before(() => snapshot.restore());

    it('updateAssetSupplyCap is successful for every collateral with different decimals', async () => {
      for (let i = 0; i < DIFFERENT_DECIMALS_COLLATERALS_COUNT; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetSupplyCap(comet, asset, NEW_SUPPLY_CAPS[i])).to.not.be.reverted;
      }
    });

    it('every collateral with different decimals has its new supply cap', async () => {
      for (let i = 0; i < DIFFERENT_DECIMALS_COLLATERALS_COUNT; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(NEW_SUPPLY_CAPS[i]);
      }
    });
  });

  context('supply cap can be updated to one wei below a whole token', function () {
    // Every collateral gets the cap in its own token units
    const NEW_SUPPLY_CAPS = DIFFERENT_DECIMALS_COLLATERALS.map(({ decimals }) => 10n ** BigInt(decimals) - 1n);

    before(() => snapshot.restore());

    it('updateAssetSupplyCap is successful for every collateral with different decimals', async () => {
      for (let i = 0; i < DIFFERENT_DECIMALS_COLLATERALS_COUNT; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetSupplyCap(comet, asset, NEW_SUPPLY_CAPS[i])).to.not.be.reverted;
      }
    });

    it('every collateral with different decimals has its new supply cap', async () => {
      for (let i = 0; i < DIFFERENT_DECIMALS_COLLATERALS_COUNT; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(NEW_SUPPLY_CAPS[i]);
      }
    });
  });

  context('supply cap can be updated to 0.5 token', function () {
    // Every collateral gets the cap in its own token units
    const NEW_SUPPLY_CAPS = DIFFERENT_DECIMALS_COLLATERALS.map(({ decimals }) => 10n ** BigInt(decimals) / 2n);

    before(() => snapshot.restore());

    it('updateAssetSupplyCap is successful for every collateral with different decimals', async () => {
      for (let i = 0; i < DIFFERENT_DECIMALS_COLLATERALS_COUNT; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetSupplyCap(comet, asset, NEW_SUPPLY_CAPS[i])).to.not.be.reverted;
      }
    });

    it('every collateral with different decimals has its new supply cap', async () => {
      for (let i = 0; i < DIFFERENT_DECIMALS_COLLATERALS_COUNT; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(NEW_SUPPLY_CAPS[i]);
      }
    });
  });

  context('supply cap can be updated to 10.5 tokens', function () {
    // Every collateral gets the cap in its own token units
    const NEW_SUPPLY_CAPS = DIFFERENT_DECIMALS_COLLATERALS.map(({ decimals }) => 10n ** BigInt(decimals) * 21n / 2n);

    before(() => snapshot.restore());

    it('updateAssetSupplyCap is successful for every collateral with different decimals', async () => {
      for (let i = 0; i < DIFFERENT_DECIMALS_COLLATERALS_COUNT; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetSupplyCap(comet, asset, NEW_SUPPLY_CAPS[i])).to.not.be.reverted;
      }
    });

    it('every collateral with different decimals has its new supply cap', async () => {
      for (let i = 0; i < DIFFERENT_DECIMALS_COLLATERALS_COUNT; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(NEW_SUPPLY_CAPS[i]);
      }
    });
  });

  context('supply cap can be updated to the max uint128', function () {
    // Every collateral gets the cap in its own token units
    const NEW_SUPPLY_CAPS = DIFFERENT_DECIMALS_COLLATERALS.map(() => MAX_UINT128);

    before(() => snapshot.restore());

    it('updateAssetSupplyCap is successful for every collateral with different decimals', async () => {
      for (let i = 0; i < DIFFERENT_DECIMALS_COLLATERALS_COUNT; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetSupplyCap(comet, asset, NEW_SUPPLY_CAPS[i])).to.not.be.reverted;
      }
    });

    it('every collateral with different decimals has its new supply cap', async () => {
      for (let i = 0; i < DIFFERENT_DECIMALS_COLLATERALS_COUNT; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(NEW_SUPPLY_CAPS[i]);
      }
    });
  });

  context('supply cap can be updated to zero', function () {
    // Every collateral gets the cap in its own token units
    const NEW_SUPPLY_CAPS = DIFFERENT_DECIMALS_COLLATERALS.map(() => 0n);

    before(() => snapshot.restore());

    it('updateAssetSupplyCap is successful for every collateral with different decimals', async () => {
      for (let i = 0; i < DIFFERENT_DECIMALS_COLLATERALS_COUNT; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetSupplyCap(comet, asset, NEW_SUPPLY_CAPS[i])).to.not.be.reverted;
      }
    });

    it('every collateral with different decimals has its new supply cap', async () => {
      for (let i = 0; i < DIFFERENT_DECIMALS_COLLATERALS_COUNT; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(NEW_SUPPLY_CAPS[i]);
      }
    });
  });

  /*//////////////////////////////////////////////////////////////
                              EDGE CASES
  //////////////////////////////////////////////////////////////*/

  // addAsset only stores the config in the Configurator; the asset reaches the list with the next list upgrade
  context('revert when the asset is added to the configurator but the asset list is not upgraded yet', function () {
    let newAsset: AssetConfigStruct;

    before(async () => {
      const token = await (await ethers.getContractFactory('FaucetToken')).deploy(0, 'New Asset', 18, 'NEW');
      const priceFeed = await (await ethers.getContractFactory('SimplePriceFeed')).deploy(10n ** 8n, 8);
      newAsset = {
        asset: token.address,
        priceFeed: priceFeed.address,
        borrowCollateralFactor: exp(0.75, 18),
        liquidateCollateralFactor: exp(0.8, 18),
        liquidationFactor: exp(0.9, 18),
        supplyCap: exp(1000, 18),
      };
      await configurator.connect(governor).addAsset(comet, newAsset);
    });

    it('sanity check: the asset list does not have the asset', async () => {
      await expect(assetList.getAssetInfoByAddress(newAsset.asset))
        .to.be.revertedWithCustomError(assetList, 'AssetNotFound');
    });

    it('updateAssetBorrowCollateralFactor reverts with AssetNotFound of the asset list', async () => {
      await expect(configurator.connect(governor).updateAssetBorrowCollateralFactor(comet, newAsset.asset, newAsset.borrowCollateralFactor))
        .to.be.revertedWithCustomError(assetList, 'AssetNotFound');
    });

    it('updateAssetLiquidateCollateralFactor reverts with AssetNotFound of the asset list', async () => {
      await expect(configurator.connect(governor).updateAssetLiquidateCollateralFactor(comet, newAsset.asset, newAsset.liquidateCollateralFactor))
        .to.be.revertedWithCustomError(assetList, 'AssetNotFound');
    });

    it('updateAssetLiquidationFactor reverts with AssetNotFound of the asset list', async () => {
      await expect(configurator.connect(governor).updateAssetLiquidationFactor(comet, newAsset.asset, newAsset.liquidationFactor))
        .to.be.revertedWithCustomError(assetList, 'AssetNotFound');
    });

    it('updateAssetSupplyCap reverts with AssetNotFound of the asset list', async () => {
      await expect(configurator.connect(governor).updateAssetSupplyCap(comet, newAsset.asset, newAsset.supplyCap))
        .to.be.revertedWithCustomError(assetList, 'AssetNotFound');
    });
  });

  // The upgrade registers a new asset in the same call, so there is no moment when the list has the asset in its
  // immutables but not registered: the setters work on it right after the upgrade
  context('factors and supply cap can be updated for an asset just added by the asset list upgrade', function () {
    const BORROW_CF = exp(0.7, 18);
    const LIQUIDATE_CF = exp(0.85, 18);
    const LIQUIDATION_FACTOR = exp(0.95, 18);
    const SUPPLY_CAP = exp(2000, 18);

    let newAsset: AssetConfigStruct;

    before(async () => {
      await snapshot.restore();
      const token = await (await ethers.getContractFactory('FaucetToken')).deploy(0, 'New Asset', 18, 'NEW');
      const priceFeed = await (await ethers.getContractFactory('SimplePriceFeed')).deploy(10n ** 8n, 8);
      newAsset = {
        asset: token.address,
        priceFeed: priceFeed.address,
        borrowCollateralFactor: exp(0.75, 18),
        liquidateCollateralFactor: exp(0.8, 18),
        liquidationFactor: exp(0.9, 18),
        supplyCap: exp(1000, 18),
      };
      await configurator.connect(governor).addAsset(comet, newAsset);
      await proxyAdmin.connect(governor).deployAndUpgradeAssetListTo(configurator.address, comet);
    });

    it('sanity check: the asset list has the asset', async () => {
      expect((await assetList.getAssetInfoByAddress(newAsset.asset)).asset).to.equal(newAsset.asset);
    });

    it('updateAssetBorrowCollateralFactor is successful', async () => {
      await expect(configurator.connect(governor).updateAssetBorrowCollateralFactor(comet, newAsset.asset, BORROW_CF))
        .to.not.be.reverted;
    });

    it('the asset list has the new borrow collateral factor', async () => {
      expect((await assetList.getAssetInfoByAddress(newAsset.asset)).borrowCollateralFactor).to.equal(BORROW_CF);
    });

    it('updateAssetLiquidateCollateralFactor is successful', async () => {
      await expect(configurator.connect(governor).updateAssetLiquidateCollateralFactor(comet, newAsset.asset, LIQUIDATE_CF))
        .to.not.be.reverted;
    });

    it('the asset list has the new liquidate collateral factor', async () => {
      expect((await assetList.getAssetInfoByAddress(newAsset.asset)).liquidateCollateralFactor).to.equal(LIQUIDATE_CF);
    });

    it('updateAssetLiquidationFactor is successful', async () => {
      await expect(configurator.connect(governor).updateAssetLiquidationFactor(comet, newAsset.asset, LIQUIDATION_FACTOR))
        .to.not.be.reverted;
    });

    it('the asset list has the new liquidation factor', async () => {
      expect((await assetList.getAssetInfoByAddress(newAsset.asset)).liquidationFactor).to.equal(LIQUIDATION_FACTOR);
    });

    it('updateAssetSupplyCap is successful', async () => {
      await expect(configurator.connect(governor).updateAssetSupplyCap(comet, newAsset.asset, SUPPLY_CAP))
        .to.not.be.reverted;
    });

    it('the asset list has the new supply cap', async () => {
      expect((await assetList.getAssetInfoByAddress(newAsset.asset)).supplyCap).to.equal(SUPPLY_CAP);
    });
  });

  context('revert when the asset list is upgraded to an implementation that swaps two registered assets', function () {
    let swappedImplementation: AssetList;
    let swappedStorageConfigs: StorageAssetConfigStructOutput[];

    before(async () => {
      await snapshot.restore();
      const immutableConfigs = await configurator.getImmutableAssetConfig(comet);
      const storageConfigs = await configurator.getStorageAssetConfig(comet);
      const swappedConfigs = [immutableConfigs[1], immutableConfigs[0], ...immutableConfigs.slice(2)];
      swappedStorageConfigs = [storageConfigs[1], storageConfigs[0], ...storageConfigs.slice(2)];
      const AssetListContractFactory = (await ethers.getContractFactory('AssetList')) as AssetList__factory;
      swappedImplementation = await AssetListContractFactory.deploy(swappedConfigs, configurator.address);
    });

    it('sanity check: the first two assets are swapped in the new implementation', async () => {
      expect((await swappedImplementation.getAssetInfo(0)).asset).to.equal((await assetList.getAssetInfo(1)).asset);
      expect((await swappedImplementation.getAssetInfo(1)).asset).to.equal((await assetList.getAssetInfo(0)).asset);
    });

    // The asset now at index 0 was registered second, so the check fails on the first asset
    it('the upgrade reverts with AssetIndexMismatch at index 0', async () => {
      await expect(proxyAdmin.connect(governor).upgradeAndCall(
        assetList.address,
        swappedImplementation.address,
        assetList.interface.encodeFunctionData('setAssetConfigs', [swappedStorageConfigs])
      )).to.be.revertedWithCustomError(assetList, 'AssetIndexMismatch').withArgs(0);
    });
  });

  context('revert when the asset list is upgraded with fewer storage configs than assets', function () {
    let implementation: string;
    let fewerStorageConfigs: StorageAssetConfigStructOutput[];

    before(async () => {
      await snapshot.restore();
      implementation = await proxyAdmin.getProxyImplementation(assetList.address);
      fewerStorageConfigs = (await configurator.getStorageAssetConfig(comet)).slice(0, -1);
    });

    it('sanity check: there is one storage config less than assets', async () => {
      expect(fewerStorageConfigs.length).to.equal(COLLATERALS.length - 1);
    });

    it('the upgrade reverts with StorageConfigsLengthMismatch', async () => {
      await expect(proxyAdmin.connect(governor).upgradeAndCall(
        assetList.address,
        implementation,
        assetList.interface.encodeFunctionData('setAssetConfigs', [fewerStorageConfigs])
      )).to.be.revertedWithCustomError(assetList, 'StorageConfigsLengthMismatch');
    });
  });

  context('revert when the asset list is upgraded with more storage configs than assets', function () {
    let implementation: string;
    let moreStorageConfigs: StorageAssetConfigStructOutput[];

    before(async () => {
      await snapshot.restore();
      implementation = await proxyAdmin.getProxyImplementation(assetList.address);
      const storageConfigs = await configurator.getStorageAssetConfig(comet);
      moreStorageConfigs = [...storageConfigs, storageConfigs[0]];
    });

    it('sanity check: there is one storage config more than assets', async () => {
      expect(moreStorageConfigs.length).to.equal(COLLATERALS.length + 1);
    });

    it('the upgrade reverts with StorageConfigsLengthMismatch', async () => {
      await expect(proxyAdmin.connect(governor).upgradeAndCall(
        assetList.address,
        implementation,
        assetList.interface.encodeFunctionData('setAssetConfigs', [moreStorageConfigs])
      )).to.be.revertedWithCustomError(assetList, 'StorageConfigsLengthMismatch');
    });
  });

  // Factors are stored as given, with all 18 decimals, so factors one wei apart are still strictly ordered
  context('LCF can be updated to one wei above BCF', function () {
    const FULL_PRECISION_BORROW_CF = 123456000000000000n;
    const NEW_LIQUIDATE_CF = FULL_PRECISION_BORROW_CF + 1n;

    before(async () => {
      await snapshot.restore();
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await configurator.connect(governor).updateAssetBorrowCollateralFactor(comet, asset, FULL_PRECISION_BORROW_CF);
      }
    });

    it('sanity check: every asset has the full precision borrow collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).borrowCollateralFactor).to.equal(FULL_PRECISION_BORROW_CF);
      }
    });

    it('updateAssetLiquidateCollateralFactor is successful for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidateCollateralFactor(comet, asset, NEW_LIQUIDATE_CF)).to.not.be.reverted;
      }
    });

    it('every asset has the new liquidate collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidateCollateralFactor).to.equal(NEW_LIQUIDATE_CF);
      }
    });
  });

  // LCF can only go below the current BCF once BCF is zero
  context('LF can be updated to one wei above LCF', function () {
    const FULL_PRECISION_LIQUIDATE_CF = 123456000000000000n;
    const NEW_LIQUIDATION_FACTOR = FULL_PRECISION_LIQUIDATE_CF + 1n;

    before(async () => {
      await snapshot.restore();
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await configurator.connect(governor).updateAssetBorrowCollateralFactor(comet, asset, 0n);
        await configurator.connect(governor).updateAssetLiquidateCollateralFactor(comet, asset, FULL_PRECISION_LIQUIDATE_CF);
      }
    });

    it('sanity check: every asset has the borrow collateral factor of zero', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).borrowCollateralFactor).to.equal(0n);
      }
    });

    it('sanity check: every asset has the full precision liquidate collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidateCollateralFactor).to.equal(FULL_PRECISION_LIQUIDATE_CF);
      }
    });

    it('updateAssetLiquidationFactor is successful for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        const { asset } = await assetList.getAssetInfo(i);
        await expect(configurator.connect(governor).updateAssetLiquidationFactor(comet, asset, NEW_LIQUIDATION_FACTOR)).to.not.be.reverted;
      }
    });

    it('every asset has the new liquidation factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidationFactor).to.equal(NEW_LIQUIDATION_FACTOR);
      }
    });
  });

  /*//////////////////////////////////////////////////////////////
                            ACCESS CONTROL
  //////////////////////////////////////////////////////////////*/

  context('revert when the caller is not the configurator', function () {
    let assetInfo: AssetInfoStructOutput;

    before(async () => {
      await snapshot.restore();
      assetInfo = await assetList.getAssetInfo(0);
    });

    it('sanity check: the caller is not the configurator', async () => {
      expect(user.address).to.not.equal(await assetList.configurator());
    });

    it('setBorrowCollateralFactor reverts with OnlyConfigurator', async () => {
      await expect(assetList.connect(user).setBorrowCollateralFactor(assetInfo.asset, assetInfo.borrowCollateralFactor))
        .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
    });

    it('setLiquidateCollateralFactor reverts with OnlyConfigurator', async () => {
      await expect(assetList.connect(user).setLiquidateCollateralFactor(assetInfo.asset, assetInfo.liquidateCollateralFactor))
        .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
    });

    it('setLiquidationFactor reverts with OnlyConfigurator', async () => {
      await expect(assetList.connect(user).setLiquidationFactor(assetInfo.asset, assetInfo.liquidationFactor))
        .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
    });

    it('setSupplyCap reverts with OnlyConfigurator', async () => {
      await expect(assetList.connect(user).setSupplyCap(assetInfo.asset, assetInfo.supplyCap))
        .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
    });
  });

  context('revert when the caller of setAssetConfigs is not the proxy admin', function () {
    let storageConfigs: StorageAssetConfigStructOutput[];

    before(async () => {
      await snapshot.restore();
      storageConfigs = await configurator.getStorageAssetConfig(comet);
    });

    it('sanity check: the caller is not the proxy admin', async () => {
      expect(user.address).to.not.equal(await proxyAdmin.getProxyAdmin(assetList.address));
    });

    it('setAssetConfigs reverts with OnlyProxyAdmin', async () => {
      await expect(assetList.connect(user).setAssetConfigs(storageConfigs))
        .to.be.revertedWithCustomError(assetList, 'OnlyProxyAdmin');
    });
  });
});
