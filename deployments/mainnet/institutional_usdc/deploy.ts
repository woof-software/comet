import { Deployed, DeploymentManager } from '../../../plugins/deployment_manager';
import { DeploySpec } from '../../../src/deploy';

// The institutional USDC market is already live on mainnet (see roots.json).
// Nothing is deployed here: the script only returns the existing contracts so
// scenario runs and `deploy` tasks treat the market as fully deployed.
export default async function deploy(deploymentManager: DeploymentManager, _deploySpec: DeploySpec): Promise<Deployed> {
  const aliases = ['comet', 'configurator', 'rewards', 'bulker'];
  const deployed: Deployed = {};
  for (const alias of aliases) {
    const contract = await deploymentManager.contract(alias);
    if (!contract) {
      throw new Error(`institutional_usdc: missing '${alias}' — run spider first`);
    }
    deployed[alias] = contract;
  }
  return deployed;
}
