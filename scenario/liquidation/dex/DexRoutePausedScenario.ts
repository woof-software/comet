import { scenario } from '../../context/CometContext';
import { dexMarketWith, LiquidationMode, Route, runDexLiquidation, assertPausedAbsorb } from './checks';

const MODES: LiquidationMode[] = ['partial', 'full'];

// Quote 1Inch for the routed collaterals to prove valid swapData is still ignored once the route is paused.
const validButIgnored = (_asset: string, hasRoute: boolean): Route => (hasRoute ? 'oneinch' : 'absorb');

for (const mode of MODES) {
  scenario(
    `Comet#dexLiquidation > route paused, all collaterals absorbed [${mode}]`,
    {
      filter: dexMarketWith(5),
    },
    async ({ actors }, context, world) => {
      const { albert, betty } = actors;
      const r = await runDexLiquidation(context, world, albert, betty, { mode, count: 5, decide: validButIgnored, pauseRoute: true });
      await assertPausedAbsorb(r, mode);
      return r.receipt;
    }
  );
}
