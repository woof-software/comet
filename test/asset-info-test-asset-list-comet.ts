import { AssetList, AssetList__factory, FaucetToken, FaucetToken__factory, SimplePriceFeed, SimplePriceFeed__factory, TransparentUpgradeableProxy__factory } from 'build/types';
import { expect, exp, makeConfigurator, makeProtocol, ethers, MAX_ASSETS, takeSnapshot, SnapshotRestorer, SignerWithAddress } from './helpers';
import { AssetInfoStructOutput } from 'build/types/AssetList';
import { AssetConfigStruct } from 'build/types/Configurator';

describe('asset info', function () {
  it('initializes protocol', async () => {
    // Factors are set explicitly, because makeProtocol and the configurator fall back to different defaults
    const factors = { borrowCF: exp(0.75, 18), liquidateCF: exp(0.8, 18), liquidationFactor: exp(0.9, 18) };
    const { cometWithExtendedAssetList, cometProxyWithExtendedAssetList, configurator, configuratorProxy } = await makeConfigurator({
      assets: {
        USDC: {},
        ASSET1: factors,
        ASSET2: factors,
        ASSET3: factors,
      },
      reward: 'ASSET1',
    });
    const comet = cometWithExtendedAssetList.attach(cometProxyWithExtendedAssetList.address);
    const configuratorAsProxy = configurator.attach(configuratorProxy.address);

    // The configurator holds the asset configs this comet was built from, so every asset info must match them
    const assetConfigs = await configuratorAsProxy.getAssetConfigs(comet.address);
    expect(await comet.numAssets()).to.be.equal(assetConfigs.length);

    for (let i = 0; i < assetConfigs.length; i++) {
      const assetInfo = await comet.getAssetInfo(i);
      expect(assetInfo.asset).to.be.equal(assetConfigs[i].asset);
      expect(assetInfo.priceFeed).to.be.equal(assetConfigs[i].priceFeed);
      expect(assetInfo.borrowCollateralFactor).to.equal(assetConfigs[i].borrowCollateralFactor);
      expect(assetInfo.liquidateCollateralFactor).to.equal(assetConfigs[i].liquidateCollateralFactor);
      expect(assetInfo.liquidationFactor).to.equal(assetConfigs[i].liquidationFactor);
    }
  });

  it('reverts if too many assets are passed', async () => {
    await expect(
      makeProtocol({
        assets: {
          USDC: {},
          ASSET1: {},
          ASSET2: {},
          ASSET3: {},
          ASSET4: {},
          ASSET5: {},
          ASSET6: {},
          ASSET7: {},
          ASSET8: {},
          ASSET9: {},
          ASSET10: {},
          ASSET11: {},
          ASSET12: {},
          ASSET13: {},
          ASSET14: {},
          ASSET15: {},
          ASSET16: {},
          ASSET17: {},
          ASSET18: {},
          ASSET19: {},
          ASSET20: {},
          ASSET21: {},
          ASSET22: {},
          ASSET23: {},
          ASSET24: {},
          ASSET25: {},
        },
        reward: 'ASSET1',
      })
    ).to.be.revertedWith("custom error 'TooManyAssets()'");
  });

  it('reverts if index is greater than numAssets', async () => {
    const { cometWithExtendedAssetList } = await makeConfigurator();
    await expect(cometWithExtendedAssetList.getAssetInfo(3)).to.be.revertedWith("custom error 'BadAsset()'");
  });

  context('collateral factors validation', function () {
    let assetList: AssetList;
    let faucetToken: FaucetToken;
    let priceFeed: SimplePriceFeed;

    // Collateral factors of a normal active collateral, strictly ordered below the maximum.
    const collateralBCF = exp(0.75, 18);
    const collateralLCF = exp(0.8, 18);
    const collateralLF = exp(0.9, 18);

    // Base valid config; each test spreads this and overrides only the field(s) under test.
    let baseAssetConfig: {
      asset: string;
      priceFeed: string;
      decimals: number;
      borrowCollateralFactor: bigint;
      liquidateCollateralFactor: bigint;
      liquidationFactor: bigint;
      supplyCap: bigint;
    };

    // Deploys an asset list the way a market gets one: the implementation holds the immutable part of the config,
    // and the proxy is initialized with the factors and the supply cap, which is where they are validated
    async function deployAssetList(assetConfig: typeof baseAssetConfig): Promise<AssetList> {
      const [, proxyAdmin, configurator] = await ethers.getSigners();
      const AssetListFactory = await ethers.getContractFactory('AssetList') as AssetList__factory;
      const implementation = await AssetListFactory.deploy([{
        asset: assetConfig.asset,
        decimals: assetConfig.decimals,
        priceFeed: assetConfig.priceFeed,
      }]);
      const proxy = await (await ethers.getContractFactory('TransparentUpgradeableProxy') as TransparentUpgradeableProxy__factory).deploy(
        implementation.address,
        proxyAdmin.address,
        AssetListFactory.interface.encodeFunctionData('initialize', [[{
          borrowCollateralFactor: assetConfig.borrowCollateralFactor,
          liquidateCollateralFactor: assetConfig.liquidateCollateralFactor,
          liquidationFactor: assetConfig.liquidationFactor,
          supplyCap: assetConfig.supplyCap,
        }], configurator.address]),
      );
      return AssetListFactory.attach(proxy.address);
    }

    before(async () => {
      faucetToken = await (await ethers.getContractFactory('FaucetToken') as FaucetToken__factory).deploy(10n ** 24n, 'Test Token', 18, 'TEST');

      priceFeed = await (await ethers.getContractFactory('SimplePriceFeed') as SimplePriceFeed__factory).deploy(exp(1, 8), 8);

      baseAssetConfig = {
        asset: faucetToken.address,
        priceFeed: priceFeed.address,
        decimals: 18,
        borrowCollateralFactor: collateralBCF,
        liquidateCollateralFactor: collateralLCF,
        liquidationFactor: collateralLF,
        supplyCap: 10n ** 24n,
      };

      assetList = await deployAssetList(baseAssetConfig);
    });

    // normal active collateral
    context('active collateral: BCF > 0, LCF > BCF, LF > LCF', function () {
      let assetInfo: AssetInfoStructOutput;

      before(async () => {
        const assetList = await deployAssetList({
          ...baseAssetConfig,
          borrowCollateralFactor: collateralBCF,
          liquidateCollateralFactor: collateralLCF,
          liquidationFactor: collateralLF,
        });
        assetInfo = await assetList.getAssetInfo(0);
      });

      it('stores borrowCollateralFactor', () => {
        expect(assetInfo.borrowCollateralFactor).to.equal(collateralBCF);
        expect(assetInfo.borrowCollateralFactor).to.be.greaterThan(0);
      });

      it('stores liquidateCollateralFactor', () => {
        expect(assetInfo.liquidateCollateralFactor).to.equal(collateralLCF);
      });

      it('stores liquidationFactor', () => {
        expect(assetInfo.liquidationFactor).to.equal(collateralLF);
      });
    });

    // soft de-listed
    context('soft de-listed collateral: BCF = 0, LCF > 0, LF > LCF', function () {
      let assetInfo: AssetInfoStructOutput;

      before(async () => {
        const assetList = await deployAssetList({
          ...baseAssetConfig,
          borrowCollateralFactor: 0n,
          liquidateCollateralFactor: collateralLCF,
          liquidationFactor: collateralLF,
        });
        assetInfo = await assetList.getAssetInfo(0);
      });

      it('stores borrowCollateralFactor as zero', () => {
        expect(assetInfo.borrowCollateralFactor).to.equal(0);
      });

      it('stores liquidateCollateralFactor', () => {
        expect(assetInfo.liquidateCollateralFactor).to.equal(collateralLCF);
      });

      it('stores liquidationFactor', () => {
        expect(assetInfo.liquidationFactor).to.equal(collateralLF);
      });
    });

    // fully de-listed
    context('fully de-listed collateral: BCF = 0, LCF = 0, LF > 0', function () {
      let assetInfo: AssetInfoStructOutput;

      before(async () => {
        const assetList = await deployAssetList({
          ...baseAssetConfig,
          borrowCollateralFactor: 0n,
          liquidateCollateralFactor: 0n,
          liquidationFactor: collateralLF,
        });
        assetInfo = await assetList.getAssetInfo(0);
      });

      it('stores borrowCollateralFactor as zero', () => {
        expect(assetInfo.borrowCollateralFactor).to.equal(0);
      });

      it('stores liquidateCollateralFactor as zero', () => {
        expect(assetInfo.liquidateCollateralFactor).to.equal(0);
      });

      it('stores liquidationFactor', () => {
        expect(assetInfo.liquidationFactor).to.equal(collateralLF);
      });
    });

    // non-liquidatable
    context('non-liquidatable collateral: BCF = 0, LCF = 0, LF = 0', function () {
      let assetInfo: AssetInfoStructOutput;

      before(async () => {
        const assetList = await deployAssetList({
          ...baseAssetConfig,
          borrowCollateralFactor: 0n,
          liquidateCollateralFactor: 0n,
          liquidationFactor: 0n,
        });
        assetInfo = await assetList.getAssetInfo(0);
      });

      it('stores borrowCollateralFactor as zero', () => {
        expect(assetInfo.borrowCollateralFactor).to.equal(0);
      });

      it('stores liquidateCollateralFactor as zero', () => {
        expect(assetInfo.liquidateCollateralFactor).to.equal(0);
      });

      it('stores liquidationFactor as zero', () => {
        expect(assetInfo.liquidationFactor).to.equal(0);
      });
    });

    // liquidation factor at maximum
    context('liquidation factor at maximum: LF = 1e18', function () {
      let assetInfo: AssetInfoStructOutput;

      before(async () => {
        const assetList = await deployAssetList({
          ...baseAssetConfig,
          liquidationFactor: exp(1, 18),
        });
        assetInfo = await assetList.getAssetInfo(0);
      });

      it('stores borrowCollateralFactor', () => {
        expect(assetInfo.borrowCollateralFactor).to.equal(collateralBCF);
      });

      it('stores liquidateCollateralFactor', () => {
        expect(assetInfo.liquidateCollateralFactor).to.equal(collateralLCF);
      });

      it('stores liquidationFactor at maximum', () => {
        expect(assetInfo.liquidationFactor).to.equal(exp(1, 18));
      });
    });

    context('revert when', function () {
      // borrow collateral factor too large

      it('BCF equals LCF when both are non-zero', async () => {
        await expect(
          deployAssetList({ ...baseAssetConfig, borrowCollateralFactor: collateralLCF, liquidateCollateralFactor: collateralLCF })
        ).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      });

      it('BCF exceeds LCF', async () => {
        await expect(
          deployAssetList({ ...baseAssetConfig, borrowCollateralFactor: collateralLF, liquidateCollateralFactor: collateralLCF })
        ).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      });

      it('BCF is non-zero but LCF is zero', async () => {
        await expect(
          deployAssetList({ ...baseAssetConfig, liquidateCollateralFactor: 0n })
        ).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      });

      // liquidate collateral factor too large

      it('LCF equals LF when both are non-zero', async () => {
        await expect(
          deployAssetList({ ...baseAssetConfig, borrowCollateralFactor: 0n, liquidateCollateralFactor: collateralLF, liquidationFactor: collateralLF })
        ).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      });

      it('LCF exceeds LF', async () => {
        await expect(
          deployAssetList({ ...baseAssetConfig, borrowCollateralFactor: 0n, liquidateCollateralFactor: collateralLF, liquidationFactor: collateralLCF })
        ).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      });

      it('LCF is non-zero but LF is zero', async () => {
        // LCF > 0 means LCF >= LF=0 is always true → LiquidateCFTooLarge
        await expect(
          deployAssetList({ ...baseAssetConfig, borrowCollateralFactor: 0n, liquidationFactor: 0n })
        ).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      });

      // liquidation penalty too high

      it('LF exceeds MAX_COLLATERAL_FACTOR', async () => {
        await expect(
          deployAssetList({ ...baseAssetConfig, liquidationFactor: exp(1, 18) + 1n })
        ).to.be.revertedWithCustomError(assetList, 'LiqPenaltyTooHigh');
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
          const assetList = await deployAssetList({
            ...baseAssetConfig,
            borrowCollateralFactor: factor,
            liquidateCollateralFactor: factor + 1n,
          });
          assetInfo = await assetList.getAssetInfo(0);
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
          const assetList = await deployAssetList({
            ...baseAssetConfig,
            borrowCollateralFactor: 0n,
            liquidateCollateralFactor: factor,
            liquidationFactor: factor + 1n,
          });
          assetInfo = await assetList.getAssetInfo(0);
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


  /*
   * The supply cap is stored exactly as configured, fractions of a token included.
   * Every flow runs for each token decimals variant, because the cap must behave the same way
   * whatever the decimals are. Each flow uses a full market of 24 collaterals and checks every one
   * of them, so every storage slot of the asset list is covered. The tokens are deployed once per
   * decimals variant, and each flow applies its own cap on top of that shared config.
   */
  describe('supply cap', function () {
    // The largest value the uint128 supply cap field can hold
    const MAX_UINT128 = 2n ** 128n - 1n;
    // A cap with only the upper 40 bits of the uint128 set
    const UPPER_BITS_ONLY = (2n ** 40n - 1n) << 88n;

    let AssetListContractFactory: AssetList__factory;
    let priceFeed: SimplePriceFeed;
    let FaucetTokenFactory: FaucetToken__factory;

    let snapshot: SnapshotRestorer;

    before(async () => {
      AssetListContractFactory = await ethers.getContractFactory('AssetList') as AssetList__factory;
      priceFeed = await (await ethers.getContractFactory('SimplePriceFeed') as SimplePriceFeed__factory).deploy(exp(1, 8), 8);
      FaucetTokenFactory = await ethers.getContractFactory('FaucetToken') as FaucetToken__factory;

      snapshot = await takeSnapshot();
    });

    // Checks every field of the asset info against the config it was created from.
    // The cap shares storage with the other fields, so all of them must come back intact, not only the cap.
    function validateGetAssetInfo(assetInfo: AssetInfoStructOutput, index: number, assetConfig: AssetConfigStruct) {
      expect(assetInfo.offset).to.equal(index);
      expect(assetInfo.asset).to.equal(assetConfig.asset);
      expect(assetInfo.priceFeed).to.equal(assetConfig.priceFeed);
      expect(assetInfo.scale).to.equal(10n ** BigInt(assetConfig.decimals.toString()));
      expect(assetInfo.borrowCollateralFactor).to.equal(assetConfig.borrowCollateralFactor);
      expect(assetInfo.liquidateCollateralFactor).to.equal(assetConfig.liquidateCollateralFactor);
      expect(assetInfo.liquidationFactor).to.equal(assetConfig.liquidationFactor);
      expect(assetInfo.supplyCap).to.equal(assetConfig.supplyCap);
    }

    // The list of token decimals to test
    const tokenDecimals = [6n, 8n, 12n, 18n];
    tokenDecimals.forEach(decimals => describe(`token with ${decimals} decimals`, () => runSupplyCapTests(decimals)));

    function runSupplyCapTests(decimals: bigint) {
      const oneToken = 10n ** decimals;

      // A regular cap every collateral starts with; each flow swaps in its own cap
      const normalSupplyCap = oneToken * 1_000_000n;

      let assetConfigs: AssetConfigStruct[] = [];
      let proxyAdmin: SignerWithAddress;
      let configurator: SignerWithAddress;

      // Deploys one token per collateral, all with the same decimals and the normal supply cap
      before(async () => {
        [, proxyAdmin, configurator] = await ethers.getSigners();
        for (let i = 0; i < MAX_ASSETS; i++) {
          const token = await FaucetTokenFactory.deploy(1n, `Test Token ${i}`, decimals, `TEST${i}`);
          assetConfigs.push({
            asset: token.address,
            priceFeed: priceFeed.address,
            decimals,
            borrowCollateralFactor: exp(0.75, 18),
            liquidateCollateralFactor: exp(0.8, 18),
            liquidationFactor: exp(0.9, 18),
            supplyCap: normalSupplyCap,
          });
        }
      });

      // Deploys an asset list implementation for the collaterals and a proxy on top of it, initialized with the given calldata
      async function deployAssetListProxy(configs: AssetConfigStruct[], initData: string): Promise<AssetList> {
        const implementation = await AssetListContractFactory.deploy(configs);
        const proxy = await (await ethers.getContractFactory('TransparentUpgradeableProxy') as TransparentUpgradeableProxy__factory).deploy(
          implementation.address,
          proxyAdmin.address,
          initData,
        );
        return AssetListContractFactory.attach(proxy.address);
      }

      // Creates an asset list where every collateral has the given cap, then checks each collateral reads back as configured
      function runHappyCaseTests(supplyCap: bigint) {
        let assetList: AssetList;

        it('creates the asset list', async () => {
          const configs = assetConfigs.map(assetConfig => ({ ...assetConfig, supplyCap }));
          assetList = await deployAssetListProxy(configs, AssetListContractFactory.interface.encodeFunctionData('initialize', [configs, configurator.address]));
        });

        it(`holds ${MAX_ASSETS} collaterals`, async () => {
          expect(await assetList.numAssets()).to.equal(MAX_ASSETS);
        });

        it('returns the configured asset info for every collateral', async () => {
          for (let i = 0; i < MAX_ASSETS; i++) {
            validateGetAssetInfo(await assetList.getAssetInfo(i), i, { ...assetConfigs[i], supplyCap });
          }
        });
      }

      after(async () => await snapshot.restore());

      context('1 wei supply cap', function () {
        const supplyCap = 1n;
        runHappyCaseTests(supplyCap);
      });

      context('cap one wei below a whole token unit', function () {
        const supplyCap = oneToken - 1n;
        runHappyCaseTests(supplyCap);
      });

      context('0.5 token cap', function () {
        const supplyCap = oneToken / 2n;
        runHappyCaseTests(supplyCap);
      });

      context('10.5 token cap', function () {
        const supplyCap = oneToken * 21n / 2n;
        runHappyCaseTests(supplyCap);
      });

      context('cap with only the upper stored bits set', function () {
        const supplyCap = UPPER_BITS_ONLY;
        runHappyCaseTests(supplyCap);
      });

      context('uint128 max cap', function () {
        const supplyCap = MAX_UINT128;
        runHappyCaseTests(supplyCap);
      });

      context('zero cap', function () {
        const supplyCap = 0n;
        runHappyCaseTests(supplyCap);
      });

      // A cap above uint128 max, set on one collateral at a time, must make the list's ABI decoder revert with no reason.
      // ethers won't encode it as uint128, so initialize is sent raw with the cap encoded as uint256 (same 32-byte layout).
      Array.from({ length: MAX_ASSETS }).forEach((_, i) => {
        context(`uint128 max + 1 cap on collateral ${i}`, function () {
          before(() => {
            assetConfigs[i].supplyCap = MAX_UINT128 + 1n;
          });

          after(() => {
            assetConfigs[i].supplyCap = normalSupplyCap;
          });

          it('reverts on initialize', async () => {
            const assetList = await deployAssetListProxy(assetConfigs, '0x');
            const data = AssetListContractFactory.interface.getSighash('initialize') + ethers.utils.defaultAbiCoder.encode(
              ['tuple(uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint256 supplyCap)[]', 'address'],
              [assetConfigs, configurator.address]
            ).slice(2);
            const [signer] = await ethers.getSigners();

            await expect(signer.sendTransaction({ to: assetList.address, data, gasLimit: 30_000_000 })).to.be.revertedWithoutReason();
          });
        });
      });
    }
  });
});
