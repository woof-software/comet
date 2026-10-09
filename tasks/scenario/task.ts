import { task } from "hardhat/config";
import { ArgumentType } from "hardhat/types/arguments";
import type { NewTaskDefinition } from "hardhat/types/tasks";

const scenarioTask = task("scenario", "Runs scenario tests")
  .addOption({
    name: "bases",
    description: "Bases to run on [defaults to all]",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .addOption({
    name: "glob",
    description: "Scenario files glob [default: scenario/**.ts]",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .addFlag({
    name: "spider",
    description: "run spider persistently before scenarios",
  })
  .addOption({
    name: "output",
    description: "Path to write the JSON report [default: scenario-results.json]",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .setAction(async () => ({
    default: (await import("./task-actions.js")).scenarioAction,
  }))
  .build();

const scenarioSpiderTask = task(
  "scenario:spider",
  "Runs spider in preparation for scenarios"
)
  .addOption({
    name: "bases",
    description: "Bases to run on [defaults to all]",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .setAction(async () => ({
    default: (await import("./task-actions.js")).scenarioSpiderAction,
  }))
  .build();

const scenarioMultistreamTask = task(
  "scenario:multistream",
  "Runs scenario streams in parallel, grouped by network"
)
  .addOption({
    name: "bases",
    description: "Bases to run on [defaults to all]",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .addFlag({
    name: "perBase",
    description:
      "Shard streams per base instead of per network. Bypasses the bridged-deployment write-race protection",
  })
  .setAction(async () => ({
    default: (await import("./task-actions.js")).scenarioMultistreamAction,
  }))
  .build();

const taskDefinitions: NewTaskDefinition[] = [
  scenarioTask,
  scenarioSpiderTask,
  scenarioMultistreamTask,
];

export default taskDefinitions;
