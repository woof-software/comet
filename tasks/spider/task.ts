import { task } from "hardhat/config";
import { ArgumentType } from "hardhat/types/arguments";
import type { NewTaskDefinition } from "hardhat/types/tasks";

const spiderTask = task(
  "spider",
  "Use Spider method to pull in contract configs"
)
  .addFlag({ name: "clean", description: "Deletes spider artifacts" })
  .addOption({
    name: "deployment",
    description: "The deployment to spider",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
    defaultValue: undefined,
  })
  .setAction(async () => import("./task-action.js"))
  .build();

const taskDefinitions: NewTaskDefinition[] = [spiderTask];

export default taskDefinitions;
