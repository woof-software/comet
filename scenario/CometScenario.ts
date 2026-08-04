import { scenario } from "./context/CometContext";
import { expect } from "chai";
import { exp } from "../test/helpers";
import { expectRevertCustom, perSecond } from "./utils";
import { BigNumber, ethers } from "ethers";
import { MockERC20 } from "../build/types";
import { getConfigForScenario } from "./utils/scenarioHelper";

const REQUIRED_NUM_ASSETS = 17; // need at least 17 assets so index 16 has offset=16

type ArrayMethods = keyof Omit<any[], number>;

type NamedKeys<T> = {
  [K in keyof T as K extends number | `${number}` | ArrayMethods
    ? never
    : K]: T[K];
};

type Normalize<T> = T extends BigNumber
  ? bigint
  : T extends string | number | boolean
  ? T
  : [NamedKeys<T>] extends [Record<string, never>]
  ? T extends (infer U)[]
    ? Normalize<U>[]
    : T
  : { [K in keyof NamedKeys<T>]: Normalize<NamedKeys<T>[K]> };

type NormalizedStruct<T> = Normalize<NamedKeys<T>>;

/**
 * Hybrid array-objects with both numeric and named keys are stripped to plain
 * objects with native bigint values, safe to destructure, compare, and serialize.
 */
function normalizeStructOutput<T>(value: T): NormalizedStruct<T> {
  function normalize(val: any): any {
    if (BigNumber.isBigNumber(val)) {
      return val.toBigInt();
    }
    if (val && typeof val === "object") {
      const namedKeys = Object.keys(val).filter((key) => isNaN(Number(key)));
      if (namedKeys.length > 0) {
        return Object.fromEntries(
          namedKeys.map((key) => [key, normalize(val[key])]),
        );
      }
      if (Array.isArray(val)) {
        return val.map(normalize);
      }
    }
    return val;
  }

  return normalize(value) as NormalizedStruct<T>;
}

scenario(
  "Comet#numAssets > market has at least one collateral asset",
  {},
  async ({ comet }) => {
    expect(await comet.numAssets()).to.be.greaterThan(0);
  },
);

scenario(
  "Comet#governor > points to timelock",
  {},
  async ({ comet, timelock }) => {
    expect(await comet.governor()).to.equal(timelock.address);
  },
);

scenario(
  "Comet#governor > is not the same address as pause guardian",
  {},
  async ({ comet }) => {
    expect(await comet.governor()).to.not.equal(await comet.pauseGuardian());
  },
);

scenario("Comet#governor > is not zero address", {}, async ({ comet }) => {
  expect(await comet.governor()).to.not.equal(ethers.constants.AddressZero);
});

scenario(
  "Comet#initializeStorage > reverts if already initialized",
  {},
  async ({ comet }) => {
    await expectRevertCustom(comet.initializeStorage(), "AlreadyInitialized()");
  },
);

scenario(
  "Comet#configuration > matches configurator parameters",
  {},
  async ({ comet, configurator }) => {
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

    const numAssets = await comet.numAssets();
    expect(numAssets).to.equal(cfg.assetConfigs.length);

    for (let i = 0; i < numAssets; i++) {
      const info = await comet.getAssetInfo(i);
      const expected = cfg.assetConfigs[i];
      expect(info.asset).to.equal(expected.asset);
      expect(info.priceFeed).to.equal(expected.priceFeed);
      expect(info.scale).to.equal(BigNumber.from(10).pow(expected.decimals));
      expect(info.borrowCollateralFactor).to.equal(expected.borrowCollateralFactor);
      expect(info.liquidateCollateralFactor).to.equal(expected.liquidateCollateralFactor);
      expect(info.liquidationFactor).to.equal(expected.liquidationFactor);
      expect(info.supplyCap).to.equal(expected.supplyCap);
    }
  },
);

scenario(
  "Comet#getAssetInfoByAddress > reverts if asset does not exist",
  {},
  async ({ comet }) => {
    const nonExistentAsset = ethers.Wallet.createRandom().address;

    await expect(
      comet.getAssetInfoByAddress(nonExistentAsset),
    ).to.be.revertedWithCustomError(comet, "BadAsset");
  },
);

scenario(
  "Comet#assetsIn > correctly sets and clears _reserved bits for assets with offset >= 16",
  {},
  async ({ comet, configurator, proxyAdmin, actors }, context) => {
    const { albert, admin } = actors;
    const currentNumAssets = await comet.numAssets();

    let targetAssetAddress: string;
    let supplyAmount: bigint;

    if (currentNumAssets < REQUIRED_NUM_ASSETS) {
      const dm = context.world.deploymentManager;
      const currentConfiguration = normalizeStructOutput(
        await configurator.getConfiguration(comet.address),
      );
      const assetsToAdd = REQUIRED_NUM_ASSETS - currentNumAssets;

      for (let i = 0; i < assetsToAdd; i++) {
        const mockToken = (await dm.deploy(
          `mockERC20:extendedAsset_${i}`,
          "capo/contracts/test/MockERC20.sol",
          ["Mock Extended Token", "MEXT", 18],
          true,
        )) as MockERC20;

        const mockPriceFeed = await dm.deploy(
          `test:extendedAssetPriceFeed_${i}`,
          "test/SimplePriceFeed.sol",
          [1 * 10 ** 8, 8],
          true,
        );

        const newAssetConfig = {
          asset: mockToken.address,
          priceFeed: mockPriceFeed.address,
          decimals: 18,
          borrowCollateralFactor: exp(0.8, 18),
          liquidateCollateralFactor: exp(0.85, 18),
          liquidationFactor: exp(0.9, 18),
          supplyCap: exp(1e6, 18),
        };

        currentConfiguration.assetConfigs.push(newAssetConfig);

        if (i === assetsToAdd - 1) {
          targetAssetAddress = mockToken.address;
          supplyAmount =
            BigInt(getConfigForScenario(context).supplyCollateral) *
            10n ** BigInt(newAssetConfig.decimals);

          await mockToken.mint(albert.address, supplyAmount);
        }
      }

      await context.setNextBaseFeeToZero();
      await configurator
        .connect(admin.signer)
        .setConfiguration(comet.address, currentConfiguration, { gasPrice: 0 });
      await context.setNextBaseFeeToZero();
      await proxyAdmin
        .connect(admin.signer)
        .deployAndUpgradeTo(configurator.address, comet.address, {
          gasPrice: 0,
        });

      await context.setAssets();
    } else {
      const assetInfo = await comet.getAssetInfo(REQUIRED_NUM_ASSETS - 1);
      targetAssetAddress = assetInfo.asset;
      supplyAmount =
        BigInt(getConfigForScenario(context).supplyCollateral) *
        assetInfo.scale.toBigInt();
      await context.sourceTokens(
        supplyAmount,
        targetAssetAddress,
        albert.address,
      );
    }

    const targetAsset = context.getAssetByAddress(targetAssetAddress);
    const assetInfo = await comet.getAssetInfo(REQUIRED_NUM_ASSETS - 1);
    const targetOffset = assetInfo.offset;

    const basicBefore = await comet.userBasic(albert.address);
    expect(basicBefore._reserved).to.equal(0);

    await targetAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({
      asset: targetAssetAddress,
      amount: supplyAmount,
    });

    const expectedReservedAfterSupply =
      1 << (targetOffset - (REQUIRED_NUM_ASSETS - 1));
    const basicAfterSupply = await comet.userBasic(albert.address);

    expect(basicAfterSupply._reserved).to.equal(expectedReservedAfterSupply);
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
