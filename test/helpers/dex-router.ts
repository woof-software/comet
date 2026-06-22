import { ethers } from "hardhat";
import { CometInterface } from "../../build/types";
import { ONEINCH_V6_ROUTER_MAINNET } from "./oneinch";

/**
 * Route helpers and shared infrastructure constants for the dex adapters.
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

// Builds a single-pool RouteConfig from an explicit poolKey.
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

// Builds a single-pool route that sells `collateral` into `base`.
export function poolRoute(
  base: string,
  collateral: string,
  fee: number,
  tickSpacing: number,
  hooks: string = ethers.constants.AddressZero
): RouteConfig {
  const zeroForOne = collateral.toLowerCase() < base.toLowerCase();
  const [currency0, currency1] = zeroForOne ? [collateral, base] : [base, collateral];
  return singleRoute({ currency0, currency1, fee, tickSpacing, hooks }, zeroForOne);
}

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
      ["address", "address", "uint24", "int24", "address"],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
    )
  );
}

// Global infrastructure.
export const CORE_ROUTER = ONEINCH_V6_ROUTER_MAINNET;
export const REDUNDANT_ROUTER = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af";
export const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";

// Swap parameters.
export const SLIPPAGE_BPS = 500; // 5%
export const ONEINCH_SLIPPAGE_PCT = 1; // 1%
export const CHAIN_ID = 1;
// Restrict 1inch routing to signature-free AMMs so the core calldata can be used on a fork.
export const AMM_PROTOCOLS = "UNISWAP_V4,UNISWAP_V3,UNISWAP_V2,SUSHI,CURVE";

export const POOL_MANAGER_SWAP_EVENT =
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)";
export const ERC20_EVENTS_IFACE = new ethers.utils.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);
export const POOL_MANAGER_IFACE = new ethers.utils.Interface([POOL_MANAGER_SWAP_EVENT]);

// Per-market data: the Comet market and its collateral swap routes (keyed by collateral address).
export interface MarketConfig {
  comet: string;
  routes: Record<string, RouteConfig>;
}
