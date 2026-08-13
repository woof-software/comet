import { fileURLToPath } from "node:url";

import type { HardhatConfig } from "hardhat/types/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { writeEnacted } from "../../plugins/deployment_manager/Enacted.js";
import { loadMigrations } from "../../plugins/deployment_manager/Migration.js";
import type { Migration } from "../../plugins/deployment_manager/Migration.js";
import { DeploymentManager } from "../../plugins/deployment_manager/index.js";
import type { VerifyArgs } from "../../plugins/deployment_manager/index.js";
import { getDefaultConnection } from "../../plugins/deployment_manager/hardhat3/runtime.js";

interface DeployTaskArguments {
  simulate: boolean;
  noDeploy: boolean;
  noVerify: boolean;
  noVerifyImpl: boolean;
  overwrite: boolean;
  deployment?: string;
}

interface PublishTaskArguments {
  address?: string;
  deployment: string;
  constructorArguments: string[];
}

interface GenerateMigrationTaskArguments {
  name: string;
  deployment?: string;
}

interface MigrateTaskArguments {
  migration: string;
  impersonate?: string;
  deployment?: string;
  prepare: boolean;
  enact: boolean;
  noEnacted: boolean;
  simulate: boolean;
  tenderly: boolean;
  overwrite: boolean;
}

interface DeployAndMigrateTaskArguments extends DeployTaskArguments {
  migration: string;
  impersonate?: string;
  prepare: boolean;
  enact: boolean;
  noEnacted: boolean;
}

function requireOption(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
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

// TODO: Don't depend on scenario's hreForBase
async function getForkEnv(
  env: HardhatRuntimeEnvironment,
  deployment: string
): Promise<HardhatRuntimeEnvironment> {
  const network = (await getDefaultConnection(env)).networkName;
  const base = env.config.scenario.bases.find(
    (b) => b.network === network && b.deployment === deployment
  );
  if (!base) {
    throw new Error(`No fork spec for ${network}-${deployment}`);
  }
  return hreForBase(base);
}

function getDefaultDeployment(config: HardhatConfig, network: string): string {
  const base = config.scenario.bases.find((b) => b.name === network);
  if (!base) {
    throw new Error(`No bases for ${network}`);
  }
  return base.deployment;
}

async function runMigration<T>(
  deploymentManager: DeploymentManager,
  govDeploymentManager: DeploymentManager,
  prepare: boolean,
  enact: boolean,
  migration: Migration<T>,
  overwrite: boolean,
  tenderly = false
) {
  await deploymentManager.cleanCache();
  console.log(`Reading artifact for migration: ${migration.name}`);
  let artifact: T = await deploymentManager.readArtifact(migration);
  if (prepare) {
    if (artifact && !overwrite) {
      throw new Error(
        "Artifact already exists for migration, please specify --overwrite to overwrite artifact."
      );
    }

    console.log("Running preparation step...");
    artifact = await migration.actions.prepare(
      deploymentManager,
      govDeploymentManager
    );
    console.log("Preparation artifact", artifact);
    const outputFile = await deploymentManager.storeArtifact(
      migration,
      artifact
    );
    if (deploymentManager.cache.writeCacheToDisk) {
      console.log(`Migration preparation artifact stored in ${outputFile}.`);
    } else {
      console.log(
        `Migration preparation artifact would have been stored in ${outputFile}, but not writing to disk in a simulation.`
      );
    }
  }

  if (enact) {
    console.log("Running enactment step...");
    const { governor, timelock } = await govDeploymentManager.getContracts();

    console.log("Running enact...");
    await migration.actions.enact(
      deploymentManager,
      govDeploymentManager,
      artifact
    );
    console.log("Enactment complete");

    if (tenderly) {
      const { tenderlyExecute } = await import("../../scenario/utils/index.js");
      await tenderlyExecute(
        govDeploymentManager,
        deploymentManager,
        governor,
        timelock
      );
    }
    await govDeploymentManager.cleanCache();
  }
}

async function verifyDeployment(
  dm: DeploymentManager,
  tag: string,
  simulate: boolean,
  noVerify: boolean,
  noVerifyImpl: boolean
) {
  const verify = !noVerify && !simulate;
  const desc = verify ? "Verify" : "Would verify";
  if (noVerify && simulate) return;

  await dm.verifyContracts(async (address, args) => {
    if (args.via === "buildfile") {
      const { contract: _, ...rest } = args;
      console.log(`[${tag}] ${desc} ${address}:`, rest);
    } else {
      console.log(`[${tag}] ${desc} ${address}:`, args);
    }
    return verify;
  });

  if (noVerifyImpl) return;

  const comet = await dm.contract("comet");
  const cometImpl = await dm.contract("comet:implementation");
  const configurator = await dm.contract("configurator");
  const config = await configurator.getConfiguration(await comet.getAddress());
  const implementationAddress = await cometImpl.getAddress();
  const args: VerifyArgs = {
    via: "artifacts",
    address: implementationAddress,
    constructorArguments: [config],
  };
  console.log(`[${tag}] ${desc} ${implementationAddress}:`, args);
  if (verify) {
    await dm.verifyContract(args);
  }
}

async function getGovernanceDeploymentManager(
  env: HardhatRuntimeEnvironment,
  dm: DeploymentManager,
  network: string,
  deployment: string,
  simulate: boolean,
  overwrite: boolean,
  saveBytecode = false
): Promise<DeploymentManager> {
  const base = env.config.scenario.bases.find(
    (b) => b.network === network && b.deployment === deployment
  );
  if (!base) {
    throw new Error(`No base for ${network}-${deployment}`);
  }

  const governanceBase =
    base.auxiliaryBase === undefined
      ? undefined
      : env.config.scenario.bases.find((b) => b.name === base.auxiliaryBase);

  if (!governanceBase) return dm;

  const governanceEnv = await hreForBase(governanceBase, simulate);
  const governanceDm = new DeploymentManager(
    governanceBase.network,
    governanceBase.deployment,
    governanceEnv,
    {
      writeCacheToDisk: !simulate || overwrite,
      verificationStrategy: "eager",
      saveBytecode,
    }
  );
  await governanceDm.spider();
  return governanceDm;
}

async function maybeImpersonate(
  governanceDm: DeploymentManager,
  impersonate: string | undefined,
  simulate: boolean
) {
  if (impersonate && !simulate) {
    throw new Error(
      "Cannot impersonate an address if not simulating a migration. Please specify --simulate to simulate."
    );
  }
  if (impersonate) {
    const { impersonateAddress } = await import(
      "../../plugins/scenario/utils/index.js"
    );
    const signer = await impersonateAddress(
      governanceDm,
      impersonate,
      10n ** 18n
    );
    governanceDm._signers.unshift(signer);
  }
}

function migrationPath(
  network: string,
  deployment: string,
  migrationName: string
): string {
  return fileURLToPath(
    new URL(
      `../../deployments/${network}/${deployment}/migrations/${migrationName}.ts`,
      import.meta.url
    )
  );
}

export const deployAction: NewTaskActionFunction<DeployTaskArguments> = async (
  taskArguments,
  env
) => {
  const { simulate, noDeploy, noVerify, noVerifyImpl, overwrite } =
    taskArguments;
  const deployment = requireOption(taskArguments.deployment, "deployment");
  const maybeForkEnv = simulate ? await getForkEnv(env, deployment) : env;
  const network = (await getDefaultConnection(env)).networkName;
  const tag = `${network}/${deployment}`;
  const dm = new DeploymentManager(network, deployment, maybeForkEnv, {
    writeCacheToDisk: !simulate || overwrite,
    verificationStrategy: simulate ? "lazy" : "eager",
  });

  if (!noDeploy) {
    try {
      const delta = await dm.runDeployScript({ allMissing: true });
      console.log(
        `[${tag}] Deployed ${dm.counter} contracts, spent ${dm.spent} Ξ`
      );
      console.log(`[${tag}]\n${dm.diffDelta(delta)}`);
    } catch (error) {
      console.log(`[${tag}] Failed to deploy with error: ${error}`);
    }
  }

  await verifyDeployment(dm, tag, simulate, noVerify, noVerifyImpl);
};

export const publishAction: NewTaskActionFunction<
  PublishTaskArguments
> = async (taskArguments, env) => {
  const address = requireOption(taskArguments.address, "address");
  const network = (await getDefaultConnection(env)).networkName;
  const deployment =
    taskArguments.deployment || getDefaultDeployment(env.config, network);
  const tag = `${network}/${deployment}`;
  const dm = new DeploymentManager(network, deployment, env);
  const args: VerifyArgs = {
    via: "artifacts",
    address,
    constructorArguments: taskArguments.constructorArguments,
  };
  console.log(`[${tag} ${address}:`, args);
  await dm.verifyContract(args);
};

export const generateMigrationAction: NewTaskActionFunction<
  GenerateMigrationTaskArguments
> = async (taskArguments, env) => {
  const deployment = requireOption(taskArguments.deployment, "deployment");
  const network = (await getDefaultConnection(env)).networkName;
  const dm = new DeploymentManager(network, deployment, env, {
    writeCacheToDisk: true,
    verificationStrategy: "lazy",
  });
  const file = await dm.generateMigration(taskArguments.name);
  console.log(`Generated migration ${network}/${deployment}/${file}`);
};

export const migrateAction: NewTaskActionFunction<
  MigrateTaskArguments
> = async (taskArguments, env) => {
  let { prepare, enact } = taskArguments;
  const {
    migration: migrationName,
    noEnacted,
    simulate,
    tenderly,
    overwrite,
    impersonate,
  } = taskArguments;
  const deployment = requireOption(taskArguments.deployment, "deployment");
  const network = (await getDefaultConnection(env)).networkName;
  const maybeForkEnv = simulate ? await getForkEnv(env, deployment) : env;
  const dm = new DeploymentManager(network, deployment, maybeForkEnv, {
    writeCacheToDisk: !simulate || overwrite,
    verificationStrategy: "eager",
    saveBytecode: tenderly,
  });

  await dm.spider();
  const governanceDm = await getGovernanceDeploymentManager(
    env,
    dm,
    network,
    deployment,
    simulate,
    overwrite,
    tenderly
  );
  await maybeImpersonate(governanceDm, impersonate, simulate);

  if (simulate) {
    console.log("Simulating migration without verification");
    dm.setVerificationStrategy("lazy");
    governanceDm.setVerificationStrategy("lazy");
  }

  const path = migrationPath(network, deployment, migrationName);
  console.log(`Loading migration from ${path}`);
  const [migration] = await loadMigrations([path]);
  if (!migration) {
    throw new Error(
      `Unknown migration for network ${network}/${deployment}: \`${migrationName}\`.`
    );
  }
  if (!prepare && !enact) prepare = true;

  await runMigration(
    dm,
    governanceDm,
    prepare,
    enact,
    migration,
    overwrite,
    tenderly
  );
  if (enact && !noEnacted) {
    await writeEnacted(migration, dm, true);
  }
};

export const deployAndMigrateAction: NewTaskActionFunction<
  DeployAndMigrateTaskArguments
> = async (taskArguments, env) => {
  let { prepare, enact } = taskArguments;
  const {
    migration: migrationName,
    noEnacted,
    simulate,
    overwrite,
    impersonate,
    noDeploy,
    noVerify,
    noVerifyImpl,
  } = taskArguments;
  const deployment = requireOption(taskArguments.deployment, "deployment");
  const maybeForkEnv = simulate ? await getForkEnv(env, deployment) : env;
  const network = (await getDefaultConnection(env)).networkName;
  const tag = `${network}/${deployment}`;
  const dm = new DeploymentManager(network, deployment, maybeForkEnv, {
    writeCacheToDisk: !simulate || overwrite,
    verificationStrategy: simulate ? "lazy" : "eager",
  });

  if (!noDeploy) {
    try {
      const delta = await dm.runDeployScript({ allMissing: true });
      console.log(
        `[${tag}] Deployed ${dm.counter} contracts, spent ${dm.spent} Ξ`
      );
      console.log(`[${tag}]\n${dm.diffDelta(delta)}`);
    } catch (error) {
      console.log(`[${tag}] Failed to deploy with error: ${error}`);
    }
  }

  await verifyDeployment(dm, tag, simulate, noVerify, noVerifyImpl);
  await dm.spider();

  const governanceDm = await getGovernanceDeploymentManager(
    env,
    dm,
    network,
    deployment,
    simulate,
    overwrite
  );
  await maybeImpersonate(governanceDm, impersonate, simulate);

  const path = migrationPath(network, deployment, migrationName);
  const [migration] = await loadMigrations([path]);
  if (!migration) {
    throw new Error(
      `Unknown migration for network ${network}/${deployment}: \`${migrationName}\`.`
    );
  }
  if (!prepare && !enact) prepare = true;

  await runMigration(dm, governanceDm, prepare, enact, migration, overwrite);
  if (enact && !noEnacted) {
    await writeEnacted(migration, dm, true);
  }
};
