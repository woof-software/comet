import { Deployed, DeploymentManager } from '../../../plugins/deployment_manager';
import { DeploySpec } from '../../../src/deploy';
import { MARKETS, TOKENS } from '../../../test/helpers';
import { deployDexMarket, DexCollateral } from '../dexDeployHelper';

// Seven Uniswap-routed collaterals (real USDC-base V4 routes reused from MARKETS.usdc).
const ROUTED: DexCollateral[] = [
  { info: TOKENS.WBTC, decimals: 8, price: 5_882_352_941_176n },
  { info: TOKENS.WETH, decimals: 18, price: 156_250_000_000n },
  { info: TOKENS.WSTETH, decimals: 18, price: 156_250_000_000n },
  { info: TOKENS.UNI, decimals: 18, price: 273_972_602n },
  { info: TOKENS.LINK, decimals: 18, price: 714_285_714n },
  { info: TOKENS.cbBTC, decimals: 8, price: 5_882_352_941_176n },
  { info: TOKENS.USDe, decimals: 18, price: 90_000_000n },
];

// Seventeen route-less collaterals
const ROUTELESS: DexCollateral[] = [
  { info: TOKENS.COMP, decimals: 18, price: 4_000_000_000n },
  { info: TOKENS.tBTC, decimals: 18, price: 5_882_352_941_176n },
  { info: TOKENS.weETH, decimals: 18, price: 160_000_000_000n },
  { info: TOKENS.rsETH, decimals: 18, price: 160_000_000_000n },
  { info: TOKENS.XAUt, decimals: 6, price: 200_000_000_000n },
  { info: TOKENS.USDS, decimals: 18, price: 90_000_000n },
  { info: TOKENS.cbETH, decimals: 18, price: 160_000_000_000n },
  { info: TOKENS.ETHx, decimals: 18, price: 160_000_000_000n },
  { info: TOKENS.ezETH, decimals: 18, price: 160_000_000_000n },
  { info: TOKENS.rswETH, decimals: 18, price: 160_000_000_000n },
  { info: TOKENS.rETH, decimals: 18, price: 170_000_000_000n },
  { info: TOKENS.osETH, decimals: 18, price: 160_000_000_000n },
  { info: TOKENS.mETH, decimals: 18, price: 160_000_000_000n },
  { info: TOKENS.SKY, decimals: 18, price: 6_000_000n },
  { info: TOKENS.sUSDS, decimals: 18, price: 100_000_000n },
  { info: TOKENS.wUSDM, decimals: 18, price: 100_000_000n },
  { info: TOKENS.sFRAX, decimals: 18, price: 100_000_000n },
];

export default async function deploy(
  deploymentManager: DeploymentManager,
  deploySpec: DeploySpec
): Promise<Deployed> {
  const collaterals = [...ROUTED, ...ROUTELESS];
  // buildRoutesFromList applies a real route only to collaterals present in MARKETS.usdc.routes; all others
  // (the route-less set) default to an unset route.
  return deployDexMarket(deploymentManager, deploySpec, {
    name: 'Compound USDC (DEX 24)',
    symbol: 'cUSDCv3-dex24',
    collaterals,
    routes: MARKETS.usdc.routes,
  });
}
