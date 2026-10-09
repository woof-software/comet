import { execSync } from "node:child_process";

import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { DeploymentManager } from "../../plugins/deployment_manager/DeploymentManager.js";
import { getDefaultConnection } from "../../plugins/deployment_manager/hardhat3/runtime.js";

interface SpiderTaskArguments {
  clean: boolean;
  deployment?: string;
}

function deleteSpiderArtifacts() {
  [
    "rm -rf deployments/*/.contracts",
    "rm deployments/*/*/aliases.json",
  ].forEach((command) => {
    console.log(command);
    execSync(command);
  });
}

const spiderAction: NewTaskActionFunction<SpiderTaskArguments> = async (
  { clean, deployment },
  hre
) => {
  const network = (await getDefaultConnection(hre)).networkName;

  if (clean) {
    deleteSpiderArtifacts();
    return;
  }

  if (!deployment) {
    throw new Error("missing argument --deployment");
  }

  const dm = new DeploymentManager(network, deployment, hre, {
    writeCacheToDisk: true,
  });
  await dm.spider();
};

export default spiderAction;
