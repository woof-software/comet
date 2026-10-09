import { scenario } from './context/CometContext.js';
import { expect } from 'chai';
import { exp } from '../test/helpers.js';
import { expectRevertCustom, perSecond } from './utils/index.js';
import { Wallet, ZeroAddress } from 'ethers';
import { FaucetToken__factory } from '../build/types/index.js';
import { getConfigForScenario } from './utils/scenarioHelper.js';

scenario('has assets', {}, async ({ comet, assets }) => {
  const numAssets = await comet.numAssets();
  // numAssets is a uint8, so converting it to an array length is safe.
  const collateralAssets = await Promise.all(Array.from({ length: Number(numAssets) }, (_, i) => comet.getAssetInfo(i)));
  const contextAssets = Object.values(assets);
  expect(contextAssets.map(a => a.address)).to.include.members(collateralAssets.map(a => a.asset));
});

const MIN_OFFSET_FOR_RESERVED = 16; // _reserved covers offsets 16–23
const REQUIRED_NUM_ASSETS = MIN_OFFSET_FOR_RESERVED + 1; // index 16 has offset 16

scenario(
  'Comet#numAssets > market has at least one collateral asset',
  {},
  async ({ comet }) => {
    expect(await comet.numAssets()).to.be.greaterThan(0n);
  },
);

scenario(
  'Comet#governor > points to timelock',
  {},
  async ({ comet, timelock }) => {
    expect(await comet.governor()).to.equal(await timelock.getAddress());
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
  expect(await comet.governor()).to.not.equal(ZeroAddress);
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
  {},
  async ({ comet, configurator }) => {
    const cfg = await configurator.getConfiguration(await comet.getAddress());

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

    const numAssets = await comet.numAssets();
    expect(numAssets).to.equal(BigInt(cfg.assetConfigs.length));

    for (let i = 0; i < numAssets; i++) {
      const info = await comet.getAssetInfo(i);
      const expected = cfg.assetConfigs[i];
      expect(info.asset).to.equal(expected.asset);
      expect(info.priceFeed).to.equal(expected.priceFeed);
      expect(info.scale).to.equal(10n ** expected.decimals);
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
      comet.getAssetInfoByAddress(Wallet.createRandom().address),
    ).to.be.revertedWithCustomError(comet, 'BadAsset');
  },
);

scenario(
  'Comet#assetsIn > correctly sets and clears _reserved bits for assets with offset >= 16',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert, admin } = actors;
    // numAssets is a uint8, so converting it for asset-count arithmetic is safe.
    const numAssets = Number(await comet.numAssets());
    const cometAddress = await comet.getAddress();

    let targetAssetAddress: string;
    let supplyAmount: bigint;

    if (numAssets < REQUIRED_NUM_ASSETS) {
      const dm = context.world.deploymentManager;
      const assetsToAdd = REQUIRED_NUM_ASSETS - numAssets;
      const fillerCount = assetsToAdd - 1; // only the last slot needs a unique token

      // Pad with a reused existing asset so supply-by-address still hits a low offset.
      if (fillerCount > 0) {
        const filler = (await configurator.getConfiguration(cometAddress))
          .assetConfigs[0];
        const fillerConfig = {
          asset: filler.asset,
          priceFeed: filler.priceFeed,
          decimals: filler.decimals,
          borrowCollateralFactor: filler.borrowCollateralFactor,
          liquidateCollateralFactor: filler.liquidateCollateralFactor,
          liquidationFactor: filler.liquidationFactor,
          supplyCap: filler.supplyCap,
        };

        for (let i = 0; i < fillerCount; i++) {
          await context.setNextBaseFeeToZero();
          await configurator
            .connect(admin.signer)
            .addAsset(cometAddress, fillerConfig, { gasPrice: 0 });
        }
      }

      // Unique token at index 16 so getAssetInfoByAddress / supply use offset >= 16.
      // Use FaucetToken (always compiled) — MockERC20 lives in the capo submodule.
      const mockTokenContract = await dm.deploy(
        'faucetToken:extendedAssetTarget',
        'test/FaucetToken.sol',
        [exp(1_000_000, 18).toString(), 'Mock Extended Token', 18, 'MEXT'],
        true,
      );
      const mockToken = FaucetToken__factory.connect(
        await mockTokenContract.getAddress(),
        await dm.getSigner(),
      );
      const mockPriceFeed = await dm.deploy(
        'test:extendedAssetTargetPriceFeed',
        'test/SimplePriceFeed.sol',
        [1 * 10 ** 8, 8],
        true,
      );

      await context.setNextBaseFeeToZero();
      await configurator.connect(admin.signer).addAsset(
        cometAddress,
        {
          asset: await mockToken.getAddress(),
          priceFeed: await mockPriceFeed.getAddress(),
          decimals: 18,
          borrowCollateralFactor: exp(0.8, 18),
          liquidateCollateralFactor: exp(0.85, 18),
          liquidationFactor: exp(0.9, 18),
          supplyCap: exp(1e6, 18),
        },
        { gasPrice: 0 },
      );

      targetAssetAddress = await mockToken.getAddress();
      supplyAmount =
        BigInt(getConfigForScenario(context).supplyCollateral) * 10n ** 18n;
      await mockToken.allocateTo(albert.address, supplyAmount);

      await context.setNextBaseFeeToZero();
      await admin.deployAndUpgradeTo(await configurator.getAddress(), cometAddress, {
        gasPrice: 0,
      });
      await context.setAssets();
    } else {
      const existing = await comet.getAssetInfo(MIN_OFFSET_FOR_RESERVED);
      targetAssetAddress = existing.asset;
      supplyAmount =
        BigInt(getConfigForScenario(context).supplyCollateral) *
        existing.scale;
      await context.sourceTokens(
        supplyAmount,
        targetAssetAddress,
        albert.address,
      );
    }

    const assetInfo = await comet.getAssetInfo(MIN_OFFSET_FOR_RESERVED);
    expect(assetInfo.asset).to.equal(targetAssetAddress);
    expect(assetInfo.offset).to.be.gte(BigInt(MIN_OFFSET_FOR_RESERVED));

    const basicBefore = await comet.userBasic(albert.address);
    expect(basicBefore._reserved).to.equal(0n);

    const targetAsset = context.getAssetByAddress(assetInfo.asset);
    await targetAsset.approve(albert, cometAddress);
    await albert.safeSupplyAsset({
      asset: assetInfo.asset,
      amount: supplyAmount,
    });

    const expectedReserved =
      1n << (assetInfo.offset - BigInt(MIN_OFFSET_FOR_RESERVED));
    const basicAfterSupply = await comet.userBasic(albert.address);
    expect(basicAfterSupply._reserved).to.equal(expectedReserved);
    expect(basicAfterSupply.assetsIn).to.equal(basicBefore.assetsIn);

    await albert.withdrawAsset({
      asset: assetInfo.asset,
      amount: supplyAmount,
    });

    const basicAfterWithdraw = await comet.userBasic(albert.address);
    expect(basicAfterWithdraw._reserved).to.equal(0n);
    expect(basicAfterWithdraw.assetsIn).to.equal(basicBefore.assetsIn);
    expect(
      await comet.collateralBalanceOf(albert.address, assetInfo.asset),
    ).to.equal(0n);
  },
);
