import { AbiCoder, encodeBytes32String, ZeroAddress } from 'ethers';
import type { Signer } from 'ethers';

import { annualize, defactor, defaultAssets, event, exp, expect, factor, makeConfigurator, Numeric, truncateDecimals, wait } from './helpers.js';
import {
  CometExtAssetList__factory,
  CometHarnessInterfaceExtendedAssetList__factory,
  CometModified__factory,
  CometModifiedFactory__factory,
  Configurator__factory,
  MarketAdminPermissionChecker__factory,
  SimplePriceFeed__factory,
  SimpleTimelock__factory
} from '../build/types/index.js';
import type { CometCore } from '../build/types/test/CometHarnessInterfaceExtendedAssetList.js';
import type { CometConfiguration } from '../build/types/Configurator.js';

const abiCoder = AbiCoder.defaultAbiCoder();
type AssetInfoStructOutput = CometCore.AssetInfoStructOutput;
type ConfigurationStructOutput = CometConfiguration.ConfigurationStructOutput;

type ConfiguratorAssetConfig = {
  asset: string;
  priceFeed: string;
  decimals: Numeric;
  borrowCollateralFactor: Numeric;
  liquidateCollateralFactor: Numeric;
  liquidationFactor: Numeric;
  supplyCap: Numeric;
};

function convertToEventAssetConfig(assetConfig: ConfiguratorAssetConfig) {
  return [
    assetConfig.asset,
    assetConfig.priceFeed,
    assetConfig.decimals,
    assetConfig.borrowCollateralFactor,
    assetConfig.liquidateCollateralFactor,
    assetConfig.liquidationFactor,
    assetConfig.supplyCap,
  ];
}

function convertToEventConfiguration(configuration: ConfigurationStructOutput) {
  return [
    configuration.governor,
    configuration.pauseGuardian,
    configuration.baseToken,
    configuration.baseTokenPriceFeed,
    configuration.extensionDelegate,
    configuration.supplyKink,
    configuration.supplyPerYearInterestRateSlopeLow,
    configuration.supplyPerYearInterestRateSlopeHigh,
    configuration.supplyPerYearInterestRateBase,
    configuration.borrowKink,
    configuration.borrowPerYearInterestRateSlopeLow,
    configuration.borrowPerYearInterestRateSlopeHigh,
    configuration.borrowPerYearInterestRateBase,
    configuration.storeFrontPriceFactor,
    configuration.trackingIndexScale,
    configuration.baseTrackingSupplySpeed,
    configuration.baseTrackingBorrowSpeed,
    configuration.baseMinForRewards,
    configuration.baseBorrowMin,
    configuration.targetReserves,
    [] // leave asset configs empty for simplicity
  ];
}

function copyConfiguration(configuration: ConfigurationStructOutput): ConfigurationStructOutput {
  return {
    governor: configuration.governor,
    pauseGuardian: configuration.pauseGuardian,
    baseToken: configuration.baseToken,
    baseTokenPriceFeed: configuration.baseTokenPriceFeed,
    extensionDelegate: configuration.extensionDelegate,
    supplyKink: configuration.supplyKink,
    supplyPerYearInterestRateSlopeLow: configuration.supplyPerYearInterestRateSlopeLow,
    supplyPerYearInterestRateSlopeHigh: configuration.supplyPerYearInterestRateSlopeHigh,
    supplyPerYearInterestRateBase: configuration.supplyPerYearInterestRateBase,
    borrowKink: configuration.borrowKink,
    borrowPerYearInterestRateSlopeLow: configuration.borrowPerYearInterestRateSlopeLow,
    borrowPerYearInterestRateSlopeHigh: configuration.borrowPerYearInterestRateSlopeHigh,
    borrowPerYearInterestRateBase: configuration.borrowPerYearInterestRateBase,
    storeFrontPriceFactor: configuration.storeFrontPriceFactor,
    trackingIndexScale: configuration.trackingIndexScale,
    baseTrackingSupplySpeed: configuration.baseTrackingSupplySpeed,
    baseTrackingBorrowSpeed: configuration.baseTrackingBorrowSpeed,
    baseMinForRewards: configuration.baseMinForRewards,
    baseBorrowMin: configuration.baseBorrowMin,
    targetReserves: configuration.targetReserves,
    assetConfigs: configuration.assetConfigs.map((assetConfig) => ({
      asset: assetConfig.asset,
      priceFeed: assetConfig.priceFeed,
      decimals: assetConfig.decimals,
      borrowCollateralFactor: assetConfig.borrowCollateralFactor,
      liquidateCollateralFactor: assetConfig.liquidateCollateralFactor,
      liquidationFactor: assetConfig.liquidationFactor,
      supplyCap: assetConfig.supplyCap,
    })),
  } as ConfigurationStructOutput;
}

function expectApproximately(actual: number, expected: number, tolerance: number) {
  expect(Math.abs(actual - expected) <= tolerance).to.be.true;
}

// Checks that the Configurator asset config matches the Comet asset info
function expectAssetConfigsToMatch(
  configuratorAssetConfigs: ConfiguratorAssetConfig,
  cometAssetInfo: AssetInfoStructOutput
) {
  expect(configuratorAssetConfigs.asset).to.be.equal(cometAssetInfo.asset);
  expect(configuratorAssetConfigs.priceFeed).to.be.equal(cometAssetInfo.priceFeed);
  expect(exp(1, configuratorAssetConfigs.decimals)).to.be.equal(cometAssetInfo.scale);
  expect(configuratorAssetConfigs.borrowCollateralFactor).to.be.equal(cometAssetInfo.borrowCollateralFactor);
  expect(configuratorAssetConfigs.liquidateCollateralFactor).to.be.equal(cometAssetInfo.liquidateCollateralFactor);
  expect(configuratorAssetConfigs.liquidationFactor).to.be.equal(cometAssetInfo.liquidationFactor);
  expect(configuratorAssetConfigs.supplyCap).to.be.equal(cometAssetInfo.supplyCap);
}

describe('configurator', function () {
  it('deploys Comet', async () => {
    const { configurator, configuratorProxy, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

    const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
    const txn = await wait(configuratorAsProxy.deploy(await cometProxy.getAddress()));
    const cometDeployedEvent = txn.receipt.logs
      .map((log) => configuratorAsProxy.interface.parseLog(log))
      .find((log) => log?.name === 'CometDeployed');
    if (!cometDeployedEvent) {
      throw new Error('CometDeployed event not found');
    }
    const newCometAddress = cometDeployedEvent.args.newComet;

    expect({
      CometDeployed: {
        cometProxy: cometDeployedEvent.args.cometProxy,
        newComet: newCometAddress,
      }
    }).to.be.deep.equal({
      CometDeployed: {
        cometProxy: await cometProxy.getAddress(),
        newComet: newCometAddress,
      }
    });
  });

  it('deploys Comet from ProxyAdmin', async () => {
    const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

    expect(await proxyAdmin.getProxyImplementation(await cometProxy.getAddress())).to.be.equal(await comet.getAddress());
    expect(await proxyAdmin.getProxyImplementation(await configuratorProxy.getAddress())).to.be.equal(await configurator.getAddress());

    await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));
    const newCometAddress = await proxyAdmin.getProxyImplementation(await cometProxy.getAddress());

    expect(newCometAddress).to.not.be.equal(await comet.getAddress());
  });

  it('reverts if deploy is called from non-governor', async () => {
    const { configuratorProxy, proxyAdmin, cometProxyWithExtendedAssetList: cometProxy, users: [alice], governor } = await makeConfigurator();

    const MarketAdminPermissionCheckerFactory = new MarketAdminPermissionChecker__factory(governor);


    const marketAdminPermissionCheckerContract =  await MarketAdminPermissionCheckerFactory.deploy(
      governor.address,
      ZeroAddress,
      ZeroAddress
    );

    await expect(proxyAdmin.connect(alice).deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress())).to.be.revertedWithCustomError(marketAdminPermissionCheckerContract, 'Unauthorized');
  });

  it('e2e governance actions from timelock', async () => {
    const { governor, configurator, configuratorProxy, proxyAdmin, cometProxyWithExtendedAssetList: cometProxy, users: [alice] } = await makeConfigurator();

    const TimelockFactory = new SimpleTimelock__factory(governor);

    const timelock = await TimelockFactory.deploy(governor.address);
    await timelock.waitForDeployment();
    await proxyAdmin.transferOwnership(await timelock.getAddress());

    const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
    await configuratorAsProxy.transferGovernor(await timelock.getAddress()); // set timelock as admin of Configurator

    expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).governor).to.be.equal(governor.address);

    // 1. SetGovernor
    // 2. DeployAndUpgradeTo
    let setGovernorCalldata = abiCoder.encode(['address', 'address'], [await cometProxy.getAddress(), alice.address]);
    let deployAndUpgradeToCalldata = abiCoder.encode(['address', 'address'], [await configuratorProxy.getAddress(), await cometProxy.getAddress()]);
    await timelock.executeTransactions([await configuratorProxy.getAddress(), await proxyAdmin.getAddress()], [0, 0], ['setGovernor(address,address)', 'deployAndUpgradeTo(address,address)'], [setGovernorCalldata, deployAndUpgradeToCalldata]);

    expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).governor).to.be.equal(alice.address);
  });

  it('reverts if initialized more than once', async () => {
    const { governor, configurator, configuratorProxy } = await makeConfigurator();

    const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
    await expect(configuratorAsProxy.initialize(governor.address)).to.be.revertedWithCustomError(configuratorAsProxy, 'AlreadyInitialized');
  });

  it('reverts if initializing the implementation contract', async () => {
    const { governor, configurator } = await makeConfigurator();

    await expect(configurator.initialize(governor.address)).to.be.revertedWithCustomError(configurator, 'AlreadyInitialized');
  });

  describe('configuration setters', function () {
    it('sets factory and deploys Comet using new factory', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometFactoryWithExtendedAssetList: cometFactory, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      // Deploy modified CometFactory
      const CometModifiedFactoryFactory = new CometModifiedFactory__factory(configurator.runner as Signer);
      const cometModifiedFactory = await CometModifiedFactoryFactory.deploy();
      await cometModifiedFactory.waitForDeployment();
      const oldFactory = await cometFactory.getAddress();
      const newFactory = await cometModifiedFactory.getAddress();

      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      const txn = await wait(configuratorAsProxy.setFactory(await cometProxy.getAddress(), await cometModifiedFactory.getAddress()));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetFactory: {
          cometProxy: await cometProxy.getAddress(),
          oldFactory,
          newFactory,
        }
      });
      expect(oldFactory).to.be.not.equal(newFactory);
      expect(await configuratorAsProxy.factory(await cometProxy.getAddress())).to.be.equal(newFactory);
      // Call new function on Comet
      const modifiedCometAsProxy = CometModified__factory.connect(await cometProxy.getAddress(), configurator.runner);
      expect(await modifiedCometAsProxy.newFunction()).to.be.equal(101n);
    });

    it('sets Configuration for a new Comet proxy', async () => {
      const { configurator, configuratorProxy, proxyAdmin } = await makeConfigurator();

      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      const newCometProxyAddress = ZeroAddress;
      const oldConfiguration = await configuratorAsProxy.getConfiguration(newCometProxyAddress);
      const newConfiguration = { ...copyConfiguration(oldConfiguration), governor: await proxyAdmin.getAddress() } as ConfigurationStructOutput;

      const txn = await wait(configuratorAsProxy.setConfiguration(newCometProxyAddress, newConfiguration));

      expect(event(txn, 0)).to.be.deep.equal({
        SetConfiguration: {
          cometProxy: newCometProxyAddress,
          oldConfiguration: convertToEventConfiguration(oldConfiguration),
          newConfiguration: convertToEventConfiguration(newConfiguration),
        }
      });
      expect(oldConfiguration).to.be.not.equal(newConfiguration);
      expect((await configuratorAsProxy.getConfiguration(newCometProxyAddress)).governor).to.be.equal(newConfiguration.governor);
    });

    it('sets Configuration for a Comet proxy with an existing configuration', async () => {
      const { configurator, configuratorProxy, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator({
        assets: {
          USDC: { initial: 1e6, decimals: 6 },
        }
      });

      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      const oldConfiguration = await configuratorAsProxy.getConfiguration(await cometProxy.getAddress());
      const newConfiguration = { ...copyConfiguration(oldConfiguration), baseBorrowMin: 1n } as ConfigurationStructOutput;

      const txn = await wait(configuratorAsProxy.setConfiguration(await cometProxy.getAddress(), newConfiguration));

      expect(event(txn, 0)).to.be.deep.equal({
        SetConfiguration: {
          cometProxy: await cometProxy.getAddress(),
          oldConfiguration: convertToEventConfiguration(oldConfiguration),
          newConfiguration: convertToEventConfiguration(newConfiguration),
        }
      });
      expect(oldConfiguration).to.be.not.equal(newConfiguration);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).baseBorrowMin).to.be.equal(newConfiguration.baseBorrowMin);
    });

    it('reverts when setting Configuration and changing baseToken for a Comet proxy with an existing configuration', async () => {
      const { configurator, configuratorProxy, cometProxyWithExtendedAssetList: cometProxy, tokens } = await makeConfigurator();
      const { COMP } = tokens;

      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      const oldConfiguration = await configuratorAsProxy.getConfiguration(await cometProxy.getAddress());
      const newConfiguration = { ...copyConfiguration(oldConfiguration), baseToken: await COMP.getAddress() } as ConfigurationStructOutput;

      await expect(
        configuratorAsProxy.setConfiguration(await cometProxy.getAddress(), newConfiguration)
      ).to.be.revertedWithCustomError(configuratorAsProxy, 'ConfigurationAlreadyExists');
    });

    it('reverts when setting Configuration and changing trackingIndexScale for a Comet proxy with an existing configuration', async () => {
      const { configurator, configuratorProxy, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      const oldConfiguration = await configuratorAsProxy.getConfiguration(await cometProxy.getAddress());
      const newConfiguration = { ...copyConfiguration(oldConfiguration), trackingIndexScale: 10_000_000n } as ConfigurationStructOutput;

      await expect(
        configuratorAsProxy.setConfiguration(await cometProxy.getAddress(), newConfiguration)
      ).to.be.revertedWithCustomError(configuratorAsProxy, 'ConfigurationAlreadyExists');
    });

    it('reverts when setting bad Configuration for a Comet proxy with an existing configuration', async () => {
      const { configurator, configuratorProxy, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      const oldConfiguration = await configuratorAsProxy.getConfiguration(await cometProxy.getAddress());
      const newConfiguration = { ...copyConfiguration(oldConfiguration), baseToken: ZeroAddress };

      await expect(
        configuratorAsProxy.setConfiguration(await cometProxy.getAddress(), newConfiguration)
      ).to.be.revertedWithCustomError(configuratorAsProxy, 'ConfigurationAlreadyExists');
    });

    it('sets governor and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy, users: [alice] } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).governor).to.be.equal(await comet.governor());

      const oldGovernor = await comet.governor();
      const newGovernor = alice.address;
      const txn = await wait(configuratorAsProxy.setGovernor(await cometProxy.getAddress(), newGovernor));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetGovernor: {
          cometProxy: await cometProxy.getAddress(),
          oldGovernor,
          newGovernor,
        }
      });
      expect(oldGovernor).to.be.not.equal(newGovernor);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).governor).to.be.equal(newGovernor);
      expect(await cometAsProxy.governor()).to.be.equal(newGovernor);
    });

    it('sets pauseGuardian and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy, users: [alice] } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).pauseGuardian).to.be.equal(await comet.pauseGuardian());

      const oldPauseGuardian = await comet.pauseGuardian();
      const newPauseGuardian = alice.address;
      const txn = await wait(configuratorAsProxy.setPauseGuardian(await cometProxy.getAddress(), newPauseGuardian));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetPauseGuardian: {
          cometProxy: await cometProxy.getAddress(),
          oldPauseGuardian,
          newPauseGuardian,
        }
      });
      expect(oldPauseGuardian).to.be.not.equal(newPauseGuardian);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).pauseGuardian).to.be.equal(newPauseGuardian);
      expect(await cometAsProxy.pauseGuardian()).to.be.equal(newPauseGuardian);
    });

    it('sets baseTokenPriceFeed and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).baseTokenPriceFeed).to.be.equal(await comet.baseTokenPriceFeed());

      // Deploy new price feed
      const PriceFeedFactory = new SimplePriceFeed__factory(comet.runner as Signer);
      const priceFeed = await PriceFeedFactory.deploy(exp(20, 8), 8);
      await priceFeed.waitForDeployment();

      const oldPriceFeed = await comet.baseTokenPriceFeed();
      const newPriceFeed = await priceFeed.getAddress();
      const txn = await wait(configuratorAsProxy.setBaseTokenPriceFeed(await cometProxy.getAddress(), newPriceFeed));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetBaseTokenPriceFeed: {
          cometProxy: await cometProxy.getAddress(),
          oldBaseTokenPriceFeed: oldPriceFeed,
          newBaseTokenPriceFeed: newPriceFeed,
        }
      });
      expect(oldPriceFeed).to.be.not.equal(newPriceFeed);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).baseTokenPriceFeed).to.be.equal(newPriceFeed);
      expect(await cometAsProxy.baseTokenPriceFeed()).to.be.equal(newPriceFeed);
    });

    it('sets extensionDelegate and deploys Comet with new configuration', async () => {
      const {
        configurator,
        configuratorProxy,
        proxyAdmin,
        assetListFactory,
        cometWithExtendedAssetList: comet,
        cometProxyWithExtendedAssetList: cometProxy,
      } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).extensionDelegate).to.be.equal(await comet.extensionDelegate());

      const CometExtAssetListFactory = new CometExtAssetList__factory(comet.runner as Signer);
      const newExtensionDelegateContract = await CometExtAssetListFactory.deploy(
        {
          name32: encodeBytes32String('Test Comet'),
          symbol32: encodeBytes32String('tCOMET')
        },
        await assetListFactory.getAddress()
      );
      await newExtensionDelegateContract.waitForDeployment();

      const oldExt = await comet.extensionDelegate();
      const newExt = await newExtensionDelegateContract.getAddress();
      const txn = await wait(configuratorAsProxy.setExtensionDelegate(await cometProxy.getAddress(), newExt));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetExtensionDelegate: {
          cometProxy: await cometProxy.getAddress(),
          oldExt,
          newExt,
        }
      });
      expect(oldExt).to.be.not.equal(newExt);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).extensionDelegate).to.be.equal(newExt);
      expect(await cometAsProxy.extensionDelegate()).to.be.equal(newExt);
    });

    it('sets supplyKink and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).supplyKink).to.be.equal(await comet.supplyKink());

      const oldKink = (await comet.supplyKink());
      const newKink = 100n;
      const txn = await wait(configuratorAsProxy.setSupplyKink(await cometProxy.getAddress(), newKink));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetSupplyKink: {
          cometProxy: await cometProxy.getAddress(),
          oldKink,
          newKink,
        }
      });
      expect(oldKink).to.be.not.equal(newKink);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).supplyKink).to.be.equal(newKink);
      expect(await cometAsProxy.supplyKink()).to.be.equal(newKink);
    });

    it('sets supplyPerYearInterestRateSlopeLow and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expectApproximately(
        defactor((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).supplyPerYearInterestRateSlopeLow),
        annualize(await comet.supplyPerSecondInterestRateSlopeLow()),
        0.00001
      );

      const oldIRSlopeLow = (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).supplyPerYearInterestRateSlopeLow;
      const newIRSlopeLow = exp(5.5, 18);
      const txn = await wait(configuratorAsProxy.setSupplyPerYearInterestRateSlopeLow(await cometProxy.getAddress(), newIRSlopeLow));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetSupplyPerYearInterestRateSlopeLow: {
          cometProxy: await cometProxy.getAddress(),
          oldIRSlopeLow,
          newIRSlopeLow,
        }
      });
      expect(oldIRSlopeLow).to.be.not.equal(newIRSlopeLow);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).supplyPerYearInterestRateSlopeLow).to.be.equal(newIRSlopeLow);
      expectApproximately(
        annualize(await cometAsProxy.supplyPerSecondInterestRateSlopeLow()),
        defactor(newIRSlopeLow),
        0.00001
      );
    });

    it('sets supplyPerYearInterestRateSlopeHigh and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expectApproximately(
        defactor((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).supplyPerYearInterestRateSlopeHigh),
        annualize(await comet.supplyPerSecondInterestRateSlopeHigh()),
        0.00001
      );

      const oldIRSlopeHigh = (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).supplyPerYearInterestRateSlopeHigh;
      const newIRSlopeHigh = exp(5.5, 18);
      const txn = await wait(configuratorAsProxy.setSupplyPerYearInterestRateSlopeHigh(await cometProxy.getAddress(), newIRSlopeHigh));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetSupplyPerYearInterestRateSlopeHigh: {
          cometProxy: await cometProxy.getAddress(),
          oldIRSlopeHigh,
          newIRSlopeHigh,
        }
      });
      expect(oldIRSlopeHigh).to.be.not.equal(newIRSlopeHigh);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).supplyPerYearInterestRateSlopeHigh).to.be.equal(newIRSlopeHigh);
      expectApproximately(
        annualize(await cometAsProxy.supplyPerSecondInterestRateSlopeHigh()),
        defactor(newIRSlopeHigh),
        0.00001
      );
    });

    it('sets supplyPerYearInterestRateBase and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expectApproximately(
        defactor((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).supplyPerYearInterestRateBase),
        annualize(await comet.supplyPerSecondInterestRateBase()),
        0.00001
      );

      const oldIRBase = (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).supplyPerYearInterestRateBase;
      const newIRBase = exp(5.5, 18);
      const txn = await wait(configuratorAsProxy.setSupplyPerYearInterestRateBase(await cometProxy.getAddress(), newIRBase));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetSupplyPerYearInterestRateBase: {
          cometProxy: await cometProxy.getAddress(),
          oldIRBase,
          newIRBase,
        }
      });
      expect(oldIRBase).to.be.not.equal(newIRBase);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).supplyPerYearInterestRateBase).to.be.equal(newIRBase);
      expectApproximately(
        annualize(await cometAsProxy.supplyPerSecondInterestRateBase()),
        defactor(newIRBase),
        0.00001
      );
    });

    it('sets borrowKink and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).borrowKink).to.be.equal(await comet.borrowKink());

      const oldKink = (await comet.borrowKink());
      const newKink = 100n;
      const txn = await wait(configuratorAsProxy.setBorrowKink(await cometProxy.getAddress(), newKink));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetBorrowKink: {
          cometProxy: await cometProxy.getAddress(),
          oldKink,
          newKink,
        }
      });
      expect(oldKink).to.be.not.equal(newKink);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).borrowKink).to.be.equal(newKink);
      expect(await cometAsProxy.borrowKink()).to.be.equal(newKink);
    });

    it('sets borrowPerYearInterestRateSlopeLow and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expectApproximately(
        defactor((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).borrowPerYearInterestRateSlopeLow),
        annualize(await comet.borrowPerSecondInterestRateSlopeLow()),
        0.00001
      );

      const oldIRSlopeLow = (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).borrowPerYearInterestRateSlopeLow;
      const newIRSlopeLow = exp(5.5, 18);
      const txn = await wait(configuratorAsProxy.setBorrowPerYearInterestRateSlopeLow(await cometProxy.getAddress(), newIRSlopeLow));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetBorrowPerYearInterestRateSlopeLow: {
          cometProxy: await cometProxy.getAddress(),
          oldIRSlopeLow,
          newIRSlopeLow,
        }
      });
      expect(oldIRSlopeLow).to.be.not.equal(newIRSlopeLow);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).borrowPerYearInterestRateSlopeLow).to.be.equal(newIRSlopeLow);
      expectApproximately(
        annualize(await cometAsProxy.borrowPerSecondInterestRateSlopeLow()),
        defactor(newIRSlopeLow),
        0.00001
      );
    });

    it('sets borrowPerYearInterestRateSlopeHigh and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expectApproximately(
        defactor((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).borrowPerYearInterestRateSlopeHigh),
        annualize(await comet.borrowPerSecondInterestRateSlopeHigh()),
        0.00001
      );

      const oldIRSlopeHigh = (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).borrowPerYearInterestRateSlopeHigh;
      const newIRSlopeHigh = exp(5.5, 18);
      const txn = await wait(configuratorAsProxy.setBorrowPerYearInterestRateSlopeHigh(await cometProxy.getAddress(), newIRSlopeHigh));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetBorrowPerYearInterestRateSlopeHigh: {
          cometProxy: await cometProxy.getAddress(),
          oldIRSlopeHigh,
          newIRSlopeHigh,
        }
      });
      expect(oldIRSlopeHigh).to.be.not.equal(newIRSlopeHigh);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).borrowPerYearInterestRateSlopeHigh).to.be.equal(newIRSlopeHigh);
      expectApproximately(
        annualize(await cometAsProxy.borrowPerSecondInterestRateSlopeHigh()),
        defactor(newIRSlopeHigh),
        0.00001
      );
    });

    it('sets borrowPerYearInterestRateBase and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expectApproximately(
        defactor((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).borrowPerYearInterestRateBase),
        annualize(await comet.borrowPerSecondInterestRateBase()),
        0.00001
      );

      const oldIRBase = (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).borrowPerYearInterestRateBase;
      const newIRBase = exp(5.5, 18);
      const txn = await wait(configuratorAsProxy.setBorrowPerYearInterestRateBase(await cometProxy.getAddress(), newIRBase));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetBorrowPerYearInterestRateBase: {
          cometProxy: await cometProxy.getAddress(),
          oldIRBase,
          newIRBase,
        }
      });
      expect(oldIRBase).to.be.not.equal(newIRBase);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).borrowPerYearInterestRateBase).to.be.equal(newIRBase);
      expectApproximately(
        annualize(await cometAsProxy.borrowPerSecondInterestRateBase()),
        defactor(newIRBase),
        0.00001
      );
    });

    it('sets storeFrontPriceFactor and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator({
        assets: {
          USDC: { decimals: 6, },
          COMP: {
            decimals: 18,
            // This needs to be < 1e18 (default) so the StoreFrontPriceFactor can be < 1e18
            liquidationFactor: exp(0.8, 18),
          },
        },
      });

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).storeFrontPriceFactor).to.be.equal(await comet.storeFrontPriceFactor());

      const oldStoreFrontPriceFactor = (await comet.storeFrontPriceFactor());
      const newStoreFrontPriceFactor = factor(0.95);
      const txn = await wait(configuratorAsProxy.setStoreFrontPriceFactor(await cometProxy.getAddress(), newStoreFrontPriceFactor));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetStoreFrontPriceFactor: {
          cometProxy: await cometProxy.getAddress(),
          oldStoreFrontPriceFactor,
          newStoreFrontPriceFactor,
        }
      });
      expect(oldStoreFrontPriceFactor).to.be.not.equal(newStoreFrontPriceFactor);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).storeFrontPriceFactor).to.be.equal(newStoreFrontPriceFactor);
      expect(await cometAsProxy.storeFrontPriceFactor()).to.be.equal(newStoreFrontPriceFactor);
    });

    it('sets baseTrackingSupplySpeed and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).baseTrackingSupplySpeed).to.be.equal(await comet.baseTrackingSupplySpeed());

      const oldSpeed = (await comet.baseTrackingSupplySpeed());
      const newSpeed = 100n;
      const txn = await wait(configuratorAsProxy.setBaseTrackingSupplySpeed(await cometProxy.getAddress(), newSpeed));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetBaseTrackingSupplySpeed: {
          cometProxy: await cometProxy.getAddress(),
          oldBaseTrackingSupplySpeed: oldSpeed,
          newBaseTrackingSupplySpeed: newSpeed,
        }
      });
      expect(oldSpeed).to.be.not.equal(newSpeed);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).baseTrackingSupplySpeed).to.be.equal(newSpeed);
      expect(await cometAsProxy.baseTrackingSupplySpeed()).to.be.equal(newSpeed);
    });

    it('sets baseTrackingBorrowSpeed and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).baseTrackingBorrowSpeed).to.be.equal(await comet.baseTrackingBorrowSpeed());

      const oldSpeed = (await comet.baseTrackingBorrowSpeed());
      const newSpeed = 100n;
      const txn = await wait(configuratorAsProxy.setBaseTrackingBorrowSpeed(await cometProxy.getAddress(), newSpeed));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetBaseTrackingBorrowSpeed: {
          cometProxy: await cometProxy.getAddress(),
          oldBaseTrackingBorrowSpeed: oldSpeed,
          newBaseTrackingBorrowSpeed: newSpeed,
        }
      });
      expect(oldSpeed).to.be.not.equal(newSpeed);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).baseTrackingBorrowSpeed).to.be.equal(newSpeed);
      expect(await cometAsProxy.baseTrackingBorrowSpeed()).to.be.equal(newSpeed);
    });

    it('sets baseMinForRewards and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).baseMinForRewards).to.be.equal(await comet.baseMinForRewards());

      const oldBaseMinForRewards = (await comet.baseMinForRewards());
      const newBaseMinForRewards = 100n;
      const txn = await wait(configuratorAsProxy.setBaseMinForRewards(await cometProxy.getAddress(), newBaseMinForRewards));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetBaseMinForRewards: {
          cometProxy: await cometProxy.getAddress(),
          oldBaseMinForRewards,
          newBaseMinForRewards,
        }
      });
      expect(oldBaseMinForRewards).to.be.not.equal(newBaseMinForRewards);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).baseMinForRewards).to.be.equal(newBaseMinForRewards);
      expect(await cometAsProxy.baseMinForRewards()).to.be.equal(newBaseMinForRewards);
    });

    it('sets baseBorrowMin and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).baseBorrowMin).to.be.equal(await comet.baseBorrowMin());

      const oldBaseBorrowMin = (await comet.baseBorrowMin());
      const newBaseBorrowMin = 100n;
      const txn = await wait(configuratorAsProxy.setBaseBorrowMin(await cometProxy.getAddress(), newBaseBorrowMin));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetBaseBorrowMin: {
          cometProxy: await cometProxy.getAddress(),
          oldBaseBorrowMin,
          newBaseBorrowMin,
        }
      });
      expect(oldBaseBorrowMin).to.be.not.equal(newBaseBorrowMin);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).baseBorrowMin).to.be.equal(newBaseBorrowMin);
      expect(await cometAsProxy.baseBorrowMin()).to.be.equal(newBaseBorrowMin);
    });

    it('sets targetReserves and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).targetReserves).to.be.equal(await comet.targetReserves());

      const oldTargetReserves = (await comet.targetReserves());
      const newTargetReserves = 100n;
      const txn = await wait(configuratorAsProxy.setTargetReserves(await cometProxy.getAddress(), newTargetReserves));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        SetTargetReserves: {
          cometProxy: await cometProxy.getAddress(),
          oldTargetReserves,
          newTargetReserves,
        }
      });
      expect(oldTargetReserves).to.be.not.equal(newTargetReserves);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).targetReserves).to.be.equal(newTargetReserves);
      expect(await cometAsProxy.targetReserves()).to.be.equal(newTargetReserves);
    });

    it('adds asset and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy, unsupportedToken } = await makeConfigurator();

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      const oldNumAssets = await comet.numAssets();
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs.length).to.be.equal(oldNumAssets);

      const newAssetConfig: ConfiguratorAssetConfig = {
        asset: await unsupportedToken.getAddress(),
        priceFeed: await comet.baseTokenPriceFeed(),
        decimals: await unsupportedToken.decimals(),
        borrowCollateralFactor: exp(0.9, 18),
        liquidateCollateralFactor: exp(1, 18),
        liquidationFactor: exp(0.95, 18),
        supplyCap: exp(1_000_000, 8),
      };
      const txn = await wait(configuratorAsProxy.addAsset(await cometProxy.getAddress(), newAssetConfig));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        AddAsset: {
          cometProxy: await cometProxy.getAddress(),
          assetConfig: convertToEventAssetConfig(newAssetConfig),
        }
      });
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs.length).to.be.equal(Number(oldNumAssets) + 1);
      expect(await cometAsProxy.numAssets()).to.be.equal(oldNumAssets + 1n);
      expectAssetConfigsToMatch(newAssetConfig, await cometAsProxy.getAssetInfo(oldNumAssets));
    });

    it('updates asset and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy, tokens } = await makeConfigurator();
      const { COMP } = tokens;

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      const oldNumAssets = await comet.numAssets();
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs.length).to.be.equal(oldNumAssets);

      const oldAssetConfig = (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0];
      const updatedAssetConfig: ConfiguratorAssetConfig = {
        asset: await COMP.getAddress(),
        priceFeed: await comet.baseTokenPriceFeed(),
        decimals: await COMP.decimals(),
        borrowCollateralFactor: exp(0.5, 18),
        liquidateCollateralFactor: exp(0.6, 18),
        liquidationFactor: exp(0.8, 18),
        supplyCap: exp(888, 18),
      };
      const txn = await wait(configuratorAsProxy.updateAsset(await cometProxy.getAddress(), updatedAssetConfig));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        UpdateAsset: {
          cometProxy: await cometProxy.getAddress(),
          oldAssetConfig: [
            oldAssetConfig.asset,
            oldAssetConfig.priceFeed,
            oldAssetConfig.decimals,
            oldAssetConfig.borrowCollateralFactor,
            oldAssetConfig.liquidateCollateralFactor,
            oldAssetConfig.liquidationFactor,
            oldAssetConfig.supplyCap,
          ],
          newAssetConfig: convertToEventAssetConfig(updatedAssetConfig),
        }
      });
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs.length).to.be.equal(oldNumAssets);
      expect(await cometAsProxy.numAssets()).to.be.equal(oldNumAssets);
      expectAssetConfigsToMatch(updatedAssetConfig, await cometAsProxy.getAssetInfo(0));
    });

    it('updates asset priceFeed and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy, tokens, priceFeeds } = await makeConfigurator();
      const { COMP } = tokens;

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].priceFeed)
        .to.be.equal((await comet.getAssetInfo(0)).priceFeed);

      const oldPriceFeed = (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].priceFeed;
      const newPriceFeed = await priceFeeds['WETH'].getAddress();
      const txn = await wait(configuratorAsProxy.updateAssetPriceFeed(await cometProxy.getAddress(), await COMP.getAddress(), newPriceFeed));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        UpdateAssetPriceFeed: {
          cometProxy: await cometProxy.getAddress(),
          asset: await COMP.getAddress(),
          oldPriceFeed,
          newPriceFeed,
        }
      });
      expect(oldPriceFeed).to.be.not.equal(newPriceFeed);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].priceFeed).to.be.equal(newPriceFeed);
      expect((await cometAsProxy.getAssetInfo(0)).priceFeed).to.be.equal(newPriceFeed);
    });

    it('updates asset borrowCollateralFactor and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy, tokens } = await makeConfigurator();
      const { COMP } = tokens;

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect(truncateDecimals((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].borrowCollateralFactor))
        .to.be.equal((await comet.getAssetInfo(0)).borrowCollateralFactor);

      const oldBorrowCF = (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].borrowCollateralFactor;
      const newBorrowCF = exp(0.5, 18);
      const txn = await wait(configuratorAsProxy.updateAssetBorrowCollateralFactor(await cometProxy.getAddress(), await COMP.getAddress(), newBorrowCF));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        UpdateAssetBorrowCollateralFactor: {
          cometProxy: await cometProxy.getAddress(),
          asset: await COMP.getAddress(),
          oldBorrowCF,
          newBorrowCF,
        }
      });
      expect(oldBorrowCF).to.be.not.equal(newBorrowCF);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].borrowCollateralFactor).to.be.equal(newBorrowCF);
      expect((await cometAsProxy.getAssetInfo(0)).borrowCollateralFactor).to.be.equal(newBorrowCF);
    });

    it('updates asset liquidateCollateralFactor and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy, tokens } = await makeConfigurator({
        assets: defaultAssets({}, {
          COMP: { borrowCF: exp(0.5, 18) }
        })
      });
      const { COMP } = tokens;

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].liquidateCollateralFactor)
        .to.be.equal((await comet.getAssetInfo(0)).liquidateCollateralFactor);

      const oldLiquidateCF = (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].liquidateCollateralFactor;
      const newLiquidateCF = exp(0.6, 18); // must be higher than borrowCF
      const txn = await wait(configuratorAsProxy.updateAssetLiquidateCollateralFactor(await cometProxy.getAddress(), await COMP.getAddress(), newLiquidateCF));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        UpdateAssetLiquidateCollateralFactor: {
          cometProxy: await cometProxy.getAddress(),
          asset: await COMP.getAddress(),
          oldLiquidateCF,
          newLiquidateCF,
        }
      });
      expect(oldLiquidateCF).to.be.not.equal(newLiquidateCF);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].liquidateCollateralFactor).to.be.equal(newLiquidateCF);
      expect((await cometAsProxy.getAssetInfo(0)).liquidateCollateralFactor).to.be.equal(newLiquidateCF);
    });

    it('updates asset liquidationFactor and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy, tokens } = await makeConfigurator();
      const { COMP } = tokens;

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].liquidationFactor)
        .to.be.equal((await comet.getAssetInfo(0)).liquidationFactor);

      const oldLiquidationFactor = (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].liquidationFactor;
      const newLiquidationFactor = exp(0.5, 18);
      const txn = await wait(configuratorAsProxy.updateAssetLiquidationFactor(await cometProxy.getAddress(), await COMP.getAddress(), newLiquidationFactor));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        UpdateAssetLiquidationFactor: {
          cometProxy: await cometProxy.getAddress(),
          asset: await COMP.getAddress(),
          oldLiquidationFactor,
          newLiquidationFactor,
        }
      });
      expect(oldLiquidationFactor).to.be.not.equal(newLiquidationFactor);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].liquidationFactor).to.be.equal(newLiquidationFactor);
      expect((await cometAsProxy.getAssetInfo(0)).liquidationFactor).to.be.equal(newLiquidationFactor);
    });

    it('updates asset supplyCap and deploys Comet with new configuration', async () => {
      const { configurator, configuratorProxy, proxyAdmin, cometWithExtendedAssetList: comet, cometProxyWithExtendedAssetList: cometProxy, tokens } = await makeConfigurator();
      const { COMP } = tokens;

      const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), comet.runner);
      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].supplyCap)
        .to.be.equal((await comet.getAssetInfo(0)).supplyCap);

      const oldSupplyCap = (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].supplyCap;
      const newSupplyCap = exp(555, 18);
      const txn = await wait(configuratorAsProxy.updateAssetSupplyCap(await cometProxy.getAddress(), await COMP.getAddress(), newSupplyCap));
      await wait(proxyAdmin.deployAndUpgradeTo(await configuratorProxy.getAddress(), await cometProxy.getAddress()));

      expect(event(txn, 0)).to.be.deep.equal({
        UpdateAssetSupplyCap: {
          cometProxy: await cometProxy.getAddress(),
          asset: await COMP.getAddress(),
          oldSupplyCap,
          newSupplyCap,
        }
      });
      expect(oldSupplyCap).to.be.not.equal(newSupplyCap);
      expect((await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).assetConfigs[0].supplyCap).to.be.equal(newSupplyCap);
      expect((await cometAsProxy.getAssetInfo(0)).supplyCap).to.be.equal(newSupplyCap);
    });

    it('reverts if updating a non-existent asset', async () => {
      const { configurator, configuratorProxy, cometProxyWithExtendedAssetList: cometProxy } = await makeConfigurator();

      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);

      await expect(
        configuratorAsProxy.updateAssetSupplyCap(await cometProxy.getAddress(), ZeroAddress, exp(555, 18))
      ).to.be.revertedWithCustomError(configuratorAsProxy, 'AssetDoesNotExist');
    });

    it('reverts if setter is called from non-governor', async () => {
      const { configuratorProxy, configurator, cometProxyWithExtendedAssetList: cometProxy, users: [alice] } = await makeConfigurator();

      const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), configurator.runner);
      await expect(
        configuratorAsProxy.connect(alice).setGovernor(await cometProxy.getAddress(), alice.address)
      ).to.be.revertedWithCustomError(configuratorAsProxy, 'Unauthorized');
    });
  });
});
