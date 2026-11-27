import { StaticConstraint, debug } from '../../plugins/scenario';
import { CometContext } from '../context/CometContext';
import { isAssetListMigrationRequired, migrateToAssetList } from '../utils';

// TEMP SOLUTION: remove together with migrateToAssetList, once the real asset list migration is prepared or executed
// on chain. Moves every market that still runs the V1 Configurator to the new Configurator and its asset list before
// any scenario runs, so all scenarios run against the new Configurator and asset list
export class AssetListMigrationConstraint<T extends CometContext> implements StaticConstraint<T> {
  async solve() {
    return async function (ctx: T): Promise<T> {
      if (await isAssetListMigrationRequired(ctx)) {
        debug(`[${ctx.world.base.name}] {AssetListMigrationConstraint} Migrating the market to the asset list`);
        const comet = await ctx.getComet();
        const admin = await ctx.world.impersonateAddress(await comet.governor(), { value: 20n ** 18n });
        await migrateToAssetList(ctx, admin);
      }
      return ctx;
    };
  }

  async check() {
    // ...
  }
}
