import type { HardhatPlugin } from "hardhat/types/plugins";

import { definePlugin } from "hardhat/plugins";

import "../type-extensions.js";
import deploymentManagerTasks from "../../../tasks/deployment_manager/task.js";
import scenarioTasks from "../../../tasks/scenario/task.js";
import spiderTasks from "../../../tasks/spider/task.js";

// Registers the local deployment-manager integration with Hardhat 3.
// The config hook resolves `deploymentManager` from hardhat.config.ts so it is available at runtime as `hre.config.deploymentManager`.
const deploymentManagerPlugin: HardhatPlugin = definePlugin({
  id: "comet-deployment-manager",
  hookHandlers: {
    config: () => import("./config-hook.js"),
  },
  tasks: [...deploymentManagerTasks, ...scenarioTasks, ...spiderTasks],
});

export default deploymentManagerPlugin;
