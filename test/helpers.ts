import hre from 'hardhat';
import { expect } from 'chai';
import { EventLog, ZeroAddress, encodeBytes32String } from 'ethers';
import type { Block, TransactionReceipt, TransactionResponse } from 'ethers';
import type { HardhatEthersSigner as SignerWithAddress } from '@nomicfoundation/hardhat-ethers/types';
import {
  BaseBulker__factory,
  CometExtAssetList__factory,
  CometRewards__factory,
  EvilToken__factory,
  FaucetToken__factory,
  FaucetWETH__factory,
  SimplePriceFeed__factory,
  TransparentUpgradeableProxy__factory,
  ConfiguratorProxy__factory,
  CometProxyAdmin__factory,
  CometFactoryWithExtendedAssetList__factory,
  Configurator__factory,
  NonStandardFaucetFeeToken__factory,
  AssetListFactory__factory,
  CometHarnessExtendedAssetList__factory,
  MarketAdminPermissionChecker__factory,
} from '../build/types/index.js';
import type {
  AssetListFactory,
  BaseBulker,
  CometExtAssetList,
  CometFactoryWithExtendedAssetList,
  CometHarnessInterfaceExtendedAssetList,
  CometHarnessInterfaceExtendedAssetList as Comet,
  CometHarnessInterfaceExtendedAssetList as CometWithExtendedAssetList,
  CometInterface,
  CometProxyAdmin,
  CometRewards,
  Configurator,
  ConfiguratorProxy,
  FaucetToken,
  MarketAdminPermissionChecker,
  NonStandardFaucetFeeToken,
  SimplePriceFeed,
  TransparentUpgradeableProxy,
} from '../build/types/index.js';
import type { CometStorage } from '../build/types/test/CometHarnessExtendedAssetList.js';

type TotalsBasicStructOutput = CometStorage.TotalsBasicStructOutput;
type TotalsCollateralStructOutput = CometStorage.TotalsCollateralStructOutput;

const { ethers } = await hre.network.getOrCreate();

export type { Comet };
export { ethers, expect, hre };

export type Numeric = number | bigint;

export enum ReentryAttack {
  TransferFrom = 0,
  WithdrawFrom = 1,
  SupplyFrom = 2,
  BuyCollateral = 3,
}

export type ProtocolOpts = {
  start?: number;
  assets?: {
    [symbol: string]: {
      name?: string;
      initial?: Numeric;
      decimals?: Numeric;
      borrowCF?: Numeric;
      liquidateCF?: Numeric;
      liquidationFactor?: Numeric;
      supplyCap?: Numeric;
      initialPrice?: number;
      priceFeedDecimals?: number;
      factory?: FaucetToken__factory | EvilToken__factory | FaucetWETH__factory | NonStandardFaucetFeeToken__factory;
    };
  };
  name?: string;
  symbol?: string;
  governor?: SignerWithAddress;
  pauseGuardian?: SignerWithAddress;
  extensionDelegateAssetList?: CometExtAssetList;
  base?: string;
  reward?: string;
  supplyKink?: Numeric;
  supplyInterestRateBase?: Numeric;
  supplyInterestRateSlopeLow?: Numeric;
  supplyInterestRateSlopeHigh?: Numeric;
  borrowKink?: Numeric;
  borrowInterestRateBase?: Numeric;
  borrowInterestRateSlopeLow?: Numeric;
  borrowInterestRateSlopeHigh?: Numeric;
  storeFrontPriceFactor?: Numeric;
  trackingIndexScale?: Numeric;
  baseTrackingSupplySpeed?: Numeric;
  baseTrackingBorrowSpeed?: Numeric;
  baseMinForRewards?: Numeric;
  baseBorrowMin?: Numeric;
  targetReserves?: Numeric;
  baseTokenBalance?: Numeric;
  marketAdminPermissionCheckerContract?: MarketAdminPermissionChecker;
};

export type Protocol = {
  opts: ProtocolOpts;
  governor: SignerWithAddress;
  pauseGuardian: SignerWithAddress;
  extensionDelegateAssetList: CometExtAssetList;
  users: SignerWithAddress[];
  base: string;
  reward: string;
  cometWithExtendedAssetList: CometWithExtendedAssetList;
  assetListFactory: AssetListFactory;
  tokens: {
    [symbol: string]: FaucetToken | NonStandardFaucetFeeToken;
  };
  unsupportedToken: FaucetToken;
  priceFeeds: {
    [symbol: string]: SimplePriceFeed;
  };
};

export type ConfiguratorAndProtocol = {
  configurator: Configurator;
  configuratorProxy: ConfiguratorProxy;
  proxyAdmin: CometProxyAdmin;
  cometFactoryWithExtendedAssetList: CometFactoryWithExtendedAssetList;
  cometProxyWithExtendedAssetList: TransparentUpgradeableProxy;
} & Protocol;

export type RewardsOpts = {
  governor?: SignerWithAddress;
  configs?: [Comet, FaucetToken | NonStandardFaucetFeeToken, Numeric?][];
};

export type Rewards = {
  opts: RewardsOpts;
  governor: SignerWithAddress;
  rewards: CometRewards;
};

export type BulkerOpts = {
  admin?: SignerWithAddress;
  weth?: string;
};

export type BulkerInfo = {
  opts: BulkerOpts;
  bulker: BaseBulker;
};

export function dfn<T>(x: T | undefined | null, dflt: T): T {
  return x == undefined ? dflt : x;
}

export function exp(i: number, d: Numeric = 0, r: Numeric = 6): bigint {
  const sign = i < 0 ? -1n : 1n;
  const parts = Math.abs(i).toString().split('.');
  const intPart = parts[0];
  const fracPart = (parts[1] || '').padEnd(Number(r), '0').slice(0, Number(r));
  const scaled = BigInt(intPart + fracPart);
  return sign * (scaled * 10n ** BigInt(d)) / 10n ** BigInt(r);
}

export function factor(f: number): bigint {
  return exp(f, factorDecimals);
}

export function defactor(f: bigint): number {
  return Number(f) / 1e18;
}

// Truncates a factor to a certain number of decimals
export function truncateDecimals(factor: bigint, decimals = 4) {
  const descaleFactor = factorScale / exp(1, decimals);
  return factor / descaleFactor * descaleFactor;
}

export function mulPrice(n: bigint, price: bigint, fromScale: bigint): bigint {
  return n * price / fromScale;
}

export function annualize(n: bigint, secondsPerYear = 31536000n): number {
  return defactor(n * secondsPerYear);
}

export function toYears(seconds: number, secondsPerYear = 31536000): number {
  return seconds / secondsPerYear;
}

export function defaultAssets(overrides = {}, perAssetOverrides = {}) {
  return {
    COMP: Object.assign({
      initial: 1e7,
      decimals: 18,
      initialPrice: 175,
    }, overrides, perAssetOverrides['COMP'] || {}),
    USDC: Object.assign({
      initial: 1e6,
      decimals: 6,
    }, overrides, perAssetOverrides['USDC'] || {}),
    WETH: Object.assign({
      initial: 1e4,
      decimals: 18,
      initialPrice: 3000,
    }, overrides, perAssetOverrides['WETH'] || {}),
    WBTC: Object.assign({
      initial: 1e3,
      decimals: 8,
      initialPrice: 41000,
    }, overrides, perAssetOverrides['WBTC'] || {}),
  };
}

export const factorDecimals = 18;
export const factorScale = factor(1);
export const ONE = factorScale;
export const ZERO = factor(0);

export async function getBlock(n?: number, ethers_ = ethers): Promise<Block> {
  const blockNumber = n == undefined ? await ethers_.provider.getBlockNumber() : n;
  const block = await ethers_.provider.getBlock(blockNumber);
  if (block === null) {
    throw new Error(`Block ${blockNumber} was not found`);
  }
  return block;
}

export async function fastForward(seconds: number, ethers_ = ethers): Promise<Block> {
  const block = await getBlock();
  await ethers_.provider.send('evm_setNextBlockTimestamp', [block.timestamp + seconds]);
  return block;
}

export async function makeProtocol(opts: ProtocolOpts = {}): Promise<Protocol> {
  const signers = await ethers.getSigners();

  const assets = opts.assets || defaultAssets();
  let priceFeeds = {};
  const PriceFeedFactory = new SimplePriceFeed__factory(signers[0]);
  for (const asset in assets) {
    const initialPrice = exp(assets[asset].initialPrice || 1, 8);
    const priceFeedDecimals = assets[asset].priceFeedDecimals || 8;
    const priceFeed = await PriceFeedFactory.deploy(initialPrice, priceFeedDecimals);
    await priceFeed.waitForDeployment();
    priceFeeds[asset] = priceFeed;
  }

  const name32 = encodeBytes32String((opts.name || 'Compound Comet'));
  const symbol32 = encodeBytes32String((opts.symbol || '📈BASE'));
  const governor = opts.governor || signers[0];
  const pauseGuardian = opts.pauseGuardian || signers[1];
  const users = signers.slice(2); // guaranteed to not be governor or pause guardian
  const base = opts.base || 'USDC';
  const reward = opts.reward || 'COMP';
  const supplyKink = dfn(opts.supplyKink, exp(0.8, 18));
  const supplyPerYearInterestRateBase = dfn(opts.supplyInterestRateBase, exp(0.0, 18));
  const supplyPerYearInterestRateSlopeLow = dfn(opts.supplyInterestRateSlopeLow, exp(0.05, 18));
  const supplyPerYearInterestRateSlopeHigh = dfn(opts.supplyInterestRateSlopeHigh, exp(2, 18));
  const borrowKink = dfn(opts.borrowKink, exp(0.8, 18));
  const borrowPerYearInterestRateBase = dfn(opts.borrowInterestRateBase, exp(0.005, 18));
  const borrowPerYearInterestRateSlopeLow = dfn(opts.borrowInterestRateSlopeLow, exp(0.1, 18));
  const borrowPerYearInterestRateSlopeHigh = dfn(opts.borrowInterestRateSlopeHigh, exp(3, 18));
  const storeFrontPriceFactor = dfn(opts.storeFrontPriceFactor, ONE);
  const trackingIndexScale = opts.trackingIndexScale || exp(1, 15);
  const baseTrackingSupplySpeed = dfn(opts.baseTrackingSupplySpeed, trackingIndexScale);
  const baseTrackingBorrowSpeed = dfn(opts.baseTrackingBorrowSpeed, trackingIndexScale);
  const baseMinForRewards = dfn(opts.baseMinForRewards, exp(1, assets[base].decimals));
  const baseBorrowMin = dfn(opts.baseBorrowMin, exp(1, assets[base].decimals));
  const targetReserves = dfn(opts.targetReserves, 0);

  const FaucetFactory = new FaucetToken__factory(signers[0]);
  const tokens = {};
  for (const symbol in assets) {
    const config = assets[symbol];
    const decimals = config.decimals || 18;
    const initial = config.initial || 1e6;
    const name = config.name || symbol;
    const factory = config.factory || FaucetFactory;
    let token;
    token = (tokens[symbol] = await factory.deploy(initial, name, decimals, symbol));
    await token.waitForDeployment();
  }

  const unsupportedToken = await FaucetFactory.deploy(1e6, 'Unsupported Token', 6, 'USUP');
  await unsupportedToken.waitForDeployment();

  const AssetListFactory = new AssetListFactory__factory(signers[0]);
  const assetListFactory = await AssetListFactory.deploy();
  await assetListFactory.waitForDeployment();

  let extensionDelegateAssetList = opts.extensionDelegateAssetList;
  if (extensionDelegateAssetList === undefined) {
    const CometExtFactory = new CometExtAssetList__factory(signers[0]);
    extensionDelegateAssetList = await CometExtFactory.deploy(
      { name32, symbol32 },
      await assetListFactory.getAddress()
    );
    await extensionDelegateAssetList.waitForDeployment();
  }

  const assetConfigs = [];
  for (const [symbol, assetConfig] of Object.entries(assets)) {
    if (symbol !== base) {
      assetConfigs.push({
        asset: await tokens[symbol].getAddress(),
        priceFeed: await priceFeeds[symbol].getAddress(),
        decimals: dfn(assets[symbol].decimals, 18),
        borrowCollateralFactor: dfn(assetConfig.borrowCF, ONE - 1n),
        liquidateCollateralFactor: dfn(assetConfig.liquidateCF, ONE),
        liquidationFactor: dfn(assetConfig.liquidationFactor, ONE),
        supplyCap: dfn(assetConfig.supplyCap, exp(100, dfn(assetConfig.decimals, 18))),
      });
    }
  }

  const config = {
    governor: governor.address,
    pauseGuardian: pauseGuardian.address,
    extensionDelegate: await extensionDelegateAssetList.getAddress(),
    baseToken: await tokens[base].getAddress(),
    baseTokenPriceFeed: await priceFeeds[base].getAddress(),
    supplyKink,
    supplyPerYearInterestRateBase,
    supplyPerYearInterestRateSlopeLow,
    supplyPerYearInterestRateSlopeHigh,
    borrowKink,
    borrowPerYearInterestRateBase,
    borrowPerYearInterestRateSlopeLow,
    borrowPerYearInterestRateSlopeHigh,
    storeFrontPriceFactor,
    trackingIndexScale,
    baseTrackingSupplySpeed,
    baseTrackingBorrowSpeed,
    baseMinForRewards,
    baseBorrowMin,
    targetReserves,
    assetConfigs,
  };
  const CometFactoryWithExtendedAssetList = new CometHarnessExtendedAssetList__factory(signers[0]);

  const cometWithExtendedAssetList = await CometFactoryWithExtendedAssetList.deploy(config);
  await cometWithExtendedAssetList.waitForDeployment();

  if (opts.start) await ethers.provider.send('evm_setNextBlockTimestamp', [opts.start]);
  await cometWithExtendedAssetList.initializeStorage();

  const baseTokenBalance = opts.baseTokenBalance;
  if (baseTokenBalance) {
    const baseToken = tokens[base];
    await wait(baseToken.allocateTo(await cometWithExtendedAssetList.getAddress(), baseTokenBalance));
  }

  return {
    opts,
    governor,
    pauseGuardian,
    extensionDelegateAssetList: extensionDelegateAssetList as CometExtAssetList,
    users,
    base,
    reward,
    cometWithExtendedAssetList: await ethers.getContractAt(
      'CometHarnessInterfaceExtendedAssetList',
      await cometWithExtendedAssetList.getAddress()
    ) as unknown as CometWithExtendedAssetList,
    assetListFactory: assetListFactory,
    tokens,
    unsupportedToken,
    priceFeeds,
  };
}

export async function getConfigurationForConfigurator(
  opts: ProtocolOpts,
  cometWithExtendedAssetList: CometHarnessInterfaceExtendedAssetList,
  governor: SignerWithAddress,
  pauseGuardian: SignerWithAddress,
  extensionDelegateAssetList: CometExtAssetList,
  tokens: {
    [p: string]: FaucetToken | NonStandardFaucetFeeToken;
  },
  base: string,
  priceFeeds: { [p: string]: SimplePriceFeed }) {

  const assets = opts.assets || defaultAssets();

  // Derive the rest of the Configurator configuration values
  const supplyKink = dfn(opts.supplyKink, exp(0.8, 18));
  const supplyPerYearInterestRateBase = dfn(opts.supplyInterestRateBase, exp(0.0, 18));
  const supplyPerYearInterestRateSlopeLow = dfn(opts.supplyInterestRateSlopeLow, exp(0.05, 18));
  const supplyPerYearInterestRateSlopeHigh = dfn(opts.supplyInterestRateSlopeHigh, exp(2, 18));
  const borrowKink = dfn(opts.borrowKink, exp(0.8, 18));
  const borrowPerYearInterestRateBase = dfn(opts.borrowInterestRateBase, exp(0.005, 18));
  const borrowPerYearInterestRateSlopeLow = dfn(opts.borrowInterestRateSlopeLow, exp(0.1, 18));
  const borrowPerYearInterestRateSlopeHigh = dfn(opts.borrowInterestRateSlopeHigh, exp(3, 18));
  const storeFrontPriceFactor = await cometWithExtendedAssetList.storeFrontPriceFactor();
  const trackingIndexScale = await cometWithExtendedAssetList.trackingIndexScale();
  const baseTrackingSupplySpeed = await cometWithExtendedAssetList.baseTrackingSupplySpeed();
  const baseTrackingBorrowSpeed = await cometWithExtendedAssetList.baseTrackingBorrowSpeed();
  const baseMinForRewards = await cometWithExtendedAssetList.baseMinForRewards();
  const baseBorrowMin = await cometWithExtendedAssetList.baseBorrowMin();
  const targetReserves = await cometWithExtendedAssetList.targetReserves();

  // Deploy CometFactory
  const CometFactoryWithExtendedAssetListFactory = new CometFactoryWithExtendedAssetList__factory(governor);
  const cometFactoryWithExtendedAssetList = await CometFactoryWithExtendedAssetListFactory.deploy();
  await cometFactoryWithExtendedAssetList.waitForDeployment();

  // Deploy Configurator
  const ConfiguratorFactory = new Configurator__factory(governor);
  const configurator = await ConfiguratorFactory.deploy();
  await configurator.waitForDeployment();

  const assetConfigs = [];
  for (const [symbol, assetConfig] of Object.entries(assets)) {
    if (symbol !== base) {
      assetConfigs.push({
        asset: await tokens[symbol].getAddress(),
        priceFeed: await priceFeeds[symbol].getAddress(),
        decimals: dfn(assets[symbol].decimals, 18),
        borrowCollateralFactor: dfn(assetConfig.borrowCF, ONE - 1n),
        liquidateCollateralFactor: dfn(assetConfig.liquidateCF, ONE),
        liquidationFactor: dfn(assetConfig.liquidationFactor, ONE),
        supplyCap: dfn(assetConfig.supplyCap, exp(100, dfn(assetConfig.decimals, 18))),
      });
    }
  }

  const configuration = {
    governor: governor.address,
    pauseGuardian: pauseGuardian.address,
    extensionDelegate: await extensionDelegateAssetList.getAddress(),
    baseToken: await tokens[base].getAddress(),
    baseTokenPriceFeed: await priceFeeds[base].getAddress(),
    supplyKink,
    supplyPerYearInterestRateBase,
    supplyPerYearInterestRateSlopeLow,
    supplyPerYearInterestRateSlopeHigh,
    borrowKink,
    borrowPerYearInterestRateBase,
    borrowPerYearInterestRateSlopeLow,
    borrowPerYearInterestRateSlopeHigh,
    storeFrontPriceFactor,
    trackingIndexScale,
    baseTrackingSupplySpeed,
    baseTrackingBorrowSpeed,
    baseMinForRewards,
    baseBorrowMin,
    targetReserves,
    assetConfigs,
  };
  return configuration;
}

// Only for testing configurator. Non-configurator tests need to deploy the CometHarness instead.
export async function makeConfigurator(opts: ProtocolOpts = {}): Promise<ConfiguratorAndProtocol> {
  const {
    governor,
    pauseGuardian,
    extensionDelegateAssetList,
    users,
    base,
    reward,
    cometWithExtendedAssetList,
    assetListFactory,
    tokens,
    unsupportedToken,
    priceFeeds,
  } = await makeProtocol(opts);

  // Deploy ProxyAdmin
  const ProxyAdmin = new CometProxyAdmin__factory(governor);
  const proxyAdmin = await ProxyAdmin.deploy(governor.address);
  await proxyAdmin.waitForDeployment();

  // Deploy Comet proxy
  const CometProxy = new TransparentUpgradeableProxy__factory(governor);
  const cometProxy = await CometProxy.deploy(
    await cometWithExtendedAssetList.getAddress(),
    await proxyAdmin.getAddress(),
    (await cometWithExtendedAssetList.initializeStorage.populateTransaction()).data,
  );
  await cometProxy.waitForDeployment();
  const configuration = await getConfigurationForConfigurator(
    opts,
    cometWithExtendedAssetList,
    governor,
    pauseGuardian,
    extensionDelegateAssetList,
    tokens,
    base,
    priceFeeds,
  );

  const cometProxyWithExtendedAssetList = await CometProxy.deploy(
    await cometWithExtendedAssetList.getAddress(),
    await proxyAdmin.getAddress(),
    (await cometWithExtendedAssetList.initializeStorage.populateTransaction()).data,
  );
  await cometProxyWithExtendedAssetList.waitForDeployment();

  // Deploy CometFactory
  const CometFactoryWithExtendedAssetListFactory = new CometFactoryWithExtendedAssetList__factory(governor);
  const cometFactoryWithExtendedAssetList = await CometFactoryWithExtendedAssetListFactory.deploy();
  await cometFactoryWithExtendedAssetList.waitForDeployment();

  // Deploy Configurator
  const ConfiguratorFactory = new Configurator__factory(governor);
  const configurator = await ConfiguratorFactory.deploy();
  await configurator.waitForDeployment();

  // Deploy Configurator proxy
  const initializeCalldata = (await configurator.initialize.populateTransaction(governor.address)).data;
  const ConfiguratorProxy = new ConfiguratorProxy__factory(governor);
  const configuratorProxy = await ConfiguratorProxy.deploy(
    await configurator.getAddress(),
    await proxyAdmin.getAddress(),
    initializeCalldata,
  );
  await configuratorProxy.waitForDeployment();

  // Set the initial factory and configuration for Comet in Configurator
  const configuratorAsProxy = Configurator__factory.connect(await configuratorProxy.getAddress(), governor);
  configuration.extensionDelegate = await extensionDelegateAssetList.getAddress();
  await configuratorAsProxy.setConfiguration(await cometProxyWithExtendedAssetList.getAddress(), configuration);
  await configuratorAsProxy.setFactory(
    await cometProxyWithExtendedAssetList.getAddress(),
    await cometFactoryWithExtendedAssetList.getAddress()
  );

  if(opts.marketAdminPermissionCheckerContract) {
    const checkerAddress = await opts.marketAdminPermissionCheckerContract.getAddress();
    await configuratorAsProxy.setMarketAdminPermissionChecker(checkerAddress);
    await proxyAdmin.setMarketAdminPermissionChecker(checkerAddress);
  } else {
    const MarketAdminPermissionCheckerFactory = new MarketAdminPermissionChecker__factory(governor);

    const marketAdminPermissionCheckerContract =  await MarketAdminPermissionCheckerFactory.deploy(
      governor.address,
      ZeroAddress,
      ZeroAddress
    );
    await marketAdminPermissionCheckerContract.waitForDeployment();

    const checkerAddress = await marketAdminPermissionCheckerContract.getAddress();
    await configuratorAsProxy.setMarketAdminPermissionChecker(checkerAddress);
    await proxyAdmin.setMarketAdminPermissionChecker(checkerAddress);
  }

  return {
    opts,
    governor,
    pauseGuardian,
    extensionDelegateAssetList,
    users,
    base,
    reward,
    proxyAdmin,
    cometWithExtendedAssetList,
    assetListFactory,
    cometProxyWithExtendedAssetList,
    configurator,
    configuratorProxy,
    cometFactoryWithExtendedAssetList,
    tokens,
    unsupportedToken,
    priceFeeds,
  };
}

export async function makeRewards(opts: RewardsOpts = {}): Promise<Rewards> {
  const signers = await ethers.getSigners();

  const governor = opts.governor || signers[0];
  const configs = opts.configs || [];

  const RewardsFactory = new CometRewards__factory(governor);
  const rewards = await RewardsFactory.deploy(governor.address);
  await rewards.waitForDeployment();

  for (const [comet, token, multiplier] of configs) {
    const cometAddress = await comet.getAddress();
    const tokenAddress = await token.getAddress();
    if (multiplier === undefined) await wait(rewards.setRewardConfig(cometAddress, tokenAddress));
    else await wait(rewards.setRewardConfigWithMultiplier(cometAddress, tokenAddress, multiplier));
  }

  return {
    opts,
    governor,
    rewards
  };
}

export async function makeBulker(opts: BulkerOpts): Promise<BulkerInfo> {
  const signers = await ethers.getSigners();

  const admin = opts.admin || signers[0];
  const weth = opts.weth;

  const BulkerFactory = new BaseBulker__factory(admin);
  const bulker = await BulkerFactory.deploy(admin.address, weth);
  await bulker.waitForDeployment();

  return {
    opts,
    bulker
  };
}
export async function bumpTotalsCollateral(cometWithExtendedAssetList: CometHarnessInterfaceExtendedAssetList, token: FaucetToken | NonStandardFaucetFeeToken, delta: bigint): Promise<TotalsCollateralStructOutput> {
  const tokenAddress = await token.getAddress();
  const cometAddress = await cometWithExtendedAssetList.getAddress();
  const t0 = await cometWithExtendedAssetList.totalsCollateral(tokenAddress);
  const t1 = Object.assign({}, t0, { totalSupplyAsset: t0.totalSupplyAsset + delta });
  await token.allocateTo(cometAddress, delta);
  await wait(cometWithExtendedAssetList.setTotalsCollateral(tokenAddress, t1));
  return t1;
}

export async function setTotalsBasic(cometWithExtendedAssetList: CometHarnessInterfaceExtendedAssetList, overrides = {}): Promise<TotalsBasicStructOutput> {
  const t0 = await cometWithExtendedAssetList.totalsBasic();
  const t1 = Object.assign({}, t0, overrides);
  await wait(cometWithExtendedAssetList.setTotalsBasic(t1));
  return t1;
}

export function objectify(arrayObject) {
  const obj = {};
  for (const key in arrayObject) {
    if (isNaN(Number(key))) {
      const value = arrayObject[key];
      if (value._isBigNumber) {
        obj[key] = BigInt(value);
      } else {
        obj[key] = value;
      }
    }
  }
  return obj;
}

export async function baseBalanceOf(comet: CometInterface, account: string): Promise<bigint> {
  const balanceOf = await comet.balanceOf(account);
  const borrowBalanceOf = await comet.borrowBalanceOf(account);
  return balanceOf - borrowBalanceOf;
}

type Portfolio = {
  internal: {
    [symbol: string]: bigint;
  };
  external: {
    [symbol: string]: bigint;
  };
}

type TotalsAndReserves = {
  totals: {
    [symbol: string]: bigint;
  };
  reserves: {
    [symbol: string]: bigint;
  };
}

export async function portfolio({ cometWithExtendedAssetList, base, tokens }, account): Promise<Portfolio> {
  const internal = { [base]: await baseBalanceOf(cometWithExtendedAssetList, account) };
  const external = { [base]: BigInt(await tokens[base].balanceOf(account)) };
  for (const symbol in tokens) {
    if (symbol != base) {
      internal[symbol] = BigInt(
        await cometWithExtendedAssetList.collateralBalanceOf(account, await tokens[symbol].getAddress())
      );
      external[symbol] = BigInt(await tokens[symbol].balanceOf(account));
    }
  }
  return { internal, external };
}

export async function totalsAndReserves({ cometWithExtendedAssetList, base, tokens }): Promise<TotalsAndReserves> {
  const totals = { [base]: BigInt((await cometWithExtendedAssetList.totalsBasic()).totalSupplyBase) };
  const reserves = { [base]: BigInt(await cometWithExtendedAssetList.getReserves()) };
  for (const symbol in tokens) {
    if (symbol != base) {
      const tokenAddress = await tokens[symbol].getAddress();
      totals[symbol] = BigInt((await cometWithExtendedAssetList.totalsCollateral(tokenAddress)).totalSupplyAsset);
      reserves[symbol] = BigInt(await cometWithExtendedAssetList.getCollateralReserves(tokenAddress));
    }
  }
  return { totals, reserves };
}

export type TransactionResponseExt = TransactionResponse & { receipt: TransactionReceipt };

export async function wait(
  tx: TransactionResponse | Promise<TransactionResponse>
): Promise<TransactionResponseExt> {
  const tx_ = await tx;
  const receipt = await tx_.wait();
  if (receipt === null) {
    throw new Error(`Transaction ${tx_.hash} was not mined`);
  }
  return Object.assign(tx_, { receipt });
}

export function event(tx, index) {
  const ev = tx.receipt.logs[index];
  if (!(ev instanceof EventLog)) {
    throw new Error(`Log ${index} is not a parsed contract event`);
  }
  const args = {};
  for (const k in ev.args) {
    const v = ev.args[k];
    if (isNaN(Number(k))) {
      if (v._isBigNumber) {
        args[k] = BigInt(v);
      } else if (Array.isArray(v)) {
        args[k] = convertToBigInt(v);
      } else {
        args[k] = v;
      }
    }
  }
  return { [ev.eventName]: args };
}

// Convert all BigNumbers in an array into BigInts
function convertToBigInt(arr) {
  const newArr = [];
  for (const v of arr) {
    if (Array.isArray(v)) {
      newArr.push(convertToBigInt(v));
    } else {
      newArr.push(v._isBigNumber ? BigInt(v) : v);
    }
  }
  return newArr;
}

export function getGasUsed(tx: TransactionResponseExt): bigint {
  return tx.receipt.gasUsed * tx.receipt.gasPrice;
}
