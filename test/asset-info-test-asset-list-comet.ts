import { AssetList, AssetList__factory, AssetListFactory, AssetListFactory__factory, FaucetToken, FaucetToken__factory, SimplePriceFeed, SimplePriceFeed__factory } from 'build/types';
import { expect, exp, makeConfigurator, ONE, makeProtocol, ethers, takeSnapshot, SnapshotRestorer } from './helpers';
import { AssetInfoStructOutput } from 'build/types/AssetList';

describe('asset info', function () {
  it('initializes protocol', async () => {
    const { cometWithExtendedAssetList: comet, tokens } = await makeConfigurator({
      assets: {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
      },
      reward: 'ASSET1',
    });

    const cometNumAssets = await comet.numAssets();
    expect(cometNumAssets).to.be.equal(3);

    const assetInfo00 = await comet.getAssetInfo(0);
    expect(assetInfo00.asset).to.be.equal(tokens['ASSET1'].address);
    expect(assetInfo00.borrowCollateralFactor).to.equal(ONE - exp(1, 14));
    expect(assetInfo00.liquidateCollateralFactor).to.equal(ONE);

    const assetInfo01 = await comet.getAssetInfo(1);
    expect(assetInfo01.asset).to.be.equal(tokens['ASSET2'].address);
    expect(assetInfo01.borrowCollateralFactor).to.equal(ONE - exp(1, 14));
    expect(assetInfo01.liquidateCollateralFactor).to.equal(ONE);

    const assetInfo02 = await comet.getAssetInfo(2);
    expect(assetInfo02.asset).to.be.equal(tokens['ASSET3'].address);
    expect(assetInfo02.borrowCollateralFactor).to.equal(ONE - exp(1, 14));
    expect(assetInfo02.liquidateCollateralFactor).to.equal(ONE);
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

  describe('factors validation', function () {
    // FACTOR_SCALE / 1e4 — the precision unit factors are truncated to when packed into AssetList storage
    const DESCALE = exp(1, 14);

    let assetList: AssetList;
    let assetListFactory: AssetListFactory;
    let faucetToken: FaucetToken;
    let priceFeed: SimplePriceFeed;

    // Base valid config; each test spreads this and overrides only the field(s) under test.
    let collateralAssetConfig: {
      asset: string;
      priceFeed: string;
      decimals: number;
      borrowCollateralFactor: bigint;
      liquidateCollateralFactor: bigint;
      liquidationFactor: bigint;
      supplyCap: bigint;
    };

    before(async () => {
      assetListFactory = await (await ethers.getContractFactory('AssetListFactory') as AssetListFactory__factory).deploy();
      await assetListFactory.deployed();

      faucetToken = await (await ethers.getContractFactory('FaucetToken') as FaucetToken__factory).deploy(10n ** 24n, 'Test Token', 18, 'TEST');
      await faucetToken.deployed();

      priceFeed = await (await ethers.getContractFactory('SimplePriceFeed') as SimplePriceFeed__factory).deploy(exp(1, 8), 8);
      await priceFeed.deployed();

      collateralAssetConfig = {
        asset: faucetToken.address,
        priceFeed: priceFeed.address,
        decimals: 18,
        borrowCollateralFactor: exp(0.75, 18),
        liquidateCollateralFactor: exp(0.8, 18),
        liquidationFactor: exp(0.9, 18),
        supplyCap: 10n ** 24n,
      };

      assetList = await (await ethers.getContractFactory('AssetList') as AssetList__factory).deploy([collateralAssetConfig]);
      await assetList.deployed();
    });

    describe('happy cases', function () {
      it('borrowCF > 0, liquidateCF > 0 and borrowCF < liquidateCF', async () => {
        await expect(assetListFactory.createAssetList([{ ...collateralAssetConfig }])).to.not.be.reverted;
      });

      it('borrowCF = 0, liquidateCF = 0', async () => {
        await expect(assetListFactory.createAssetList([{ ...collateralAssetConfig, borrowCollateralFactor: 0n, liquidateCollateralFactor: 0n }])).to.not.be.reverted;
      });

      it('borrowCF > liquidationFactor and borrowCF < liquidateCF', async () => {
        await expect(assetListFactory.createAssetList([{
          ...collateralAssetConfig,
          borrowCollateralFactor: exp(0.95, 18),
          liquidateCollateralFactor: exp(0.98, 18),
          liquidationFactor: exp(0.9, 18),
        }])).to.not.be.reverted;
      });

      it('borrowCF < liquidateCF and liquidateCF > liquidationFactor', async () => {
        await expect(assetListFactory.createAssetList([{
          ...collateralAssetConfig,
          borrowCollateralFactor: exp(0.7, 18),
          liquidateCollateralFactor: exp(0.95, 18),
          liquidationFactor: exp(0.9, 18),
        }])).to.not.be.reverted;
      });

      it('borrowCF < liquidateCF < liquidationFactor', async () => {
        await expect(assetListFactory.createAssetList([{
          ...collateralAssetConfig,
          borrowCollateralFactor: exp(0.7, 18),
          liquidateCollateralFactor: exp(0.8, 18),
          liquidationFactor: exp(0.95, 18),
        }])).to.not.be.reverted;
      });

      it('borrowCF = 0 and liquidateCF > 0', async () => {
        await expect(assetListFactory.createAssetList([{ ...collateralAssetConfig, borrowCollateralFactor: 0n }])).to.not.be.reverted;
      });

      it('borrowCF = 0, liquidationFactor = 0, liquidateCF > 0', async () => {
        await expect(assetListFactory.createAssetList([{ ...collateralAssetConfig, borrowCollateralFactor: 0n, liquidationFactor: 0n }])).to.not.be.reverted;
      });

      it('liquidateCF < MAX_COLLATERAL_FACTOR', async () => {
        await expect(assetListFactory.createAssetList([{ ...collateralAssetConfig, liquidateCollateralFactor: ONE - DESCALE }])).to.not.be.reverted;
      });

      it('liquidateCF = MAX_COLLATERAL_FACTOR', async () => {
        await expect(assetListFactory.createAssetList([{ ...collateralAssetConfig, liquidateCollateralFactor: ONE }])).to.not.be.reverted;
      });

      it('liquidationFactor < MAX_COLLATERAL_FACTOR', async () => {
        await expect(assetListFactory.createAssetList([{ ...collateralAssetConfig, liquidationFactor: ONE - DESCALE }])).to.not.be.reverted;
      });

      it('liquidationFactor = MAX_COLLATERAL_FACTOR', async () => {
        await expect(assetListFactory.createAssetList([{ ...collateralAssetConfig, liquidationFactor: ONE }])).to.not.be.reverted;
      });
    });

    describe('revert when', function () {
      it('borrowCF > 0, liquidateCF = 0', async () => {
        await expect(assetListFactory.createAssetList([{ ...collateralAssetConfig, liquidateCollateralFactor: 0n }]))
          .to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      });

      it('borrowCF > 0, liquidateCF > 0 and borrowCF > liquidateCF', async () => {
        await expect(assetListFactory.createAssetList([{ ...collateralAssetConfig, borrowCollateralFactor: exp(0.9, 18), liquidateCollateralFactor: exp(0.8, 18) }]))
          .to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      });

      it('borrowCF > 0, liquidateCF > 0 and borrowCF = liquidateCF', async () => {
        await expect(assetListFactory.createAssetList([{ ...collateralAssetConfig, borrowCollateralFactor: exp(0.8, 18), liquidateCollateralFactor: exp(0.8, 18) }]))
          .to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      });

      it('liquidateCF > MAX_COLLATERAL_FACTOR', async () => {
        await expect(assetListFactory.createAssetList([{ ...collateralAssetConfig, borrowCollateralFactor: 0n, liquidateCollateralFactor: ONE + 1n }]))
          .to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      });

      it('liquidationFactor > MAX_COLLATERAL_FACTOR', async () => {
        await expect(assetListFactory.createAssetList([{ ...collateralAssetConfig, liquidationFactor: ONE + 1n }]))
          .to.be.revertedWithCustomError(assetList, 'LiqPenaltyTooHigh');
      });
    });

    /*
     * When every factor is a positive integer smaller than DESCALE (1e14), truncation zeroes them
     * all out after packing. The post-descale BorrowCFTooLarge guard is conditioned on
     * packedBorrowCF != 0, so it short-circuits. Only the raw pre-descale checks apply.
     * State is verified by attaching to the address returned via callStatic.
     */
    describe('all factors > 0 and below DESCALE — pack to zero', function () {
      describe('happy cases', function () {
        describe('minimum valid values: borrowCF = 1, liquidateCF = 2, liquidationFactor = 1', function () {
          let assetInfo: AssetInfoStructOutput;

          before(async () => {
            const config = [{ ...collateralAssetConfig, borrowCollateralFactor: 1n, liquidateCollateralFactor: 2n, liquidationFactor: 1n }];
            const address = await assetListFactory.callStatic.createAssetList(config);
            await assetListFactory.createAssetList(config);
            const deployedAssetList = await ethers.getContractAt('AssetList', address);
            assetInfo = await deployedAssetList.getAssetInfo(0);
          });

          it('borrowCollateralFactor packs to zero', async () => {
            expect(assetInfo.borrowCollateralFactor).to.equal(0n);
          });

          it('liquidateCollateralFactor packs to zero', async () => {
            expect(assetInfo.liquidateCollateralFactor).to.equal(0n);
          });

          it('liquidationFactor packs to zero', async () => {
            expect(assetInfo.liquidationFactor).to.equal(0n);
          });
        });

        describe('maximum sub-DESCALE values: borrowCF = 1, liquidateCF and liquidationFactor at DESCALE - 1', function () {
          let assetInfo: AssetInfoStructOutput;

          before(async () => {
            const config = [{ ...collateralAssetConfig, borrowCollateralFactor: 1n, liquidateCollateralFactor: DESCALE - 1n, liquidationFactor: DESCALE - 1n }];
            const address = await assetListFactory.callStatic.createAssetList(config);
            await assetListFactory.createAssetList(config);
            const deployedAssetList = await ethers.getContractAt('AssetList', address);
            assetInfo = await deployedAssetList.getAssetInfo(0);
          });

          it('borrowCollateralFactor packs to zero', async () => {
            expect(assetInfo.borrowCollateralFactor).to.equal(0n);
          });

          it('liquidateCollateralFactor packs to zero', async () => {
            expect(assetInfo.liquidateCollateralFactor).to.equal(0n);
          });

          it('liquidationFactor packs to zero', async () => {
            expect(assetInfo.liquidationFactor).to.equal(0n);
          });
        });

        describe('borrowCF just below liquidateCF: both at adjacent sub-DESCALE positions', function () {
          let assetInfo: AssetInfoStructOutput;

          before(async () => {
            const config = [{ ...collateralAssetConfig, borrowCollateralFactor: DESCALE - 2n, liquidateCollateralFactor: DESCALE - 1n, liquidationFactor: 1n }];
            const address = await assetListFactory.callStatic.createAssetList(config);
            await assetListFactory.createAssetList(config);
            const deployedAssetList = await ethers.getContractAt('AssetList', address);
            assetInfo = await deployedAssetList.getAssetInfo(0);
          });

          it('borrowCollateralFactor packs to zero', async () => {
            expect(assetInfo.borrowCollateralFactor).to.equal(0n);
          });

          it('liquidateCollateralFactor packs to zero', async () => {
            expect(assetInfo.liquidateCollateralFactor).to.equal(0n);
          });

          it('liquidationFactor packs to zero', async () => {
            expect(assetInfo.liquidationFactor).to.equal(0n);
          });
        });
      });

      describe('revert when', function () {
        it('borrowCF > liquidateCF: pre-descale ordering check fires even though both pack to zero', async () => {
          await expect(assetListFactory.createAssetList([{
            ...collateralAssetConfig,
            borrowCollateralFactor: 2n,
            liquidateCollateralFactor: 1n,
            liquidationFactor: 1n,
          }])).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        });

        it('borrowCF = liquidateCF: pre-descale equality check fires even though both pack to zero', async () => {
          await expect(assetListFactory.createAssetList([{
            ...collateralAssetConfig,
            borrowCollateralFactor: 1n,
            liquidateCollateralFactor: 1n,
            liquidationFactor: 1n,
          }])).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        });
      });
    });

    /*
     * Factors are truncated to 4-decimal precision (DESCALE = 1e14) when packed into AssetList
     * storage. A post-descale safety check re-runs the BorrowCFTooLarge guard on packed values,
     * catching cases where original values pass the first check but collapse into the same bin.
     */
    describe('descaled values', function () {
      describe('happy cases', function () {
        it('both factors are exact multiples of DESCALE with a clear gap', async () => {
          // 0.9e18 → 9000 units, 0.91e18 → 9100 units after descale
          await expect(assetListFactory.createAssetList([{
            ...collateralAssetConfig,
            borrowCollateralFactor: exp(0.9, 18),
            liquidateCollateralFactor: exp(0.91, 18),
          }])).to.not.be.reverted;
        });

        it('gap is exactly one DESCALE unit — minimum valid separation', async () => {
          // 9000*DESCALE → 9001*DESCALE: packed values differ by 1 unit
          await expect(assetListFactory.createAssetList([{
            ...collateralAssetConfig,
            borrowCollateralFactor: exp(0.9, 18),
            liquidateCollateralFactor: exp(0.9, 18) + DESCALE,
          }])).to.not.be.reverted;
        });

        it('borrowCF just below a bin boundary, liquidateCF at that boundary', async () => {
          // borrowCF = 9000*DESCALE - 1 → truncates to bin 8999; liquidateCF = 9000*DESCALE → bin 9000
          await expect(assetListFactory.createAssetList([{
            ...collateralAssetConfig,
            borrowCollateralFactor: exp(0.9, 18) - 1n,
            liquidateCollateralFactor: exp(0.9, 18),
          }])).to.not.be.reverted;
        });

        it('borrowCF inside a bin, liquidateCF at the start of the next bin', async () => {
          // borrowCF = 9000*DESCALE + 1 → bin 9000; liquidateCF = 9001*DESCALE → bin 9001
          await expect(assetListFactory.createAssetList([{
            ...collateralAssetConfig,
            borrowCollateralFactor: exp(0.9, 18) + 1n,
            liquidateCollateralFactor: exp(0.9, 18) + DESCALE,
          }])).to.not.be.reverted;
        });

        it('borrowCF = 0 with liquidateCF below DESCALE — descale check is skipped', async () => {
          // Packed borrowCollateralFactor = 0 → the != 0 guard short-circuits the descale check
          await expect(assetListFactory.createAssetList([{
            ...collateralAssetConfig,
            borrowCollateralFactor: 0n,
            liquidateCollateralFactor: 1n,
          }])).to.not.be.reverted;
        });
      });

      describe('revert when', function () {
        it('gap = 1: liquidateCF is in the same bin as borrowCF after truncation', async () => {
          // 9000*DESCALE and 9000*DESCALE + 1 both truncate to 9000 → equal after descale
          await expect(assetListFactory.createAssetList([{
            ...collateralAssetConfig,
            borrowCollateralFactor: exp(0.9, 18),
            liquidateCollateralFactor: exp(0.9, 18) + 1n,
          }])).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        });

        it('gap = DESCALE - 1: maximum same-bin gap — liquidateCF still truncates to the same bin', async () => {
          // 9001*DESCALE - 1 truncates to 9000, same as 9000*DESCALE
          await expect(assetListFactory.createAssetList([{
            ...collateralAssetConfig,
            borrowCollateralFactor: exp(0.9, 18),
            liquidateCollateralFactor: exp(0.9, 18) + DESCALE - 1n,
          }])).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        });

        it('both values are non-zero and inside the same bin', async () => {
          // borrowCF = 9000*DESCALE + 1, liquidateCF = 9001*DESCALE - 1 → both truncate to 9000
          await expect(assetListFactory.createAssetList([{
            ...collateralAssetConfig,
            borrowCollateralFactor: exp(0.9, 18) + 1n,
            liquidateCollateralFactor: exp(0.9, 18) + DESCALE - 1n,
          }])).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        });

        it('same-bin collision at a different factor magnitude', async () => {
          // 7000*DESCALE and 7000*DESCALE + 1 both truncate to 7000 → equal after descale
          await expect(assetListFactory.createAssetList([{
            ...collateralAssetConfig,
            borrowCollateralFactor: exp(0.7, 18),
            liquidateCollateralFactor: exp(0.7, 18) + 1n,
          }])).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        });
      });
    });
  });

  /**
   * The same factor rules, checked through the whole contract chain instead of AssetListFactory alone:
   *  - deployment: makeConfigurator → CometWithExtendedAssetList constructor → AssetListFactory → AssetList
   *  - upgrade: Configurator.updateAsset*() (stores the value without validating it) → CometProxyAdmin.deployAndUpgradeTo
   *    → Configurator.deploy → CometFactoryWithExtendedAssetList → constructor → AssetListFactory → AssetList
   */
  describe('factors validation through the full contract chain', function () {
    const BORROW_CF = exp(0.75, 18);
    const LIQUIDATE_CF = exp(0.8, 18);
    const LIQUIDATION_FACTOR = exp(0.9, 18);
    const asset = (overrides: { borrowCF?: bigint, liquidateCF?: bigint, liquidationFactor?: bigint } = {}) => ({
      USDC: {},
      ASSET1: { borrowCF: BORROW_CF, liquidateCF: LIQUIDATE_CF, liquidationFactor: LIQUIDATION_FACTOR, ...overrides },
    });

    // any deployed market, only for the custom-error ABI
    let errorsAbi: Awaited<ReturnType<typeof makeConfigurator>>['cometWithExtendedAssetList'];

    before(async () => {
      errorsAbi = (await makeConfigurator({ assets: asset() })).cometWithExtendedAssetList;
    });

    describe('at deployment', function () {
      it('reverts with BorrowCFTooLarge when borrowCF >= liquidateCF (both > 0)', async () => {
        await expect(makeConfigurator({ assets: asset({ borrowCF: LIQUIDATE_CF }) }))
          .to.be.revertedWithCustomError(errorsAbi, 'BorrowCFTooLarge');
      });

      it('reverts with BorrowCFTooLarge when borrowCF > 0 and liquidateCF = 0', async () => {
        await expect(makeConfigurator({ assets: asset({ liquidateCF: 0n }) }))
          .to.be.revertedWithCustomError(errorsAbi, 'BorrowCFTooLarge');
      });

      it('reverts with LiquidateCFTooLarge when liquidateCF > MAX_COLLATERAL_FACTOR', async () => {
        await expect(makeConfigurator({ assets: asset({ liquidateCF: ONE + exp(1, 14) }) }))
          .to.be.revertedWithCustomError(errorsAbi, 'LiquidateCFTooLarge');
      });

      it('reverts with LiqPenaltyTooHigh when liquidationFactor > MAX_COLLATERAL_FACTOR', async () => {
        await expect(makeConfigurator({ assets: asset({ liquidationFactor: ONE + exp(1, 14) }) }))
          .to.be.revertedWithCustomError(errorsAbi, 'LiqPenaltyTooHigh');
      });

      it('deploys a soft-delisted asset (borrowCF = 0, liquidateCF > 0)', async () => {
        const { cometWithExtendedAssetList: comet } = await makeConfigurator({ assets: asset({ borrowCF: 0n }) });
        const info = await comet.getAssetInfo(0);
        expect(info.borrowCollateralFactor).to.equal(0);
        expect(info.liquidateCollateralFactor).to.equal(LIQUIDATE_CF);
      });

      it('deploys a fully delisted asset (borrowCF = 0, liquidateCF = 0, liquidationFactor = 0)', async () => {
        const { cometWithExtendedAssetList: comet } = await makeConfigurator({
          assets: asset({ borrowCF: 0n, liquidateCF: 0n, liquidationFactor: 0n }),
        });
        const info = await comet.getAssetInfo(0);
        expect(info.borrowCollateralFactor).to.equal(0);
        expect(info.liquidateCollateralFactor).to.equal(0);
        expect(info.liquidationFactor).to.equal(0);
      });
    });

    describe('at upgrade (configurator update + deployAndUpgradeTo)', function () {
      let protocol: Awaited<ReturnType<typeof makeConfigurator>>;
      let configuratorAsProxy: Awaited<ReturnType<typeof makeConfigurator>>['configurator'];
      let cometProxyAddress: string;
      let assetAddress: string;
      let implementationBefore: string;
      let upgradeFixture: SnapshotRestorer;

      before(async () => {
        protocol = await makeConfigurator({ assets: asset() });
        configuratorAsProxy = protocol.configurator.attach(protocol.configuratorProxy.address);
        cometProxyAddress = protocol.cometProxyWithExtendedAssetList.address;
        assetAddress = protocol.tokens['ASSET1'].address;
        implementationBefore = await protocol.proxyAdmin.getProxyImplementation(cometProxyAddress);
        upgradeFixture = await takeSnapshot();
      });

      const upgrade = () => protocol.proxyAdmin.connect(protocol.governor).deployAndUpgradeTo(protocol.configuratorProxy.address, cometProxyAddress);
      const cometAtProxy = () => protocol.cometWithExtendedAssetList.attach(cometProxyAddress);

      /** The rejected upgrade left the proxy on the old implementation with the old factors. */
      async function expectUnchanged() {
        expect(await protocol.proxyAdmin.getProxyImplementation(cometProxyAddress)).to.equal(implementationBefore);
        const info = await cometAtProxy().getAssetInfoByAddress(assetAddress);
        expect(info.borrowCollateralFactor).to.equal(BORROW_CF);
        expect(info.liquidateCollateralFactor).to.equal(LIQUIDATE_CF);
        expect(info.liquidationFactor).to.equal(LIQUIDATION_FACTOR);
      }

      it('liquidationFactor > MAX: the configurator stores it, the upgrade reverts with LiqPenaltyTooHigh', async () => {
        await upgradeFixture.restore();
        await configuratorAsProxy.connect(protocol.governor).updateAssetLiquidationFactor(cometProxyAddress, assetAddress, ONE + exp(1, 14));

        await expect(upgrade()).to.be.revertedWithCustomError(errorsAbi, 'LiqPenaltyTooHigh');
        await expectUnchanged();
      });

      it('borrowCF >= liquidateCF: the upgrade reverts with BorrowCFTooLarge', async () => {
        await upgradeFixture.restore();
        await configuratorAsProxy.connect(protocol.governor).updateAssetBorrowCollateralFactor(cometProxyAddress, assetAddress, LIQUIDATE_CF);

        await expect(upgrade()).to.be.revertedWithCustomError(errorsAbi, 'BorrowCFTooLarge');
        await expectUnchanged();
      });

      it('liquidateCF = 0 with borrowCF > 0: the upgrade reverts with BorrowCFTooLarge', async () => {
        await upgradeFixture.restore();
        await configuratorAsProxy.connect(protocol.governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, assetAddress, 0n);

        await expect(upgrade()).to.be.revertedWithCustomError(errorsAbi, 'BorrowCFTooLarge');
        await expectUnchanged();
      });

      it('liquidateCF > MAX: the upgrade reverts with LiquidateCFTooLarge', async () => {
        await upgradeFixture.restore();
        await configuratorAsProxy.connect(protocol.governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, assetAddress, ONE + exp(1, 14));

        await expect(upgrade()).to.be.revertedWithCustomError(errorsAbi, 'LiquidateCFTooLarge');
        await expectUnchanged();
      });

      it('soft delist (borrowCF = 0): the upgrade succeeds and the proxy reads the new factors', async () => {
        await upgradeFixture.restore();
        await configuratorAsProxy.connect(protocol.governor).updateAssetBorrowCollateralFactor(cometProxyAddress, assetAddress, 0n);

        await expect(upgrade()).to.not.be.reverted;
        expect(await protocol.proxyAdmin.getProxyImplementation(cometProxyAddress)).to.not.equal(implementationBefore);
        const info = await cometAtProxy().getAssetInfoByAddress(assetAddress);
        expect(info.borrowCollateralFactor).to.equal(0);
        expect(info.liquidateCollateralFactor).to.equal(LIQUIDATE_CF);
        expect(info.liquidationFactor).to.equal(LIQUIDATION_FACTOR);
      });
    });
  });
});
