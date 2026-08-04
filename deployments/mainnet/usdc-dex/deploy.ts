import { Deployed, DeploymentManager } from '../../../plugins/deployment_manager';
import { DeploySpec } from '../../../src/deploy';
import { MARKETS, TOKENS } from '../../../test/helpers';
import { deployDexMarket } from '../dexDeployHelper';

/**
 * Fresh mainnet-fork Comet (USDC base) with Liquidation module + DEX adapter over five real collaterals.
 * WBTC / WETH / WSTETH / LINK carry Uniswap routes; UNI is left route-less so it is swept back to Comet and
 * absorbed on liquidation. Used as the 5-collateral base for scenario/liquidation/dex.
 */

const COLLATERALS = [
  { info: TOKENS.WBTC, decimals: 8, price: 5_882_352_941_176n },
  { info: TOKENS.WETH, decimals: 18, price: 156_250_000_000n },
  { info: TOKENS.WSTETH, decimals: 18, price: 156_250_000_000n },
  { info: TOKENS.UNI, decimals: 18, price: 273_972_602n },
  { info: TOKENS.LINK, decimals: 18, price: 714_285_714n },
];

export default async function deploy(
  deploymentManager: DeploymentManager,
  deploySpec: DeploySpec
): Promise<Deployed> {
  // Drop UNI's route so it stays route-less (swept back to Comet on liquidation).
  const routes = Object.fromEntries(
    Object.entries(MARKETS.usdc.routes).filter(([addr]) => addr.toLowerCase() !== TOKENS.UNI.address.toLowerCase())
  );
  return deployDexMarket(deploymentManager, deploySpec, {
    name: 'Compound USDC (DEX)',
    symbol: 'cUSDCv3-dex',
    collaterals: COLLATERALS,
    routes,
  });
}
