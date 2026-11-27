import { StaticConstraint, Solution, World, debug } from '../../plugins/scenario';
import { basename, resolve } from 'path';
import { CometContext, MigrationData } from '../context/CometContext';
import { Migration, loadMigration } from '../../plugins/deployment_manager/Migration';
import { readMigrationRegistry } from '../../plugins/deployment_manager/MigrationRegistry';
import { modifiedPaths } from '../utils';
import { impersonateAddress } from '../../plugins/scenario/utils';
import { exp } from '../../test/helpers';

async function getMigrations<T>(world: World): Promise<Migration<T>[]> {
  // TODO: make this configurable from cli params/env var?
  const dm = world.deploymentManager;
  const govDm = world.auxiliaryDeploymentManager || dm;
  const pattern = new RegExp(`deployments/${dm.network}/${dm.deployment}/migrations/.*.ts`);
  const registry = await readMigrationRegistry(dm.cache.getFilePath({ rel: 'migrations.json' }));
  const migrations: Migration<T>[] = [];
  for (const path of await modifiedPaths(pattern)) {
    const name = basename(path, '.ts');
    const entry = registry.get(name);
    if (entry?.status === 'needs-review') {
      throw new Error(`Migration ${name} needs review before running its scenario`);
    }
    if (entry && entry.status !== 'pending') {
      debug(`[${world.base.name}] Skipping migration ${name}: ${entry.status}`);
      continue;
    }

    const migration = await loadMigration(resolve(path));
    if (!entry && await migration.actions.enacted?.(dm, govDm)) continue;
    migrations.push(migration);
  }
  return migrations;
}

export class MigrationConstraint<T extends CometContext> implements StaticConstraint<T> {
  async solve(world: World) {
    const label = `[${world.base.name}] {MigrationConstraint}`;
    const solutions: Solution<T>[] = [];
    const migrationPaths = [await getMigrations(world)];

    for (const migrationList of migrationPaths) {
      if (migrationList.length == 0 && migrationPaths.length > 1) {
        if (!process.env['WITHOUT_MIGRATIONS']) {
          debug(`${label} Skipping empty migration`);
          continue;
        }
      }
      solutions.push(async function (ctx: T): Promise<T> {
        const govDeploymentManager = ctx.world.auxiliaryDeploymentManager || ctx.world.deploymentManager;
        const governor = await govDeploymentManager.getContractOrThrow('governor');
        const compWhale = (await ctx.getCompWhales())[0];
        const proposer = await impersonateAddress(govDeploymentManager, compWhale, exp(1, 18)); // give them enough ETH to make the proposal

        // Make proposer the default signer
        govDeploymentManager._signers.unshift(proposer);

        // Order migrations deterministically and store in the context (i.e. for verification)
        const migrations = migrationList.sort((a, b) => a.name.localeCompare(b.name)).map(m => <MigrationData>({ migration: m }));
        ctx.migrations = migrations;

        debug(`${label} Running scenario with migrations: ${JSON.stringify(migrations.map((m) => m.migration.name))}`);
        for (const migrationData of migrations) {
          const migration = migrationData.migration;
          const artifact = await migration.actions.prepare(ctx.world.deploymentManager, govDeploymentManager);
          debug(`${label} Prepared migration ${migration.name}.\n  Artifact\n-------\n\n${JSON.stringify(artifact, null, 2)}\n-------\n`);
          migrationData.preMigrationBlockNumber = await ctx.world.deploymentManager.hre.ethers.provider.getBlockNumber();
          const lastProposalBefore = await governor.proposalCount();
          await migration.actions.enact(ctx.world.deploymentManager, govDeploymentManager, artifact);
          const lastProposalAfter = await governor.proposalCount();
          // Store the latest proposal id if one was created by this migration
          if (lastProposalAfter > lastProposalBefore) {
            migrationData.lastProposal = lastProposalAfter.toNumber();
          }
          debug(`${label} Enacted migration ${migration.name}`);
        }

        // Remove proposer from signers
        govDeploymentManager._signers.shift();

        return ctx;
      });
    }

    return solutions;
  }

  async check() {
    return; // XXX
  }
}
