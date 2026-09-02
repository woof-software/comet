import { scenario } from '../../context/CometContext';
import { dexMarketWith, LiquidationMode, Route, runDexLiquidation, assertDexLiquidation } from './checks';

const MODES: LiquidationMode[] = ['partial', 'full'];

// Routed collaterals alternate between the 1Inch and Uniswap paths; route-less collaterals are absorbed.
const mixedRoutes = (_asset: string, hasRoute: boolean, index: number): Route =>
  hasRoute ? (index % 2 === 0 ? 'oneinch' : 'uniswap') : 'absorb';

for (const mode of MODES) {
  scenario(
    `Comet#dexLiquidation > five collaterals, mixed routes [${mode}]`,
    {
      filter: dexMarketWith(5),
    },
    async ({ actors }, context, world) => {
      const { albert, betty } = actors;
      const r = await runDexLiquidation(context, world, albert, betty, { mode, count: 5, decide: mixedRoutes });
      await assertDexLiquidation(r, mode);
      return r.receipt;
    }
  );

  scenario(
    `Comet#dexLiquidation > twenty-four collaterals, mixed routes [${mode}]`,
    {
      filter: dexMarketWith(24),
    },
    async ({ actors }, context, world) => {
      const { albert, betty } = actors;
      const r = await runDexLiquidation(context, world, albert, betty, { mode, count: 24, decide: mixedRoutes });
      await assertDexLiquidation(r, mode);
      return r.receipt;
    }
  );
}
