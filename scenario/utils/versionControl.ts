import { CometContext } from '../context/CometContext';

// Service patch 2 introduces:
//  - configurable max supported utilization: governance sets the limit per market through the Configurator,
//    and Comet takes it from its configuration instead of a constant
export const SERVICE_PATCH_2_VERSION = '1.2.2';

/**
 * Filter for scenarios that cover service patch 2
 * @param ctx The Comet context
 * @returns true if the market's Comet reports the service patch 2 version, false otherwise
 */
export async function servicePatch2(ctx: CometContext): Promise<boolean> {
  const comet = await ctx.getComet();
  return (await comet.version()) === SERVICE_PATCH_2_VERSION;
}
