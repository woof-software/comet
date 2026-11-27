import { CometContext } from '../context/CometContext';

// Compares two dotted versions part by part as numbers: < 0 if a is older, 0 if equal, > 0 if newer.
// A missing part counts as 0, so '1.2' equals '1.2.0'. A part that is not a number gives NaN, which fails any check
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Service patch 2 introduces:
//  - fractional supply caps: the asset list stores each supply cap in full, down to 1 wei,
//    instead of rounding it down to whole tokens
//  - strict collateral factor ordering: every collateral must satisfy BCF < LCF < LF <= MAX,
//    where a lower factor may be zero only when every factor below it is zero too
//  - configurable max supported utilization: governance sets the limit per market through the Configurator,
//    and Comet takes it from its configuration instead of a constant
export const SERVICE_PATCH_2_VERSION = '1.2.2';

/**
 * Filter for scenarios that cover service patch 2
 * @param ctx The Comet context
 * @returns true if the market's Comet reports the service patch 2 version or newer, false otherwise
 */
export async function servicePatch2(ctx: CometContext): Promise<boolean> {
  const comet = await ctx.getComet();
  return compareVersions(await comet.version(), SERVICE_PATCH_2_VERSION) >= 0;
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
      'function maxSupportedUtilization() external view returns (uint)',
    ]);

    // A Comet without the function reverts or returns nothing
    const result = await ethers.provider.call({
      to: comet.address,
      data: iface.getSighash('maxSupportedUtilization'),
    });

    return !!result && result !== '0x';
  } catch (e) {
    return false;
  }
}

/**
 * Filter for scenarios that cover the hashed asset list
 * @param ctx The Comet context
 * @returns true if the market still has to be moved to the hashed asset list: its Comet has no asset list, or the
 *  list does not answer configHash() with exactly 32 bytes, the same check the Configurator makes
 */
export async function isAssetListMigrationRequired(ctx: CometContext): Promise<boolean> {
  try {
    const comet = await ctx.getComet();
    const ethers = ctx.world.deploymentManager.hre.ethers;

    const iface = new ethers.utils.Interface([
      'function assetList() external view returns (address)',
      'function configHash() external view returns (bytes32)',
    ]);

    const [assetList] = iface.decodeFunctionResult(
      'assetList',
      await ethers.provider.call({ to: comet.address, data: iface.getSighash('assetList') })
    );
    const configHash = await ethers.provider.call({ to: assetList, data: iface.getSighash('configHash') });

    return ethers.utils.hexDataLength(configHash) !== 32;
  } catch (e) {
    return true;
  }
}
