import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import { CometContext, scenario } from '../context/CometContext';
import { expectRevertCustom, fundAccount, matchesDeployment } from '../utils';
import { SECONDS_PER_YEAR } from '../utils/constants';
import { ConfiguratorOptimism, MarketAdminPermissionChecker } from '../../build/types';
import { normalizeStructOutput } from './shared';

// Scenarios for the market admin, who may call a subset of the Configurator setters without full governance.
// The market admin permission checker lives on Optimism's Configurator only, so every scenario here runs on Optimism

// The market's Configurator through the ABI that has the market admin permission checker. The context returns it as
// the base Configurator, which has neither the checker getter nor its setter
async function getConfiguratorOptimism(context: CometContext): Promise<ConfiguratorOptimism> {
  const configurator = await context.getConfigurator();
  return await context.world.deploymentManager.hre.ethers.getContractAt(
    'ConfiguratorOptimism',
    configurator.address
  ) as ConfiguratorOptimism;
}

async function getMarketAdminSigner(context: CometContext): Promise<SignerWithAddress> {
  const dm = context.world.deploymentManager;
  const configurator = await getConfiguratorOptimism(context);

  const marketAdminPermissionChecker = (await dm.hre.ethers.getContractAt(
    'MarketAdminPermissionChecker',
    await configurator.marketAdminPermissionChecker()
  )) as MarketAdminPermissionChecker;

  const marketAdmin = await marketAdminPermissionChecker.marketAdmin();
  const marketAdminSigner = await context.world.impersonateAddress(marketAdmin);
  await fundAccount(context.world, marketAdminSigner);
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

scenario(
  'Configurator#setMarketAdminPermissionChecker updates value if called by governor',
  {
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ actors }, context) => {
    const configurator = await getConfiguratorOptimism(context);
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const newMarketAdminPermissionChecker = await deployMarketAdminPermissionChecker(context);
    await configurator.connect(admin.signer).setMarketAdminPermissionChecker(newMarketAdminPermissionChecker);

    expect(await configurator.marketAdminPermissionChecker()).to.be.equal(newMarketAdminPermissionChecker);
  }
);

scenario(
  'Configurator#setMarketAdminPermissionChecker can be overwritten multiple times',
  {
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ actors }, context) => {
    const configurator = await getConfiguratorOptimism(context);
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ actors }, context) => {
    const configurator = await getConfiguratorOptimism(context);
    const { albert } = actors;

    const newMarketAdminPermissionChecker = await deployMarketAdminPermissionChecker(context);

    await expectRevertCustom(
      configurator.connect(albert.signer).setMarketAdminPermissionChecker(newMarketAdminPermissionChecker),
      'Unauthorized()'
    );
  }
);

scenario(
  'Configurator#setSupplyKink updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);
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
  'Configurator#setSupplyPerYearInterestRateSlopeLow updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);
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
  'Configurator#setSupplyPerYearInterestRateSlopeHigh updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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
  'Configurator#setSupplyPerYearInterestRateBase updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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
  'Configurator#setBorrowKink updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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
  'Configurator#setBorrowPerYearInterestRateSlopeLow updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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
  'Configurator#setBorrowPerYearInterestRateSlopeHigh updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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
  'Configurator#setBorrowPerYearInterestRateBase updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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
  'Configurator#setBaseTrackingSupplySpeed updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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
  'Configurator#setBaseTrackingBorrowSpeed updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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
  'Configurator#setBaseBorrowMin updates value if called by market-admin',
  {
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'optimism' }])
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

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