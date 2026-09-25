import { CometContext } from '../context/CometContext';

// Service patch 2 introduces:
//  - fractional supply caps: the asset list stores each supply cap in full, down to 1 wei,
//    instead of rounding it down to whole tokens
//  - strict collateral factor ordering: every collateral must satisfy BCF < LCF < LF <= MAX,
//    where a lower factor may be zero only when every factor below it is zero too
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

/**
 * Filter for scenarios that cover service patch (1): the Comet exposes MAX_SUPPORTED_UTILIZATION,
 * which only exists from that patch on
 * @param ctx The Comet context
 * @returns true if the market's Comet has MAX_SUPPORTED_UTILIZATION, false otherwise
 */
export async function servicePatch(ctx: CometContext): Promise<boolean> {
  try {
    const comet = await ctx.getComet();
    const ethers = ctx.world.deploymentManager.hre.ethers;

    const iface = new ethers.utils.Interface([
      'function MAX_SUPPORTED_UTILIZATION() external view returns (uint)',
    ]);

    // A Comet without the function reverts or returns nothing
    const result = await ethers.provider.call({
      to: comet.address,
      data: iface.getSighash('MAX_SUPPORTED_UTILIZATION'),
    });

    return !!result && result !== '0x';
  } catch (e) {
    return false;
  }
}
