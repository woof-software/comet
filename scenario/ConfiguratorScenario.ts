import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { CometContext, scenario } from './context/CometContext';
import { exp } from '../test/helpers';
import { expectRevertCustom, setEtherBalance, supportsMarketAdminPermissionChecker } from './utils';
import { MarketAdminPermissionChecker } from '../build/types';

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

async function hasActiveAsset(ctx: CometContext): Promise<boolean> {
  const configurator = await ctx.getConfigurator();
  const cometAddress = (await ctx.getComet()).address;
  const assetConfigs = normalizeStructOutput(await configurator.getConfiguration(cometAddress)).assetConfigs;

  return assetConfigs.some((asset) => asset.borrowCollateralFactor > 0n && asset.supplyCap > 0n);
}

/// Finds the first asset with non-zero configuration values
async function getActiveAsset(context: CometContext) {
  const configurator = await context.getConfigurator();
  const cometAddress = (await context.getComet()).address;
  const assetConfigs = normalizeStructOutput(await configurator.getConfiguration(cometAddress)).assetConfigs;

  const assetIndex = assetConfigs.findIndex((asset) => asset.borrowCollateralFactor > 0n && asset.supplyCap > 0n);

  return {
    assetIndex,
    assetConfig: assetConfigs[assetIndex]
  };
}

function getMinSupplyCapIncrement(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

async function getMarketAdminSigner(context: CometContext): Promise<SignerWithAddress> {
  const dm = context.world.deploymentManager;
  const configurator = await context.getConfigurator();

  const marketAdminPermissionChecker = (await dm.hre.ethers.getContractAt(
    'MarketAdminPermissionChecker',
    await configurator.marketAdminPermissionChecker()
  )) as MarketAdminPermissionChecker;

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

  return marketAdminPermissionChecker.address;
}

async function deployCometFactory(context: CometContext, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;
  const cometFactory = await dm.deploy('test:cometFactory', 'CometFactoryWithExtendedAssetList.sol', [], force);

  return cometFactory.address;
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

  return priceFeed.address;
}

async function deployTimelock(context: CometContext, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;
  const admin = context.actors.admin;
  const timelock = await dm.deploy('test:timelock', 'test/SimpleTimelock.sol', [admin.address], force);

  return timelock.address;
}

async function deployMockERC20(context: CometContext, alias: string, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;

  const mockERC20 = await dm.deploy(
    `mockERC20:${alias}`,
    'capo/contracts/test/MockERC20.sol',
    ['Mock Token', 'MOCK', 18],
    force
  );

  return mockERC20.address;
}

async function deployCometExt(context: CometContext, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;
  const assetListFactory = await dm.deploy('test:assetListFactory', 'AssetListFactory.sol', []);

  const extConfiguration = {
    name32: ethers.utils.formatBytes32String('MOCK'),
    symbol32: ethers.utils.formatBytes32String('cMOCKv3')
  };

  const cometExt = await dm.deploy(
    'test:comet:implementation:implementation',
    'CometExtAssetList.sol',
    [extConfiguration, assetListFactory.address],
    force
  );

  return cometExt.address;
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
        decimals: 18,
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
    tmpCometImpl.address,
    cometAdmin.address,
    []
  ]);

  return cometProxy.address;
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

    await configurator.connect(admin.signer).setFactory(comet.address, newFactory);

    expect(await configurator.factory(comet.address)).to.be.equal(newFactory);
  }
);

scenario(
  'Configurator#setFactory can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewFactory = await deployCometFactory(context);
    const secondNewFactory = await deployCometFactory(context, true);

    await configurator.connect(admin.signer).setFactory(comet.address, firstNewFactory);

    expect(await configurator.factory(comet.address)).to.be.equal(firstNewFactory);

    await configurator.connect(admin.signer).setFactory(comet.address, secondNewFactory);

    expect(await configurator.factory(comet.address)).to.be.equal(secondNewFactory);
  }
);

scenario(
  'Configurator#setFactory reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;
    const newFactory = await deployCometFactory(context);

    await expectRevertCustom(
      configurator.connect(albert.signer).setFactory(comet.address, newFactory),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setConfiguration updates existing configuration if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    const existingConfiguration = normalizeStructOutput(await configurator.getConfiguration(comet.address));

    const updatedConfiguration = {
      ...existingConfiguration,
      baseBorrowMin: existingConfiguration.baseBorrowMin + 1n
    };

    await configurator.connect(admin.signer).setConfiguration(comet.address, updatedConfiguration);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address))).to.be.deep.equal(
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

    const existingConfiguration = normalizeStructOutput(await configurator.getConfiguration(comet.address));

    const updatedConfiguration = {
      ...existingConfiguration,
      baseBorrowMin: existingConfiguration.baseBorrowMin + 1n
    };
    await expectRevertCustom(
      configurator.connect(albert.signer).setConfiguration(comet.address, updatedConfiguration),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setConfiguration reverts if base token is changed for existing configuration',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    const existingConfiguration = normalizeStructOutput(await configurator.getConfiguration(comet.address));

    const updatedConfiguration = {
      ...existingConfiguration,
      baseToken: await deployMockERC20(context, 'baseToken')
    };

    await expectRevertCustom(
      configurator.connect(admin.signer).setConfiguration(comet.address, updatedConfiguration),
      'ConfigurationAlreadyExists()'
    );
  }
);

scenario(
  'Configurator#setConfiguration reverts if tracking index scale is changed for existing configuration',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    const existingConfiguration = normalizeStructOutput(await configurator.getConfiguration(comet.address));

    const updatedConfiguration = {
      ...existingConfiguration,
      trackingIndexScale: existingConfiguration.trackingIndexScale + 1n
    };

    await expectRevertCustom(
      configurator.connect(admin.signer).setConfiguration(comet.address, updatedConfiguration),
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
    await configurator.connect(admin.signer).setGovernor(comet.address, newGovernor);

    expect((await configurator.getConfiguration(comet.address)).governor).to.be.equal(newGovernor);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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

    await configurator.connect(admin.signer).setGovernor(comet.address, firstNewGovernor);

    expect((await configurator.getConfiguration(comet.address)).governor).to.be.equal(firstNewGovernor);

    await configurator.connect(admin.signer).setGovernor(comet.address, secondNewGovernor);

    expect((await configurator.getConfiguration(comet.address)).governor).to.be.equal(secondNewGovernor);
  }
);

scenario(
  'Configurator#setGovernor reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;
    const newGovernor = await deployTimelock(context);

    await expectRevertCustom(
      configurator.connect(albert.signer).setGovernor(comet.address, newGovernor),
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
    await configurator.connect(admin.signer).setPauseGuardian(comet.address, newPauseGuardian);

    expect((await configurator.getConfiguration(comet.address)).pauseGuardian).to.be.equal(newPauseGuardian);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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

    await configurator.connect(admin.signer).setPauseGuardian(comet.address, firstNewPauseGuardian);

    expect((await configurator.getConfiguration(comet.address)).pauseGuardian).to.be.equal(firstNewPauseGuardian);

    await configurator.connect(admin.signer).setPauseGuardian(comet.address, secondNewPauseGuardian);

    expect((await configurator.getConfiguration(comet.address)).pauseGuardian).to.be.equal(secondNewPauseGuardian);
  }
);

scenario(
  'Configurator#setPauseGuardian reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const newPauseGuardian = await ethers.Wallet.createRandom().getAddress();

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

    await configurator.connect(admin.signer).setBaseTokenPriceFeed(comet.address, newPriceFeed);

    expect((await configurator.getConfiguration(comet.address)).baseTokenPriceFeed).to.be.equal(newPriceFeed);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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

    await configurator.connect(admin.signer).setBaseTokenPriceFeed(comet.address, firstNewPriceFeed);

    expect((await configurator.getConfiguration(comet.address)).baseTokenPriceFeed).to.be.equal(firstNewPriceFeed);

    await configurator.connect(admin.signer).setBaseTokenPriceFeed(comet.address, secondNewPriceFeed);

    expect((await configurator.getConfiguration(comet.address)).baseTokenPriceFeed).to.be.equal(secondNewPriceFeed);
  }
);

scenario(
  'Configurator#setBaseTokenPriceFeed reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { albert } = actors;

    const newPriceFeed = await deployPriceFeed(context, 'baseToken');

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

    const newExtensionDelegate = await deployCometExt(context);

    await configurator.connect(admin.signer).setExtensionDelegate(comet.address, newExtensionDelegate);

    expect((await configurator.getConfiguration(comet.address)).extensionDelegate).to.be.equal(newExtensionDelegate);
  }
);

scenario(
  'Configurator#setExtensionDelegate can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;

    const firstNewExtensionDelegate = await deployCometExt(context);
    const secondNewExtensionDelegate = await deployCometExt(context, true);

    await configurator.connect(admin.signer).setExtensionDelegate(comet.address, firstNewExtensionDelegate);

    expect((await configurator.getConfiguration(comet.address)).extensionDelegate).to.be.equal(
      firstNewExtensionDelegate
    );

    await configurator.connect(admin.signer).setExtensionDelegate(comet.address, secondNewExtensionDelegate);

    expect((await configurator.getConfiguration(comet.address)).extensionDelegate).to.be.equal(
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
      configurator.connect(albert.signer).setExtensionDelegate(comet.address, newExtensionDelegate),
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
      await configurator.getConfiguration(comet.address)
    ).storeFrontPriceFactor;

    const newStoreFrontPriceFactor = oldStoreFrontPriceFactor + 1n;
    await configurator.connect(admin.signer).setStoreFrontPriceFactor(comet.address, newStoreFrontPriceFactor);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).storeFrontPriceFactor).to.be.equal(
      newStoreFrontPriceFactor
    );

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.storeFrontPriceFactor()).to.be.equal(newStoreFrontPriceFactor);
  }
);
scenario(
  'Configurator#setStoreFrontPriceFactor can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const initialStoreFrontPriceFactor = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).storeFrontPriceFactor;

    const firstStoreFrontPriceFactor = initialStoreFrontPriceFactor + 1n;
    const secondStoreFrontPriceFactor = firstStoreFrontPriceFactor + 1n;

    await configurator.connect(admin.signer).setStoreFrontPriceFactor(comet.address, firstStoreFrontPriceFactor);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).storeFrontPriceFactor).to.be.equal(
      firstStoreFrontPriceFactor
    );

    await configurator.connect(admin.signer).setStoreFrontPriceFactor(comet.address, secondStoreFrontPriceFactor);

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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    const oldBaseMinForRewards = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseMinForRewards;

    const newBaseMinForRewards = oldBaseMinForRewards + 1n;
    await configurator.connect(admin.signer).setBaseMinForRewards(comet.address, newBaseMinForRewards);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseMinForRewards).to.be.equal(
      newBaseMinForRewards
    );

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.baseMinForRewards()).to.be.equal(newBaseMinForRewards);
  }
);

scenario(
  'Configurator#setBaseMinForRewards can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const initialBaseMinForRewards = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseMinForRewards;

    const firstBaseMinForRewards = initialBaseMinForRewards + 1n;
    const secondBaseMinForRewards = firstBaseMinForRewards + 1n;

    await configurator.connect(admin.signer).setBaseMinForRewards(comet.address, firstBaseMinForRewards);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseMinForRewards).to.be.equal(
      firstBaseMinForRewards
    );

    await configurator.connect(admin.signer).setBaseMinForRewards(comet.address, secondBaseMinForRewards);

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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    const oldTargetReserves = normalizeStructOutput(await configurator.getConfiguration(comet.address)).targetReserves;

    const newTargetReserves = oldTargetReserves + 1n;
    await configurator.connect(admin.signer).setTargetReserves(comet.address, newTargetReserves);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).targetReserves).to.be.equal(
      newTargetReserves
    );

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.targetReserves()).to.be.equal(newTargetReserves);
  }
);

scenario(
  'Configurator#setTargetReserves can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    const initialTargetReserves = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).targetReserves;

    const firstTargetReserves = initialTargetReserves + 1n;
    const secondTargetReserves = firstTargetReserves + 1n;

    await configurator.connect(admin.signer).setTargetReserves(comet.address, firstTargetReserves);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).targetReserves).to.be.equal(
      firstTargetReserves
    );

    await configurator.connect(admin.signer).setTargetReserves(comet.address, secondTargetReserves);

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
      asset: await deployMockERC20(context, 'asset'),
      priceFeed: await deployPriceFeed(context, 'asset'),
      decimals: 18,
      borrowCollateralFactor: exp(0.8, 18),
      liquidateCollateralFactor: exp(0.85, 18),
      liquidationFactor: exp(0.9, 18),
      supplyCap: exp(5e6, 18)
    };

    await configurator.connect(admin.signer).addAsset(comet.address, newAssetConfig);
    const assetConfigsAfter = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs;

    expect(assetConfigsAfter.length).to.be.equal(numAssetsBefore + 1);
    expect(assetConfigsAfter.at(-1)).to.be.deep.equal(newAssetConfig);
  }
);

scenario('Configurator#addAsset can add multiple assets', {}, async ({ comet, configurator, actors }, context) => {
  const { admin } = actors;

  const numAssetsBefore = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.length;

  const firstNewAssetConfig = {
    asset: await deployMockERC20(context, 'asset'),
    priceFeed: await deployPriceFeed(context, 'asset'),
    decimals: 18,
    borrowCollateralFactor: exp(0.8, 18),
    liquidateCollateralFactor: exp(0.85, 18),
    liquidationFactor: exp(0.9, 18),
    supplyCap: exp(5e6, 18)
  };

  const secondNewAssetConfig = {
    asset: await deployMockERC20(context, 'asset', true),
    priceFeed: await deployPriceFeed(context, 'asset', true),
    decimals: 6,
    borrowCollateralFactor: exp(0.8, 18),
    liquidateCollateralFactor: exp(0.85, 18),
    liquidationFactor: exp(0.9, 18),
    supplyCap: exp(5e6, 6)
  };

  await configurator.connect(admin.signer).addAsset(comet.address, firstNewAssetConfig);
  await configurator.connect(admin.signer).addAsset(comet.address, secondNewAssetConfig);
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
        asset: await deployMockERC20(context, 'asset'),
        priceFeed: await deployPriceFeed(context, 'asset'),
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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const assetIndex = -1;
    const assetConfigsBefore = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs;
    const existingAssetConfig = assetConfigsBefore.at(assetIndex);

    const updatedAssetConfig = {
      ...existingAssetConfig,
      borrowCollateralFactor: existingAssetConfig.borrowCollateralFactor + MIN_FACTOR_INCREMENT,
      liquidateCollateralFactor: existingAssetConfig.liquidateCollateralFactor + MIN_FACTOR_INCREMENT
    };

    await configurator.connect(admin.signer).updateAsset(comet.address, updatedAssetConfig);
    const assetConfigsAfter = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs;

    expect(assetConfigsAfter.length).to.be.equal(assetConfigsBefore.length);
    expect(assetConfigsAfter.at(assetIndex)).to.be.deep.equal(updatedAssetConfig);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
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

    await configurator.connect(admin.signer).updateAsset(comet.address, firstUpdatedAssetConfig);
    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
    ).to.be.deep.equal(firstUpdatedAssetConfig);

    await configurator.connect(admin.signer).updateAsset(comet.address, secondUpdatedAssetConfig);
    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
    ).to.be.deep.equal(secondUpdatedAssetConfig);
  }
);

scenario('Configurator#updateAsset reverts if called by non-governor', {}, async ({ comet, configurator, actors }) => {
  const { albert } = actors;

  const existingAssetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
    -1
  );

  const updatedAssetConfig = {
    ...existingAssetConfig,
    supplyCap: existingAssetConfig.supplyCap + getMinSupplyCapIncrement(existingAssetConfig.decimals)
  };

  await expectRevertCustom(
    configurator.connect(albert.signer).updateAsset(comet.address, updatedAssetConfig),
    'Unauthorized()'
  );
});

scenario('Configurator#updateAsset reverts if asset does not exist', {}, async ({ comet, configurator, actors }) => {
  const { admin } = actors;

  const existingAssetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
    -1
  );

  const updatedAssetConfig = {
    ...existingAssetConfig,
    asset: await ethers.Wallet.createRandom().getAddress()
  };

  await expectRevertCustom(
    configurator.connect(admin.signer).updateAsset(comet.address, updatedAssetConfig),
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
    const existingAsset = (await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).asset;
    const newPriceFeed = await deployPriceFeed(context, 'asset');

    await configurator
      .connect(admin.signer)
      .updateAssetPriceFeed(comet.address, existingAsset, newPriceFeed);

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

    const firstNewPriceFeed = await deployPriceFeed(context, 'asset');
    const secondNewPriceFeed = await deployPriceFeed(context, 'asset', true);

    await configurator
      .connect(admin.signer)
      .updateAssetPriceFeed(comet.address, existingAsset, firstNewPriceFeed);

    expect((await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).priceFeed).to.be.equal(
      firstNewPriceFeed
    );

    await configurator
      .connect(admin.signer)
      .updateAssetPriceFeed(comet.address, existingAsset, secondNewPriceFeed);

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
    const newPriceFeed = await deployPriceFeed(context, 'asset');

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

    const nonExistingAsset = await ethers.Wallet.createRandom().getAddress();
    const newPriceFeed = await deployPriceFeed(context, 'asset');

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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldSupplyKink = normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyKink;
    const newSupplyKink = oldSupplyKink + 1n;

    await configurator.connect(admin.signer).setSupplyKink(comet.address, newSupplyKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyKink).to.be.equal(
      newSupplyKink
    );

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect((await comet.supplyKink()).toBigInt()).to.be.equal(newSupplyKink);
  }
);

scenario(
  'Configurator#setSupplyKink can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldSupplyKink = normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyKink;
    const firstNewSupplyKink = oldSupplyKink + 1n;
    const secondNewSupplyKink = firstNewSupplyKink + 1n;

    await configurator.connect(admin.signer).setSupplyKink(comet.address, firstNewSupplyKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyKink).to.be.equal(
      firstNewSupplyKink
    );

    await configurator.connect(admin.signer).setSupplyKink(comet.address, secondNewSupplyKink);

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

    await configurator.connect(marketAdminSigner).setSupplyKink(comet.address, newSupplyKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyKink).to.be.equal(
      newSupplyKink
    );

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateSlopeLow;

    const newSupplyPerYearInterestRateSlopeLow = oldSupplyPerYearInterestRateSlopeLow + 1n;

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeLow(comet.address, newSupplyPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeLow
    ).to.be.equal(newSupplyPerYearInterestRateSlopeLow);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect((await comet.supplyPerSecondInterestRateSlopeLow()).toBigInt()).to.be.equal(
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
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateSlopeLow;

    const firstNewSupplyPerYearInterestRateSlopeLow = oldSupplyPerYearInterestRateSlopeLow + 1n;
    const secondNewSupplyPerYearInterestRateSlopeLow = firstNewSupplyPerYearInterestRateSlopeLow + 1n;

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeLow(comet.address, firstNewSupplyPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeLow
    ).to.be.equal(firstNewSupplyPerYearInterestRateSlopeLow);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeLow(comet.address, secondNewSupplyPerYearInterestRateSlopeLow);

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

    await configurator
      .connect(marketAdminSigner)
      .setSupplyPerYearInterestRateSlopeLow(comet.address, newSupplyPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeLow
    ).to.be.equal(newSupplyPerYearInterestRateSlopeLow);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateSlopeHigh;

    const newSupplyPerYearInterestRateSlopeHigh = oldSupplyPerYearInterestRateSlopeHigh + 1n;

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeHigh(comet.address, newSupplyPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeHigh
    ).to.be.equal(newSupplyPerYearInterestRateSlopeHigh);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect((await comet.supplyPerSecondInterestRateSlopeHigh()).toBigInt()).to.be.equal(
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
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateSlopeHigh;

    const firstNewSupplyPerYearInterestRateSlopeHigh = oldSupplyPerYearInterestRateSlopeHigh + 1n;
    const secondNewSupplyPerYearInterestRateSlopeHigh = firstNewSupplyPerYearInterestRateSlopeHigh + 1n;

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeHigh(comet.address, firstNewSupplyPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeHigh
    ).to.be.equal(firstNewSupplyPerYearInterestRateSlopeHigh);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeHigh(comet.address, secondNewSupplyPerYearInterestRateSlopeHigh);

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

    await configurator
      .connect(marketAdminSigner)
      .setSupplyPerYearInterestRateSlopeHigh(comet.address, newSupplyPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeHigh
    ).to.be.equal(newSupplyPerYearInterestRateSlopeHigh);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldSupplyPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateBase;

    const newSupplyPerYearInterestRateBase = oldSupplyPerYearInterestRateBase + 1n;

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateBase(comet.address, newSupplyPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateBase
    ).to.be.equal(newSupplyPerYearInterestRateBase);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect((await comet.supplyPerSecondInterestRateBase()).toBigInt()).to.be.equal(
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
      await configurator.getConfiguration(comet.address)
    ).supplyPerYearInterestRateBase;

    const firstNewSupplyPerYearInterestRateBase = oldSupplyPerYearInterestRateBase + 1n;
    const secondNewSupplyPerYearInterestRateBase = firstNewSupplyPerYearInterestRateBase + 1n;

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateBase(comet.address, firstNewSupplyPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateBase
    ).to.be.equal(firstNewSupplyPerYearInterestRateBase);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateBase(comet.address, secondNewSupplyPerYearInterestRateBase);

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

    await configurator
      .connect(marketAdminSigner)
      .setSupplyPerYearInterestRateBase(comet.address, newSupplyPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateBase
    ).to.be.equal(newSupplyPerYearInterestRateBase);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBorrowKink = normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowKink;
    const newBorrowKink = oldBorrowKink + 1n;

    await configurator.connect(admin.signer).setBorrowKink(comet.address, newBorrowKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowKink).to.be.equal(
      newBorrowKink
    );

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect((await comet.borrowKink()).toBigInt()).to.be.equal(newBorrowKink);
  }
);

scenario(
  'Configurator#setBorrowKink can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBorrowKink = normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowKink;
    const firstNewBorrowKink = oldBorrowKink + 1n;
    const secondNewBorrowKink = firstNewBorrowKink + 1n;

    await configurator.connect(admin.signer).setBorrowKink(comet.address, firstNewBorrowKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowKink).to.be.equal(
      firstNewBorrowKink
    );

    await configurator.connect(admin.signer).setBorrowKink(comet.address, secondNewBorrowKink);

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

    await configurator.connect(marketAdminSigner).setBorrowKink(comet.address, newBorrowKink);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowKink).to.be.equal(
      newBorrowKink
    );

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateSlopeLow = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateSlopeLow;

    const newBorrowPerYearInterestRateSlopeLow = oldBorrowPerYearInterestRateSlopeLow + 1n;

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeLow(comet.address, newBorrowPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeLow
    ).to.be.equal(newBorrowPerYearInterestRateSlopeLow);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect((await comet.borrowPerSecondInterestRateSlopeLow()).toBigInt()).to.be.equal(
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
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateSlopeLow;

    const firstNewBorrowPerYearInterestRateSlopeLow = oldBorrowPerYearInterestRateSlopeLow + 1n;
    const secondNewBorrowPerYearInterestRateSlopeLow = firstNewBorrowPerYearInterestRateSlopeLow + 1n;

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeLow(comet.address, firstNewBorrowPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeLow
    ).to.be.equal(firstNewBorrowPerYearInterestRateSlopeLow);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeLow(comet.address, secondNewBorrowPerYearInterestRateSlopeLow);

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

    await configurator
      .connect(marketAdminSigner)
      .setBorrowPerYearInterestRateSlopeLow(comet.address, newBorrowPerYearInterestRateSlopeLow);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeLow
    ).to.be.equal(newBorrowPerYearInterestRateSlopeLow);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateSlopeHigh = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateSlopeHigh;

    const newBorrowPerYearInterestRateSlopeHigh = oldBorrowPerYearInterestRateSlopeHigh + 1n;

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeHigh(comet.address, newBorrowPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeHigh
    ).to.be.equal(newBorrowPerYearInterestRateSlopeHigh);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect((await comet.borrowPerSecondInterestRateSlopeHigh()).toBigInt()).to.be.equal(
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
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateSlopeHigh;

    const firstNewBorrowPerYearInterestRateSlopeHigh = oldBorrowPerYearInterestRateSlopeHigh + 1n;
    const secondNewBorrowPerYearInterestRateSlopeHigh = oldBorrowPerYearInterestRateSlopeHigh + 2n;

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeHigh(comet.address, firstNewBorrowPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeHigh
    ).to.be.equal(firstNewBorrowPerYearInterestRateSlopeHigh);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeHigh(comet.address, secondNewBorrowPerYearInterestRateSlopeHigh);

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

    await configurator
      .connect(marketAdminSigner)
      .setBorrowPerYearInterestRateSlopeHigh(comet.address, newBorrowPerYearInterestRateSlopeHigh);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeHigh
    ).to.be.equal(newBorrowPerYearInterestRateSlopeHigh);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBorrowPerYearInterestRateBase = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateBase;

    const newBorrowPerYearInterestRateBase = oldBorrowPerYearInterestRateBase + 1n;

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateBase(comet.address, newBorrowPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateBase
    ).to.be.equal(newBorrowPerYearInterestRateBase);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect((await comet.borrowPerSecondInterestRateBase()).toBigInt()).to.be.equal(
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
      await configurator.getConfiguration(comet.address)
    ).borrowPerYearInterestRateBase;

    const firstNewBorrowPerYearInterestRateBase = oldBorrowPerYearInterestRateBase + 1n;
    const secondNewBorrowPerYearInterestRateBase = firstNewBorrowPerYearInterestRateBase + 1n;

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateBase(comet.address, firstNewBorrowPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateBase
    ).to.be.equal(firstNewBorrowPerYearInterestRateBase);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateBase(comet.address, secondNewBorrowPerYearInterestRateBase);

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

    await configurator
      .connect(marketAdminSigner)
      .setBorrowPerYearInterestRateBase(comet.address, newBorrowPerYearInterestRateBase);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateBase
    ).to.be.equal(newBorrowPerYearInterestRateBase);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBaseTrackingSupplySpeed = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseTrackingSupplySpeed;

    const newBaseTrackingSupplySpeed = oldBaseTrackingSupplySpeed + 1n;

    await configurator.connect(admin.signer).setBaseTrackingSupplySpeed(comet.address, newBaseTrackingSupplySpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingSupplySpeed
    ).to.be.equal(newBaseTrackingSupplySpeed);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect((await comet.baseTrackingSupplySpeed()).toBigInt()).to.be.equal(newBaseTrackingSupplySpeed);
  }
);

scenario(
  'Configurator#setBaseTrackingSupplySpeed can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBaseTrackingSupplySpeed = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseTrackingSupplySpeed;

    const firstNewBaseTrackingSupplySpeed = oldBaseTrackingSupplySpeed + 1n;
    const secondNewBaseTrackingSupplySpeed = firstNewBaseTrackingSupplySpeed + 1n;

    await configurator
      .connect(admin.signer)
      .setBaseTrackingSupplySpeed(comet.address, firstNewBaseTrackingSupplySpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingSupplySpeed
    ).to.be.equal(firstNewBaseTrackingSupplySpeed);

    await configurator
      .connect(admin.signer)
      .setBaseTrackingSupplySpeed(comet.address, secondNewBaseTrackingSupplySpeed);

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

    await configurator
      .connect(marketAdminSigner)
      .setBaseTrackingSupplySpeed(comet.address, newBaseTrackingSupplySpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingSupplySpeed
    ).to.be.equal(newBaseTrackingSupplySpeed);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBaseTrackingBorrowSpeed = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseTrackingBorrowSpeed;

    const newBaseTrackingBorrowSpeed = oldBaseTrackingBorrowSpeed + 1n;

    await configurator.connect(admin.signer).setBaseTrackingBorrowSpeed(comet.address, newBaseTrackingBorrowSpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingBorrowSpeed
    ).to.be.equal(newBaseTrackingBorrowSpeed);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect((await comet.baseTrackingBorrowSpeed()).toBigInt()).to.be.equal(newBaseTrackingBorrowSpeed);
  }
);

scenario(
  'Configurator#setBaseTrackingBorrowSpeed can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBaseTrackingBorrowSpeed = normalizeStructOutput(
      await configurator.getConfiguration(comet.address)
    ).baseTrackingBorrowSpeed;

    const firstNewBaseTrackingBorrowSpeed = oldBaseTrackingBorrowSpeed + 1n;
    const secondNewBaseTrackingBorrowSpeed = firstNewBaseTrackingBorrowSpeed + 1n;

    await configurator
      .connect(admin.signer)
      .setBaseTrackingBorrowSpeed(comet.address, firstNewBaseTrackingBorrowSpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingBorrowSpeed
    ).to.be.equal(firstNewBaseTrackingBorrowSpeed);

    await configurator
      .connect(admin.signer)
      .setBaseTrackingBorrowSpeed(comet.address, secondNewBaseTrackingBorrowSpeed);

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

    await configurator
      .connect(marketAdminSigner)
      .setBaseTrackingBorrowSpeed(comet.address, newBaseTrackingBorrowSpeed);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseTrackingBorrowSpeed
    ).to.be.equal(newBaseTrackingBorrowSpeed);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBaseBorrowMin = normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseBorrowMin;
    const newBaseBorrowMin = oldBaseBorrowMin + 1n;

    await configurator.connect(admin.signer).setBaseBorrowMin(comet.address, newBaseBorrowMin);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseBorrowMin).to.be.equal(
      newBaseBorrowMin
    );

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect((await comet.baseBorrowMin()).toBigInt()).to.be.equal(newBaseBorrowMin);
  }
);

scenario(
  'Configurator#setBaseBorrowMin can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;

    const oldBaseBorrowMin = normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseBorrowMin;
    const firstNewBaseBorrowMin = oldBaseBorrowMin + 1n;
    const secondNewBaseBorrowMin = firstNewBaseBorrowMin + 1n;

    await configurator.connect(admin.signer).setBaseBorrowMin(comet.address, firstNewBaseBorrowMin);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseBorrowMin).to.be.equal(
      firstNewBaseBorrowMin
    );

    await configurator.connect(admin.signer).setBaseBorrowMin(comet.address, secondNewBaseBorrowMin);

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

    await configurator.connect(marketAdminSigner).setBaseBorrowMin(comet.address, newBaseBorrowMin);

    expect(normalizeStructOutput(await configurator.getConfiguration(comet.address)).baseBorrowMin).to.be.equal(
      newBaseBorrowMin
    );

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
      .updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, newAssetBorrowCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(newAssetBorrowCollateralFactor);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
      assetIndex
    );
    const oldAssetBorrowCollateralFactor = assetConfig.borrowCollateralFactor;
    const firstNewAssetBorrowCollateralFactor = oldAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;
    const secondNewAssetBorrowCollateralFactor = firstNewAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(admin.signer)
      .updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, firstNewAssetBorrowCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(firstNewAssetBorrowCollateralFactor);

    await configurator
      .connect(admin.signer)
      .updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, secondNewAssetBorrowCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
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
      .updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, newAssetBorrowCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(newAssetBorrowCollateralFactor);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
      .updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, newAssetBorrowCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(newAssetBorrowCollateralFactor);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
      .updateAssetBorrowCollateralFactor(comet.address, assetConfig.asset, newAssetBorrowCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .borrowCollateralFactor
    ).to.be.equal(newAssetBorrowCollateralFactor);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    const assetInfo = normalizeStructOutput(await comet.getAssetInfoByAddress(assetConfig.asset));

    expect(assetInfo.borrowCollateralFactor).to.be.equal(newAssetBorrowCollateralFactor);
  }
);

scenario(
  'Configurator#updateAssetBorrowCollateralFactor reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(-1);
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
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    // use the existing config to get a valid factor value
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(-1);
    const oldAssetBorrowCollateralFactor = assetConfig.borrowCollateralFactor;
    const newAssetBorrowCollateralFactor = oldAssetBorrowCollateralFactor + MIN_FACTOR_INCREMENT;

    const nonExistingAsset = await ethers.Wallet.createRandom().getAddress();

    await expectRevertCustom(
      configurator
        .connect(admin.signer)
        .updateAssetBorrowCollateralFactor(comet.address, nonExistingAsset, newAssetBorrowCollateralFactor),
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
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
      assetIndex
    );
    const oldAssetLiquidateCollateralFactor = assetConfig.liquidateCollateralFactor;
    const newAssetLiquidateCollateralFactor = oldAssetLiquidateCollateralFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(admin.signer)
      .updateAssetLiquidateCollateralFactor(comet.address, assetConfig.asset, newAssetLiquidateCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidateCollateralFactor
    ).to.be.equal(newAssetLiquidateCollateralFactor);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
      assetIndex
    );
    const oldAssetLiquidateCollateralFactor = assetConfig.liquidateCollateralFactor;
    const firstNewAssetLiquidateCollateralFactor = oldAssetLiquidateCollateralFactor + MIN_FACTOR_INCREMENT;
    const secondNewAssetLiquidateCollateralFactor = firstNewAssetLiquidateCollateralFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(admin.signer)
      .updateAssetLiquidateCollateralFactor(comet.address, assetConfig.asset, firstNewAssetLiquidateCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidateCollateralFactor
    ).to.be.equal(firstNewAssetLiquidateCollateralFactor);

    await configurator
      .connect(admin.signer)
      .updateAssetLiquidateCollateralFactor(comet.address, assetConfig.asset, secondNewAssetLiquidateCollateralFactor);

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
    const assetIndex = -1;
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
      assetIndex
    );
    const oldAssetLiquidateCollateralFactor = assetConfig.liquidateCollateralFactor;
    const newAssetLiquidateCollateralFactor = oldAssetLiquidateCollateralFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(marketAdminSigner)
      .updateAssetLiquidateCollateralFactor(comet.address, assetConfig.asset, newAssetLiquidateCollateralFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidateCollateralFactor
    ).to.be.equal(newAssetLiquidateCollateralFactor);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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

    const nonExistingAsset = await ethers.Wallet.createRandom().getAddress();

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, nonExistingAsset, 1n),
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
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
      assetIndex
    );
    const oldAssetLiquidationFactor = assetConfig.liquidationFactor;
    const newAssetLiquidationFactor = oldAssetLiquidationFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(admin.signer)
      .updateAssetLiquidationFactor(comet.address, assetConfig.asset, newAssetLiquidationFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidationFactor
    ).to.be.equal(newAssetLiquidationFactor);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
      assetIndex
    );
    const oldAssetLiquidationFactor = assetConfig.liquidationFactor;
    const firstNewAssetLiquidationFactor = oldAssetLiquidationFactor + MIN_FACTOR_INCREMENT;
    const secondNewAssetLiquidationFactor = firstNewAssetLiquidationFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(admin.signer)
      .updateAssetLiquidationFactor(comet.address, assetConfig.asset, firstNewAssetLiquidationFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidationFactor
    ).to.be.equal(firstNewAssetLiquidationFactor);

    await configurator
      .connect(admin.signer)
      .updateAssetLiquidationFactor(comet.address, assetConfig.asset, secondNewAssetLiquidationFactor);

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
    const assetIndex = -1;
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
      assetIndex
    );
    const oldAssetLiquidationFactor = assetConfig.liquidationFactor;
    const newAssetLiquidationFactor = oldAssetLiquidationFactor + MIN_FACTOR_INCREMENT;

    await configurator
      .connect(marketAdminSigner)
      .updateAssetLiquidationFactor(comet.address, assetConfig.asset, newAssetLiquidationFactor);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex)
        .liquidationFactor
    ).to.be.equal(newAssetLiquidationFactor);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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

    const nonExistingAsset = await ethers.Wallet.createRandom().getAddress();

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, nonExistingAsset, 1n),
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
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
      assetIndex
    );
    const oldAssetSupplyCap = assetConfig.supplyCap;
    const newAssetSupplyCap = oldAssetSupplyCap + getMinSupplyCapIncrement(assetConfig.decimals);

    await configurator
      .connect(admin.signer)
      .updateAssetSupplyCap(comet.address, assetConfig.asset, newAssetSupplyCap);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(newAssetSupplyCap);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
      assetIndex
    );
    const oldAssetSupplyCap = assetConfig.supplyCap;
    const firstNewAssetSupplyCap = oldAssetSupplyCap + getMinSupplyCapIncrement(assetConfig.decimals);
    const secondNewAssetSupplyCap = firstNewAssetSupplyCap + getMinSupplyCapIncrement(assetConfig.decimals);

    await configurator
      .connect(admin.signer)
      .updateAssetSupplyCap(comet.address, assetConfig.asset, firstNewAssetSupplyCap);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(firstNewAssetSupplyCap);

    await configurator
      .connect(admin.signer)
      .updateAssetSupplyCap(comet.address, assetConfig.asset, secondNewAssetSupplyCap);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).supplyCap
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
      .updateAssetSupplyCap(comet.address, assetConfig.asset, newAssetSupplyCap);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(newAssetSupplyCap);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
    const assetConfig = normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(
      assetIndex
    );
    const oldAssetSupplyCap = assetConfig.supplyCap;
    const newAssetSupplyCap = oldAssetSupplyCap + getMinSupplyCapIncrement(assetConfig.decimals);

    await configurator
      .connect(marketAdminSigner)
      .updateAssetSupplyCap(comet.address, assetConfig.asset, newAssetSupplyCap);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(newAssetSupplyCap);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
      .updateAssetSupplyCap(comet.address, assetConfig.asset, newAssetSupplyCap);

    expect(
      normalizeStructOutput(await configurator.getConfiguration(comet.address)).assetConfigs.at(assetIndex).supplyCap
    ).to.be.equal(newAssetSupplyCap);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

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
    const nonExistingAsset = await ethers.Wallet.createRandom().getAddress();

    await expectRevertCustom(
      configurator.connect(admin.signer).updateAssetSupplyCap(comet.address, nonExistingAsset, 1n),
      'AssetDoesNotExist()'
    );
  }
);
