import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { DeploymentManager } from "../../plugins/deployment_manager/DeploymentManager.js";
import type { ForkSpec } from "../../plugins/scenario/World.js";

interface ScenarioTaskArguments {
  bases?: string;
  glob?: string;
  output?: string;
  spider: boolean;
}

interface ScenarioSpiderTaskArguments {
  bases?: string;
}

interface ScenarioMultistreamTaskArguments {
  bases?: string;
  perBase: boolean;
}

async function hreForBase(
  ...args: Parameters<
    typeof import("../../plugins/scenario/utils/hreForBase.js").default
  >
) {
  const { default: createHreForBase } = await import(
    "../../plugins/scenario/utils/hreForBase.js"
  );
  return createHreForBase(...args);
}

async function runScenarios(
  ...args: Parameters<
    typeof import("../../plugins/scenario/Runner.js").runScenarios
  >
) {
  const { runScenarios: run } = await import(
    "../../plugins/scenario/Runner.js"
  );
  return run(...args);
}

export function getBasesFromTaskArgs(
  givenBases: string | undefined,
  env: HardhatRuntimeEnvironment
): ForkSpec[] {
  if (!givenBases) return env.config.scenario.bases;

  const baseMap = Object.fromEntries(
    env.config.scenario.bases.map((base) => [base.name, base])
  );
  return givenBases.split(",").map((baseName) => {
    const base = baseMap[baseName];
    if (!base) {
      throw new Error(`Unknown base: ${baseName}`);
    }
    return base;
  });
}

export const scenarioAction: NewTaskActionFunction<
  ScenarioTaskArguments
> = async (taskArguments, env) => {
  const bases = getBasesFromTaskArgs(taskArguments.bases, env);
  if (taskArguments.spider) {
    await env.tasks
      .getTask("scenario:spider")
      .run({ bases: taskArguments.bases });
  }
  await runScenarios(bases, taskArguments.glob, taskArguments.output);
};

export const scenarioMultistreamAction: NewTaskActionFunction<
  ScenarioMultistreamTaskArguments
> = async (taskArguments, env) => {
  const bases = getBasesFromTaskArgs(taskArguments.bases, env);
  const { runMultistream } = await import("../../scripts/multistream/run.js");
  await runMultistream(bases, taskArguments.perBase);
};

export const scenarioSpiderAction: NewTaskActionFunction<
  ScenarioSpiderTaskArguments
> = async (taskArguments, env) => {
  const bases = getBasesFromTaskArgs(taskArguments.bases, env);
  // Let every base finish before reporting failures from individual providers.
  const results = await Promise.allSettled(
    bases.map(async (base) => {
      if (base.network === "hardhat") return;

      const baseHre = await hreForBase(base);
      const dm = new DeploymentManager(base.network, base.deployment, baseHre, {
        writeCacheToDisk: true,
      });
      await dm.spider();
    })
  );
  const failures = results
    .map((result, i) => ({ result, base: bases[i] }))
    .filter(
      (entry): entry is { result: PromiseRejectedResult; base: ForkSpec } =>
        entry.result.status === "rejected"
    );

  for (const { result, base } of failures) {
    console.error(`Spider failed for ${base.name}:`, result.reason);
  }
  if (failures.length > 0) {
    throw new Error(
      `Spider failed for ${failures.length}/${bases.length} base(s): ${failures
        .map(({ base }) => base.name)
        .join(", ")}`
    );
  }
};
