import hre, { ethers } from 'hardhat';
import { Signer } from 'ethers';
import {
  CometInterface,
  CometInterface__factory,
  ERC20,
  ERC20__factory,
  OneInchV6CoreAdapter,
  OneInchV6CoreAdapter__factory,
} from '../../build/types';
import { ONEINCH_V6_ROUTER_MAINNET } from './oneinch';
import { takeSnapshot, SnapshotRestorer } from './snapshot';

/**
 * Uniswap V4 swap-route helpers and the shared mainnet-fork fixture for the dex adapters.
 */

// Mirrors UniswapAdapter.RouteKind.
export enum RouteKind {
  Unset = 0,
  Single = 1,
  Multi = 2,
}

export interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export interface PathKey {
  intermediateCurrency: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  hookData: string;
}

// Mirrors UniswapAdapter.RouteConfig.
export interface RouteConfig {
  kind: RouteKind;
  poolKey: PoolKey;
  zeroForOne: boolean;
  path: PathKey[];
}

const ZERO_POOL_KEY: PoolKey = {
  currency0: ethers.constants.AddressZero,
  currency1: ethers.constants.AddressZero,
  fee: 0,
  tickSpacing: 0,
  hooks: ethers.constants.AddressZero,
};

// Builds a single-pool RouteConfig.
export function singleRoute(poolKey: PoolKey, zeroForOne: boolean): RouteConfig {
  return { kind: RouteKind.Single, poolKey, zeroForOne, path: [] };
}

// Builds a multi-hop RouteConfig from an ordered list of path hops.
export function multiRoute(path: PathKey[]): RouteConfig {
  return { kind: RouteKind.Multi, poolKey: ZERO_POOL_KEY, zeroForOne: false, path };
}

// Unset route for a collateral that has no configured Uniswap V4 route.
export function unsetRoute(): RouteConfig {
  return { kind: RouteKind.Unset, poolKey: ZERO_POOL_KEY, zeroForOne: false, path: [] };
}

export const WBTC_USDC_ROUTE: RouteConfig = singleRoute(
  {
    currency0: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
    currency1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    fee: 3000,
    tickSpacing: 60,
    hooks: ethers.constants.AddressZero,
  },
  true
);

export const WETH_USDC_ROUTE: RouteConfig = singleRoute(
  {
    currency0: ethers.constants.AddressZero, // Native coin
    currency1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    fee: 3000,
    tickSpacing: 60,
    hooks: ethers.constants.AddressZero,
  },
  true
);

// USDC -> ETH reuses the ETH/USDC pool with the direction reversed (zeroForOne = false).
export const USDC_WETH_ROUTE: RouteConfig = singleRoute(WETH_USDC_ROUTE.poolKey, false);

export const WSTETH_USDC_ROUTE: RouteConfig = multiRoute([
  // hop 1: wstETH -> WBTC
  {
    intermediateCurrency: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
    fee: 2500,
    tickSpacing: 50,
    hooks: ethers.constants.AddressZero,
    hookData: '0x',
  },
  // hop 2: WBTC -> USDC
  {
    intermediateCurrency: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    fee: 3000,
    tickSpacing: 60,
    hooks: ethers.constants.AddressZero,
    hookData: '0x',
  },
]);

// Builds swap routes for all Comet collaterals, leaving collaterals without a known route as unset.
export async function buildRoutes(
  comet: CometInterface,
  realRoutes: Record<string, RouteConfig>
): Promise<RouteConfig[]> {
  const lowercasedRoutes: Record<string, RouteConfig> = {};
  for (const [asset, route] of Object.entries(realRoutes)) {
    lowercasedRoutes[asset.toLowerCase()] = route;
  }

  const numAssets: number = await comet.numAssets();
  const routes: RouteConfig[] = [];
  for (let i = 0; i < numAssets; ++i) {
    const info = await comet.getAssetInfo(i);
    const asset: string = info.asset;
    routes.push(lowercasedRoutes[asset.toLowerCase()] ?? unsetRoute());
  }
  return routes;
}

// Computes the Uniswap V4 poolId for a PoolKey (`keccak256(abi.encode(poolKey))`).
export function v4PoolId(poolKey: PoolKey): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
    )
  );
}

// Mainnet data
export const COMET_USDC = '0xc3d688B66703497DAA19211EEdff47f25384cdc3'; // cUSDCv3
export const COMET_WETH = '0xA17581A9E3356d9A858b789D68B4d866e593aE94'; // cWETHv3 (base = WETH)
export const CORE_ROUTER = ONEINCH_V6_ROUTER_MAINNET;
export const REDUNDANT_ROUTER = '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af';
export const POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90';

export const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
export const WBTC_WHALE = '0x58De44c4E1CBb802118d35e232F763D98Dc7c8CC';
export const WBTC_AMOUNT = ethers.utils.parseUnits('1', 8); // 1 WBTC

export const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
export const WSTETH_WHALE = '0x5313b39bf226ced2332C81eB97BB28c6fD50d1a3';
export const WSTETH_AMOUNT = ethers.utils.parseUnits('1', 18); // 1 wstETH

export const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const WETH_WHALE = '0x4553e3Bc6327006A63C5aA4cdAC887f66b6A433E';
export const WETH_AMOUNT = ethers.utils.parseUnits('1', 18); // 1 WETH

export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const USDC_WHALE = '0x01b8697695EAb322A339c4bf75740Db75dc9375E';
export const USDC_AMOUNT = ethers.utils.parseUnits('4000', 6); // 4,000 USDC

export const SLIPPAGE_BPS = 500; // 5%
export const ONEINCH_SLIPPAGE_PCT = 1; // 1%
export const CHAIN_ID = 1;
// Restrict 1inch routing to signature-free AMMs so the core calldata can be used on a fork.
export const AMM_PROTOCOLS = 'UNISWAP_V3,UNISWAP_V2,SUSHI,CURVE';

// Swap routes per collateral used by the fixture.
export const REAL_ROUTES: Record<string, RouteConfig> = {
  [WBTC]: WBTC_USDC_ROUTE,
  [WSTETH]: WSTETH_USDC_ROUTE,
  [WETH]: WETH_USDC_ROUTE,
};

// Swap routes for the cWETHv3 (base WETH) market: USDC -> ETH exercises the native-output path.
export const WETH_MARKET_ROUTES: Record<string, RouteConfig> = {
  [USDC]: USDC_WETH_ROUTE,
};

export const POOL_MANAGER_SWAP_EVENT =
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)';
export const ERC20_EVENTS_IFACE = new ethers.utils.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);
export const POOL_MANAGER_IFACE = new ethers.utils.Interface([POOL_MANAGER_SWAP_EVENT]);

export interface DexAdapterFixture {
  adapter: OneInchV6CoreAdapter;
  adapterFactory: OneInchV6CoreAdapter__factory;
  routes: RouteConfig[];
  comet: CometInterface;
  baseToken: string;
  baseTokenErc20: ERC20;
  wbtcErc20: ERC20;
  wstethErc20: ERC20;
  wethErc20: ERC20;
  moduleSigner: Signer;
  moduleAddress: string;
  snapshot: SnapshotRestorer;
}

// Points the fixture at a specific Comet market and route set (defaults to cUSDCv3).
export interface SetupOptions {
  comet?: string;
  realRoutes?: Record<string, RouteConfig>;
}

// Resets the mainnet fork, deploys a OneInchV6CoreAdapter, and snapshots the post-deploy state.
export async function setupDexAdapter(options: SetupOptions = {}): Promise<DexAdapterFixture> {
  const cometAddress = options.comet ?? COMET_USDC;
  const realRoutes = options.realRoutes ?? REAL_ROUTES;

  await hre.network.provider.request({
    method: 'hardhat_reset',
    params: [{ forking: { jsonRpcUrl: process.env.MAINNET_QUICKNODE_LINK } }],
  });

  const [, moduleSigner] = await ethers.getSigners();
  const moduleAddress = await moduleSigner.getAddress();

  const comet = CometInterface__factory.connect(cometAddress, ethers.provider);
  const baseToken = await comet.baseToken();
  const baseTokenErc20 = ERC20__factory.connect(baseToken, ethers.provider);
  const wbtcErc20 = ERC20__factory.connect(WBTC, ethers.provider);
  const wstethErc20 = ERC20__factory.connect(WSTETH, ethers.provider);
  const wethErc20 = ERC20__factory.connect(WETH, ethers.provider);

  const routes = await buildRoutes(comet, realRoutes);

  const adapterFactory = (await ethers.getContractFactory(
    'OneInchV6CoreAdapter'
  )) as OneInchV6CoreAdapter__factory;
  const adapter = await adapterFactory.deploy(
    cometAddress,
    moduleAddress,
    CORE_ROUTER,
    REDUNDANT_ROUTER,
    WETH,
    SLIPPAGE_BPS,
    routes
  );
  await adapter.deployed();

  const snapshot = await takeSnapshot();

  return {
    adapter,
    adapterFactory,
    routes,
    comet,
    baseToken,
    baseTokenErc20,
    wbtcErc20,
    wstethErc20,
    wethErc20,
    moduleSigner,
    moduleAddress,
    snapshot,
  };
}
