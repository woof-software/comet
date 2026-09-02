import { Deployed, DeploymentManager } from '../../../plugins/deployment_manager';
import { DeploySpec } from '../../../src/deploy';
import { MARKETS, TOKENS } from '../../../test/helpers';
import { deployDexMarket } from '../dexDeployHelper';

/**
 * Single-collateral (WETH) DEX-liquidation test market on a mainnet fork. WETH carries a Uniswap route, so a
 * lone-collateral position can be sold via 1Inch (1.1), via Uniswap on empty swapData (1.2), or via the
 * Uniswap fallback when the 1Inch call reverts (1.3). Pinned by the `numAssets === 1` filter.
 */

const COLLATERALS = [{ info: TOKENS.WETH, decimals: 18, price: 156_250_000_000n }];

export default async function deploy(
  deploymentManager: DeploymentManager,
  deploySpec: DeploySpec
): Promise<Deployed> {
  const routes = { [TOKENS.WETH.address]: MARKETS.usdc.routes[TOKENS.WETH.address] };
  return deployDexMarket(deploymentManager, deploySpec, {
    name: 'Compound USDC (DEX 1)',
    symbol: 'cUSDCv3-dex1',
    collaterals: COLLATERALS,
    routes,
  });
}
