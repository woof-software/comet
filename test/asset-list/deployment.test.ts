import { MAX_ASSETS, MAX_UINT128, SignerWithAddress, ZERO_ADDRESS, ethers, exp, expect, factorScale, prepareAssets } from '../helpers';
import { AssetList, AssetList__factory, TransparentUpgradeableProxy__factory } from '../../build/types';
import { ImmutableAssetConfigStruct, StorageAssetConfigStruct } from '../../build/types/AssetList';

/*//////////////////////////////////////////////////////////////
                          SHARED CONSTANTS
//////////////////////////////////////////////////////////////*/

const MAX_ASSET_DECIMALS = 19;
const TYPEHASH = ethers.utils.id('ImmutableConfig[](address asset,address priceFeed)');
const DIFFERENT_DECIMALS_COLLATERALS: { symbol: string, decimals: number }[] = [
  { symbol: 'WETH', decimals: 18 },
  { symbol: 'WBTC', decimals: 8 },
  { symbol: 'USDT', decimals: 6 },
  { symbol: 'NODEC', decimals: 0 },
  { symbol: 'MAXDEC', decimals: MAX_ASSET_DECIMALS },
];

// The market's collateral assets, in the order they are listed, one per slot up to MAX_ASSETS
const COLLATERALS: { symbol: string, decimals: number }[] = [
  ...DIFFERENT_DECIMALS_COLLATERALS, // 1 - 5
  // The rest fill every slot left, 6 - 24
  ...Array.from({ length: MAX_ASSETS - DIFFERENT_DECIMALS_COLLATERALS.length }, (_, j) => ({
    symbol: `ASSET${j + DIFFERENT_DECIMALS_COLLATERALS.length}`,
    decimals: 18,
  })),
];

// The market: USDC as the base asset, then the collaterals
const ASSETS = {
  USDC: { decimals: 6, initialPrice: 1 },
  ...Object.fromEntries(COLLATERALS.map(({ symbol, decimals }) => [symbol, { decimals }])),
};

describe('asset list deployment: constructor', function () {
  let AssetListContractFactory: AssetList__factory;
  let assetList: AssetList; // the implementation, not initialized
  let immutableConfigs: ImmutableAssetConfigStruct[];
  let configurator: SignerWithAddress; // only its address matters here

  before(async () => {
    [configurator] = await ethers.getSigners();
    ({ immutableConfigs } = await prepareAssets({ base: 'USDC', assets: ASSETS }));
    AssetListContractFactory = (await ethers.getContractFactory('AssetList')) as AssetList__factory;
  });

  context('happy path', function () {
    it('deploys with the list of immutable configs', async () => {
      assetList = await AssetListContractFactory.deploy(immutableConfigs, configurator.address);
      await expect(assetList.deployTransaction).to.not.be.reverted;
    });

    it(`sets numAssets to the number of configs, ${MAX_ASSETS}: every slot is used`, async () => {
      expect(await assetList.numAssets()).to.equal(MAX_ASSETS);
    });

    it('sets configHash to the hash of the immutable configs', async () => {
      // ConfigHash.hashConfig(TYPEHASH, abi.encode(immutableConfigs)), computed off-chain
      const encodedConfigs = ethers.utils.defaultAbiCoder.encode(['tuple(address asset, address priceFeed)[]'], [immutableConfigs]);
      expect(await assetList.configHash()).to.equal(ethers.utils.keccak256(ethers.utils.hexConcat([TYPEHASH, encodedConfigs])));
    });

    it('sets the configurator', async () => {
      expect(await assetList.configurator()).to.equal(configurator.address);
    });

    it('the implementation cannot be initialized', async () => {
      await expect(assetList.initialize([])).to.be.revertedWith('Initializable: contract is already initialized');
    });

    it('every asset is stored at its index', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).asset).to.equal(immutableConfigs[i].asset);
      }
    });

    it('every asset has its price feed', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).priceFeed).to.equal(immutableConfigs[i].priceFeed);
      }
    });

    it('every asset has its index as the offset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).offset).to.equal(i);
      }
    });

    it('every asset has a scale of 10 to the power of its decimals', async () => {
      for (const [i, { decimals }] of COLLATERALS.entries()) {
        expect((await assetList.getAssetInfo(i)).scale).to.equal(10n ** BigInt(decimals));
      }
    });

    // Factors and supply caps live in storage, which only initialize fills, so the implementation has none

    it('every asset has no borrow collateral factor yet', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).borrowCollateralFactor).to.equal(0);
      }
    });

    it('every asset has no liquidate collateral factor yet', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidateCollateralFactor).to.equal(0);
      }
    });

    it('every asset has no liquidation factor yet', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidationFactor).to.equal(0);
      }
    });

    it('every asset has no supply cap yet', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(0);
      }
    });
  });

  context('happy path (same configs in a different order)', function () {
    let reorderedConfigs: ImmutableAssetConfigStruct[];
    let reorderedAssetList: AssetList;

    before(() => {
      reorderedConfigs = [...immutableConfigs].reverse();
    });

    it('deploys with the reordered configs', async () => {
      reorderedAssetList = await AssetListContractFactory.deploy(reorderedConfigs, configurator.address);
      await expect(reorderedAssetList.deployTransaction).to.not.be.reverted;
    });

    it('sets configHash to the hash of the reordered configs', async () => {
      // ConfigHash.hashConfig(TYPEHASH, abi.encode(reorderedConfigs)), computed off-chain
      const encodedConfigs = ethers.utils.defaultAbiCoder.encode(['tuple(address asset, address priceFeed)[]'], [reorderedConfigs]);
      expect(await reorderedAssetList.configHash()).to.equal(ethers.utils.keccak256(ethers.utils.hexConcat([TYPEHASH, encodedConfigs])));
    });

    it('gives a different configHash than the original order', async () => {
      expect(await reorderedAssetList.configHash()).to.not.equal(await assetList.configHash());
    });
  });

  context('revert when', function () {
    it('the list of configs is empty', async () => {
      await expect(AssetListContractFactory.deploy([], configurator.address)).to.be.revertedWithCustomError(assetList, 'NoAssets');
    });

    it(`there are more than ${MAX_ASSETS} configs`, async () => {
      await expect(AssetListContractFactory.deploy(Array(MAX_ASSETS + 1).fill(immutableConfigs[0]), configurator.address))
        .to.be.revertedWithCustomError(assetList, 'TooManyAssets');
    });

    it('a price feed does not have 8 decimals', async () => {
      const { immutableConfigs: [badPriceFeedConfig] } = await prepareAssets({
        base: 'USDC',
        assets: { USDC: ASSETS.USDC, BADFEED: { priceFeedDecimals: 18 } },
      });
      await expect(AssetListContractFactory.deploy([immutableConfigs[0], badPriceFeedConfig], configurator.address))
        .to.be.revertedWithCustomError(assetList, 'PriceFeedDecimalsNotMatched');
    });

    it(`an asset has more than ${MAX_ASSET_DECIMALS} decimals`, async () => {
      const { immutableConfigs: [tooManyDecimalsConfig] } = await prepareAssets({
        base: 'USDC',
        assets: { USDC: ASSETS.USDC, TOOMANYDEC: { decimals: MAX_ASSET_DECIMALS + 1 } },
      });
      await expect(AssetListContractFactory.deploy([immutableConfigs[0], tooManyDecimalsConfig], configurator.address))
        .to.be.revertedWithCustomError(assetList, 'MaxAssetDecimalsExceeds');
    });

    it('an asset inside the list is the zero address', async () => {
      await expect(AssetListContractFactory.deploy([immutableConfigs[0], { ...immutableConfigs[1], asset: ZERO_ADDRESS }, immutableConfigs[2]], configurator.address))
        .to.be.revertedWithCustomError(assetList, 'ZeroAddress');
    });

    it('the configurator is the zero address', async () => {
      await expect(AssetListContractFactory.deploy(immutableConfigs, ZERO_ADDRESS))
        .to.be.revertedWithCustomError(assetList, 'ZeroConfigurator');
    });

    it('a price feed inside the list is the zero address', async () => {
      await expect(AssetListContractFactory.deploy([immutableConfigs[0], { ...immutableConfigs[1], priceFeed: ZERO_ADDRESS }, immutableConfigs[2]], configurator.address))
        .to.be.revertedWithCustomError(assetList, 'ZeroAddress');
    });
  });
});

describe('asset list deployment: initialize', function () {
  let AssetListContractFactory: AssetList__factory;
  let ProxyContractFactory: TransparentUpgradeableProxy__factory;
  let assetListImplementation: AssetList;
  let immutableConfigs: ImmutableAssetConfigStruct[];
  // The valid factors and supply cap prepareAssets gives every asset; a revert case breaks one asset at a time
  let defaultStorageConfigs: StorageAssetConfigStruct[];
  // The same for a smaller market with only the collaterals of different decimals, and the implementation built from it
  let differentDecimalsStorageConfigs: StorageAssetConfigStruct[];
  let differentDecimalsImplementation: AssetList;
  // Only their addresses matter here
  let configurator: SignerWithAddress;
  let proxyAdmin: SignerWithAddress;

  const SUPPLY_CAP = exp(1000, 18);

  before(async () => {
    [configurator, proxyAdmin] = await ethers.getSigners();
    ({ immutableConfigs, storageConfigs: defaultStorageConfigs } = await prepareAssets({ base: 'USDC', assets: ASSETS }));
    AssetListContractFactory = (await ethers.getContractFactory('AssetList')) as AssetList__factory;
    ProxyContractFactory = (await ethers.getContractFactory('TransparentUpgradeableProxy')) as TransparentUpgradeableProxy__factory;
    assetListImplementation = await AssetListContractFactory.deploy(immutableConfigs, configurator.address);

    const differentDecimalsAssets = await prepareAssets({
      base: 'USDC',
      assets: {
        USDC: ASSETS.USDC,
        ...Object.fromEntries(DIFFERENT_DECIMALS_COLLATERALS.map(({ symbol, decimals }) => [symbol, { decimals }])),
      },
    });
    differentDecimalsStorageConfigs = differentDecimalsAssets.storageConfigs;
    differentDecimalsImplementation = await AssetListContractFactory.deploy(differentDecimalsAssets.immutableConfigs, configurator.address);
  });

  /*//////////////////////////////////////////////////////////////
                          COLLATERAL FACTORS
  //////////////////////////////////////////////////////////////*/

  context('can be initialized with BCF > 0, LCF > BCF and LF > LCF', function () {
    const BORROW_CF = exp(0.75, 18);
    const LIQUIDATE_CF = exp(0.8, 18);
    const LIQUIDATION_FACTOR = exp(0.9, 18);

    let assetList: AssetList;
    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      storageConfigs = COLLATERALS.map(() => ({
        borrowCollateralFactor: BORROW_CF,
        liquidateCollateralFactor: LIQUIDATE_CF,
        liquidationFactor: LIQUIDATION_FACTOR,
        supplyCap: SUPPLY_CAP,
      }));
    });

    it('deploys the asset list proxy, initialized with the factors and supply cap of every asset', async () => {
      const proxy = await ProxyContractFactory.deploy(
        assetListImplementation.address,
        proxyAdmin.address,
        assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      );
      await expect(proxy.deployTransaction).to.not.be.reverted;
      assetList = assetListImplementation.attach(proxy.address);
    });

    it('every asset has the borrow collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).borrowCollateralFactor).to.equal(BORROW_CF);
      }
    });

    it('every asset has the liquidate collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidateCollateralFactor).to.equal(LIQUIDATE_CF);
      }
    });

    it('every asset has the liquidation factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidationFactor).to.equal(LIQUIDATION_FACTOR);
      }
    });

    it('every asset has the supply cap', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(SUPPLY_CAP);
      }
    });
  });

  context('can be initialized with BCF = 0, LCF > 0 and LF > LCF', function () {
    const BORROW_CF = 0n;
    const LIQUIDATE_CF = exp(0.8, 18);
    const LIQUIDATION_FACTOR = exp(0.9, 18);

    let assetList: AssetList;
    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      storageConfigs = COLLATERALS.map(() => ({
        borrowCollateralFactor: BORROW_CF,
        liquidateCollateralFactor: LIQUIDATE_CF,
        liquidationFactor: LIQUIDATION_FACTOR,
        supplyCap: SUPPLY_CAP,
      }));
    });

    it('deploys the asset list proxy, initialized with the factors and supply cap of every asset', async () => {
      const proxy = await ProxyContractFactory.deploy(
        assetListImplementation.address,
        proxyAdmin.address,
        assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      );
      await expect(proxy.deployTransaction).to.not.be.reverted;
      assetList = assetListImplementation.attach(proxy.address);
    });

    it('every asset has the borrow collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).borrowCollateralFactor).to.equal(BORROW_CF);
      }
    });

    it('every asset has the liquidate collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidateCollateralFactor).to.equal(LIQUIDATE_CF);
      }
    });

    it('every asset has the liquidation factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidationFactor).to.equal(LIQUIDATION_FACTOR);
      }
    });

    it('every asset has the supply cap', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(SUPPLY_CAP);
      }
    });
  });

  context('can be initialized with BCF = 0, LCF = 0 and LF > 0', function () {
    const BORROW_CF = 0n;
    const LIQUIDATE_CF = 0n;
    const LIQUIDATION_FACTOR = exp(0.9, 18);

    let assetList: AssetList;
    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      storageConfigs = COLLATERALS.map(() => ({
        borrowCollateralFactor: BORROW_CF,
        liquidateCollateralFactor: LIQUIDATE_CF,
        liquidationFactor: LIQUIDATION_FACTOR,
        supplyCap: SUPPLY_CAP,
      }));
    });

    it('deploys the asset list proxy, initialized with the factors and supply cap of every asset', async () => {
      const proxy = await ProxyContractFactory.deploy(
        assetListImplementation.address,
        proxyAdmin.address,
        assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      );
      await expect(proxy.deployTransaction).to.not.be.reverted;
      assetList = assetListImplementation.attach(proxy.address);
    });

    it('every asset has the borrow collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).borrowCollateralFactor).to.equal(BORROW_CF);
      }
    });

    it('every asset has the liquidate collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidateCollateralFactor).to.equal(LIQUIDATE_CF);
      }
    });

    it('every asset has the liquidation factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidationFactor).to.equal(LIQUIDATION_FACTOR);
      }
    });

    it('every asset has the supply cap', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(SUPPLY_CAP);
      }
    });
  });

  context('can be initialized with BCF = 0, LCF = 0 and LF = 0', function () {
    const BORROW_CF = 0n;
    const LIQUIDATE_CF = 0n;
    const LIQUIDATION_FACTOR = 0n;

    let assetList: AssetList;
    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      storageConfigs = COLLATERALS.map(() => ({
        borrowCollateralFactor: BORROW_CF,
        liquidateCollateralFactor: LIQUIDATE_CF,
        liquidationFactor: LIQUIDATION_FACTOR,
        supplyCap: SUPPLY_CAP,
      }));
    });

    it('deploys the asset list proxy, initialized with the factors and supply cap of every asset', async () => {
      const proxy = await ProxyContractFactory.deploy(
        assetListImplementation.address,
        proxyAdmin.address,
        assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      );
      await expect(proxy.deployTransaction).to.not.be.reverted;
      assetList = assetListImplementation.attach(proxy.address);
    });

    it('every asset has the borrow collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).borrowCollateralFactor).to.equal(BORROW_CF);
      }
    });

    it('every asset has the liquidate collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidateCollateralFactor).to.equal(LIQUIDATE_CF);
      }
    });

    it('every asset has the liquidation factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidationFactor).to.equal(LIQUIDATION_FACTOR);
      }
    });

    it('every asset has the supply cap', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(SUPPLY_CAP);
      }
    });
  });

  context('can be initialized with LF at the maximum, 1e18', function () {
    const BORROW_CF = exp(0.75, 18);
    const LIQUIDATE_CF = exp(0.8, 18);
    const LIQUIDATION_FACTOR = factorScale;

    let assetList: AssetList;
    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      storageConfigs = COLLATERALS.map(() => ({
        borrowCollateralFactor: BORROW_CF,
        liquidateCollateralFactor: LIQUIDATE_CF,
        liquidationFactor: LIQUIDATION_FACTOR,
        supplyCap: SUPPLY_CAP,
      }));
    });

    it('deploys the asset list proxy, initialized with the factors and supply cap of every asset', async () => {
      const proxy = await ProxyContractFactory.deploy(
        assetListImplementation.address,
        proxyAdmin.address,
        assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      );
      await expect(proxy.deployTransaction).to.not.be.reverted;
      assetList = assetListImplementation.attach(proxy.address);
    });

    it('every asset has the borrow collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).borrowCollateralFactor).to.equal(BORROW_CF);
      }
    });

    it('every asset has the liquidate collateral factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidateCollateralFactor).to.equal(LIQUIDATE_CF);
      }
    });

    it('every asset has the liquidation factor', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).liquidationFactor).to.equal(LIQUIDATION_FACTOR);
      }
    });

    it('every asset has the supply cap', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(SUPPLY_CAP);
      }
    });
  });

  context('revert when BCF equals LCF and both are non-zero', function () {
    const BORROW_CF = exp(0.8, 18);
    const LIQUIDATE_CF = exp(0.8, 18);
    const LIQUIDATION_FACTOR = exp(0.9, 18);

    it('reverts with BorrowCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        // Only asset i gets the factors, every other asset keeps its valid ones
        const storageConfigs = defaultStorageConfigs.map((config, j) => (j === i ? {
          ...config,
          borrowCollateralFactor: BORROW_CF,
          liquidateCollateralFactor: LIQUIDATE_CF,
          liquidationFactor: LIQUIDATION_FACTOR,
        } : config));

        await expect(ProxyContractFactory.deploy(
          assetListImplementation.address,
          proxyAdmin.address,
          assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
        )).to.be.revertedWithCustomError(assetListImplementation, 'BorrowCFTooLarge');
      }
    });
  });

  context('revert when BCF exceeds LCF', function () {
    const BORROW_CF = exp(0.8, 18) + 1n;
    const LIQUIDATE_CF = exp(0.8, 18);
    const LIQUIDATION_FACTOR = exp(0.9, 18);

    it('reverts with BorrowCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        // Only asset i gets the factors, every other asset keeps its valid ones
        const storageConfigs = defaultStorageConfigs.map((config, j) => (j === i ? {
          ...config,
          borrowCollateralFactor: BORROW_CF,
          liquidateCollateralFactor: LIQUIDATE_CF,
          liquidationFactor: LIQUIDATION_FACTOR,
        } : config));

        await expect(ProxyContractFactory.deploy(
          assetListImplementation.address,
          proxyAdmin.address,
          assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
        )).to.be.revertedWithCustomError(assetListImplementation, 'BorrowCFTooLarge');
      }
    });
  });

  context('revert when BCF is non-zero and LCF is zero', function () {
    const BORROW_CF = exp(0.75, 18);
    const LIQUIDATE_CF = 0n;
    const LIQUIDATION_FACTOR = exp(0.9, 18);

    it('reverts with BorrowCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        // Only asset i gets the factors, every other asset keeps its valid ones
        const storageConfigs = defaultStorageConfigs.map((config, j) => (j === i ? {
          ...config,
          borrowCollateralFactor: BORROW_CF,
          liquidateCollateralFactor: LIQUIDATE_CF,
          liquidationFactor: LIQUIDATION_FACTOR,
        } : config));

        await expect(ProxyContractFactory.deploy(
          assetListImplementation.address,
          proxyAdmin.address,
          assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
        )).to.be.revertedWithCustomError(assetListImplementation, 'BorrowCFTooLarge');
      }
    });
  });

  context('revert when LCF equals LF and both are non-zero', function () {
    const BORROW_CF = exp(0.75, 18);
    const LIQUIDATE_CF = exp(0.9, 18);
    const LIQUIDATION_FACTOR = exp(0.9, 18);

    it('reverts with LiquidateCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        // Only asset i gets the factors, every other asset keeps its valid ones
        const storageConfigs = defaultStorageConfigs.map((config, j) => (j === i ? {
          ...config,
          borrowCollateralFactor: BORROW_CF,
          liquidateCollateralFactor: LIQUIDATE_CF,
          liquidationFactor: LIQUIDATION_FACTOR,
        } : config));

        await expect(ProxyContractFactory.deploy(
          assetListImplementation.address,
          proxyAdmin.address,
          assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
        )).to.be.revertedWithCustomError(assetListImplementation, 'LiquidateCFTooLarge');
      }
    });
  });

  context('revert when LCF exceeds LF', function () {
    const BORROW_CF = exp(0.75, 18);
    const LIQUIDATE_CF = exp(0.9, 18) + 1n;
    const LIQUIDATION_FACTOR = exp(0.9, 18);

    it('reverts with LiquidateCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        // Only asset i gets the factors, every other asset keeps its valid ones
        const storageConfigs = defaultStorageConfigs.map((config, j) => (j === i ? {
          ...config,
          borrowCollateralFactor: BORROW_CF,
          liquidateCollateralFactor: LIQUIDATE_CF,
          liquidationFactor: LIQUIDATION_FACTOR,
        } : config));

        await expect(ProxyContractFactory.deploy(
          assetListImplementation.address,
          proxyAdmin.address,
          assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
        )).to.be.revertedWithCustomError(assetListImplementation, 'LiquidateCFTooLarge');
      }
    });
  });

  context('revert when LCF is non-zero and LF is zero', function () {
    const BORROW_CF = exp(0.75, 18);
    const LIQUIDATE_CF = exp(0.8, 18);
    const LIQUIDATION_FACTOR = 0n;

    it('reverts with LiquidateCFTooLarge for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        // Only asset i gets the factors, every other asset keeps its valid ones
        const storageConfigs = defaultStorageConfigs.map((config, j) => (j === i ? {
          ...config,
          borrowCollateralFactor: BORROW_CF,
          liquidateCollateralFactor: LIQUIDATE_CF,
          liquidationFactor: LIQUIDATION_FACTOR,
        } : config));

        await expect(ProxyContractFactory.deploy(
          assetListImplementation.address,
          proxyAdmin.address,
          assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
        )).to.be.revertedWithCustomError(assetListImplementation, 'LiquidateCFTooLarge');
      }
    });
  });

  context('revert when LF exceeds the maximum, 1e18', function () {
    const BORROW_CF = exp(0.75, 18);
    const LIQUIDATE_CF = exp(0.8, 18);
    const LIQUIDATION_FACTOR = factorScale + 1n;

    it('reverts with LiqPenaltyTooHigh for every asset', async () => {
      for (let i = 0; i < COLLATERALS.length; i++) {
        // Only asset i gets the factors, every other asset keeps its valid ones
        const storageConfigs = defaultStorageConfigs.map((config, j) => (j === i ? {
          ...config,
          borrowCollateralFactor: BORROW_CF,
          liquidateCollateralFactor: LIQUIDATE_CF,
          liquidationFactor: LIQUIDATION_FACTOR,
        } : config));

        await expect(ProxyContractFactory.deploy(
          assetListImplementation.address,
          proxyAdmin.address,
          assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
        )).to.be.revertedWithCustomError(assetListImplementation, 'LiqPenaltyTooHigh');
      }
    });
  });

  /*//////////////////////////////////////////////////////////////
                            SUPPLY CAPS
  //////////////////////////////////////////////////////////////*/

  context('can be initialized with a 1 wei supply cap', function () {
    let assetList: AssetList;
    let supplyCaps: bigint[];
    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      // Every collateral gets the cap in its own token units
      supplyCaps = DIFFERENT_DECIMALS_COLLATERALS.map(() => 1n);
      storageConfigs = differentDecimalsStorageConfigs.map((config, i) => ({ ...config, supplyCap: supplyCaps[i] }));
    });

    it('deploys the asset list proxy, initialized with the supply caps', async () => {
      const proxy = await ProxyContractFactory.deploy(
        differentDecimalsImplementation.address,
        proxyAdmin.address,
        differentDecimalsImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      );
      await expect(proxy.deployTransaction).to.not.be.reverted;
      assetList = differentDecimalsImplementation.attach(proxy.address);
    });

    it('every collateral with different decimals has its supply cap', async () => {
      for (let i = 0; i < supplyCaps.length; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(supplyCaps[i]);
      }
    });
  });

  context('can be initialized with a supply cap one wei below a whole token', function () {
    let assetList: AssetList;
    let supplyCaps: bigint[];
    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      // Every collateral gets the cap in its own token units
      supplyCaps = DIFFERENT_DECIMALS_COLLATERALS.map(({ decimals }) => 10n ** BigInt(decimals) - 1n);
      storageConfigs = differentDecimalsStorageConfigs.map((config, i) => ({ ...config, supplyCap: supplyCaps[i] }));
    });

    it('deploys the asset list proxy, initialized with the supply caps', async () => {
      const proxy = await ProxyContractFactory.deploy(
        differentDecimalsImplementation.address,
        proxyAdmin.address,
        differentDecimalsImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      );
      await expect(proxy.deployTransaction).to.not.be.reverted;
      assetList = differentDecimalsImplementation.attach(proxy.address);
    });

    it('every collateral with different decimals has its supply cap', async () => {
      for (let i = 0; i < supplyCaps.length; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(supplyCaps[i]);
      }
    });
  });

  context('can be initialized with a supply cap of 0.5 token', function () {
    let assetList: AssetList;
    let supplyCaps: bigint[];
    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      // Every collateral gets the cap in its own token units
      supplyCaps = DIFFERENT_DECIMALS_COLLATERALS.map(({ decimals }) => 10n ** BigInt(decimals) / 2n);
      storageConfigs = differentDecimalsStorageConfigs.map((config, i) => ({ ...config, supplyCap: supplyCaps[i] }));
    });

    it('deploys the asset list proxy, initialized with the supply caps', async () => {
      const proxy = await ProxyContractFactory.deploy(
        differentDecimalsImplementation.address,
        proxyAdmin.address,
        differentDecimalsImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      );
      await expect(proxy.deployTransaction).to.not.be.reverted;
      assetList = differentDecimalsImplementation.attach(proxy.address);
    });

    it('every collateral with different decimals has its supply cap', async () => {
      for (let i = 0; i < supplyCaps.length; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(supplyCaps[i]);
      }
    });
  });

  context('can be initialized with a supply cap of 10.5 tokens', function () {
    let assetList: AssetList;
    let supplyCaps: bigint[];
    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      // Every collateral gets the cap in its own token units
      supplyCaps = DIFFERENT_DECIMALS_COLLATERALS.map(({ decimals }) => 10n ** BigInt(decimals) * 21n / 2n);
      storageConfigs = differentDecimalsStorageConfigs.map((config, i) => ({ ...config, supplyCap: supplyCaps[i] }));
    });

    it('deploys the asset list proxy, initialized with the supply caps', async () => {
      const proxy = await ProxyContractFactory.deploy(
        differentDecimalsImplementation.address,
        proxyAdmin.address,
        differentDecimalsImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      );
      await expect(proxy.deployTransaction).to.not.be.reverted;
      assetList = differentDecimalsImplementation.attach(proxy.address);
    });

    it('every collateral with different decimals has its supply cap', async () => {
      for (let i = 0; i < supplyCaps.length; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(supplyCaps[i]);
      }
    });
  });

  context('can be initialized with the max uint128 supply cap', function () {
    let assetList: AssetList;
    let supplyCaps: bigint[];
    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      // Every collateral gets the cap in its own token units
      supplyCaps = DIFFERENT_DECIMALS_COLLATERALS.map(() => MAX_UINT128);
      storageConfigs = differentDecimalsStorageConfigs.map((config, i) => ({ ...config, supplyCap: supplyCaps[i] }));
    });

    it('deploys the asset list proxy, initialized with the supply caps', async () => {
      const proxy = await ProxyContractFactory.deploy(
        differentDecimalsImplementation.address,
        proxyAdmin.address,
        differentDecimalsImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      );
      await expect(proxy.deployTransaction).to.not.be.reverted;
      assetList = differentDecimalsImplementation.attach(proxy.address);
    });

    it('every collateral with different decimals has its supply cap', async () => {
      for (let i = 0; i < supplyCaps.length; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(supplyCaps[i]);
      }
    });
  });

  context('can be initialized with a zero supply cap', function () {
    let assetList: AssetList;
    let supplyCaps: bigint[];
    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      // Every collateral gets the cap in its own token units
      supplyCaps = DIFFERENT_DECIMALS_COLLATERALS.map(() => 0n);
      storageConfigs = differentDecimalsStorageConfigs.map((config, i) => ({ ...config, supplyCap: supplyCaps[i] }));
    });

    it('deploys the asset list proxy, initialized with the supply caps', async () => {
      const proxy = await ProxyContractFactory.deploy(
        differentDecimalsImplementation.address,
        proxyAdmin.address,
        differentDecimalsImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      );
      await expect(proxy.deployTransaction).to.not.be.reverted;
      assetList = differentDecimalsImplementation.attach(proxy.address);
    });

    it('every collateral with different decimals has its supply cap', async () => {
      for (let i = 0; i < supplyCaps.length; i++) {
        expect((await assetList.getAssetInfo(i)).supplyCap).to.equal(supplyCaps[i]);
      }
    });
  });

  /*//////////////////////////////////////////////////////////////
                          GENERAL REVERT CASES
  //////////////////////////////////////////////////////////////*/

  context('revert when there are fewer storage configs than assets', function () {
    const BORROW_CF = exp(0.75, 18);
    const LIQUIDATE_CF = exp(0.8, 18);
    const LIQUIDATION_FACTOR = exp(0.9, 18);

    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      storageConfigs = COLLATERALS.slice(1).map(() => ({
        borrowCollateralFactor: BORROW_CF,
        liquidateCollateralFactor: LIQUIDATE_CF,
        liquidationFactor: LIQUIDATION_FACTOR,
        supplyCap: SUPPLY_CAP,
      }));
    });

    it('reverts with StorageConfigsLengthMismatch', async () => {
      await expect(ProxyContractFactory.deploy(
        assetListImplementation.address,
        proxyAdmin.address,
        assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      )).to.be.revertedWithCustomError(assetListImplementation, 'StorageConfigsLengthMismatch');
    });
  });

  context('revert when there are more storage configs than assets', function () {
    const BORROW_CF = exp(0.75, 18);
    const LIQUIDATE_CF = exp(0.8, 18);
    const LIQUIDATION_FACTOR = exp(0.9, 18);

    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      storageConfigs = [...COLLATERALS, COLLATERALS[0]].map(() => ({
        borrowCollateralFactor: BORROW_CF,
        liquidateCollateralFactor: LIQUIDATE_CF,
        liquidationFactor: LIQUIDATION_FACTOR,
        supplyCap: SUPPLY_CAP,
      }));
    });

    it('reverts with StorageConfigsLengthMismatch', async () => {
      await expect(ProxyContractFactory.deploy(
        assetListImplementation.address,
        proxyAdmin.address,
        assetListImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      )).to.be.revertedWithCustomError(assetListImplementation, 'StorageConfigsLengthMismatch');
    });
  });

  // The constructor does not check for duplicates, so they surface when initialize registers the assets
  context('revert when the same asset is listed twice', function () {
    const BORROW_CF = exp(0.75, 18);
    const LIQUIDATE_CF = exp(0.8, 18);
    const LIQUIDATION_FACTOR = exp(0.9, 18);

    let storageConfigs: StorageAssetConfigStruct[];

    before(() => {
      storageConfigs = [0, 1].map(() => ({
        borrowCollateralFactor: BORROW_CF,
        liquidateCollateralFactor: LIQUIDATE_CF,
        liquidationFactor: LIQUIDATION_FACTOR,
        supplyCap: SUPPLY_CAP,
      }));
    });

    it('reverts with AssetAlreadyAdded', async () => {
      const duplicatesImplementation = await AssetListContractFactory.deploy([immutableConfigs[0], immutableConfigs[0]], configurator.address);
      await expect(ProxyContractFactory.deploy(
        duplicatesImplementation.address,
        proxyAdmin.address,
        duplicatesImplementation.interface.encodeFunctionData('initialize', [storageConfigs])
      )).to.be.revertedWithCustomError(assetListImplementation, 'AssetAlreadyAdded');
    });
  });
});
