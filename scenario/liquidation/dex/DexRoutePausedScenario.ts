import { scenario } from '../../context/CometContext';
import { CometContext } from '../../context/CometContext';
import { hasDexLiquidation, hasCollateralCount } from '../../utils';
import { LiquidationMode, Route, runDexLiquidation, assertPausedAbsorb } from './checks';

const MODES: LiquidationMode[] = ['partial', 'full'];

// Quote 1Inch for the routed collaterals to prove valid swapData is still ignored once the route is paused.
const validButIgnored = (_asset: string, hasRoute: boolean): Route => (hasRoute ? 'oneinch' : 'absorb');

for (const mode of MODES) {
  scenario.only(
    `Comet#dexLiquidation > route paused, all collaterals absorbed [${mode}]`,
    {
      filter: (ctx: CometContext) => hasDexLiquidation(ctx).then((ok) => ok && hasCollateralCount(ctx, 5)),
    },
    async ({ actors }, context, world) => {
      const { albert, betty } = actors;
      const r = await runDexLiquidation(context, world, albert, betty, { mode, count: 5, decide: validButIgnored, pauseRoute: true });
      await assertPausedAbsorb(r, mode);
      return r.receipt;
    }
  );
}
