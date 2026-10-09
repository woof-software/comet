import { expect } from 'chai';
import { ethers } from 'ethers';
import type { Signer } from 'ethers';
import type { CometContext } from './context/CometContext.js';
import { scenario } from './context/CometContext.js';
import { exp } from '../test/helpers.js';
import { expectRevertCustom, setEtherBalance, supportsMarketAdminPermissionChecker } from './utils/index.js';
import { MarketAdminPermissionChecker__factory } from '../build/types/index.js';
import { SECONDS_PER_YEAR } from './utils/constants.js';

// Based on contract's internal precision: FACTOR_SCALE=1e18 with 4 decimal places
const FACTOR_SCALE = 10n ** 18n;
const MIN_FACTOR_INCREMENT = FACTOR_SCALE / 10n ** 4n;

type ArrayMethods = keyof Omit<any[], number>;

type NamedKeys<T> = {
  [K in keyof T as K extends number | `${number}` | ArrayMethods ? never : K]: T[K];
};

type Normalize<T> = T extends string | number | boolean | bigint
  ? T
  : [NamedKeys<T>] extends [Record<string, never>]
  ? T extends (infer U)[]
    ? Normalize<U>[]
    : T
  : { [K in keyof NamedKeys<T>]: Normalize<NamedKeys<T>[K]> };

type NormalizedStruct<T> = Normalize<NamedKeys<T>>;

/**
 * Hybrid array-objects with both numeric and named keys are stripped to plain
 * objects with native bigint values, safe to destructure and compare.
 */
function normalizeStructOutput<T>(value: T): NormalizedStruct<T> {
  function normalize(val: any): any {
    if (val && typeof val.toObject === 'function') {
      if (val.length === 0) return [];
      // Named struct fields are not enumerable on ethers v6 Results.
      try {
        return normalize(val.toObject());
      } catch (error) {
        // Unnamed Results represent arrays rather than structs.
        if (!ethers.isError(error, 'UNSUPPORTED_OPERATION')) throw error;
        return Array.from(val, normalize);
      }
    }
    if (val && typeof val === 'object') {
      const namedKeys = Object.keys(val).filter((key) => isNaN(Number(key)));
      if (namedKeys.length > 0) {
        return Object.fromEntries(namedKeys.map((key) => [key, normalize(val[key])]));
      }
      if (Array.isArray(val)) {
        return Array.from(val, normalize);
      }
    }
    return val;
  }

  return normalize(value) as NormalizedStruct<T>;
}

async function hasActiveAsset(ctx: CometContext): Promise<boolean> {
  const configurator = await ctx.getConfigurator();
  const cometAddress = await (await ctx.getComet()).getAddress();
  const assetConfigs = normalizeStructOutput(await configurator.getConfiguration(cometAddress)).assetConfigs;

  return assetConfigs.some((asset) => asset.borrowCollateralFactor > 0n && asset.supplyCap > 0n);
}

/// Finds the first asset with non-zero configuration values
async function getActiveAsset(context: CometContext) {
  const configurator = await context.getConfigurator();
  const cometAddress = await (await context.getComet()).getAddress();
  const assetConfigs = normalizeStructOutput(await configurator.getConfiguration(cometAddress)).assetConfigs;

  const assetIndex = assetConfigs.findIndex((asset) => asset.borrowCollateralFactor > 0n && asset.supplyCap > 0n);

  return {
    assetIndex,
    assetConfig: assetConfigs[assetIndex]
  };
}

function getMinSupplyCapIncrement(decimals: bigint): bigint {
  return 10n ** decimals;
}

async function getMarketAdminSigner(context: CometContext): Promise<Signer> {
  const dm = context.world.deploymentManager;
  const configurator = await context.getConfigurator();

  const marketAdminPermissionChecker = MarketAdminPermissionChecker__factory.connect(
    await configurator.marketAdminPermissionChecker(),
    configurator.runner
  );

  const marketAdmin = await marketAdminPermissionChecker.marketAdmin();
  const marketAdminSigner = await context.world.impersonateAddress(marketAdmin);
  await setEtherBalance(dm, marketAdmin, exp(1, 18));
  return marketAdminSigner;
}

async function deployMarketAdminPermissionChecker(context: CometContext, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;
  const initialOwner = await ethers.Wallet.createRandom().getAddress();
  const marketAdmin = await ethers.Wallet.createRandom().getAddress();
  const marketAdminPauseGuardian = await ethers.Wallet.createRandom().getAddress();

  const marketAdminPermissionChecker = await dm.deploy(
    'test:marketAdminPermissionChecker',
    'marketupdates/MarketAdminPermissionChecker.sol',
    [initialOwner, marketAdmin, marketAdminPauseGuardian],
    force
  );

  return await marketAdminPermissionChecker.getAddress();
}

async function deployCometFactory(context: CometContext, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;
  const cometFactory = await dm.deploy('test:cometFactory', 'CometFactoryWithExtendedAssetList.sol', [], force);

  return await cometFactory.getAddress();
}

async function deployPriceFeed(context: CometContext, alias: string, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;
  const PRICE_FEED_DECIMALS = 8;
  const PRICE_FEED_ANSWER = 1 * 10 ** PRICE_FEED_DECIMALS;

  const priceFeed = await dm.deploy(
    `test:${alias}PriceFeed`,
    'test/SimplePriceFeed.sol',
    [PRICE_FEED_ANSWER, PRICE_FEED_DECIMALS],
    force
  );

  return await priceFeed.getAddress();
}

async function deployTimelock(context: CometContext, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;
  const admin = context.actors.admin;
  const timelock = await dm.deploy('test:timelock', 'test/SimpleTimelock.sol', [admin.address], force);

  return await timelock.getAddress();
}

async function deployMockERC20(context: CometContext, alias: string, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;

  const mockERC20 = await dm.deploy(
    `mockERC20:${alias}`,
    'capo/contracts/test/MockERC20.sol',
    ['Mock Token', 'MOCK', 18],
    force
  );

  return await mockERC20.getAddress();
}

async function deployCometExt(context: CometContext, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;
  const assetListFactory = await dm.deploy('test:assetListFactory', 'AssetListFactory.sol', []);

  const extConfiguration = {
    name32: ethers.encodeBytes32String('MOCK'),
    symbol32: ethers.encodeBytes32String('cMOCKv3')
  };

  const cometExt = await dm.deploy(
    'test:comet:implementation:implementation',
    'CometExtAssetList.sol',
    [extConfiguration, await assetListFactory.getAddress()],
    force
  );

  return await cometExt.getAddress();
}

async function deployComet(context: CometContext): Promise<string> {
  const dm = context.world.deploymentManager;
  const { admin, pauseGuardian } = context.actors;

  const configuration = {
    governor: admin.address,
    pauseGuardian: pauseGuardian.address,
    baseToken: await deployMockERC20(context, 'baseToken'),
    baseTokenPriceFeed: await deployPriceFeed(context, 'baseToken'),
    extensionDelegate: await deployCometExt(context),
    supplyKink: exp(0.9, 18), // 900000000000000000n
    supplyPerYearInterestRateSlopeLow: exp(0.036, 18), // 36000000000000000n
    supplyPerYearInterestRateSlopeHigh: exp(3.196, 18), // 3196000000000000000n
    supplyPerYearInterestRateBase: 0n,
    borrowKink: exp(0.9, 18), // 900000000000000000n
    borrowPerYearInterestRateSlopeLow: exp(0.027778, 18), // 27778000000000000n
    borrowPerYearInterestRateSlopeHigh: exp(3.6, 18), // 3600000000000000000n
    borrowPerYearInterestRateBase: exp(0.015, 18), // 15000000000000000n
    storeFrontPriceFactor: exp(0.6, 18), // 600000000000000000n
    trackingIndexScale: exp(0.001, 18), // 1000000000000000n
    baseTrackingSupplySpeed: 0n,
    baseTrackingBorrowSpeed: 0n,
    baseMinForRewards: exp(1, 9), // 1000000000n
    baseBorrowMin: exp(1, 5), // 100000n
    targetReserves: exp(2, 13), //20000000000000n
    assetConfigs: [
      {
        asset: await deployMockERC20(context, 'asset'),
        priceFeed: await deployPriceFeed(context, 'asset'),
        decimals: 18n,
        borrowCollateralFactor: exp(0.65, 18), // 650000000000000000n
        liquidateCollateralFactor: exp(0.7, 18), // 700000000000000000n
        liquidationFactor: exp(0.8, 18), // 800000000000000000n
        supplyCap: exp(1.4, 24) // 1400000000000000000000000n
      }
    ]
  };

  const cometAdmin = await context.getCometAdmin();
  const tmpCometImpl = await dm.deploy('test:comet:implementation', 'CometWithExtendedAssetList.sol', [configuration]);

  const cometProxy = await dm.deploy('test:comet', 'vendor/proxy/transparent/TransparentUpgradeableProxy.sol', [
    await tmpCometImpl.getAddress(),
    await cometAdmin.getAddress(),
    '0x'
  ]);

  return await cometProxy.getAddress();
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
    const { admin } = actors;

    const newGovernor = await deployTimelock(context);
    await configurator.connect(admin.signer).transferGovernor(newGovernor);

    expect(await configurator.governor()).to.be.equal(newGovernor);
  }
);

scenario(
  'Configurator#transferGovernor new governor can call governor-only methods',
  {},
  async ({ configurator, actors }, context) => {
    const { admin } = actors;

    const newGovernor = await deployTimelock(context);
    const newGovernorSigner = await context.world.impersonateAddress(newGovernor);
    await setEtherBalance(context.world.deploymentManager, newGovernor, exp(1, 18));

    await configurator.connect(admin.signer).transferGovernor(newGovernor);
    await configurator.connect(newGovernorSigner).transferGovernor(admin.address);

    expect(await configurator.governor()).to.be.equal(admin.address);
  }
);

scenario(
  'Configurator#transferGovernor reverts if called by non-governor',
  {},
  async ({ configurator, actors }, context) => {
    const { albert } = actors;
    const newGovernor = await deployTimelock(context);

    await expectRevertCustom(configurator.connect(albert.signer).transferGovernor(newGovernor), 'Unauthorized()');
  }
);

scenario(
  'Configurator#setFactory updates factory if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const newFactory = await deployCometFactory(context);

    await configurator.connect(admin.signer).setFactory(await comet.getAddress(), newFactory);

    expect(await configurator.factory(await comet.getAddress())).to.be.equal(newFactory);
  }
);

scenario(
  'Configurator#setFactory can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewFactory = await deployCometFactory(context);
    const secondNewFactory = await deployCometFactory(context, true);

    await configurator.connect(admin.signer).setFactory(await comet.getAddress(), firstNewFactory);

    expect(await configurator.factory(await comet.getAddress())).to.be.equal(firstNewFactory);

    await configurator.connect(admin.signer).setFactory(await comet.getAddress(), secondNewFactory);

    expect(await configurator.factory(await comet.getAddress())).to.be.equal(secondNewFactory);
  }
);

scenario(
  'Configurator#setFactory reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;
    const newFactory = await deployCometFactory(context);

    await expectRevertCustom(
      configurator.connect(albert.signer).setFactory(await comet.getAddress(), newFactory),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setConfiguration updates existing configuration if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    const existingConfiguration = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress()));

    const updatedConfiguration = {
      ...existingConfiguration,
      baseBorrowMin: existingConfiguration.baseBorrowMin + 1n
    };

    await configurator.connect(admin.signer).setConfiguration(await comet.getAddress(), updatedConfiguration);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress()))).to.be.deep.equal(
      updatedConfiguration
    );
  }
);

scenario(
  'Configurator#setConfiguration initializes new comet proxy configuration',
  {},
  async ({ configurator, actors }, context) => {
    const { admin } = actors;
    const newCometProxy = await deployComet(context);
    const configuration = normalizeStructOutput(await configurator.getConfiguration(newCometProxy));

    await configurator.connect(admin.signer).setConfiguration(newCometProxy, configuration);

    expect(normalizeStructOutput(await configurator.getConfiguration(newCometProxy))).to.be.deep.equal(configuration);
  }
);

scenario(
  'Configurator#setConfiguration reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const existingConfiguration = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress()));

    const updatedConfiguration = {
      ...existingConfiguration,
      baseBorrowMin: existingConfiguration.baseBorrowMin + 1n
    };
    await expectRevertCustom(
      configurator.connect(albert.signer).setConfiguration(await comet.getAddress(), updatedConfiguration),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setConfiguration reverts if base token is changed for existing configuration',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    const existingConfiguration = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress()));

    const updatedConfiguration = {
      ...existingConfiguration,
      baseToken: await deployMockERC20(context, 'baseToken')
    };

    await expectRevertCustom(
      configurator.connect(admin.signer).setConfiguration(await comet.getAddress(), updatedConfiguration),
      'ConfigurationAlreadyExists()'
    );
  }
);

scenario(
  'Configurator#setConfiguration reverts if tracking index scale is changed for existing configuration',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    const existingConfiguration = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress()));

    const updatedConfiguration = {
      ...existingConfiguration,
      trackingIndexScale: existingConfiguration.trackingIndexScale + 1n
    };

    await expectRevertCustom(
      configurator.connect(admin.signer).setConfiguration(await comet.getAddress(), updatedConfiguration),
      'ConfigurationAlreadyExists()'
    );
  }
);

scenario(
  'Configurator#setGovernor updates governor in configuration if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const newGovernor = await deployTimelock(context);
    await configurator.connect(admin.signer).setGovernor(await comet.getAddress(), newGovernor);

    expect((await configurator.getConfiguration(await comet.getAddress())).governor).to.be.equal(newGovernor);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.governor()).to.be.equal(newGovernor);
  }
);

scenario(
  'Configurator#setGovernor can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewGovernor = await deployTimelock(context);
    const secondNewGovernor = await deployTimelock(context, true);

    await configurator.connect(admin.signer).setGovernor(await comet.getAddress(), firstNewGovernor);

    expect((await configurator.getConfiguration(await comet.getAddress())).governor).to.be.equal(firstNewGovernor);

    await configurator.connect(admin.signer).setGovernor(await comet.getAddress(), secondNewGovernor);

    expect((await configurator.getConfiguration(await comet.getAddress())).governor).to.be.equal(secondNewGovernor);
  }
);

scenario(
  'Configurator#setGovernor reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;
    const newGovernor = await deployTimelock(context);

    await expectRevertCustom(
      configurator.connect(albert.signer).setGovernor(await comet.getAddress(), newGovernor),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setPauseGuardian updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const newPauseGuardian = await ethers.Wallet.createRandom().getAddress();
    await configurator.connect(admin.signer).setPauseGuardian(await comet.getAddress(), newPauseGuardian);

    expect((await configurator.getConfiguration(await comet.getAddress())).pauseGuardian).to.be.equal(newPauseGuardian);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.pauseGuardian()).to.be.equal(newPauseGuardian);
  }
);

scenario(
  'Configurator#setPauseGuardian can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const firstNewPauseGuardian = await ethers.Wallet.createRandom().getAddress();
    const secondNewPauseGuardian = await ethers.Wallet.createRandom().getAddress();

    await configurator.connect(admin.signer).setPauseGuardian(await comet.getAddress(), firstNewPauseGuardian);

    expect((await configurator.getConfiguration(await comet.getAddress())).pauseGuardian).to.be.equal(firstNewPauseGuardian);

    await configurator.connect(admin.signer).setPauseGuardian(await comet.getAddress(), secondNewPauseGuardian);

    expect((await configurator.getConfiguration(await comet.getAddress())).pauseGuardian).to.be.equal(secondNewPauseGuardian);
  }
);

scenario(
  'Configurator#setPauseGuardian reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const newPauseGuardian = await ethers.Wallet.createRandom().getAddress();

    await expectRevertCustom(
      configurator.connect(albert.signer).setPauseGuardian(await comet.getAddress(), newPauseGuardian),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setMarketAdminPermissionChecker updates value if called by governor',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ configurator, actors }, context) => {
    const { admin } = actors;

    const newMarketAdminPermissionChecker = await deployMarketAdminPermissionChecker(context);
    await configurator.connect(admin.signer).setMarketAdminPermissionChecker(newMarketAdminPermissionChecker);

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

    const firstNewMarketAdminPermissionChecker = await deployMarketAdminPermissionChecker(context);
    const secondNewMarketAdminPermissionChecker = await deployMarketAdminPermissionChecker(context, true);

    await configurator.connect(admin.signer).setMarketAdminPermissionChecker(firstNewMarketAdminPermissionChecker);

    expect(await configurator.marketAdminPermissionChecker()).to.be.equal(firstNewMarketAdminPermissionChecker);

    await configurator.connect(admin.signer).setMarketAdminPermissionChecker(secondNewMarketAdminPermissionChecker);

    expect(await configurator.marketAdminPermissionChecker()).to.be.equal(secondNewMarketAdminPermissionChecker);
  }
);

scenario(
  'Configurator#setMarketAdminPermissionChecker reverts if called by non-governor',
  {
    filter: async (ctx: CometContext) => await supportsMarketAdminPermissionChecker(ctx)
  },
  async ({ configurator, actors }, context) => {
    const { albert } = actors;

    const newMarketAdminPermissionChecker = await deployMarketAdminPermissionChecker(context);

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
    const newPriceFeed = await deployPriceFeed(context, 'baseToken');

    await configurator.connect(admin.signer).setBaseTokenPriceFeed(await comet.getAddress(), newPriceFeed);

    expect((await configurator.getConfiguration(await comet.getAddress())).baseTokenPriceFeed).to.be.equal(newPriceFeed);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.baseTokenPriceFeed()).to.be.equal(newPriceFeed);
  }
);

scenario(
  'Configurator#setBaseTokenPriceFeed can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewPriceFeed = await deployPriceFeed(context, 'baseToken');
    const secondNewPriceFeed = await deployPriceFeed(context, 'baseToken', true);

    await configurator.connect(admin.signer).setBaseTokenPriceFeed(await comet.getAddress(), firstNewPriceFeed);

    expect((await configurator.getConfiguration(await comet.getAddress())).baseTokenPriceFeed).to.be.equal(firstNewPriceFeed);

    await configurator.connect(admin.signer).setBaseTokenPriceFeed(await comet.getAddress(), secondNewPriceFeed);

    expect((await configurator.getConfiguration(await comet.getAddress())).baseTokenPriceFeed).to.be.equal(secondNewPriceFeed);
  }
);

scenario(
  'Configurator#setBaseTokenPriceFeed reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;

    const newPriceFeed = await deployPriceFeed(context, 'baseToken');

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseTokenPriceFeed(await comet.getAddress(), newPriceFeed),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setExtensionDelegate updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const newExtensionDelegate = await deployCometExt(context);

    await configurator.connect(admin.signer).setExtensionDelegate(await comet.getAddress(), newExtensionDelegate);

    expect((await configurator.getConfiguration(await comet.getAddress())).extensionDelegate).to.be.equal(newExtensionDelegate);
  }
);

scenario(
  'Configurator#setExtensionDelegate can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewExtensionDelegate = await deployCometExt(context);
    const secondNewExtensionDelegate = await deployCometExt(context, true);

    await configurator.connect(admin.signer).setExtensionDelegate(await comet.getAddress(), firstNewExtensionDelegate);

    expect((await configurator.getConfiguration(await comet.getAddress())).extensionDelegate).to.be.equal(
      firstNewExtensionDelegate
    );

    await configurator.connect(admin.signer).setExtensionDelegate(await comet.getAddress(), secondNewExtensionDelegate);

    expect((await configurator.getConfiguration(await comet.getAddress())).extensionDelegate).to.be.equal(
      secondNewExtensionDelegate
    );
  }
);

scenario(
  'Configurator#setExtensionDelegate reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;

    const newExtensionDelegate = await deployCometExt(context);

    await expectRevertCustom(
      configurator.connect(albert.signer).setExtensionDelegate(await comet.getAddress(), newExtensionDelegate),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setStoreFrontPriceFactor updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldStoreFrontPriceFactor = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).storeFrontPriceFactor;

    const newStoreFrontPriceFactor = oldStoreFrontPriceFactor + 1n;
    await configurator.connect(admin.signer).setStoreFrontPriceFactor(await comet.getAddress(), newStoreFrontPriceFactor);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).storeFrontPriceFactor).to.be.equal(
      newStoreFrontPriceFactor
    );

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.storeFrontPriceFactor()).to.be.equal(newStoreFrontPriceFactor);
  }
);
scenario(
  'Configurator#setStoreFrontPriceFactor can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const initialStoreFrontPriceFactor = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).storeFrontPriceFactor;

    const firstStoreFrontPriceFactor = initialStoreFrontPriceFactor + 1n;
    const secondStoreFrontPriceFactor = firstStoreFrontPriceFactor + 1n;

    await configurator.connect(admin.signer).setStoreFrontPriceFactor(await comet.getAddress(), firstStoreFrontPriceFactor);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).storeFrontPriceFactor).to.be.equal(
      firstStoreFrontPriceFactor
    );

    await configurator.connect(admin.signer).setStoreFrontPriceFactor(await comet.getAddress(), secondStoreFrontPriceFactor);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).storeFrontPriceFactor).to.be.equal(
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
      await configurator.getConfiguration(await comet.getAddress())
    ).storeFrontPriceFactor;

    const newStoreFrontPriceFactor = oldStoreFrontPriceFactor + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setStoreFrontPriceFactor(await comet.getAddress(), newStoreFrontPriceFactor),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setBaseMinForRewards updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    const oldBaseMinForRewards = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).baseMinForRewards;

    const newBaseMinForRewards = oldBaseMinForRewards + 1n;
    await configurator.connect(admin.signer).setBaseMinForRewards(await comet.getAddress(), newBaseMinForRewards);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseMinForRewards).to.be.equal(
      newBaseMinForRewards
    );

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.baseMinForRewards()).to.be.equal(newBaseMinForRewards);
  }
);

scenario(
  'Configurator#setBaseMinForRewards can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const initialBaseMinForRewards = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).baseMinForRewards;

    const firstBaseMinForRewards = initialBaseMinForRewards + 1n;
    const secondBaseMinForRewards = firstBaseMinForRewards + 1n;

    await configurator.connect(admin.signer).setBaseMinForRewards(await comet.getAddress(), firstBaseMinForRewards);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseMinForRewards).to.be.equal(
      firstBaseMinForRewards
    );

    await configurator.connect(admin.signer).setBaseMinForRewards(await comet.getAddress(), secondBaseMinForRewards);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseMinForRewards).to.be.equal(
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
      await configurator.getConfiguration(await comet.getAddress())
    ).baseMinForRewards;

    const newBaseMinForRewards = oldBaseMinForRewards + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseMinForRewards(await comet.getAddress(), newBaseMinForRewards),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setTargetReserves updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    const oldTargetReserves = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).targetReserves;

    const newTargetReserves = oldTargetReserves + 1n;
    await configurator.connect(admin.signer).setTargetReserves(await comet.getAddress(), newTargetReserves);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).targetReserves).to.be.equal(
      newTargetReserves
    );

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.targetReserves()).to.be.equal(newTargetReserves);
  }
);

scenario(
  'Configurator#setTargetReserves can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    const initialTargetReserves = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).targetReserves;

    const firstTargetReserves = initialTargetReserves + 1n;
    const secondTargetReserves = firstTargetReserves + 1n;

    await configurator.connect(admin.signer).setTargetReserves(await comet.getAddress(), firstTargetReserves);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).targetReserves).to.be.equal(
      firstTargetReserves
    );

    await configurator.connect(admin.signer).setTargetReserves(await comet.getAddress(), secondTargetReserves);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).targetReserves).to.be.equal(
      secondTargetReserves
    );
  }
);

scenario(
  'Configurator#setTargetReserves reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldTargetReserves = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).targetReserves;
    const newTargetReserves = oldTargetReserves + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setTargetReserves(await comet.getAddress(), newTargetReserves),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#addAsset succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const numAssetsBefore = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs
      .length;

    const newAssetConfig = {
      asset: await deployMockERC20(context, 'asset'),
      priceFeed: await deployPriceFeed(context, 'asset'),
      decimals: 18n,
      borrowCollateralFactor: exp(0.8, 18),
      liquidateCollateralFactor: exp(0.85, 18),
      liquidationFactor: exp(0.9, 18),
      supplyCap: exp(5e6, 18)
    };

    await configurator.connect(admin.signer).addAsset(await comet.getAddress(), newAssetConfig);
    const assetConfigsAfter = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs;

    expect(assetConfigsAfter.length).to.be.equal(numAssetsBefore + 1);
    expect(assetConfigsAfter.at(-1)).to.be.deep.equal(newAssetConfig);
  }
);

scenario('Configurator#addAsset can add multiple assets', {}, async ({ comet, configurator, actors }, context) => {
  const { admin } = actors;

  const numAssetsBefore = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.length;

  const firstNewAssetConfig = {
    asset: await deployMockERC20(context, 'asset'),
    priceFeed: await deployPriceFeed(context, 'asset'),
    decimals: 18n,
    borrowCollateralFactor: exp(0.8, 18),
    liquidateCollateralFactor: exp(0.85, 18),
    liquidationFactor: exp(0.9, 18),
    supplyCap: exp(5e6, 18)
  };

  const secondNewAssetConfig = {
    asset: await deployMockERC20(context, 'asset', true),
    priceFeed: await deployPriceFeed(context, 'asset', true),
    decimals: 6n,
    borrowCollateralFactor: exp(0.8, 18),
    liquidateCollateralFactor: exp(0.85, 18),
    liquidationFactor: exp(0.9, 18),
    supplyCap: exp(5e6, 6)
  };

  await configurator.connect(admin.signer).addAsset(await comet.getAddress(), firstNewAssetConfig);
  await configurator.connect(admin.signer).addAsset(await comet.getAddress(), secondNewAssetConfig);
  const assetConfigsAfter = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs;

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
      configurator.connect(albert.signer).addAsset(await comet.getAddress(), {
        asset: await deployMockERC20(context, 'asset'),
        priceFeed: await deployPriceFeed(context, 'asset'),
        decimals: 18n,
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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const assetIndex = -1;
    const assetConfigsBefore = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs;
    const existingAssetConfig = assetConfigsBefore.at(assetIndex);

    const updatedAssetConfig = {
      ...existingAssetConfig,
      borrowCollateralFactor: existingAssetConfig.borrowCollateralFactor + MIN_FACTOR_INCREMENT,
      liquidateCollateralFactor: existingAssetConfig.liquidateCollateralFactor + MIN_FACTOR_INCREMENT
    };

    await configurator.connect(admin.signer).updateAsset(await comet.getAddress(), updatedAssetConfig);
    const assetConfigsAfter = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs;

    expect(assetConfigsAfter.length).to.be.equal(assetConfigsBefore.length);
    expect(assetConfigsAfter.at(assetIndex)).to.be.deep.equal(updatedAssetConfig);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    const updatedAssetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(existingAssetConfig.asset));

    expect(updatedAssetInfo.borrowCollateralFactor).to.be.equal(updatedAssetConfig.borrowCollateralFactor);
    expect(updatedAssetInfo.liquidateCollateralFactor).to.be.equal(updatedAssetConfig.liquidateCollateralFactor);
  }
);

scenario(
  'Configurator#updateAsset can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const assetIndex = -1;
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(
      assetIndex
    );

    const firstUpdatedAssetConfig = {
      ...assetConfig,
      liquidateCollateralFactor: assetConfig.liquidateCollateralFactor + MIN_FACTOR_INCREMENT
    };

    const secondUpdatedAssetConfig = {
      ...firstUpdatedAssetConfig,
      borrowCollateralFactor: firstUpdatedAssetConfig.borrowCollateralFactor + MIN_FACTOR_INCREMENT
    };

    await configurator.connect(admin.signer).updateAsset(await comet.getAddress(), firstUpdatedAssetConfig);
    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
    ).to.be.deep.equal(firstUpdatedAssetConfig);

    await configurator.connect(admin.signer).updateAsset(await comet.getAddress(), secondUpdatedAssetConfig);
    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
    ).to.be.deep.equal(secondUpdatedAssetConfig);
  }
);

scenario('Configurator#updateAsset reverts if called by non-governor', {}, async ({ comet, configurator, actors }) => {
  const { albert } = actors;

  const existingAssetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(
    -1
  );

  const updatedAssetConfig = {
    ...existingAssetConfig,
    supplyCap: existingAssetConfig.supplyCap + getMinSupplyCapIncrement(existingAssetConfig.decimals)
  };

  await expectRevertCustom(
    configurator.connect(albert.signer).updateAsset(await comet.getAddress(), updatedAssetConfig),
    'Unauthorized()'
  );
});

scenario('Configurator#updateAsset reverts if asset does not exist', {}, async ({ comet, configurator, actors }) => {
  const { admin } = actors;

  const existingAssetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(
    -1
  );

  const updatedAssetConfig = {
    ...existingAssetConfig,
    asset: await ethers.Wallet.createRandom().getAddress()
  };

  await expectRevertCustom(
    configurator.connect(admin.signer).updateAsset(await comet.getAddress(), updatedAssetConfig),
    'AssetDoesNotExist()'
  );
});

scenario(
  'Configurator#updateAssetPriceFeed succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    // use the last asset in the existing configuration to ensure the asset exists
    const assetIndex = -1;
    const existingAsset = (await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex).asset;
    const newPriceFeed = await deployPriceFeed(context, 'asset');

    await configurator
      .connect(admin.signer)
      .updateAssetPriceFeed(await comet.getAddress(), existingAsset, newPriceFeed);

    expect((await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex).priceFeed).to.be.equal(
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
    const existingAsset = (await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex).asset;

    const firstNewPriceFeed = await deployPriceFeed(context, 'asset');
    const secondNewPriceFeed = await deployPriceFeed(context, 'asset', true);

    await configurator
      .connect(admin.signer)
      .updateAssetPriceFeed(await comet.getAddress(), existingAsset, firstNewPriceFeed);

    expect((await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex).priceFeed).to.be.equal(
      firstNewPriceFeed
    );

    await configurator
      .connect(admin.signer)
      .updateAssetPriceFeed(await comet.getAddress(), existingAsset, secondNewPriceFeed);

    expect((await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex).priceFeed).to.be.equal(
      secondNewPriceFeed
    );
  }
);

scenario(
  'Configurator#updateAssetPriceFeed reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;

    const existingAsset = (await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(-1).asset;
    const newPriceFeed = await deployPriceFeed(context, 'asset');

    await expectRevertCustom(
      configurator.connect(albert.signer).updateAssetPriceFeed(await comet.getAddress(), existingAsset, newPriceFeed),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#updateAssetPriceFeed reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const nonExistingAsset = await ethers.Wallet.createRandom().getAddress();
    const newPriceFeed = await deployPriceFeed(context, 'asset');

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAssetPriceFeed(await comet.getAddress(), nonExistingAsset, newPriceFeed),
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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldSupplyKink = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyKink;
    const newSupplyKink = oldSupplyKink + 1n;

    await configurator.connect(admin.signer).setSupplyKink(await comet.getAddress(), newSupplyKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyKink).to.be.equal(
      newSupplyKink
    );

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.supplyKink()).to.be.equal(newSupplyKink);
  }
);

scenario(
  'Configurator#setSupplyKink can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldSupplyKink = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyKink;
    const firstNewSupplyKink = oldSupplyKink + 1n;
    const secondNewSupplyKink = firstNewSupplyKink + 1n;

    await configurator.connect(admin.signer).setSupplyKink(await comet.getAddress(), firstNewSupplyKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyKink).to.be.equal(
      firstNewSupplyKink
    );

    await configurator.connect(admin.signer).setSupplyKink(await comet.getAddress(), secondNewSupplyKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyKink).to.be.equal(
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

    const oldSupplyKink = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyKink;
    const newSupplyKink = oldSupplyKink + 1n;

    await configurator.connect(marketAdminSigner).setSupplyKink(await comet.getAddress(), newSupplyKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyKink).to.be.equal(
      newSupplyKink
    );

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.supplyKink()).to.be.equal(newSupplyKink);
  }
);

scenario(
  'Configurator#setSupplyKink reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldSupplyKink = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyKink;
    const newSupplyKink = oldSupplyKink + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setSupplyKink(await comet.getAddress(), newSupplyKink),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeLow updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).supplyPerYearInterestRateSlopeLow;

    const newSupplyPerYearInterestRateSlopeLow = oldSupplyPerYearInterestRateSlopeLow + 1n;

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeLow(await comet.getAddress(), newSupplyPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyPerYearInterestRateSlopeLow
    ).to.be.equal(newSupplyPerYearInterestRateSlopeLow);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.supplyPerSecondInterestRateSlopeLow()).to.be.equal(
      newSupplyPerYearInterestRateSlopeLow / SECONDS_PER_YEAR
    );
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeLow can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).supplyPerYearInterestRateSlopeLow;

    const firstNewSupplyPerYearInterestRateSlopeLow = oldSupplyPerYearInterestRateSlopeLow + 1n;
    const secondNewSupplyPerYearInterestRateSlopeLow = firstNewSupplyPerYearInterestRateSlopeLow + 1n;

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeLow(await comet.getAddress(), firstNewSupplyPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyPerYearInterestRateSlopeLow
    ).to.be.equal(firstNewSupplyPerYearInterestRateSlopeLow);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeLow(await comet.getAddress(), secondNewSupplyPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyPerYearInterestRateSlopeLow
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
      await configurator.getConfiguration(await comet.getAddress())
    ).supplyPerYearInterestRateSlopeLow;

    const newSupplyPerYearInterestRateSlopeLow = oldSupplyPerYearInterestRateSlopeLow + 1n;

    await configurator
      .connect(marketAdminSigner)
      .setSupplyPerYearInterestRateSlopeLow(await comet.getAddress(), newSupplyPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyPerYearInterestRateSlopeLow
    ).to.be.equal(newSupplyPerYearInterestRateSlopeLow);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.supplyPerSecondInterestRateSlopeLow()).to.be.equal(
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
      await configurator.getConfiguration(await comet.getAddress())
    ).supplyPerYearInterestRateSlopeLow;

    const newSupplyPerYearInterestRateSlopeLow = oldSupplyPerYearInterestRateSlopeLow + 1n;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .setSupplyPerYearInterestRateSlopeLow(await comet.getAddress(), newSupplyPerYearInterestRateSlopeLow),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeHigh updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).supplyPerYearInterestRateSlopeHigh;

    const newSupplyPerYearInterestRateSlopeHigh = oldSupplyPerYearInterestRateSlopeHigh + 1n;

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeHigh(await comet.getAddress(), newSupplyPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyPerYearInterestRateSlopeHigh
    ).to.be.equal(newSupplyPerYearInterestRateSlopeHigh);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.supplyPerSecondInterestRateSlopeHigh()).to.be.equal(
      newSupplyPerYearInterestRateSlopeHigh / SECONDS_PER_YEAR
    );
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeHigh can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).supplyPerYearInterestRateSlopeHigh;

    const firstNewSupplyPerYearInterestRateSlopeHigh = oldSupplyPerYearInterestRateSlopeHigh + 1n;
    const secondNewSupplyPerYearInterestRateSlopeHigh = firstNewSupplyPerYearInterestRateSlopeHigh + 1n;

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeHigh(await comet.getAddress(), firstNewSupplyPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyPerYearInterestRateSlopeHigh
    ).to.be.equal(firstNewSupplyPerYearInterestRateSlopeHigh);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeHigh(await comet.getAddress(), secondNewSupplyPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyPerYearInterestRateSlopeHigh
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
      await configurator.getConfiguration(await comet.getAddress())
    ).supplyPerYearInterestRateSlopeHigh;

    const newSupplyPerYearInterestRateSlopeHigh = oldSupplyPerYearInterestRateSlopeHigh + 1n;

    await configurator
      .connect(marketAdminSigner)
      .setSupplyPerYearInterestRateSlopeHigh(await comet.getAddress(), newSupplyPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyPerYearInterestRateSlopeHigh
    ).to.be.equal(newSupplyPerYearInterestRateSlopeHigh);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.supplyPerSecondInterestRateSlopeHigh()).to.be.equal(
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
      await configurator.getConfiguration(await comet.getAddress())
    ).supplyPerYearInterestRateSlopeHigh;

    const newSupplyPerYearInterestRateSlopeHigh = oldSupplyPerYearInterestRateSlopeHigh + 1n;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .setSupplyPerYearInterestRateSlopeHigh(await comet.getAddress(), newSupplyPerYearInterestRateSlopeHigh),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateBase updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).supplyPerYearInterestRateBase;

    const newSupplyPerYearInterestRateBase = oldSupplyPerYearInterestRateBase + 1n;

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateBase(await comet.getAddress(), newSupplyPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyPerYearInterestRateBase
    ).to.be.equal(newSupplyPerYearInterestRateBase);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.supplyPerSecondInterestRateBase()).to.be.equal(
      newSupplyPerYearInterestRateBase / SECONDS_PER_YEAR
    );
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateBase can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).supplyPerYearInterestRateBase;

    const firstNewSupplyPerYearInterestRateBase = oldSupplyPerYearInterestRateBase + 1n;
    const secondNewSupplyPerYearInterestRateBase = firstNewSupplyPerYearInterestRateBase + 1n;

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateBase(await comet.getAddress(), firstNewSupplyPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyPerYearInterestRateBase
    ).to.be.equal(firstNewSupplyPerYearInterestRateBase);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateBase(await comet.getAddress(), secondNewSupplyPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyPerYearInterestRateBase
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
      await configurator.getConfiguration(await comet.getAddress())
    ).supplyPerYearInterestRateBase;

    const newSupplyPerYearInterestRateBase = oldSupplyPerYearInterestRateBase + 1n;

    await configurator
      .connect(marketAdminSigner)
      .setSupplyPerYearInterestRateBase(await comet.getAddress(), newSupplyPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).supplyPerYearInterestRateBase
    ).to.be.equal(newSupplyPerYearInterestRateBase);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.supplyPerSecondInterestRateBase()).to.be.equal(
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
      await configurator.getConfiguration(await comet.getAddress())
    ).supplyPerYearInterestRateBase;

    const newSupplyPerYearInterestRateBase = oldSupplyPerYearInterestRateBase + 1n;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .setSupplyPerYearInterestRateBase(await comet.getAddress(), newSupplyPerYearInterestRateBase),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setBorrowKink updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBorrowKink = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowKink;
    const newBorrowKink = oldBorrowKink + 1n;

    await configurator.connect(admin.signer).setBorrowKink(await comet.getAddress(), newBorrowKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowKink).to.be.equal(
      newBorrowKink
    );

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.borrowKink()).to.be.equal(newBorrowKink);
  }
);

scenario(
  'Configurator#setBorrowKink can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBorrowKink = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowKink;
    const firstNewBorrowKink = oldBorrowKink + 1n;
    const secondNewBorrowKink = firstNewBorrowKink + 1n;

    await configurator.connect(admin.signer).setBorrowKink(await comet.getAddress(), firstNewBorrowKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowKink).to.be.equal(
      firstNewBorrowKink
    );

    await configurator.connect(admin.signer).setBorrowKink(await comet.getAddress(), secondNewBorrowKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowKink).to.be.equal(
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
    const oldBorrowKink = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowKink;
    const newBorrowKink = oldBorrowKink + 1n;

    await configurator.connect(marketAdminSigner).setBorrowKink(await comet.getAddress(), newBorrowKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowKink).to.be.equal(
      newBorrowKink
    );

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.borrowKink()).to.be.equal(newBorrowKink);
  }
);

scenario(
  'Configurator#setBorrowKink reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldBorrowKink = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowKink;
    const newBorrowKink = oldBorrowKink + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBorrowKink(await comet.getAddress(), newBorrowKink),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeLow updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).borrowPerYearInterestRateSlopeLow;

    const newBorrowPerYearInterestRateSlopeLow = oldBorrowPerYearInterestRateSlopeLow + 1n;

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeLow(await comet.getAddress(), newBorrowPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowPerYearInterestRateSlopeLow
    ).to.be.equal(newBorrowPerYearInterestRateSlopeLow);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.borrowPerSecondInterestRateSlopeLow()).to.be.equal(
      newBorrowPerYearInterestRateSlopeLow / SECONDS_PER_YEAR
    );
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeLow can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).borrowPerYearInterestRateSlopeLow;

    const firstNewBorrowPerYearInterestRateSlopeLow = oldBorrowPerYearInterestRateSlopeLow + 1n;
    const secondNewBorrowPerYearInterestRateSlopeLow = firstNewBorrowPerYearInterestRateSlopeLow + 1n;

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeLow(await comet.getAddress(), firstNewBorrowPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowPerYearInterestRateSlopeLow
    ).to.be.equal(firstNewBorrowPerYearInterestRateSlopeLow);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeLow(await comet.getAddress(), secondNewBorrowPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowPerYearInterestRateSlopeLow
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
      await configurator.getConfiguration(await comet.getAddress())
    ).borrowPerYearInterestRateSlopeLow;

    const newBorrowPerYearInterestRateSlopeLow = oldBorrowPerYearInterestRateSlopeLow + 1n;

    await configurator
      .connect(marketAdminSigner)
      .setBorrowPerYearInterestRateSlopeLow(await comet.getAddress(), newBorrowPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowPerYearInterestRateSlopeLow
    ).to.be.equal(newBorrowPerYearInterestRateSlopeLow);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.borrowPerSecondInterestRateSlopeLow()).to.be.equal(
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
      await configurator.getConfiguration(await comet.getAddress())
    ).borrowPerYearInterestRateSlopeLow;

    const newBorrowPerYearInterestRateSlopeLow = oldBorrowPerYearInterestRateSlopeLow + 1n;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .setBorrowPerYearInterestRateSlopeLow(await comet.getAddress(), newBorrowPerYearInterestRateSlopeLow),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeHigh updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).borrowPerYearInterestRateSlopeHigh;

    const newBorrowPerYearInterestRateSlopeHigh = oldBorrowPerYearInterestRateSlopeHigh + 1n;

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeHigh(await comet.getAddress(), newBorrowPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowPerYearInterestRateSlopeHigh
    ).to.be.equal(newBorrowPerYearInterestRateSlopeHigh);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.borrowPerSecondInterestRateSlopeHigh()).to.be.equal(
      newBorrowPerYearInterestRateSlopeHigh / SECONDS_PER_YEAR
    );
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeHigh can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).borrowPerYearInterestRateSlopeHigh;

    const firstNewBorrowPerYearInterestRateSlopeHigh = oldBorrowPerYearInterestRateSlopeHigh + 1n;
    const secondNewBorrowPerYearInterestRateSlopeHigh = oldBorrowPerYearInterestRateSlopeHigh + 2n;

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeHigh(await comet.getAddress(), firstNewBorrowPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowPerYearInterestRateSlopeHigh
    ).to.be.equal(firstNewBorrowPerYearInterestRateSlopeHigh);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeHigh(await comet.getAddress(), secondNewBorrowPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowPerYearInterestRateSlopeHigh
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
      await configurator.getConfiguration(await comet.getAddress())
    ).borrowPerYearInterestRateSlopeHigh;

    const newBorrowPerYearInterestRateSlopeHigh = oldBorrowPerYearInterestRateSlopeHigh + 1n;

    await configurator
      .connect(marketAdminSigner)
      .setBorrowPerYearInterestRateSlopeHigh(await comet.getAddress(), newBorrowPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowPerYearInterestRateSlopeHigh
    ).to.be.equal(newBorrowPerYearInterestRateSlopeHigh);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.borrowPerSecondInterestRateSlopeHigh()).to.be.equal(
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
      await configurator.getConfiguration(await comet.getAddress())
    ).borrowPerYearInterestRateSlopeHigh;

    const newBorrowPerYearInterestRateSlopeHigh = oldBorrowPerYearInterestRateSlopeHigh + 1n;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .setBorrowPerYearInterestRateSlopeHigh(await comet.getAddress(), newBorrowPerYearInterestRateSlopeHigh),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateBase updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).borrowPerYearInterestRateBase;

    const newBorrowPerYearInterestRateBase = oldBorrowPerYearInterestRateBase + 1n;

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateBase(await comet.getAddress(), newBorrowPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowPerYearInterestRateBase
    ).to.be.equal(newBorrowPerYearInterestRateBase);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.borrowPerSecondInterestRateBase()).to.be.equal(
      newBorrowPerYearInterestRateBase / SECONDS_PER_YEAR
    );
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateBase can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).borrowPerYearInterestRateBase;

    const firstNewBorrowPerYearInterestRateBase = oldBorrowPerYearInterestRateBase + 1n;
    const secondNewBorrowPerYearInterestRateBase = firstNewBorrowPerYearInterestRateBase + 1n;

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateBase(await comet.getAddress(), firstNewBorrowPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowPerYearInterestRateBase
    ).to.be.equal(firstNewBorrowPerYearInterestRateBase);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateBase(await comet.getAddress(), secondNewBorrowPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowPerYearInterestRateBase
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
      await configurator.getConfiguration(await comet.getAddress())
    ).borrowPerYearInterestRateBase;

    const newBorrowPerYearInterestRateBase = oldBorrowPerYearInterestRateBase + 1n;

    await configurator
      .connect(marketAdminSigner)
      .setBorrowPerYearInterestRateBase(await comet.getAddress(), newBorrowPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).borrowPerYearInterestRateBase
    ).to.be.equal(newBorrowPerYearInterestRateBase);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.borrowPerSecondInterestRateBase()).to.be.equal(
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
      await configurator.getConfiguration(await comet.getAddress())
    ).borrowPerYearInterestRateBase;

    const newBorrowPerYearInterestRateBase = oldBorrowPerYearInterestRateBase + 1n;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .setBorrowPerYearInterestRateBase(await comet.getAddress(), newBorrowPerYearInterestRateBase),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setBaseTrackingSupplySpeed updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBaseTrackingSupplySpeed = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).baseTrackingSupplySpeed;

    const newBaseTrackingSupplySpeed = oldBaseTrackingSupplySpeed + 1n;

    await configurator.connect(admin.signer).setBaseTrackingSupplySpeed(await comet.getAddress(), newBaseTrackingSupplySpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseTrackingSupplySpeed
    ).to.be.equal(newBaseTrackingSupplySpeed);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.baseTrackingSupplySpeed()).to.be.equal(newBaseTrackingSupplySpeed);
  }
);

scenario(
  'Configurator#setBaseTrackingSupplySpeed can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBaseTrackingSupplySpeed = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).baseTrackingSupplySpeed;

    const firstNewBaseTrackingSupplySpeed = oldBaseTrackingSupplySpeed + 1n;
    const secondNewBaseTrackingSupplySpeed = firstNewBaseTrackingSupplySpeed + 1n;

    await configurator
      .connect(admin.signer)
      .setBaseTrackingSupplySpeed(await comet.getAddress(), firstNewBaseTrackingSupplySpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseTrackingSupplySpeed
    ).to.be.equal(firstNewBaseTrackingSupplySpeed);

    await configurator
      .connect(admin.signer)
      .setBaseTrackingSupplySpeed(await comet.getAddress(), secondNewBaseTrackingSupplySpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseTrackingSupplySpeed
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
      await configurator.getConfiguration(await comet.getAddress())
    ).baseTrackingSupplySpeed;

    const newBaseTrackingSupplySpeed = oldBaseTrackingSupplySpeed + 1n;

    await configurator
      .connect(marketAdminSigner)
      .setBaseTrackingSupplySpeed(await comet.getAddress(), newBaseTrackingSupplySpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseTrackingSupplySpeed
    ).to.be.equal(newBaseTrackingSupplySpeed);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.baseTrackingSupplySpeed()).to.be.equal(newBaseTrackingSupplySpeed);
  }
);

scenario(
  'Configurator#setBaseTrackingSupplySpeed reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldBaseTrackingSupplySpeed = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).baseTrackingSupplySpeed;

    const newBaseTrackingSupplySpeed = oldBaseTrackingSupplySpeed + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseTrackingSupplySpeed(await comet.getAddress(), newBaseTrackingSupplySpeed),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setBaseTrackingBorrowSpeed updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBaseTrackingBorrowSpeed = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).baseTrackingBorrowSpeed;

    const newBaseTrackingBorrowSpeed = oldBaseTrackingBorrowSpeed + 1n;

    await configurator.connect(admin.signer).setBaseTrackingBorrowSpeed(await comet.getAddress(), newBaseTrackingBorrowSpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseTrackingBorrowSpeed
    ).to.be.equal(newBaseTrackingBorrowSpeed);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.baseTrackingBorrowSpeed()).to.be.equal(newBaseTrackingBorrowSpeed);
  }
);

scenario(
  'Configurator#setBaseTrackingBorrowSpeed can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBaseTrackingBorrowSpeed = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).baseTrackingBorrowSpeed;

    const firstNewBaseTrackingBorrowSpeed = oldBaseTrackingBorrowSpeed + 1n;
    const secondNewBaseTrackingBorrowSpeed = firstNewBaseTrackingBorrowSpeed + 1n;

    await configurator
      .connect(admin.signer)
      .setBaseTrackingBorrowSpeed(await comet.getAddress(), firstNewBaseTrackingBorrowSpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseTrackingBorrowSpeed
    ).to.be.equal(firstNewBaseTrackingBorrowSpeed);

    await configurator
      .connect(admin.signer)
      .setBaseTrackingBorrowSpeed(await comet.getAddress(), secondNewBaseTrackingBorrowSpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseTrackingBorrowSpeed
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
      await configurator.getConfiguration(await comet.getAddress())
    ).baseTrackingBorrowSpeed;

    const newBaseTrackingBorrowSpeed = oldBaseTrackingBorrowSpeed + 1n;

    await configurator
      .connect(marketAdminSigner)
      .setBaseTrackingBorrowSpeed(await comet.getAddress(), newBaseTrackingBorrowSpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseTrackingBorrowSpeed
    ).to.be.equal(newBaseTrackingBorrowSpeed);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.baseTrackingBorrowSpeed()).to.be.equal(newBaseTrackingBorrowSpeed);
  }
);

scenario(
  'Configurator#setBaseTrackingBorrowSpeed reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldBaseTrackingBorrowSpeed = normalizeStructOutput(
      await configurator.getConfiguration(await comet.getAddress())
    ).baseTrackingBorrowSpeed;

    const newBaseTrackingBorrowSpeed = oldBaseTrackingBorrowSpeed + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseTrackingBorrowSpeed(await comet.getAddress(), newBaseTrackingBorrowSpeed),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setBaseBorrowMin updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBaseBorrowMin = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseBorrowMin;
    const newBaseBorrowMin = oldBaseBorrowMin + 1n;

    await configurator.connect(admin.signer).setBaseBorrowMin(await comet.getAddress(), newBaseBorrowMin);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseBorrowMin).to.be.equal(
      newBaseBorrowMin
    );

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.baseBorrowMin()).to.be.equal(newBaseBorrowMin);
  }
);

scenario(
  'Configurator#setBaseBorrowMin can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBaseBorrowMin = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseBorrowMin;
    const firstNewBaseBorrowMin = oldBaseBorrowMin + 1n;
    const secondNewBaseBorrowMin = firstNewBaseBorrowMin + 1n;

    await configurator.connect(admin.signer).setBaseBorrowMin(await comet.getAddress(), firstNewBaseBorrowMin);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseBorrowMin).to.be.equal(
      firstNewBaseBorrowMin
    );

    await configurator.connect(admin.signer).setBaseBorrowMin(await comet.getAddress(), secondNewBaseBorrowMin);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseBorrowMin).to.be.equal(
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
    const oldBaseBorrowMin = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseBorrowMin;
    const newBaseBorrowMin = oldBaseBorrowMin + 1n;

    await configurator.connect(marketAdminSigner).setBaseBorrowMin(await comet.getAddress(), newBaseBorrowMin);

    expect(normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseBorrowMin).to.be.equal(
      newBaseBorrowMin
    );

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    expect(await comet.baseBorrowMin()).to.be.equal(newBaseBorrowMin);
  }
);

scenario(
  'Configurator#setBaseBorrowMin reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const oldBaseBorrowMin = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).baseBorrowMin;
    const newBaseBorrowMin = oldBaseBorrowMin + 1n;

    await expectRevertCustom(
      configurator.connect(albert.signer).setBaseBorrowMin(await comet.getAddress(), newBaseBorrowMin),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#updateAssetBorrowCollateralFactor succeeds if called by governor',
  {
    filter: async (ctx: CometContext) => await hasActiveAsset(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetBorrowCollateralFactor = assetConfig.borrowCollateralFactor;
    const newAssetBorrowCollateralFactor = oldAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(admin.signer)
      .updateAssetBorrowCollateralFactor(await comet.getAddress(), assetConfig.asset, newAssetBorrowCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(newAssetBorrowCollateralFactor);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.borrowCollateralFactor).to.be.equal(newAssetBorrowCollateralFactor);
  }
);

scenario(
  'Configurator#updateAssetBorrowCollateralFactor can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const assetIndex = -1;
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(
      assetIndex
    );
    const oldAssetBorrowCollateralFactor = assetConfig.borrowCollateralFactor;
    const firstNewAssetBorrowCollateralFactor = oldAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;
    const secondNewAssetBorrowCollateralFactor = firstNewAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(admin.signer)
      .updateAssetBorrowCollateralFactor(await comet.getAddress(), assetConfig.asset, firstNewAssetBorrowCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(firstNewAssetBorrowCollateralFactor);

    await configurator
      .connect(admin.signer)
      .updateAssetBorrowCollateralFactor(await comet.getAddress(), assetConfig.asset, secondNewAssetBorrowCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(secondNewAssetBorrowCollateralFactor);
  }
);

scenario(
  'Configurator#updateAssetBorrowCollateralFactor disables asset if called by governor',
  {
    filter: async (ctx: CometContext) => await hasActiveAsset(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const newAssetBorrowCollateralFactor = 0n;

    await configurator
      .connect(admin.signer)
      .updateAssetBorrowCollateralFactor(await comet.getAddress(), assetConfig.asset, newAssetBorrowCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(newAssetBorrowCollateralFactor);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.borrowCollateralFactor).to.be.equal(newAssetBorrowCollateralFactor);
  }
);

scenario(
  'Configurator#updateAssetBorrowCollateralFactor succeeds if called by market-admin',
  {
    filter: async (ctx: CometContext) =>
      (await supportsMarketAdminPermissionChecker(ctx)) && (await hasActiveAsset(ctx))
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);
    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const oldAssetBorrowCollateralFactor = assetConfig.borrowCollateralFactor;
    const newAssetBorrowCollateralFactor = oldAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(marketAdminSigner)
      .updateAssetBorrowCollateralFactor(await comet.getAddress(), assetConfig.asset, newAssetBorrowCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(newAssetBorrowCollateralFactor);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.borrowCollateralFactor).to.be.equal(newAssetBorrowCollateralFactor);
  }
);

scenario(
  'Configurator#updateAssetBorrowCollateralFactor disables asset if called by market-admin',
  {
    filter: async (ctx: CometContext) =>
      (await supportsMarketAdminPermissionChecker(ctx)) && (await hasActiveAsset(ctx))
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);
    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const newAssetBorrowCollateralFactor = 0n;

    await configurator
      .connect(marketAdminSigner)
      .updateAssetBorrowCollateralFactor(await comet.getAddress(), assetConfig.asset, newAssetBorrowCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(newAssetBorrowCollateralFactor);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.borrowCollateralFactor).to.be.equal(newAssetBorrowCollateralFactor);
  }
);

scenario(
  'Configurator#updateAssetBorrowCollateralFactor reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(-1);
    const oldAssetBorrowCollateralFactor = assetConfig.borrowCollateralFactor;
    const newAssetBorrowCollateralFactor = oldAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .updateAssetBorrowCollateralFactor(await comet.getAddress(), assetConfig.asset, newAssetBorrowCollateralFactor),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#updateAssetBorrowCollateralFactor reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    // use the existing config to get a valid factor value
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(-1);
    const oldAssetBorrowCollateralFactor = assetConfig.borrowCollateralFactor;
    const newAssetBorrowCollateralFactor = oldAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;

    const nonExistingAsset = await ethers.Wallet.createRandom().getAddress();

    await expectRevertCustom(
      configurator
        .connect(admin.signer)
        .updateAssetBorrowCollateralFactor(await comet.getAddress(), nonExistingAsset, newAssetBorrowCollateralFactor),
      'AssetDoesNotExist()'
    );
  }
);

scenario(
  'Configurator#updateAssetLiquidateCollateralFactor succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const assetIndex = -1;
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(
      assetIndex
    );
    const oldAssetLiquidateCollateralFactor = assetConfig.liquidateCollateralFactor;
    const newAssetLiquidateCollateralFactor = oldAssetLiquidateCollateralFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(admin.signer)
      .updateAssetLiquidateCollateralFactor(await comet.getAddress(), assetConfig.asset, newAssetLiquidateCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
        .liquidateCollateralFactor
    ).to.be.equal(newAssetLiquidateCollateralFactor);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.liquidateCollateralFactor).to.be.equal(newAssetLiquidateCollateralFactor);
  }
);

scenario(
  'Configurator#updateAssetLiquidateCollateralFactor can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const assetIndex = -1;
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(
      assetIndex
    );
    const oldAssetLiquidateCollateralFactor = assetConfig.liquidateCollateralFactor;
    const firstNewAssetLiquidateCollateralFactor = oldAssetLiquidateCollateralFactor + MIN_FACTOR_INCREMENT;
    const secondNewAssetLiquidateCollateralFactor = firstNewAssetLiquidateCollateralFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(admin.signer)
      .updateAssetLiquidateCollateralFactor(await comet.getAddress(), assetConfig.asset, firstNewAssetLiquidateCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
        .liquidateCollateralFactor
    ).to.be.equal(firstNewAssetLiquidateCollateralFactor);

    await configurator
      .connect(admin.signer)
      .updateAssetLiquidateCollateralFactor(await comet.getAddress(), assetConfig.asset, secondNewAssetLiquidateCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
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
    const assetIndex = -1;
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(
      assetIndex
    );
    const oldAssetLiquidateCollateralFactor = assetConfig.liquidateCollateralFactor;
    const newAssetLiquidateCollateralFactor = oldAssetLiquidateCollateralFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(marketAdminSigner)
      .updateAssetLiquidateCollateralFactor(await comet.getAddress(), assetConfig.asset, newAssetLiquidateCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
        .liquidateCollateralFactor
    ).to.be.equal(newAssetLiquidateCollateralFactor);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.liquidateCollateralFactor).to.be.equal(newAssetLiquidateCollateralFactor);
  }
);

scenario(
  'Configurator#updateAssetLiquidateCollateralFactor reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const assetConfigs = (await configurator.getConfiguration(await comet.getAddress())).assetConfigs;

    await expectRevertCustom(
      configurator
        .connect(albert.signer)
        .updateAssetLiquidateCollateralFactor(await comet.getAddress(), assetConfigs.at(-1).asset, 1n),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#updateAssetLiquidateCollateralFactor reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const nonExistingAsset = await ethers.Wallet.createRandom().getAddress();

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(await comet.getAddress(), nonExistingAsset, 1n),
      'AssetDoesNotExist()'
    );
  }
);

scenario(
  'Configurator#updateAssetLiquidationFactor succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const assetIndex = -1;
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(
      assetIndex
    );
    const oldAssetLiquidationFactor = assetConfig.liquidationFactor;
    const newAssetLiquidationFactor = oldAssetLiquidationFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(admin.signer)
      .updateAssetLiquidationFactor(await comet.getAddress(), assetConfig.asset, newAssetLiquidationFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
        .liquidationFactor
    ).to.be.equal(newAssetLiquidationFactor);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.liquidationFactor).to.be.equal(newAssetLiquidationFactor);
  }
);

scenario(
  'Configurator#updateAssetLiquidationFactor can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const assetIndex = -1;
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(
      assetIndex
    );
    const oldAssetLiquidationFactor = assetConfig.liquidationFactor;
    const firstNewAssetLiquidationFactor = oldAssetLiquidationFactor + MIN_FACTOR_INCREMENT;
    const secondNewAssetLiquidationFactor = firstNewAssetLiquidationFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(admin.signer)
      .updateAssetLiquidationFactor(await comet.getAddress(), assetConfig.asset, firstNewAssetLiquidationFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
        .liquidationFactor
    ).to.be.equal(firstNewAssetLiquidationFactor);

    await configurator
      .connect(admin.signer)
      .updateAssetLiquidationFactor(await comet.getAddress(), assetConfig.asset, secondNewAssetLiquidationFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
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
    const assetIndex = -1;
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(
      assetIndex
    );
    const oldAssetLiquidationFactor = assetConfig.liquidationFactor;
    const newAssetLiquidationFactor = oldAssetLiquidationFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(marketAdminSigner)
      .updateAssetLiquidationFactor(await comet.getAddress(), assetConfig.asset, newAssetLiquidationFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex)
        .liquidationFactor
    ).to.be.equal(newAssetLiquidationFactor);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.liquidationFactor).to.be.equal(newAssetLiquidationFactor);
  }
);

scenario(
  'Configurator#updateAssetLiquidationFactor reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const assetConfigs = (await configurator.getConfiguration(await comet.getAddress())).assetConfigs;

    await expectRevertCustom(
      configurator.connect(albert.signer).updateAssetLiquidationFactor(await comet.getAddress(), assetConfigs.at(-1).asset, 1n),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#updateAssetLiquidationFactor reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const nonExistingAsset = await ethers.Wallet.createRandom().getAddress();

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAssetLiquidationFactor(await comet.getAddress(), nonExistingAsset, 1n),
      'AssetDoesNotExist()'
    );
  }
);

scenario(
  'Configurator#updateAssetSupplyCap succeeds if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const assetIndex = -1;
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(
      assetIndex
    );
    const oldAssetSupplyCap = assetConfig.supplyCap;
    const newAssetSupplyCap = oldAssetSupplyCap + getMinSupplyCapIncrement(assetConfig.decimals);

    await configurator
      .connect(admin.signer)
      .updateAssetSupplyCap(await comet.getAddress(), assetConfig.asset, newAssetSupplyCap);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(newAssetSupplyCap);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.supplyCap).to.be.equal(newAssetSupplyCap);
  }
);

scenario(
  'Configurator#updateAssetSupplyCap can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const assetIndex = -1;
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(
      assetIndex
    );
    const oldAssetSupplyCap = assetConfig.supplyCap;
    const firstNewAssetSupplyCap = oldAssetSupplyCap + getMinSupplyCapIncrement(assetConfig.decimals);
    const secondNewAssetSupplyCap = firstNewAssetSupplyCap + getMinSupplyCapIncrement(assetConfig.decimals);

    await configurator
      .connect(admin.signer)
      .updateAssetSupplyCap(await comet.getAddress(), assetConfig.asset, firstNewAssetSupplyCap);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(firstNewAssetSupplyCap);

    await configurator
      .connect(admin.signer)
      .updateAssetSupplyCap(await comet.getAddress(), assetConfig.asset, secondNewAssetSupplyCap);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(secondNewAssetSupplyCap);
  }
);

scenario(
  'Configurator#updateAssetSupplyCap disables asset if called by governor',
  {
    filter: async (ctx: CometContext) => await hasActiveAsset(ctx)
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const newAssetSupplyCap = 0n;

    await configurator
      .connect(admin.signer)
      .updateAssetSupplyCap(await comet.getAddress(), assetConfig.asset, newAssetSupplyCap);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(newAssetSupplyCap);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

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
    const assetIndex = -1;
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(
      assetIndex
    );
    const oldAssetSupplyCap = assetConfig.supplyCap;
    const newAssetSupplyCap = oldAssetSupplyCap + getMinSupplyCapIncrement(assetConfig.decimals);

    await configurator
      .connect(marketAdminSigner)
      .updateAssetSupplyCap(await comet.getAddress(), assetConfig.asset, newAssetSupplyCap);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(newAssetSupplyCap);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.supplyCap).to.be.equal(newAssetSupplyCap);
  }
);

scenario(
  'Configurator#updateAssetSupplyCap disables asset if called by market-admin',
  {
    filter: async (ctx: CometContext) =>
      (await supportsMarketAdminPermissionChecker(ctx)) && (await hasActiveAsset(ctx))
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const marketAdminSigner = await getMarketAdminSigner(context);
    const { assetIndex, assetConfig } = await getActiveAsset(context);
    const newAssetSupplyCap = 0n;

    await configurator
      .connect(marketAdminSigner)
      .updateAssetSupplyCap(await comet.getAddress(), assetConfig.asset, newAssetSupplyCap);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(await comet.getAddress())).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(newAssetSupplyCap);

    await admin.deployAndUpgradeTo(await configurator.getAddress(), await comet.getAddress());

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.supplyCap).to.be.equal(newAssetSupplyCap);
  }
);

scenario(
  'Configurator#updateAssetSupplyCap reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;
    const assetConfigs = (await configurator.getConfiguration(await comet.getAddress())).assetConfigs;

    await expectRevertCustom(
      configurator.connect(albert.signer).updateAssetSupplyCap(await comet.getAddress(), assetConfigs.at(-1).asset, 1n),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#updateAssetSupplyCap reverts if asset does not exist',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    const nonExistingAsset = await ethers.Wallet.createRandom().getAddress();

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAssetSupplyCap(await comet.getAddress(), nonExistingAsset, 1n),
      'AssetDoesNotExist()'
    );
  }
);
