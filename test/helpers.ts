import hre from 'hardhat';
import { ethers } from 'hardhat';
import { expect } from 'chai';
import { Block } from '@ethersproject/abstract-provider';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import {
  BaseBulker,
  BaseBulker__factory,
  CometExt,
  CometExtAssetList,
  CometExtAssetList__factory,
  CometRewards,
  CometRewards__factory,
  EvilToken__factory,
  FaucetToken,
  FaucetToken__factory,
  FaucetWETH__factory,
  SimplePriceFeed,
  SimplePriceFeed__factory,
  TransparentUpgradeableProxy,
  TransparentUpgradeableProxy__factory,
  ConfiguratorProxy,
  ConfiguratorProxy__factory,
  CometProxyAdmin,
  CometProxyAdmin__factory,
  CometFactoryWithExtendedAssetList,
  CometFactoryWithExtendedAssetList__factory,
  Configurator,
  Configurator__factory,
  CometInterface,
  CometMainInterface,
  NonStandardFaucetFeeToken,
  NonStandardFaucetFeeToken__factory,
  AssetListFactory,
  AssetListFactory__factory,
  CometHarnessExtendedAssetList__factory,
  CometHarnessInterfaceExtendedAssetList as CometWithExtendedAssetList,
  MarketAdminPermissionChecker, MarketAdminPermissionChecker__factory,
  CometHarnessInterfaceExtendedAssetList,
  LiquidationModule,
  LiquidationModule__factory,
} from '../build/types';
import { BigNumber } from 'ethers';
import { TransactionReceipt, TransactionResponse } from '@ethersproject/abstract-provider';
import { TotalsBasicStructOutput, TotalsCollateralStructOutput } from '../build/types/CometHarnessExtendedAssetList';

// Helpers
import type { Numeric } from './helpers/index';
import { exp, dfn, defaultAssets, deployDefaultLiquidationModule, deployEmptyDexAdapter, mulPrice, toBigInt, convertToBigInt, setBalance } from './helpers/index';

export * from './helpers/index';
export { ethers, expect, hre };

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
      // When set, an already-deployed token at this address is used (e.g. a real mainnet token on a fork)
      // instead of deploying a fresh mock. The price feed stays a mock SimplePriceFeed.
      address?: string;
    };
  };
  name?: string;
  symbol?: string;
  governor?: SignerWithAddress;
  multisig?: SignerWithAddress;
  pauseGuardian?: SignerWithAddress;
  extensionDelegate?: CometExt;
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
  liquidationModule?: LiquidationModule;
  dexAdapter?: string;
  liquidationModuleOpts?: {
    executors?: string[];
    pausers?: string[];
    incentiveBps?: bigint;
  };
  skipInitStorage?: boolean;
};

export type Protocol = {
  opts: ProtocolOpts;
  governor: SignerWithAddress;
  pauseGuardian: SignerWithAddress;
  multisig: SignerWithAddress;
  executors: SignerWithAddress[];
  pausers: SignerWithAddress[];
  extensionDelegate: CometExtAssetList;
  users: SignerWithAddress[];
  base: string;
  reward: string;
  comet: CometWithExtendedAssetList;
  assetListFactory: AssetListFactory;
  tokens: {
    [symbol: string]: FaucetToken | NonStandardFaucetFeeToken;
  };
  unsupportedToken: FaucetToken;
  priceFeeds: {
    [symbol: string]: SimplePriceFeed;
  };
  defaultLiquidationModule: LiquidationModule;
};

export type ConfiguratorAndProtocol = {
  configurator: Configurator;
  configuratorProxy: ConfiguratorProxy;
  proxyAdmin: CometProxyAdmin;
  cometFactory: CometFactoryWithExtendedAssetList;
  cometProxy: TransparentUpgradeableProxy;
} & Protocol;

export type RewardsOpts = {
  governor?: SignerWithAddress;
  configs?: [CometHarnessInterfaceExtendedAssetList, FaucetToken | NonStandardFaucetFeeToken, Numeric?][];
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

export type UserCollateral = {
  balance: BigNumber;
  _reserved: BigNumber;
};

export type UserBasic = {
  principal: BigNumber;
  baseTrackingIndex: BigNumber;
  baseTrackingAccrued: BigNumber;
  assetsIn: number;
  _reserved: number;
};

export type CollateralState = {
  tokenBalanceBefore: BigNumber;
  totalsCollateralBefore: BigNumber;
  collateralReservesBefore: BigNumber;
  seizeAmount: bigint;
  seizedValue: bigint;
};

export async function makeCollateralStates(
  comet: CometMainInterface,
  tokens: { [symbol: string]: FaucetToken | NonStandardFaucetFeeToken },
  keys: string[]
): Promise<Record<string, CollateralState>> {
  const col: Record<string, CollateralState> = {};
  for (const key of keys) {
    const asset = tokens[key] as FaucetToken;
    col[key] = {
      tokenBalanceBefore: await asset.balanceOf(comet.address),
      totalsCollateralBefore: (await comet.totalsCollateral(asset.address)).totalSupplyAsset,
      collateralReservesBefore: await comet.getCollateralReserves(asset.address),
      seizeAmount: 0n,
      seizedValue: 0n,
    };
  }
  return col;
}

export const factorDecimals = 18;
export const factorScale = exp(1, factorDecimals);
export const ONE = factorScale;
export const ZERO = exp(0, factorDecimals);
export const BASE_INDEX_SCALE = 1e15;
export const ZERO_ADDRESS = ethers.constants.AddressZero;
export const DEFAULT_PRICEFEED_DECIMALS = 8;
export const MAX_ASSETS = 24;
export const MAX_SUPPORTED_UTILIZATION = exp(2, 18);

export async function getBlock(n?: number, ethers_ = ethers): Promise<Block> {
  const blockNumber = n == undefined ? await ethers_.provider.getBlockNumber() : n;
  return ethers_.provider.getBlock(blockNumber);
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
  const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
  for (const asset in assets) {
    const initialPrice = exp(assets[asset].initialPrice || 1, 8);
    const priceFeedDecimals = assets[asset].priceFeedDecimals || 8;
    const priceFeed = await PriceFeedFactory.deploy(initialPrice, priceFeedDecimals);
    await priceFeed.deployed();
    priceFeeds[asset] = priceFeed;
  }

  const name32 = ethers.utils.formatBytes32String(opts.name || 'Compound Comet');
  const symbol32 = ethers.utils.formatBytes32String(opts.symbol || '📈BASE');
  const governor = opts.governor || signers[0];
  const pauseGuardian = opts.pauseGuardian || signers[1];
  // Reserve dedicated signers for the liquidation module roles from the tail of the signer list so
  // low-index `users` stay stable across the suite. These are returned so tests can drive the roles.
  const multisig = opts.multisig ?? signers[2];
  const executors = opts.liquidationModuleOpts?.executors ? await Promise.all(opts.liquidationModuleOpts?.executors.map(toSigner)) : signers.slice(-2);
  const pausers = opts.liquidationModuleOpts?.pausers ? await Promise.all(opts.liquidationModuleOpts?.pausers.map(toSigner)) : signers.slice(-4, -2);
  const users = signers.slice(3); // not governor, multisig, pause guardian - though some users may be pausers or executors
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

  const FaucetFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
  const tokens: Record<string, FaucetToken> = {};
  for (const symbol in assets) {
    const config = assets[symbol];
    if (config.address) {
      // Use an already-deployed token (e.g. a real mainnet token on a fork) instead of a fresh mock.
      tokens[symbol] = (await ethers.getContractAt('FaucetToken', config.address)) as FaucetToken;
      continue;
    }
    const decimals = config.decimals || 18;
    const initial = config.initial || 1e6;
    const name = config.name || symbol;
    const factory = config.factory || FaucetFactory;
    let token;
    token = tokens[symbol] = await factory.deploy(initial, name, decimals, symbol);
    await token.deployed();
  }

  const unsupportedToken = await FaucetFactory.deploy(1e6, 'Unsupported Token', 6, 'USUP');

  const AssetListFactory = (await ethers.getContractFactory('AssetListFactory')) as AssetListFactory__factory;
  const assetListFactory = await AssetListFactory.deploy();
  await assetListFactory.deployed();

  let extensionDelegate = opts.extensionDelegate;
  if (extensionDelegate === undefined) {
    const CometExtFactory = (await ethers.getContractFactory('CometExtAssetList')) as CometExtAssetList__factory;
    extensionDelegate = await CometExtFactory.deploy({ name32, symbol32 }, assetListFactory.address);
    await extensionDelegate.deployed();
  }

  const defaultLiquidationModule = opts.liquidationModule ?? await deployDefaultLiquidationModule({
    dexAdapter: opts.dexAdapter ?? (await deployEmptyDexAdapter(Object.entries(tokens).filter(([symbol]) => symbol !== base).map(([, token]) => {return token.address;}))).address,
    multisig: multisig.address,
    executors: opts.liquidationModuleOpts?.executors ?? executors.map((x) => x.address),
    pausers: opts.liquidationModuleOpts?.pausers ?? pausers.map((x) => x.address),
    incentiveBps: opts.liquidationModuleOpts?.incentiveBps
  });

  const config = {
    governor: governor.address,
    pauseGuardian: pauseGuardian.address,
    extensionDelegate: extensionDelegate.address,
    liquidationModule: defaultLiquidationModule.address,
    baseToken: tokens[base].address,
    baseTokenPriceFeed: priceFeeds[base].address,
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
    assetConfigs: Object.entries(assets).reduce((acc, [symbol, config], _i) => {
      if (symbol != base) {
        acc.push({
          asset: tokens[symbol].address,
          priceFeed: priceFeeds[symbol].address,
          decimals: dfn(assets[symbol].decimals, 18),
          borrowCollateralFactor: dfn(config.borrowCF, exp(0.8, 18)),
          liquidateCollateralFactor: dfn(config.liquidateCF, exp(0.85, 18)),
          liquidationFactor: dfn(config.liquidationFactor, exp(0.9, 18)),
          supplyCap: dfn(config.supplyCap, exp(150000, dfn(config.decimals, 18))),
        });
      }
      return acc;
    }, []),
  };

  const CometFactory = (await ethers.getContractFactory('CometHarnessExtendedAssetList')) as CometHarnessExtendedAssetList__factory;
  const comet = await CometFactory.deploy(config);

  config.assetConfigs = Object.entries(assets).reduce((acc, [symbol, config], _i) => {
    if (symbol != base) {
      acc.push({
        asset: tokens[symbol].address,
        priceFeed: priceFeeds[symbol].address,
        decimals: dfn(assets[symbol].decimals, 18),
        borrowCollateralFactor: dfn(config.borrowCF, exp(0.8, 18)),
        liquidateCollateralFactor: dfn(config.liquidateCF, exp(0.85, 18)),
        liquidationFactor: dfn(config.liquidationFactor, exp(0.9, 18)),
        supplyCap: dfn(config.supplyCap, exp(150000, dfn(config.decimals, 18))),
      });
    }
    return acc;
  }, []);

  if (opts.start) await ethers.provider.send('evm_setNextBlockTimestamp', [opts.start]);
  if (!opts.skipInitStorage) await comet.initializeStorage();

  const baseTokenBalance = opts.baseTokenBalance;
  if (baseTokenBalance) {
    const baseToken = tokens[base];
    await baseToken.allocateTo(comet.address, baseTokenBalance);
  }

  return {
    opts,
    governor,
    pauseGuardian,
    multisig,
    executors,
    pausers,
    extensionDelegate: extensionDelegate as CometExtAssetList,
    users,
    base,
    reward,
    comet: await ethers.getContractAt('CometHarnessInterfaceExtendedAssetList', comet.address) as CometWithExtendedAssetList,
    assetListFactory: assetListFactory,
    tokens,
    unsupportedToken,
    priceFeeds,
    defaultLiquidationModule,
  };
}

export async function getConfigurationForConfigurator(
  opts: ProtocolOpts,
  comet: CometWithExtendedAssetList,
  governor: SignerWithAddress,
  pauseGuardian: SignerWithAddress,
  extensionDelegate: CometExtAssetList,
  tokens: {
    [p: string]: FaucetToken | NonStandardFaucetFeeToken;
  },
  base: string,
  priceFeeds: { [p: string]: SimplePriceFeed },
  liquidationModule: string
) {

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
  const storeFrontPriceFactor = await comet.storeFrontPriceFactor();
  const trackingIndexScale = await comet.trackingIndexScale();
  const baseTrackingSupplySpeed = await comet.baseTrackingSupplySpeed();
  const baseTrackingBorrowSpeed = await comet.baseTrackingBorrowSpeed();
  const baseMinForRewards = await comet.baseMinForRewards();
  const baseBorrowMin = await comet.baseBorrowMin();
  const targetReserves = await comet.targetReserves();

  // Deploy Configurator
  const ConfiguratorFactory = (await ethers.getContractFactory('Configurator')) as Configurator__factory;
  const configurator = await ConfiguratorFactory.deploy();
  await configurator.deployed();
  const configuration = {
    governor: governor.address,
    pauseGuardian: pauseGuardian.address,
    extensionDelegate: extensionDelegate.address,
    baseToken: tokens[base].address,
    baseTokenPriceFeed: priceFeeds[base].address,
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
    liquidationModule,
    assetConfigs: Object.entries(assets).reduce((acc, [symbol, config], _i) => {
      if (symbol != base) {
        acc.push({
          asset: tokens[symbol].address,
          priceFeed: priceFeeds[symbol].address,
          decimals: dfn(assets[symbol].decimals, 18),
          borrowCollateralFactor: dfn(config.borrowCF, exp(0.8, 18)),
          liquidateCollateralFactor: dfn(config.liquidateCF, exp(0.85, 18)),
          liquidationFactor: dfn(config.liquidationFactor, exp(0.9, 18)),
          supplyCap: dfn(config.supplyCap, exp(150000, dfn(config.decimals, 18))),
        });
      }
      return acc;
    }, []),
  };
  return configuration;
}

// Only for testing configurator. Non-configurator tests need to deploy the CometHarnessExtendedAssetList instead.
export async function makeConfigurator(opts: ProtocolOpts = {}): Promise<ConfiguratorAndProtocol> {
  const {
    governor,
    pauseGuardian,
    multisig,
    executors,
    pausers,
    extensionDelegate,
    users,
    base,
    reward,
    comet,
    assetListFactory,
    tokens,
    unsupportedToken,
    priceFeeds,
  } = await makeProtocol({...opts, skipInitStorage: true });

  // Deploy ProxyAdmin
  const ProxyAdmin = (await ethers.getContractFactory('CometProxyAdmin')) as CometProxyAdmin__factory;
  const proxyAdmin = await ProxyAdmin.connect(governor).deploy(governor.address);

  // Deploy Comet proxy
  const CometProxy = (await ethers.getContractFactory('TransparentUpgradeableProxy')) as TransparentUpgradeableProxy__factory;
  const cometProxy = await CometProxy.deploy(
    comet.address,
    proxyAdmin.address,
    '0x',
  );

  // Deploy LiquidationModule
  const LiquidationModule = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
  const liquidationModule = await LiquidationModule.deploy(
    opts.dexAdapter ?? (await deployEmptyDexAdapter(Object.entries(tokens).filter(([symbol]) => symbol !== base).map(([, token]) => {return token.address;}))).address,
    multisig.address,
    executors.map((x) => x.address),
    pausers.map((x) => x.address),
    opts.liquidationModuleOpts?.incentiveBps ?? 0n
  );

  const configuration = await getConfigurationForConfigurator(
    opts,
    comet,
    governor,
    pauseGuardian,
    extensionDelegate,
    tokens,
    base,
    priceFeeds,
    liquidationModule.address
  );

  // Deploy CometFactory
  const CometFactoryFactory = (await ethers.getContractFactory('CometFactoryWithExtendedAssetList')) as CometFactoryWithExtendedAssetList__factory;
  const cometFactory = await CometFactoryFactory.deploy();

  // Deploy Configurator
  const ConfiguratorFactory = (await ethers.getContractFactory('Configurator')) as Configurator__factory;
  const configurator = await ConfiguratorFactory.deploy();

  // Deploy Configurator proxy
  const initializeCalldata = (await configurator.populateTransaction.initialize(governor.address)).data;
  const ConfiguratorProxy = (await ethers.getContractFactory('ConfiguratorProxy')) as ConfiguratorProxy__factory;
  const configuratorProxy = await ConfiguratorProxy.deploy(configurator.address, proxyAdmin.address, initializeCalldata);

  // Set the initial factory and configuration for Comet in Configurator
  const configuratorAsProxy = configurator.attach(configuratorProxy.address);
  await configuratorAsProxy.connect(governor).setConfiguration(cometProxy.address, configuration);
  await configuratorAsProxy.connect(governor).setFactory(cometProxy.address, cometFactory.address);

  await configuratorAsProxy.connect(governor).setConfiguration(cometProxy.address, configuration);
  await configuratorAsProxy.connect(governor).setFactory(cometProxy.address, cometFactory.address);

  if(opts.marketAdminPermissionCheckerContract) {
    await configuratorAsProxy.connect(governor).setMarketAdminPermissionChecker(opts.marketAdminPermissionCheckerContract.address);
    await proxyAdmin.connect(governor).setMarketAdminPermissionChecker(opts.marketAdminPermissionCheckerContract.address);
  } else {
    const MarketAdminPermissionCheckerFactory = (await ethers.getContractFactory(
      'MarketAdminPermissionChecker'
    )) as MarketAdminPermissionChecker__factory;

    const marketAdminPermissionCheckerContract =  await MarketAdminPermissionCheckerFactory.deploy(
      governor.address,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero
    );

    await configuratorAsProxy.connect(governor).setMarketAdminPermissionChecker(marketAdminPermissionCheckerContract.address);
    await proxyAdmin.connect(governor).setMarketAdminPermissionChecker(marketAdminPermissionCheckerContract.address);
  }

  const initializeStorageCalldata = (await comet.populateTransaction.initializeStorage()).data;
  await proxyAdmin.connect(governor).deployUpgradeToAndCall(
    configuratorProxy.address,
    cometProxy.address,
    initializeStorageCalldata
  );

  return {
    opts,
    governor,
    pauseGuardian,
    multisig,
    executors,
    pausers,
    extensionDelegate,
    users,
    base,
    reward,
    proxyAdmin,
    comet,
    assetListFactory,
    cometProxy,
    configurator,
    configuratorProxy,
    cometFactory,
    tokens,
    unsupportedToken,
    priceFeeds,
    defaultLiquidationModule: liquidationModule
  };
}

export async function seedMarketActivity(
  comet: CometHarnessInterfaceExtendedAssetList,
  tokens: { [symbol: string]: FaucetToken | NonStandardFaucetFeeToken },
  priceFeeds: { [symbol: string]: SimplePriceFeed },
  lenderUser: SignerWithAddress,
  borrowerUser: SignerWithAddress,
  baseToken: FaucetToken,
  initialBaseFunding: bigint,
): Promise<void> {
  const collateralConfigs = [
    { key: 'COMP', amount: exp(1.5, 18) }, // ~$150
    { key: 'WETH', amount: exp(0.075, 18) }, // ~$150
    { key: 'USDT', amount: exp(150, 6) }, // ~$150
  ];

  // Seed the market with other users so balances are non-empty, simulating a live
  // market where reserves, supplies and borrows are already non-zero before the test acts.
  // The lender supplies the first 3 collaterals (~$150 each) and base liquidity.
  for (const config of collateralConfigs) {
    await tokens[config.key].allocateTo(lenderUser.address, config.amount);
    await tokens[config.key].connect(lenderUser).approve(comet.address, config.amount);
    await comet.connect(lenderUser).supply(tokens[config.key].address, config.amount);
  }

  // Seed base liquidity
  const baseTokenAmount = exp(2000, 6); // ~$2000
  await baseToken.allocateTo(lenderUser.address, baseTokenAmount);
  await baseToken.connect(lenderUser).approve(comet.address, baseTokenAmount);
  await comet.connect(lenderUser).supply(baseToken.address, baseTokenAmount);

  // seed reserves
  await baseToken.allocateTo(comet.address, initialBaseFunding);

  // The borrower supplies every collateral (~$100 each) and opens a ~$300 borrow.
  // amount = targetValue * scale / price (targetValue and price both in 1e8 units).
  const borrowerCollateralValue = exp(100, 8); // $100 in 1e8 price units
  const borrowAmount = exp(300, 6); // ~$300
  for (const symbol in tokens) {
    const { scale } = await comet.getAssetInfoByAddress(tokens[symbol].address);
    const price = (await priceFeeds[symbol].latestRoundData())[1].toBigInt();
    const amount = borrowerCollateralValue * scale.toBigInt() / price;
    await tokens[symbol].allocateTo(borrowerUser.address, amount);
    await tokens[symbol].connect(borrowerUser).approve(comet.address, amount);
    await comet.connect(borrowerUser).supply(tokens[symbol].address, amount);
  }
  await comet.connect(borrowerUser).withdraw(baseToken.address, borrowAmount); // ~$300
}

export async function makeRewards(opts: RewardsOpts = {}): Promise<Rewards> {
  const signers = await ethers.getSigners();

  const governor = opts.governor || signers[0];
  const configs = opts.configs || [];

  const RewardsFactory = (await ethers.getContractFactory('CometRewards')) as CometRewards__factory;
  const rewards = await RewardsFactory.deploy(governor.address);
  await rewards.deployed();

  for (const [comet, token, multiplier] of configs) {
    if (multiplier === undefined) await wait(rewards.setRewardConfig(comet.address, token.address));
    else await wait(rewards.setRewardConfigWithMultiplier(comet.address, token.address, multiplier));
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

  const BulkerFactory = (await ethers.getContractFactory('BaseBulker')) as BaseBulker__factory;
  const bulker = await BulkerFactory.deploy(admin.address, weth);
  await bulker.deployed();

  return {
    opts,
    bulker
  };
}
export async function bumpTotalsCollateral(comet: CometHarnessInterfaceExtendedAssetList, token: FaucetToken | NonStandardFaucetFeeToken, delta: bigint): Promise<TotalsCollateralStructOutput> {
  const t0 = await comet.totalsCollateral(token.address);
  const t1 = Object.assign({}, t0, { totalSupplyAsset: t0.totalSupplyAsset.toBigInt() + delta });
  await token.allocateTo(comet.address, delta);
  await wait(comet.setTotalsCollateral(token.address, t1));
  return t1;
}

export async function setTotalsBasic(comet: CometHarnessInterfaceExtendedAssetList, overrides = {}): Promise<TotalsBasicStructOutput> {
  const t0 = await comet.totalsBasic();
  const t1 = Object.assign({}, t0, overrides);
  await wait(comet.setTotalsBasic(t1));
  return t1;
}

export async function updateAssetBorrowCollateralFactor(configurator: Configurator, cometProxyAdmin: CometProxyAdmin, cometAddress: string, assetAddress: string, borrowCF: bigint) {
  await configurator.updateAssetBorrowCollateralFactor(cometAddress, assetAddress, borrowCF);
  await cometProxyAdmin.deployAndUpgradeTo(configurator.address, cometAddress);
}

export async function updateAssetLiquidateCollateralFactor(configurator: Configurator, cometProxyAdmin: CometProxyAdmin, cometAddress: string, assetAddress: string, liquidateCF: bigint, governor: SignerWithAddress) {
  await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometAddress, assetAddress, liquidateCF);
  await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configurator.address, cometAddress);
}

export async function getLiquidity(comet: CometWithExtendedAssetList, token: FaucetToken | NonStandardFaucetFeeToken, amount: bigint): Promise<BigNumber> {
  const assetInfo = await comet.getAssetInfoByAddress(token.address);
  const priceUSD = mulPrice(amount, await comet.getPrice(assetInfo.priceFeed), assetInfo.scale);
  return BigNumber.from(priceUSD).mul(assetInfo.borrowCollateralFactor).div(factorScale);
}

export async function getLiquidityWithLiquidateCF(comet: CometMainInterface, token: FaucetToken | NonStandardFaucetFeeToken, amount: bigint): Promise<BigNumber> {
  const assetInfo = await comet.getAssetInfoByAddress(token.address);
  const priceUSD = mulPrice(amount, await comet.getPrice(assetInfo.priceFeed), assetInfo.scale);
  if (assetInfo.liquidateCollateralFactor.eq(0)) {
    return BigNumber.from(0);
  }
  return BigNumber.from(priceUSD).mul(assetInfo.liquidateCollateralFactor).div(factorScale);
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
  return balanceOf.sub(borrowBalanceOf).toBigInt();
}

type Portfolio = {
  internal: {
    [symbol: string]: bigint;
  };
  external: {
    [symbol: string]: bigint;
  };
};

type TotalsAndReserves = {
  totals: {
    [symbol: string]: bigint;
  };
  reserves: {
    [symbol: string]: bigint;
  };
};

export async function portfolio({ comet, base, tokens }, account): Promise<Portfolio> {
  const internal = { [base]: await baseBalanceOf(comet, account) };
  const external = { [base]: BigInt(await tokens[base].balanceOf(account)) };
  for (const symbol in tokens) {
    if (symbol != base) {
      internal[symbol] = BigInt(await comet.collateralBalanceOf(account, tokens[symbol].address));
      external[symbol] = BigInt(await tokens[symbol].balanceOf(account));
    }
  }
  return { internal, external };
}

export async function totalsAndReserves({ comet, base, tokens }): Promise<TotalsAndReserves> {
  const totals = {
    [base]: BigInt((await comet.totalsBasic()).totalSupplyBase),
  };
  const reserves = { [base]: BigInt(await comet.getReserves()) };
  for (const symbol in tokens) {
    if (symbol != base) {
      totals[symbol] = BigInt((await comet.totalsCollateral(tokens[symbol].address)).totalSupplyAsset);
      reserves[symbol] = BigInt(await comet.getCollateralReserves(tokens[symbol].address));
    }
  }
  return { totals, reserves };
}

export interface TransactionResponseExt extends TransactionResponse {
  receipt: TransactionReceipt;
}

export async function wait(tx: TransactionResponse | Promise<TransactionResponse>): Promise<TransactionResponseExt> {
  const tx_ = await tx;
  let receipt = await tx_.wait();
  return {
    ...tx_,
    receipt,
  };
}

export function event(tx, index) {
  const ev = tx.receipt.events[index],
    args = {};
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
  return { [ev.event]: args };
}

export function getGasUsed(tx: TransactionResponseExt): bigint {
  return tx.receipt.gasUsed.mul(tx.receipt.effectiveGasPrice).toBigInt();
}

export function presentValueSupply(baseSupplyIndex: bigint | BigNumber, principalValue: bigint | BigNumber): bigint {
  const principal = toBigInt(principalValue);
  const index = toBigInt(baseSupplyIndex);
  return principal * index / BigInt(BASE_INDEX_SCALE);
}

function presentValueBorrow(baseBorrowIndex: bigint | BigNumber, principalValue: bigint | BigNumber): bigint {
  const principal = toBigInt(principalValue);
  const index = toBigInt(baseBorrowIndex);
  return principal * index / BigInt(BASE_INDEX_SCALE);
}

export function presentValue(
  principalValue: bigint | BigNumber,
  baseSupplyIndex: bigint | BigNumber,
  baseBorrowIndex: bigint | BigNumber
): bigint {
  const principal = toBigInt(principalValue);
  if (principal >= 0n) {
    return presentValueSupply(baseSupplyIndex, principal);
  } else {
    return -presentValueBorrow(baseBorrowIndex, -principal);
  }
}

function principalValueSupply(baseSupplyIndex: bigint, presentValue: bigint): bigint {
  return (presentValue * BigInt(BASE_INDEX_SCALE)) / baseSupplyIndex;
}

function principalValueBorrow(baseBorrowIndex: bigint, presentValue: bigint): bigint {
  return (presentValue * BigInt(BASE_INDEX_SCALE) + baseBorrowIndex - 1n) / baseBorrowIndex;
}

export function principalValue(
  presentValue: bigint | BigNumber,
  baseSupplyIndex: bigint | BigNumber,
  baseBorrowIndex: bigint | BigNumber
): bigint {
  const pv = toBigInt(presentValue);
  if (pv >= 0n) {
    return principalValueSupply(toBigInt(baseSupplyIndex), pv);
  } else {
    return -principalValueBorrow(toBigInt(baseBorrowIndex), -pv);
  }
}

/*//////////////////////////////////////////////////////////////
                          FORK SETUP
//////////////////////////////////////////////////////////////*/

export async function setupFork(blockNumber?: number, jsonRpcUrl?: string) {
  const mainnetConfig = hre.config.networks.mainnet as any;

  await hre.network.provider.request({
    method: 'hardhat_reset',
    params: [
      {
        forking: {
          jsonRpcUrl: jsonRpcUrl ?? mainnetConfig.url,
          blockNumber: blockNumber ?? undefined,
        },
      },
    ],
  });
}

const toSigner = async (x: string | SignerWithAddress): Promise<SignerWithAddress> => {
  if (typeof x !== 'string') return x;                 // already a signer (default slice)
  const signer = await ethers.getImpersonatedSigner(x);
  await setBalance(signer.address, ethers.utils.parseEther('10')); // gas to call the module
  return signer;
};
