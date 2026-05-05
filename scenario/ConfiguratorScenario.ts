import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { expectRevertCustom, supportsMarketAdminPermissionChecker } from './utils';
import { MarketAdminPermissionChecker__factory, CometFactoryWithExtendedAssetList__factory } from '../build/types';

import { exp } from '../test/helpers';

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

/**
 * Hybrid array-objects with both numeric and named keys are stripped to plain
 * objects with native bigint values, safe to destructure, compare, and serialize.
 */
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

/// Finds the first asset with non-zero configuration values
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

async function deployMockPriceFeed(context: CometContext): Promise<string> {
  const dm = context.world.deploymentManager;
  const PRICE_FEED_DECIMALS = 8;
  const PRICE_FEED_ANSWER = 1 * 10 ** PRICE_FEED_DECIMALS;

  const priceFeed = await dm.deploy(
    'mock:priceFeed',
    'test/SimplePriceFeed.sol',
    [PRICE_FEED_ANSWER, PRICE_FEED_DECIMALS],
    true
  );

  return priceFeed.address;
}

function getMinSupplyCapIncrement(assetConfig: { supplyCap: bigint; decimals: number }): bigint {
  return 10n ** BigInt(assetConfig.decimals);
}

/*
|========================================
|       Governor-Only Functions
|========================================
*/
scenario(
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

scenario(
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

scenario(
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

scenario(
  'Configurator#transferGovernor reverts if called by non-governor',
  {},
  async ({ configurator, actors }) => {
    const { albert } = actors;

    await expectRevertCustom(configurator.connect(albert.signer).transferGovernor(albert.address), 'Unauthorized()');
  }
);

scenario(
  'Configurator#setFactory updates factory if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const dm = context.world.deploymentManager;

    await context.setNextBaseFeeToZero();
    const newFactory = await dm.deploy(
      'CometFactoryWithExtendedAssetList',
      'CometFactoryWithExtendedAssetList.sol',
      [],
      true
    );

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setFactory(comet.address, newFactory.address, { gasPrice: 0 });

    expect(await configurator.factory(comet.address)).to.be.equal(newFactory.address);
  }
);

scenario(
  'Configurator#setFactory can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const dm = context.world.deploymentManager;

    const firstNewFactory = await dm.deploy(
      'CometFactoryWithExtendedAssetList',
      'CometFactoryWithExtendedAssetList.sol',
      [],
      true
    );
    const secondNewFactory = await dm.deploy(
      'CometFactoryWithExtendedAssetList',
      'CometFactoryWithExtendedAssetList.sol',
      [],
      true
    );

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setFactory(comet.address, firstNewFactory.address, { gasPrice: 0 });

    expect(await configurator.factory(comet.address)).to.be.equal(firstNewFactory.address);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setFactory(comet.address, secondNewFactory.address, { gasPrice: 0 });

    expect(await configurator.factory(comet.address)).to.be.equal(secondNewFactory.address);
  }
);

scenario(
  'Configurator#setFactory reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;

    const dm = context.world.deploymentManager;

    await context.setNextBaseFeeToZero();
    const newFactory = await dm.deploy(
      'CometFactoryWithExtendedAssetList',
      'CometFactoryWithExtendedAssetList.sol',
      [],
      true
    );

    await expectRevertCustom(
      configurator.connect(albert.signer).setFactory(comet.address, newFactory.address),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setConfiguration updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const newCometProxy = '0x' + '1234'.repeat(10); // @todo change to a valid contract
    // use the existing configuration from the current comet as a base
    const existingConfiguration = normalizeStructOutput(await configurator.getConfiguration(comet.address));
    const newConfiguration = {
      ...existingConfiguration,
      baseToken: '0x' + '4321'.repeat(10)
    };

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setConfiguration(newCometProxy, newConfiguration, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(newCometProxy))).to.be.deep.equal(
      newConfiguration
    );
  }
);

scenario(
  'Configurator#setConfiguration reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const newCometProxy = '0x' + '1234'.repeat(10); // @todo change to a valid contract
    // use the existing configuration from the current comet as a base
    const existingConfiguration = normalizeStructOutput(await configurator.getConfiguration(comet.address));
    const newConfiguration = {
      ...existingConfiguration,
      baseToken: '0x' + '4321'.repeat(10)
    };

    await expectRevertCustom(
      configurator.connect(albert.signer).setConfiguration(newCometProxy, newConfiguration),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setConfiguration reverts if configuration already exists for comet proxy',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    // use the existing configuration from the current comet as a base
    const existingConfiguration = normalizeStructOutput(await configurator.getConfiguration(comet.address));
    const newConfiguration = {
      ...existingConfiguration,
      baseToken: '0x' + '4321'.repeat(10)
    };

    await expectRevertCustom(
      configurator.connect(admin.signer).setConfiguration(comet.address, newConfiguration),
      'ConfigurationAlreadyExists()'
    );
  }
);

scenario(
  'Configurator#setGovernor updates governor in configuration if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const newGovernor = '0x' + '1234'.repeat(10); // @todo change to a valid contract
    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setGovernor(comet.address, newGovernor, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).governor).to.be.equal(newGovernor);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect(await comet.governor()).to.be.equal(newGovernor);
  }
);

scenario(
  'Configurator#setGovernor can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewGovernor = '0x' + '1234'.repeat(10); // @todo change to a valid contract
    const secondNewGovernor = '0x' + '5678'.repeat(10); // @todo change to a valid contract

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setGovernor(comet.address, firstNewGovernor, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).governor).to.be.equal(firstNewGovernor);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setGovernor(comet.address, secondNewGovernor, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).governor).to.be.equal(secondNewGovernor);
  }
);

scenario(
  'Configurator#setGovernor reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const newGovernor = '0x' + '1234'.repeat(10); // @todo change to a valid contract

    await expectRevertCustom(
      configurator.connect(albert.signer).setGovernor(comet.address, newGovernor),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setPauseGuardian updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const newPauseGuardian = '0x' + '1234'.repeat(10); // @todo change to a valid contract
    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setPauseGuardian(comet.address, newPauseGuardian, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).pauseGuardian).to.be.equal(newPauseGuardian);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect(await comet.pauseGuardian()).to.be.equal(newPauseGuardian);
  }
);

scenario(
  'Configurator#setPauseGuardian can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewPauseGuardian = '0x' + '1234'.repeat(10); // @todo change to a valid contract
    const secondNewPauseGuardian = '0x' + '5678'.repeat(10); // @todo change to a valid contract

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setPauseGuardian(comet.address, firstNewPauseGuardian, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).pauseGuardian).to.be.equal(firstNewPauseGuardian);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setPauseGuardian(comet.address, secondNewPauseGuardian, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).pauseGuardian).to.be.equal(secondNewPauseGuardian);
  }
);

scenario(
  'Configurator#setPauseGuardian reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const newPauseGuardian = '0x' + '1234'.repeat(10); // @todo change to a valid contract

    await expectRevertCustom(
      configurator.connect(albert.signer).setPauseGuardian(comet.address, newPauseGuardian),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setMarketAdminPermissionChecker updates value if called by governor',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ configurator, actors }) => {
    const { admin } = actors;

    const newMarketAdminPermissionChecker = '0x' + '1234'.repeat(10); // @todo change to a valid contract
    await configurator.connect(admin.signer).setMarketAdminPermissionChecker(newMarketAdminPermissionChecker, {
      gasPrice: 0
    });

    expect(await configurator.marketAdminPermissionChecker()).to.be.equal(newMarketAdminPermissionChecker);
  }
);

scenario(
  'Configurator#setMarketAdminPermissionChecker can be overwritten multiple times',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewMarketAdminPermissionChecker = '0x' + '1234'.repeat(10); // @todo change to a valid contract
    const secondNewMarketAdminPermissionChecker = '0x' + '5678'.repeat(10); // @todo change to a valid contract

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

scenario(
  'Configurator#setMarketAdminPermissionChecker reverts if called by non-governor',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ configurator, actors }) => {
    const { albert } = actors;

    const newMarketAdminPermissionChecker = '0x' + '1234'.repeat(10); // @todo change to a valid contract

    await expectRevertCustom(
      configurator.connect(albert.signer).setMarketAdminPermissionChecker(newMarketAdminPermissionChecker),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setBaseTokenPriceFeed updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const newPriceFeed = await deployMockPriceFeed(context);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseTokenPriceFeed(comet.address, newPriceFeed, {
      gasPrice: 0
    });

    expect((await configurator.getConfiguration(comet.address)).baseTokenPriceFeed).to.be.equal(newPriceFeed);

    await context.setNextBaseFeeToZero();
    await admin.deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

    expect(await comet.baseTokenPriceFeed()).to.be.equal(newPriceFeed);
  }
);

scenario(
  'Configurator#setBaseTokenPriceFeed can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewPriceFeed = await deployMockPriceFeed(context);
    const secondNewPriceFeed = await deployMockPriceFeed(context);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseTokenPriceFeed(comet.address, firstNewPriceFeed, {
      gasPrice: 0
    });

    expect((await configurator.getConfiguration(comet.address)).baseTokenPriceFeed).to.be.equal(firstNewPriceFeed);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseTokenPriceFeed(comet.address, secondNewPriceFeed, {
      gasPrice: 0
    });

    expect((await configurator.getConfiguration(comet.address)).baseTokenPriceFeed).to.be.equal(secondNewPriceFeed);
  }
);

scenario(
  'Configurator#setBaseTokenPriceFeed reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;

    const newPriceFeed = await deployMockPriceFeed(context);

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseTokenPriceFeed(comet.address, newPriceFeed),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setExtensionDelegate updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const newExtensionDelegate = '0x' + '1234'.repeat(10); // @todo change to a valid contract

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setExtensionDelegate(comet.address, newExtensionDelegate, {
      gasPrice: 0
    });

    expect((await configurator.getConfiguration(comet.address)).extensionDelegate).to.be.equal(newExtensionDelegate);
  }
);

scenario(
  'Configurator#setExtensionDelegate can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewExtensionDelegate = '0x' + '1234'.repeat(10); // @todo change to a valid contract
    const secondNewExtensionDelegate = '0x' + '5678'.repeat(10); // @todo change to a valid contract

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setExtensionDelegate(comet.address, firstNewExtensionDelegate, {
      gasPrice: 0
    });

    expect((await configurator.getConfiguration(comet.address)).extensionDelegate).to.be.equal(
      firstNewExtensionDelegate
    );

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setExtensionDelegate(comet.address, secondNewExtensionDelegate, {
      gasPrice: 0
    });

    expect((await configurator.getConfiguration(comet.address)).extensionDelegate).to.be.equal(
      secondNewExtensionDelegate
    );
  }
);

scenario(
  'Configurator#setExtensionDelegate reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const newExtensionDelegate = '0x' + '1234'.repeat(10); // @todo change to a valid contract

    await expectRevertCustom(
      configurator.connect(albert.signer).setExtensionDelegate(comet.address, newExtensionDelegate),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setStoreFrontPriceFactor updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldStoreFrontPriceFactor = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).storeFrontPriceFactor;

    const newStoreFrontPriceFactor = oldStoreFrontPriceFactor + 1n;
    await context.setNextBaseFeeToZero();
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
scenario(
  'Configurator#setStoreFrontPriceFactor can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const initialStoreFrontPriceFactor = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).storeFrontPriceFactor;

    const firstStoreFrontPriceFactor = initialStoreFrontPriceFactor + 1n;
    const secondStoreFrontPriceFactor = firstStoreFrontPriceFactor + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setStoreFrontPriceFactor(comet.address, firstStoreFrontPriceFactor, {
      gasPrice: 0
    });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).storeFrontPriceFactor).to.be.equal(
      firstStoreFrontPriceFactor
    );

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setStoreFrontPriceFactor(comet.address, secondStoreFrontPriceFactor, {
      gasPrice: 0
    });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).storeFrontPriceFactor).to.be.equal(
      secondStoreFrontPriceFactor
    );
  }
);

scenario(
  'Configurator#setStoreFrontPriceFactor reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldStoreFrontPriceFactor = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).storeFrontPriceFactor;

    const newStoreFrontPriceFactor = oldStoreFrontPriceFactor + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setStoreFrontPriceFactor(comet.address, newStoreFrontPriceFactor),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#setBaseMinForRewards can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const initialBaseMinForRewards = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseMinForRewards;

    const firstBaseMinForRewards = initialBaseMinForRewards + 1n;
    const secondBaseMinForRewards = firstBaseMinForRewards + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseMinForRewards(comet.address, firstBaseMinForRewards, {
      gasPrice: 0
    });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseMinForRewards).to.be.equal(
      firstBaseMinForRewards
    );

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseMinForRewards(comet.address, secondBaseMinForRewards, {
      gasPrice: 0
    });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseMinForRewards).to.be.equal(
      secondBaseMinForRewards
    );
  }
);

scenario(
  'Configurator#setBaseMinForRewards reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldBaseMinForRewards = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseMinForRewards;

    const newBaseMinForRewards = oldBaseMinForRewards + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseMinForRewards(comet.address, newBaseMinForRewards),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#setTargetReserves can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    const initialTargetReserves = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).targetReserves;

    const firstTargetReserves = initialTargetReserves + 1n;
    const secondTargetReserves = firstTargetReserves + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setTargetReserves(comet.address, firstTargetReserves, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).targetReserves).to.be.equal(
      firstTargetReserves
    );

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setTargetReserves(comet.address, secondTargetReserves, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).targetReserves).to.be.equal(
      secondTargetReserves
    );
  }
);

scenario(
  'Configurator#setTargetReserves reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldTargetReserves = normalizeStructOutput(await configurator.getConfiguration(comet.address)).targetReserves;
    const newTargetReserves = oldTargetReserves + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setTargetReserves(comet.address, newTargetReserves),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#addAsset succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const numAssetsBefore = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs
      .length;

    const newAssetConfig = {
      asset: '0x' + '2211'.repeat(10),
      priceFeed: await deployMockPriceFeed(context),
      decimals: 18,
      borrowCollateralFactor: exp(0.8, 18),
      liquidateCollateralFactor: exp(0.85, 18),
      liquidationFactor: exp(0.9, 18),
      supplyCap: exp(5e6, 18)
    };

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).addAsset(comet.address, newAssetConfig, { gasPrice: 0 });
    const assetConfigsAfter = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs;

    expect(assetConfigsAfter.length).to.be.equal(numAssetsBefore + 1);
    expect(assetConfigsAfter.at(-1)).to.be.deep.equal(newAssetConfig);
  }
);

scenario('Configurator#addAsset can add multiple assets', {}, async ({ comet, configurator, actors }, context) => {
  const { admin } = actors;

  const numAssetsBefore = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.length;

  const firstNewAssetConfig = {
    asset: '0x' + '2211'.repeat(10),
    priceFeed: await deployMockPriceFeed(context),
    decimals: 18,
    borrowCollateralFactor: exp(0.8, 18),
    liquidateCollateralFactor: exp(0.85, 18),
    liquidationFactor: exp(0.9, 18),
    supplyCap: exp(5e6, 18)
  };

  const secondNewAssetConfig = {
    asset: '0x' + '5566'.repeat(10),
    priceFeed: await deployMockPriceFeed(context),
    decimals: 6,
    borrowCollateralFactor: exp(0.8, 18),
    liquidateCollateralFactor: exp(0.85, 18),
    liquidationFactor: exp(0.9, 18),
    supplyCap: exp(5e6, 6)
  };

  await context.setNextBaseFeeToZero();
  await configurator.connect(admin.signer).addAsset(comet.address, firstNewAssetConfig, { gasPrice: 0 });
  await context.setNextBaseFeeToZero();
  await configurator.connect(admin.signer).addAsset(comet.address, secondNewAssetConfig, { gasPrice: 0 });
  const assetConfigsAfter = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs;

  expect(assetConfigsAfter.length).to.be.equal(numAssetsBefore + 2);
  expect(assetConfigsAfter.at(-2)).to.be.deep.equal(firstNewAssetConfig);
  expect(assetConfigsAfter.at(-1)).to.be.deep.equal(secondNewAssetConfig);
});

scenario(
  'Configurator#addAsset reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;

    await expectRevertCustom(
      configurator.connect(albert.signer).addAsset(comet.address, {
        asset: '0x' + '2211'.repeat(10),
        priceFeed: await deployMockPriceFeed(context),
        decimals: 18,
        borrowCollateralFactor: exp(0.8, 18),
        liquidateCollateralFactor: exp(0.85, 18),
        liquidationFactor: exp(0.9, 18),
        supplyCap: exp(5e6, 18)
      }),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#updateAsset can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);

    const firstUpdatedAssetConfig = {
      ...assetConfig,
      liquidateCollateralFactor: assetConfig.liquidateCollateralFactor + MIN_FACTOR_INCREMENT
    };

    const secondUpdatedAssetConfig = {
      ...firstUpdatedAssetConfig,
      borrowCollateralFactor: firstUpdatedAssetConfig.borrowCollateralFactor + MIN_FACTOR_INCREMENT
    };

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).updateAsset(comet.address, firstUpdatedAssetConfig, { gasPrice: 0 });
    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
    ).to.be.deep.equal(firstUpdatedAssetConfig);

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).updateAsset(comet.address, secondUpdatedAssetConfig, { gasPrice: 0 });
    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
    ).to.be.deep.equal(secondUpdatedAssetConfig);
  }
);

scenario(
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

scenario(
  'Configurator#updateAsset reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const existingAssetConfig = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).assetConfigs.at(-1);

    const updatedAssetConfig = {
      ...existingAssetConfig,
      asset: '0x' + '9999'.repeat(10) // non-existing asset address
    };

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAsset(comet.address, updatedAssetConfig),
      'AssetDoesNotExist()'
    );
  }
);

scenario(
  'Configurator#updateAssetPriceFeed succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    // use the last asset in the existing configuration to ensure the asset exists
    const assetIndex = -1;
    const existingAsset = (await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).asset;
    const newPriceFeed = await deployMockPriceFeed(context);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetPriceFeed(comet.address, existingAsset, newPriceFeed, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).priceFeed).to.be.equal(
      newPriceFeed
    );
  }
);

scenario(
  'Configurator#updateAssetPriceFeed can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    // use the last asset in the existing configuration to ensure the asset exists
    const assetIndex = -1;
    const existingAsset = (await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).asset;

    const firstNewPriceFeed = await deployMockPriceFeed(context);
    const secondNewPriceFeed = await deployMockPriceFeed(context);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetPriceFeed(comet.address, existingAsset, firstNewPriceFeed, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).priceFeed).to.be.equal(
      firstNewPriceFeed
    );

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetPriceFeed(comet.address, existingAsset, secondNewPriceFeed, { gasPrice: 0 });

    expect((await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).priceFeed).to.be.equal(
      secondNewPriceFeed
    );
  }
);

scenario(
  'Configurator#updateAssetPriceFeed reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;

    const existingAsset = (await configurator.getConfiguration(comet.address)).assetConfigs.at(-1).asset;
    const newPriceFeed = await deployMockPriceFeed(context);

    await expectRevertCustom(
      configurator.connect(albert.signer).updateAssetPriceFeed(comet.address, existingAsset, newPriceFeed),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#updateAssetPriceFeed reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const nonExistingAsset = '0x' + '1199'.repeat(10);
    const newPriceFeed = await deployMockPriceFeed(context);

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

scenario(
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

scenario(
  'Configurator#setSupplyKink can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldSupplyKink = normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyKink;
    const firstNewSupplyKink = oldSupplyKink + 1n;
    const secondNewSupplyKink = firstNewSupplyKink + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setSupplyKink(comet.address, firstNewSupplyKink, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyKink).to.be.equal(
      firstNewSupplyKink
    );

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setSupplyKink(comet.address, secondNewSupplyKink, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyKink).to.be.equal(
      secondNewSupplyKink
    );
  }
);

scenario(
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

scenario(
  'Configurator#setSupplyKink reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldSupplyKink = normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyKink;
    const newSupplyKink = oldSupplyKink + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setSupplyKink(comet.address, newSupplyKink),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeLow can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateSlopeLow;

    const firstNewSupplyPerYearInterestRateSlopeLow = oldSupplyPerYearInterestRateSlopeLow + 1n;
    const secondNewSupplyPerYearInterestRateSlopeLow = firstNewSupplyPerYearInterestRateSlopeLow + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeLow(comet.address, firstNewSupplyPerYearInterestRateSlopeLow, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeLow
    ).to.be.equal(firstNewSupplyPerYearInterestRateSlopeLow);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeLow(comet.address, secondNewSupplyPerYearInterestRateSlopeLow, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeLow
    ).to.be.equal(secondNewSupplyPerYearInterestRateSlopeLow);
  }
);

scenario(
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

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeLow reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldSupplyPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateSlopeLow;

    const newSupplyPerYearInterestRateSlopeLow = oldSupplyPerYearInterestRateSlopeLow + 1n;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .setSupplyPerYearInterestRateSlopeLow(comet.address, newSupplyPerYearInterestRateSlopeLow),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeHigh can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateSlopeHigh;

    const firstNewSupplyPerYearInterestRateSlopeHigh = oldSupplyPerYearInterestRateSlopeHigh + 1n;
    const secondNewSupplyPerYearInterestRateSlopeHigh = firstNewSupplyPerYearInterestRateSlopeHigh + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeHigh(comet.address, firstNewSupplyPerYearInterestRateSlopeHigh, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeHigh
    ).to.be.equal(firstNewSupplyPerYearInterestRateSlopeHigh);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeHigh(comet.address, secondNewSupplyPerYearInterestRateSlopeHigh, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeHigh
    ).to.be.equal(secondNewSupplyPerYearInterestRateSlopeHigh);
  }
);

scenario(
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

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeHigh reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldSupplyPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateSlopeHigh;

    const newSupplyPerYearInterestRateSlopeHigh = oldSupplyPerYearInterestRateSlopeHigh + 1n;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .setSupplyPerYearInterestRateSlopeHigh(comet.address, newSupplyPerYearInterestRateSlopeHigh),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#setSupplyPerYearInterestRateBase can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateBase;

    const firstNewSupplyPerYearInterestRateBase = oldSupplyPerYearInterestRateBase + 1n;
    const secondNewSupplyPerYearInterestRateBase = firstNewSupplyPerYearInterestRateBase + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateBase(comet.address, firstNewSupplyPerYearInterestRateBase, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateBase
    ).to.be.equal(firstNewSupplyPerYearInterestRateBase);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateBase(comet.address, secondNewSupplyPerYearInterestRateBase, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateBase
    ).to.be.equal(secondNewSupplyPerYearInterestRateBase);
  }
);

scenario(
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

scenario(
  'Configurator#setSupplyPerYearInterestRateBase reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldSupplyPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateBase;

    const newSupplyPerYearInterestRateBase = oldSupplyPerYearInterestRateBase + 1n;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .setSupplyPerYearInterestRateBase(comet.address, newSupplyPerYearInterestRateBase),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#setBorrowKink can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBorrowKink = normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowKink;
    const firstNewBorrowKink = oldBorrowKink + 1n;
    const secondNewBorrowKink = firstNewBorrowKink + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBorrowKink(comet.address, firstNewBorrowKink, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowKink).to.be.equal(
      firstNewBorrowKink
    );

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBorrowKink(comet.address, secondNewBorrowKink, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowKink).to.be.equal(
      secondNewBorrowKink
    );
  }
);

scenario(
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

scenario(
  'Configurator#setBorrowKink reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldBorrowKink = normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowKink;
    const newBorrowKink = oldBorrowKink + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBorrowKink(comet.address, newBorrowKink),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeLow can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateSlopeLow;

    const firstNewBorrowPerYearInterestRateSlopeLow = oldBorrowPerYearInterestRateSlopeLow + 1n;
    const secondNewBorrowPerYearInterestRateSlopeLow = firstNewBorrowPerYearInterestRateSlopeLow + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeLow(comet.address, firstNewBorrowPerYearInterestRateSlopeLow, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeLow
    ).to.be.equal(firstNewBorrowPerYearInterestRateSlopeLow);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeLow(comet.address, secondNewBorrowPerYearInterestRateSlopeLow, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeLow
    ).to.be.equal(secondNewBorrowPerYearInterestRateSlopeLow);
  }
);

scenario(
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

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeLow reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldBorrowPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateSlopeLow;

    const newBorrowPerYearInterestRateSlopeLow = oldBorrowPerYearInterestRateSlopeLow + 1n;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .setBorrowPerYearInterestRateSlopeLow(comet.address, newBorrowPerYearInterestRateSlopeLow),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeHigh can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateSlopeHigh;

    const firstNewBorrowPerYearInterestRateSlopeHigh = oldBorrowPerYearInterestRateSlopeHigh + 1n;
    const secondNewBorrowPerYearInterestRateSlopeHigh = oldBorrowPerYearInterestRateSlopeHigh + 2n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeHigh(comet.address, firstNewBorrowPerYearInterestRateSlopeHigh, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeHigh
    ).to.be.equal(firstNewBorrowPerYearInterestRateSlopeHigh);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeHigh(comet.address, secondNewBorrowPerYearInterestRateSlopeHigh, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeHigh
    ).to.be.equal(secondNewBorrowPerYearInterestRateSlopeHigh);
  }
);

scenario(
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

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeHigh reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldBorrowPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateSlopeHigh;

    const newBorrowPerYearInterestRateSlopeHigh = oldBorrowPerYearInterestRateSlopeHigh + 1n;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .setBorrowPerYearInterestRateSlopeHigh(comet.address, newBorrowPerYearInterestRateSlopeHigh),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#setBorrowPerYearInterestRateBase can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateBase;

    const firstNewBorrowPerYearInterestRateBase = oldBorrowPerYearInterestRateBase + 1n;
    const secondNewBorrowPerYearInterestRateBase = firstNewBorrowPerYearInterestRateBase + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateBase(comet.address, firstNewBorrowPerYearInterestRateBase, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateBase
    ).to.be.equal(firstNewBorrowPerYearInterestRateBase);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateBase(comet.address, secondNewBorrowPerYearInterestRateBase, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateBase
    ).to.be.equal(secondNewBorrowPerYearInterestRateBase);
  }
);

scenario(
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

scenario(
  'Configurator#setBorrowPerYearInterestRateBase reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldBorrowPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateBase;

    const newBorrowPerYearInterestRateBase = oldBorrowPerYearInterestRateBase + 1n;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .setBorrowPerYearInterestRateBase(comet.address, newBorrowPerYearInterestRateBase),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#setBaseTrackingSupplySpeed can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBaseTrackingSupplySpeed = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseTrackingSupplySpeed;

    const firstNewBaseTrackingSupplySpeed = oldBaseTrackingSupplySpeed + 1n;
    const secondNewBaseTrackingSupplySpeed = firstNewBaseTrackingSupplySpeed + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setBaseTrackingSupplySpeed(comet.address, firstNewBaseTrackingSupplySpeed, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingSupplySpeed
    ).to.be.equal(firstNewBaseTrackingSupplySpeed);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setBaseTrackingSupplySpeed(comet.address, secondNewBaseTrackingSupplySpeed, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingSupplySpeed
    ).to.be.equal(secondNewBaseTrackingSupplySpeed);
  }
);

scenario(
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

scenario(
  'Configurator#setBaseTrackingSupplySpeed reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldBaseTrackingSupplySpeed = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseTrackingSupplySpeed;

    const newBaseTrackingSupplySpeed = oldBaseTrackingSupplySpeed + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseTrackingSupplySpeed(comet.address, newBaseTrackingSupplySpeed),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#setBaseTrackingBorrowSpeed can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBaseTrackingBorrowSpeed = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseTrackingBorrowSpeed;

    const firstNewBaseTrackingBorrowSpeed = oldBaseTrackingBorrowSpeed + 1n;
    const secondNewBaseTrackingBorrowSpeed = firstNewBaseTrackingBorrowSpeed + 1n;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setBaseTrackingBorrowSpeed(comet.address, firstNewBaseTrackingBorrowSpeed, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingBorrowSpeed
    ).to.be.equal(firstNewBaseTrackingBorrowSpeed);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .setBaseTrackingBorrowSpeed(comet.address, secondNewBaseTrackingBorrowSpeed, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingBorrowSpeed
    ).to.be.equal(secondNewBaseTrackingBorrowSpeed);
  }
);

scenario(
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

scenario(
  'Configurator#setBaseTrackingBorrowSpeed reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldBaseTrackingBorrowSpeed = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseTrackingBorrowSpeed;

    const newBaseTrackingBorrowSpeed = oldBaseTrackingBorrowSpeed + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseTrackingBorrowSpeed(comet.address, newBaseTrackingBorrowSpeed),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#setBaseBorrowMin can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const oldBaseBorrowMin = normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseBorrowMin;
    const firstNewBaseBorrowMin = oldBaseBorrowMin + 1n;
    const secondNewBaseBorrowMin = firstNewBaseBorrowMin + 1n;

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseBorrowMin(comet.address, firstNewBaseBorrowMin, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseBorrowMin).to.be.equal(
      firstNewBaseBorrowMin
    );

    await context.setNextBaseFeeToZero();
    await configurator.connect(admin.signer).setBaseBorrowMin(comet.address, secondNewBaseBorrowMin, { gasPrice: 0 });

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseBorrowMin).to.be.equal(
      secondNewBaseBorrowMin
    );
  }
);

scenario(
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

scenario(
  'Configurator#setBaseBorrowMin reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldBaseBorrowMin = normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseBorrowMin;
    const newBaseBorrowMin = oldBaseBorrowMin + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseBorrowMin(comet.address, newBaseBorrowMin),
      'Unauthorized()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#updateAssetBorrowCollateralFactor can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetBorrowCollateralFactor = assetConfig.borrowCollateralFactor;
    const firstNewAssetBorrowCollateralFactor = oldAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;
    const secondNewAssetBorrowCollateralFactor = firstNewAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, firstNewAssetBorrowCollateralFactor, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(firstNewAssetBorrowCollateralFactor);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, secondNewAssetBorrowCollateralFactor, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(secondNewAssetBorrowCollateralFactor);
  }
);

scenario(
  'Configurator#updateAssetBorrowCollateralFactor disables asset if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const newAssetBorrowCollateralFactor = 0n;

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

scenario(
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

scenario(
  'Configurator#updateAssetBorrowCollateralFactor disables asset if called by market-admin',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);
    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const newAssetBorrowCollateralFactor = 0n;

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

scenario(
  'Configurator#updateAssetBorrowCollateralFactor reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;

    const { assetConfig } = await getActiveAsset(context);
    const oldAssetBorrowCollateralFactor = assetConfig.borrowCollateralFactor;
    const newAssetBorrowCollateralFactor = oldAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, newAssetBorrowCollateralFactor),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#updateAssetBorrowCollateralFactor reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    // use the existing config to get a valid factor value
    const { assetConfig } = await getActiveAsset(context);
    const oldAssetBorrowCollateralFactor = assetConfig.borrowCollateralFactor;
    const newAssetBorrowCollateralFactor = oldAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;

    const nonExistingAsset = '0x' + '1199'.repeat(10);

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, nonExistingAsset, newAssetBorrowCollateralFactor),
      'AssetDoesNotExist()'
    );
  }
);

scenario(
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

scenario(
  'Configurator#updateAssetLiquidateCollateralFactor can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetLiquidateCollateralFactor = assetConfig.liquidateCollateralFactor;
    const firstNewAssetLiquidateCollateralFactor = oldAssetLiquidateCollateralFactor + MIN_FACTOR_INCREMENT;
    const secondNewAssetLiquidateCollateralFactor = firstNewAssetLiquidateCollateralFactor + MIN_FACTOR_INCREMENT;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetLiquidateCollateralFactor(comet.address, assetConfig.asset, firstNewAssetLiquidateCollateralFactor, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidateCollateralFactor
    ).to.be.equal(firstNewAssetLiquidateCollateralFactor);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetLiquidateCollateralFactor(comet.address, assetConfig.asset, secondNewAssetLiquidateCollateralFactor, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidateCollateralFactor
    ).to.be.equal(secondNewAssetLiquidateCollateralFactor);
  }
);

scenario(
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

scenario(
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

scenario(
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

scenario(
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

scenario(
  'Configurator#updateAssetLiquidationFactor can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetLiquidationFactor = assetConfig.liquidationFactor;
    const firstNewAssetLiquidationFactor = oldAssetLiquidationFactor + MIN_FACTOR_INCREMENT;
    const secondNewAssetLiquidationFactor = firstNewAssetLiquidationFactor + MIN_FACTOR_INCREMENT;

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetLiquidationFactor(comet.address, assetConfig.asset, firstNewAssetLiquidationFactor, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidationFactor
    ).to.be.equal(firstNewAssetLiquidationFactor);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetLiquidationFactor(comet.address, assetConfig.asset, secondNewAssetLiquidationFactor, {
        gasPrice: 0
      });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidationFactor
    ).to.be.equal(secondNewAssetLiquidationFactor);
  }
);

scenario(
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

scenario(
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

scenario(
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

scenario(
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

scenario(
  'Configurator#updateAssetSupplyCap can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetSupplyCap = assetConfig.supplyCap;
    const firstNewAssetSupplyCap = oldAssetSupplyCap + getMinSupplyCapIncrement(assetConfig);
    const secondNewAssetSupplyCap = firstNewAssetSupplyCap + getMinSupplyCapIncrement(assetConfig);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetSupplyCap(comet.address, assetConfig.asset, firstNewAssetSupplyCap, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(firstNewAssetSupplyCap);

    await context.setNextBaseFeeToZero();
    await configurator
      .connect(admin.signer)
      .updateAssetSupplyCap(comet.address, assetConfig.asset, secondNewAssetSupplyCap, { gasPrice: 0 });

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(secondNewAssetSupplyCap);
  }
);

scenario(
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

scenario(
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

scenario(
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

scenario(
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

scenario(
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
