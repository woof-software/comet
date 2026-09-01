import type { CometConfiguration as CometConfigurationTypes } from '../../build/types/CometWithExtendedAssetList.js';
import type { CometConfiguration as ConfiguratorTypes } from '../../build/types/Configurator.js';
import type { ProtocolConfiguration } from './index.js';
import type { ContractMap } from '../../plugins/deployment_manager/ContractMap.js';
import type { DeploymentManager } from '../../plugins/deployment_manager/DeploymentManager.js';

type AssetConfigStruct = CometConfigurationTypes.AssetConfigStruct;
type ConfigurationStruct = ConfiguratorTypes.ConfigurationStruct;

function address(a: string): string {
  if (!a.match(/^0x[a-fA-F0-9]{40}$/)) {
    throw new Error(`expected address, got \`${a}\``);
  }
  return a;
}

function floor(n: number): bigint {
  return BigInt(Math.floor(n));
}

function number(n: number): bigint {
  return floor(Number(n));
}

function percentage(n: number, checkRange: boolean = true): bigint {
  if (checkRange) {
    if (n > 1.0) {
      throw new Error(`percentage greater than 100% [received=${n}]`);
    } else if (n < 0) {
      throw new Error(`percentage less than 0% [received=${n}]`);
    }
  }
  return floor(n * 1e18);
}

// Note: Expects a string in scientific notation format (e.g. 1000e18 or 1_000e18)
function stringToBigInt(x: ScientificNotation) {
  if (typeof x !== 'string') {
    throw new Error(`expected argument to be string, got ${x}`);
  }
  const sanitizedInput = x.replace(/_/g, '');
  if (!sanitizedInput.match(/^[0-9]+([.][0-9]+)?e[0-9]+$/)) {
    throw new Error(`expected string in scientific notation form, got ${x}`);
  }

  const nums = sanitizedInput.split('e');
  const coefficient = Number(nums[0]);
  const exponent = Number(nums[1]);
  // If exponent is a decimal, then just convert it directly using `number()`.
  // Note: This does mean we could lose some precision when using a decimal coefficient
  if (!Number.isInteger(coefficient)) {
    return number(Number(sanitizedInput));
  } else {
    return BigInt(coefficient) * 10n ** BigInt(exponent);
  }
}

type ScientificNotation = string;

interface NetworkRateConfiguration {
  supplyKink: number;
  supplySlopeLow: number;
  supplySlopeHigh: number;
  supplyBase: number;
  borrowKink: number;
  borrowSlopeLow: number;
  borrowSlopeHigh: number;
  borrowBase: number;
}

interface NetworkTrackingConfiguration {
  indexScale: ScientificNotation;
  baseSupplySpeed: ScientificNotation;
  baseBorrowSpeed: ScientificNotation;
  baseMinForRewards: ScientificNotation;
}

interface NetworkAssetConfiguration {
  address?: string;
  priceFeed: string;
  decimals: number;
  borrowCF: number;
  liquidateCF: number;
  liquidationFactor: number;
  supplyCap: ScientificNotation;
}

export interface NetworkConfiguration {
  name: string;
  symbol: string;
  governor?: string;
  pauseGuardian?: string;
  baseToken: string;
  baseTokenAddress?: string;
  baseTokenPriceFeed: string;
  borrowMin: ScientificNotation;
  storeFrontPriceFactor: number;
  targetReserves: ScientificNotation;
  rates: NetworkRateConfiguration;
  tracking: NetworkTrackingConfiguration;
  assets: { [name: string]: NetworkAssetConfiguration };
  rewardToken?: string;
  rewardTokenAddress?: string;
}

async function getContractAddress(
  contractName: string,
  contracts: ContractMap,
  fallbackAddress?: string
): Promise<string> {
  const contract = contracts.get(contractName);
  if (!contract) {
    if (fallbackAddress) return fallbackAddress;
    throw new Error(
      `Cannot find contract \`${contractName}\` in contract map with keys \`${JSON.stringify(
        [...contracts.keys()]
      )}\``
    );
  }
  return contract.getAddress();
}

async function getAssetConfigs(
  assets: { [name: string]: NetworkAssetConfiguration },
  contracts: ContractMap
): Promise<AssetConfigStruct[]> {
  return Promise.all(
    Object.entries(assets).map(async ([assetName, assetConfig]) => ({
      asset: await getContractAddress(
        assetName,
        contracts,
        assetConfig.address
      ),
      priceFeed: await getContractAddress(
        `${assetName}:priceFeed`,
        contracts,
        assetConfig.priceFeed
      ),
      decimals: number(assetConfig.decimals),
      borrowCollateralFactor: percentage(assetConfig.borrowCF),
      liquidateCollateralFactor: percentage(assetConfig.liquidateCF),
      liquidationFactor: percentage(assetConfig.liquidationFactor),
      supplyCap: stringToBigInt(assetConfig.supplyCap),
    }))
  );
}

async function getOverridesOrConfig(
  overrides: ProtocolConfiguration,
  config: NetworkConfiguration,
  contracts: ContractMap
): Promise<ProtocolConfiguration> {
  let timelockAddress: string | undefined;
  const getTimelockAddress = async () =>
    (timelockAddress ??= await getContractAddress('timelock', contracts));

  return {
    name: overrides.name ?? config.name,
    symbol: overrides.symbol ?? config.symbol,
    governor:
      overrides.governor ??
      (config.governor ? address(config.governor) : await getTimelockAddress()),
    pauseGuardian:
      overrides.pauseGuardian ??
      (config.pauseGuardian
        ? address(config.pauseGuardian)
        : await getTimelockAddress()),
    baseToken:
      overrides.baseToken ??
      (await getContractAddress(
        config.baseToken,
        contracts,
        config.baseTokenAddress
      )),
    baseTokenPriceFeed:
      overrides.baseTokenPriceFeed ??
      (await getContractAddress(
        `${config.baseToken}:priceFeed`,
        contracts,
        config.baseTokenPriceFeed
      )),
    baseBorrowMin: overrides.baseBorrowMin ?? stringToBigInt(config.borrowMin),
    storeFrontPriceFactor:
      overrides.storeFrontPriceFactor ??
      percentage(config.storeFrontPriceFactor),
    targetReserves:
      overrides.targetReserves ?? stringToBigInt(config.targetReserves),
    supplyKink: overrides.supplyKink ?? percentage(config.rates.supplyKink),
    supplyPerYearInterestRateSlopeLow:
      overrides.supplyPerYearInterestRateSlopeLow ??
      percentage(config.rates.supplySlopeLow),
    supplyPerYearInterestRateSlopeHigh:
      overrides.supplyPerYearInterestRateSlopeHigh ??
      percentage(config.rates.supplySlopeHigh, false),
    supplyPerYearInterestRateBase:
      overrides.supplyPerYearInterestRateBase ??
      percentage(config.rates.supplyBase),
    borrowKink: overrides.borrowKink ?? percentage(config.rates.borrowKink),
    borrowPerYearInterestRateSlopeLow:
      overrides.borrowPerYearInterestRateSlopeLow ??
      percentage(config.rates.borrowSlopeLow),
    borrowPerYearInterestRateSlopeHigh:
      overrides.borrowPerYearInterestRateSlopeHigh ??
      percentage(config.rates.borrowSlopeHigh, false),
    borrowPerYearInterestRateBase:
      overrides.borrowPerYearInterestRateBase ??
      percentage(config.rates.borrowBase),
    trackingIndexScale:
      overrides.trackingIndexScale ??
      stringToBigInt(config.tracking.indexScale),
    baseTrackingSupplySpeed:
      overrides.baseTrackingSupplySpeed ??
      stringToBigInt(config.tracking.baseSupplySpeed),
    baseTrackingBorrowSpeed:
      overrides.baseTrackingBorrowSpeed ??
      stringToBigInt(config.tracking.baseBorrowSpeed),
    baseMinForRewards:
      overrides.baseMinForRewards ??
      stringToBigInt(config.tracking.baseMinForRewards),
    assetConfigs:
      overrides.assetConfigs ??
      (await getAssetConfigs(config.assets, contracts)),
    rewardTokenAddress:
      overrides.rewardTokenAddress ??
      (config.rewardToken !== undefined
        ? await getContractAddress(
          config.rewardToken,
          contracts,
          config.rewardTokenAddress
        )
        : config.rewardTokenAddress),
  };
}

export async function getConfiguration(
  deploymentManager: DeploymentManager,
  configOverrides: ProtocolConfiguration = {}
): Promise<ProtocolConfiguration> {
  const config = await deploymentManager.readConfig<NetworkConfiguration>();
  const contracts = await deploymentManager.contracts();
  return getOverridesOrConfig(configOverrides, config, contracts);
}

export async function getConfigurationStruct(
  deploymentManager: DeploymentManager,
  configOverrides: ProtocolConfiguration = {}
): Promise<ConfigurationStruct> {
  const contracts = await deploymentManager.contracts();
  const configuration = (await getConfiguration(
    deploymentManager,
    configOverrides
  )) as ConfigurationStruct;
  const extensionDelegate =
    configOverrides.extensionDelegate ??
    (await getContractAddress(
      'comet:implementation:implementation',
      contracts
    ));
  return { ...configuration, extensionDelegate };
}
