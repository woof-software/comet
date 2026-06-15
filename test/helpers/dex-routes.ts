import { ethers } from 'hardhat';
import { CometInterface } from 'build/types';

/**
 * Uniswap V4 swap-route helpers for the redundant path of {CoreDexAdapter}.
 */

export interface Route {
  poolKey: {
    currency0: string;
    currency1: string;
    fee: number;
    tickSpacing: number;
    hooks: string;
  };
  zeroForOne: boolean;
}

export const WBTC_USDC_ROUTE: Route = {
  poolKey: {
    currency0: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
    currency1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    fee: 3000,
    tickSpacing: 60,
    hooks: ethers.constants.AddressZero,
  },
  zeroForOne: true,
};

// Placeholder route used to setup DexAdapter where not all collateral swap routes are known.
export function placeholderRoute(asset: string, baseToken: string): Route {
  const zeroForOne = asset.toLowerCase() < baseToken.toLowerCase();
  const [currency0, currency1] = zeroForOne ? [asset, baseToken] : [baseToken, asset];
  return {
    poolKey: { currency0, currency1, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero },
    zeroForOne,
  };
}

// Builds swap routes for all Comet collaterals, using placeholder route for missing real routes.
export async function buildRoutes(
  comet: CometInterface,
  baseToken: string,
  realRoutes: Record<string, Route>
): Promise<Route[]> {
  const lowercasedRoutes: Record<string, Route> = {};
  for (const [asset, route] of Object.entries(realRoutes)) {
    lowercasedRoutes[asset.toLowerCase()] = route;
  }

  const numAssets: number = await comet.numAssets();
  const routes: Route[] = [];
  for (let i = 0; i < numAssets; ++i) {
    const info = await comet.getAssetInfo(i);
    const asset: string = info.asset;
    routes.push(lowercasedRoutes[asset.toLowerCase()] ?? placeholderRoute(asset, baseToken));
  }
  return routes;
}

// Computes the Uniswap V4 poolId for a route's PoolKey (`keccak256(abi.encode(poolKey))`).
export function v4PoolId(poolKey: Route['poolKey']): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
    )
  );
}
