import { scenario } from '../../context/CometContext';
import { CometContext } from '../../context/CometContext';
import { hasDexLiquidation, hasCollateralCount } from '../../utils';
import { LiquidationMode, runDexLiquidation, assertDexLiquidation } from './checks';

const MODES: LiquidationMode[] = ['partial', 'full'];

const single = (ctx: CometContext) => hasDexLiquidation(ctx).then((ok) => ok && hasCollateralCount(ctx, 1));
const fiveCollateral = (ctx: CometContext) => hasDexLiquidation(ctx).then((ok) => ok && hasCollateralCount(ctx, 5));

for (const mode of MODES) {
  scenario.only(
    `Comet#dexLiquidation > single collateral sold via 1Inch [${mode}]`,
    { filter: single },
    async ({ actors }, context, world) => {
      const { albert, betty } = actors;
      const r = await runDexLiquidation(context, world, albert, betty, { mode, count: 1, decide: () => 'oneinch' });
      await assertDexLiquidation(r, mode);
      return r.receipt;
    }
  );

  scenario.only(
    `Comet#dexLiquidation > single collateral sold via Uniswap [${mode}]`,
    { filter: single },
    async ({ actors }, context, world) => {
      const { albert, betty } = actors;
      const r = await runDexLiquidation(context, world, albert, betty, { mode, count: 1, decide: () => 'uniswap' });
      await assertDexLiquidation(r, mode);
      return r.receipt;
    }
  );

  scenario.only(
    `Comet#dexLiquidation > single collateral when 1Inch call fails, falls back to Uniswap [${mode}]`,
    { filter: single },
    async ({ actors }, context, world) => {
      const { albert, betty } = actors;
      const r = await runDexLiquidation(context, world, albert, betty, { mode, count: 1, decide: () => 'corrupt' });
      await assertDexLiquidation(r, mode);
      return r.receipt;
    }
  );

  scenario.only(
    `Comet#dexLiquidation > route-less collateral is absorbed [${mode}]`,
    { filter: fiveCollateral },
    async ({ actors }, context, world) => {
      const { albert, betty } = actors;
      const r = await runDexLiquidation(context, world, albert, betty, {
        mode,
        count: 1,
        pick: (hasRoute) => !hasRoute, // build a lone position out of the route-less collateral only
        decide: () => 'absorb',
      });
      await assertDexLiquidation(r, mode);
      return r.receipt;
    }
  );
}
