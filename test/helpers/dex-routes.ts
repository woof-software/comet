import { ethers } from 'hardhat';
import { CometInterface } from 'build/types';

/**
 * Uniswap V4 swap-route helpers for the redundant path of {CoreDexAdapter}.
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
