import { AbiCoder, encodeBytes32String, MaxUint256, ZeroAddress } from 'ethers';
import type { Signer, ContractTransactionResponse } from 'ethers';
import type { HardhatEthersSigner as SignerWithAddress } from '@nomicfoundation/hardhat-ethers/types';
import { ethers, annualize, defactor, defaultAssets, event, exp, expect, factor, makeConfigurator, truncateDecimals, wait } from './helpers.js';
import type { Numeric } from './helpers.js';
import { takeSnapshot } from './helpers/snapshot.js';
import type { SnapshotRestorer } from './helpers/snapshot.js';
import { CometExtAssetList__factory, CometFactoryWithExtendedAssetList__factory, CometHarnessInterfaceExtendedAssetList__factory, CometModified__factory, CometModifiedFactory__factory, Configurator__factory, ConfiguratorProxy__factory, MarketAdminPermissionChecker__factory, SimplePriceFeed__factory, SimpleTimelock__factory } from '../build/types/index.js';
import type { CometExtAssetList, CometFactoryWithExtendedAssetList, CometHarnessInterfaceExtendedAssetList, CometProxyAdmin, Configurator, MarketAdminPermissionChecker, SimplePriceFeed, TransparentUpgradeableProxy } from '../build/types/index.js';
import type { CometConfiguration } from '../build/types/Configurator.js';
type ConfigurationStruct = CometConfiguration.ConfigurationStruct;


const abiCoder = AbiCoder.defaultAbiCoder();

type AssetInfoStructOutput = Awaited<ReturnType<CometHarnessInterfaceExtendedAssetList['getAssetInfo']>>;

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


function copyConfiguration(configuration: ConfigurationStruct): ConfigurationStruct {
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
    assetConfigs: configuration.assetConfigs.map(copyAssetConfig),
  };
}

// ethers v6 Result exposes named struct fields without making them enumerable.
function copyAssetConfig(assetConfig: CometConfiguration.AssetConfigStruct): CometConfiguration.AssetConfigStruct {
  return {
    asset: assetConfig.asset,
    priceFeed: assetConfig.priceFeed,
    decimals: assetConfig.decimals,
    borrowCollateralFactor: assetConfig.borrowCollateralFactor,
    liquidateCollateralFactor: assetConfig.liquidateCollateralFactor,
    liquidationFactor: assetConfig.liquidationFactor,
    supplyCap: assetConfig.supplyCap,
  };
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
  // Configurator and its proxy
  let configurator: Configurator;
  let configuratorProxy: Configurator;
  // Comet
  let cometImplementation: CometHarnessInterfaceExtendedAssetList;
  let comet: CometHarnessInterfaceExtendedAssetList;
  let cometProxy: TransparentUpgradeableProxy;
  let cometProxyAdmin: CometProxyAdmin;
  // Signers
  let governor: SignerWithAddress;
  let alice: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;
  // Variables
  let assetListFactoryAddr: string;
  let unsupportedTokenAddr: string;

  before(async () => {
    const protocol = await makeConfigurator();
    configurator = protocol.configurator;
    configuratorProxy = Configurator__factory.connect(await protocol.configuratorProxy.getAddress(), configurator.runner);
    cometImplementation = protocol.cometWithExtendedAssetList;
    cometProxy = protocol.cometProxyWithExtendedAssetList;
    comet = CometHarnessInterfaceExtendedAssetList__factory.connect(await cometProxy.getAddress(), cometImplementation.runner);
    cometProxyAdmin = protocol.proxyAdmin;
    governor = protocol.governor;
    alice = protocol.users[1];
    pauseGuardian = protocol.pauseGuardian;
    assetListFactoryAddr = (await protocol.assetListFactory.getAddress());
    unsupportedTokenAddr = (await protocol.unsupportedToken.getAddress());
  });

  describe('initialization', function () {
    it('version is set to 1 by default', async () => {
      expect(await configuratorProxy.version()).to.be.equal(1);
    });

    it('governor is set to the address of the governor', async () => {
      expect(await configuratorProxy.governor()).to.be.equal(governor.address);
    });

    it('reverts by reinitialization', async () => {
      await expect(configuratorProxy.initialize(governor.address)).to.be.revertedWithCustomError(configurator, 'AlreadyInitialized');
    });

    it('implementation contract cannot be initialized (version == type(uint256).max)', async () => {
      expect(await configurator.version()).to.equal(MaxUint256);

      await expect(configurator.initialize(governor.address))
        .to.be.revertedWithCustomError(configurator, 'AlreadyInitialized');
    });

    describe('fresh proxy initialization', function() {
      let configuratorImplementation: Configurator;
      let proxyFactory: ConfiguratorProxy__factory;

      before(async () => {
        const ConfiguratorFactory = new Configurator__factory(governor);
        configuratorImplementation = await ConfiguratorFactory.deploy();

        proxyFactory = new ConfiguratorProxy__factory(governor);
        const newConfiguratorProxy = await proxyFactory.deploy((await configuratorImplementation.getAddress()), (await cometProxyAdmin.getAddress()), '0x');
        await newConfiguratorProxy.waitForDeployment();
        configuratorImplementation = Configurator__factory.connect(await newConfiguratorProxy.getAddress(), configuratorImplementation.runner);
      });

      it('reverts if initialized with zero address governor (InvalidAddress)', async () => {
        const snapshot = await takeSnapshot();

        expect(await configuratorImplementation.version()).to.equal(0);

        await expect(configuratorImplementation.initialize(ZeroAddress))
          .to.be.revertedWithCustomError(configurator, 'InvalidAddress');

        await snapshot.restore();
      });

      it('fresh proxy can be initialized with a valid governor', async () => {
        await expect(configuratorImplementation.initialize(governor.address)).to.not.be.revert(ethers);

        expect(await configuratorImplementation.governor()).to.equal(governor.address);
        expect(await configuratorImplementation.version()).to.equal(1);
      });

      it('already initialized proxy cannot be reinitialized', async () => {
        await expect(configuratorImplementation.initialize(alice.address))
          .to.be.revertedWithCustomError(configurator, 'AlreadyInitialized');

        expect(await configuratorImplementation.governor()).to.equal(governor.address);
      });
    });
  });

  describe('comet factory setter', function() {
    let setFactoryTx: ContractTransactionResponse;
    let newFactory: CometFactoryWithExtendedAssetList;
    let oldFactory: string;
    before(async () => {
      // Deploy new CometFactory
      const CometFactoryWithExtendedAssetList = new CometFactoryWithExtendedAssetList__factory(governor);
      newFactory = await CometFactoryWithExtendedAssetList.deploy();
      await newFactory.waitForDeployment();
    });

    describe('revert cases', function() {
      it('reverts by non-governor', async () => {
        expect(alice.address).to.not.equal(governor.address);
        await expect(configuratorProxy.connect(alice).setFactory((await cometProxy.getAddress()), ZeroAddress)).to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });
    });

    describe('happy path', function() {
      it('sanity check: current factory != new factory', async () => {
        oldFactory = await configuratorProxy.factory((await cometProxy.getAddress()));
        expect(oldFactory).to.be.not.equal((await newFactory.getAddress()));
      });

      it('sets factory is successful', async () => {
        setFactoryTx = await configuratorProxy.setFactory((await cometProxy.getAddress()), (await newFactory.getAddress()));
        await expect(setFactoryTx).to.not.be.revert(ethers);
      });

      it('setting new factory emits SetFactory event', async () => {
        await expect(setFactoryTx).to.emit(configuratorProxy, 'SetFactory').withArgs((await cometProxy.getAddress()), oldFactory, (await newFactory.getAddress()));
      });

      it('new factory is set and stored in the configurator', async () => {
        expect(await configuratorProxy.factory((await cometProxy.getAddress()))).to.be.equal((await newFactory.getAddress()));
      });
    });

    describe('edge cases', function() {
      let snapshot: SnapshotRestorer;
      before(async () => snapshot = await takeSnapshot());

      it('factory can be set to the same factory', async () => {
        // check current factory
        expect(await configuratorProxy.factory((await cometProxy.getAddress()))).to.be.equal((await newFactory.getAddress()));

        // set factory to the same factory
        await configuratorProxy.connect(governor).setFactory((await cometProxy.getAddress()), (await newFactory.getAddress()));

        // check factory is still the same
        expect(await configuratorProxy.factory((await cometProxy.getAddress()))).to.be.equal((await newFactory.getAddress()));
      });

      it('factory can be set to zero address', async () => {
        await configuratorProxy.connect(governor).setFactory((await cometProxy.getAddress()), ZeroAddress);

        // check factory is set to address(0)
        expect(await configuratorProxy.factory((await cometProxy.getAddress()))).to.be.equal(ZeroAddress);

        await snapshot.restore();
      });
    });
  });

  describe('configuration setting', function() {
    let oldConfiguration: ConfigurationStruct;
    let newConfiguration: ConfigurationStruct;
    before(async () => {
      oldConfiguration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));

      // We clone entire oldConfiguration with some modifications
      newConfiguration = copyConfiguration(oldConfiguration);
    });

    describe('revert cases', function() {
      it('reverts by non-governor', async () => {
        expect(alice.address).to.not.equal(governor.address);
        await expect(configuratorProxy.connect(alice).setConfiguration((await cometProxy.getAddress()), newConfiguration)).to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });

      it('reverts if trackingIndexScale values is changed', async () => {
        newConfiguration = { ...copyConfiguration(newConfiguration), trackingIndexScale: (BigInt(oldConfiguration.trackingIndexScale) + 1n) };

        await expect(configuratorProxy.connect(governor).setConfiguration((await cometProxy.getAddress()), newConfiguration)).to.be.revertedWithCustomError(configurator, 'ConfigurationAlreadyExists');

        newConfiguration = { ...copyConfiguration(newConfiguration), trackingIndexScale: oldConfiguration.trackingIndexScale };
      });

      it('reverts if base token is changed', async () => {
        newConfiguration = { ...copyConfiguration(newConfiguration), baseToken: alice.address };

        await expect(configuratorProxy.connect(governor).setConfiguration((await cometProxy.getAddress()), newConfiguration)).to.be.revertedWithCustomError(configurator, 'ConfigurationAlreadyExists');
      });

      it('reverts if base token is set to zero address', async () => {
        newConfiguration = { ...copyConfiguration(newConfiguration), baseToken: ZeroAddress };

        await expect(configuratorProxy.connect(governor).setConfiguration((await cometProxy.getAddress()), newConfiguration)).to.be.revertedWithCustomError(configurator, 'ConfigurationAlreadyExists');

        newConfiguration = { ...copyConfiguration(newConfiguration), baseToken: oldConfiguration.baseToken };
      });
    });

    describe('happy path', function() {
      let setConfigurationTx: ContractTransactionResponse;
      before(async () => {
        // Make new configuration different from old configuration
        newConfiguration = {
          ...copyConfiguration(newConfiguration),
          baseBorrowMin: (BigInt(newConfiguration.baseBorrowMin) + 1n),
          pauseGuardian: alice.address,
          targetReserves: (BigInt(newConfiguration.targetReserves) + 1n),
        };
      });

      it('sets configuration is successful', async () => {
        setConfigurationTx = await configuratorProxy.connect(governor).setConfiguration((await cometProxy.getAddress()), newConfiguration);
        await expect(setConfigurationTx).to.not.be.revert(ethers);
      });

      it('setting new configuration emits SetConfiguration event (deep equal)', async () => {
        const receipt = await setConfigurationTx.wait();
        if (!receipt) throw new Error('SetConfiguration receipt not found');
        const setConfigurationEvent = receipt.logs
          .filter(log => log.address === (configuratorProxy.target as string))
          .map(log => configuratorProxy.interface.parseLog(log))
          .find(log => log?.name === 'SetConfiguration');
        if (!setConfigurationEvent) throw new Error('SetConfiguration event not found');

        expect(setConfigurationEvent).to.not.be.undefined;

        const {
          cometProxy: cometProxyArg,
          oldConfiguration: oldConfigurationArg,
          newConfiguration: newConfigurationArg,
        } = (setConfigurationEvent).args;

        expect(cometProxyArg).to.equal((await cometProxy.getAddress()));
        // oldConfiguration is a struct Result from getConfiguration(), same shape as event arg
        expect(oldConfigurationArg).to.deep.equal(oldConfiguration);
        // newConfiguration was spread into a plain object, so re-fetch from storage to get a matching struct Result
        const storedNewConfiguration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
        expect(newConfigurationArg).to.deep.equal(storedNewConfiguration);
      });

      it('new configuration is updated in the configurator in storage', async () => {
        const updatedConfiguration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));

        expect(updatedConfiguration.baseBorrowMin).to.be.equal(newConfiguration.baseBorrowMin);
        expect(updatedConfiguration.pauseGuardian).to.be.equal(newConfiguration.pauseGuardian);
        expect(updatedConfiguration.targetReserves).to.be.equal(newConfiguration.targetReserves);
      });
    });

    describe('edge cases', function() {
      it('same configuration can be set multiple times', async () => {
        const currentConfiguration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
        await configuratorProxy.connect(governor).setConfiguration((await cometProxy.getAddress()), copyConfiguration(currentConfiguration));

        const updatedConfiguration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
        expect(updatedConfiguration).to.deep.eq(currentConfiguration);
      });
    });
  });

  describe('comet upgrade', function () {
    // New comet implementation address
    let newCometImplementation: string;
    // Deploy transaction
    let deployTx: ContractTransactionResponse;

    describe('new implementation deployment', function() {
      it('sanity check: configurations and changes', async () => {
        // Current implementation pauseGuardian check
        expect(await comet.pauseGuardian()).to.be.equal(pauseGuardian.address);

        // New configuration pauseGuardian check
        const newConfiguration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
        expect(newConfiguration.pauseGuardian).to.be.equal(alice.address);
      });

      it('deploy new implementation is successful', async () => {
        newCometImplementation = await configuratorProxy.deploy.staticCall((await cometProxy.getAddress()));
        deployTx = await configuratorProxy.deploy((await cometProxy.getAddress()));
        await expect(deployTx).to.not.be.revert(ethers);
      });

      it('deploy emits CometDeployed event', async () => {
        await expect(deployTx)
          .to.emit(configuratorProxy, 'CometDeployed')
          .withArgs((await cometProxy.getAddress()), newCometImplementation);
      });

      it('new implementation has new pauseGuardian', async () => {
        const newComet = await ethers.getContractAt('CometWithExtendedAssetList', newCometImplementation);
        expect(await newComet.pauseGuardian()).to.be.equal(alice.address);
      });

      describe('edge cases', function() {
        it('anyone can deploy new implementation', async () => {
          // From Alice
          await expect(configuratorProxy.connect(alice).deploy((await cometProxy.getAddress()))).to.not.be.revert(ethers);

          // From Governor
          await expect(configuratorProxy.connect(governor).deploy((await cometProxy.getAddress()))).to.not.be.revert(ethers);

          // From Pause Guardian
          await expect(configuratorProxy.connect(pauseGuardian).deploy((await cometProxy.getAddress()))).to.not.be.revert(ethers);
        });
      });
    });

    describe('comet deployment from ProxyAdmin', function() {
      let deployTx: ContractTransactionResponse;

      before(async () => {
        // Change configuration back (pauseguardian to pauseGuardian)
        const currentConfiguration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
        await configuratorProxy.connect(governor).setConfiguration(
          (await cometProxy.getAddress()),
          { ...copyConfiguration(currentConfiguration), pauseGuardian: pauseGuardian.address }
        );
      });

      it('deploy comet from ProxyAdmin is successful', async () => {
        deployTx = await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
        await expect(deployTx).to.not.be.revert(ethers);
      });

      it('deploy emits CometDeployed event', async () => {
        const newImplementation = await cometProxyAdmin.getProxyImplementation((await cometProxy.getAddress()));
        await expect(deployTx)
          .to.emit(configuratorProxy, 'CometDeployed')
          .withArgs((await cometProxy.getAddress()), newImplementation);
      });
    });

    describe('deploy edge cases', function() {
      it('reverts when factory is not set (zero address)', async () => {
        const snapshot = await takeSnapshot();

        await configuratorProxy.connect(governor).setFactory((await cometProxy.getAddress()), ZeroAddress);

        // Reverts with "Error: Transaction reverted without a reason string"
        await expect(configuratorProxy.deploy((await cometProxy.getAddress()))).to.be.revert(ethers);

        await snapshot.restore();
      });

      it('reverts when deploying for a proxy with no configuration', async () => {
        const randomAddr = '0x0000000000000000000000000000000000000042';

        // Reverts with "Error: Transaction reverted without a reason string"
        await expect(configuratorProxy.deploy(randomAddr)).to.be.revert(ethers);
      });
    });
  });

  describe('setters', function() {
    describe('governor setter', function() {
      let setGovernorTx: ContractTransactionResponse;
      let newCometGovernor: SignerWithAddress;
      let oldCometGovernor: string;

      describe('revert cases', function() {
        it('reverts by non-governor', async () => {
          newCometGovernor = (await ethers.getSigners())[5];
          expect(alice.address).to.not.equal(governor.address);
          await expect(configuratorProxy.connect(alice).setGovernor((await cometProxy.getAddress()), (await newCometGovernor.getAddress())))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });

      describe('happy path', function() {
        let deployTx: ContractTransactionResponse;

        it('sanity check: current comet governor != new governor', async () => {
          const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          oldCometGovernor = configuration.governor;
          newCometGovernor = (await ethers.getSigners())[5];
          expect(oldCometGovernor).to.not.equal((await newCometGovernor.getAddress()));
        });

        it('sanity check: comet proxy has old governor before change', async () => {
          expect(await comet.governor()).to.be.equal(oldCometGovernor);
        });

        it('setGovernor is successful', async () => {
          setGovernorTx = await configuratorProxy.connect(governor).setGovernor((await cometProxy.getAddress()), (await newCometGovernor.getAddress()));
          await expect(setGovernorTx).to.not.be.revert(ethers);
        });

        it('setting new governor emits SetGovernor event', async () => {
          await expect(setGovernorTx)
            .to.emit(configuratorProxy, 'SetGovernor')
            .withArgs((await cometProxy.getAddress()), oldCometGovernor, (await newCometGovernor.getAddress()));
        });

        it('new governor is stored in configurator configuration', async () => {
          const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          expect(configuration.governor).to.be.equal((await newCometGovernor.getAddress()));
        });

        it('deploy and upgrade from ProxyAdmin is successful', async () => {
          deployTx = await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          await expect(deployTx).to.not.be.revert(ethers);
        });

        it('deploy emits CometDeployed event', async () => {
          const newCometImplementation = await cometProxyAdmin.getProxyImplementation((await cometProxy.getAddress()));
          await expect(deployTx)
            .to.emit(configuratorProxy, 'CometDeployed')
            .withArgs((await cometProxy.getAddress()), newCometImplementation);
        });

        it('comet proxy has new governor after upgrade', async () => {
          expect(await comet.governor()).to.be.equal((await newCometGovernor.getAddress()));
        });
      });

      describe('edge cases', function() {
        let snapshot: SnapshotRestorer;
        before(async () => (snapshot = await takeSnapshot()));

        it('governor can be set to the same address', async () => {
          const currentConfiguration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));

          await configuratorProxy.connect(governor).setGovernor((await cometProxy.getAddress()), currentConfiguration.governor);

          const updatedConfiguration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          expect(updatedConfiguration.governor).to.be.equal(currentConfiguration.governor);
        });

        it('governor can be set to zero address', async () => {
          await configuratorProxy.connect(governor).setGovernor((await cometProxy.getAddress()), ZeroAddress);

          const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));

          expect(configuration.governor).to.be.equal(ZeroAddress);
          await snapshot.restore();
        });
      });
    });

    describe('pauseGuardian setter', function() {
      let setPauseGuardianTx: ContractTransactionResponse;
      let newPauseGuardian: SignerWithAddress;
      let oldPauseGuardian: string;

      describe('revert cases', function() {
        it('reverts by non-governor', async () => {
          newPauseGuardian = (await ethers.getSigners())[6];
          await expect(configuratorProxy.connect(alice).setPauseGuardian((await cometProxy.getAddress()), (await newPauseGuardian.getAddress())))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });

      describe('edge cases', function() {
        it('can be set to zero address', async () => {
          await configuratorProxy.connect(governor).setPauseGuardian((await cometProxy.getAddress()), ZeroAddress);
          expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).pauseGuardian).to.be.equal(ZeroAddress);
        });
      });

      describe('happy path', function() {
        it('sanity check: current and new pause guardian are different', async () => {
          newPauseGuardian = (await ethers.getSigners())[6];
          const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          oldPauseGuardian = configuration.pauseGuardian;
          expect(oldPauseGuardian).to.not.equal((await newPauseGuardian.getAddress()));
        });

        it('setPauseGuardian is successful', async () => {
          setPauseGuardianTx = await configuratorProxy.connect(governor).setPauseGuardian((await cometProxy.getAddress()), (await newPauseGuardian.getAddress()));
          await expect(setPauseGuardianTx).to.not.be.revert(ethers);
        });

        it('emits SetPauseGuardian event', async () => {
          await expect(setPauseGuardianTx)
            .to.emit(configuratorProxy, 'SetPauseGuardian')
            .withArgs((await cometProxy.getAddress()), oldPauseGuardian, (await newPauseGuardian.getAddress()));
        });

        it('new pauseGuardian is updated in configuration', async () => {
          const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          expect(configuration.pauseGuardian).to.be.equal((await newPauseGuardian.getAddress()));
        });

        it('deploy and upgrade comet with new configuration', async () => {
          await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
        });

        it('pauseGuardian is updated in comet', async () => {
          expect(await comet.pauseGuardian()).to.be.equal((await newPauseGuardian.getAddress()));
        });
      });
    });

    describe('setMarketAdminPermissionChecker', function() {
      let setTx: ContractTransactionResponse;
      let newChecker: MarketAdminPermissionChecker;
      let oldChecker: string;

      before(async () => {
        const Factory = new MarketAdminPermissionChecker__factory(governor);
        newChecker = await Factory.deploy(governor.address, ZeroAddress, ZeroAddress);
        await newChecker.waitForDeployment();
      });

      describe('revert cases', function() {
        it('reverts by non-governor', async () => {
          await expect(configuratorProxy.connect(alice).setMarketAdminPermissionChecker((await newChecker.getAddress())))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });

      describe('edge cases', function() {
        it('can be set to zero address', async () => {
          await configuratorProxy.connect(governor).setMarketAdminPermissionChecker(ZeroAddress);
          expect(await configuratorProxy.marketAdminPermissionChecker()).to.be.equal(ZeroAddress);
        });
      });

      describe('happy path', function() {
        it('sanity check: current and new checker are different', async () => {
          oldChecker = await configuratorProxy.marketAdminPermissionChecker();
          expect(oldChecker).to.not.equal((await newChecker.getAddress()));
        });

        it('sets MarketAdminPermissionChecker successfully', async () => {
          setTx = await configuratorProxy.connect(governor).setMarketAdminPermissionChecker((await newChecker.getAddress()));
          await expect(setTx).to.not.be.revert(ethers);
        });

        it('emits SetMarketAdminPermissionChecker event', async () => {
          await expect(setTx)
            .to.emit(configuratorProxy, 'SetMarketAdminPermissionChecker')
            .withArgs(oldChecker, (await newChecker.getAddress()));
        });

        it('new checker is stored', async () => {
          expect(await configuratorProxy.marketAdminPermissionChecker()).to.be.equal((await newChecker.getAddress()));
        });
      });
    });

    describe('setBaseTokenPriceFeed', function() {
      let setTx: ContractTransactionResponse;
      let newPriceFeed: SimplePriceFeed;
      let oldPriceFeed: string;

      before(async () => {
        oldPriceFeed = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).baseTokenPriceFeed;
        const PriceFeedFactory = new SimplePriceFeed__factory(governor);
        newPriceFeed = await PriceFeedFactory.deploy(exp(200, 8), 8);
      });

      describe('revert cases', function() {
        it('reverts by non-governor', async () => {
          await expect(configuratorProxy.connect(alice).setBaseTokenPriceFeed((await cometProxy.getAddress()), (await newPriceFeed.getAddress())))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });

      describe('edge cases', function() {
        it('can be set to zero address', async () => {
          const snapshot: SnapshotRestorer = await takeSnapshot();

          await configuratorProxy.connect(governor).setBaseTokenPriceFeed((await cometProxy.getAddress()), ZeroAddress);
          expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).baseTokenPriceFeed).to.be.equal(ZeroAddress);

          await snapshot.restore();
        });
      });

      describe('happy path', function() {
        it('sets baseTokenPriceFeed successfully', async () => {
          setTx = await configuratorProxy.connect(governor).setBaseTokenPriceFeed((await cometProxy.getAddress()), (await newPriceFeed.getAddress()));
          await expect(setTx).to.not.be.revert(ethers);
        });

        it('emits SetBaseTokenPriceFeed event', async () => {
          await expect(setTx)
            .to.emit(configuratorProxy, 'SetBaseTokenPriceFeed')
            .withArgs((await cometProxy.getAddress()), oldPriceFeed, (await newPriceFeed.getAddress()));
        });

        it('new baseTokenPriceFeed is stored in configuration', async () => {
          const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          expect(configuration.baseTokenPriceFeed).to.be.equal((await newPriceFeed.getAddress()));
        });

        it('deploy and upgrade comet with new configuration', async () => {
          await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
        });

        it('baseTokenPriceFeed is updated in comet', async () => {
          expect(await comet.baseTokenPriceFeed()).to.be.equal((await newPriceFeed.getAddress()));
        });
      });
    });

    describe('setExtensionDelegate', function() {
      let setTx: ContractTransactionResponse;
      let newExtensionDelegate: CometExtAssetList;
      let oldExtensionDelegate: string;

      before(async () => {
        oldExtensionDelegate = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).extensionDelegate;

        const name32 = encodeBytes32String('Compound Comet');
        const symbol32 = encodeBytes32String('cBASE');
        const ExtFactory = new CometExtAssetList__factory(governor);
        newExtensionDelegate = await ExtFactory.deploy({ name32, symbol32 }, assetListFactoryAddr);
      });

      describe('revert cases', function() {
        it('reverts by non-governor', async () => {
          await expect(configuratorProxy.connect(alice).setExtensionDelegate((await cometProxy.getAddress()), (await newExtensionDelegate.getAddress())))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });

      describe('edge cases', function() {
        it('can be set to zero address', async () => {
          const snapshot: SnapshotRestorer = await takeSnapshot();

          await configuratorProxy.connect(governor).setExtensionDelegate((await cometProxy.getAddress()), ZeroAddress);
          expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).extensionDelegate).to.be.equal(ZeroAddress);

          await snapshot.restore();
        });
      });

      describe('happy path', function() {
        it('sets extensionDelegate successfully', async () => {
          setTx = await configuratorProxy.connect(governor).setExtensionDelegate((await cometProxy.getAddress()), (await newExtensionDelegate.getAddress()));
          await expect(setTx).to.not.be.revert(ethers);
        });

        it('emits SetExtensionDelegate event', async () => {
          await expect(setTx)
            .to.emit(configuratorProxy, 'SetExtensionDelegate')
            .withArgs((await cometProxy.getAddress()), oldExtensionDelegate, (await newExtensionDelegate.getAddress()));
        });

        it('new extensionDelegate is stored in configuration', async () => {
          const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          expect(configuration.extensionDelegate).to.be.equal((await newExtensionDelegate.getAddress()));
        });

        it('deploy and upgrade comet with new configuration', async () => {
          await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
        });

        it('extensionDelegate is updated in comet', async () => {
          expect(await comet.extensionDelegate()).to.be.equal((await newExtensionDelegate.getAddress()));
        });
      });
    });

    describe('interest rate setters (governorOrMarketAdmin)', function() {
      const SECONDS_PER_YEAR = 31_536_000n;

      describe('setSupplyKink', function() {
        const NEW_SUPPLY_KINK = exp(0.7, 18);
        let oldSupplyKink: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setSupplyKink((await cometProxy.getAddress()), exp(0.7, 18)))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setSupplyKink((await cometProxy.getAddress()), 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).supplyKink).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new supply kink are different', async () => {
            oldSupplyKink = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).supplyKink;
            expect(oldSupplyKink).to.not.equal(NEW_SUPPLY_KINK);
          });

          it('sets supplyKink successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setSupplyKink((await cometProxy.getAddress()), NEW_SUPPLY_KINK);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetSupplyKink event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetSupplyKink')
              .withArgs((await cometProxy.getAddress()), oldSupplyKink, NEW_SUPPLY_KINK);
          });

          it('new supplyKink is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.supplyKink).to.be.equal(NEW_SUPPLY_KINK);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('supplyKink is updated in comet', async () => {
            expect(await comet.supplyKink()).to.be.equal(NEW_SUPPLY_KINK);
          });
        });
      });

      describe('setSupplyPerYearInterestRateSlopeLow', function() {
        const NEW_SLOPE_LOW = exp(0.06, 18);
        let oldSlopeLow: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setSupplyPerYearInterestRateSlopeLow((await cometProxy.getAddress()), NEW_SLOPE_LOW))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setSupplyPerYearInterestRateSlopeLow((await cometProxy.getAddress()), 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).supplyPerYearInterestRateSlopeLow).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new supply slope low are different', async () => {
            oldSlopeLow = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).supplyPerYearInterestRateSlopeLow;
            expect(oldSlopeLow).to.not.equal(NEW_SLOPE_LOW);
          });

          it('sets supplyPerYearInterestRateSlopeLow successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setSupplyPerYearInterestRateSlopeLow((await cometProxy.getAddress()), NEW_SLOPE_LOW);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetSupplyPerYearInterestRateSlopeLow event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetSupplyPerYearInterestRateSlopeLow')
              .withArgs((await cometProxy.getAddress()), oldSlopeLow, NEW_SLOPE_LOW);
          });

          it('new supplyPerYearInterestRateSlopeLow is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.supplyPerYearInterestRateSlopeLow).to.be.equal(NEW_SLOPE_LOW);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('supplyPerSecondInterestRateSlopeLow is updated in comet', async () => {
            const expectedPerSecond = NEW_SLOPE_LOW / SECONDS_PER_YEAR;
            expect(await comet.supplyPerSecondInterestRateSlopeLow()).to.equal(expectedPerSecond);
          });
        });
      });

      describe('setSupplyPerYearInterestRateSlopeHigh', function() {
        const NEW_SLOPE_HIGH = exp(2.5, 18);
        let oldSlopeHigh: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setSupplyPerYearInterestRateSlopeHigh((await cometProxy.getAddress()), NEW_SLOPE_HIGH))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setSupplyPerYearInterestRateSlopeHigh((await cometProxy.getAddress()), 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).supplyPerYearInterestRateSlopeHigh).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new supply slope high are different', async () => {
            oldSlopeHigh = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).supplyPerYearInterestRateSlopeHigh;
            expect(oldSlopeHigh).to.not.equal(NEW_SLOPE_HIGH);
          });

          it('sets supplyPerYearInterestRateSlopeHigh successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setSupplyPerYearInterestRateSlopeHigh((await cometProxy.getAddress()), NEW_SLOPE_HIGH);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetSupplyPerYearInterestRateSlopeHigh event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetSupplyPerYearInterestRateSlopeHigh')
              .withArgs((await cometProxy.getAddress()), oldSlopeHigh, NEW_SLOPE_HIGH);
          });

          it('new supplyPerYearInterestRateSlopeHigh is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.supplyPerYearInterestRateSlopeHigh).to.be.equal(NEW_SLOPE_HIGH);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('supplyPerSecondInterestRateSlopeHigh is updated in comet', async () => {
            const expectedPerSecond = NEW_SLOPE_HIGH / SECONDS_PER_YEAR;
            expect(await comet.supplyPerSecondInterestRateSlopeHigh()).to.equal(expectedPerSecond);
          });
        });
      });

      describe('setSupplyPerYearInterestRateBase', function() {
        const NEW_BASE = exp(0.01, 18);
        let oldBase: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setSupplyPerYearInterestRateBase((await cometProxy.getAddress()), NEW_BASE))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setSupplyPerYearInterestRateBase((await cometProxy.getAddress()), 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).supplyPerYearInterestRateBase).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new supply base are different', async () => {
            oldBase = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).supplyPerYearInterestRateBase;
            expect(oldBase).to.not.equal(NEW_BASE);
          });

          it('sets supplyPerYearInterestRateBase successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setSupplyPerYearInterestRateBase((await cometProxy.getAddress()), NEW_BASE);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetSupplyPerYearInterestRateBase event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetSupplyPerYearInterestRateBase')
              .withArgs((await cometProxy.getAddress()), oldBase, NEW_BASE);
          });

          it('new supplyPerYearInterestRateBase is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.supplyPerYearInterestRateBase).to.be.equal(NEW_BASE);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('supplyPerSecondInterestRateBase is updated in comet', async () => {
            const expectedPerSecond = NEW_BASE / SECONDS_PER_YEAR;
            expect(await comet.supplyPerSecondInterestRateBase()).to.equal(expectedPerSecond);
          });
        });
      });

      describe('setBorrowKink', function() {
        const NEW_BORROW_KINK = exp(0.75, 18);
        let oldBorrowKink: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBorrowKink((await cometProxy.getAddress()), NEW_BORROW_KINK))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setBorrowKink((await cometProxy.getAddress()), 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).borrowKink).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new borrow kink are different', async () => {
            oldBorrowKink = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).borrowKink;
            expect(oldBorrowKink).to.not.equal(NEW_BORROW_KINK);
          });

          it('sets borrowKink successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBorrowKink((await cometProxy.getAddress()), NEW_BORROW_KINK);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetBorrowKink event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBorrowKink')
              .withArgs((await cometProxy.getAddress()), oldBorrowKink, NEW_BORROW_KINK);
          });

          it('new borrowKink is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.borrowKink).to.be.equal(NEW_BORROW_KINK);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('borrowKink is updated in comet', async () => {
            expect(await comet.borrowKink()).to.be.equal(NEW_BORROW_KINK);
          });
        });
      });

      describe('setBorrowPerYearInterestRateSlopeLow', function() {
        const NEW_SLOPE_LOW = exp(0.12, 18);
        let oldSlopeLow: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBorrowPerYearInterestRateSlopeLow((await cometProxy.getAddress()), NEW_SLOPE_LOW))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setBorrowPerYearInterestRateSlopeLow((await cometProxy.getAddress()), 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).borrowPerYearInterestRateSlopeLow).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new borrow slope low are different', async () => {
            oldSlopeLow = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).borrowPerYearInterestRateSlopeLow;
            expect(oldSlopeLow).to.not.equal(NEW_SLOPE_LOW);
          });

          it('sets borrowPerYearInterestRateSlopeLow successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBorrowPerYearInterestRateSlopeLow((await cometProxy.getAddress()), NEW_SLOPE_LOW);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetBorrowPerYearInterestRateSlopeLow event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBorrowPerYearInterestRateSlopeLow')
              .withArgs((await cometProxy.getAddress()), oldSlopeLow, NEW_SLOPE_LOW);
          });

          it('new borrowPerYearInterestRateSlopeLow is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.borrowPerYearInterestRateSlopeLow).to.be.equal(NEW_SLOPE_LOW);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('borrowPerSecondInterestRateSlopeLow is updated in comet', async () => {
            const expectedPerSecond = NEW_SLOPE_LOW / SECONDS_PER_YEAR;
            expect(await comet.borrowPerSecondInterestRateSlopeLow()).to.equal(expectedPerSecond);
          });
        });
      });

      describe('setBorrowPerYearInterestRateSlopeHigh', function() {
        const NEW_SLOPE_HIGH = exp(3.5, 18);
        let oldSlopeHigh: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBorrowPerYearInterestRateSlopeHigh((await cometProxy.getAddress()), NEW_SLOPE_HIGH))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setBorrowPerYearInterestRateSlopeHigh((await cometProxy.getAddress()), 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).borrowPerYearInterestRateSlopeHigh).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new borrow slope high are different', async () => {
            oldSlopeHigh = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).borrowPerYearInterestRateSlopeHigh;
            expect(oldSlopeHigh).to.not.equal(NEW_SLOPE_HIGH);
          });

          it('sets borrowPerYearInterestRateSlopeHigh successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBorrowPerYearInterestRateSlopeHigh((await cometProxy.getAddress()), NEW_SLOPE_HIGH);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetBorrowPerYearInterestRateSlopeHigh event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBorrowPerYearInterestRateSlopeHigh')
              .withArgs((await cometProxy.getAddress()), oldSlopeHigh, NEW_SLOPE_HIGH);
          });

          it('new borrowPerYearInterestRateSlopeHigh is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.borrowPerYearInterestRateSlopeHigh).to.be.equal(NEW_SLOPE_HIGH);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('borrowPerSecondInterestRateSlopeHigh is updated in comet', async () => {
            const expectedPerSecond = NEW_SLOPE_HIGH / SECONDS_PER_YEAR;
            expect(await comet.borrowPerSecondInterestRateSlopeHigh()).to.equal(expectedPerSecond);
          });
        });
      });

      describe('setBorrowPerYearInterestRateBase', function() {
        const NEW_BASE = exp(0.006, 18);
        let oldBase: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBorrowPerYearInterestRateBase((await cometProxy.getAddress()), NEW_BASE))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setBorrowPerYearInterestRateBase((await cometProxy.getAddress()), 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).borrowPerYearInterestRateBase).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new borrow base are different', async () => {
            oldBase = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).borrowPerYearInterestRateBase;
            expect(oldBase).to.not.equal(NEW_BASE);
          });

          it('sets borrowPerYearInterestRateBase successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBorrowPerYearInterestRateBase((await cometProxy.getAddress()), NEW_BASE);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetBorrowPerYearInterestRateBase event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBorrowPerYearInterestRateBase')
              .withArgs((await cometProxy.getAddress()), oldBase, NEW_BASE);
          });

          it('new borrowPerYearInterestRateBase is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.borrowPerYearInterestRateBase).to.be.equal(NEW_BASE);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('borrowPerSecondInterestRateBase is updated in comet', async () => {
            const expectedPerSecond = NEW_BASE / SECONDS_PER_YEAR;
            expect(await comet.borrowPerSecondInterestRateBase()).to.equal(expectedPerSecond);
          });
        });
      });
    });

    describe('other governor-only setters', function() {
      describe('setStoreFrontPriceFactor', function() {
        const NEW_STORE_FRONT_PRICE_FACTOR = exp(0.95, 18);
        let oldStoreFrontPriceFactor: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setStoreFrontPriceFactor((await cometProxy.getAddress()), NEW_STORE_FRONT_PRICE_FACTOR))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot: SnapshotRestorer = await takeSnapshot();

            await configuratorProxy.connect(governor).setStoreFrontPriceFactor((await cometProxy.getAddress()), 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).storeFrontPriceFactor).to.be.equal(0);

            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new store front price factor are different', async () => {
            oldStoreFrontPriceFactor = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).storeFrontPriceFactor;
            expect(oldStoreFrontPriceFactor).to.not.equal(NEW_STORE_FRONT_PRICE_FACTOR);
          });

          it('sets storeFrontPriceFactor successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setStoreFrontPriceFactor((await cometProxy.getAddress()), NEW_STORE_FRONT_PRICE_FACTOR);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetStoreFrontPriceFactor event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetStoreFrontPriceFactor')
              .withArgs((await cometProxy.getAddress()), oldStoreFrontPriceFactor, NEW_STORE_FRONT_PRICE_FACTOR);
          });

          it('new storeFrontPriceFactor is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.storeFrontPriceFactor).to.equal(NEW_STORE_FRONT_PRICE_FACTOR);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('storeFrontPriceFactor is updated in comet', async () => {
            expect(await comet.storeFrontPriceFactor()).to.equal(NEW_STORE_FRONT_PRICE_FACTOR);
          });
        });
      });

      describe('setBaseTrackingSupplySpeed', function() {
        const NEW_BASE_TRACKING_SUPPLY_SPEED = exp(2, 15);
        let oldBaseTrackingSupplySpeed: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBaseTrackingSupplySpeed((await cometProxy.getAddress()), NEW_BASE_TRACKING_SUPPLY_SPEED))
              .to.be.revert(ethers);
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot: SnapshotRestorer = await takeSnapshot();
            await configuratorProxy.connect(governor).setBaseTrackingSupplySpeed((await cometProxy.getAddress()), 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).baseTrackingSupplySpeed).to.be.equal(0);
            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new base tracking supply speed are different', async () => {
            oldBaseTrackingSupplySpeed = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).baseTrackingSupplySpeed;
            expect(oldBaseTrackingSupplySpeed).to.not.equal(NEW_BASE_TRACKING_SUPPLY_SPEED);
          });

          it('sets baseTrackingSupplySpeed successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBaseTrackingSupplySpeed((await cometProxy.getAddress()), NEW_BASE_TRACKING_SUPPLY_SPEED);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetBaseTrackingSupplySpeed event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBaseTrackingSupplySpeed')
              .withArgs((await cometProxy.getAddress()), oldBaseTrackingSupplySpeed, NEW_BASE_TRACKING_SUPPLY_SPEED);
          });

          it('new baseTrackingSupplySpeed is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.baseTrackingSupplySpeed).to.equal(NEW_BASE_TRACKING_SUPPLY_SPEED);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('baseTrackingSupplySpeed is updated in comet', async () => {
            expect(await comet.baseTrackingSupplySpeed()).to.equal(NEW_BASE_TRACKING_SUPPLY_SPEED);
          });
        });
      });

      describe('setBaseTrackingBorrowSpeed', function() {
        const NEW_BASE_TRACKING_BORROW_SPEED = exp(2, 15);
        let oldBaseTrackingBorrowSpeed: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBaseTrackingBorrowSpeed((await cometProxy.getAddress()), NEW_BASE_TRACKING_BORROW_SPEED))
              .to.be.revert(ethers);
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot: SnapshotRestorer = await takeSnapshot();
            await configuratorProxy.connect(governor).setBaseTrackingBorrowSpeed((await cometProxy.getAddress()), 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).baseTrackingBorrowSpeed).to.be.equal(0);
            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new base tracking borrow speed are different', async () => {
            oldBaseTrackingBorrowSpeed = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).baseTrackingBorrowSpeed;
            expect(oldBaseTrackingBorrowSpeed).to.not.equal(NEW_BASE_TRACKING_BORROW_SPEED);
          });

          it('sets baseTrackingBorrowSpeed successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBaseTrackingBorrowSpeed((await cometProxy.getAddress()), NEW_BASE_TRACKING_BORROW_SPEED);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetBaseTrackingBorrowSpeed event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBaseTrackingBorrowSpeed')
              .withArgs((await cometProxy.getAddress()), oldBaseTrackingBorrowSpeed, NEW_BASE_TRACKING_BORROW_SPEED);
          });

          it('new baseTrackingBorrowSpeed is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.baseTrackingBorrowSpeed).to.equal(NEW_BASE_TRACKING_BORROW_SPEED);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('baseTrackingBorrowSpeed is updated in comet', async () => {
            expect(await comet.baseTrackingBorrowSpeed()).to.equal(NEW_BASE_TRACKING_BORROW_SPEED);
          });
        });
      });

      describe('setBaseMinForRewards', function() {
        const NEW_BASE_MIN_FOR_REWARDS = exp(2, 6);
        let oldBaseMinForRewards: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBaseMinForRewards((await cometProxy.getAddress()), NEW_BASE_MIN_FOR_REWARDS))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to same value', async () => {
            const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            await configuratorProxy.connect(governor).setBaseMinForRewards((await cometProxy.getAddress()), config.baseMinForRewards);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).baseMinForRewards).to.equal(config.baseMinForRewards);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new base min for rewards are different', async () => {
            oldBaseMinForRewards = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).baseMinForRewards;
            expect(oldBaseMinForRewards).to.not.equal(NEW_BASE_MIN_FOR_REWARDS);
          });

          it('sets baseMinForRewards successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBaseMinForRewards((await cometProxy.getAddress()), NEW_BASE_MIN_FOR_REWARDS);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetBaseMinForRewards event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBaseMinForRewards')
              .withArgs((await cometProxy.getAddress()), oldBaseMinForRewards, NEW_BASE_MIN_FOR_REWARDS);
          });

          it('new baseMinForRewards is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.baseMinForRewards).to.equal(NEW_BASE_MIN_FOR_REWARDS);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('baseMinForRewards is updated in comet', async () => {
            expect(await comet.baseMinForRewards()).to.equal(NEW_BASE_MIN_FOR_REWARDS);
          });
        });
      });

      describe('setBaseBorrowMin', function() {
        const NEW_BASE_BORROW_MIN = exp(2, 6);
        let oldBaseBorrowMin: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBaseBorrowMin((await cometProxy.getAddress()), NEW_BASE_BORROW_MIN))
              .to.be.revert(ethers);
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot: SnapshotRestorer = await takeSnapshot();
            await configuratorProxy.connect(governor).setBaseBorrowMin((await cometProxy.getAddress()), 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).baseBorrowMin).to.be.equal(0);
            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new base borrow min are different', async () => {
            oldBaseBorrowMin = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).baseBorrowMin;
            expect(oldBaseBorrowMin).to.not.equal(NEW_BASE_BORROW_MIN);
          });

          it('sets baseBorrowMin successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBaseBorrowMin((await cometProxy.getAddress()), NEW_BASE_BORROW_MIN);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetBaseBorrowMin event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBaseBorrowMin')
              .withArgs((await cometProxy.getAddress()), oldBaseBorrowMin, NEW_BASE_BORROW_MIN);
          });

          it('new baseBorrowMin is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.baseBorrowMin).to.equal(NEW_BASE_BORROW_MIN);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('baseBorrowMin is updated in comet', async () => {
            expect(await comet.baseBorrowMin()).to.equal(NEW_BASE_BORROW_MIN);
          });
        });
      });

      describe('setTargetReserves', function() {
        const NEW_TARGET_RESERVES = exp(1, 6);
        let oldTargetReserves: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setTargetReserves((await cometProxy.getAddress()), NEW_TARGET_RESERVES))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot: SnapshotRestorer = await takeSnapshot();
            await configuratorProxy.connect(governor).setTargetReserves((await cometProxy.getAddress()), 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).targetReserves).to.be.equal(0);
            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new target reserves are different', async () => {
            oldTargetReserves = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).targetReserves;
            expect(oldTargetReserves).to.not.equal(NEW_TARGET_RESERVES);
          });

          it('sets targetReserves successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setTargetReserves((await cometProxy.getAddress()), NEW_TARGET_RESERVES);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits SetTargetReserves event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetTargetReserves')
              .withArgs((await cometProxy.getAddress()), oldTargetReserves, NEW_TARGET_RESERVES);
          });

          it('new targetReserves is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.targetReserves).to.equal(NEW_TARGET_RESERVES);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('targetReserves is updated in comet', async () => {
            expect(await comet.targetReserves()).to.equal(NEW_TARGET_RESERVES);
          });
        });
      });
    });

    describe('asset update setters', function() {
      let firstAsset: { asset: string, priceFeed: string };

      before(async () => {
        const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
        firstAsset = {
          asset: config.assetConfigs[0].asset,
          priceFeed: config.assetConfigs[0].priceFeed,
        };
      });

      describe('updateAssetPriceFeed', function() {
        let newPriceFeed: SimplePriceFeed;
        let oldPriceFeed: string;
        let setTx: ContractTransactionResponse;

        before(async () => {
          const PriceFeedFactory = new SimplePriceFeed__factory(governor);
          newPriceFeed = await PriceFeedFactory.deploy(exp(500, 8), 8);
          await newPriceFeed.waitForDeployment();
        });

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).updateAssetPriceFeed((await cometProxy.getAddress()), firstAsset.asset, (await newPriceFeed.getAddress())))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero address', async () => {
            const snapshot = await takeSnapshot();

            await configuratorProxy.connect(governor).updateAssetPriceFeed((await cometProxy.getAddress()), firstAsset.asset, ZeroAddress);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].priceFeed).to.be.equal(ZeroAddress);

            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new price feed are different', async () => {
            oldPriceFeed = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].priceFeed;
            expect(oldPriceFeed).to.not.equal((await newPriceFeed.getAddress()));
          });

          it('updates asset price feed successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetPriceFeed((await cometProxy.getAddress()), firstAsset.asset, (await newPriceFeed.getAddress()));
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits UpdateAssetPriceFeed event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetPriceFeed')
              .withArgs((await cometProxy.getAddress()), firstAsset.asset, oldPriceFeed, (await newPriceFeed.getAddress()));
          });

          it('new priceFeed is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.assetConfigs[0].priceFeed).to.be.equal((await newPriceFeed.getAddress()));
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('priceFeed is updated in comet', async () => {
            const assetInfo = await comet.getAssetInfoByAddress(firstAsset.asset);
            expect(assetInfo.priceFeed).to.be.equal((await newPriceFeed.getAddress()));
          });
        });
      });

      describe('updateAssetBorrowCollateralFactor', function() {
        const NEW_BORROW_CF = exp(0.9, 18);
        let oldBorrowCF: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).updateAssetBorrowCollateralFactor((await cometProxy.getAddress()), firstAsset.asset, NEW_BORROW_CF))
              .to.be.revert(ethers);
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot = await takeSnapshot();

            await configuratorProxy.connect(governor).updateAssetBorrowCollateralFactor((await cometProxy.getAddress()), firstAsset.asset, 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].borrowCollateralFactor).to.be.equal(0);

            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new borrow collateral factor are different', async () => {
            oldBorrowCF = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].borrowCollateralFactor;
            expect(oldBorrowCF).to.not.equal(NEW_BORROW_CF);
          });

          it('updates asset borrow collateral factor successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetBorrowCollateralFactor((await cometProxy.getAddress()), firstAsset.asset, NEW_BORROW_CF);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits UpdateAssetBorrowCollateralFactor event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetBorrowCollateralFactor')
              .withArgs((await cometProxy.getAddress()), firstAsset.asset, oldBorrowCF, NEW_BORROW_CF);
          });

          it('new borrowCollateralFactor is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.assetConfigs[0].borrowCollateralFactor).to.be.equal(NEW_BORROW_CF);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('borrowCollateralFactor is updated in comet', async () => {
            const assetInfo = await comet.getAssetInfoByAddress(firstAsset.asset);
            expect(assetInfo.borrowCollateralFactor).to.be.equal(NEW_BORROW_CF);
          });
        });
      });

      describe('updateAssetLiquidateCollateralFactor', function() {
        const NEW_LIQUIDATE_CF = exp(0.95, 18);
        let oldLiquidateCF: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).updateAssetLiquidateCollateralFactor((await cometProxy.getAddress()), firstAsset.asset, NEW_LIQUIDATE_CF))
              .to.be.revert(ethers);
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot = await takeSnapshot();

            await configuratorProxy.connect(governor).updateAssetLiquidateCollateralFactor((await cometProxy.getAddress()), firstAsset.asset, 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].liquidateCollateralFactor).to.be.equal(0);

            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new liquidate collateral factor are different', async () => {
            oldLiquidateCF = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].liquidateCollateralFactor;
            expect(oldLiquidateCF).to.not.equal(NEW_LIQUIDATE_CF);
          });

          it('updates asset liquidate collateral factor successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetLiquidateCollateralFactor((await cometProxy.getAddress()), firstAsset.asset, NEW_LIQUIDATE_CF);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits UpdateAssetLiquidateCollateralFactor event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetLiquidateCollateralFactor')
              .withArgs((await cometProxy.getAddress()), firstAsset.asset, oldLiquidateCF, NEW_LIQUIDATE_CF);
          });

          it('new liquidateCollateralFactor is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.assetConfigs[0].liquidateCollateralFactor).to.be.equal(NEW_LIQUIDATE_CF);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('liquidateCollateralFactor is updated in comet', async () => {
            const assetInfo = await comet.getAssetInfoByAddress(firstAsset.asset);
            expect(assetInfo.liquidateCollateralFactor).to.be.equal(NEW_LIQUIDATE_CF);
          });
        });
      });

      describe('updateAssetLiquidationFactor', function() {
        const NEW_LIQUIDATION_FACTOR = exp(0.95, 18);
        let oldLiquidationFactor: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).updateAssetLiquidationFactor((await cometProxy.getAddress()), firstAsset.asset, NEW_LIQUIDATION_FACTOR))
              .to.be.revert(ethers);
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot = await takeSnapshot();
            await configuratorProxy.connect(governor).updateAssetLiquidationFactor((await cometProxy.getAddress()), firstAsset.asset, 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].liquidationFactor).to.be.equal(0);
            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new liquidation factor are different', async () => {
            oldLiquidationFactor = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].liquidationFactor;
            expect(oldLiquidationFactor).to.not.equal(NEW_LIQUIDATION_FACTOR);
          });

          it('updates asset liquidation factor successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetLiquidationFactor((await cometProxy.getAddress()), firstAsset.asset, NEW_LIQUIDATION_FACTOR);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits UpdateAssetLiquidationFactor event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetLiquidationFactor')
              .withArgs((await cometProxy.getAddress()), firstAsset.asset, oldLiquidationFactor, NEW_LIQUIDATION_FACTOR);
          });

          it('new liquidationFactor is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.assetConfigs[0].liquidationFactor).to.be.equal(NEW_LIQUIDATION_FACTOR);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('liquidationFactor is updated in comet', async () => {
            const assetInfo = await comet.getAssetInfoByAddress(firstAsset.asset);
            expect(assetInfo.liquidationFactor).to.be.equal(NEW_LIQUIDATION_FACTOR);
          });
        });
      });

      describe('updateAssetSupplyCap', function() {
        const NEW_SUPPLY_CAP = exp(200, 18);
        let oldSupplyCap: bigint;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).updateAssetSupplyCap((await cometProxy.getAddress()), firstAsset.asset, NEW_SUPPLY_CAP))
              .to.be.revert(ethers);
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).updateAssetSupplyCap((await cometProxy.getAddress()), firstAsset.asset, 0);
            expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].supplyCap).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new supply cap are different', async () => {
            oldSupplyCap = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].supplyCap;
            expect(oldSupplyCap).to.not.equal(NEW_SUPPLY_CAP);
          });

          it('updates asset supply cap successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetSupplyCap((await cometProxy.getAddress()), firstAsset.asset, NEW_SUPPLY_CAP);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits UpdateAssetSupplyCap event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetSupplyCap')
              .withArgs((await cometProxy.getAddress()), firstAsset.asset, oldSupplyCap, NEW_SUPPLY_CAP);
          });

          it('new supplyCap is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(configuration.assetConfigs[0].supplyCap).to.be.equal(NEW_SUPPLY_CAP);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('supplyCap is updated in comet', async () => {
            const assetInfo = await comet.getAssetInfoByAddress(firstAsset.asset);
            expect(assetInfo.supplyCap).to.be.equal(NEW_SUPPLY_CAP);
          });
        });
      });

      describe('addAsset', function() {
        let newPriceFeedAddr: string;
        let newAssetConfig: { asset: string, priceFeed: string, decimals: number, borrowCollateralFactor: bigint, liquidateCollateralFactor: bigint, liquidationFactor: bigint, supplyCap: bigint };
        let setTx: ContractTransactionResponse;

        before(async () => {
          const PriceFeedFactory = new SimplePriceFeed__factory(governor);
          const feed = await PriceFeedFactory.deploy(exp(100, 8), 8);
          await feed.waitForDeployment();
          newPriceFeedAddr = (await feed.getAddress());
          newAssetConfig = {
            asset: unsupportedTokenAddr,
            priceFeed: newPriceFeedAddr,
            decimals: 6,
            borrowCollateralFactor: exp(0.8, 18),
            liquidateCollateralFactor: exp(0.9, 18),
            liquidationFactor: exp(0.95, 18),
            supplyCap: exp(100, 6),
          };
        });

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).addAsset((await cometProxy.getAddress()), newAssetConfig))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('happy path', function() {
          it('sanity check: asset does not exist in comet yet', async () => {
            await expect(comet.getAssetInfoByAddress(unsupportedTokenAddr)).to.be.revert(ethers);
          });

          it('adds asset successfully', async () => {
            setTx = await configuratorProxy.connect(governor).addAsset((await cometProxy.getAddress()), newAssetConfig);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits AddAsset event', async () => {
            await expect(setTx).to.emit(configuratorProxy, 'AddAsset');
          });

          it('new asset is stored in configuration', async () => {
            const updated = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(updated.assetConfigs[updated.assetConfigs.length - 1].asset).to.equal(unsupportedTokenAddr);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('new asset is available in comet', async () => {
            const assetInfo = await comet.getAssetInfoByAddress(unsupportedTokenAddr);
            expect(assetInfo.asset).to.equal(unsupportedTokenAddr);
          });
        });
      });

      describe('updateAsset', function() {
        const NEW_BORROW_CF = exp(0.85, 18);
        let oldAssetConfig: CometConfiguration.AssetConfigStruct;
        let setTx: ContractTransactionResponse;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            const assetConfig0 = config.assetConfigs[0];
            const newAssetConfig = {
              ...copyAssetConfig(assetConfig0),
              borrowCollateralFactor: NEW_BORROW_CF,
            };
            await expect(configuratorProxy.connect(alice).updateAsset((await cometProxy.getAddress()), newAssetConfig))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new borrow collateral factor are different', async () => {
            oldAssetConfig = (await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0];
            expect(oldAssetConfig.borrowCollateralFactor).to.not.equal(NEW_BORROW_CF);
          });

          it('updates asset successfully', async () => {
            const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            const assetConfig0 = config.assetConfigs[0];
            const newAssetConfig = {
              ...copyAssetConfig(assetConfig0),
              borrowCollateralFactor: NEW_BORROW_CF,
            };
            setTx = await configuratorProxy.connect(governor).updateAsset((await cometProxy.getAddress()), newAssetConfig);
            await expect(setTx).to.not.be.revert(ethers);
          });

          it('emits UpdateAsset event', async () => {
            await expect(setTx).to.emit(configuratorProxy, 'UpdateAsset');
          });

          it('new borrowCollateralFactor is stored in configuration', async () => {
            const updated = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
            expect(updated.assetConfigs[0].borrowCollateralFactor).to.equal(NEW_BORROW_CF);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo((await configuratorProxy.getAddress()), (await cometProxy.getAddress()));
          });

          it('borrowCollateralFactor is updated in comet', async () => {
            const assetInfo = await comet.getAssetInfoByAddress(firstAsset.asset);
            expect(assetInfo.borrowCollateralFactor).to.equal(NEW_BORROW_CF);
          });
        });
      });

      describe('getAssetIndex', function() {
        it('returns correct index for existing asset', async () => {
          const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          const firstAssetAddr = config.assetConfigs[0].asset;
          const index = await configuratorProxy.getAssetIndex((await cometProxy.getAddress()), firstAssetAddr);
          expect(index).to.equal(0);
        });

        it('reverts with AssetDoesNotExist for non-existent asset', async () => {
          await expect(configuratorProxy.getAssetIndex((await cometProxy.getAddress()), ZeroAddress))
            .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
        });

        it('reverts with AssetDoesNotExist for random address', async () => {
          await expect(configuratorProxy.getAssetIndex((await cometProxy.getAddress()), alice.address))
            .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
        });
      });

      describe('asset setter reverts on non-existent asset', function() {
        const NON_EXISTENT_ASSET = '0x0000000000000000000000000000000000000001';

        it('updateAssetPriceFeed reverts with AssetDoesNotExist', async () => {
          await expect(configuratorProxy.connect(governor).updateAssetPriceFeed((await cometProxy.getAddress()), NON_EXISTENT_ASSET, ZeroAddress))
            .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
        });

        it('updateAssetBorrowCollateralFactor reverts with AssetDoesNotExist', async () => {
          await expect(configuratorProxy.connect(governor).updateAssetBorrowCollateralFactor((await cometProxy.getAddress()), NON_EXISTENT_ASSET, exp(0.5, 18)))
            .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
        });

        it('updateAssetLiquidateCollateralFactor reverts with AssetDoesNotExist', async () => {
          await expect(configuratorProxy.connect(governor).updateAssetLiquidateCollateralFactor((await cometProxy.getAddress()), NON_EXISTENT_ASSET, exp(0.5, 18)))
            .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
        });

        it('updateAssetLiquidationFactor reverts with AssetDoesNotExist', async () => {
          await expect(configuratorProxy.connect(governor).updateAssetLiquidationFactor((await cometProxy.getAddress()), NON_EXISTENT_ASSET, exp(0.5, 18)))
            .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
        });

        it('updateAssetSupplyCap reverts with AssetDoesNotExist', async () => {
          await expect(configuratorProxy.connect(governor).updateAssetSupplyCap((await cometProxy.getAddress()), NON_EXISTENT_ASSET, exp(100, 18)))
            .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
        });

        it('updateAsset reverts with AssetDoesNotExist', async () => {
          const config = {
            asset: NON_EXISTENT_ASSET,
            priceFeed: ZeroAddress,
            decimals: 6,
            borrowCollateralFactor: exp(0.8, 18),
            liquidateCollateralFactor: exp(0.9, 18),
            liquidationFactor: exp(0.95, 18),
            supplyCap: exp(100, 6),
          };
          await expect(configuratorProxy.connect(governor).updateAsset((await cometProxy.getAddress()), config))
            .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
        });
      });

      describe('addAsset edge cases', function() {
        it('can add duplicate asset (no on-chain guard)', async () => {
          const snapshot = await takeSnapshot();

          const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          const existingAsset = config.assetConfigs[0];
          const numAssetsBefore = config.assetConfigs.length;

          await configuratorProxy.connect(governor).addAsset((await cometProxy.getAddress()), copyAssetConfig(existingAsset));

          const updated = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          expect(updated.assetConfigs.length).to.equal(numAssetsBefore + 1);
          expect(updated.assetConfigs[updated.assetConfigs.length - 1].asset).to.equal(existingAsset.asset);

          await snapshot.restore();
        });
      });
    });

    describe('transferGovernor', function() {
      let transferTx: ContractTransactionResponse;
      let newGovernor: SignerWithAddress;
      let oldGovernor: string;

      describe('revert cases', function() {
        it('reverts by non-governor', async () => {
          await expect(configuratorProxy.connect(alice).transferGovernor(alice.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });

      describe('edge cases', function() {
        it('can transfer to zero address (bricks the configurator)', async () => {
          const snapshot = await takeSnapshot();

          await configuratorProxy.connect(governor).transferGovernor(ZeroAddress);
          expect(await configuratorProxy.governor()).to.equal(ZeroAddress);

          await expect(configuratorProxy.connect(governor).transferGovernor(governor.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');

          await snapshot.restore();
        });

        it('can transfer to the same governor', async () => {
          await configuratorProxy.connect(governor).transferGovernor(governor.address);
          expect(await configuratorProxy.governor()).to.equal(governor.address);
        });
      });

      describe('happy path', function() {
        let snapshot: SnapshotRestorer;
        before(async () => {
          snapshot = await takeSnapshot();
          newGovernor = alice;
        });
        after(async () => await snapshot.restore());

        it('sanity check: current and new governor are different', async () => {
          oldGovernor = await configuratorProxy.governor();
          expect(oldGovernor).to.not.equal(newGovernor.address);
        });

        it('transfers governor successfully', async () => {
          transferTx = await configuratorProxy.connect(governor).transferGovernor(newGovernor.address);
          await expect(transferTx).to.not.be.revert(ethers);
        });

        it('emits GovernorTransferred event', async () => {
          await expect(transferTx)
            .to.emit(configuratorProxy, 'GovernorTransferred')
            .withArgs(oldGovernor, newGovernor.address);
        });

        it('new governor is stored in configurator', async () => {
          expect(await configuratorProxy.governor()).to.equal(newGovernor.address);
        });

        it('new governor can call governor-only functions', async () => {
          await expect(configuratorProxy.connect(newGovernor).setGovernor((await cometProxy.getAddress()), newGovernor.address))
            .to.not.be.revert(ethers);
        });

        it('old governor can no longer call governor-only functions', async () => {
          await expect(configuratorProxy.connect(governor).setGovernor((await cometProxy.getAddress()), governor.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });
    });

    describe('governorOrMarketAdmin modifier', function() {
      let marketAdmin: SignerWithAddress;
      let permissionChecker: MarketAdminPermissionChecker;
      let snapshot: SnapshotRestorer;

      before(async () => {
        snapshot = await takeSnapshot();

        marketAdmin = (await ethers.getSigners())[7];

        const Factory = new MarketAdminPermissionChecker__factory(governor);
        permissionChecker = await Factory.deploy(governor.address, marketAdmin.address, ZeroAddress);
        await permissionChecker.waitForDeployment();

        await configuratorProxy.connect(governor).setMarketAdminPermissionChecker((await permissionChecker.getAddress()));
      });

      after(async () => await snapshot.restore());

      describe('market admin can call governorOrMarketAdmin functions', function() {
        it('market admin can call setSupplyKink', async () => {
          const innerSnapshot = await takeSnapshot();
          const newKink = exp(0.85, 18);
          await expect(configuratorProxy.connect(marketAdmin).setSupplyKink((await cometProxy.getAddress()), newKink))
            .to.not.be.revert(ethers);
          expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).supplyKink).to.equal(newKink);
          await innerSnapshot.restore();
        });

        it('market admin can call setBorrowKink', async () => {
          const innerSnapshot = await takeSnapshot();
          const newKink = exp(0.65, 18);
          await expect(configuratorProxy.connect(marketAdmin).setBorrowKink((await cometProxy.getAddress()), newKink))
            .to.not.be.revert(ethers);
          expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).borrowKink).to.equal(newKink);
          await innerSnapshot.restore();
        });

        it('market admin can call setSupplyPerYearInterestRateSlopeLow', async () => {
          const innerSnapshot = await takeSnapshot();
          const newVal = exp(0.05, 18);
          await expect(configuratorProxy.connect(marketAdmin).setSupplyPerYearInterestRateSlopeLow((await cometProxy.getAddress()), newVal))
            .to.not.be.revert(ethers);
          expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).supplyPerYearInterestRateSlopeLow).to.equal(newVal);
          await innerSnapshot.restore();
        });

        it('market admin can call updateAssetBorrowCollateralFactor', async () => {
          const innerSnapshot = await takeSnapshot();
          const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          const assetAddr = config.assetConfigs[0].asset;
          const newVal = exp(0.8, 18);
          await expect(configuratorProxy.connect(marketAdmin).updateAssetBorrowCollateralFactor((await cometProxy.getAddress()), assetAddr, newVal))
            .to.not.be.revert(ethers);
          expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].borrowCollateralFactor).to.equal(newVal);
          await innerSnapshot.restore();
        });

        it('market admin can call updateAssetLiquidateCollateralFactor', async () => {
          const innerSnapshot = await takeSnapshot();
          const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          const assetAddr = config.assetConfigs[0].asset;
          const newVal = exp(0.92, 18);
          await expect(configuratorProxy.connect(marketAdmin).updateAssetLiquidateCollateralFactor((await cometProxy.getAddress()), assetAddr, newVal))
            .to.not.be.revert(ethers);
          expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].liquidateCollateralFactor).to.equal(newVal);
          await innerSnapshot.restore();
        });

        it('market admin can call updateAssetLiquidationFactor', async () => {
          const innerSnapshot = await takeSnapshot();
          const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          const assetAddr = config.assetConfigs[0].asset;
          const newVal = exp(0.93, 18);
          await expect(configuratorProxy.connect(marketAdmin).updateAssetLiquidationFactor((await cometProxy.getAddress()), assetAddr, newVal))
            .to.not.be.revert(ethers);
          expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].liquidationFactor).to.equal(newVal);
          await innerSnapshot.restore();
        });

        it('market admin can call updateAssetSupplyCap', async () => {
          const innerSnapshot = await takeSnapshot();
          const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          const assetAddr = config.assetConfigs[0].asset;
          const newVal = exp(500, 18);
          await expect(configuratorProxy.connect(marketAdmin).updateAssetSupplyCap((await cometProxy.getAddress()), assetAddr, newVal))
            .to.not.be.revert(ethers);
          expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).assetConfigs[0].supplyCap).to.equal(newVal);
          await innerSnapshot.restore();
        });

        it('market admin can call setBaseBorrowMin', async () => {
          const innerSnapshot = await takeSnapshot();
          const newVal = exp(5, 6);
          await expect(configuratorProxy.connect(marketAdmin).setBaseBorrowMin((await cometProxy.getAddress()), newVal))
            .to.not.be.revert(ethers);
          expect((await configuratorProxy.getConfiguration((await cometProxy.getAddress()))).baseBorrowMin).to.equal(newVal);
          await innerSnapshot.restore();
        });
      });

      describe('market admin cannot call governor-only functions', function() {
        it('market admin cannot call setFactory', async () => {
          await expect(configuratorProxy.connect(marketAdmin).setFactory((await cometProxy.getAddress()), ZeroAddress))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });

        it('market admin cannot call setGovernor', async () => {
          await expect(configuratorProxy.connect(marketAdmin).setGovernor((await cometProxy.getAddress()), marketAdmin.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });

        it('market admin cannot call setPauseGuardian', async () => {
          await expect(configuratorProxy.connect(marketAdmin).setPauseGuardian((await cometProxy.getAddress()), marketAdmin.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });

        it('market admin cannot call setConfiguration', async () => {
          const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
          await expect(configuratorProxy.connect(marketAdmin).setConfiguration((await cometProxy.getAddress()), copyConfiguration(config)))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });

        it('market admin cannot call addAsset', async () => {
          const assetConfig = {
            asset: unsupportedTokenAddr,
            priceFeed: ZeroAddress,
            decimals: 6,
            borrowCollateralFactor: exp(0.8, 18),
            liquidateCollateralFactor: exp(0.9, 18),
            liquidationFactor: exp(0.95, 18),
            supplyCap: exp(100, 6),
          };
          await expect(configuratorProxy.connect(marketAdmin).addAsset((await cometProxy.getAddress()), assetConfig))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });

        it('market admin cannot call transferGovernor', async () => {
          await expect(configuratorProxy.connect(marketAdmin).transferGovernor(marketAdmin.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });

      describe('paused market admin cannot call governorOrMarketAdmin functions', function() {
        let innerSnapshot: SnapshotRestorer;
        before(async () => {
          innerSnapshot = await takeSnapshot();
          await permissionChecker.connect(governor).pauseMarketAdmin();
        });
        after(async () => await innerSnapshot.restore());

        it('paused market admin cannot call setSupplyKink', async () => {
          await expect(configuratorProxy.connect(marketAdmin).setSupplyKink((await cometProxy.getAddress()), exp(0.5, 18)))
            .to.be.revert(ethers);
        });
      });
    });

    describe('idempotency (setting same value)', function() {
      it('setSupplyKink emits event with old == new when setting same value', async () => {
        const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
        const currentKink = config.supplyKink;

        const tx = await configuratorProxy.connect(governor).setSupplyKink((await cometProxy.getAddress()), currentKink);
        await expect(tx)
          .to.emit(configuratorProxy, 'SetSupplyKink')
          .withArgs((await cometProxy.getAddress()), currentKink, currentKink);
      });

      it('setBorrowKink emits event with old == new when setting same value', async () => {
        const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
        const currentKink = config.borrowKink;

        const tx = await configuratorProxy.connect(governor).setBorrowKink((await cometProxy.getAddress()), currentKink);
        await expect(tx)
          .to.emit(configuratorProxy, 'SetBorrowKink')
          .withArgs((await cometProxy.getAddress()), currentKink, currentKink);
      });

      it('setPauseGuardian emits event with old == new when setting same value', async () => {
        const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
        const currentGuardian = config.pauseGuardian;

        const tx = await configuratorProxy.connect(governor).setPauseGuardian((await cometProxy.getAddress()), currentGuardian);
        await expect(tx)
          .to.emit(configuratorProxy, 'SetPauseGuardian')
          .withArgs((await cometProxy.getAddress()), currentGuardian, currentGuardian);
      });

      it('setBaseTokenPriceFeed emits event with old == new when setting same value', async () => {
        const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
        const currentFeed = config.baseTokenPriceFeed;

        const tx = await configuratorProxy.connect(governor).setBaseTokenPriceFeed((await cometProxy.getAddress()), currentFeed);
        await expect(tx)
          .to.emit(configuratorProxy, 'SetBaseTokenPriceFeed')
          .withArgs((await cometProxy.getAddress()), currentFeed, currentFeed);
      });

      it('setTargetReserves emits event with old == new when setting same value', async () => {
        const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
        const currentReserves = config.targetReserves;

        const tx = await configuratorProxy.connect(governor).setTargetReserves((await cometProxy.getAddress()), currentReserves);
        await expect(tx)
          .to.emit(configuratorProxy, 'SetTargetReserves')
          .withArgs((await cometProxy.getAddress()), currentReserves, currentReserves);
      });

      it('updateAssetSupplyCap emits event with old == new when setting same value', async () => {
        const config = await configuratorProxy.getConfiguration((await cometProxy.getAddress()));
        const assetAddr = config.assetConfigs[0].asset;
        const currentCap = config.assetConfigs[0].supplyCap;

        const tx = await configuratorProxy.connect(governor).updateAssetSupplyCap((await cometProxy.getAddress()), assetAddr, currentCap);
        await expect(tx)
          .to.emit(configuratorProxy, 'UpdateAssetSupplyCap')
          .withArgs((await cometProxy.getAddress()), assetAddr, currentCap, currentCap);
      });
    });
  });
});

describe('configurator deployed-configuration regressions', function () {
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
