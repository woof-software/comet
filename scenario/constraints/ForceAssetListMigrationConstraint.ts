import { StaticConstraint, debug } from '../../plugins/scenario';
import { CometContext } from '../context/CometContext';
import { migrateToAssetList } from '../utils';
import { isAssetListMigrationRequired } from '../utils/versionControl';

// TEMP SOLUTION: to remove, delete this file and its two lines in scenario/context/CometContext.ts.
// Force-moves every market still on the V1 Configurator to the new Configurator and asset list, once per base,
// after the real migrations and open proposals, so every scenario runs on the new Configurator and asset list
export class ForceAssetListMigrationConstraint<T extends CometContext> implements StaticConstraint<T> {
  async solve() {
    return async function (ctx: T): Promise<T> {
      if (await isAssetListMigrationRequired(ctx)) {
        debug(`[${ctx.world.base.name}] {ForceAssetListMigrationConstraint} Migrating the market to the asset list`);
        const comet = await ctx.getComet();
        const governor = await ctx.world.impersonateAddress(await comet.governor(), { value: 10n ** 18n });
        await migrateToAssetList(ctx, governor);
      }
      return ctx;
    };
  }

  async check() {
    return;
  }
}
