import { DEFAULT_MAX_SUPPORTED_UTILIZATION, ethers, exp, expect, makeConfigurator, SnapshotRestorer, takeSnapshot, ZERO_ADDRESS } from './helpers';
import {
  AssetList,
  CometExt,
  CometExt__factory,
  CometFactoryWithExtendedAssetList,
  CometFactoryWithExtendedAssetList__factory,
  CometHarnessInterfaceExtendedAssetList,
  CometProxyAdminOptimism as CometProxyAdmin,
  ConfiguratorOptimism__factory,
  ConfiguratorProxy__factory,
  MarketAdminPermissionChecker,
  MarketAdminPermissionChecker__factory,
  SimplePriceFeed,
  SimplePriceFeed__factory,
  TransparentUpgradeableProxy
} from '../build/types';
import { AssetConfigStruct, ConfigurationStruct, ConfiguratorOptimism as Configurator } from '../build/types/ConfiguratorOptimism';
import { BigNumber, ContractTransaction } from 'ethers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

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

    it('implementation contract cannot be initialized (version == type(uint256).max)', async () => {
      expect(await configurator.version()).to.equal(ethers.constants.MaxUint256);

      await expect(configurator.initialize(governor.address))
        .to.be.revertedWithCustomError(configurator, 'AlreadyInitialized');
    });

    describe('fresh proxy initialization', function() {
      let configuratorImplementation: Configurator;
      let proxyFactory: ConfiguratorProxy__factory;

      before(async () => {
        const ConfiguratorFactory = (await ethers.getContractFactory('ConfiguratorOptimism')) as ConfiguratorOptimism__factory;
        configuratorImplementation = await ConfiguratorFactory.deploy();

        proxyFactory = await ethers.getContractFactory('ConfiguratorProxy') as ConfiguratorProxy__factory;
        const newConfiguratorProxy = await proxyFactory.deploy(configuratorImplementation.address, cometProxyAdmin.address, '0x');
        await newConfiguratorProxy.deployed();
        configuratorImplementation = configuratorImplementation.attach(newConfiguratorProxy.address);
      });

      it('reverts if initialized with zero address governor (InvalidAddress)', async () => {
        const snapshot = await takeSnapshot();

        expect(await configuratorImplementation.version()).to.equal(0);

        await expect(configuratorImplementation.initialize(ZERO_ADDRESS))
          .to.be.revertedWithCustomError(configurator, 'InvalidAddress');

        await snapshot.restore();
      });

      it('fresh proxy can be initialized with a valid governor', async () => {
        await expect(configuratorImplementation.initialize(governor.address)).to.not.be.reverted;

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

  describe('asset list factory setter', function() {
    let setAssetListFactoryTx: ContractTransaction;
    let newAssetListFactory: string;
    let oldAssetListFactory: string;
    before(async () => {
      // Deploy new AssetListFactory, answering to the same Configurator
      const AssetListFactory = await ethers.getContractFactory('AssetListFactory');
      const assetListFactory = await AssetListFactory.deploy(configuratorProxy.address);
      await assetListFactory.deployed();
      newAssetListFactory = assetListFactory.address;
    });

    describe('revert cases', function() {
      it('reverts by non-governor', async () => {
        expect(alice.address).to.not.equal(governor.address);
        await expect(configuratorProxy.connect(alice).setAssetListFactory(cometProxy.address, newAssetListFactory))
          .to.be.revertedWithCustomError(configurator, 'Unauthorized');
      });

      it('reverts if new asset list factory is zero address', async () => {
        await expect(configuratorProxy.connect(governor).setAssetListFactory(cometProxy.address, ZERO_ADDRESS))
          .to.be.revertedWithCustomError(configurator, 'InvalidAddress');
      });

      it('reverts if comet proxy is zero address', async () => {
        await expect(configuratorProxy.connect(governor).setAssetListFactory(ZERO_ADDRESS, newAssetListFactory))
          .to.be.revertedWithCustomError(configurator, 'InvalidAddress');
      });
    });

    describe('happy path', function() {
      it('sanity check: current asset list factory != new asset list factory', async () => {
        oldAssetListFactory = await configuratorProxy.cometAssetListFactories(cometProxy.address);
        expect(oldAssetListFactory).to.not.equal(ZERO_ADDRESS);
        expect(oldAssetListFactory).to.be.not.equal(newAssetListFactory);
      });

      it('sets asset list factory is successful', async () => {
        setAssetListFactoryTx = await configuratorProxy.connect(governor).setAssetListFactory(cometProxy.address, newAssetListFactory);
        await expect(setAssetListFactoryTx).to.not.be.reverted;
      });

      it('setting new asset list factory emits SetAssetListFactory event', async () => {
        await expect(setAssetListFactoryTx).to.emit(configuratorProxy, 'SetAssetListFactory')
          .withArgs(cometProxy.address, oldAssetListFactory, newAssetListFactory);
      });

      it('new asset list factory is set and stored in the configurator', async () => {
        expect(await configuratorProxy.cometAssetListFactories(cometProxy.address)).to.be.equal(newAssetListFactory);
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

      it('reverts if the market is already configured, even with the same configuration', async () => {
        expect(oldConfiguration.assetList).to.not.equal(ZERO_ADDRESS);

        await expect(configuratorProxy.connect(governor).setConfiguration(cometProxy.address, oldConfiguration))
          .to.be.revertedWithCustomError(configurator, 'ConfigurationAlreadyExists');
      });

      it('reverts if the market is already configured, with another asset list', async () => {
        await expect(configuratorProxy.connect(governor).setConfiguration(cometProxy.address, { ...oldConfiguration, assetList: alice.address }))
          .to.be.revertedWithCustomError(configurator, 'ConfigurationAlreadyExists');
      });

      it('reverts if a new market is configured without an asset list', async () => {
        const newMarket = (await ethers.getSigners())[9].address;
        expect((await configuratorProxy.getConfiguration(newMarket)).assetList).to.equal(ZERO_ADDRESS);

        await expect(configuratorProxy.connect(governor).setConfiguration(newMarket, { ...oldConfiguration, assetList: ZERO_ADDRESS }))
          .to.be.revertedWithCustomError(configurator, 'InvalidAddress');
      });
    });

    // The configuration is set once per market, so the happy path configures a new market
    describe('happy path (new market)', function() {
      let newMarket: string;
      let emptyConfiguration: ConfigurationStruct;
      let setConfigurationTx: ContractTransaction;
      before(async () => {
        newMarket = (await ethers.getSigners())[8].address;
        emptyConfiguration = await configuratorProxy.getConfiguration(newMarket);
        // Make new configuration different from old configuration; the asset list is the one set up with the fixture market
        newConfiguration = {
          ...newConfiguration,
          baseBorrowMin: BigNumber.from(newConfiguration.baseBorrowMin).add(1),
          pauseGuardian: alice.address,
          targetReserves: BigNumber.from(newConfiguration.targetReserves).add(1),
        };
      });

      it('sanity check: the new market has no configuration yet', async () => {
        expect(emptyConfiguration.baseToken).to.equal(ZERO_ADDRESS);
        expect(emptyConfiguration.assetList).to.equal(ZERO_ADDRESS);
      });

      it('sets configuration is successful', async () => {
        setConfigurationTx = await configuratorProxy.connect(governor).setConfiguration(newMarket, newConfiguration);
        await expect(setConfigurationTx).to.not.be.reverted;
      });

      it('setting new configuration emits SetConfiguration event (deep equal)', async () => {
        const receipt = await setConfigurationTx.wait();
        const setConfigurationEvent = receipt.events?.find((e) => e.event === 'SetConfiguration');

        expect(setConfigurationEvent).to.not.be.undefined;

        const {
          cometProxy: cometProxyArg,
          oldConfiguration: oldConfigurationArg,
          newConfiguration: newConfigurationArg,
        } = (setConfigurationEvent).args;

        expect(cometProxyArg).to.equal(newMarket);
        // The market had no configuration yet, so the old one is empty
        expect(oldConfigurationArg).to.deep.equal(emptyConfiguration);
        // newConfiguration was spread into a plain object, so re-fetch from storage to get a matching struct Result
        const storedNewConfiguration = await configuratorProxy.getConfiguration(newMarket);
        expect(newConfigurationArg).to.deep.equal(storedNewConfiguration);
      });

      it('new configuration is updated in the configurator in storage', async () => {
        const updatedConfiguration = await configuratorProxy.getConfiguration(newMarket);

        expect(updatedConfiguration.baseBorrowMin).to.be.equal(newConfiguration.baseBorrowMin);
        expect(updatedConfiguration.pauseGuardian).to.be.equal(newConfiguration.pauseGuardian);
        expect(updatedConfiguration.targetReserves).to.be.equal(newConfiguration.targetReserves);
        expect(updatedConfiguration.assetList).to.be.equal(newConfiguration.assetList);
      });

      it('the same call again reverts, as the configuration is set only once', async () => {
        await expect(configuratorProxy.connect(governor).setConfiguration(newMarket, newConfiguration))
          .to.be.revertedWithCustomError(configurator, 'ConfigurationAlreadyExists');
      });
    });

    describe('edge cases', function() {
      it('a configured market is still updated through the field setters', async () => {
        const newMarket = (await ethers.getSigners())[8].address;
        const newBaseBorrowMin = BigNumber.from(newConfiguration.baseBorrowMin).add(1);

        await configuratorProxy.connect(governor).setBaseBorrowMin(newMarket, newBaseBorrowMin);

        expect((await configuratorProxy.getConfiguration(newMarket)).baseBorrowMin).to.be.equal(newBaseBorrowMin);
      });
    });
  });

  describe('comet upgrade', function () {
    // New comet implementation address
    let newCometImplementation: string;
    // Deploy transaction
    let deployTx: ContractTransaction;

    describe('new implementation deployment', function() {
      before(async () => {
        // The configuration is set only once, so the pause guardian is changed through its setter
        await configuratorProxy.connect(governor).setPauseGuardian(cometProxy.address, alice.address);
      });

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
        await configuratorProxy.connect(governor).setPauseGuardian(cometProxy.address, pauseGuardian.address);
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

    describe('deploy edge cases', function() {
      it('reverts when factory is not set (zero address)', async () => {
        const snapshot = await takeSnapshot();

        await configuratorProxy.connect(governor).setFactory(cometProxy.address, ZERO_ADDRESS);

        // Reverts with "Error: Transaction reverted without a reason string"
        await expect(configuratorProxy.deploy(cometProxy.address)).to.be.reverted;

        await snapshot.restore();
      });

      it('reverts when deploying for a proxy with no configuration', async () => {
        const randomAddr = '0x0000000000000000000000000000000000000042';

        // Reverts with "Error: Transaction reverted without a reason string"
        await expect(configuratorProxy.deploy(randomAddr)).to.be.reverted;
      });
    });
  });

  describe('asset list deployment', function() {
    let snapshot: SnapshotRestorer;
    let fixtureConfiguration: ConfigurationStruct;
    before(async () => {
      snapshot = await takeSnapshot();
      fixtureConfiguration = await configuratorProxy.getConfiguration(cometProxy.address);
    });
    after(async () => await snapshot.restore());

    describe('revert cases', function() {
      it('reverts if asset list proxy is zero address', async () => {
        const marketWithoutConfiguration = (await ethers.getSigners())[11].address;
        expect((await configuratorProxy.getConfiguration(marketWithoutConfiguration)).assetList).to.equal(ZERO_ADDRESS);

        await expect(configuratorProxy.deployAssetList(marketWithoutConfiguration))
          .to.be.revertedWithCustomError(configurator, 'AssetListNotSet');
      });

      it('reverts if asset list proxy does not support config hash', async () => {
        // An address with no code stands for a list that can't tell its config hash
        const market = (await ethers.getSigners())[12].address;
        const randomAssetList = ethers.Wallet.createRandom().address;
        await configuratorProxy.connect(governor).setConfiguration(market, { ...fixtureConfiguration, assetList: randomAssetList });

        // The call to an address without code reverts with empty revert data
        await expect(configuratorProxy.deployAssetList(market)).to.be.revertedWithoutReason();
      });

      it('reverts if asset list factory is not set (zero address)', async () => {
        // The market has the fixture's list but no asset configs, so the hashes differ and a new list must be deployed
        const market = (await ethers.getSigners())[13].address;
        await configuratorProxy.connect(governor).setConfiguration(market, fixtureConfiguration);
        expect(await configuratorProxy.cometAssetListFactories(market)).to.equal(ZERO_ADDRESS);

        await expect(configuratorProxy.deployAssetList(market))
          .to.be.revertedWithCustomError(configurator, 'AssetListFactoryNotSet');
      });

      it('reverts if asset list factory does not support createAssetList', async () => {
        // The proxy admin is a contract without createAssetList
        const market = (await ethers.getSigners())[14].address;
        await configuratorProxy.connect(governor).setConfiguration(market, fixtureConfiguration);
        await configuratorProxy.connect(governor).setAssetListFactory(market, cometProxyAdmin.address);

        // The proxy admin has no createAssetList and no fallback, so the call reverts with empty revert data
        await expect(configuratorProxy.deployAssetList(market)).to.be.revertedWithoutReason();
      });
    });

    // The fixture market's asset list was built from its current immutable asset configs
    describe('happy path (immutable configs not changed)', function() {
      let assetListProxy: string;
      let assetListImplementationBefore: string;
      let returnedAssetListProxy: string;
      let returnedAssetListImpl: string;
      let deployAssetListTx: ContractTransaction;

      before(async () => {
        assetListProxy = fixtureConfiguration.assetList;
        assetListImplementationBefore = await cometProxyAdmin.getProxyImplementation(assetListProxy);
      });

      it('sanity check: asset list config hash matches the immutable asset configs', async () => {
        const assetList = await ethers.getContractAt('AssetList', assetListProxy);
        const immutableConfigs = await configuratorProxy.getImmutableAssetConfig(cometProxy.address);
        const encodedImmutableConfigs = ethers.utils.defaultAbiCoder.encode(['tuple(address asset, address priceFeed)[]'], [immutableConfigs]);

        expect(await assetList.configHash()).to.be.equal(
          ethers.utils.keccak256(ethers.utils.hexConcat([await assetList.TYPEHASH(), encodedImmutableConfigs]))
        );
      });

      it('static call of deploy asset list is successful', async () => {
        [returnedAssetListProxy, returnedAssetListImpl] = await configuratorProxy.connect(alice).callStatic.deployAssetList(cometProxy.address);
      });

      it('returns the asset list proxy of the comet', async () => {
        expect(returnedAssetListProxy).to.be.equal(assetListProxy);
      });

      it('returns zero address for the implementation', async () => {
        expect(returnedAssetListImpl).to.be.equal(ZERO_ADDRESS);
      });

      it('anyone can call deploy asset list', async () => {
        expect(alice.address).to.not.equal(governor.address);

        deployAssetListTx = await configuratorProxy.connect(alice).deployAssetList(cometProxy.address);
        await expect(deployAssetListTx).to.not.be.reverted;
      });

      it('does not emit AssetListDeployed event', async () => {
        await expect(deployAssetListTx).to.not.emit(configuratorProxy, 'AssetListDeployed');
      });

      it('does not upgrade the asset list proxy', async () => {
        expect(await cometProxyAdmin.getProxyImplementation(assetListProxy)).to.be.equal(assetListImplementationBefore);
      });

      it('asset list proxy of the comet stays the same in the configurator', async () => {
        expect((await configuratorProxy.getConfiguration(cometProxy.address)).assetList).to.be.equal(assetListProxy);
      });
    });

    describe('happy path (immutable configs changed)', function() {
      let assetListProxy: string;
      let assetListImplementationBefore: string;
      let expectedAssetListProxy: string;
      let expectedNewAssetListImpl: string;
      let deployAssetListTx: ContractTransaction;

      before(async () => {
        assetListProxy = fixtureConfiguration.assetList;
        assetListImplementationBefore = await cometProxyAdmin.getProxyImplementation(assetListProxy);

        // A new price feed changes the immutable asset configs, so the list must be redeployed
        const PriceFeedFactory = await ethers.getContractFactory('SimplePriceFeed') as SimplePriceFeed__factory;
        const newPriceFeed = await PriceFeedFactory.deploy(exp(1, 8), 8);
        await newPriceFeed.deployed();
        const [firstAssetConfig] = await configuratorProxy.getAssetConfigs(cometProxy.address);
        await configuratorProxy.connect(governor).updateAssetPriceFeed(cometProxy.address, firstAssetConfig.asset, newPriceFeed.address);
      });

      it('sanity check: immutable asset configs differ from the deployed asset list', async () => {
        const assetList = await ethers.getContractAt('AssetList', assetListProxy);
        const [firstAssetConfig] = await configuratorProxy.getAssetConfigs(cometProxy.address);
        expect((await assetList.getAssetInfo(0)).priceFeed).to.not.equal(firstAssetConfig.priceFeed);
      });

      it('static call of deploy asset list is successful', async () => {
        [expectedAssetListProxy, expectedNewAssetListImpl] = await configuratorProxy.connect(alice).callStatic.deployAssetList(cometProxy.address);
      });

      it('returns the asset list proxy of the comet', async () => {
        expect(expectedAssetListProxy).to.be.equal(assetListProxy);
      });

      it('returns the new implementation address', async () => {
        expect(expectedNewAssetListImpl).to.not.equal(ZERO_ADDRESS);
      });

      it('anyone can deploy asset list', async () => {
        expect(alice.address).to.not.equal(governor.address);

        deployAssetListTx = await configuratorProxy.connect(alice).deployAssetList(cometProxy.address);
        await expect(deployAssetListTx).to.not.be.reverted;
      });

      it('deploying asset list emits AssetListDeployed event', async () => {
        await expect(deployAssetListTx).to.emit(configuratorProxy, 'AssetListDeployed')
          .withArgs(cometProxy.address, assetListProxy, expectedNewAssetListImpl);
      });

      it('new implementation is built from the current immutable asset configs', async () => {
        const newAssetListImpl = await ethers.getContractAt('AssetList', expectedNewAssetListImpl);
        const [firstAssetConfig] = await configuratorProxy.getAssetConfigs(cometProxy.address);

        expect(await ethers.provider.getCode(expectedNewAssetListImpl)).to.not.equal('0x');
        expect((await newAssetListImpl.getAssetInfo(0)).priceFeed).to.be.equal(firstAssetConfig.priceFeed);
      });

      it('does not upgrade the asset list proxy, only deploys the implementation', async () => {
        expect(await cometProxyAdmin.getProxyImplementation(assetListProxy)).to.be.equal(assetListImplementationBefore);
      });

      it('asset list proxy of the comet stays the same in the configurator', async () => {
        expect((await configuratorProxy.getConfiguration(cometProxy.address)).assetList).to.be.equal(assetListProxy);
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
      let newExtensionDelegate: CometExt;
      let oldExtensionDelegate: string;

      before(async () => {
        oldExtensionDelegate = (await configuratorProxy.getConfiguration(cometProxy.address)).extensionDelegate;

        const name32 = ethers.utils.formatBytes32String('Compound Comet');
        const symbol32 = ethers.utils.formatBytes32String('cBASE');
        const ExtFactory = (await ethers.getContractFactory('CometExt')) as CometExt__factory;
        newExtensionDelegate = await ExtFactory.deploy({ name32, symbol32 });
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

    describe('setMaxSupportedUtilization', function() {
      const OLD_MAX_SUPPORTED_UTILIZATION = DEFAULT_MAX_SUPPORTED_UTILIZATION;
      const NEW_MAX_SUPPORTED_UTILIZATION = exp(3, 18);
      let snapshot: SnapshotRestorer;

      before(async () => {
        snapshot = await takeSnapshot();
      });

      after(async () => await snapshot.restore());

      describe('revert cases', function() {
        it('reverts by non-governor and non-market admin', async () => {
          await expect(configuratorProxy.connect(alice).setMaxSupportedUtilization(cometProxy.address, NEW_MAX_SUPPORTED_UTILIZATION))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });
      });

      describe('happy path by governor', function() {
        let setTx: ContractTransaction;

        before(async () => {
          setTx = await configuratorProxy.connect(governor).setMaxSupportedUtilization(cometProxy.address, NEW_MAX_SUPPORTED_UTILIZATION);
        });

        it('emits SetMaxSupportedUtilization event', async () => {
          await expect(setTx)
            .to.emit(configuratorProxy, 'SetMaxSupportedUtilization')
            .withArgs(cometProxy.address, OLD_MAX_SUPPORTED_UTILIZATION, NEW_MAX_SUPPORTED_UTILIZATION);
        });

        it('new maxSupportedUtilization is stored in configuration', async () => {
          expect((await configuratorProxy.getConfiguration(cometProxy.address)).maxSupportedUtilization).to.equal(NEW_MAX_SUPPORTED_UTILIZATION);
        });

        it('deploy and upgrade comet with new configuration', async () => {
          await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
        });

        it('maxSupportedUtilization is updated in comet', async () => {
          expect(await comet.maxSupportedUtilization()).to.equal(NEW_MAX_SUPPORTED_UTILIZATION);
        });
      });
    });

    describe('asset update setters', function() {
      let firstAsset: { asset: string, priceFeed: string };

      before(async () => {
        const assetConfigs = await configuratorProxy.getAssetConfigs(cometProxy.address);
        firstAsset = {
          asset: assetConfigs[0].asset,
          priceFeed: assetConfigs[0].priceFeed,
        };
      });

      describe('updateAssetPriceFeed', function() {
        let newPriceFeed: SimplePriceFeed;
        let oldPriceFeed: string;
        let setTx: ContractTransaction;

        before(async () => {
          const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
          newPriceFeed = await PriceFeedFactory.deploy(exp(500, 8), 8);
          await newPriceFeed.deployed();
        });

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).updateAssetPriceFeed(cometProxy.address, firstAsset.asset, newPriceFeed.address))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });

          it('reverts if new price feed is zero address', async () => {
            await expect(configuratorProxy.connect(governor).updateAssetPriceFeed(cometProxy.address, firstAsset.asset, ZERO_ADDRESS))
              .to.be.revertedWithCustomError(configurator, 'InvalidAddress');
          });

          // An address the market has no asset config for, such as a user's
          it('reverts if the asset does not exist', async () => {
            await expect(configuratorProxy.connect(governor).updateAssetPriceFeed(cometProxy.address, alice.address, newPriceFeed.address))
              .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new price feed are different', async () => {
            oldPriceFeed = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0].priceFeed;
            expect(oldPriceFeed).to.not.equal(newPriceFeed.address);
          });

          it('updates asset price feed successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetPriceFeed(cometProxy.address, firstAsset.asset, newPriceFeed.address);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits UpdateAssetPriceFeed event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetPriceFeed')
              .withArgs(cometProxy.address, firstAsset.asset, oldPriceFeed, newPriceFeed.address);
          });

          it('new priceFeed is stored in configuration', async () => {
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[0].priceFeed).to.be.equal(newPriceFeed.address);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('priceFeed is updated in comet', async () => {
            const assetInfo = await comet.getAssetInfoByAddress(firstAsset.asset);
            expect(assetInfo.priceFeed).to.be.equal(newPriceFeed.address);
          });
        });
      });

      describe('updateAssetBorrowCollateralFactor', function() {
        const NEW_BORROW_CF = exp(0.78, 18);
        let oldBorrowCF: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).updateAssetBorrowCollateralFactor(cometProxy.address, firstAsset.asset, NEW_BORROW_CF))
              .to.be.reverted;
          });

          // An address the market has no asset config for, such as a user's
          it('reverts if the asset does not exist', async () => {
            await expect(configuratorProxy.connect(governor).updateAssetBorrowCollateralFactor(cometProxy.address, alice.address, NEW_BORROW_CF))
              .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            const snapshot = await takeSnapshot();

            await configuratorProxy.connect(governor).updateAssetBorrowCollateralFactor(cometProxy.address, firstAsset.asset, 0);
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[0].borrowCollateralFactor).to.be.equal(0);

            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new borrow collateral factor are different', async () => {
            oldBorrowCF = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0].borrowCollateralFactor;
            expect(oldBorrowCF).to.not.equal(NEW_BORROW_CF);
          });

          it('updates asset borrow collateral factor successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetBorrowCollateralFactor(cometProxy.address, firstAsset.asset, NEW_BORROW_CF);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits UpdateAssetBorrowCollateralFactor event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetBorrowCollateralFactor')
              .withArgs(cometProxy.address, firstAsset.asset, oldBorrowCF, NEW_BORROW_CF);
          });

          it('new borrowCollateralFactor is stored in configuration', async () => {
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[0].borrowCollateralFactor).to.be.equal(NEW_BORROW_CF);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('borrowCollateralFactor is updated in comet', async () => {
            const assetInfo = await comet.getAssetInfoByAddress(firstAsset.asset);
            expect(assetInfo.borrowCollateralFactor).to.be.equal(NEW_BORROW_CF);
          });
        });

        // addAsset only stores the config in the Configurator, the asset reaches the asset list with the next list
        // upgrade. Until then the Configurator updates only its own stored config and doesn't call the list
        describe('happy path (asset added but not in the asset list yet)', function() {
          let newAsset: AssetConfigStruct;
          let newAssetIndex: number;
          let assetList: AssetList;
          let setTx: ContractTransaction;
          let snapshot: SnapshotRestorer;

          before(async () => {
            snapshot = await takeSnapshot();
            const token = await (await ethers.getContractFactory('FaucetToken')).deploy(0, 'New Asset', 18, 'NEW');
            const priceFeed = await (await ethers.getContractFactory('SimplePriceFeed')).deploy(exp(1, 8), 8);
            newAsset = {
              asset: token.address,
              priceFeed: priceFeed.address,
              borrowCollateralFactor: exp(0.75, 18),
              liquidateCollateralFactor: exp(0.8, 18),
              liquidationFactor: exp(0.9, 18),
              supplyCap: exp(1000, 18),
            };
            await configuratorProxy.connect(governor).addAsset(cometProxy.address, newAsset);
            newAssetIndex = (await configuratorProxy.getAssetConfigs(cometProxy.address)).length - 1;
            assetList = (await ethers.getContractAt('AssetList', (await configuratorProxy.getConfiguration(cometProxy.address)).assetList)) as AssetList;
          });

          after(() => snapshot.restore());

          it('sanity check: the asset list does not have the asset', async () => {
            await expect(assetList.getAssetInfoByAddress(newAsset.asset)).to.be.revertedWithCustomError(assetList, 'AssetNotFound');
          });

          it('updates asset borrow collateral factor successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetBorrowCollateralFactor(cometProxy.address, newAsset.asset, NEW_BORROW_CF);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits UpdateAssetBorrowCollateralFactor event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetBorrowCollateralFactor')
              .withArgs(cometProxy.address, newAsset.asset, newAsset.borrowCollateralFactor, NEW_BORROW_CF);
          });

          it('new borrowCollateralFactor is stored in configuration', async () => {
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[newAssetIndex].borrowCollateralFactor).to.be.equal(NEW_BORROW_CF);
          });

          it('the asset list still does not have the asset', async () => {
            await expect(assetList.getAssetInfoByAddress(newAsset.asset)).to.be.revertedWithCustomError(assetList, 'AssetNotFound');
          });
        });
      });

      describe('updateAssetLiquidateCollateralFactor', function() {
        const NEW_LIQUIDATE_CF = exp(0.85, 18);
        let oldLiquidateCF: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).updateAssetLiquidateCollateralFactor(cometProxy.address, firstAsset.asset, NEW_LIQUIDATE_CF))
              .to.be.reverted;
          });

          // An address the market has no asset config for, such as a user's
          it('reverts if the asset does not exist', async () => {
            await expect(configuratorProxy.connect(governor).updateAssetLiquidateCollateralFactor(cometProxy.address, alice.address, NEW_LIQUIDATE_CF))
              .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero once the borrow collateral factor is zero', async () => {
            const snapshot = await takeSnapshot();

            await configuratorProxy.connect(governor).updateAssetBorrowCollateralFactor(cometProxy.address, firstAsset.asset, 0);
            await configuratorProxy.connect(governor).updateAssetLiquidateCollateralFactor(cometProxy.address, firstAsset.asset, 0);
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[0].liquidateCollateralFactor).to.be.equal(0);

            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new liquidate collateral factor are different', async () => {
            oldLiquidateCF = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0].liquidateCollateralFactor;
            expect(oldLiquidateCF).to.not.equal(NEW_LIQUIDATE_CF);
          });

          it('updates asset liquidate collateral factor successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetLiquidateCollateralFactor(cometProxy.address, firstAsset.asset, NEW_LIQUIDATE_CF);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits UpdateAssetLiquidateCollateralFactor event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetLiquidateCollateralFactor')
              .withArgs(cometProxy.address, firstAsset.asset, oldLiquidateCF, NEW_LIQUIDATE_CF);
          });

          it('new liquidateCollateralFactor is stored in configuration', async () => {
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[0].liquidateCollateralFactor).to.be.equal(NEW_LIQUIDATE_CF);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('liquidateCollateralFactor is updated in comet', async () => {
            const assetInfo = await comet.getAssetInfoByAddress(firstAsset.asset);
            expect(assetInfo.liquidateCollateralFactor).to.be.equal(NEW_LIQUIDATE_CF);
          });
        });

        // addAsset only stores the config in the Configurator, the asset reaches the asset list with the next list
        // upgrade. Until then the Configurator updates only its own stored config and doesn't call the list
        describe('happy path (asset added but not in the asset list yet)', function() {
          let newAsset: AssetConfigStruct;
          let newAssetIndex: number;
          let assetList: AssetList;
          let setTx: ContractTransaction;
          let snapshot: SnapshotRestorer;

          before(async () => {
            snapshot = await takeSnapshot();
            const token = await (await ethers.getContractFactory('FaucetToken')).deploy(0, 'New Asset', 18, 'NEW');
            const priceFeed = await (await ethers.getContractFactory('SimplePriceFeed')).deploy(exp(1, 8), 8);
            newAsset = {
              asset: token.address,
              priceFeed: priceFeed.address,
              borrowCollateralFactor: exp(0.75, 18),
              liquidateCollateralFactor: exp(0.8, 18),
              liquidationFactor: exp(0.9, 18),
              supplyCap: exp(1000, 18),
            };
            await configuratorProxy.connect(governor).addAsset(cometProxy.address, newAsset);
            newAssetIndex = (await configuratorProxy.getAssetConfigs(cometProxy.address)).length - 1;
            assetList = (await ethers.getContractAt('AssetList', (await configuratorProxy.getConfiguration(cometProxy.address)).assetList)) as AssetList;
          });

          after(() => snapshot.restore());

          it('sanity check: the asset list does not have the asset', async () => {
            await expect(assetList.getAssetInfoByAddress(newAsset.asset)).to.be.revertedWithCustomError(assetList, 'AssetNotFound');
          });

          it('updates asset liquidate collateral factor successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetLiquidateCollateralFactor(cometProxy.address, newAsset.asset, NEW_LIQUIDATE_CF);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits UpdateAssetLiquidateCollateralFactor event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetLiquidateCollateralFactor')
              .withArgs(cometProxy.address, newAsset.asset, newAsset.liquidateCollateralFactor, NEW_LIQUIDATE_CF);
          });

          it('new liquidateCollateralFactor is stored in configuration', async () => {
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[newAssetIndex].liquidateCollateralFactor).to.be.equal(NEW_LIQUIDATE_CF);
          });

          it('the asset list still does not have the asset', async () => {
            await expect(assetList.getAssetInfoByAddress(newAsset.asset)).to.be.revertedWithCustomError(assetList, 'AssetNotFound');
          });
        });
      });

      describe('updateAssetLiquidationFactor', function() {
        const NEW_LIQUIDATION_FACTOR = exp(0.95, 18);
        let oldLiquidationFactor: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).updateAssetLiquidationFactor(cometProxy.address, firstAsset.asset, NEW_LIQUIDATION_FACTOR))
              .to.be.reverted;
          });

          // An address the market has no asset config for, such as a user's
          it('reverts if the asset does not exist', async () => {
            await expect(configuratorProxy.connect(governor).updateAssetLiquidationFactor(cometProxy.address, alice.address, NEW_LIQUIDATION_FACTOR))
              .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero once the collateral factors are zero', async () => {
            const snapshot = await takeSnapshot();
            await configuratorProxy.connect(governor).updateAssetBorrowCollateralFactor(cometProxy.address, firstAsset.asset, 0);
            await configuratorProxy.connect(governor).updateAssetLiquidateCollateralFactor(cometProxy.address, firstAsset.asset, 0);
            await configuratorProxy.connect(governor).updateAssetLiquidationFactor(cometProxy.address, firstAsset.asset, 0);
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[0].liquidationFactor).to.be.equal(0);
            await snapshot.restore();
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new liquidation factor are different', async () => {
            oldLiquidationFactor = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0].liquidationFactor;
            expect(oldLiquidationFactor).to.not.equal(NEW_LIQUIDATION_FACTOR);
          });

          it('updates asset liquidation factor successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetLiquidationFactor(cometProxy.address, firstAsset.asset, NEW_LIQUIDATION_FACTOR);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits UpdateAssetLiquidationFactor event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetLiquidationFactor')
              .withArgs(cometProxy.address, firstAsset.asset, oldLiquidationFactor, NEW_LIQUIDATION_FACTOR);
          });

          it('new liquidationFactor is stored in configuration', async () => {
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[0].liquidationFactor).to.be.equal(NEW_LIQUIDATION_FACTOR);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('liquidationFactor is updated in comet', async () => {
            const assetInfo = await comet.getAssetInfoByAddress(firstAsset.asset);
            expect(assetInfo.liquidationFactor).to.be.equal(NEW_LIQUIDATION_FACTOR);
          });
        });

        // addAsset only stores the config in the Configurator, the asset reaches the asset list with the next list
        // upgrade. Until then the Configurator updates only its own stored config and doesn't call the list
        describe('happy path (asset added but not in the asset list yet)', function() {
          let newAsset: AssetConfigStruct;
          let newAssetIndex: number;
          let assetList: AssetList;
          let setTx: ContractTransaction;
          let snapshot: SnapshotRestorer;

          before(async () => {
            snapshot = await takeSnapshot();
            const token = await (await ethers.getContractFactory('FaucetToken')).deploy(0, 'New Asset', 18, 'NEW');
            const priceFeed = await (await ethers.getContractFactory('SimplePriceFeed')).deploy(exp(1, 8), 8);
            newAsset = {
              asset: token.address,
              priceFeed: priceFeed.address,
              borrowCollateralFactor: exp(0.75, 18),
              liquidateCollateralFactor: exp(0.8, 18),
              liquidationFactor: exp(0.9, 18),
              supplyCap: exp(1000, 18),
            };
            await configuratorProxy.connect(governor).addAsset(cometProxy.address, newAsset);
            newAssetIndex = (await configuratorProxy.getAssetConfigs(cometProxy.address)).length - 1;
            assetList = (await ethers.getContractAt('AssetList', (await configuratorProxy.getConfiguration(cometProxy.address)).assetList)) as AssetList;
          });

          after(() => snapshot.restore());

          it('sanity check: the asset list does not have the asset', async () => {
            await expect(assetList.getAssetInfoByAddress(newAsset.asset)).to.be.revertedWithCustomError(assetList, 'AssetNotFound');
          });

          it('updates asset liquidation factor successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetLiquidationFactor(cometProxy.address, newAsset.asset, NEW_LIQUIDATION_FACTOR);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits UpdateAssetLiquidationFactor event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetLiquidationFactor')
              .withArgs(cometProxy.address, newAsset.asset, newAsset.liquidationFactor, NEW_LIQUIDATION_FACTOR);
          });

          it('new liquidationFactor is stored in configuration', async () => {
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[newAssetIndex].liquidationFactor).to.be.equal(NEW_LIQUIDATION_FACTOR);
          });

          it('the asset list still does not have the asset', async () => {
            await expect(assetList.getAssetInfoByAddress(newAsset.asset)).to.be.revertedWithCustomError(assetList, 'AssetNotFound');
          });
        });
      });

      describe('updateAssetSupplyCap', function() {
        const NEW_SUPPLY_CAP = exp(200, 18);
        let oldSupplyCap: BigNumber;
        let setTx: ContractTransaction;

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).updateAssetSupplyCap(cometProxy.address, firstAsset.asset, NEW_SUPPLY_CAP))
              .to.be.reverted;
          });

          // An address the market has no asset config for, such as a user's
          it('reverts if the asset does not exist', async () => {
            await expect(configuratorProxy.connect(governor).updateAssetSupplyCap(cometProxy.address, alice.address, NEW_SUPPLY_CAP))
              .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
          });
        });

        describe('edge cases', function() {
          it('can be set to zero', async () => {
            await configuratorProxy.connect(governor).updateAssetSupplyCap(cometProxy.address, firstAsset.asset, 0);
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[0].supplyCap).to.be.equal(0);
          });
        });

        describe('happy path', function() {
          it('sanity check: current and new supply cap are different', async () => {
            oldSupplyCap = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0].supplyCap;
            expect(oldSupplyCap).to.not.equal(NEW_SUPPLY_CAP);
          });

          it('updates asset supply cap successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetSupplyCap(cometProxy.address, firstAsset.asset, NEW_SUPPLY_CAP);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits UpdateAssetSupplyCap event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetSupplyCap')
              .withArgs(cometProxy.address, firstAsset.asset, oldSupplyCap, NEW_SUPPLY_CAP);
          });

          it('new supplyCap is stored in configuration', async () => {
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[0].supplyCap).to.be.equal(NEW_SUPPLY_CAP);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('supplyCap is updated in comet', async () => {
            const assetInfo = await comet.getAssetInfoByAddress(firstAsset.asset);
            expect(assetInfo.supplyCap).to.be.equal(NEW_SUPPLY_CAP);
          });
        });

        // addAsset only stores the config in the Configurator, the asset reaches the asset list with the next list
        // upgrade. Until then the Configurator updates only its own stored config and doesn't call the list
        describe('happy path (asset added but not in the asset list yet)', function() {
          let newAsset: AssetConfigStruct;
          let newAssetIndex: number;
          let assetList: AssetList;
          let setTx: ContractTransaction;
          let snapshot: SnapshotRestorer;

          before(async () => {
            snapshot = await takeSnapshot();
            const token = await (await ethers.getContractFactory('FaucetToken')).deploy(0, 'New Asset', 18, 'NEW');
            const priceFeed = await (await ethers.getContractFactory('SimplePriceFeed')).deploy(exp(1, 8), 8);
            newAsset = {
              asset: token.address,
              priceFeed: priceFeed.address,
              borrowCollateralFactor: exp(0.75, 18),
              liquidateCollateralFactor: exp(0.8, 18),
              liquidationFactor: exp(0.9, 18),
              supplyCap: exp(1000, 18),
            };
            await configuratorProxy.connect(governor).addAsset(cometProxy.address, newAsset);
            newAssetIndex = (await configuratorProxy.getAssetConfigs(cometProxy.address)).length - 1;
            assetList = (await ethers.getContractAt('AssetList', (await configuratorProxy.getConfiguration(cometProxy.address)).assetList)) as AssetList;
          });

          after(() => snapshot.restore());

          it('sanity check: the asset list does not have the asset', async () => {
            await expect(assetList.getAssetInfoByAddress(newAsset.asset)).to.be.revertedWithCustomError(assetList, 'AssetNotFound');
          });

          it('updates asset supply cap successfully', async () => {
            setTx = await configuratorProxy.connect(governor).updateAssetSupplyCap(cometProxy.address, newAsset.asset, NEW_SUPPLY_CAP);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits UpdateAssetSupplyCap event', async () => {
            await expect(setTx)
              .to.emit(configuratorProxy, 'UpdateAssetSupplyCap')
              .withArgs(cometProxy.address, newAsset.asset, newAsset.supplyCap, NEW_SUPPLY_CAP);
          });

          it('new supplyCap is stored in configuration', async () => {
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[newAssetIndex].supplyCap).to.be.equal(NEW_SUPPLY_CAP);
          });

          it('the asset list still does not have the asset', async () => {
            await expect(assetList.getAssetInfoByAddress(newAsset.asset)).to.be.revertedWithCustomError(assetList, 'AssetNotFound');
          });
        });
      });

      describe('addAsset', function() {
        let newPriceFeedAddr: string;
        let newAssetConfig: { asset: string, priceFeed: string, borrowCollateralFactor: bigint, liquidateCollateralFactor: bigint, liquidationFactor: bigint, supplyCap: bigint };
        let setTx: ContractTransaction;

        before(async () => {
          const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
          const feed = await PriceFeedFactory.deploy(exp(100, 8), 8);
          await feed.deployed();
          newPriceFeedAddr = feed.address;
          newAssetConfig = {
            asset: unsupportedTokenAddr,
            priceFeed: newPriceFeedAddr,
            borrowCollateralFactor: exp(0.8, 18),
            liquidateCollateralFactor: exp(0.9, 18),
            liquidationFactor: exp(0.95, 18),
            supplyCap: exp(100, 6),
          };
        });

        describe('revert cases', function() {
          it('reverts by non-governor', async () => {
            await expect(configuratorProxy.connect(alice).addAsset(cometProxy.address, newAssetConfig))
              .to.be.revertedWithCustomError(configurator, 'Unauthorized');
          });

          it('reverts if asset already exists', async () => {
            // Take the last stored asset config and add it again, unchanged
            const assetConfigs = await configuratorProxy.getAssetConfigs(cometProxy.address);
            const lastAssetConfig = assetConfigs[assetConfigs.length - 1];

            await expect(configuratorProxy.connect(governor).addAsset(cometProxy.address, lastAssetConfig))
              .to.be.revertedWithCustomError(configurator, 'AssetAlreadyExists');
          });
        });

        describe('happy path', function() {
          it('sanity check: asset does not exist in comet yet', async () => {
            await expect(comet.getAssetInfoByAddress(unsupportedTokenAddr)).to.be.reverted;
          });

          it('adds asset successfully', async () => {
            setTx = await configuratorProxy.connect(governor).addAsset(cometProxy.address, newAssetConfig);
            await expect(setTx).to.not.be.reverted;
          });

          it('emits AddAsset event', async () => {
            await expect(setTx).to.emit(configuratorProxy, 'AddAsset');
          });

          it('new asset is stored in configuration', async () => {
            expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[(await configuratorProxy.getAssetConfigs(cometProxy.address)).length - 1].asset).to.equal(unsupportedTokenAddr);
          });

          it('deploy and upgrade comet with new configuration', async () => {
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxy.address);
          });

          it('the upgrade adds the asset to the asset list, with the factors and cap of its stored config', async () => {
            const assetList = await ethers.getContractAt('AssetList', (await configuratorProxy.getConfiguration(cometProxy.address)).assetList);
            const assetInfo = await assetList.getAssetInfoByAddress(unsupportedTokenAddr);
            expect(assetInfo.borrowCollateralFactor).to.equal(newAssetConfig.borrowCollateralFactor);
            expect(assetInfo.liquidateCollateralFactor).to.equal(newAssetConfig.liquidateCollateralFactor);
            expect(assetInfo.liquidationFactor).to.equal(newAssetConfig.liquidationFactor);
            expect(assetInfo.supplyCap).to.equal(newAssetConfig.supplyCap);
          });

          it('new asset is available in comet', async () => {
            const assetInfo = await comet.getAssetInfoByAddress(unsupportedTokenAddr);
            expect(assetInfo.asset).to.equal(unsupportedTokenAddr);
          });
        });
      });

      describe('getAssetIndex', function() {
        it('returns correct index for existing asset', async () => {
          const firstAssetAddr = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0].asset;
          const index = await configuratorProxy.getAssetIndex(cometProxy.address, firstAssetAddr);
          expect(index).to.equal(0);
        });

        it('reverts with AssetDoesNotExist for non-existent asset', async () => {
          await expect(configuratorProxy.getAssetIndex(cometProxy.address, ZERO_ADDRESS))
            .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
        });

        it('reverts with AssetDoesNotExist for random address', async () => {
          await expect(configuratorProxy.getAssetIndex(cometProxy.address, alice.address))
            .to.be.revertedWithCustomError(configurator, 'AssetDoesNotExist');
        });
      });

      describe('addAsset revert cases', function() {
        it('reverts if the asset is already in the asset configs', async () => {
          const existingAsset = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0];

          await expect(configuratorProxy.connect(governor).addAsset(cometProxy.address, existingAsset))
            .to.be.revertedWithCustomError(configurator, 'AssetAlreadyExists');
        });

        it('reverts if the asset is zero address', async () => {
          const existingAsset = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0];

          await expect(configuratorProxy.connect(governor).addAsset(cometProxy.address, { ...existingAsset, asset: ZERO_ADDRESS }))
            .to.be.revertedWithCustomError(configurator, 'InvalidAddress');
        });
      });
    });

    describe('transferGovernor', function() {
      let transferTx: ContractTransaction;
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

          await configuratorProxy.connect(governor).transferGovernor(ZERO_ADDRESS);
          expect(await configuratorProxy.governor()).to.equal(ZERO_ADDRESS);

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
          await expect(transferTx).to.not.be.reverted;
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
          await expect(configuratorProxy.connect(newGovernor).setGovernor(cometProxy.address, newGovernor.address))
            .to.not.be.reverted;
        });

        it('old governor can no longer call governor-only functions', async () => {
          await expect(configuratorProxy.connect(governor).setGovernor(cometProxy.address, governor.address))
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

        const Factory = (await ethers.getContractFactory('MarketAdminPermissionChecker')) as MarketAdminPermissionChecker__factory;
        permissionChecker = await Factory.deploy(governor.address, marketAdmin.address, ZERO_ADDRESS);
        await permissionChecker.deployed();

        await configuratorProxy.connect(governor).setMarketAdminPermissionChecker(permissionChecker.address);
      });

      after(async () => await snapshot.restore());

      describe('market admin can call governorOrMarketAdmin functions', function() {
        it('market admin can call setSupplyKink', async () => {
          const innerSnapshot = await takeSnapshot();
          const newKink = exp(0.85, 18);
          await expect(configuratorProxy.connect(marketAdmin).setSupplyKink(cometProxy.address, newKink))
            .to.not.be.reverted;
          expect((await configuratorProxy.getConfiguration(cometProxy.address)).supplyKink).to.equal(newKink);
          await innerSnapshot.restore();
        });

        it('market admin can call setBorrowKink', async () => {
          const innerSnapshot = await takeSnapshot();
          const newKink = exp(0.65, 18);
          await expect(configuratorProxy.connect(marketAdmin).setBorrowKink(cometProxy.address, newKink))
            .to.not.be.reverted;
          expect((await configuratorProxy.getConfiguration(cometProxy.address)).borrowKink).to.equal(newKink);
          await innerSnapshot.restore();
        });

        it('market admin can call setSupplyPerYearInterestRateSlopeLow', async () => {
          const innerSnapshot = await takeSnapshot();
          const newVal = exp(0.05, 18);
          await expect(configuratorProxy.connect(marketAdmin).setSupplyPerYearInterestRateSlopeLow(cometProxy.address, newVal))
            .to.not.be.reverted;
          expect((await configuratorProxy.getConfiguration(cometProxy.address)).supplyPerYearInterestRateSlopeLow).to.equal(newVal);
          await innerSnapshot.restore();
        });

        it('market admin can call updateAssetBorrowCollateralFactor', async () => {
          const innerSnapshot = await takeSnapshot();
          const assetAddr = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0].asset;
          const newVal = exp(0.8, 18);
          await expect(configuratorProxy.connect(marketAdmin).updateAssetBorrowCollateralFactor(cometProxy.address, assetAddr, newVal))
            .to.not.be.reverted;
          expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[0].borrowCollateralFactor).to.equal(newVal);
          await innerSnapshot.restore();
        });

        it('market admin can call updateAssetLiquidateCollateralFactor', async () => {
          const innerSnapshot = await takeSnapshot();
          const assetAddr = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0].asset;
          const newVal = exp(0.92, 18);
          await expect(configuratorProxy.connect(marketAdmin).updateAssetLiquidateCollateralFactor(cometProxy.address, assetAddr, newVal))
            .to.not.be.reverted;
          expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[0].liquidateCollateralFactor).to.equal(newVal);
          await innerSnapshot.restore();
        });

        it('market admin can call updateAssetLiquidationFactor', async () => {
          const innerSnapshot = await takeSnapshot();
          const assetAddr = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0].asset;
          const newVal = exp(0.93, 18);
          await expect(configuratorProxy.connect(marketAdmin).updateAssetLiquidationFactor(cometProxy.address, assetAddr, newVal))
            .to.not.be.reverted;
          expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[0].liquidationFactor).to.equal(newVal);
          await innerSnapshot.restore();
        });

        it('market admin can call updateAssetSupplyCap', async () => {
          const innerSnapshot = await takeSnapshot();
          const assetAddr = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0].asset;
          const newVal = exp(500, 18);
          await expect(configuratorProxy.connect(marketAdmin).updateAssetSupplyCap(cometProxy.address, assetAddr, newVal))
            .to.not.be.reverted;
          expect((await configuratorProxy.getAssetConfigs(cometProxy.address))[0].supplyCap).to.equal(newVal);
          await innerSnapshot.restore();
        });

        it('market admin can call setBaseBorrowMin', async () => {
          const innerSnapshot = await takeSnapshot();
          const newVal = exp(5, 6);
          await expect(configuratorProxy.connect(marketAdmin).setBaseBorrowMin(cometProxy.address, newVal))
            .to.not.be.reverted;
          expect((await configuratorProxy.getConfiguration(cometProxy.address)).baseBorrowMin).to.equal(newVal);
          await innerSnapshot.restore();
        });
      });

      describe('market admin cannot call governor-only functions', function() {
        it('market admin cannot call setFactory', async () => {
          await expect(configuratorProxy.connect(marketAdmin).setFactory(cometProxy.address, ZERO_ADDRESS))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });

        it('market admin cannot call setGovernor', async () => {
          await expect(configuratorProxy.connect(marketAdmin).setGovernor(cometProxy.address, marketAdmin.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });

        it('market admin cannot call setPauseGuardian', async () => {
          await expect(configuratorProxy.connect(marketAdmin).setPauseGuardian(cometProxy.address, marketAdmin.address))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });

        it('market admin cannot call setConfiguration', async () => {
          const config = await configuratorProxy.getConfiguration(cometProxy.address);
          await expect(configuratorProxy.connect(marketAdmin).setConfiguration(cometProxy.address, config))
            .to.be.revertedWithCustomError(configurator, 'Unauthorized');
        });

        it('market admin cannot call addAsset', async () => {
          const assetConfig = {
            asset: unsupportedTokenAddr,
            priceFeed: ZERO_ADDRESS,
            borrowCollateralFactor: exp(0.8, 18),
            liquidateCollateralFactor: exp(0.9, 18),
            liquidationFactor: exp(0.95, 18),
            supplyCap: exp(100, 6),
          };
          await expect(configuratorProxy.connect(marketAdmin).addAsset(cometProxy.address, assetConfig))
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
          await expect(configuratorProxy.connect(marketAdmin).setSupplyKink(cometProxy.address, exp(0.5, 18)))
            .to.be.reverted;
        });
      });
    });

    describe('idempotency (setting same value)', function() {
      it('setSupplyKink emits event with old == new when setting same value', async () => {
        const config = await configuratorProxy.getConfiguration(cometProxy.address);
        const currentKink = config.supplyKink;

        const tx = await configuratorProxy.connect(governor).setSupplyKink(cometProxy.address, currentKink);
        await expect(tx)
          .to.emit(configuratorProxy, 'SetSupplyKink')
          .withArgs(cometProxy.address, currentKink, currentKink);
      });

      it('setBorrowKink emits event with old == new when setting same value', async () => {
        const config = await configuratorProxy.getConfiguration(cometProxy.address);
        const currentKink = config.borrowKink;

        const tx = await configuratorProxy.connect(governor).setBorrowKink(cometProxy.address, currentKink);
        await expect(tx)
          .to.emit(configuratorProxy, 'SetBorrowKink')
          .withArgs(cometProxy.address, currentKink, currentKink);
      });

      it('setPauseGuardian emits event with old == new when setting same value', async () => {
        const config = await configuratorProxy.getConfiguration(cometProxy.address);
        const currentGuardian = config.pauseGuardian;

        const tx = await configuratorProxy.connect(governor).setPauseGuardian(cometProxy.address, currentGuardian);
        await expect(tx)
          .to.emit(configuratorProxy, 'SetPauseGuardian')
          .withArgs(cometProxy.address, currentGuardian, currentGuardian);
      });

      it('setBaseTokenPriceFeed emits event with old == new when setting same value', async () => {
        const config = await configuratorProxy.getConfiguration(cometProxy.address);
        const currentFeed = config.baseTokenPriceFeed;

        const tx = await configuratorProxy.connect(governor).setBaseTokenPriceFeed(cometProxy.address, currentFeed);
        await expect(tx)
          .to.emit(configuratorProxy, 'SetBaseTokenPriceFeed')
          .withArgs(cometProxy.address, currentFeed, currentFeed);
      });

      it('setTargetReserves emits event with old == new when setting same value', async () => {
        const config = await configuratorProxy.getConfiguration(cometProxy.address);
        const currentReserves = config.targetReserves;

        const tx = await configuratorProxy.connect(governor).setTargetReserves(cometProxy.address, currentReserves);
        await expect(tx)
          .to.emit(configuratorProxy, 'SetTargetReserves')
          .withArgs(cometProxy.address, currentReserves, currentReserves);
      });

      it('updateAssetSupplyCap emits event with old == new when setting same value', async () => {
        const assetAddr = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0].asset;
        const currentCap = (await configuratorProxy.getAssetConfigs(cometProxy.address))[0].supplyCap;

        const tx = await configuratorProxy.connect(governor).updateAssetSupplyCap(cometProxy.address, assetAddr, currentCap);
        await expect(tx)
          .to.emit(configuratorProxy, 'UpdateAssetSupplyCap')
          .withArgs(cometProxy.address, assetAddr, currentCap, currentCap);
      });
    });
  });
});
