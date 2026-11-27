import { ethers } from 'hardhat';
import { BigNumber, utils } from 'ethers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import {
  AssetList,
  AssetListFactory,
  CometProxyAdmin,
  Configurator,
  ConfiguratorIntermediate,
  ConfiguratorV1,
} from 'build/types';
import { impersonateAccount, setBalance } from './network-helpers';

// The slot a transparent proxy keeps its admin in (EIP-1967)
export const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

// Storage layout of the V1 Configurator, where the asset configs still live inside the Configuration:
// configuratorParams is the mapping at slot 1, Configuration.assetConfigs is the struct's 11th slot (offset 10),
// and each old AssetConfig takes 3 slots (asset | priceFeed + decimals + borrowCF | liquidateCF + liquidationFactor + supplyCap).
// In the final layout the same offset 10 is read as Configuration.assetList
const CONFIGURATOR_PARAMS_SLOT = 1;
const ASSET_CONFIGS_OFFSET = 10;
const OLD_ASSET_CONFIG_SLOTS = 3;

export type ConfigurationV1 = Awaited<ReturnType<ConfiguratorV1['getConfiguration']>>;
export type ConfigurationFinal = Awaited<ReturnType<Configurator['getConfiguration']>>;
export type AssetConfigsFinal = Awaited<ReturnType<Configurator['getAssetConfigs']>>;

// Raw storage of the old Configuration.assetConfigs array of one market
export interface OldAssetConfigsStorage {
  length: BigNumber;
  // Every slot of every element, in order
  elementSlots: string[];
}

export interface ConfiguratorMigrationResult {
  // Read through the V1 ABI before any upgrade
  v1Configuration: ConfigurationV1;
  oldAssetConfigsStorageBefore: OldAssetConfigsStorage;
  // Read right after the migration, before the market is given its asset list
  oldAssetConfigsStorageAfter: OldAssetConfigsStorage;
  configurationAfterMigration: ConfigurationFinal;
  assetConfigsAfterMigration: AssetConfigsFinal;
  versionBefore: BigNumber;
  governorBefore: string;
  factoryBefore: string;
  // Deployed contracts
  configuratorAdmin: CometProxyAdmin;
  configuratorImplementation: string;
  assetListFactory: AssetListFactory;
  assetList: AssetList;
}

function slotAt(base: string, offset: number | BigNumber): string {
  return utils.hexZeroPad(BigNumber.from(base).add(offset).toHexString(), 32);
}

/**
 * Reads the raw storage of the old Configuration.assetConfigs array of a market, so the migration can be checked to
 * have cleared it. `numElements` is passed in, as the length slot is zeroed by the migration
 */
export async function readOldAssetConfigsStorage(
  configuratorAddress: string,
  cometAddress: string,
  numElements: number
): Promise<OldAssetConfigsStorage> {
  const configurationSlot = utils.keccak256(
    utils.defaultAbiCoder.encode(['address', 'uint256'], [cometAddress, CONFIGURATOR_PARAMS_SLOT])
  );
  const lengthSlot = slotAt(configurationSlot, ASSET_CONFIGS_OFFSET);
  const dataSlot = utils.keccak256(lengthSlot);

  const length = BigNumber.from(await ethers.provider.getStorageAt(configuratorAddress, lengthSlot));
  const elementSlots: string[] = [];
  for (let i = 0; i < numElements * OLD_ASSET_CONFIG_SLOTS; i++) {
    elementSlots.push(await ethers.provider.getStorageAt(configuratorAddress, slotAt(dataSlot, i)));
  }
  return { length, elementSlots };
}

/**
 * Moves a live market from the V1 Configurator to the asset list, the way the migration proposals do it:
 *  1. upgrade the Configurator to ConfiguratorIntermediate and move the market's asset configs out of the Configuration;
 *  2. upgrade it to the final Configurator and set the market's asset list factory;
 *  3. deploy the market's first asset list (implementation from the factory, proxy owned by the Comet's proxy admin,
 *     initialized with the migrated factors and caps) and set it with setConfiguration.
 * Only the given market is migrated. The Comet itself is not redeployed.
 * Everything needed to check the migration is recorded on the way and returned.
 */
export async function migrateConfiguratorToAssetList(
  configuratorAddress: string,
  cometAddress: string,
  governor: SignerWithAddress,
  cometProxyAdmin: CometProxyAdmin
): Promise<ConfiguratorMigrationResult> {
  // The Configurator proxy is upgraded by its own admin, read from the EIP-1967 admin slot
  const configuratorAdmin = (await ethers.getContractAt(
    'CometProxyAdmin',
    utils.getAddress('0x' + (await ethers.provider.getStorageAt(configuratorAddress, ADMIN_SLOT)).slice(26))
  )) as CometProxyAdmin;
  const configuratorAdminOwner = await configuratorAdmin.owner();
  await impersonateAccount(configuratorAdminOwner);
  await setBalance(configuratorAdminOwner, utils.parseEther('10000'));
  const configuratorAdminSigner = await ethers.getSigner(configuratorAdminOwner);

  // Snapshot the V1 state
  const configuratorV1 = (await ethers.getContractAt('ConfiguratorV1', configuratorAddress)) as ConfiguratorV1;
  const v1Configuration = await configuratorV1.getConfiguration(cometAddress);
  const numAssets = v1Configuration.assetConfigs.length;
  const oldAssetConfigsStorageBefore = await readOldAssetConfigsStorage(configuratorAddress, cometAddress, numAssets);
  const versionBefore = await configuratorV1.version();
  const governorBefore = await configuratorV1.governor();
  const factoryBefore = await configuratorV1.factory(cometAddress);

  // Step 1: Intermediate Configurator moves the asset configs to their own mapping and clears the old array
  const intermediateImplementation = await (await ethers.getContractFactory('ConfiguratorIntermediate')).deploy();
  await configuratorAdmin.connect(configuratorAdminSigner).upgrade(configuratorAddress, intermediateImplementation.address);
  const intermediate = (await ethers.getContractAt('ConfiguratorIntermediate', configuratorAddress)) as ConfiguratorIntermediate;
  await intermediate.connect(governor).migrateAssetConfig([cometAddress]);

  // Step 2: final Configurator
  const configuratorImplementation = await (await ethers.getContractFactory('Configurator')).deploy();
  await configuratorAdmin.connect(configuratorAdminSigner).upgrade(configuratorAddress, configuratorImplementation.address);
  const configurator = (await ethers.getContractAt('Configurator', configuratorAddress)) as Configurator;

  const oldAssetConfigsStorageAfter = await readOldAssetConfigsStorage(configuratorAddress, cometAddress, numAssets);
  const configurationAfterMigration = await configurator.getConfiguration(cometAddress);
  const assetConfigsAfterMigration = await configurator.getAssetConfigs(cometAddress);

  const assetListFactory = (await (await ethers.getContractFactory('AssetListFactory')).deploy(configuratorAddress)) as AssetListFactory;
  await configurator.connect(governor).setAssetListFactory(cometAddress, assetListFactory.address);

  // Step 3: the market's first asset list. deployAssetList only redeploys an existing list, so the first
  // implementation comes straight from the factory
  const immutableConfigs = await configurator.getImmutableAssetConfig(cometAddress);
  const assetListImplementation = await assetListFactory.callStatic.createAssetList(immutableConfigs);
  await assetListFactory.createAssetList(immutableConfigs);
  const assetListInterface = (await ethers.getContractFactory('AssetList')).interface;
  const assetListProxy = await (await ethers.getContractFactory('TransparentUpgradeableProxy')).deploy(
    assetListImplementation,
    cometProxyAdmin.address,
    assetListInterface.encodeFunctionData('initialize', [await configurator.getStorageAssetConfig(cometAddress)])
  );
  // setConfiguration sets the list proxy once, for a market that has none yet
  await configurator
    .connect(governor)
    .setConfiguration(cometAddress, { ...configurationAfterMigration, assetList: assetListProxy.address });

  return {
    v1Configuration,
    oldAssetConfigsStorageBefore,
    oldAssetConfigsStorageAfter,
    configurationAfterMigration,
    assetConfigsAfterMigration,
    versionBefore,
    governorBefore,
    factoryBefore,
    configuratorAdmin,
    configuratorImplementation: configuratorImplementation.address,
    assetListFactory,
    assetList: (await ethers.getContractAt('AssetList', assetListProxy.address)) as AssetList,
  };
}
