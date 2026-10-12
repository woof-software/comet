import { ethers } from 'hardhat';
import { Contract } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import {
  AssetList,
  AssetList__factory,
  AssetListFactory,
  CometFactoryWithExtendedAssetList,
  CometInterface,
  CometProxyAdmin,
  Configurator,
  FaucetToken,
  MarketAdminPermissionChecker,
} from '../../build/types';
import { ImmutableAssetConfigStruct, StorageAssetConfigStruct } from '../../build/types/AssetList';
import { AssetConfigStruct } from '../../build/types/Configurator';
import { impersonateAccount, setBalance } from '../helpers/network-helpers';

export const MAX_ASSETS = 24;
export const PRICE_FEED_DECIMALS = 8;
export const MAX_ASSET_DECIMALS = 19;
export const TYPEHASH = ethers.utils.id('ImmutableConfig[](address asset,uint8 decimals,address priceFeed)');

// Decimals of the fixture assets, in the order they are listed. They cover both ends of the allowed range:
// 0 decimals (scale 1) and MAX_ASSET_DECIMALS.
export const ASSET_DECIMALS = [18, 8, 6, 0, MAX_ASSET_DECIMALS];

// What every fixture asset is initialized with; the supply cap is in whole tokens.
export const BORROW_CF = 75n * 10n ** 16n;
export const LIQUIDATE_CF = 80n * 10n ** 16n;
export const LIQUIDATION_FACTOR = 90n * 10n ** 16n;
export const SUPPLY_CAP = 1_000_000n;

export type AssetListFixture = {
  governor: SignerWithAddress; // owns the proxy admin, governs the Configurator and the Comet
  pauseGuardian: SignerWithAddress;
  marketAdmin: SignerWithAddress; // holds its role only in the market admin variant of the fixture
  users: SignerWithAddress[]; // hold no role
  AssetListContractFactory: AssetList__factory;
  assetListImplementation: AssetList; // built from `configs`, not initialized
  assetList: AssetList; // proxy, initialized with `storageConfigs` and `configurator`
  configs: ImmutableAssetConfigStruct[]; // one per ASSET_DECIMALS entry
  storageConfigs: StorageAssetConfigStruct[]; // in the order of `configs`
  assetListFactory: AssetListFactory;
  proxyAdmin: CometProxyAdmin; // admin of the Configurator, Comet and asset list proxies
  configurator: Configurator; // proxy
  cometFactory: CometFactoryWithExtendedAssetList;
  comet: CometInterface; // proxy
  baseToken: FaucetToken;
  permissionChecker?: MarketAdminPermissionChecker; // only in the market admin variant
};

async function deploy<T extends Contract>(name: string, ...args: unknown[]): Promise<T> {
  return (await (await ethers.getContractFactory(name)).deploy(...args)).deployed() as Promise<T>;
}

// Deploys a token and a price feed, and returns the immutable asset config that lists them.
export async function deployImmutableAssetConfig(
  decimals: number,
  priceFeedDecimals = PRICE_FEED_DECIMALS
): Promise<ImmutableAssetConfigStruct> {
  const token = await deploy('FaucetToken', 0, 'Asset', decimals, 'ASSET');
  const priceFeed = await deploy('SimplePriceFeed', 10n ** BigInt(priceFeedDecimals), priceFeedDecimals);
  return { asset: token.address, decimals, priceFeed: priceFeed.address };
}

// A new token and price feed with the fixture factors and supply cap: a full asset config, as the Configurator
// stores it.
export async function deployAssetConfig(decimals = 18, overrides: Partial<AssetConfigStruct> = {}): Promise<AssetConfigStruct> {
  return {
    ...(await deployImmutableAssetConfig(decimals)),
    borrowCollateralFactor: BORROW_CF,
    liquidateCollateralFactor: LIQUIDATE_CF,
    liquidationFactor: LIQUIDATION_FACTOR,
    supplyCap: SUPPLY_CAP * 10n ** BigInt(decimals),
    ...overrides,
  };
}

// A signer for a contract address, funded to pay for gas.
export async function impersonate(address: string): Promise<SignerWithAddress> {
  await impersonateAccount(address);
  await setBalance(address, 10n ** 18n);
  return ethers.getSigner(address);
}

// One immutable asset config per entry of `decimalsList`, in the same order.
export async function deployImmutableAssetConfigs(decimalsList: number[]): Promise<ImmutableAssetConfigStruct[]> {
  const configs: ImmutableAssetConfigStruct[] = [];
  for (const decimals of decimalsList) configs.push(await deployImmutableAssetConfig(decimals));
  return configs;
}

// ConfigHash.hashConfig(TYPEHASH, abi.encode(configs)), computed off-chain.
export function hashConfig(configs: ImmutableAssetConfigStruct[]): string {
  const encoded = ethers.utils.defaultAbiCoder.encode(
    ['tuple(address asset, uint8 decimals, address priceFeed)[]'],
    [configs]
  );
  return ethers.utils.keccak256(ethers.utils.hexConcat([TYPEHASH, encoded]));
}

// Deploys a proxy of an AssetList implementation, initialized through the proxy constructor data.
export async function deployAssetListProxy(
  implementation: AssetList,
  admin: string,
  storageConfigs: StorageAssetConfigStruct[],
  configurator: string
): Promise<AssetList> {
  const proxy = await deploy(
    'TransparentUpgradeableProxy',
    implementation.address,
    admin,
    implementation.interface.encodeFunctionData('initialize', [storageConfigs, configurator])
  );
  return implementation.attach(proxy.address);
}

// A complete market: a Comet reading one asset per ASSET_DECIMALS entry from an AssetList proxy. The Configurator
// holds the same configuration, so deploying a new Comet through the proxy admin changes nothing.
// With `withMarketAdmin`, the Configurator and the proxy admin are the Optimism variants, which let the market
// admin of a MarketAdminPermissionChecker in.
export async function deployAssetListFixture(withMarketAdmin = false): Promise<AssetListFixture> {
  const [governor, pauseGuardian, marketAdmin, ...users] = await ethers.getSigners();
  const variant = withMarketAdmin ? 'Optimism' : '';
  const deployProxy = async (name: string, implementation: Contract, initializer: string, args: unknown[] = []) =>
    (await deploy(
      name,
      implementation.address,
      proxyAdmin.address,
      implementation.interface.encodeFunctionData(initializer, args)
    )).address;

  const proxyAdmin = await deploy<CometProxyAdmin>(`CometProxyAdmin${variant}`, governor.address);
  const configuratorImplementation = await deploy<Configurator>(`Configurator${variant}`);
  const configurator = configuratorImplementation.attach(
    await deployProxy('ConfiguratorProxy', configuratorImplementation, 'initialize', [governor.address])
  );

  const AssetListContractFactory = (await ethers.getContractFactory('AssetList')) as AssetList__factory;
  const configs = await deployImmutableAssetConfigs(ASSET_DECIMALS);
  const storageConfigs = ASSET_DECIMALS.map((decimals) => ({
    borrowCollateralFactor: BORROW_CF,
    liquidateCollateralFactor: LIQUIDATE_CF,
    liquidationFactor: LIQUIDATION_FACTOR,
    supplyCap: SUPPLY_CAP * 10n ** BigInt(decimals),
  }));
  const assetListImplementation = await AssetListContractFactory.deploy(configs);
  const assetList = await deployAssetListProxy(
    assetListImplementation,
    proxyAdmin.address,
    storageConfigs,
    configurator.address
  );

  const assetListFactory = await deploy<AssetListFactory>('AssetListFactory');
  const cometFactory = await deploy<CometFactoryWithExtendedAssetList>('CometFactoryWithExtendedAssetList');
  const baseToken = await deploy<FaucetToken>('FaucetToken', 0, 'USDC', 6, 'USDC');
  const configuration = {
    governor: governor.address,
    pauseGuardian: pauseGuardian.address,
    baseToken: baseToken.address,
    baseTokenPriceFeed: (await deploy('SimplePriceFeed', 10n ** 8n, PRICE_FEED_DECIMALS)).address,
    extensionDelegate: (await deploy(
      'CometExtAssetList',
      { name32: ethers.utils.formatBytes32String('Comet'), symbol32: ethers.utils.formatBytes32String('BASE') },
      assetListFactory.address
    )).address,
    supplyKink: 8n * 10n ** 17n,
    supplyPerYearInterestRateSlopeLow: 5n * 10n ** 16n,
    supplyPerYearInterestRateSlopeHigh: 2n * 10n ** 18n,
    supplyPerYearInterestRateBase: 0,
    borrowKink: 8n * 10n ** 17n,
    borrowPerYearInterestRateSlopeLow: 10n ** 17n,
    borrowPerYearInterestRateSlopeHigh: 3n * 10n ** 18n,
    borrowPerYearInterestRateBase: 5n * 10n ** 15n,
    storeFrontPriceFactor: 10n ** 18n,
    trackingIndexScale: 10n ** 15n,
    baseTrackingSupplySpeed: 10n ** 15n,
    baseTrackingBorrowSpeed: 10n ** 15n,
    baseMinForRewards: 10n ** 6n,
    baseBorrowMin: 10n ** 6n,
    targetReserves: 0,
    assetList: assetList.address,
  };
  const cometImplementation = await deploy('CometWithExtendedAssetList', configuration);
  const comet = (await ethers.getContractAt(
    'CometInterface',
    await deployProxy('TransparentUpgradeableProxy', cometImplementation, 'initializeStorage')
  )) as CometInterface;

  await configurator.setFactory(comet.address, cometFactory.address);
  await configurator.setAssetListFactory(comet.address, assetListFactory.address);
  await configurator.setConfiguration(comet.address, configuration);
  for (let i = 0; i < configs.length; i++) {
    await configurator.addAsset(comet.address, { ...configs[i], ...storageConfigs[i] });
  }

  let permissionChecker: MarketAdminPermissionChecker;
  if (withMarketAdmin) {
    permissionChecker = await deploy('MarketAdminPermissionChecker', governor.address, marketAdmin.address, ethers.constants.AddressZero);
    for (const contract of [configurator, proxyAdmin] as Contract[]) {
      await contract.setMarketAdminPermissionChecker(permissionChecker.address);
    }
  }

  return {
    governor,
    pauseGuardian,
    marketAdmin,
    users,
    AssetListContractFactory,
    assetListImplementation,
    assetList,
    configs,
    storageConfigs,
    assetListFactory,
    proxyAdmin,
    configurator,
    cometFactory,
    comet,
    baseToken,
    permissionChecker,
  };
}
