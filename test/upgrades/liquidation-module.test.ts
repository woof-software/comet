import { expect } from 'chai';
import { ethers } from 'hardhat';
import {
  setupFork,
  impersonateAccount,
  setBalance,
  deployDefaultLiquidationModuleWithComet,
  deployEmptyDexAdapter,
} from '../helpers';
import {
  CometExtAssetList,
  CometFactoryWithExtendedAssetList__factory,
  CometProxyAdmin,
  CometWithExtendedAssetList,
  Configurator,
  LiquidationModule,
} from 'build/types';
import { ConfigurationStructOutput } from 'build/types/Configurator';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber, ContractTransaction } from 'ethers';
import { TotalsBasicStructOutput } from 'build/types/CometExtAssetList';

const LEGACY_CONFIGURATOR_ABI = [
  'function getConfiguration(address cometProxy) view returns ((address governor,address pauseGuardian,address baseToken,address baseTokenPriceFeed,address extensionDelegate,uint64 supplyKink,uint64 supplyPerYearInterestRateSlopeLow,uint64 supplyPerYearInterestRateSlopeHigh,uint64 supplyPerYearInterestRateBase,uint64 borrowKink,uint64 borrowPerYearInterestRateSlopeLow,uint64 borrowPerYearInterestRateSlopeHigh,uint64 borrowPerYearInterestRateBase,uint64 storeFrontPriceFactor,uint64 trackingIndexScale,uint64 baseTrackingSupplySpeed,uint64 baseTrackingBorrowSpeed,uint104 baseMinForRewards,uint104 baseBorrowMin,uint104 targetReserves,(address asset,address priceFeed,uint8 decimals,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap)[] assetConfigs))',
];

type LegacyConfiguration = {
  governor: string;
  pauseGuardian: string;
  baseToken: string;
  baseTokenPriceFeed: string;
  extensionDelegate: string;
  supplyKink: BigNumber;
  supplyPerYearInterestRateSlopeLow: BigNumber;
  supplyPerYearInterestRateSlopeHigh: BigNumber;
  supplyPerYearInterestRateBase: BigNumber;
  borrowKink: BigNumber;
  borrowPerYearInterestRateSlopeLow: BigNumber;
  borrowPerYearInterestRateSlopeHigh: BigNumber;
  borrowPerYearInterestRateBase: BigNumber;
  storeFrontPriceFactor: BigNumber;
  trackingIndexScale: BigNumber;
  baseTrackingSupplySpeed: BigNumber;
  baseTrackingBorrowSpeed: BigNumber;
  baseMinForRewards: BigNumber;
  baseBorrowMin: BigNumber;
  targetReserves: BigNumber;
  assetConfigs: {
    asset: string;
    priceFeed: string;
    decimals: number;
    borrowCollateralFactor: BigNumber;
    liquidateCollateralFactor: BigNumber;
    liquidationFactor: BigNumber;
    supplyCap: BigNumber;
  }[];
};

type CometValuesSnapshot = {
  governor: string;
  pauseGuardian: string;
  baseToken: string;
  baseTokenPriceFeed: string;
  extensionDelegate: string;
  supplyKink: string;
  borrowKink: string;
  storeFrontPriceFactor: string;
  trackingIndexScale: string;
  baseTrackingSupplySpeed: string;
  baseTrackingBorrowSpeed: string;
  baseMinForRewards: string;
  baseBorrowMin: string;
  targetReserves: string;
  numAssets: number;
  totalsBasic: TotalsBasicStructOutput;
};

function normalizeConfiguration(configuration: ConfigurationStructOutput | LegacyConfiguration) {
  return {
    governor: configuration.governor,
    pauseGuardian: configuration.pauseGuardian,
    baseToken: configuration.baseToken,
    baseTokenPriceFeed: configuration.baseTokenPriceFeed,
    extensionDelegate: configuration.extensionDelegate,
    supplyKink: configuration.supplyKink.toString(),
    supplyPerYearInterestRateSlopeLow: configuration.supplyPerYearInterestRateSlopeLow.toString(),
    supplyPerYearInterestRateSlopeHigh: configuration.supplyPerYearInterestRateSlopeHigh.toString(),
    supplyPerYearInterestRateBase: configuration.supplyPerYearInterestRateBase.toString(),
    borrowKink: configuration.borrowKink.toString(),
    borrowPerYearInterestRateSlopeLow: configuration.borrowPerYearInterestRateSlopeLow.toString(),
    borrowPerYearInterestRateSlopeHigh: configuration.borrowPerYearInterestRateSlopeHigh.toString(),
    borrowPerYearInterestRateBase: configuration.borrowPerYearInterestRateBase.toString(),
    storeFrontPriceFactor: configuration.storeFrontPriceFactor.toString(),
    trackingIndexScale: configuration.trackingIndexScale.toString(),
    baseTrackingSupplySpeed: configuration.baseTrackingSupplySpeed.toString(),
    baseTrackingBorrowSpeed: configuration.baseTrackingBorrowSpeed.toString(),
    baseMinForRewards: configuration.baseMinForRewards.toString(),
    baseBorrowMin: configuration.baseBorrowMin.toString(),
    targetReserves: configuration.targetReserves.toString(),
    assetConfigs: configuration.assetConfigs.map((assetConfig) => ({
      asset: assetConfig.asset,
      priceFeed: assetConfig.priceFeed,
      decimals: assetConfig.decimals,
      borrowCollateralFactor: assetConfig.borrowCollateralFactor.toString(),
      liquidateCollateralFactor: assetConfig.liquidateCollateralFactor.toString(),
      liquidationFactor: assetConfig.liquidationFactor.toString(),
      supplyCap: assetConfig.supplyCap.toString(),
    })),
  };
}

async function getCometValuesSnapshot(
  comet: CometWithExtendedAssetList,
  cometExt: CometExtAssetList
): Promise<CometValuesSnapshot> {
  return {
    governor: await comet.governor(),
    pauseGuardian: await comet.pauseGuardian(),
    baseToken: await comet.baseToken(),
    baseTokenPriceFeed: await comet.baseTokenPriceFeed(),
    extensionDelegate: await comet.extensionDelegate(),
    supplyKink: (await comet.supplyKink()).toString(),
    borrowKink: (await comet.borrowKink()).toString(),
    storeFrontPriceFactor: (await comet.storeFrontPriceFactor()).toString(),
    trackingIndexScale: (await comet.trackingIndexScale()).toString(),
    baseTrackingSupplySpeed: (await comet.baseTrackingSupplySpeed()).toString(),
    baseTrackingBorrowSpeed: (await comet.baseTrackingBorrowSpeed()).toString(),
    baseMinForRewards: (await comet.baseMinForRewards()).toString(),
    baseBorrowMin: (await comet.baseBorrowMin()).toString(),
    targetReserves: (await comet.targetReserves()).toString(),
    numAssets: await comet.numAssets(),
    totalsBasic: await cometExt.totalsBasic(),
  };
}

// This fork test covers the two-step mainnet upgrade path for adding liquidation
// module configuration to the USDC Comet. It first proves the Configurator proxy
// values survive its implementation upgrade, then proves Comet proxy values
// survive the move to a fresh CometWithExtendedAssetList implementation that
// binds a LiquidationModuleForComet via immutable constructor config.
describe('liquidation module upgrade', function () {
  const FORK_BLOCK_NUMBER = 25172553;
  const COMET_ADDRESS = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
  const CONFIGURATOR_ADDRESS = '0x316f9708bB98af7dA9c68C1C3b5e79039cD336E3';
  const GOVERNOR_ADDRESS = '0x6d903f6003cca6255d85cca4d3b5e5146dc33925';
  const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

  let comet: CometWithExtendedAssetList;
  let cometExt: CometExtAssetList;
  let configurator: Configurator;
  let proxyAdmin: CometProxyAdmin;
  let governor: SignerWithAddress;
  let configuratorProxyAdmin: SignerWithAddress;
  let liquidationModule: LiquidationModule;

  let configuratorConfigurationBefore: ReturnType<typeof normalizeConfiguration>;
  let configuratorConfigurationAfter: ReturnType<typeof normalizeConfiguration>;
  let cometValuesBefore: CometValuesSnapshot;
  let cometValuesAfter: CometValuesSnapshot;
  let originalCometImplementation: string;
  let newCometImplementation: string;
  let newFactoryAddress: string;
  let setLiquidationModuleTx: ContractTransaction;
  let deployCometTx: ContractTransaction;
  let upgradeCometTx: ContractTransaction;

  before(async function () {
    await setupFork(FORK_BLOCK_NUMBER);

    comet = (await ethers.getContractAt('CometWithExtendedAssetList', COMET_ADDRESS)) as CometWithExtendedAssetList;
    cometExt = (await ethers.getContractAt('CometExtAssetList', COMET_ADDRESS)) as CometExtAssetList;
    configurator = (await ethers.getContractAt('Configurator', CONFIGURATOR_ADDRESS)) as Configurator;

    const configuratorAdminRaw = await ethers.provider.getStorageAt(CONFIGURATOR_ADDRESS, ADMIN_SLOT);
    const configuratorAdminAddress = ethers.utils.getAddress('0x' + configuratorAdminRaw.slice(26));
    await impersonateAccount(configuratorAdminAddress);
    configuratorProxyAdmin = await ethers.getSigner(configuratorAdminAddress);
    await setBalance(configuratorAdminAddress, ethers.utils.parseEther('10000'));

    const cometAdminRaw = await ethers.provider.getStorageAt(COMET_ADDRESS, ADMIN_SLOT);
    const cometAdminAddress = ethers.utils.getAddress('0x' + cometAdminRaw.slice(26));
    proxyAdmin = (await ethers.getContractAt('CometProxyAdmin', cometAdminAddress)) as CometProxyAdmin;
    originalCometImplementation = await proxyAdmin.getProxyImplementation(COMET_ADDRESS);

    await impersonateAccount(GOVERNOR_ADDRESS);
    governor = await ethers.getSigner(GOVERNOR_ADDRESS);
    await setBalance(GOVERNOR_ADDRESS, ethers.utils.parseEther('10000'));
  });

  describe('when upgrading the configurator', function () {
    let latestConfiguratorImplementation: string;
    let configuratorUpgradeTx: ContractTransaction;

    it('grabs the configurator values for the Comet proxy', async function () {
      const legacyConfigurator = await ethers.getContractAt(
        LEGACY_CONFIGURATOR_ABI,
        CONFIGURATOR_ADDRESS
      );
      configuratorConfigurationBefore = normalizeConfiguration(
        await legacyConfigurator.getConfiguration(COMET_ADDRESS)
      );
    });

    it('deploys the new configurator implementation', async function () {
      const LatestConfigurator = await ethers.getContractFactory('Configurator');
      const latestConfigurator = await LatestConfigurator.deploy();
      await latestConfigurator.deployed();
      latestConfiguratorImplementation = latestConfigurator.address;
      expect(latestConfiguratorImplementation).to.not.equal(ethers.constants.AddressZero);
    });

    it('updates the configurator proxy implementation', async function () {
      const configuratorProxy = await ethers.getContractAt('ConfiguratorProxy', CONFIGURATOR_ADDRESS);
      configuratorUpgradeTx = await configuratorProxy
        .connect(configuratorProxyAdmin)
        .upgradeTo(latestConfiguratorImplementation);
      await expect(configuratorUpgradeTx).to.not.be.reverted;

      configurator = (await ethers.getContractAt('Configurator', CONFIGURATOR_ADDRESS)) as Configurator;
    });

    it('keeps the configurator values for the Comet proxy unchanged', async function () {
      configuratorConfigurationAfter = normalizeConfiguration(
        await configurator.getConfiguration(COMET_ADDRESS)
      );
      expect(configuratorConfigurationAfter).to.deep.equal(configuratorConfigurationBefore);
    });

    it('starts the new configurator fields empty after upgrade', async function () {
      const configuration = await configurator.getConfiguration(COMET_ADDRESS);

      expect(configuration.liquidationModule).to.equal(ethers.constants.AddressZero);
    });

    it('keeps the Comet configuration aligned with the live Comet', async function () {
      const configuration = await configurator.getConfiguration(COMET_ADDRESS);

      expect(configuration.governor).to.equal(await comet.governor());
      expect(configuration.pauseGuardian).to.equal(await comet.pauseGuardian());
      expect(configuration.baseToken).to.equal(await comet.baseToken());
      expect(configuration.baseTokenPriceFeed).to.equal(await comet.baseTokenPriceFeed());
      expect(configuration.extensionDelegate).to.equal(await comet.extensionDelegate());
      expect(configuration.supplyKink).to.equal(await comet.supplyKink());
      expect(configuration.borrowKink).to.equal(await comet.borrowKink());
      expect(configuration.storeFrontPriceFactor).to.equal(await comet.storeFrontPriceFactor());
      expect(configuration.trackingIndexScale).to.equal(await comet.trackingIndexScale());
      expect(configuration.baseTrackingSupplySpeed).to.equal(await comet.baseTrackingSupplySpeed());
      expect(configuration.baseTrackingBorrowSpeed).to.equal(await comet.baseTrackingBorrowSpeed());
      expect(configuration.baseMinForRewards).to.equal(await comet.baseMinForRewards());
      expect(configuration.baseBorrowMin).to.equal(await comet.baseBorrowMin());
      expect(configuration.targetReserves).to.equal(await comet.targetReserves());
      expect(configuration.assetConfigs.length).to.equal(await comet.numAssets());
    });
  });

  describe('when upgrading the Comet implementation', function () {
    it('grabs the Comet proxy values', async function () {
      cometValuesBefore = await getCometValuesSnapshot(comet, cometExt);
    });

    it('deploys a LiquidationModuleForComet bound to the existing Comet', async function () {
      // Use non-DAO role holders: DAO is already granted PAUSER_ROLE in the LM constructor.
      const [executor, pauser, multisig] = await ethers.getSigners();
      const configuration = await configurator.getConfiguration(COMET_ADDRESS);
      const collateralAddresses = configuration.assetConfigs.map((assetConfig) => assetConfig.asset);
      const dexAdapter = await deployEmptyDexAdapter(collateralAddresses);
      liquidationModule = await deployDefaultLiquidationModuleWithComet(
        {
          multisig: multisig.address,
          executors: [executor.address],
          pausers: [pauser.address],
          dexAdapter: dexAdapter.address,
        },
        COMET_ADDRESS
      );
      expect(liquidationModule.address).to.not.equal(ethers.constants.AddressZero);
    });

    it('sets the liquidation module in the configurator', async function () {
      setLiquidationModuleTx = await configurator.connect(governor).setLiquidationModule(COMET_ADDRESS, liquidationModule.address);
      await expect(setLiquidationModuleTx).to.not.be.reverted;
    });

    it('emits SetLiquidationModule', async function () {
      await expect(setLiquidationModuleTx).to.emit(configurator, 'SetLiquidationModule')
        .withArgs(COMET_ADDRESS, ethers.constants.AddressZero, liquidationModule.address);
    });

    it('sets the extended asset list Comet factory', async function () {
      const CometFactoryWithExtendedAssetList = (await ethers.getContractFactory(
        'CometFactoryWithExtendedAssetList'
      )) as CometFactoryWithExtendedAssetList__factory;
      const newFactory = await CometFactoryWithExtendedAssetList.deploy();
      await newFactory.deployed();
      newFactoryAddress = newFactory.address;

      await expect(configurator.connect(governor).setFactory(COMET_ADDRESS, newFactoryAddress)).to.not.be.reverted;
    });

    it('stores the new deployment-only configuration', async function () {
      const configuration = await configurator.getConfiguration(COMET_ADDRESS);

      expect(configuration.liquidationModule).to.equal(liquidationModule.address);
      expect(await configurator.factory(COMET_ADDRESS)).to.equal(newFactoryAddress);
    });

    it('deploys the new extended asset list Comet implementation', async function () {
      // Fresh LM is required: the new implementation constructor calls setAssetList on it.
      deployCometTx = await configurator.connect(governor).deploy(COMET_ADDRESS);
      const deployReceipt = await deployCometTx.wait();
      const deployEvent = deployReceipt.events.find((event) => event.event === 'CometDeployed');
      newCometImplementation = deployEvent.args.newComet;

      expect(newCometImplementation).to.not.equal(ethers.constants.AddressZero);
      expect(newCometImplementation).to.not.equal(originalCometImplementation);
    });

    it('updates the Comet proxy implementation', async function () {
      upgradeCometTx = await proxyAdmin.connect(governor).upgrade(COMET_ADDRESS, newCometImplementation);
      await expect(upgradeCometTx).to.not.be.reverted;
    });

    it('uses the new Comet implementation', async function () {
      expect(await proxyAdmin.getProxyImplementation(COMET_ADDRESS)).to.equal(newCometImplementation);
    });

    it('uses the configured liquidation module as an immutable on the new implementation', async function () {
      expect(await comet.liquidationModule()).to.equal(liquidationModule.address);
    });

    it('keeps the Comet proxy values unchanged', async function () {
      cometValuesAfter = await getCometValuesSnapshot(comet, cometExt);
      expect(cometValuesAfter).to.deep.equal(cometValuesBefore);
    });
  });
});
