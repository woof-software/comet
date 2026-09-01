import { expect } from 'chai';
import { constants } from 'ethers';
import { ethers } from 'hardhat';
import {
  AssetListFactory__factory,
  CometExtAssetList__factory,
  CometWithExtendedAssetList__factory,
  ConfiguratorProxy__factory,
  Configurator__factory,
  FaucetToken__factory,
  LiquidationModuleForComet__factory,
  LiquidationModule__factory,
  OneInchV6Adapter__factory,
  SimplePriceFeed__factory,
  TransparentUpgradeableProxy__factory,
} from '../build/types';
import { scenario } from './context/CometContext';
import { fundAccount, hasModule } from './utils';
import {
  buildInitialCollateralSlippages,
  buildRoutesFromList,
  CORE_ROUTER,
  exp,
  REDUNDANT_ROUTER,
  SLIPPAGE_BPS,
  TOKENS,
} from '../test/helpers';

/**
 * Liquidation-module attachment scenarios. These cover the two lifecycle paths rather than absorb
 * behavior: binding an uninitialized module while deploying a new market, and swapping the module on
 * an already-live Comet through Configurator state followed by a proxy upgrade.
 */
scenario(
  'LiquidationModule deployment > new Comet deploys with the module initialized',
  { },
  async ({ actors }, _context, world) => {
    const { admin, pauseGuardian, albert, betty, charles } = actors;
    const INCENTIVE_BPS = 500n;
    const scenarioEthers = world.deploymentManager.hre.ethers;

    const FaucetTokenFactory = (await scenarioEthers.getContractFactory('FaucetToken')) as FaucetToken__factory;
    const [deployer] = await scenarioEthers.getSigners();
    await Promise.all([deployer, admin, pauseGuardian, albert, betty, charles].map((account) => fundAccount(world, account)));
    const baseToken = await FaucetTokenFactory.deploy(exp(1, 6), 'USD Coin', 6, 'USDC');
    await baseToken.deployed();
    const firstCollateral = await FaucetTokenFactory.deploy(exp(1, 18), 'Compound', 18, 'COMP');
    await firstCollateral.deployed();
    const secondCollateral = await FaucetTokenFactory.deploy(exp(1, 18), 'Wrapped Ether', 18, 'WETH');
    await secondCollateral.deployed();

    const PriceFeedFactory = (await scenarioEthers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
    const baseTokenPriceFeed = await PriceFeedFactory.deploy(exp(1, 8), 8);
    await baseTokenPriceFeed.deployed();
    const firstCollateralPriceFeed = await PriceFeedFactory.deploy(exp(100, 8), 8);
    await firstCollateralPriceFeed.deployed();
    const secondCollateralPriceFeed = await PriceFeedFactory.deploy(exp(2000, 8), 8);
    await secondCollateralPriceFeed.deployed();

    const AssetListFactory = (await scenarioEthers.getContractFactory('AssetListFactory')) as AssetListFactory__factory;
    const assetListFactory = await AssetListFactory.deploy();
    await assetListFactory.deployed();

    const CometExtFactory = (await scenarioEthers.getContractFactory('CometExtAssetList')) as CometExtAssetList__factory;
    const extensionDelegate = await CometExtFactory.deploy(
      {
        name32: ethers.utils.formatBytes32String('Compound Comet Scenarios'),
        symbol32: ethers.utils.formatBytes32String('CCS'),
      },
      assetListFactory.address
    );
    await extensionDelegate.deployed();

    const DexAdapterFactory = (await scenarioEthers.getContractFactory('OneInchV6Adapter')) as OneInchV6Adapter__factory;
    const dexAdapter = await DexAdapterFactory.deploy(
      CORE_ROUTER,
      REDUNDANT_ROUTER,
      TOKENS.WETH.address,
      SLIPPAGE_BPS,
      buildRoutesFromList([firstCollateral.address, secondCollateral.address], {}),
      buildInitialCollateralSlippages()
    );
    await dexAdapter.deployed();
    const LiquidationModuleFactory = (await scenarioEthers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
    const liquidationModule = await LiquidationModuleFactory.deploy(
      dexAdapter.address,
      betty.address,
      [albert.address],
      [charles.address],
      INCENTIVE_BPS
    );
    await liquidationModule.deployed();

    expect(liquidationModule.address).to.properAddress;
    expect(await liquidationModule.comet()).to.equal(constants.AddressZero);
    expect(await liquidationModule.assetList()).to.equal(constants.AddressZero);
    expect(await liquidationModule.dexAdapter()).to.equal(dexAdapter.address);
    expect(await liquidationModule.incentiveBps()).to.equal(INCENTIVE_BPS);
    expect(await liquidationModule.hasRole(await liquidationModule.EXECUTOR_ROLE(), albert.address)).to.be.true;
    expect(await liquidationModule.hasRole(await liquidationModule.PAUSER_ROLE(), charles.address)).to.be.true;
    expect(await liquidationModule.hasRole(await liquidationModule.MULTISIG_ROLE(), betty.address)).to.be.true;

    const ProxyAdminFactory = await scenarioEthers.getContractFactory('CometProxyAdmin');
    const proxyAdmin = await ProxyAdminFactory.deploy(admin.address);
    await proxyAdmin.deployed();
    const CometFactoryFactory = await scenarioEthers.getContractFactory('CometFactoryWithExtendedAssetList');
    const cometFactory = await CometFactoryFactory.deploy();
    await cometFactory.deployed();
    const ConfiguratorFactory = (await scenarioEthers.getContractFactory('Configurator')) as Configurator__factory;
    const configurator = await ConfiguratorFactory.deploy();
    await configurator.deployed();
    const initializeCalldata = (await configurator.populateTransaction.initialize(admin.address)).data;
    const ConfiguratorProxyFactory = (await scenarioEthers.getContractFactory('ConfiguratorProxy')) as ConfiguratorProxy__factory;
    const configuratorProxy = await ConfiguratorProxyFactory.deploy(configurator.address, proxyAdmin.address, initializeCalldata);
    await configuratorProxy.deployed();
    const configuratorAsProxy = configurator.attach(configuratorProxy.address).connect(admin.signer);
    const configuratorAsDeployer = configurator.attach(configuratorProxy.address).connect(charles.signer);

    const proxyDeployerNonce = await charles.signer.getTransactionCount();
    const predictedCometProxyAddress = ethers.utils.getContractAddress({ from: charles.address, nonce: proxyDeployerNonce + 1 });
    expect(await scenarioEthers.provider.getCode(predictedCometProxyAddress)).to.equal('0x');
    const configuration = {
      governor: admin.address,
      pauseGuardian: pauseGuardian.address,
      extensionDelegate: extensionDelegate.address,
      liquidationModule: liquidationModule.address,
      baseToken: baseToken.address,
      baseTokenPriceFeed: baseTokenPriceFeed.address,
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
          asset: firstCollateral.address,
          priceFeed: firstCollateralPriceFeed.address,
          decimals: 18,
          borrowCollateralFactor: exp(0.8, 18),
          liquidateCollateralFactor: exp(0.85, 18),
          liquidationFactor: exp(0.9, 18),
          supplyCap: exp(150000, 18),
        },
        {
          asset: secondCollateral.address,
          priceFeed: secondCollateralPriceFeed.address,
          decimals: 18,
          borrowCollateralFactor: exp(0.8, 18),
          liquidateCollateralFactor: exp(0.85, 18),
          liquidationFactor: exp(0.9, 18),
          supplyCap: exp(150000, 18),
        },
      ],
    };

    await configuratorAsProxy.setConfiguration(predictedCometProxyAddress, configuration);
    await configuratorAsProxy.setFactory(predictedCometProxyAddress, cometFactory.address);
    const storedConfiguration = await configuratorAsProxy.getConfiguration(predictedCometProxyAddress);
    expect(storedConfiguration.liquidationModule).to.equal(liquidationModule.address);

    const deployCometTx = await configuratorAsDeployer['deploy(address)'](predictedCometProxyAddress);
    const deployCometReceipt = await deployCometTx.wait();
    const cometDeployedEvent = deployCometReceipt.events?.find((event) => event.event === 'CometDeployed');
    const deployedImplementation = cometDeployedEvent?.args?.newComet;
    expect(deployCometReceipt.status).to.equal(1);
    await expect(deployCometTx).to.emit(configuratorAsProxy, 'CometDeployed').withArgs(predictedCometProxyAddress, deployedImplementation);
    expect(deployedImplementation).to.properAddress;

    const assetList = await liquidationModule.assetList();
    expect(assetList).to.properAddress;
    expect(await liquidationModule.numAssets()).to.equal(configuration.assetConfigs.length);
    expect(await liquidationModule.baseToken()).to.equal(baseToken.address);
    expect(await dexAdapter.baseAsset()).to.equal(baseToken.address);

    const CometFactory = (await scenarioEthers.getContractFactory('CometWithExtendedAssetList')) as CometWithExtendedAssetList__factory;
    const initializeStorageCalldata = CometFactory.interface.encodeFunctionData('initializeStorage');
    const CometProxyFactory = (await scenarioEthers.getContractFactory('TransparentUpgradeableProxy')) as TransparentUpgradeableProxy__factory;
    const cometProxy = await CometProxyFactory.connect(charles.signer).deploy(
      deployedImplementation,
      proxyAdmin.address,
      initializeStorageCalldata
    );
    await cometProxy.deployed();
    const cometAsProxy = CometFactory.attach(cometProxy.address);
    expect(cometProxy.address).to.equal(predictedCometProxyAddress);
    await expect(cometProxy.deployTransaction).to.emit(cometProxy, 'Upgraded').withArgs(deployedImplementation);
    expect(await cometAsProxy.liquidationModule()).to.equal(liquidationModule.address);
    expect(await liquidationModule.comet()).to.equal(cometProxy.address);

    await expect(liquidationModule.setAssetList(assetList, configuration.assetConfigs.length, baseToken.address))
      .to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
    await expect(liquidationModule.initiateModule(1_000_000n)).to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
  }
);

scenario(
  'LiquidationModule deployment > existing Comet switches modules only after upgrade',
  { filter: async (ctx) => await hasModule(ctx) },
  async ({ comet, configurator, proxyAdmin, actors }, _context, world) => {
    const { admin, albert, betty, charles } = actors;
    const INCENTIVE_BPS = 500n;
    const scenarioEthers = world.deploymentManager.hre.ethers;
    const [deployer] = await scenarioEthers.getSigners();
    await Promise.all([deployer, admin, albert, betty, charles].map((account) => fundAccount(world, account)));
    const cometProxyAddress = comet.address;
    const oldLiquidationModule = await comet.liquidationModule();
    const baseToken = await comet.baseToken();
    const assetListBefore = await comet.assetList();
    const numAssets = await comet.numAssets();
    const baseScale = await comet.baseScale();
    const collateralAssets = await Promise.all(Array.from({ length: numAssets }, async (_, index) => (await comet.getAssetInfo(index)).asset));

    const DexAdapterFactory = (await scenarioEthers.getContractFactory('OneInchV6Adapter')) as OneInchV6Adapter__factory;
    const dexAdapter = await DexAdapterFactory.deploy(
      CORE_ROUTER,
      REDUNDANT_ROUTER,
      TOKENS.WETH.address,
      SLIPPAGE_BPS,
      buildRoutesFromList(collateralAssets, {}),
      buildInitialCollateralSlippages()
    );
    await dexAdapter.deployed();
    const LiquidationModuleFactory = (await scenarioEthers.getContractFactory('LiquidationModuleForComet')) as LiquidationModuleForComet__factory;
    const liquidationModule = await LiquidationModuleFactory.deploy(
      dexAdapter.address,
      betty.address,
      [albert.address],
      [charles.address],
      INCENTIVE_BPS,
      cometProxyAddress,
      { gasLimit: 30_000_000 }
    );
    await liquidationModule.deployed();

    expect(liquidationModule.address).to.properAddress;
    expect(await liquidationModule.comet()).to.equal(cometProxyAddress);
    expect(await liquidationModule.baseScale()).to.equal(baseScale);
    expect(await liquidationModule.dexAdapter()).to.equal(dexAdapter.address);
    expect(await liquidationModule.incentiveBps()).to.equal(INCENTIVE_BPS);
    expect(await liquidationModule.partialLiquidationEnabled()).to.be.true;
    expect(await liquidationModule.TARGET_HEALTH_FACTOR()).to.equal(exp(1.05, 18));
    expect(await liquidationModule.hasRole(await liquidationModule.EXECUTOR_ROLE(), albert.address)).to.be.true;
    expect(await liquidationModule.hasRole(await liquidationModule.PAUSER_ROLE(), charles.address)).to.be.true;
    expect(await liquidationModule.hasRole(await liquidationModule.MULTISIG_ROLE(), betty.address)).to.be.true;
    expect(await dexAdapter.comet()).to.equal(cometProxyAddress);
    expect(await dexAdapter.module()).to.equal(liquidationModule.address);
    expect(await liquidationModule.assetList()).to.equal(constants.AddressZero);

    const configuratorAsGovernor = configurator.connect(admin.signer);
    expect((await configuratorAsGovernor.getConfiguration(cometProxyAddress)).liquidationModule).to.equal(oldLiquidationModule);
    expect(await comet.liquidationModule()).to.equal(oldLiquidationModule);
    const setLiquidationModuleTx = await configuratorAsGovernor.setLiquidationModule(cometProxyAddress, liquidationModule.address);
    const setLiquidationModuleReceipt = await setLiquidationModuleTx.wait();
    const setLiquidationModuleEvent = setLiquidationModuleReceipt.events?.find((event) => event.event === 'SetLiquidationModule');
    expect(setLiquidationModuleReceipt.status).to.equal(1);
    expect(setLiquidationModuleEvent?.args?.cometProxy).to.equal(cometProxyAddress);
    expect(setLiquidationModuleEvent?.args?.oldLiquidationModule).to.equal(oldLiquidationModule);
    expect(setLiquidationModuleEvent?.args?.newLiquidationModule).to.equal(liquidationModule.address);
    expect((await configuratorAsGovernor.getConfiguration(cometProxyAddress)).liquidationModule).to.equal(liquidationModule.address);
    expect(await comet.liquidationModule()).to.equal(oldLiquidationModule);

    const upgradeTx = await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, cometProxyAddress);
    const upgradeReceipt = await upgradeTx.wait();
    const eventInterface = new ethers.utils.Interface([
      'event CometDeployed(address indexed cometProxy, address indexed newComet)',
      'event Upgraded(address indexed implementation)',
    ]);
    const upgradeEvents = (upgradeReceipt.events ?? []).flatMap((event) => {
      try {
        return [eventInterface.parseLog(event)];
      } catch {
        return [];
      }
    });
    const deployedImplementation = upgradeEvents.find((event) => event.name === 'CometDeployed')?.args.newComet;
    expect(upgradeReceipt.status).to.equal(1);
    expect(upgradeEvents.map((event) => event.name)).to.include('CometDeployed');
    expect(upgradeEvents.map((event) => event.name)).to.include('Upgraded');
    expect(deployedImplementation).to.properAddress;

    const assetListAfter = await comet.assetList();
    expect(await comet.liquidationModule()).to.equal(liquidationModule.address);
    expect(await comet.baseToken()).to.equal(baseToken);
    expect(assetListAfter).to.not.equal(assetListBefore);
    expect(await liquidationModule.assetList()).to.equal(assetListAfter);
    expect(await liquidationModule.numAssets()).to.equal(numAssets);
    expect(await liquidationModule.baseToken()).to.equal(baseToken);
    expect(await liquidationModule.comet()).to.equal(cometProxyAddress);
    expect(await liquidationModule.baseScale()).to.equal(baseScale);
    expect(await dexAdapter.baseAsset()).to.equal(baseToken);
    expect(await dexAdapter.comet()).to.equal(cometProxyAddress);

    await expect(liquidationModule.setAssetList(assetListAfter, numAssets, baseToken))
      .to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
    await expect(liquidationModule.initiateModule(baseScale)).to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
  }
);
