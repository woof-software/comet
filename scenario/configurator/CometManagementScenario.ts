import { expect } from 'chai';
import { ethers } from 'ethers';
import { CometContext, scenario } from '../context/CometContext';
import { exp } from '../../test/helpers';
import { fundAccount } from '../utils';
import { SECONDS_PER_YEAR } from '../utils/constants';
import {
  normalizeStructOutput,
  deployCometExt,
  deployCometFactory,
  deployMockERC20,
  deployPriceFeed,
  deployTimelock,
} from './shared';

// The governor setters for the Comet-related fields of the Configuration (Configurator.sol, "Governance setters for
// Comet-related configuration"): each one stores the new value, can be called again, and reaches the Comet after
// a redeploy

// The Comet reads its collateral from an asset list: an implementation holding the asset and its price feed,
// behind a proxy owned by the Comet's proxy admin and initialized with the factors and supply cap
async function deployAssetList(context: CometContext): Promise<string> {
  const dm = context.world.deploymentManager;
  const cometAdmin = await context.getCometAdmin();
  const configurator = await context.getConfigurator();

  const assetListImpl = await dm.deploy('test:assetList:implementation', 'AssetList.sol', [[
    {
      asset: await deployMockERC20(context, 'asset'),
      decimals: 18,
      priceFeed: await deployPriceFeed(context, 'asset'),
    },
  ]]);
  const storageConfigs = [
    {
      borrowCollateralFactor: exp(0.65, 18), // 650000000000000000n
      liquidateCollateralFactor: exp(0.7, 18), // 700000000000000000n
      liquidationFactor: exp(0.8, 18), // 800000000000000000n
      supplyCap: exp(1.4, 24), // 1400000000000000000000000n
    },
  ];
  const assetListProxy = await dm.deploy('test:assetList', 'vendor/proxy/transparent/TransparentUpgradeableProxy.sol', [
    assetListImpl.address,
    cometAdmin.address,
    assetListImpl.interface.encodeFunctionData('initialize', [storageConfigs, configurator.address]),
  ]);

  return assetListProxy.address;
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
    assetList: await deployAssetList(context),
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

scenario(
  'Configurator#setGovernor updates governor in configuration if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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
    await fundAccount(admin.context.world, admin);

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

    await expect(
      configurator.connect(albert.signer).setGovernor(comet.address, newGovernor)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setPauseGuardian updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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
    await fundAccount(admin.context.world, admin);

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

    await expect(
      configurator.connect(albert.signer).setPauseGuardian(comet.address, newPauseGuardian)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setBaseTokenPriceFeed updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);
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
    await fundAccount(admin.context.world, admin);

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

    await expect(
      configurator.connect(albert.signer).setBaseTokenPriceFeed(comet.address, newPriceFeed)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setExtensionDelegate updates value if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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
    await fundAccount(admin.context.world, admin);

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

    await expect(
      configurator.connect(albert.signer).setExtensionDelegate(comet.address, newExtensionDelegate)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setSupplyKink updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { supplyKink } = await configurator.getConfiguration(comet.address);
    const newSupplyKink = supplyKink.add(1);

    await configurator.connect(admin.signer).setSupplyKink(comet.address, newSupplyKink);

    expect((await configurator.getConfiguration(comet.address)).supplyKink).to.be.equal(
      newSupplyKink
    );

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.supplyKink()).to.be.equal(newSupplyKink);
  }
);

scenario(
  'Configurator#setSupplyKink can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { supplyKink } = await configurator.getConfiguration(comet.address);
    const firstNewSupplyKink = supplyKink.add(1);
    const secondNewSupplyKink = firstNewSupplyKink.add(1);

    await configurator.connect(admin.signer).setSupplyKink(comet.address, firstNewSupplyKink);

    expect((await configurator.getConfiguration(comet.address)).supplyKink).to.be.equal(
      firstNewSupplyKink
    );

    await configurator.connect(admin.signer).setSupplyKink(comet.address, secondNewSupplyKink);

    expect((await configurator.getConfiguration(comet.address)).supplyKink).to.be.equal(
      secondNewSupplyKink
    );
  }
);

scenario(
  'Configurator#setSupplyKink reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { supplyKink } = await configurator.getConfiguration(comet.address);
    const newSupplyKink = supplyKink.add(1);

    await expect(
      configurator.connect(albert.signer).setSupplyKink(comet.address, newSupplyKink)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeLow updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { supplyPerYearInterestRateSlopeLow } = await configurator.getConfiguration(comet.address);

    const newSupplyPerYearInterestRateSlopeLow = supplyPerYearInterestRateSlopeLow.add(1);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeLow(comet.address, newSupplyPerYearInterestRateSlopeLow);

    expect(
      (await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeLow
    ).to.be.equal(newSupplyPerYearInterestRateSlopeLow);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.supplyPerSecondInterestRateSlopeLow()).to.be.equal(
      newSupplyPerYearInterestRateSlopeLow.div(SECONDS_PER_YEAR)
    );
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeLow can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { supplyPerYearInterestRateSlopeLow } = await configurator.getConfiguration(comet.address);

    const firstNewSupplyPerYearInterestRateSlopeLow = supplyPerYearInterestRateSlopeLow.add(1);
    const secondNewSupplyPerYearInterestRateSlopeLow = firstNewSupplyPerYearInterestRateSlopeLow.add(1);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeLow(comet.address, firstNewSupplyPerYearInterestRateSlopeLow);

    expect(
      (await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeLow
    ).to.be.equal(firstNewSupplyPerYearInterestRateSlopeLow);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeLow(comet.address, secondNewSupplyPerYearInterestRateSlopeLow);

    expect(
      (await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeLow
    ).to.be.equal(secondNewSupplyPerYearInterestRateSlopeLow);
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeLow reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { supplyPerYearInterestRateSlopeLow } = await configurator.getConfiguration(comet.address);
    const newSupplyPerYearInterestRateSlopeLow = supplyPerYearInterestRateSlopeLow.add(1);

    await expect(
      configurator
        .connect(albert.signer)
        .setSupplyPerYearInterestRateSlopeLow(comet.address, newSupplyPerYearInterestRateSlopeLow)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeHigh updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { supplyPerYearInterestRateSlopeHigh } = await configurator.getConfiguration(comet.address);

    const newSupplyPerYearInterestRateSlopeHigh = supplyPerYearInterestRateSlopeHigh.add(1);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeHigh(comet.address, newSupplyPerYearInterestRateSlopeHigh);

    expect(
      (await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeHigh
    ).to.be.equal(newSupplyPerYearInterestRateSlopeHigh);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.supplyPerSecondInterestRateSlopeHigh()).to.be.equal(
      newSupplyPerYearInterestRateSlopeHigh.div(SECONDS_PER_YEAR)
    );
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeHigh can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { supplyPerYearInterestRateSlopeHigh } = await configurator.getConfiguration(comet.address);

    const firstNewSupplyPerYearInterestRateSlopeHigh = supplyPerYearInterestRateSlopeHigh.add(1);
    const secondNewSupplyPerYearInterestRateSlopeHigh = firstNewSupplyPerYearInterestRateSlopeHigh.add(1);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeHigh(comet.address, firstNewSupplyPerYearInterestRateSlopeHigh);

    expect(
      (await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeHigh
    ).to.be.equal(firstNewSupplyPerYearInterestRateSlopeHigh);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateSlopeHigh(comet.address, secondNewSupplyPerYearInterestRateSlopeHigh);

    expect(
      (await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateSlopeHigh
    ).to.be.equal(secondNewSupplyPerYearInterestRateSlopeHigh);
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateSlopeHigh reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { supplyPerYearInterestRateSlopeHigh } = await configurator.getConfiguration(comet.address);
    const newSupplyPerYearInterestRateSlopeHigh = supplyPerYearInterestRateSlopeHigh.add(1);

    await expect(
      configurator
        .connect(albert.signer)
        .setSupplyPerYearInterestRateSlopeHigh(comet.address, newSupplyPerYearInterestRateSlopeHigh)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateBase updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { supplyPerYearInterestRateBase } = await configurator.getConfiguration(comet.address);

    const newSupplyPerYearInterestRateBase = supplyPerYearInterestRateBase.add(1);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateBase(comet.address, newSupplyPerYearInterestRateBase);

    expect(
      (await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateBase
    ).to.be.equal(newSupplyPerYearInterestRateBase);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.supplyPerSecondInterestRateBase()).to.be.equal(
      newSupplyPerYearInterestRateBase.div(SECONDS_PER_YEAR)
    );
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateBase can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { supplyPerYearInterestRateBase } = await configurator.getConfiguration(comet.address);

    const firstNewSupplyPerYearInterestRateBase = supplyPerYearInterestRateBase.add(1);
    const secondNewSupplyPerYearInterestRateBase = firstNewSupplyPerYearInterestRateBase.add(1);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateBase(comet.address, firstNewSupplyPerYearInterestRateBase);

    expect(
      (await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateBase
    ).to.be.equal(firstNewSupplyPerYearInterestRateBase);

    await configurator
      .connect(admin.signer)
      .setSupplyPerYearInterestRateBase(comet.address, secondNewSupplyPerYearInterestRateBase);

    expect(
      (await configurator.getConfiguration(comet.address)).supplyPerYearInterestRateBase
    ).to.be.equal(secondNewSupplyPerYearInterestRateBase);
  }
);

scenario(
  'Configurator#setSupplyPerYearInterestRateBase reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { supplyPerYearInterestRateBase } = await configurator.getConfiguration(comet.address);
    const newSupplyPerYearInterestRateBase = supplyPerYearInterestRateBase.add(1);

    await expect(
      configurator
        .connect(albert.signer)
        .setSupplyPerYearInterestRateBase(comet.address, newSupplyPerYearInterestRateBase)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setBorrowKink updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { borrowKink } = await configurator.getConfiguration(comet.address);
    const newBorrowKink = borrowKink.add(1);

    await configurator.connect(admin.signer).setBorrowKink(comet.address, newBorrowKink);

    expect((await configurator.getConfiguration(comet.address)).borrowKink).to.be.equal(
      newBorrowKink
    );

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.borrowKink()).to.be.equal(newBorrowKink);
  }
);

scenario(
  'Configurator#setBorrowKink can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { borrowKink } = await configurator.getConfiguration(comet.address);
    const firstNewBorrowKink = borrowKink.add(1);
    const secondNewBorrowKink = firstNewBorrowKink.add(1);

    await configurator.connect(admin.signer).setBorrowKink(comet.address, firstNewBorrowKink);

    expect((await configurator.getConfiguration(comet.address)).borrowKink).to.be.equal(
      firstNewBorrowKink
    );

    await configurator.connect(admin.signer).setBorrowKink(comet.address, secondNewBorrowKink);

    expect((await configurator.getConfiguration(comet.address)).borrowKink).to.be.equal(
      secondNewBorrowKink
    );
  }
);

scenario(
  'Configurator#setBorrowKink reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { borrowKink } = await configurator.getConfiguration(comet.address);
    const newBorrowKink = borrowKink.add(1);

    await expect(
      configurator.connect(albert.signer).setBorrowKink(comet.address, newBorrowKink)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeLow updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { borrowPerYearInterestRateSlopeLow } = await configurator.getConfiguration(comet.address);

    const newBorrowPerYearInterestRateSlopeLow = borrowPerYearInterestRateSlopeLow.add(1);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeLow(comet.address, newBorrowPerYearInterestRateSlopeLow);

    expect(
      (await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeLow
    ).to.be.equal(newBorrowPerYearInterestRateSlopeLow);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.borrowPerSecondInterestRateSlopeLow()).to.be.equal(
      newBorrowPerYearInterestRateSlopeLow.div(SECONDS_PER_YEAR)
    );
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeLow can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { borrowPerYearInterestRateSlopeLow } = await configurator.getConfiguration(comet.address);

    const firstNewBorrowPerYearInterestRateSlopeLow = borrowPerYearInterestRateSlopeLow.add(1);
    const secondNewBorrowPerYearInterestRateSlopeLow = firstNewBorrowPerYearInterestRateSlopeLow.add(1);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeLow(comet.address, firstNewBorrowPerYearInterestRateSlopeLow);

    expect(
      (await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeLow
    ).to.be.equal(firstNewBorrowPerYearInterestRateSlopeLow);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeLow(comet.address, secondNewBorrowPerYearInterestRateSlopeLow);

    expect(
      (await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeLow
    ).to.be.equal(secondNewBorrowPerYearInterestRateSlopeLow);
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeLow reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { borrowPerYearInterestRateSlopeLow } = await configurator.getConfiguration(comet.address);
    const newBorrowPerYearInterestRateSlopeLow = borrowPerYearInterestRateSlopeLow.add(1);

    await expect(
      configurator
        .connect(albert.signer)
        .setBorrowPerYearInterestRateSlopeLow(comet.address, newBorrowPerYearInterestRateSlopeLow)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeHigh updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { borrowPerYearInterestRateSlopeHigh } = await configurator.getConfiguration(comet.address);

    const newBorrowPerYearInterestRateSlopeHigh = borrowPerYearInterestRateSlopeHigh.add(1);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeHigh(comet.address, newBorrowPerYearInterestRateSlopeHigh);

    expect(
      (await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeHigh
    ).to.be.equal(newBorrowPerYearInterestRateSlopeHigh);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.borrowPerSecondInterestRateSlopeHigh()).to.be.equal(
      newBorrowPerYearInterestRateSlopeHigh.div(SECONDS_PER_YEAR)
    );
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeHigh can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { borrowPerYearInterestRateSlopeHigh } = await configurator.getConfiguration(comet.address);

    const firstNewBorrowPerYearInterestRateSlopeHigh = borrowPerYearInterestRateSlopeHigh.add(1);
    const secondNewBorrowPerYearInterestRateSlopeHigh = borrowPerYearInterestRateSlopeHigh.add(2);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeHigh(comet.address, firstNewBorrowPerYearInterestRateSlopeHigh);

    expect(
      (await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeHigh
    ).to.be.equal(firstNewBorrowPerYearInterestRateSlopeHigh);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateSlopeHigh(comet.address, secondNewBorrowPerYearInterestRateSlopeHigh);

    expect(
      (await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateSlopeHigh
    ).to.be.equal(secondNewBorrowPerYearInterestRateSlopeHigh);
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateSlopeHigh reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { borrowPerYearInterestRateSlopeHigh } = await configurator.getConfiguration(comet.address);
    const newBorrowPerYearInterestRateSlopeHigh = borrowPerYearInterestRateSlopeHigh.add(1);

    await expect(
      configurator
        .connect(albert.signer)
        .setBorrowPerYearInterestRateSlopeHigh(comet.address, newBorrowPerYearInterestRateSlopeHigh)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateBase updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { borrowPerYearInterestRateBase } = await configurator.getConfiguration(comet.address);

    const newBorrowPerYearInterestRateBase = borrowPerYearInterestRateBase.add(1);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateBase(comet.address, newBorrowPerYearInterestRateBase);

    expect(
      (await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateBase
    ).to.be.equal(newBorrowPerYearInterestRateBase);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.borrowPerSecondInterestRateBase()).to.be.equal(
      newBorrowPerYearInterestRateBase.div(SECONDS_PER_YEAR)
    );
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateBase can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { borrowPerYearInterestRateBase } = await configurator.getConfiguration(comet.address);

    const firstNewBorrowPerYearInterestRateBase = borrowPerYearInterestRateBase.add(1);
    const secondNewBorrowPerYearInterestRateBase = firstNewBorrowPerYearInterestRateBase.add(1);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateBase(comet.address, firstNewBorrowPerYearInterestRateBase);

    expect(
      (await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateBase
    ).to.be.equal(firstNewBorrowPerYearInterestRateBase);

    await configurator
      .connect(admin.signer)
      .setBorrowPerYearInterestRateBase(comet.address, secondNewBorrowPerYearInterestRateBase);

    expect(
      (await configurator.getConfiguration(comet.address)).borrowPerYearInterestRateBase
    ).to.be.equal(secondNewBorrowPerYearInterestRateBase);
  }
);

scenario(
  'Configurator#setBorrowPerYearInterestRateBase reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { borrowPerYearInterestRateBase } = await configurator.getConfiguration(comet.address);
    const newBorrowPerYearInterestRateBase = borrowPerYearInterestRateBase.add(1);

    await expect(
      configurator
        .connect(albert.signer)
        .setBorrowPerYearInterestRateBase(comet.address, newBorrowPerYearInterestRateBase)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setStoreFrontPriceFactor updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { storeFrontPriceFactor } = await configurator.getConfiguration(comet.address);

    const newStoreFrontPriceFactor = storeFrontPriceFactor.add(1);
    await configurator.connect(admin.signer).setStoreFrontPriceFactor(comet.address, newStoreFrontPriceFactor);

    expect((await configurator.getConfiguration(comet.address)).storeFrontPriceFactor).to.be.equal(
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
    await fundAccount(admin.context.world, admin);

    const { storeFrontPriceFactor } = await configurator.getConfiguration(comet.address);

    const firstStoreFrontPriceFactor = storeFrontPriceFactor.add(1);
    const secondStoreFrontPriceFactor = firstStoreFrontPriceFactor.add(1);

    await configurator.connect(admin.signer).setStoreFrontPriceFactor(comet.address, firstStoreFrontPriceFactor);

    expect((await configurator.getConfiguration(comet.address)).storeFrontPriceFactor).to.be.equal(
      firstStoreFrontPriceFactor
    );

    await configurator.connect(admin.signer).setStoreFrontPriceFactor(comet.address, secondStoreFrontPriceFactor);

    expect((await configurator.getConfiguration(comet.address)).storeFrontPriceFactor).to.be.equal(
      secondStoreFrontPriceFactor
    );
  }
);

scenario(
  'Configurator#setStoreFrontPriceFactor reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { storeFrontPriceFactor } = await configurator.getConfiguration(comet.address);
    const newStoreFrontPriceFactor = storeFrontPriceFactor.add(1);

    await expect(
      configurator.connect(albert.signer).setStoreFrontPriceFactor(comet.address, newStoreFrontPriceFactor)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setBaseTrackingSupplySpeed updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { baseTrackingSupplySpeed } = await configurator.getConfiguration(comet.address);

    const newBaseTrackingSupplySpeed = baseTrackingSupplySpeed.add(1);

    await configurator.connect(admin.signer).setBaseTrackingSupplySpeed(comet.address, newBaseTrackingSupplySpeed);

    expect(
      (await configurator.getConfiguration(comet.address)).baseTrackingSupplySpeed
    ).to.be.equal(newBaseTrackingSupplySpeed);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.baseTrackingSupplySpeed()).to.be.equal(newBaseTrackingSupplySpeed);
  }
);

scenario(
  'Configurator#setBaseTrackingSupplySpeed can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { baseTrackingSupplySpeed } = await configurator.getConfiguration(comet.address);

    const firstNewBaseTrackingSupplySpeed = baseTrackingSupplySpeed.add(1);
    const secondNewBaseTrackingSupplySpeed = firstNewBaseTrackingSupplySpeed.add(1);

    await configurator
      .connect(admin.signer)
      .setBaseTrackingSupplySpeed(comet.address, firstNewBaseTrackingSupplySpeed);

    expect(
      (await configurator.getConfiguration(comet.address)).baseTrackingSupplySpeed
    ).to.be.equal(firstNewBaseTrackingSupplySpeed);

    await configurator
      .connect(admin.signer)
      .setBaseTrackingSupplySpeed(comet.address, secondNewBaseTrackingSupplySpeed);

    expect(
      (await configurator.getConfiguration(comet.address)).baseTrackingSupplySpeed
    ).to.be.equal(secondNewBaseTrackingSupplySpeed);
  }
);

scenario(
  'Configurator#setBaseTrackingSupplySpeed reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { baseTrackingSupplySpeed } = await configurator.getConfiguration(comet.address);
    const newBaseTrackingSupplySpeed = baseTrackingSupplySpeed.add(1);

    await expect(
      configurator.connect(albert.signer).setBaseTrackingSupplySpeed(comet.address, newBaseTrackingSupplySpeed)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setBaseTrackingBorrowSpeed updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { baseTrackingBorrowSpeed } = await configurator.getConfiguration(comet.address);

    const newBaseTrackingBorrowSpeed = baseTrackingBorrowSpeed.add(1);

    await configurator.connect(admin.signer).setBaseTrackingBorrowSpeed(comet.address, newBaseTrackingBorrowSpeed);

    expect(
      (await configurator.getConfiguration(comet.address)).baseTrackingBorrowSpeed
    ).to.be.equal(newBaseTrackingBorrowSpeed);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.baseTrackingBorrowSpeed()).to.be.equal(newBaseTrackingBorrowSpeed);
  }
);

scenario(
  'Configurator#setBaseTrackingBorrowSpeed can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { baseTrackingBorrowSpeed } = await configurator.getConfiguration(comet.address);

    const firstNewBaseTrackingBorrowSpeed = baseTrackingBorrowSpeed.add(1);
    const secondNewBaseTrackingBorrowSpeed = firstNewBaseTrackingBorrowSpeed.add(1);

    await configurator
      .connect(admin.signer)
      .setBaseTrackingBorrowSpeed(comet.address, firstNewBaseTrackingBorrowSpeed);

    expect(
      (await configurator.getConfiguration(comet.address)).baseTrackingBorrowSpeed
    ).to.be.equal(firstNewBaseTrackingBorrowSpeed);

    await configurator
      .connect(admin.signer)
      .setBaseTrackingBorrowSpeed(comet.address, secondNewBaseTrackingBorrowSpeed);

    expect(
      (await configurator.getConfiguration(comet.address)).baseTrackingBorrowSpeed
    ).to.be.equal(secondNewBaseTrackingBorrowSpeed);
  }
);

scenario(
  'Configurator#setBaseTrackingBorrowSpeed reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { baseTrackingBorrowSpeed } = await configurator.getConfiguration(comet.address);
    const newBaseTrackingBorrowSpeed = baseTrackingBorrowSpeed.add(1);

    await expect(
      configurator.connect(albert.signer).setBaseTrackingBorrowSpeed(comet.address, newBaseTrackingBorrowSpeed)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setBaseMinForRewards updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);
    const { baseMinForRewards } = await configurator.getConfiguration(comet.address);

    const newBaseMinForRewards = baseMinForRewards.add(1);
    await configurator.connect(admin.signer).setBaseMinForRewards(comet.address, newBaseMinForRewards);

    expect((await configurator.getConfiguration(comet.address)).baseMinForRewards).to.be.equal(
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
    await fundAccount(admin.context.world, admin);

    const { baseMinForRewards } = await configurator.getConfiguration(comet.address);

    const firstBaseMinForRewards = baseMinForRewards.add(1);
    const secondBaseMinForRewards = firstBaseMinForRewards.add(1);

    await configurator.connect(admin.signer).setBaseMinForRewards(comet.address, firstBaseMinForRewards);

    expect((await configurator.getConfiguration(comet.address)).baseMinForRewards).to.be.equal(
      firstBaseMinForRewards
    );

    await configurator.connect(admin.signer).setBaseMinForRewards(comet.address, secondBaseMinForRewards);

    expect((await configurator.getConfiguration(comet.address)).baseMinForRewards).to.be.equal(
      secondBaseMinForRewards
    );
  }
);

scenario(
  'Configurator#setBaseMinForRewards reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { baseMinForRewards } = await configurator.getConfiguration(comet.address);
    const newBaseMinForRewards = baseMinForRewards.add(1);

    await expect(
      configurator.connect(albert.signer).setBaseMinForRewards(comet.address, newBaseMinForRewards)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setBaseBorrowMin updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { baseBorrowMin } = await configurator.getConfiguration(comet.address);
    const newBaseBorrowMin = baseBorrowMin.add(1);

    await configurator.connect(admin.signer).setBaseBorrowMin(comet.address, newBaseBorrowMin);

    expect((await configurator.getConfiguration(comet.address)).baseBorrowMin).to.be.equal(
      newBaseBorrowMin
    );

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.baseBorrowMin()).to.be.equal(newBaseBorrowMin);
  }
);

scenario(
  'Configurator#setBaseBorrowMin can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { baseBorrowMin } = await configurator.getConfiguration(comet.address);
    const firstNewBaseBorrowMin = baseBorrowMin.add(1);
    const secondNewBaseBorrowMin = firstNewBaseBorrowMin.add(1);

    await configurator.connect(admin.signer).setBaseBorrowMin(comet.address, firstNewBaseBorrowMin);

    expect((await configurator.getConfiguration(comet.address)).baseBorrowMin).to.be.equal(
      firstNewBaseBorrowMin
    );

    await configurator.connect(admin.signer).setBaseBorrowMin(comet.address, secondNewBaseBorrowMin);

    expect((await configurator.getConfiguration(comet.address)).baseBorrowMin).to.be.equal(
      secondNewBaseBorrowMin
    );
  }
);

scenario(
  'Configurator#setBaseBorrowMin reverts if called by unauthorized caller',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { baseBorrowMin } = await configurator.getConfiguration(comet.address);
    const newBaseBorrowMin = baseBorrowMin.add(1);

    await expect(
      configurator.connect(albert.signer).setBaseBorrowMin(comet.address, newBaseBorrowMin)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

// The asset list setters exist only on the upgraded Configurator, which comes with the service patch 2 Comet

scenario(
  'Configurator#setTargetReserves updates value if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { targetReserves } = await configurator.getConfiguration(comet.address);
    const newTargetReserves = targetReserves.add(1);

    await configurator.connect(admin.signer).setTargetReserves(comet.address, newTargetReserves);

    expect((await configurator.getConfiguration(comet.address)).targetReserves).to.be.equal(newTargetReserves);

    await admin.deployAndUpgradeTo(configurator.address, comet.address);

    expect(await comet.targetReserves()).to.be.equal(newTargetReserves);
  }
);

scenario(
  'Configurator#setTargetReserves can be overwritten multiple times',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const { targetReserves } = await configurator.getConfiguration(comet.address);
    const firstTargetReserves = targetReserves.add(1);
    const secondTargetReserves = firstTargetReserves.add(1);

    await configurator.connect(admin.signer).setTargetReserves(comet.address, firstTargetReserves);

    expect((await configurator.getConfiguration(comet.address)).targetReserves).to.be.equal(firstTargetReserves);

    await configurator.connect(admin.signer).setTargetReserves(comet.address, secondTargetReserves);

    expect((await configurator.getConfiguration(comet.address)).targetReserves).to.be.equal(secondTargetReserves);
  }
);

scenario(
  'Configurator#setTargetReserves reverts if called by non-governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { albert } = actors;

    const { targetReserves } = await configurator.getConfiguration(comet.address);
    const newTargetReserves = targetReserves.add(1);

    await expect(
      configurator.connect(albert.signer).setTargetReserves(comet.address, newTargetReserves)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

/*//////////////////////////////////////////////////////////////
                            FACTORY
//////////////////////////////////////////////////////////////*/

scenario(
  'Configurator#setFactory updates factory if called by governor',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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
    await fundAccount(admin.context.world, admin);

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

    await expect(
      configurator.connect(albert.signer).setFactory(comet.address, newFactory)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

/*//////////////////////////////////////////////////////////////
                         CONFIGURATION
//////////////////////////////////////////////////////////////*/

scenario(
  'Configurator#setConfiguration updates existing configuration if called by governor',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);
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
    await fundAccount(admin.context.world, admin);
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
    await expect(
      configurator.connect(albert.signer).setConfiguration(comet.address, updatedConfiguration)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#setConfiguration reverts if base token is changed for existing configuration',
  {},
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);
    const existingConfiguration = normalizeStructOutput(await configurator.getConfiguration(comet.address));

    const updatedConfiguration = {
      ...existingConfiguration,
      baseToken: await deployMockERC20(context, 'baseToken')
    };

    await expect(
      configurator.connect(admin.signer).setConfiguration(comet.address, updatedConfiguration)
    ).to.be.revertedWithCustomError(configurator, 'ConfigurationAlreadyExists');
  }
);

scenario(
  'Configurator#setConfiguration reverts if tracking index scale is changed for existing configuration',
  {},
  async ({ comet, configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);
    const existingConfiguration = normalizeStructOutput(await configurator.getConfiguration(comet.address));

    const updatedConfiguration = {
      ...existingConfiguration,
      trackingIndexScale: existingConfiguration.trackingIndexScale + 1n
    };

    await expect(
      configurator.connect(admin.signer).setConfiguration(comet.address, updatedConfiguration)
    ).to.be.revertedWithCustomError(configurator, 'ConfigurationAlreadyExists');
  }
);
