import { AssetList, AssetList__factory, AssetListFactory, AssetListFactory__factory, FaucetToken, FaucetToken__factory, SimplePriceFeed, SimplePriceFeed__factory } from 'build/types';
import { expect, exp, makeConfigurator, makeProtocol, ethers } from './helpers';
import { AssetInfoStructOutput } from 'build/types/AssetList';

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
    const { assetConfigs } = await configuratorAsProxy.getConfiguration(comet.address);
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
    let assetListFactory: AssetListFactory;
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

    before(async () => {
      assetListFactory = await (await ethers.getContractFactory('AssetListFactory') as AssetListFactory__factory).deploy();

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

      assetList = await (await ethers.getContractFactory('AssetList') as AssetList__factory).deploy([baseAssetConfig]);
    });

    // normal active collateral
    context('active collateral: BCF > 0, LCF > BCF, LF > LCF', function () {
      let assetInfo: AssetInfoStructOutput;

      before(async () => {
        const assetList = await (await ethers.getContractFactory('AssetList') as AssetList__factory).deploy([{
          ...baseAssetConfig,
          borrowCollateralFactor: collateralBCF,
          liquidateCollateralFactor: collateralLCF,
          liquidationFactor: collateralLF,
        }]);
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
        const assetList = await (await ethers.getContractFactory('AssetList') as AssetList__factory).deploy([{
          ...baseAssetConfig,
          borrowCollateralFactor: 0n,
          liquidateCollateralFactor: collateralLCF,
          liquidationFactor: collateralLF,
        }]);
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
        const assetList = await (await ethers.getContractFactory('AssetList') as AssetList__factory).deploy([{
          ...baseAssetConfig,
          borrowCollateralFactor: 0n,
          liquidateCollateralFactor: 0n,
          liquidationFactor: collateralLF,
        }]);
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
        const assetList = await (await ethers.getContractFactory('AssetList') as AssetList__factory).deploy([{
          ...baseAssetConfig,
          borrowCollateralFactor: 0n,
          liquidateCollateralFactor: 0n,
          liquidationFactor: 0n,
        }]);
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
        const assetList = await (await ethers.getContractFactory('AssetList') as AssetList__factory).deploy([{
          ...baseAssetConfig,
          liquidationFactor: exp(1, 18),
        }]);
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
          assetListFactory.createAssetList([{ ...baseAssetConfig, borrowCollateralFactor: collateralLCF, liquidateCollateralFactor: collateralLCF }])
        ).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      });

      it('BCF exceeds LCF', async () => {
        await expect(
          assetListFactory.createAssetList([{ ...baseAssetConfig, borrowCollateralFactor: collateralLF, liquidateCollateralFactor: collateralLCF }])
        ).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      });

      it('BCF is non-zero but LCF is zero', async () => {
        await expect(
          assetListFactory.createAssetList([{ ...baseAssetConfig, liquidateCollateralFactor: 0n }])
        ).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
      });

      // liquidate collateral factor too large

      it('LCF equals LF when both are non-zero', async () => {
        await expect(
          assetListFactory.createAssetList([{ ...baseAssetConfig, borrowCollateralFactor: 0n, liquidateCollateralFactor: collateralLF, liquidationFactor: collateralLF }])
        ).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      });

      it('LCF exceeds LF', async () => {
        await expect(
          assetListFactory.createAssetList([{ ...baseAssetConfig, borrowCollateralFactor: 0n, liquidateCollateralFactor: collateralLF, liquidationFactor: collateralLCF }])
        ).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      });

      it('LCF is non-zero but LF is zero', async () => {
        // LCF > 0 means LCF >= LF=0 is always true → LiquidateCFTooLarge
        await expect(
          assetListFactory.createAssetList([{ ...baseAssetConfig, borrowCollateralFactor: 0n, liquidationFactor: 0n }])
        ).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
      });

      // liquidation penalty too high

      it('LF exceeds MAX_COLLATERAL_FACTOR', async () => {
        await expect(
          assetListFactory.createAssetList([{ ...baseAssetConfig, liquidationFactor: exp(1, 18) + 1n }])
        ).to.be.revertedWithCustomError(assetList, 'LiqPenaltyTooHigh');
      });
    });

    /*//////////////////////////////////////////////////////////////
                            DESCALED FACTORS
    //////////////////////////////////////////////////////////////*/

    context('descaled factors', function () {
      // Factors are stored with four decimal digits of precision: dividing by 1e14 keeps only
      // the first four digits, so 0.1234 is exactly one stored unit and 0.1235 is the next one up.
      const descaledFactor = 123400000000000000n;
      const nextDescaledFactor = 123500000000000000n;
      // A value above 0.1234 that still loses its extra digits and becomes 1234 once stored.
      const sameDescaledFactor = 123456000000000000n;

      context('LCF > BCF after descale', function () {
        let assetInfo: AssetInfoStructOutput;

        before(async () => {
          const assetList = await (await ethers.getContractFactory('AssetList') as AssetList__factory).deploy([{
            ...baseAssetConfig,
            borrowCollateralFactor: descaledFactor,
            liquidateCollateralFactor: nextDescaledFactor,
          }]);
          assetInfo = await assetList.getAssetInfo(0);
        });

        it('stores borrowCollateralFactor', () => {
          expect(assetInfo.borrowCollateralFactor).to.equal(descaledFactor);
        });

        it('stores liquidateCollateralFactor one precision unit above borrowCollateralFactor', () => {
          expect(assetInfo.liquidateCollateralFactor).to.equal(nextDescaledFactor);
        });
      });

      context('LF > LCF after descale', function () {
        let assetInfo: AssetInfoStructOutput;

        before(async () => {
          const assetList = await (await ethers.getContractFactory('AssetList') as AssetList__factory).deploy([{
            ...baseAssetConfig,
            borrowCollateralFactor: 0n,
            liquidateCollateralFactor: descaledFactor,
            liquidationFactor: nextDescaledFactor,
          }]);
          assetInfo = await assetList.getAssetInfo(0);
        });

        it('stores liquidateCollateralFactor', () => {
          expect(assetInfo.liquidateCollateralFactor).to.equal(descaledFactor);
        });

        it('stores liquidationFactor one precision unit above liquidateCollateralFactor', () => {
          expect(assetInfo.liquidationFactor).to.equal(nextDescaledFactor);
        });
      });

      context('descale revert when', function () {
        // Each case passes the check on the original factors, because the upper factor is larger,
        // but both factors become the same number once stored, so the stored ordering check rejects it.

        it('LCF is above BCF only in digits that descale drops', async () => {
          await expect(
            assetListFactory.createAssetList([{ ...baseAssetConfig, borrowCollateralFactor: descaledFactor, liquidateCollateralFactor: sameDescaledFactor }])
          ).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        });

        it('LCF is one wei above BCF', async () => {
          await expect(
            assetListFactory.createAssetList([{ ...baseAssetConfig, borrowCollateralFactor: descaledFactor, liquidateCollateralFactor: descaledFactor + 1n }])
          ).to.be.revertedWithCustomError(assetList, 'BorrowCFTooLarge');
        });

        it('LF is above LCF only in digits that descale drops', async () => {
          await expect(
            assetListFactory.createAssetList([{ ...baseAssetConfig, borrowCollateralFactor: 0n, liquidateCollateralFactor: descaledFactor, liquidationFactor: sameDescaledFactor }])
          ).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
        });

        it('LF is one wei above LCF', async () => {
          await expect(
            assetListFactory.createAssetList([{ ...baseAssetConfig, borrowCollateralFactor: 0n, liquidateCollateralFactor: descaledFactor, liquidationFactor: descaledFactor + 1n }])
          ).to.be.revertedWithCustomError(assetList, 'LiquidateCFTooLarge');
        });
      });
    });
  });
});
