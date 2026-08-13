import { task } from "hardhat/config";
import { ArgumentType } from "hardhat/types/arguments";
import type { NewTaskDefinition } from "hardhat/types/tasks";

const deployTask = task("deploy", "Deploys market")
  .addFlag({
    name: "simulate",
    description: "only simulates the blockchain effects",
  })
  .addFlag({ name: "noDeploy", description: "skip the actual deploy step" })
  .addFlag({ name: "noVerify", description: "do not verify any contracts" })
  .addFlag({
    name: "noVerifyImpl",
    description: "do not verify the impl contract",
  })
  .addFlag({ name: "overwrite", description: "overwrites cache" })
  .addOption({
    name: "deployment",
    description: "The deployment to deploy",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .setAction(async () => ({
    default: (await import("./task-actions.js")).deployAction,
  }))
  .build();

const publishTask = task(
  "publish",
  "Verifies a known contract at an address, given its args"
)
  .addOption({
    name: "address",
    description: "The address to publish",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .addOption({
    name: "deployment",
    description: "The deployment to use to verify",
    defaultValue: "",
  })
  .addVariadicArgument({
    name: "constructorArguments",
    description: "The contract args",
    defaultValue: [],
  })
  .setAction(async () => ({
    default: (await import("./task-actions.js")).publishAction,
  }))
  .build();

const generateMigrationTask = task("gen:migration", "Generates a new migration")
  .addPositionalArgument({ name: "name", description: "name of the migration" })
  .addOption({
    name: "deployment",
    description: "The deployment to generate the migration for",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .setAction(async () => ({
    default: (await import("./task-actions.js")).generateMigrationAction,
  }))
  .build();

const migrateTask = task("migrate", "Runs migration")
  .addPositionalArgument({
    name: "migration",
    description: "name of migration",
  })
  .addOption({
    name: "impersonate",
    description:
      "the governor will impersonate the passed account for proposals [only when simulating]",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .addOption({
    name: "deployment",
    description: "The deployment to apply the migration to",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .addFlag({
    name: "prepare",
    description: "runs preparation [defaults to true if enact not specified]",
  })
  .addFlag({ name: "enact", description: "enacts migration [implies prepare]" })
  .addFlag({
    name: "noEnacted",
    description: "do not write enacted to the migration script",
  })
  .addFlag({
    name: "simulate",
    description: "only simulates the blockchain effects",
  })
  .addFlag({
    name: "tenderly",
    description: "use tenderly to simulate the migration",
  })
  .addFlag({
    name: "overwrite",
    description: "overwrites artifact if exists, fails otherwise",
  })
  .setAction(async () => ({
    default: (await import("./task-actions.js")).migrateAction,
  }))
  .build();

const deployAndMigrateTask = task(
  "deploy_and_migrate",
  "Runs deploy and migration"
)
  .addPositionalArgument({
    name: "migration",
    description: "name of migration",
  })
  .addOption({
    name: "impersonate",
    description:
      "the governor will impersonate the passed account for proposals [only when simulating]",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .addFlag({
    name: "simulate",
    description: "only simulates the blockchain effects",
  })
  .addFlag({ name: "noDeploy", description: "skip the actual deploy step" })
  .addFlag({ name: "noVerify", description: "do not verify any contracts" })
  .addFlag({
    name: "noVerifyImpl",
    description: "do not verify the impl contract",
  })
  .addFlag({ name: "overwrite", description: "overwrites cache" })
  .addFlag({
    name: "prepare",
    description: "runs preparation [defaults to true if enact not specified]",
  })
  .addFlag({ name: "enact", description: "enacts migration [implies prepare]" })
  .addFlag({
    name: "noEnacted",
    description: "do not write enacted to the migration script",
  })
  .addOption({
    name: "deployment",
    description: "The deployment to deploy",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .setAction(async () => ({
    default: (await import("./task-actions.js")).deployAndMigrateAction,
  }))
  .build();

const taskDefinitions: NewTaskDefinition[] = [
  deployTask,
  publishTask,
  generateMigrationTask,
  migrateTask,
  deployAndMigrateTask,
];

export default taskDefinitions;
