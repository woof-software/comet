import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { expectRevertCustom, supportsMarketAdminPermissionChecker } from './utils';
import { MarketAdminPermissionChecker__factory, CometFactoryWithExtendedAssetList__factory } from '../build/types';

const SECONDS_PER_YEAR = 31_536_000n;
// Based on contract's internal precision: FACTOR_SCALE=1e18 with 4 decimal places
const FACTOR_SCALE = 10n ** 18n;
const MIN_FACTOR_INCREMENT = FACTOR_SCALE / 10n ** 4n;

type ArrayMethods = keyof Omit<any[], number>;

type NamedKeys<T> = {
  [K in keyof T as K extends number | `${number}` | ArrayMethods ? never : K]: T[K];
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

function normalizeStructOutput<T>(value: T): NormalizedStruct<T> {
  function normalize(val: any): any {
    if (BigNumber.isBigNumber(val)) {
      return val.toBigInt();
    }
    if (val && typeof val === 'object') {
      const namedKeys = Object.keys(val).filter((key) => isNaN(Number(key)));
      if (namedKeys.length > 0) {
        return Object.fromEntries(namedKeys.map((key) => [key, normalize(val[key])]));
      }
      if (Array.isArray(val)) {
        return val.map(normalize);
      }
    }
    return val;
  }

  return normalize(value) as NormalizedStruct<T>;
}

async function getActiveAsset(context: CometContext) {
  const configurator = await context.getConfigurator();
  const cometAddress = (await context.getComet()).address;
  const assetConfigs = normalizeStructOutput(await configurator.getConfiguration(cometAddress)).assetConfigs;

  const assetIndex = assetConfigs.findIndex((asset) => asset.borrowCollateralFactor > 0n && asset.supplyCap > 0n);

  if (assetIndex === -1) {
    throw new Error('No active asset found in configuration');
  }

  return {
    assetIndex,
    assetConfig: assetConfigs[assetIndex]
  };
}

async function getMarketAdminSigner(context: CometContext) {
  const { albert } = context.actors;
  const configurator = await context.getConfigurator();
  const marketAdminPermissionChecker = MarketAdminPermissionChecker__factory.connect(
    await configurator.marketAdminPermissionChecker(),
    albert.signer
  );
  return context.world.impersonateAddress(await marketAdminPermissionChecker.marketAdmin());
}

function getMinSupplyCapIncrement(assetConfig: { supplyCap: bigint; decimals: number }): bigint {
  return 10n ** BigInt(assetConfig.decimals);
}

/*
|========================================
|       Governor-Only Functions
|========================================
*/
scenario.only(
  'Configurator#transferGovernor updates configurator governor if called by governor',
  {},
  async ({ configurator, actors }, context) => {
    const { albert, admin } = actors;

    const newGovernor = albert.address;
    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).transferGovernor(newGovernor, { gasPrice: 0 });

    expect(await configurator.governor()).to.be.equal(newGovernor);
  }
);

scenario.only(
  'Configurator#transferGovernor succeeds if new governor is zero address',
  {},
  async ({ configurator, actors }, context) => {
    const { admin } = actors;

    const newGovernor = ethers.constants.AddressZero;
    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).transferGovernor(newGovernor, { gasPrice: 0 });

    expect(await configurator.governor()).to.be.equal(newGovernor);
  }
);

scenario.only(
  'Configurator#transferGovernor new governor can call governor-only methods',
  {},
  async ({ configurator, actors }, context) => {
    const { albert, betty, admin } = actors;

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).transferGovernor(albert.address, { gasPrice: 0 });
    await context.setNextBaseFeeToZero();
    await configurator.connect(albert.signer).transferGovernor(betty.address, { gasPrice: 0 });

    expect(await configurator.governor()).to.be.equal(betty.address);
  }
);

scenario.only(
  'Configurator#transferGovernor reverts if called by non-governor',
  {},
  async ({ configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(configurator.connect(albert.signer).transferGovernor(albert.address), 'Unauthorized()');
  }
);

scenario.only(
  'Configurator#setFactory updates factory if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const newFactory = await new CometFactoryWithExtendedAssetList__factory(admin.signer).deploy({ gasPrice: 0 });
    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setFactory(comet.address, newFactory.address, { gasPrice: 0 });

    expect(await configurator.factory(comet.address)).to.be.equal(newFactory.address);
  }
);

scenario.only(
  'Configurator#setFactory can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewFactory = '0x' + '1234'.repeat(10);
    const secondNewFactory = '0x' + '5678'.repeat(10);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setFactory(comet.address, firstNewFactory, { gasPrice: 0 });

    expect(await configurator.factory(comet.address)).to.be.equal(firstNewFactory);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setFactory(comet.address, secondNewFactory, { gasPrice: 0 });

    expect(await configurator.factory(comet.address)).to.be.equal(secondNewFactory);
  }
);

scenario.only(
  'Configurator#setFactory reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert, admin } = actors;

    await context.setNextBaseFeeToZero();
    const newFactory = await new CometFactoryWithExtendedAssetList__factory(admin.signer).deploy({ gasPrice: 0 });

    await expectRevertCustom(
      configurator.connect(albert.signer).setFactory(comet.address, newFactory.address),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setConfiguration updates value if called by governor',
  {},
  async ({ governor, configurator, actors }, context) => {
    const { admin } = actors;

    const newCometProxy = '0x' + '1234'.repeat(10);
    const newConfiguration = {
      governor: governor.address,
      pauseGuardian: '0x' + '5678'.repeat(10),
      baseToken: '0x' + '4321'.repeat(10),
      baseTokenPriceFeed: '0x' + '8765'.repeat(10),
      extensionDelegate: '0x' + '1122'.repeat(10),
      supplyKink: 1n,
      supplyPerYearInterestRateSlopeLow: 1n,
      supplyPerYearInterestRateSlopeHigh: 1n,
      supplyPerYearInterestRateBase: 1n,
      borrowKink: 1n,
      borrowPerYearInterestRateSlopeLow: 1n,
      borrowPerYearInterestRateSlopeHigh: 1n,
      borrowPerYearInterestRateBase: 1n,
      storeFrontPriceFactor: 1n,
      trackingIndexScale: 1n,
      baseTrackingSupplySpeed: 1n,
      baseTrackingBorrowSpeed: 1n,
      baseMinForRewards: 1n,
      baseBorrowMin: 1n,
      targetReserves: 1n,
      assetConfigs: [
        {
          asset: '0x' + '2211'.repeat(10),
          priceFeed: '0x' + '3344'.repeat(10),
          decimals: 18,
          borrowCollateralFactor: 1n,
          liquidateCollateralFactor: 1n,
          liquidationFactor: 1n,
          supplyCap: 1n
        }
      ]
    };

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setConfiguration(newCometProxy, newConfiguration, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(newCometProxy))).to.be.deep.equal(
      newConfiguration
    );
  }
);

scenario.only(
  'Configurator#setConfiguration reverts if called by non-governor',
  {},
  async ({ governor, configurator, actors }) => {
    const { albert } = actors;

    const newCometProxy = '0x' + '1234'.repeat(10);
    const newConfiguration = {
      governor: governor.address,
      pauseGuardian: '0x' + '5678'.repeat(10),
      baseToken: '0x' + '4321'.repeat(10),
      baseTokenPriceFeed: '0x' + '8765'.repeat(10),
      extensionDelegate: '0x' + '1122'.repeat(10),
      supplyKink: 1n,
      supplyPerYearInterestRateSlopeLow: 1n,
      supplyPerYearInterestRateSlopeHigh: 1n,
      supplyPerYearInterestRateBase: 1n,
      borrowKink: 1n,
      borrowPerYearInterestRateSlopeLow: 1n,
      borrowPerYearInterestRateSlopeHigh: 1n,
      borrowPerYearInterestRateBase: 1n,
      storeFrontPriceFactor: 1n,
      trackingIndexScale: 1n,
      baseTrackingSupplySpeed: 1n,
      baseTrackingBorrowSpeed: 1n,
      baseMinForRewards: 1n,
      baseBorrowMin: 1n,
      targetReserves: 1n,
      assetConfigs: [
        {
          asset: '0x' + '2211'.repeat(10),
          priceFeed: '0x' + '3344'.repeat(10),
          decimals: 18,
          borrowCollateralFactor: 1n,
          liquidateCollateralFactor: 1n,
          liquidationFactor: 1n,
          supplyCap: 1n
        }
      ]
    };

    await expectRevertCustom(
      configurator.connect(albert.signer).setConfiguration(newCometProxy, newConfiguration),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setGovernor updates governor in configuration if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const newGovernor = '0x' + '1234'.repeat(10);
    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setGovernor(comet.address, newGovernor, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).governor).to.be.equal(newGovernor);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect(await comet.governor()).to.be.equal(newGovernor);
  }
);

scenario.only(
  'Configurator#setGovernor can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewGovernor = '0x' + '1234'.repeat(10);
    const secondNewGovernor = '0x' + '5678'.repeat(10);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setGovernor(comet.address, firstNewGovernor, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).governor).to.be.equal(firstNewGovernor);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setGovernor(comet.address, secondNewGovernor, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).governor).to.be.equal(secondNewGovernor);
  }
);

scenario.only(
  'Configurator#setGovernor reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setGovernor(comet.address, '0x' + '1234'.repeat(10)),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setPauseGuardian updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const newPauseGuardian = '0x' + '1234'.repeat(10);
    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setPauseGuardian(comet.address, newPauseGuardian, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).pauseGuardian).to.be.equal(newPauseGuardian);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect(await comet.pauseGuardian()).to.be.equal(newPauseGuardian);
  }
);

scenario.only(
  'Configurator#setPauseGuardian can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewPauseGuardian = '0x' + '1234'.repeat(10);
    const secondNewPauseGuardian = '0x' + '5678'.repeat(10);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setPauseGuardian(comet.address, firstNewPauseGuardian, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).pauseGuardian).to.be.equal(firstNewPauseGuardian);
    
    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setPauseGuardian(comet.address, secondNewPauseGuardian, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).pauseGuardian).to.be.equal(secondNewPauseGuardian);
  }
);

scenario.only(
  'Configurator#setPauseGuardian reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setPauseGuardian(comet.address, '0x' + '1234'.repeat(10)),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setMarketAdminPermissionChecker updates value if called by governor',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ configurator, actors }) => {
    const { admin } = actors;

    const newMarketAdminPermissionChecker = '0x' + '1234'.repeat(10);
    await configurator.connect(admin.signer).setMarketAdminPermissionChecker(newMarketAdminPermissionChecker, {
      gasPrice: 0
    });

    expect(await configurator.marketAdminPermissionChecker()).to.be.equal(newMarketAdminPermissionChecker);
  }
);

scenario.only(
  'Configurator#setMarketAdminPermissionChecker can be overwritten multiple times',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewMarketAdminPermissionChecker = '0x' + '1234'.repeat(10);
    const secondNewMarketAdminPermissionChecker = '0x' + '5678'.repeat(10);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setMarketAdminPermissionChecker(firstNewMarketAdminPermissionChecker, {
      gasPrice: 0
    });

    expect(await configurator.marketAdminPermissionChecker()).to.be.equal(firstNewMarketAdminPermissionChecker);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setMarketAdminPermissionChecker(secondNewMarketAdminPermissionChecker, {
      gasPrice: 0
    });

    expect(await configurator.marketAdminPermissionChecker()).to.be.equal(secondNewMarketAdminPermissionChecker);
  }
);

scenario.only(
  'Configurator#setMarketAdminPermissionChecker reverts if called by non-governor',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setMarketAdminPermissionChecker('0x' + '1234'.repeat(10)),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setBaseTokenPriceFeed updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const newBaseTokenPriceFeed = '0x' + '1234'.repeat(10);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseTokenPriceFeed(comet.address, newBaseTokenPriceFeed, {
      gasPrice: 0
    });

    expect((await configurator.getConfiguration(comet.address)).baseTokenPriceFeed).to.be.equal(newBaseTokenPriceFeed);
  }
);

scenario.only(
  'Configurator#setBaseTokenPriceFeed can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewBaseTokenPriceFeed = '0x' + '1234'.repeat(10);
    const secondNewBaseTokenPriceFeed = '0x' + '5678'.repeat(10);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseTokenPriceFeed(comet.address, firstNewBaseTokenPriceFeed, {
      gasPrice: 0
    });

    expect((await configurator.getConfiguration(comet.address)).baseTokenPriceFeed).to.be.equal(firstNewBaseTokenPriceFeed);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseTokenPriceFeed(comet.address, secondNewBaseTokenPriceFeed, {
      gasPrice: 0
    });

    expect((await configurator.getConfiguration(comet.address)).baseTokenPriceFeed).to.be.equal(secondNewBaseTokenPriceFeed);
  }
);

scenario.only(
  'Configurator#setBaseTokenPriceFeed reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseTokenPriceFeed(comet.address, '0x' + '1234'.repeat(10)),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setExtensionDelegate updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const newExtensionDelegate = '0x' + '1234'.repeat(10);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setExtensionDelegate(comet.address, newExtensionDelegate, {
      gasPrice: 0
    });

    expect((await configurator.getConfiguration(comet.address)).extensionDelegate).to.be.equal(newExtensionDelegate);
  }
);

scenario.only(
  'Configurator#setExtensionDelegate can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewExtensionDelegate = '0x' + '1234'.repeat(10);
    const secondNewExtensionDelegate = '0x' + '5678'.repeat(10);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setExtensionDelegate(comet.address, firstNewExtensionDelegate, {
      gasPrice: 0
    });

    expect((await configurator.getConfiguration(comet.address)).extensionDelegate).to.be.equal(firstNewExtensionDelegate);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setExtensionDelegate(comet.address, secondNewExtensionDelegate, {
      gasPrice: 0
    });

    expect((await configurator.getConfiguration(comet.address)).extensionDelegate).to.be.equal(secondNewExtensionDelegate);
  }
);

scenario.only(
  'Configurator#setExtensionDelegate reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setExtensionDelegate(comet.address, '0x' + '1234'.repeat(10)),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setStoreFrontPriceFactor updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldStoreFrontPriceFactor = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).storeFrontPriceFactor;

    const newStoreFrontPriceFactor = oldStoreFrontPriceFactor + 1n;
    await configurator.connect(admin.signer).setStoreFrontPriceFactor(comet.address, newStoreFrontPriceFactor, {
      gasPrice: 0
    });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).storeFrontPriceFactor).to.be.equal(
      newStoreFrontPriceFactor
    );

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect(await comet.storeFrontPriceFactor()).to.be.equal(newStoreFrontPriceFactor);
  }
);

scenario.only(
  'Configurator#setStoreFrontPriceFactor reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setStoreFrontPriceFactor(comet.address, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setBaseMinForRewards updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    const oldBaseMinForRewards = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseMinForRewards;

    const newBaseMinForRewards = oldBaseMinForRewards + 1n;
    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseMinForRewards(comet.address, newBaseMinForRewards, {
      gasPrice: 0
    });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseMinForRewards).to.be.equal(
      newBaseMinForRewards
    );

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect(await comet.baseMinForRewards()).to.be.equal(newBaseMinForRewards);
  }
);

scenario.only(
  'Configurator#setBaseMinForRewards reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseMinForRewards(comet.address, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setTargetReserves updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    const oldTargetReserves = normalizeStructOutput(await configurator.getConfiguration(comet.address)).targetReserves;

    const newTargetReserves = oldTargetReserves + 1n;
    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setTargetReserves(comet.address, newTargetReserves, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).targetReserves).to.be.equal(
      newTargetReserves
    );

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect(await comet.targetReserves()).to.be.equal(newTargetReserves);
  }
);

scenario.only(
  'Configurator#setTargetReserves reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setTargetReserves(comet.address, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#addAsset succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const numAssetsBefore = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs
      .length;

    const newAssetConfig = {
      asset: '0x' + '2211'.repeat(10),
      priceFeed: '0x' + '3344'.repeat(10),
      decimals: 18,
      borrowCollateralFactor: 1n,
      liquidateCollateralFactor: 1n,
      liquidationFactor: 1n,
      supplyCap: 1n
    };

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).addAsset(comet.address, newAssetConfig, { gasPrice: 0 });
    const assetConfigsAfter = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs;

    expect(assetConfigsAfter.length).to.be.equal(numAssetsBefore + 1);
    expect(assetConfigsAfter.at(-1)).to.be.deep.equal(newAssetConfig);
  }
);

scenario.only(
  'Configurator#addAsset reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).addAsset(comet.address, {
        asset: '0x' + '2211'.repeat(10),
        priceFeed: '0x' + '3344'.repeat(10),
        decimals: 18,
        borrowCollateralFactor: 1n,
        liquidateCollateralFactor: 1n,
        liquidationFactor: 1n,
        supplyCap: 1n
      }),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#updateAsset succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const assetConfigsBefore = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs;

    const { assetIndex } = await getActiveAsset(context);
    const existingAssetConfig = assetConfigsBefore.at(assetIndex);

    const updatedAssetConfig = {
      ...existingAssetConfig,
      borrowCollateralFactor: existingAssetConfig.borrowCollateralFactor + MIN_FACTOR_INCREMENT,
      liquidateCollateralFactor: existingAssetConfig.liquidateCollateralFactor + MIN_FACTOR_INCREMENT
    };

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).updateAsset(comet.address, updatedAssetConfig, { gasPrice: 0 });
    const assetConfigsAfter = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs;

    expect(assetConfigsAfter.length).to.be.equal(assetConfigsBefore.length);
    expect(assetConfigsAfter.at(assetIndex)).to.be.deep.equal(updatedAssetConfig);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    const updatedAssetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(existingAssetConfig.asset));

    expect(updatedAssetInfo.borrowCollateralFactor).to.be.equal(updatedAssetConfig.borrowCollateralFactor);
    expect(updatedAssetInfo.liquidateCollateralFactor).to.be.equal(updatedAssetConfig.liquidateCollateralFactor);
  }
);

scenario.only(
  'Configurator#updateAsset reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const existingAssetConfig = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).assetConfigs.at(-1);

    const updatedAssetConfig = {
      ...existingAssetConfig,
      supplyCap: existingAssetConfig.supplyCap + getMinSupplyCapIncrement(existingAssetConfig)
    };

    await expectRevertCustom(
      configurator.connect(albert.signer).updateAsset(comet.address, updatedAssetConfig),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#updateAsset reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const existingAssetConfig = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).assetConfigs.at(-1);

    const updatedAssetConfig = {
      ...existingAssetConfig,
      asset: '0x' + '9999'.repeat(10)
    };

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAsset(comet.address, updatedAssetConfig),
      'AssetDoesNotExist()'
    );
  }
);

scenario.only(
  'Configurator#updateAssetPriceFeed succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const newPriceFeed = '0x' + '8899'.repeat(10);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetPriceFeed(comet.address, assetConfig.asset, newPriceFeed, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).priceFeed).to.be.equal(
      newPriceFeed
    );
  }
);

scenario.only(
  'Configurator#updateAssetPriceFeed reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const assetConfigs = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs;
    const newPriceFeed = '0x' + '8899'.repeat(10);

    await expectRevertCustom(
      configurator.connect(albert.signer).updateAssetPriceFeed(comet.address, assetConfigs.at(-1).asset, newPriceFeed),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#updateAssetPriceFeed reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const nonExistingAsset = '0x' + '1199'.repeat(10);
    const newPriceFeed = '0x' + '8899'.repeat(10);

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAssetPriceFeed(comet.address, nonExistingAsset, newPriceFeed),
      'AssetDoesNotExist()'
    );
  }
);

/*
|========================================
| Governor & Market Admin-Only Functions
|========================================
*/

scenario.only(
  'Configurator#setSupplyKink updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldSupplyKink = normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyKink;
    const newSupplyKink = oldSupplyKink + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setSupplyKink(comet.address, newSupplyKink, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyKink).to.be.equal(
      newSupplyKink
    );

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.supplyKink()).toBigInt()).to.be.equal(newSupplyKink);
  }
);

scenario.only(
  'Configurator#setSupplyKink updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    const marketAdminSigner = await getMarketAdminSigner(context);

    const oldSupplyKink = normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyKink;
    const newSupplyKink = oldSupplyKink + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(marketAdminSigner).setSupplyKink(comet.address, newSupplyKink, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyKink).to.be.equal(
      newSupplyKink
    );

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.supplyKink()).toBigInt()).to.be.equal(newSupplyKink);
  }
);

scenario.only(
  'Configurator#setSupplyKink reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(configurator.connect(albert.signer).setSupplyKink(comet.address, 1n), 'Unauthorized()');
  }
);

scenario.only(
  'Configurator#setSupplyPerYearInterestRateSlopeLow updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateSlopeLow;

    const newSupplyPerYearInterestRateSlopeLow = oldSupplyPerYearInterestRateSlopeLow + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeLow(comet.address, newSupplyPerYearInterestRateSlopeLow, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeLow
    ).to.be.equal(newSupplyPerYearInterestRateSlopeLow);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.supplyPerSecondInterestRateSlopeLow()).toBigInt()).to.be.equal(
      newSupplyPerYearInterestRateSlopeLow / SECONDS_PER_YEAR
    );
  }
);

scenario.only(
  'Configurator#setSupplyPerYearInterestRateSlopeLow updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);

    const oldSupplyPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateSlopeLow;

    const newSupplyPerYearInterestRateSlopeLow = oldSupplyPerYearInterestRateSlopeLow + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .setSupplyPerYearInterestRateSlopeLow(comet.address, newSupplyPerYearInterestRateSlopeLow, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeLow
    ).to.be.equal(newSupplyPerYearInterestRateSlopeLow);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.supplyPerSecondInterestRateSlopeLow()).toBigInt()).to.be.equal(
      newSupplyPerYearInterestRateSlopeLow / SECONDS_PER_YEAR
    );
  }
);

scenario.only(
  'Configurator#setSupplyPerYearInterestRateSlopeLow reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setSupplyPerYearInterestRateSlopeLow(comet.address, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setSupplyPerYearInterestRateSlopeHigh updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateSlopeHigh;

    const newSupplyPerYearInterestRateSlopeHigh = oldSupplyPerYearInterestRateSlopeHigh + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeHigh(comet.address, newSupplyPerYearInterestRateSlopeHigh, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeHigh
    ).to.be.equal(newSupplyPerYearInterestRateSlopeHigh);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.supplyPerSecondInterestRateSlopeHigh()).toBigInt()).to.be.equal(
      newSupplyPerYearInterestRateSlopeHigh / SECONDS_PER_YEAR
    );
  }
);

scenario.only(
  'Configurator#setSupplyPerYearInterestRateSlopeHigh updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);

    const oldSupplyPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateSlopeHigh;

    const newSupplyPerYearInterestRateSlopeHigh = oldSupplyPerYearInterestRateSlopeHigh + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .setSupplyPerYearInterestRateSlopeHigh(comet.address, newSupplyPerYearInterestRateSlopeHigh, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeHigh
    ).to.be.equal(newSupplyPerYearInterestRateSlopeHigh);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.supplyPerSecondInterestRateSlopeHigh()).toBigInt()).to.be.equal(
      newSupplyPerYearInterestRateSlopeHigh / SECONDS_PER_YEAR
    );
  }
);

scenario.only(
  'Configurator#setSupplyPerYearInterestRateSlopeHigh reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setSupplyPerYearInterestRateSlopeHigh(comet.address, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setSupplyPerYearInterestRateBase updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateBase;

    const newSupplyPerYearInterestRateBase = oldSupplyPerYearInterestRateBase + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateBase(comet.address, newSupplyPerYearInterestRateBase, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateBase
    ).to.be.equal(newSupplyPerYearInterestRateBase);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.supplyPerSecondInterestRateBase()).toBigInt()).to.be.equal(
      newSupplyPerYearInterestRateBase / SECONDS_PER_YEAR
    );
  }
);

scenario.only(
  'Configurator#setSupplyPerYearInterestRateBase updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);

    const oldSupplyPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateBase;

    const newSupplyPerYearInterestRateBase = oldSupplyPerYearInterestRateBase + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .setSupplyPerYearInterestRateBase(comet.address, newSupplyPerYearInterestRateBase, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateBase
    ).to.be.equal(newSupplyPerYearInterestRateBase);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.supplyPerSecondInterestRateBase()).toBigInt()).to.be.equal(
      newSupplyPerYearInterestRateBase / SECONDS_PER_YEAR
    );
  }
);

scenario.only(
  'Configurator#setSupplyPerYearInterestRateBase reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setSupplyPerYearInterestRateBase(comet.address, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setBorrowKink updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBorrowKink = normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowKink;
    const newBorrowKink = oldBorrowKink + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBorrowKink(comet.address, newBorrowKink, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowKink).to.be.equal(
      newBorrowKink
    );

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.borrowKink()).toBigInt()).to.be.equal(newBorrowKink);
  }
);

scenario.only(
  'Configurator#setBorrowKink updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);
    const oldBorrowKink = normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowKink;
    const newBorrowKink = oldBorrowKink + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(marketAdminSigner).setBorrowKink(comet.address, newBorrowKink, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowKink).to.be.equal(
      newBorrowKink
    );

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.borrowKink()).toBigInt()).to.be.equal(newBorrowKink);
  }
);

scenario.only(
  'Configurator#setBorrowKink reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(configurator.connect(albert.signer).setBorrowKink(comet.address, 1n), 'Unauthorized()');
  }
);

scenario.only(
  'Configurator#setBorrowPerYearInterestRateSlopeLow updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateSlopeLow;

    const newBorrowPerYearInterestRateSlopeLow = oldBorrowPerYearInterestRateSlopeLow + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeLow(comet.address, newBorrowPerYearInterestRateSlopeLow, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeLow
    ).to.be.equal(newBorrowPerYearInterestRateSlopeLow);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.borrowPerSecondInterestRateSlopeLow()).toBigInt()).to.be.equal(
      newBorrowPerYearInterestRateSlopeLow / SECONDS_PER_YEAR
    );
  }
);

scenario.only(
  'Configurator#setBorrowPerYearInterestRateSlopeLow updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);

    const oldBorrowPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateSlopeLow;

    const newBorrowPerYearInterestRateSlopeLow = oldBorrowPerYearInterestRateSlopeLow + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .setBorrowPerYearInterestRateSlopeLow(comet.address, newBorrowPerYearInterestRateSlopeLow, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeLow
    ).to.be.equal(newBorrowPerYearInterestRateSlopeLow);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.borrowPerSecondInterestRateSlopeLow()).toBigInt()).to.be.equal(
      newBorrowPerYearInterestRateSlopeLow / SECONDS_PER_YEAR
    );
  }
);

scenario.only(
  'Configurator#setBorrowPerYearInterestRateSlopeLow reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBorrowPerYearInterestRateSlopeLow(comet.address, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setBorrowPerYearInterestRateSlopeHigh updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateSlopeHigh;

    const newBorrowPerYearInterestRateSlopeHigh = oldBorrowPerYearInterestRateSlopeHigh + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeHigh(comet.address, newBorrowPerYearInterestRateSlopeHigh, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeHigh
    ).to.be.equal(newBorrowPerYearInterestRateSlopeHigh);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.borrowPerSecondInterestRateSlopeHigh()).toBigInt()).to.be.equal(
      newBorrowPerYearInterestRateSlopeHigh / SECONDS_PER_YEAR
    );
  }
);

scenario.only(
  'Configurator#setBorrowPerYearInterestRateSlopeHigh updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);

    const oldBorrowPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateSlopeHigh;

    const newBorrowPerYearInterestRateSlopeHigh = oldBorrowPerYearInterestRateSlopeHigh + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .setBorrowPerYearInterestRateSlopeHigh(comet.address, newBorrowPerYearInterestRateSlopeHigh, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeHigh
    ).to.be.equal(newBorrowPerYearInterestRateSlopeHigh);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.borrowPerSecondInterestRateSlopeHigh()).toBigInt()).to.be.equal(
      newBorrowPerYearInterestRateSlopeHigh / SECONDS_PER_YEAR
    );
  }
);

scenario.only(
  'Configurator#setBorrowPerYearInterestRateSlopeHigh reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBorrowPerYearInterestRateSlopeHigh(comet.address, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setBorrowPerYearInterestRateBase updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateBase;

    const newBorrowPerYearInterestRateBase = oldBorrowPerYearInterestRateBase + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateBase(comet.address, newBorrowPerYearInterestRateBase, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateBase
    ).to.be.equal(newBorrowPerYearInterestRateBase);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.borrowPerSecondInterestRateBase()).toBigInt()).to.be.equal(
      newBorrowPerYearInterestRateBase / SECONDS_PER_YEAR
    );
  }
);

scenario.only(
  'Configurator#setBorrowPerYearInterestRateBase updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);

    const oldBorrowPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateBase;

    const newBorrowPerYearInterestRateBase = oldBorrowPerYearInterestRateBase + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .setBorrowPerYearInterestRateBase(comet.address, newBorrowPerYearInterestRateBase, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateBase
    ).to.be.equal(newBorrowPerYearInterestRateBase);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.borrowPerSecondInterestRateBase()).toBigInt()).to.be.equal(
      newBorrowPerYearInterestRateBase / SECONDS_PER_YEAR
    );
  }
);

scenario.only(
  'Configurator#setBorrowPerYearInterestRateBase reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBorrowPerYearInterestRateBase(comet.address, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setBaseTrackingSupplySpeed updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBaseTrackingSupplySpeed = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseTrackingSupplySpeed;

    const newBaseTrackingSupplySpeed = oldBaseTrackingSupplySpeed + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseTrackingSupplySpeed(comet.address, newBaseTrackingSupplySpeed, {
      gasPrice: 0
    });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingSupplySpeed
    ).to.be.equal(newBaseTrackingSupplySpeed);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.baseTrackingSupplySpeed()).toBigInt()).to.be.equal(newBaseTrackingSupplySpeed);
  }
);

scenario.only(
  'Configurator#setBaseTrackingSupplySpeed updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);

    const oldBaseTrackingSupplySpeed = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseTrackingSupplySpeed;

    const newBaseTrackingSupplySpeed = oldBaseTrackingSupplySpeed + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .setBaseTrackingSupplySpeed(comet.address, newBaseTrackingSupplySpeed, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingSupplySpeed
    ).to.be.equal(newBaseTrackingSupplySpeed);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.baseTrackingSupplySpeed()).toBigInt()).to.be.equal(newBaseTrackingSupplySpeed);
  }
);

scenario.only(
  'Configurator#setBaseTrackingSupplySpeed reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseTrackingSupplySpeed(comet.address, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setBaseTrackingBorrowSpeed updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBaseTrackingBorrowSpeed = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseTrackingBorrowSpeed;

    const newBaseTrackingBorrowSpeed = oldBaseTrackingBorrowSpeed + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseTrackingBorrowSpeed(comet.address, newBaseTrackingBorrowSpeed, {
      gasPrice: 0
    });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingBorrowSpeed
    ).to.be.equal(newBaseTrackingBorrowSpeed);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.baseTrackingBorrowSpeed()).toBigInt()).to.be.equal(newBaseTrackingBorrowSpeed);
  }
);

scenario.only(
  'Configurator#setBaseTrackingBorrowSpeed updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);

    const oldBaseTrackingBorrowSpeed = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseTrackingBorrowSpeed;

    const newBaseTrackingBorrowSpeed = oldBaseTrackingBorrowSpeed + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .setBaseTrackingBorrowSpeed(comet.address, newBaseTrackingBorrowSpeed, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingBorrowSpeed
    ).to.be.equal(newBaseTrackingBorrowSpeed);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.baseTrackingBorrowSpeed()).toBigInt()).to.be.equal(newBaseTrackingBorrowSpeed);
  }
);

scenario.only(
  'Configurator#setBaseTrackingBorrowSpeed reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseTrackingBorrowSpeed(comet.address, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#setBaseBorrowMin updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBaseBorrowMin = normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseBorrowMin;
    const newBaseBorrowMin = oldBaseBorrowMin + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseBorrowMin(comet.address, newBaseBorrowMin, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseBorrowMin).to.be.equal(
      newBaseBorrowMin
    );

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.baseBorrowMin()).toBigInt()).to.be.equal(newBaseBorrowMin);
  }
);

scenario.only(
  'Configurator#setBaseBorrowMin updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);
    const oldBaseBorrowMin = normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseBorrowMin;
    const newBaseBorrowMin = oldBaseBorrowMin + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(marketAdminSigner).setBaseBorrowMin(comet.address, newBaseBorrowMin, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseBorrowMin).to.be.equal(
      newBaseBorrowMin
    );

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect((await comet.baseBorrowMin()).toBigInt()).to.be.equal(newBaseBorrowMin);
  }
);

scenario.only(
  'Configurator#setBaseBorrowMin reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(configurator.connect(albert.signer).setBaseBorrowMin(comet.address, 1n), 'Unauthorized()');
  }
);

scenario.only(
  'Configurator#updateAssetBorrowCollateralFactor succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetBorrowCollateralFactor = assetConfig.borrowCollateralFactor;
    const newAssetBorrowCollateralFactor = oldAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, newAssetBorrowCollateralFactor, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(newAssetBorrowCollateralFactor);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.borrowCollateralFactor).to.be.equal(newAssetBorrowCollateralFactor);
  }
);

scenario.only(
  'Configurator#updateAssetBorrowCollateralFactor disables asset if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const assetConfigs = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs;
    const newAssetBorrowCollateralFactor = 0n;

    const assetIdex = -2;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetBorrowCollateralFactor(
        comet.address,
        assetConfigs.at(assetIdex).asset,
        newAssetBorrowCollateralFactor,
        {
          gasPrice: 0
        }
      );

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIdex)
        .borrowCollateralFactor
    ).to.be.equal(newAssetBorrowCollateralFactor);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfigs.at(assetIdex).asset));

    expect(assetInfo.borrowCollateralFactor).to.be.equal(newAssetBorrowCollateralFactor);
  }
);

scenario.only(
  'Configurator#updateAssetBorrowCollateralFactor succeeds if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);
    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetBorrowCollateralFactor = assetConfig.borrowCollateralFactor;
    const newAssetBorrowCollateralFactor = oldAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, newAssetBorrowCollateralFactor, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(newAssetBorrowCollateralFactor);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.borrowCollateralFactor).to.be.equal(newAssetBorrowCollateralFactor);
  }
);

scenario.only(
  'Configurator#updateAssetBorrowCollateralFactor disables asset if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);
    const assetConfigs = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs;
    const newAssetBorrowCollateralFactor = 0n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .updateAssetBorrowCollateralFactor(comet.address, assetConfigs.at(-1).asset, newAssetBorrowCollateralFactor, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(-1)
        .borrowCollateralFactor
    ).to.be.equal(newAssetBorrowCollateralFactor);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfigs.at(-1).asset));

    expect(assetInfo.borrowCollateralFactor).to.be.equal(newAssetBorrowCollateralFactor);
  }
);

scenario.only(
  'Configurator#updateAssetBorrowCollateralFactor reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const existingAsset = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
      -1
    ).asset;

    await expectRevertCustom(
      configurator.connect(albert.signer).updateAssetBorrowCollateralFactor(comet.address, existingAsset, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#updateAssetBorrowCollateralFactor reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const nonExistingAsset = '0x' + '1199'.repeat(10);

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, nonExistingAsset, 1n),
      'AssetDoesNotExist()'
    );
  }
);

scenario.only(
  'Configurator#updateAssetLiquidateCollateralFactor succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetLiquidateCollateralFactor = assetConfig.liquidateCollateralFactor;
    const newAssetLiquidateCollateralFactor = oldAssetLiquidateCollateralFactor + MIN_FACTOR_INCREMENT;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetLiquidateCollateralFactor(comet.address, assetConfig.asset, newAssetLiquidateCollateralFactor, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidateCollateralFactor
    ).to.be.equal(newAssetLiquidateCollateralFactor);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.liquidateCollateralFactor).to.be.equal(newAssetLiquidateCollateralFactor);
  }
);

scenario.only(
  'Configurator#updateAssetLiquidateCollateralFactor succeeds if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetLiquidateCollateralFactor = assetConfig.liquidateCollateralFactor;
    const newAssetLiquidateCollateralFactor = oldAssetLiquidateCollateralFactor + MIN_FACTOR_INCREMENT;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .updateAssetLiquidateCollateralFactor(comet.address, assetConfig.asset, newAssetLiquidateCollateralFactor, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidateCollateralFactor
    ).to.be.equal(newAssetLiquidateCollateralFactor);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.liquidateCollateralFactor).to.be.equal(newAssetLiquidateCollateralFactor);
  }
);

scenario.only(
  'Configurator#updateAssetLiquidateCollateralFactor reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const assetConfigs = (await configurator.getConfiguration(comet.address)).assetConfigs;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .updateAssetLiquidateCollateralFactor(comet.address, assetConfigs.at(-1).asset, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#updateAssetLiquidateCollateralFactor reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const nonExistingAsset = '0x' + '1199'.repeat(10);

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, nonExistingAsset, 1n),
      'AssetDoesNotExist()'
    );
  }
);

scenario.only(
  'Configurator#updateAssetLiquidationFactor succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetLiquidationFactor = assetConfig.liquidationFactor;
    const newAssetLiquidationFactor = oldAssetLiquidationFactor + MIN_FACTOR_INCREMENT;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetLiquidationFactor(comet.address, assetConfig.asset, newAssetLiquidationFactor, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidationFactor
    ).to.be.equal(newAssetLiquidationFactor);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.liquidationFactor).to.be.equal(newAssetLiquidationFactor);
  }
);

scenario.only(
  'Configurator#updateAssetLiquidationFactor succeeds if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);
    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetLiquidationFactor = assetConfig.liquidationFactor;
    const newAssetLiquidationFactor = oldAssetLiquidationFactor + MIN_FACTOR_INCREMENT;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .updateAssetLiquidationFactor(comet.address, assetConfig.asset, newAssetLiquidationFactor, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidationFactor
    ).to.be.equal(newAssetLiquidationFactor);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.liquidationFactor).to.be.equal(newAssetLiquidationFactor);
  }
);

scenario.only(
  'Configurator#updateAssetLiquidationFactor reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const assetConfigs = (await configurator.getConfiguration(comet.address)).assetConfigs;

    await expectRevertCustom(
      configurator.connect(albert.signer).updateAssetLiquidationFactor(comet.address, assetConfigs.at(-1).asset, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#updateAssetLiquidationFactor reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const nonExistingAsset = '0x' + '1199'.repeat(10);

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, nonExistingAsset, 1n),
      'AssetDoesNotExist()'
    );
  }
);

scenario.only(
  'Configurator#updateAssetSupplyCap succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetSupplyCap = assetConfig.supplyCap;
    const newAssetSupplyCap = oldAssetSupplyCap + getMinSupplyCapIncrement(assetConfig);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetSupplyCap(comet.address, assetConfig.asset, newAssetSupplyCap, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(newAssetSupplyCap);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.supplyCap).to.be.equal(newAssetSupplyCap);
  }
);

scenario.only(
  'Configurator#updateAssetSupplyCap disables asset if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const newAssetSupplyCap = 0n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetSupplyCap(comet.address, assetConfig.asset, newAssetSupplyCap, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(newAssetSupplyCap);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.supplyCap).to.be.equal(newAssetSupplyCap);
  }
);

scenario.only(
  'Configurator#updateAssetSupplyCap succeeds if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);
    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetSupplyCap = assetConfig.supplyCap;
    const newAssetSupplyCap = oldAssetSupplyCap + getMinSupplyCapIncrement(assetConfig);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .updateAssetSupplyCap(comet.address, assetConfig.asset, newAssetSupplyCap, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(newAssetSupplyCap);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.supplyCap).to.be.equal(newAssetSupplyCap);
  }
);

scenario.only(
  'Configurator#updateAssetSupplyCap disables asset if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);
    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const newAssetSupplyCap = 0n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(marketAdminSigner)
      .updateAssetSupplyCap(comet.address, assetConfig.asset, newAssetSupplyCap, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(newAssetSupplyCap);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.supplyCap).to.be.equal(newAssetSupplyCap);
  }
);

scenario.only(
  'Configurator#updateAssetSupplyCap reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const assetConfigs = (await configurator.getConfiguration(comet.address)).assetConfigs;

    await expectRevertCustom(
      configurator.connect(albert.signer).updateAssetSupplyCap(comet.address, assetConfigs.at(-1).asset, 1n),
      'Unauthorized()'
    );
  }
);

scenario.only(
  'Configurator#updateAssetSupplyCap reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const nonExistingAsset = '0x' + '1199'.repeat(10);

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAssetSupplyCap(comet.address, nonExistingAsset, 1n),
      'AssetDoesNotExist()'
    );
  }
);
