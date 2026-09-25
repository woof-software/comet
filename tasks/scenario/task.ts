import { task } from 'hardhat/config';
import { runScenarios } from '../../plugins/scenario/Runner';
import hreForBase from '../../plugins/scenario/utils/hreForBase';
import '../../plugins/scenario/type-extensions';
import { ForkSpec } from '../../plugins/scenario/World';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeploymentManager } from '../../plugins/deployment_manager/DeploymentManager';
import { runMultistream } from '../../scripts/multistream/run';

export function getBasesFromTaskArgs(givenBases: string | undefined, env: HardhatRuntimeEnvironment): ForkSpec[] {
  let bases: ForkSpec[] = env.config.scenario.bases;
  if (givenBases) {
    let baseMap = Object.fromEntries(env.config.scenario.bases.map((base) => [base.name, base]));
    bases = givenBases.split(',').map((baseName) => {
      let base = baseMap[baseName];
      if (!base) {
        throw new Error(`Unknown base: ${baseName}`);
      }
      return base;
    });
  }

  return bases;
}

task('scenario', 'Runs scenario tests')
  .addOptionalParam('bases', 'Bases to run on [defaults to all]')
  .addOptionalParam('glob', 'Scenario files glob [default: scenario/**.ts]')
  .addOptionalParam('output', 'Path to write the JSON report [default: scenario-results.json]')
  .addFlag('spider', 'run spider persistently before scenarios')
  .setAction(async (taskArgs, env: HardhatRuntimeEnvironment) => {
    const bases: ForkSpec[] = getBasesFromTaskArgs(taskArgs.bases, env);
    if (taskArgs.spider) {
      await env.run('scenario:spider', taskArgs);
    }
    await runScenarios(bases, taskArgs.glob, taskArgs.output);
  });

task('scenario:multistream', 'Runs scenario streams in parallel, grouped by network')
  .addOptionalParam('bases', 'Bases to run on [defaults to all]')
  .addFlag('perBase', 'Shard streams per base instead of per network. Bypasses the bridged-deployment write-race protection')
  .setAction(async (taskArgs, env: HardhatRuntimeEnvironment) => {
    const bases: ForkSpec[] = getBasesFromTaskArgs(taskArgs.bases, env);
    await runMultistream(bases, taskArgs.perBase);
  });

task('scenario:spider', 'Runs spider in preparation for scenarios')
  .addOptionalParam('bases', 'Bases to run on [defaults to all]')
  .setAction(async (taskArgs, env) => {
    const bases: ForkSpec[] = getBasesFromTaskArgs(taskArgs.bases, env);
    // Promise.allSettled, not Promise.all: an RPC/API hiccup on one base (e.g. a flaky
    // provider, an explorer API returning 500s) shouldn't abandon every other base's
    // in-flight spider — each base fails or succeeds independently, and we only throw
    // (failing this task) after every base has had its chance.
    const results = await Promise.allSettled(bases.map(async (base) => {
      if (base.network !== 'hardhat') {
        let hre = await hreForBase(base);
        let dm = new DeploymentManager(
          base.network,
          base.deployment,
          hre,
          {
            writeCacheToDisk: true,
          }
        );
        await dm.spider();
      }
    }));

    const failures = results
      .map((result, i) => ({ result, base: bases[i] }))
      .filter((entry): entry is { result: PromiseRejectedResult, base: ForkSpec } => entry.result.status === 'rejected');

    for (const { result, base } of failures) {
      console.error(`Spider failed for ${base.name}:`, result.reason);
    }

    if (failures.length > 0) {
      throw new Error(`Spider failed for ${failures.length}/${bases.length} base(s): ${failures.map(({ base }) => base.name).join(', ')}`);
    }
  });
