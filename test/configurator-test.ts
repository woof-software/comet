import { annualize, defactor, defaultAssets, ethers, event, exp, expect, factor, makeConfigurator, Numeric, SnapshotRestorer, takeSnapshot, truncateDecimals, wait, ZERO_ADDRESS } from './helpers';
import {
  CometExtAssetList,
  CometExtAssetList__factory,
  CometFactoryWithExtendedAssetList,
  CometFactoryWithExtendedAssetList__factory,
  CometHarnessExtendedAssetList,
  CometHarnessInterfaceExtendedAssetList,
  CometModifiedFactory__factory,
  CometProxyAdmin,
  Configurator__factory,
  MarketAdminPermissionChecker,
  MarketAdminPermissionChecker__factory,
  SimplePriceFeed,
  SimplePriceFeed__factory,
  SimpleTimelock__factory,
  TransparentUpgradeableProxy
} from '../build/types';
import { AssetInfoStructOutput } from '../build/types/CometHarnessInterface';
import { ConfigurationStruct, ConfigurationStructOutput, Configurator } from '../build/types/Configurator';
import { BigNumber, ContractTransaction } from 'ethers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

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
    configuration.supplyKink.toBigInt(),
    configuration.supplyPerYearInterestRateSlopeLow.toBigInt(),
    configuration.supplyPerYearInterestRateSlopeHigh.toBigInt(),
    configuration.supplyPerYearInterestRateBase.toBigInt(),
    configuration.borrowKink.toBigInt(),
    configuration.borrowPerYearInterestRateSlopeLow.toBigInt(),
    configuration.borrowPerYearInterestRateSlopeHigh.toBigInt(),
    configuration.borrowPerYearInterestRateBase.toBigInt(),
    configuration.storeFrontPriceFactor.toBigInt(),
    configuration.trackingIndexScale.toBigInt(),
    configuration.baseTrackingSupplySpeed.toBigInt(),
    configuration.baseTrackingBorrowSpeed.toBigInt(),
    configuration.baseMinForRewards.toBigInt(),
    configuration.baseBorrowMin.toBigInt(),
    configuration.targetReserves.toBigInt(),
    [] // leave asset configs empty for simplicity
  ];
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

describe.only('configurator', function () {
  // Configurator and its proxy
  let configurator: Configurator;
  let configuratorProxy: Configurator;
  // Comet
  let cometImplementation: CometHarnessInterfaceExtendedAssetList;
  let comet: CometHarnessInterfaceExtendedAssetList;
  let cometProxy: TransparentUpgradeableProxy;
  let cometProxyAdmin: CometProxyAdmin;

  let governor: SignerWithAddress;
  let alice: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;
  let assetListFactoryAddr: string;
  let unsupportedTokenAddr: string;

  before(async () => {
    const protocol = await makeConfigurator();
    configurator = protocol.configurator;
    configuratorProxy = configurator.attach(protocol.configuratorProxy.address);
    cometImplementation = protocol.cometWithExtendedAssetList;
    cometProxy = protocol.cometProxyWithExtendedAssetList;
    comet = cometImplementation.attach(cometProxy.address);
    cometProxyAdmin = protocol.proxyAdmin;
    governor = protocol.governor;
    alice = protocol.users[1];
    pauseGuardian = protocol.pauseGuardian;
    assetListFactoryAddr = protocol.assetListFactory.address;
    unsupportedTokenAddr = protocol.unsupportedToken.address;
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
  });

  describe('comet factory setter', function() {
    let setFactoryTx: ContractTransaction;
    let newFactory: CometFactoryWithExtendedAssetList;
    let oldFactory: string;
    before(async () => {
      // Deploy new CometFactory
      const CometFactoryWithExtendedAssetList = (await ethers.getContractFactory('CometFactoryWithExtendedAssetList')) as CometFactoryWithExtendedAssetList__factory;
      newFactory = await CometFactoryWithExtendedAssetList.deploy();
      await newFactory.deployed();
    });
    
    describe('revert cases', function() {
      it('reverts by non-governor', async () => {
        expect(alice.address).to.not.equal(governor.address);
        await expect(configuratorProxy.connect(alice).setFactory(cometProxy.address, ethers.constants.AddressZero)).to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });
    });

    describe('happy path', function() {
      it('sanity check: current factory != new factory', async () => {
        oldFactory = await configuratorProxy.factory(cometProxy.address);
        expect(oldFactory).to.be.not.equal(newFactory.address);
      });

      it('sets factory is successful', async () => {
        setFactoryTx = await configuratorProxy.setFactory(cometProxy.address, newFactory.address);
        await expect(setFactoryTx).to.not.be.reverted;
      });

      it('setting new factory emits SetFactory event', async () => {
        await expect(setFactoryTx).to.emit(configuratorProxy, 'SetFactory').withArgs(cometProxy.address, oldFactory, newFactory.address);
      });

      it('new factory is set and stored in the configurator', async () => {
        expect(await configuratorProxy.factory(cometProxy.address)).to.be.equal(newFactory.address);
      });
    });

    describe('edge cases', function() {
      let snapshot: SnapshotRestorer;
      before(async () => snapshot = await takeSnapshot());

      it('factory can be set to the same factory', async () => {
        // check current factory
        expect(await configuratorProxy.factory(cometProxy.address)).to.be.equal(newFactory.address);

        // set factory to the same factory
        await configuratorProxy.connect(governor).setFactory(cometProxy.address, newFactory.address);

        // check factory is still the same
        expect(await configuratorProxy.factory(cometProxy.address)).to.be.equal(newFactory.address);
      });

      it('factory can be set to zero address', async () => {
        await configuratorProxy.connect(governor).setFactory(cometProxy.address, ZERO_ADDRESS);

        // check factory is set to address(0)
        expect(await configuratorProxy.factory(cometProxy.address)).to.be.equal(ethers.constants.AddressZero);

        await snapshot.restore();
      });
    });
  });

  describe('configuration setting', function() {
    let oldConfiguration: ConfigurationStruct;
    let newConfiguration: ConfigurationStruct;
    before(async () => {
      oldConfiguration = await configuratorProxy.getConfiguration(cometProxy.address);

      // We clone entire oldConfiguration with some modifications
      newConfiguration = oldConfiguration;
    });

    describe('revert cases', function() {
      it('reverts by non-governor', async () => {
        expect(alice.address).to.not.equal(governor.address);
        await expect(configuratorProxy.connect(alice).setConfiguration(cometProxy.address, newConfiguration)).to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });

      it('reverts if trackingIndexScale values is changed', async () => {
        newConfiguration = { ...newConfiguration, trackingIndexScale: BigNumber.from(oldConfiguration.trackingIndexScale).add(1) };

        await expect(configuratorProxy.connect(governor).setConfiguration(cometProxy.address, newConfiguration)).to.be.revertedWithCustomError(configurator, 'ConfigurationAlreadyExists');

        newConfiguration = { ...newConfiguration, trackingIndexScale: oldConfiguration.trackingIndexScale };
      });

      it('reverts if base token is changed', async () => {
        newConfiguration = { ...newConfiguration, baseToken: alice.address };

        await expect(configuratorProxy.connect(governor).setConfiguration(cometProxy.address, newConfiguration)).to.be.revertedWithCustomError(configurator, 'ConfigurationAlreadyExists');
      });

      it('reverts if base token is set to zero address', async () => {
        newConfiguration = { ...newConfiguration, baseToken: ZERO_ADDRESS };

        await expect(configuratorProxy.connect(governor).setConfiguration(cometProxy.address, newConfiguration)).to.be.revertedWithCustomError(configurator, 'ConfigurationAlreadyExists');

        newConfiguration = { ...newConfiguration, baseToken: oldConfiguration.baseToken };
      });
    });

    describe('happy path', function() {
      let setConfigurationTx: ContractTransaction;
      before(async () => {
        // Make new configuration different from old configuration
        newConfiguration = {
          ...newConfiguration,
          baseBorrowMin: BigNumber.from(newConfiguration.baseBorrowMin).add(1),
          pauseGuardian: alice.address,
          targetReserves: BigNumber.from(newConfiguration.targetReserves).add(1),
        };
      });

      it('sets configuration is successful', async () => {
        setConfigurationTx = await configuratorProxy.connect(governor).setConfiguration(cometProxy.address, newConfiguration);
        await expect(setConfigurationTx).to.not.be.reverted;
      });

      it('setting new configuration emits SetConfiguration event', async () => {
        const receipt = await setConfigurationTx.wait();
        const setConfigurationEvent = receipt.events?.find((e) => e.event === 'SetConfiguration');

        expect(setConfigurationEvent).to.not.be.undefined;

        const {
          cometProxy: cometProxyArg,
          oldConfiguration: oldConfigurationArg,
          newConfiguration: newConfigurationArg,
        } = (setConfigurationEvent as any).args;

        expect(cometProxyArg).to.equal(cometProxy.address);
        expect(convertToEventConfiguration(oldConfigurationArg)).to.deep.eq(
          convertToEventConfiguration(oldConfiguration as any),
        );
        expect(convertToEventConfiguration(newConfigurationArg)).to.deep.eq(
          convertToEventConfiguration(newConfiguration as any),
        );
      });

      it('new configuration is updated in the configurator in storage', async () => {
        const updatedConfiguration = await configuratorProxy.getConfiguration(cometProxy.address);
        
        expect(updatedConfiguration.baseBorrowMin).to.be.equal(newConfiguration.baseBorrowMin);
        expect(updatedConfiguration.pauseGuardian).to.be.equal(newConfiguration.pauseGuardian);
        expect(updatedConfiguration.targetReserves).to.be.equal(newConfiguration.targetReserves);
      });
    });

    describe('edge cases', function() {
      it('same configuration can be set multiple times', async () => {
        const currentConfiguration = await configuratorProxy.getConfiguration(cometProxy.address);
        await configuratorProxy.connect(governor).setConfiguration(cometProxy.address, currentConfiguration);

        const updatedConfiguration = await configuratorProxy.getConfiguration(cometProxy.address);
        expect(updatedConfiguration).to.deep.eq(currentConfiguration);
      });
    });
  });

  describe('comet upgrade', function () {
    // New comet implementation address
    let newCometImplementation: string;
    // Deploy transaction
    let deployTx: ContractTransaction;

    describe('new implementation deployment', function() {
      it('sanity check: configurations and changes', async () => {
        // Current implementation pauseGuardian check
        expect(await comet.pauseGuardian()).to.be.equal(pauseGuardian.address);

        // New configuration pauseGuardian check
        const newConfiguration = await configuratorProxy.getConfiguration(cometProxy.address);
        expect(newConfiguration.pauseGuardian).to.be.equal(alice.address);
      });

      it('deploy new implementation is successful', async () => {
        newCometImplementation = await configuratorProxy.callStatic.deploy(cometProxy.address);
        deployTx = await configuratorProxy.deploy(cometProxy.address);
        await expect(deployTx).to.not.be.reverted;
      });

      it('deploy emits CometDeployed event', async () => {
        await expect(deployTx)
          .to.emit(configuratorProxy, 'CometDeployed')
          .withArgs(cometProxy.address, newCometImplementation);
      });

      it('new implementation has new pauseGuardian', async () => {
        const newComet = await ethers.getContractAt('CometWithExtendedAssetList', newCometImplementation);
        expect(await newComet.pauseGuardian()).to.be.equal(alice.address);
      });

      describe('edge cases', function() {
        it('anyone can deploy new implementation', async () => {
          // From Alice
          await expect(configuratorProxy.connect(alice).deploy(cometProxy.address)).to.not.be.reverted;
  
          // From Governor
          await expect(configuratorProxy.connect(governor).deploy(cometProxy.address)).to.not.be.reverted;
  
          // From Pause Guardian
          await expect(configuratorProxy.connect(pauseGuardian).deploy(cometProxy.address)).to.not.be.reverted;
        });
      });
    });

    describe('comet deployment from ProxyAdmin', function() {
      let deployTx: ContractTransaction;

      before(async () => {
        // Change configuration back (pauseguardian to pauseGuardian)
        const currentConfiguration = await configuratorProxy.getConfiguration(cometProxy.address);
        await configuratorProxy.connect(governor).setConfiguration(
          cometProxy.address,
          { ...currentConfiguration, pauseGuardian: pauseGuardian.address }
        );
      });

      it('deploy comet from ProxyAdmin is successful', async () => {
        deployTx = await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
        await expect(deployTx).to.not.be.reverted;
      });

      it('deploy emits CometDeployed event', async () => {
        const newImplementation = await cometProxyAdmin.getProxyImplementation(cometProxy.address);
        await expect(deployTx)
          .to.emit(configuratorProxy, 'CometDeployed')
          .withArgs(cometProxy.address, newImplementation);
      });
    });
  });

  describe('setters', function() {
    describe('governor setter', function() {
      let setGovernorTx: ContractTransaction;
      let newCometGovernor: SignerWithAddress;
      let oldCometGovernor: string;

      describe('revert cases', function() {
        it('reverts by non-governor', async () => {
          newCometGovernor = (await ethers.getSigners())[5];
          expect(alice.address).to.not.equal(governor.address);
          await expect(configuratorProxy.connect(alice).setGovernor(cometProxy.address, newCometGovernor.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });

      describe('happy path', function() {
        let deployTx: ContractTransaction;

        it('sanity check: current comet governor != new governor', async () => {
          const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
          oldCometGovernor = configuration.governor;
          newCometGovernor = (await ethers.getSigners())[5];
          expect(oldCometGovernor).to.not.equal(newCometGovernor.address);
        });

        it('sanity check: comet proxy has old governor before change', async () => {
          expect(await comet.governor()).to.be.equal(oldCometGovernor);
        });

        it('setGovernor is successful', async () => {
          setGovernorTx = await configuratorProxy.connect(governor).setGovernor(cometProxy.address, newCometGovernor.address);
          await expect(setGovernorTx).to.not.be.reverted;
        });

        it('setting new governor emits SetGovernor event', async () => {
          await expect(setGovernorTx)
            .to.emit(configuratorProxy, 'SetGovernor')
            .withArgs(cometProxy.address, oldCometGovernor, newCometGovernor.address);
        });

        it('new governor is stored in configurator configuration', async () => {
          const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
          expect(configuration.governor).to.be.equal(newCometGovernor.address);
        });

        it('deploy and upgrade from ProxyAdmin is successful', async () => {
          deployTx = await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          await expect(deployTx).to.not.be.reverted;
        });

        it('deploy emits CometDeployed event', async () => {
          const newCometImplementation = await cometProxyAdmin.getProxyImplementation(cometProxy.address);
          await expect(deployTx)
            .to.emit(configuratorProxy, 'CometDeployed')
            .withArgs(cometProxy.address, newCometImplementation);
        });

        it('comet proxy has new governor after upgrade', async () => {
          expect(await comet.governor()).to.be.equal(newCometGovernor.address);
        });
      });

      describe('edge cases', function() {
        let snapshot: SnapshotRestorer;
        before(async () => (snapshot = await takeSnapshot()));

        it('governor can be set to the same address', async () => {
          const currentConfiguration = await configuratorProxy.getConfiguration(cometProxy.address);

          await configuratorProxy.connect(governor).setGovernor(cometProxy.address, currentConfiguration.governor);

          const updatedConfiguration = await configuratorProxy.getConfiguration(cometProxy.address);
          expect(updatedConfiguration.governor).to.be.equal(currentConfiguration.governor);
        });

        it('governor can be set to zero address', async () => {
          await configuratorProxy.connect(governor).setGovernor(cometProxy.address, ZERO_ADDRESS);

          const configuration = await configuratorProxy.getConfiguration(cometProxy.address);

          expect(configuration.governor).to.be.equal(ZERO_ADDRESS);
          await snapshot.restore();
        });
      });
    });

    describe('pauseGuardian setter', function() {
      let setPauseGuardianTx: ContractTransaction;
      let newPauseGuardian: SignerWithAddress;
      let oldPauseGuardian: string;

      describe('revert cases', function() {
        it('reverts by non-governor', async () => {
          newPauseGuardian = (await ethers.getSigners())[6];
          await expect(configuratorProxy.connect(alice).setPauseGuardian(cometProxy.address, newPauseGuardian.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });

      describe('edge cases', function() {
        it('can be set to zero address', async () => {
          await configuratorProxy.connect(governor).setPauseGuardian(cometProxy.address, ZERO_ADDRESS);
          expect((await configuratorProxy.getConfiguration(cometProxy.address)).pauseGuardian).to.be.equal(ZERO_ADDRESS);
        });
      });

      describe('happy path', function() {
        it('sanity check: current and new pause guardian are different', async () => {
          newPauseGuardian = (await ethers.getSigners())[6];
          const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
          oldPauseGuardian = configuration.pauseGuardian;
          expect(oldPauseGuardian).to.not.equal(newPauseGuardian.address);
        });

        it('setPauseGuardian is successful', async () => {
          setPauseGuardianTx = await configuratorProxy.connect(governor).setPauseGuardian(cometProxy.address, newPauseGuardian.address);
          await expect(setPauseGuardianTx).to.not.be.reverted;
        });

        it('emits SetPauseGuardian event', async () => {
          await expect(setPauseGuardianTx)
            .to.emit(configuratorProxy, 'SetPauseGuardian')
            .withArgs(cometProxy.address, oldPauseGuardian, newPauseGuardian.address);
        });

        it('new pauseGuardian is updated in configuration', async () => {
          const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
          expect(configuration.pauseGuardian).to.be.equal(newPauseGuardian.address);
        });

        it('deploy and upgrade comet with new configuration', async () => {
          await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
        });

        it('pauseGuardian is updated in comet', async () => {
          expect(await comet.pauseGuardian()).to.be.equal(newPauseGuardian.address);
        });
      });
    });

    describe('setMarketAdminPermissionChecker', function() {
      let setTx: ContractTransaction;
      let newChecker: MarketAdminPermissionChecker;
      let oldChecker: string;

      before(async () => {
        const Factory = await ethers.getContractFactory('MarketAdminPermissionChecker') as MarketAdminPermissionChecker__factory;
        newChecker = await Factory.deploy(governor.address, ZERO_ADDRESS, ZERO_ADDRESS);
        await newChecker.deployed();
      });

      describe('revert cases', function() {
        it('reverts by non-governor', async () => {
          await expect(configuratorProxy.connect(alice).setMarketAdminPermissionChecker(newChecker.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });

      describe('edge cases', function() {
        it('can be set to zero address', async () => {
          await configuratorProxy.connect(governor).setMarketAdminPermissionChecker(ZERO_ADDRESS);
          expect(await configuratorProxy.marketAdminPermissionChecker()).to.be.equal(ZERO_ADDRESS);
        });
      });

      describe('happy path', function() {
        it('sanity check: current and new checker are different', async () => {
          oldChecker = await configuratorProxy.marketAdminPermissionChecker();
          expect(oldChecker).to.not.equal(newChecker.address);
        });

        it('sets MarketAdminPermissionChecker successfully', async () => {
          setTx = await configuratorProxy.connect(governor).setMarketAdminPermissionChecker(newChecker.address);
          await expect(setTx).to.not.be.reverted;
        });

        it('emits SetMarketAdminPermissionChecker event', async () => {
          await expect(setTx)
            .to.emit(configuratorProxy, 'SetMarketAdminPermissionChecker')
            .withArgs(oldChecker, newChecker.address);
        });

        it('new checker is stored', async () => {
          expect(await configuratorProxy.marketAdminPermissionChecker()).to.be.equal(newChecker.address);
        });
      });
    });

    describe('setBaseTokenPriceFeed', function() {
      let setTx: ContractTransaction;
      let newPriceFeed: SimplePriceFeed;
      let oldPriceFeed: string;

      before(async () => {
        oldPriceFeed = (await configuratorProxy.getConfiguration(cometProxy.address)).baseTokenPriceFeed;
        const PriceFeedFactory = await ethers.getContractFactory('SimplePriceFeed') as SimplePriceFeed__factory;
        newPriceFeed = await PriceFeedFactory.deploy(exp(200, 8), 8);
      });

      describe('revert cases', function() {
        it('reverts by non-governor', async () => {
          await expect(configuratorProxy.connect(alice).setBaseTokenPriceFeed(cometProxy.address, newPriceFeed.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });

      describe('edge cases', function() {
        it('can be set to zero address', async () => {
          const snapshot: SnapshotRestorer = await takeSnapshot();

          await configuratorProxy.connect(governor).setBaseTokenPriceFeed(cometProxy.address, ZERO_ADDRESS);
          expect((await configuratorProxy.getConfiguration(cometProxy.address)).baseTokenPriceFeed).to.be.equal(ZERO_ADDRESS);

          await snapshot.restore();
        });
      });

      describe('happy path', function() {
        it('sets baseTokenPriceFeed successfully', async () => {
          setTx = await configuratorProxy.connect(governor).setBaseTokenPriceFeed(cometProxy.address, newPriceFeed.address);
          await expect(setTx).to.not.be.reverted;
        });

        it('emits SetBaseTokenPriceFeed event', async () => {
          await expect(setTx)
            .to.emit(configuratorProxy, 'SetBaseTokenPriceFeed')
            .withArgs(cometProxy.address, oldPriceFeed, newPriceFeed.address);
        });

        it('new baseTokenPriceFeed is stored in configuration', async () => {
          const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
          expect(configuration.baseTokenPriceFeed).to.be.equal(newPriceFeed.address);
        });

        it('deploy and upgrade comet with new configuration', async () => {
          await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
        });

        it('baseTokenPriceFeed is updated in comet', async () => {
          expect(await comet.baseTokenPriceFeed()).to.be.equal(newPriceFeed.address);
        });
      });
    });

    describe('setExtensionDelegate', function() {
      let setTx: ContractTransaction;
      let newExtensionDelegate: CometExtAssetList;
      let oldExtensionDelegate: string;

      before(async () => {
        oldExtensionDelegate = (await configuratorProxy.getConfiguration(cometProxy.address)).extensionDelegate;

        const name32 = ethers.utils.formatBytes32String('Compound Comet');
        const symbol32 = ethers.utils.formatBytes32String('cBASE');
        const ExtFactory = (await ethers.getContractFactory('CometExtAssetList')) as CometExtAssetList__factory;
        newExtensionDelegate = await ExtFactory.deploy({ name32, symbol32 }, assetListFactoryAddr);
      });

      describe('revert cases', function() {
        it('reverts by non-governor', async () => {
          await expect(configuratorProxy.connect(alice).setExtensionDelegate(cometProxy.address, newExtensionDelegate.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });

      describe('edge cases', function() {
        it('can be set to zero address', async () => {
          const snapshot: SnapshotRestorer = await takeSnapshot();

          await configuratorProxy.connect(governor).setExtensionDelegate(cometProxy.address, ZERO_ADDRESS);
          expect((await configuratorProxy.getConfiguration(cometProxy.address)).extensionDelegate).to.be.equal(ZERO_ADDRESS);

          await snapshot.restore();
        });
      });

      describe('happy path', function() {
        it('sets extensionDelegate successfully', async () => {
          setTx = await configuratorProxy.connect(governor).setExtensionDelegate(cometProxy.address, newExtensionDelegate.address);
          await expect(setTx).to.not.be.reverted;
        });

        it('emits SetExtensionDelegate event', async () => {
          await expect(setTx)
            .to.emit(configuratorProxy, 'SetExtensionDelegate')
            .withArgs(cometProxy.address, oldExtensionDelegate, newExtensionDelegate.address);
        });

        it('new extensionDelegate is stored in configuration', async () => {
          const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
          expect(configuration.extensionDelegate).to.be.equal(newExtensionDelegate.address);
        });

        it('deploy and upgrade comet with new configuration', async () => {
          await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
        });

        it('extensionDelegate is updated in comet', async () => {
          expect(await comet.extensionDelegate()).to.be.equal(newExtensionDelegate.address);
        });
      });
    });

    describe('interest rate setters (governorOrMarketAdmin)', function() {
      const SECONDS_PER_YEAR = 31_536_000n;

      describe('setSupplyKink', function() {
        const NEW_SUPPLY_KINK = exp(0.7, 18);
        let oldSupplyKink: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setSupplyKink(cometProxy.address, exp(0.7, 18)))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setSupplyKink(cometProxy.address, 0);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).supplyKink).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new supply kink are different', async () => {
            oldSupplyKink = (await configuratorProxy.getConfiguration(cometProxy.address)).supplyKink;
            expect(oldSupplyKink).to.not.equal(NEW_SUPPLY_KINK);
          });

          it('sets supplyKink successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setSupplyKink(cometProxy.address, NEW_SUPPLY_KINK);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetSupplyKink event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetSupplyKink')
              .withArgs(cometProxy.address, oldSupplyKink, NEW_SUPPLY_KINK);
          });

          it('new supplyKink is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.supplyKink).to.be.equal(NEW_SUPPLY_KINK);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('supplyKink is updated in comet', async () => {
            expect(await comet.supplyKink()).to.be.equal(NEW_SUPPLY_KINK);
          });
        });
      });

      describe('setSupplyPerYearInterestRateSlopeLow', function() {
        const NEW_SLOPE_LOW = exp(0.06, 18);
        let oldSlopeLow: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setSupplyPerYearInterestRateSlopeLow(cometProxy.address, NEW_SLOPE_LOW))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setSupplyPerYearInterestRateSlopeLow(cometProxy.address, 0);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).supplyPerYearInterestRateSlopeLow).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new supply slope low are different', async () => {
            oldSlopeLow = (await configuratorProxy.getConfiguration(cometProxy.address)).supplyPerYearInterestRateSlopeLow;
            expect(oldSlopeLow).to.not.equal(NEW_SLOPE_LOW);
          });

          it('sets supplyPerYearInterestRateSlopeLow successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setSupplyPerYearInterestRateSlopeLow(cometProxy.address, NEW_SLOPE_LOW);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetSupplyPerYearInterestRateSlopeLow event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetSupplyPerYearInterestRateSlopeLow')
              .withArgs(cometProxy.address, oldSlopeLow, NEW_SLOPE_LOW);
          });

          it('new supplyPerYearInterestRateSlopeLow is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.supplyPerYearInterestRateSlopeLow).to.be.equal(NEW_SLOPE_LOW);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('supplyPerSecondInterestRateSlopeLow is updated in comet', async () => {
            const expectedPerSecond = NEW_SLOPE_LOW / SECONDS_PER_YEAR;
            expect(await comet.supplyPerSecondInterestRateSlopeLow()).to.equal(expectedPerSecond);
          });
        });
      });

      describe('setSupplyPerYearInterestRateSlopeHigh', function() {
        const NEW_SLOPE_HIGH = exp(2.5, 18);
        let oldSlopeHigh: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setSupplyPerYearInterestRateSlopeHigh(cometProxy.address, NEW_SLOPE_HIGH))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setSupplyPerYearInterestRateSlopeHigh(cometProxy.address, 0);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).supplyPerYearInterestRateSlopeHigh).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new supply slope high are different', async () => {
            oldSlopeHigh = (await configuratorProxy.getConfiguration(cometProxy.address)).supplyPerYearInterestRateSlopeHigh;
            expect(oldSlopeHigh).to.not.equal(NEW_SLOPE_HIGH);
          });

          it('sets supplyPerYearInterestRateSlopeHigh successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setSupplyPerYearInterestRateSlopeHigh(cometProxy.address, NEW_SLOPE_HIGH);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetSupplyPerYearInterestRateSlopeHigh event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetSupplyPerYearInterestRateSlopeHigh')
              .withArgs(cometProxy.address, oldSlopeHigh, NEW_SLOPE_HIGH);
          });

          it('new supplyPerYearInterestRateSlopeHigh is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.supplyPerYearInterestRateSlopeHigh).to.be.equal(NEW_SLOPE_HIGH);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('supplyPerSecondInterestRateSlopeHigh is updated in comet', async () => {
            const expectedPerSecond = NEW_SLOPE_HIGH / SECONDS_PER_YEAR;
            expect(await comet.supplyPerSecondInterestRateSlopeHigh()).to.equal(expectedPerSecond);
          });
        });
      });

      describe('setSupplyPerYearInterestRateBase', function() {
        const NEW_BASE = exp(0.01, 18);
        let oldBase: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setSupplyPerYearInterestRateBase(cometProxy.address, NEW_BASE))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setSupplyPerYearInterestRateBase(cometProxy.address, 0);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).supplyPerYearInterestRateBase).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new supply base are different', async () => {
            oldBase = (await configuratorProxy.getConfiguration(cometProxy.address)).supplyPerYearInterestRateBase;
            expect(oldBase).to.not.equal(NEW_BASE);
          });

          it('sets supplyPerYearInterestRateBase successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setSupplyPerYearInterestRateBase(cometProxy.address, NEW_BASE);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetSupplyPerYearInterestRateBase event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetSupplyPerYearInterestRateBase')
              .withArgs(cometProxy.address, oldBase, NEW_BASE);
          });

          it('new supplyPerYearInterestRateBase is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.supplyPerYearInterestRateBase).to.be.equal(NEW_BASE);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('supplyPerSecondInterestRateBase is updated in comet', async () => {
            const expectedPerSecond = NEW_BASE / SECONDS_PER_YEAR;
            expect(await comet.supplyPerSecondInterestRateBase()).to.equal(expectedPerSecond);
          });
        });
      });

      describe('setBorrowKink', function() {
        const NEW_BORROW_KINK = exp(0.75, 18);
        let oldBorrowKink: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBorrowKink(cometProxy.address, NEW_BORROW_KINK))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setBorrowKink(cometProxy.address, 0);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).borrowKink).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new borrow kink are different', async () => {
            oldBorrowKink = (await configuratorProxy.getConfiguration(cometProxy.address)).borrowKink;
            expect(oldBorrowKink).to.not.equal(NEW_BORROW_KINK);
          });

          it('sets borrowKink successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBorrowKink(cometProxy.address, NEW_BORROW_KINK);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetBorrowKink event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBorrowKink')
              .withArgs(cometProxy.address, oldBorrowKink, NEW_BORROW_KINK);
          });

          it('new borrowKink is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.borrowKink).to.be.equal(NEW_BORROW_KINK);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('borrowKink is updated in comet', async () => {
            expect(await comet.borrowKink()).to.be.equal(NEW_BORROW_KINK);
          });
        });
      });

      describe('setBorrowPerYearInterestRateSlopeLow', function() {
        const NEW_SLOPE_LOW = exp(0.12, 18);
        let oldSlopeLow: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBorrowPerYearInterestRateSlopeLow(cometProxy.address, NEW_SLOPE_LOW))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setBorrowPerYearInterestRateSlopeLow(cometProxy.address, 0);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).borrowPerYearInterestRateSlopeLow).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new borrow slope low are different', async () => {
            oldSlopeLow = (await configuratorProxy.getConfiguration(cometProxy.address)).borrowPerYearInterestRateSlopeLow;
            expect(oldSlopeLow).to.not.equal(NEW_SLOPE_LOW);
          });

          it('sets borrowPerYearInterestRateSlopeLow successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBorrowPerYearInterestRateSlopeLow(cometProxy.address, NEW_SLOPE_LOW);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetBorrowPerYearInterestRateSlopeLow event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBorrowPerYearInterestRateSlopeLow')
              .withArgs(cometProxy.address, oldSlopeLow, NEW_SLOPE_LOW);
          });

          it('new borrowPerYearInterestRateSlopeLow is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.borrowPerYearInterestRateSlopeLow).to.be.equal(NEW_SLOPE_LOW);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('borrowPerSecondInterestRateSlopeLow is updated in comet', async () => {
            const expectedPerSecond = NEW_SLOPE_LOW / SECONDS_PER_YEAR;
            expect(await comet.borrowPerSecondInterestRateSlopeLow()).to.equal(expectedPerSecond);
          });
        });
      });

      describe('setBorrowPerYearInterestRateSlopeHigh', function() {
        const NEW_SLOPE_HIGH = exp(3.5, 18);
        let oldSlopeHigh: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBorrowPerYearInterestRateSlopeHigh(cometProxy.address, NEW_SLOPE_HIGH))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setBorrowPerYearInterestRateSlopeHigh(cometProxy.address, 0);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).borrowPerYearInterestRateSlopeHigh).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new borrow slope high are different', async () => {
            oldSlopeHigh = (await configuratorProxy.getConfiguration(cometProxy.address)).borrowPerYearInterestRateSlopeHigh;
            expect(oldSlopeHigh).to.not.equal(NEW_SLOPE_HIGH);
          });

          it('sets borrowPerYearInterestRateSlopeHigh successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBorrowPerYearInterestRateSlopeHigh(cometProxy.address, NEW_SLOPE_HIGH);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetBorrowPerYearInterestRateSlopeHigh event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBorrowPerYearInterestRateSlopeHigh')
              .withArgs(cometProxy.address, oldSlopeHigh, NEW_SLOPE_HIGH);
          });

          it('new borrowPerYearInterestRateSlopeHigh is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.borrowPerYearInterestRateSlopeHigh).to.be.equal(NEW_SLOPE_HIGH);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('borrowPerSecondInterestRateSlopeHigh is updated in comet', async () => {
            const expectedPerSecond = NEW_SLOPE_HIGH / SECONDS_PER_YEAR;
            expect(await comet.borrowPerSecondInterestRateSlopeHigh()).to.equal(expectedPerSecond);
          });
        });
      });

      describe('setBorrowPerYearInterestRateBase', function() {
        const NEW_BASE = exp(0.006, 18);
        let oldBase: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBorrowPerYearInterestRateBase(cometProxy.address, NEW_BASE))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).setBorrowPerYearInterestRateBase(cometProxy.address, 0);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).borrowPerYearInterestRateBase).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new borrow base are different', async () => {
            oldBase = (await configuratorProxy.getConfiguration(cometProxy.address)).borrowPerYearInterestRateBase;
            expect(oldBase).to.not.equal(NEW_BASE);
          });

          it('sets borrowPerYearInterestRateBase successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBorrowPerYearInterestRateBase(cometProxy.address, NEW_BASE);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetBorrowPerYearInterestRateBase event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBorrowPerYearInterestRateBase')
              .withArgs(cometProxy.address, oldBase, NEW_BASE);
          });

          it('new borrowPerYearInterestRateBase is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.borrowPerYearInterestRateBase).to.be.equal(NEW_BASE);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
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
        let oldStoreFrontPriceFactor: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setStoreFrontPriceFactor(cometProxy.address, NEW_STORE_FRONT_PRICE_FACTOR))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot: SnapshotRestorer = await takeSnapshot();

            await configuratorProxy.connect(governor).setStoreFrontPriceFactor(cometProxy.address, 0);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).storeFrontPriceFactor).to.be.equal(0);

            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new store front price factor are different', async () => {
            oldStoreFrontPriceFactor = (await configuratorProxy.getConfiguration(cometProxy.address)).storeFrontPriceFactor;
            expect(oldStoreFrontPriceFactor).to.not.equal(NEW_STORE_FRONT_PRICE_FACTOR);
          });

          it('sets storeFrontPriceFactor successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setStoreFrontPriceFactor(cometProxy.address, NEW_STORE_FRONT_PRICE_FACTOR);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetStoreFrontPriceFactor event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetStoreFrontPriceFactor')
              .withArgs(cometProxy.address, oldStoreFrontPriceFactor, NEW_STORE_FRONT_PRICE_FACTOR);
          });

          it('new storeFrontPriceFactor is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.storeFrontPriceFactor).to.equal(NEW_STORE_FRONT_PRICE_FACTOR);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('storeFrontPriceFactor is updated in comet', async () => {
            expect(await comet.storeFrontPriceFactor()).to.equal(NEW_STORE_FRONT_PRICE_FACTOR);
          });
        });
      });

      describe('setBaseTrackingSupplySpeed', function() {
        const NEW_BASE_TRACKING_SUPPLY_SPEED = exp(2, 15);
        let oldBaseTrackingSupplySpeed: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBaseTrackingSupplySpeed(cometProxy.address, NEW_BASE_TRACKING_SUPPLY_SPEED))
              .to.be.reverted;
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot: SnapshotRestorer = await takeSnapshot();
            await configuratorProxy.connect(governor).setBaseTrackingSupplySpeed(cometProxy.address, 0);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).baseTrackingSupplySpeed).to.be.equal(0);
            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new base tracking supply speed are different', async () => {
            oldBaseTrackingSupplySpeed = (await configuratorProxy.getConfiguration(cometProxy.address)).baseTrackingSupplySpeed;
            expect(oldBaseTrackingSupplySpeed).to.not.equal(NEW_BASE_TRACKING_SUPPLY_SPEED);
          });

          it('sets baseTrackingSupplySpeed successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBaseTrackingSupplySpeed(cometProxy.address, NEW_BASE_TRACKING_SUPPLY_SPEED);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetBaseTrackingSupplySpeed event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBaseTrackingSupplySpeed')
              .withArgs(cometProxy.address, oldBaseTrackingSupplySpeed, NEW_BASE_TRACKING_SUPPLY_SPEED);
          });

          it('new baseTrackingSupplySpeed is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.baseTrackingSupplySpeed).to.equal(NEW_BASE_TRACKING_SUPPLY_SPEED);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('baseTrackingSupplySpeed is updated in comet', async () => {
            expect(await comet.baseTrackingSupplySpeed()).to.equal(NEW_BASE_TRACKING_SUPPLY_SPEED);
          });
        });
      });

      describe('setBaseTrackingBorrowSpeed', function() {
        const NEW_BASE_TRACKING_BORROW_SPEED = exp(2, 15);
        let oldBaseTrackingBorrowSpeed: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBaseTrackingBorrowSpeed(cometProxy.address, NEW_BASE_TRACKING_BORROW_SPEED))
              .to.be.reverted;
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot: SnapshotRestorer = await takeSnapshot();
            await configuratorProxy.connect(governor).setBaseTrackingBorrowSpeed(cometProxy.address, 0);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).baseTrackingBorrowSpeed).to.be.equal(0);
            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new base tracking borrow speed are different', async () => {
            oldBaseTrackingBorrowSpeed = (await configuratorProxy.getConfiguration(cometProxy.address)).baseTrackingBorrowSpeed;
            expect(oldBaseTrackingBorrowSpeed).to.not.equal(NEW_BASE_TRACKING_BORROW_SPEED);
          });

          it('sets baseTrackingBorrowSpeed successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBaseTrackingBorrowSpeed(cometProxy.address, NEW_BASE_TRACKING_BORROW_SPEED);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetBaseTrackingBorrowSpeed event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBaseTrackingBorrowSpeed')
              .withArgs(cometProxy.address, oldBaseTrackingBorrowSpeed, NEW_BASE_TRACKING_BORROW_SPEED);
          });

          it('new baseTrackingBorrowSpeed is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.baseTrackingBorrowSpeed).to.equal(NEW_BASE_TRACKING_BORROW_SPEED);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('baseTrackingBorrowSpeed is updated in comet', async () => {
            expect(await comet.baseTrackingBorrowSpeed()).to.equal(NEW_BASE_TRACKING_BORROW_SPEED);
          });
        });
      });

      describe('setBaseMinForRewards', function() {
        const NEW_BASE_MIN_FOR_REWARDS = exp(2, 6);
        let oldBaseMinForRewards: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBaseMinForRewards(cometProxy.address, NEW_BASE_MIN_FOR_REWARDS))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to same value', async () => {
            const config = await configuratorProxy.getConfiguration(cometProxy.address);
            await configuratorProxy.connect(governor).setBaseMinForRewards(cometProxy.address, config.baseMinForRewards);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).baseMinForRewards).to.equal(config.baseMinForRewards);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new base min for rewards are different', async () => {
            oldBaseMinForRewards = (await configuratorProxy.getConfiguration(cometProxy.address)).baseMinForRewards;
            expect(oldBaseMinForRewards).to.not.equal(NEW_BASE_MIN_FOR_REWARDS);
          });

          it('sets baseMinForRewards successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBaseMinForRewards(cometProxy.address, NEW_BASE_MIN_FOR_REWARDS);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetBaseMinForRewards event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBaseMinForRewards')
              .withArgs(cometProxy.address, oldBaseMinForRewards, NEW_BASE_MIN_FOR_REWARDS);
          });

          it('new baseMinForRewards is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.baseMinForRewards).to.equal(NEW_BASE_MIN_FOR_REWARDS);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('baseMinForRewards is updated in comet', async () => {
            expect(await comet.baseMinForRewards()).to.equal(NEW_BASE_MIN_FOR_REWARDS);
          });
        });
      });

      describe('setBaseBorrowMin', function() {
        const NEW_BASE_BORROW_MIN = exp(2, 6);
        let oldBaseBorrowMin: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setBaseBorrowMin(cometProxy.address, NEW_BASE_BORROW_MIN))
              .to.be.reverted;
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot: SnapshotRestorer = await takeSnapshot();
            await configuratorProxy.connect(governor).setBaseBorrowMin(cometProxy.address, 0);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).baseBorrowMin).to.be.equal(0);
            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new base borrow min are different', async () => {
            oldBaseBorrowMin = (await configuratorProxy.getConfiguration(cometProxy.address)).baseBorrowMin;
            expect(oldBaseBorrowMin).to.not.equal(NEW_BASE_BORROW_MIN);
          });

          it('sets baseBorrowMin successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setBaseBorrowMin(cometProxy.address, NEW_BASE_BORROW_MIN);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetBaseBorrowMin event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetBaseBorrowMin')
              .withArgs(cometProxy.address, oldBaseBorrowMin, NEW_BASE_BORROW_MIN);
          });

          it('new baseBorrowMin is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.baseBorrowMin).to.equal(NEW_BASE_BORROW_MIN);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('baseBorrowMin is updated in comet', async () => {
            expect(await comet.baseBorrowMin()).to.equal(NEW_BASE_BORROW_MIN);
          });
        });
      });

      describe('setTargetReserves', function() {
        const NEW_TARGET_RESERVES = exp(1, 6);
        let oldTargetReserves: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).setTargetReserves(cometProxy.address, NEW_TARGET_RESERVES))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot: SnapshotRestorer = await takeSnapshot();
            await configuratorProxy.connect(governor).setTargetReserves(cometProxy.address, 0);
            expect((await configuratorProxy.getConfiguration(cometProxy.address)).targetReserves).to.be.equal(0);
            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new target reserves are different', async () => {
            oldTargetReserves = (await configuratorProxy.getConfiguration(cometProxy.address)).targetReserves;
            expect(oldTargetReserves).to.not.equal(NEW_TARGET_RESERVES);
          });

          it('sets targetReserves successfully', async () => {
            setTx = await configuratorProxy.connect(governor).setTargetReserves(cometProxy.address, NEW_TARGET_RESERVES);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits SetTargetReserves event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'SetTargetReserves')
              .withArgs(cometProxy.address, oldTargetReserves, NEW_TARGET_RESERVES);
          });

          it('new targetReserves is stored in configuration', async () => {
            const configuration = await configuratorProxy.getConfiguration(cometProxy.address);
            expect(configuration.targetReserves).to.equal(NEW_TARGET_RESERVES);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('targetReserves is updated in comet', async () => {
            expect(await comet.targetReserves()).to.equal(NEW_TARGET_RESERVES);
          });
        });
      });
    });

    describe('asset update setters', function() {
      let firstAsset: { asset: string, priceFeed: string };
      const toFactor = (n: number) => BigNumber.from(exp(n, 18).toString());
      const toSupplyCap = (n: number, d: number) => BigNumber.from(exp(n, d).toString());

      before(async () => {
        const config = await configuratorProxy.getConfiguration(cometProxy.address);
        firstAsset = {
          asset: config.assetConfigs[0].asset,
          priceFeed: config.assetConfigs[0].priceFeed,
        };
      });

      describe('updateAssetPriceFeed', function() {
        it('reverts by non-governor', async () => {
          const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
          const newFeed = await PriceFeedFactory.deploy(exp(500, 8), 8);
          await newFeed.deployed();
          await expect(configuratorProxy.connect(alice).updateAssetPriceFeed(cometProxy.address, firstAsset.asset, newFeed.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
        it('governor updates successfully', async () => {
          const config = await configuratorProxy.getConfiguration(cometProxy.address);
          const oldFeed = config.assetConfigs[0].priceFeed;
          const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
          const newFeed = await PriceFeedFactory.deploy(exp(500, 8), 8);
          await newFeed.deployed();
          const tx = await configuratorProxy.connect(governor).updateAssetPriceFeed(cometProxy.address, firstAsset.asset, newFeed.address);
          await expect(tx).to.emit(configuratorProxy, 'UpdateAssetPriceFeed').withArgs(cometProxy.address, firstAsset.asset, oldFeed, newFeed.address);
          const updated = await configuratorProxy.getConfiguration(cometProxy.address);
          expect(updated.assetConfigs[0].priceFeed).to.equal(newFeed.address);
        });
      });

      describe('updateAssetBorrowCollateralFactor', function() {
        it('reverts by non-governor', async () => {
          await expect(configuratorProxy.connect(alice).updateAssetBorrowCollateralFactor(cometProxy.address, firstAsset.asset, toFactor(0.9)))
            .to.be.reverted;
        });
        it('governor updates successfully', async () => {
          const newVal = toFactor(0.9);
          const tx = await configuratorProxy.connect(governor).updateAssetBorrowCollateralFactor(cometProxy.address, firstAsset.asset, newVal);
          await expect(tx).to.emit(configuratorProxy, 'UpdateAssetBorrowCollateralFactor');
          const updated = await configuratorProxy.getConfiguration(cometProxy.address);
          expect(updated.assetConfigs[0].borrowCollateralFactor).to.equal(newVal);
        });
      });

      describe('updateAssetLiquidateCollateralFactor', function() {
        it('reverts by non-governor', async () => {
          await expect(configuratorProxy.connect(alice).updateAssetLiquidateCollateralFactor(cometProxy.address, firstAsset.asset, toFactor(0.95)))
            .to.be.reverted;
        });
        it('governor updates successfully', async () => {
          const newVal = toFactor(0.95);
          await configuratorProxy.connect(governor).updateAssetLiquidateCollateralFactor(cometProxy.address, firstAsset.asset, newVal);
          const updated = await configuratorProxy.getConfiguration(cometProxy.address);
          expect(updated.assetConfigs[0].liquidateCollateralFactor).to.equal(newVal);
        });
      });

      describe('updateAssetLiquidationFactor', function() {
        it('reverts by non-governor', async () => {
          await expect(configuratorProxy.connect(alice).updateAssetLiquidationFactor(cometProxy.address, firstAsset.asset, toFactor(0.95)))
            .to.be.reverted;
        });
        it('governor updates successfully', async () => {
          const newVal = toFactor(0.95);
          await configuratorProxy.connect(governor).updateAssetLiquidationFactor(cometProxy.address, firstAsset.asset, newVal);
          const updated = await configuratorProxy.getConfiguration(cometProxy.address);
          expect(updated.assetConfigs[0].liquidationFactor).to.equal(newVal);
        });
      });

      describe('updateAssetSupplyCap', function() {
        it('reverts by non-governor', async () => {
          await expect(configuratorProxy.connect(alice).updateAssetSupplyCap(cometProxy.address, firstAsset.asset, toSupplyCap(200, 18)))
            .to.be.reverted;
        });
        it('governor updates successfully', async () => {
          const newVal = toSupplyCap(200, 18);
          const tx = await configuratorProxy.connect(governor).updateAssetSupplyCap(cometProxy.address, firstAsset.asset, newVal);
          await expect(tx).to.emit(configuratorProxy, 'UpdateAssetSupplyCap');
          const updated = await configuratorProxy.getConfiguration(cometProxy.address);
          expect(updated.assetConfigs[0].supplyCap).to.equal(newVal);
        });
      });

      describe('addAsset', function() {
        let newPriceFeedAddr: string;

        before(async () => {
          const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
          const feed = await PriceFeedFactory.deploy(exp(100, 8), 8);
          await feed.deployed();
          newPriceFeedAddr = feed.address;
        });

        it('reverts by non-governor', async () => {
          const assetConfig = {
            asset: unsupportedTokenAddr,
            priceFeed: newPriceFeedAddr,
            decimals: 6,
            borrowCollateralFactor: toFactor(0.8),
            liquidateCollateralFactor: toFactor(0.9),
            liquidationFactor: toFactor(0.95),
            supplyCap: toSupplyCap(100, 6),
          };
          await expect(configuratorProxy.connect(alice).addAsset(cometProxy.address, assetConfig))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });

        it('governor adds asset successfully', async () => {
          const config = await configuratorProxy.getConfiguration(cometProxy.address);
          const numAssetsBefore = config.assetConfigs.length;
          const assetConfig = {
            asset: unsupportedTokenAddr,
            priceFeed: newPriceFeedAddr,
            decimals: 6,
            borrowCollateralFactor: toFactor(0.8),
            liquidateCollateralFactor: toFactor(0.9),
            liquidationFactor: toFactor(0.95),
            supplyCap: toSupplyCap(100, 6),
          };
          const tx = await configuratorProxy.connect(governor).addAsset(cometProxy.address, assetConfig);
          await expect(tx).to.emit(configuratorProxy, 'AddAsset');
          const updated = await configuratorProxy.getConfiguration(cometProxy.address);
          expect(updated.assetConfigs.length).to.equal(numAssetsBefore + 1);
          expect(updated.assetConfigs[updated.assetConfigs.length - 1].asset).to.equal(unsupportedTokenAddr);
        });
      });

      describe('updateAsset', function() {
        it('reverts by non-governor', async () => {
          const config = await configuratorProxy.getConfiguration(cometProxy.address);
          const assetConfig0 = config.assetConfigs[0];
          const newAssetConfig = {
            ...assetConfig0,
            borrowCollateralFactor: toFactor(0.85),
          };
          await expect(configuratorProxy.connect(alice).updateAsset(cometProxy.address, newAssetConfig))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });

        it('governor updates asset successfully', async () => {
          const config = await configuratorProxy.getConfiguration(cometProxy.address);
          const assetConfig0 = config.assetConfigs[0];
          const newBorrowCF = toFactor(0.85);
          const newAssetConfig = {
            ...assetConfig0,
            borrowCollateralFactor: newBorrowCF,
          };
          const tx = await configuratorProxy.connect(governor).updateAsset(cometProxy.address, newAssetConfig);
          await expect(tx).to.emit(configuratorProxy, 'UpdateAsset');
          const updated = await configuratorProxy.getConfiguration(cometProxy.address);
          expect(updated.assetConfigs[0].borrowCollateralFactor).to.equal(newBorrowCF);
        });
      });
    });
  });
});
