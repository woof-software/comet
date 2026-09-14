import { ContractTransaction } from 'ethers';
import {
  AssetListFactory__factory,
  CometExtAssetList__factory,
  CometProxyAdmin,
  CometProxyAdmin__factory,
  CometWithExtendedAssetList,
  CometWithExtendedAssetList__factory,
  Configurator,
  ConfiguratorProxy__factory,
  Configurator__factory,
  FaucetToken__factory,
  DexLiquidationModule,
  DexLiquidationModule__factory,
  OneInchV6Adapter,
  SimplePriceFeed__factory,
  TransparentUpgradeableProxy,
  TransparentUpgradeableProxy__factory,
} from 'build/types';
import {
  deployEmptyDexAdapter,
  ethers,
  exp,
  expect,
} from '../../helpers';

// Covers the deployment flow for a new Comet market that starts with the
// default DexLiquidationModule. The module is deployed before the Comet exists,
// then Comet deployment initializes its asset list and proxy storage binds it.
describe('deploy liquidation module for new comet', function () {
  const INCENTIVE_BPS = BigInt(500);

  let configuratorAsProxy: Configurator;
  let cometAsProxy: CometWithExtendedAssetList;
  let cometProxy: TransparentUpgradeableProxy;
  let proxyAdmin: CometProxyAdmin;
  let liquidationModule: DexLiquidationModule;
  let dexAdapter: OneInchV6Adapter;

  let predictedCometProxyAddress: string;
  let deployedImplementation: string;
  let baseToken: string;
  let assetList: string;
  let numAssets: number;
  let baseScale: bigint;
  let multisig: string;
  let executor: string;
  let pauser: string;

  before(async () => {
    const signers = await ethers.getSigners();
    const [deployer, governor, pauseGuardian] = signers;
    multisig = signers[3].address;
    executor = signers[4].address;
    pauser = signers[5].address;

    const FaucetTokenFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
    const usdc = await FaucetTokenFactory.deploy(exp(1, 6), 'USD Coin', 6, 'USDC');
    await usdc.deployed();
    const comp = await FaucetTokenFactory.deploy(exp(1, 18), 'Compound', 18, 'COMP');
    await comp.deployed();
    const weth = await FaucetTokenFactory.deploy(exp(1, 18), 'Wrapped Ether', 18, 'WETH');
    await weth.deployed();

    const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
    const usdcFeed = await PriceFeedFactory.deploy(exp(1, 8), 8);
    await usdcFeed.deployed();
    const compFeed = await PriceFeedFactory.deploy(exp(100, 8), 8);
    await compFeed.deployed();
    const wethFeed = await PriceFeedFactory.deploy(exp(2000, 8), 8);
    await wethFeed.deployed();

    const AssetListFactory = (await ethers.getContractFactory('AssetListFactory')) as AssetListFactory__factory;
    const assetListFactory = await AssetListFactory.deploy();
    await assetListFactory.deployed();

    const CometExtFactory = (await ethers.getContractFactory('CometExtAssetList')) as CometExtAssetList__factory;
    const extensionDelegate = await CometExtFactory.deploy(
      {
        name32: ethers.utils.formatBytes32String('Compound Comet'),
        symbol32: ethers.utils.formatBytes32String('cUSDC'),
      },
      assetListFactory.address
    );
    await extensionDelegate.deployed();

    dexAdapter = await deployEmptyDexAdapter([comp.address, weth.address]);

    const DexLiquidationModuleFactory = (await ethers.getContractFactory('DexLiquidationModule')) as DexLiquidationModule__factory;
    liquidationModule = await DexLiquidationModuleFactory.deploy(
      dexAdapter.address,
      multisig,
      [executor],
      [pauser],
      INCENTIVE_BPS
    );
    await liquidationModule.deployed();

    const ProxyAdminFactory = (await ethers.getContractFactory('CometProxyAdmin')) as CometProxyAdmin__factory;
    proxyAdmin = await ProxyAdminFactory.deploy(governor.address);
    await proxyAdmin.deployed();

    const CometFactoryFactory = (await ethers.getContractFactory('CometFactoryWithExtendedAssetList'));
    const cometFactory = await CometFactoryFactory.deploy();
    await cometFactory.deployed();

    const ConfiguratorFactory = (await ethers.getContractFactory('Configurator')) as Configurator__factory;
    const configurator = await ConfiguratorFactory.deploy();
    await configurator.deployed();

    const initializeCalldata = (await configurator.populateTransaction.initialize(governor.address)).data;
    const ConfiguratorProxyFactory = (await ethers.getContractFactory('ConfiguratorProxy')) as ConfiguratorProxy__factory;
    const configuratorProxy = await ConfiguratorProxyFactory.deploy(configurator.address, proxyAdmin.address, initializeCalldata);
    await configuratorProxy.deployed();
    configuratorAsProxy = configurator.attach(configuratorProxy.address);

    const deployerNonce = await deployer.getTransactionCount();
    predictedCometProxyAddress = ethers.utils.getContractAddress({
      from: deployer.address,
      nonce: deployerNonce + 1,
    });

    const configuration = {
      governor: governor.address,
      pauseGuardian: pauseGuardian.address,
      extensionDelegate: extensionDelegate.address,
      liquidationModule: liquidationModule.address,
      baseToken: usdc.address,
      baseTokenPriceFeed: usdcFeed.address,
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.05, 18),
      supplyPerYearInterestRateSlopeHigh: exp(2, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(0.005, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.1, 18),
      borrowPerYearInterestRateSlopeHigh: exp(3, 18),
      storeFrontPriceFactor: exp(1, 18),
      trackingIndexScale: exp(1, 15),
      baseTrackingSupplySpeed: exp(1, 15),
      baseTrackingBorrowSpeed: exp(1, 15),
      baseMinForRewards: exp(1, 6),
      baseBorrowMin: exp(1, 6),
      targetReserves: 0,
      assetConfigs: [
        {
          asset: comp.address,
          priceFeed: compFeed.address,
          decimals: 18,
          borrowCollateralFactor: exp(0.8, 18),
          liquidateCollateralFactor: exp(0.85, 18),
          liquidationFactor: exp(0.9, 18),
          supplyCap: exp(150000, 18),
        },
        {
          asset: weth.address,
          priceFeed: wethFeed.address,
          decimals: 18,
          borrowCollateralFactor: exp(0.8, 18),
          liquidateCollateralFactor: exp(0.85, 18),
          liquidationFactor: exp(0.9, 18),
          supplyCap: exp(150000, 18),
        },
      ],
    };

    await configuratorAsProxy.connect(governor).setConfiguration(predictedCometProxyAddress, configuration);
    await configuratorAsProxy.connect(governor).setFactory(predictedCometProxyAddress, cometFactory.address);

    baseToken = usdc.address;
    numAssets = configuration.assetConfigs.length;
    baseScale = BigInt(1_000_000);
  });

  describe('deploy module before comet', function () {
    it('deploys the module', async () => {
      expect(liquidationModule.address).to.properAddress;
    });

    it('emits the initial incentive event', async () => {
      await expect(liquidationModule.deployTransaction)
        .to.emit(liquidationModule, 'IncentiveBpsUpdated')
        .withArgs(0, INCENTIVE_BPS);
    });

    it('does not bind COMET before comet deployment', async () => {
      expect(await liquidationModule.comet()).to.equal(ethers.constants.AddressZero);
    });

    it('does not set the asset list before comet deployment', async () => {
      expect(await liquidationModule.assetList()).to.equal(ethers.constants.AddressZero);
    });

    it('sets the DEX adapter', async () => {
      expect(await liquidationModule.dexAdapter()).to.equal(dexAdapter.address);
    });

    it('sets the incentive bps', async () => {
      expect(await liquidationModule.incentiveBps()).to.equal(INCENTIVE_BPS);
    });

    it('grants the executor role', async () => {
      expect(await liquidationModule.hasRole(await liquidationModule.EXECUTOR_ROLE(), executor)).to.be.true;
    });

    it('grants the pauser role', async () => {
      expect(await liquidationModule.hasRole(await liquidationModule.PAUSER_ROLE(), pauser)).to.be.true;
    });
  });

  describe('update config for comet', function () {
    it('stores the liquidation module in the configuration', async () => {
      expect((await configuratorAsProxy.getConfiguration(predictedCometProxyAddress)).liquidationModule).to.equal(liquidationModule.address);
    });

    it('stores the base token in the configuration', async () => {
      expect((await configuratorAsProxy.getConfiguration(predictedCometProxyAddress)).baseToken).to.equal(baseToken);
    });
  });

  describe('deploy comet', function () {
    let deployCometTx: ContractTransaction;
    let deployProxyTx: ContractTransaction;
    let deploymentEventNames: string[];

    it('deploys the comet implementation from configurator', async () => {
      deployCometTx = await configuratorAsProxy['deploy(address)'](predictedCometProxyAddress);
      const receipt = await deployCometTx.wait();
      const iface = new ethers.utils.Interface([
        'event CometDeployed(address indexed cometProxy, address indexed newComet)',
      ]);
      const cometDeployed = (receipt.events ?? [])
        .map((event) => {
          try {
            return iface.parseLog(event);
          } catch {
            return undefined;
          }
        })
        .find((event) => event?.name === 'CometDeployed');

      deployedImplementation = cometDeployed?.args.newComet;

      expect(receipt.status).to.equal(1);
    });

    it('emits CometDeployed', async () => {
      await expect(deployCometTx)
        .to.emit(configuratorAsProxy, 'CometDeployed')
        .withArgs(predictedCometProxyAddress, deployedImplementation);
    });

    it('deploys a comet implementation', async () => {
      expect(deployedImplementation).to.properAddress;
    });

    it('sets the module asset list during implementation deployment', async () => {
      assetList = await liquidationModule.assetList();
      expect(assetList).to.properAddress;
    });

    it('sets the module asset count during implementation deployment', async () => {
      expect(await liquidationModule.numAssets()).to.equal(numAssets);
    });

    it('sets the module base token during implementation deployment', async () => {
      expect(await liquidationModule.baseToken()).to.equal(baseToken);
    });

    it('sets the DEX adapter base asset during implementation deployment', async () => {
      expect(await dexAdapter.baseAsset()).to.equal(baseToken);
    });

    it('deploys the comet proxy and initializes storage', async () => {
      const CometFactory = (await ethers.getContractFactory('CometWithExtendedAssetList')) as CometWithExtendedAssetList__factory;
      const initializeStorageCalldata = CometFactory.interface.encodeFunctionData('initializeStorage');
      const CometProxyFactory = (await ethers.getContractFactory('TransparentUpgradeableProxy')) as TransparentUpgradeableProxy__factory;

      cometProxy = await CometProxyFactory.deploy(
        deployedImplementation,
        proxyAdmin.address,
        initializeStorageCalldata
      );
      deployProxyTx = cometProxy.deployTransaction;
      await cometProxy.deployed();
      cometAsProxy = CometFactory.attach(cometProxy.address);

      expect(cometProxy.address).to.equal(predictedCometProxyAddress);
    });

    it('emits Upgraded from the proxy deployment', async () => {
      const receipt = await deployProxyTx.wait();
      const iface = new ethers.utils.Interface([
        'event Upgraded(address indexed implementation)',
      ]);

      deploymentEventNames = (receipt.events ?? [])
        .map((event) => {
          try {
            return iface.parseLog(event).name;
          } catch {
            return undefined;
          }
        })
        .filter((eventName): eventName is string => eventName !== undefined);

      expect(deploymentEventNames).to.include('Upgraded');
    });

    it('Comet uses the liquidation module', async () => {
      expect(await cometAsProxy.liquidationModule()).to.equal(liquidationModule.address);
    });

    it('Comet uses the configured base token', async () => {
      expect(await cometAsProxy.baseToken()).to.equal(baseToken);
    });

    it('Comet uses the module asset list', async () => {
      expect(await cometAsProxy.assetList()).to.equal(assetList);
    });

    it('sets COMET on the module to the proxy', async () => {
      expect(await liquidationModule.comet()).to.equal(cometProxy.address);
    });

    it('sets BASE_SCALE on the module from Comet storage initialization', async () => {
      expect(await liquidationModule.baseScale()).to.equal(baseScale);
    });

    it('initiates the DEX adapter for the comet proxy', async () => {
      expect(await dexAdapter.comet()).to.equal(cometProxy.address);
    });

    it('authorizes the module on the DEX adapter', async () => {
      expect(await dexAdapter.module()).to.equal(liquidationModule.address);
    });
  });

  describe('revert when', function () {
    it('setAssetList is called after deployment initialized it', async () => {
      await expect(
        liquidationModule.setAssetList(assetList, numAssets, baseToken)
      ).to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
    });

    it('initiateModule is called after proxy storage initialized it', async () => {
      await expect(
        liquidationModule.initiateModule(baseScale)
      ).to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
    });
  });
});
