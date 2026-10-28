import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { exp } from '../test/helpers';
import { expectRevertCustom, perSecond, servicePatch2 } from './utils';
import { BigNumber, BigNumberish, ethers } from 'ethers';
import { FaucetToken } from '../build/types';
import { getConfigForScenario } from './utils/scenarioHelper';
import { getToken } from './assetList/shared';

const MIN_OFFSET_FOR_RESERVED = 16; // _reserved covers offsets 16–23
const REQUIRED_NUM_ASSETS = MIN_OFFSET_FOR_RESERVED + 1; // index 16 has offset 16

scenario(
  'Comet#numAssets > market has at least one collateral asset',
  {},
  async ({ comet }) => {
    expect(await comet.numAssets()).to.be.greaterThan(0);
  },
);

scenario(
  'Comet#governor > points to timelock',
  {},
  async ({ comet, timelock }) => {
    expect(await comet.governor()).to.equal(timelock.address);
  },
);

scenario(
  'Comet#governor > is not the same address as pause guardian',
  {},
  async ({ comet }) => {
    expect(await comet.governor()).to.not.equal(await comet.pauseGuardian());
  },
);

scenario('Comet#governor > is not zero address', {}, async ({ comet }) => {
  expect(await comet.governor()).to.not.equal(ethers.constants.AddressZero);
});

scenario(
  'Comet#initializeStorage > reverts if already initialized',
  {},
  async ({ comet }) => {
    await expectRevertCustom(comet.initializeStorage(), 'AlreadyInitialized()');
  },
);

scenario(
  'Comet#configuration > matches configurator parameters',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator }, context) => {
    const cfg = await configurator.getConfiguration(comet.address);

    expect(await comet.governor()).to.equal(cfg.governor);
    expect(await comet.pauseGuardian()).to.equal(cfg.pauseGuardian);
    expect(await comet.baseToken()).to.equal(cfg.baseToken);
    expect(await comet.baseTokenPriceFeed()).to.equal(cfg.baseTokenPriceFeed);
    expect(await comet.extensionDelegate()).to.equal(cfg.extensionDelegate);

    expect(await comet.supplyKink()).to.equal(cfg.supplyKink);
    expect(await comet.supplyPerSecondInterestRateSlopeLow()).to.equal(
      perSecond(cfg.supplyPerYearInterestRateSlopeLow),
    );
    expect(await comet.supplyPerSecondInterestRateSlopeHigh()).to.equal(
      perSecond(cfg.supplyPerYearInterestRateSlopeHigh),
    );
    expect(await comet.supplyPerSecondInterestRateBase()).to.equal(
      perSecond(cfg.supplyPerYearInterestRateBase),
    );
    expect(await comet.borrowKink()).to.equal(cfg.borrowKink);
    expect(await comet.borrowPerSecondInterestRateSlopeLow()).to.equal(
      perSecond(cfg.borrowPerYearInterestRateSlopeLow),
    );
    expect(await comet.borrowPerSecondInterestRateSlopeHigh()).to.equal(
      perSecond(cfg.borrowPerYearInterestRateSlopeHigh),
    );
    expect(await comet.borrowPerSecondInterestRateBase()).to.equal(
      perSecond(cfg.borrowPerYearInterestRateBase),
    );

    expect(await comet.storeFrontPriceFactor()).to.equal(cfg.storeFrontPriceFactor);
    expect(await comet.trackingIndexScale()).to.equal(cfg.trackingIndexScale);
    expect(await comet.baseTrackingSupplySpeed()).to.equal(cfg.baseTrackingSupplySpeed);
    expect(await comet.baseTrackingBorrowSpeed()).to.equal(cfg.baseTrackingBorrowSpeed);
    expect(await comet.baseMinForRewards()).to.equal(cfg.baseMinForRewards);
    expect(await comet.baseBorrowMin()).to.equal(cfg.baseBorrowMin);
    expect(await comet.targetReserves()).to.equal(cfg.targetReserves);

    // The asset configs are no longer part of the configuration, the Configurator returns them on their own
    const assetConfigs = await configurator.getAssetConfigs(comet.address);
    const numAssets = await comet.numAssets();
    expect(numAssets).to.equal(assetConfigs.length);

    for (let i = 0; i < numAssets; i++) {
      const info = await comet.getAssetInfo(i);
      const expected = assetConfigs[i];
      expect(info.asset).to.equal(expected.asset);
      expect(info.priceFeed).to.equal(expected.priceFeed);
      // The scale comes from the token's own decimals, which the asset list reads at construction
      expect(info.scale).to.equal(BigNumber.from(10).pow(await (await getToken(context, expected.asset)).decimals()));
      expect(info.borrowCollateralFactor).to.equal(expected.borrowCollateralFactor);
      expect(info.liquidateCollateralFactor).to.equal(expected.liquidateCollateralFactor);
      expect(info.liquidationFactor).to.equal(expected.liquidationFactor);
      expect(info.supplyCap).to.equal(expected.supplyCap);
    }
  },
);

scenario(
  'Comet#getAssetInfoByAddress > reverts if asset does not exist',
  {},
  async ({ comet }) => {
    await expect(
      comet.getAssetInfoByAddress(ethers.Wallet.createRandom().address),
    ).to.be.revertedWithCustomError(comet, 'BadAsset');
  },
);

scenario(
  'Comet#assetsIn > correctly sets and clears _reserved bits for assets with offset >= 16',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, proxyAdmin, actors }, context) => {
    const { albert, admin } = actors;
    const numAssets = await comet.numAssets();

    let targetAssetAddress: string;
    let supplyAmount: bigint;

    if (numAssets < REQUIRED_NUM_ASSETS) {
      const dm = context.world.deploymentManager;

      // Every slot up to index 16 gets its own token, since the Configurator rejects an asset added twice.
      // The last one, at index 16, is the asset the scenario supplies
      const addedAssets: string[] = [];
      let mockToken: FaucetToken;
      for (let i = numAssets; i < REQUIRED_NUM_ASSETS; i++) {
        mockToken = await dm.deploy<FaucetToken, [string, string, BigNumberish, string]>(
          `faucetToken:extendedAssetTarget${i}`,
          'test/FaucetToken.sol',
          [exp(1_000_000, 18).toString(), 'Mock Extended Token', 18, 'MEXT'],
          true,
        );
        const mockPriceFeed = await dm.deploy(
          `test:extendedAssetTargetPriceFeed${i}`,
          'test/SimplePriceFeed.sol',
          [1 * 10 ** 8, 8],
          true,
        );

        await context.setNextBaseFeeToZero();
        await configurator.connect(admin.signer).addAsset(
          comet.address,
          {
            asset: mockToken.address,
            priceFeed: mockPriceFeed.address,
            borrowCollateralFactor: exp(0.8, 18),
            liquidateCollateralFactor: exp(0.85, 18),
            liquidationFactor: exp(0.9, 18),
            supplyCap: exp(1e6, 18),
          },
          { gasPrice: 0 },
        );
        addedAssets.push(mockToken.address);
      }

      // The new assets reach the Comet through a new asset list, which registers them with their factors and caps,
      // and then a redeploy of the Comet
      await context.setNextBaseFeeToZero();
      await proxyAdmin.connect(admin.signer).deployAndUpgradeAssetListTo(configurator.address, comet.address, { gasPrice: 0 });
      for (const addedAsset of addedAssets) {
        await context.setNextBaseFeeToZero();
        await configurator.connect(admin.signer).setAssetConfigToAssetList(comet.address, addedAsset, { gasPrice: 0 });
      }

      targetAssetAddress = mockToken.address;
      supplyAmount =
        BigInt(getConfigForScenario(context).supplyCollateral) * 10n ** 18n;
      await mockToken.allocateTo(albert.address, supplyAmount);

      await context.setNextBaseFeeToZero();
      await admin.deployAndUpgradeTo(configurator.address, comet.address, {
        gasPrice: 0,
      });
      await context.setAssets();
    } else {
      const existing = await comet.getAssetInfo(MIN_OFFSET_FOR_RESERVED);
      targetAssetAddress = existing.asset;
      supplyAmount =
        BigInt(getConfigForScenario(context).supplyCollateral) *
        existing.scale.toBigInt();
      await context.sourceTokens(
        supplyAmount,
        targetAssetAddress,
        albert.address,
      );
    }

    const assetInfo = await comet.getAssetInfo(MIN_OFFSET_FOR_RESERVED);
    expect(assetInfo.asset).to.equal(targetAssetAddress);
    expect(assetInfo.offset).to.be.gte(MIN_OFFSET_FOR_RESERVED);

    const basicBefore = await comet.userBasic(albert.address);
    expect(basicBefore._reserved).to.equal(0);

    const targetAsset = context.getAssetByAddress(assetInfo.asset);
    await targetAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({
      asset: assetInfo.asset,
      amount: supplyAmount,
    });

    const expectedReserved =
      1n << BigInt(assetInfo.offset - MIN_OFFSET_FOR_RESERVED);
    const basicAfterSupply = await comet.userBasic(albert.address);
    expect(basicAfterSupply._reserved).to.equal(expectedReserved);
    expect(basicAfterSupply.assetsIn).to.equal(basicBefore.assetsIn);

    await albert.withdrawAsset({
      asset: assetInfo.asset,
      amount: supplyAmount,
    });

    const basicAfterWithdraw = await comet.userBasic(albert.address);
    expect(basicAfterWithdraw._reserved).to.equal(0);
    expect(basicAfterWithdraw.assetsIn).to.equal(basicBefore.assetsIn);
    expect(
      await comet.collateralBalanceOf(albert.address, assetInfo.asset),
    ).to.equal(0);
  },
);
