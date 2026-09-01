import type { ConfigHooks } from 'hardhat/types/hooks';

import type { DeploymentManagerConfig } from '../type-extensions.js';

export default async (): Promise<Partial<ConfigHooks>> => ({
  async resolveUserConfig(userConfig, resolveConfigurationVariable, next) {
    const resolvedConfig = await next(userConfig, resolveConfigurationVariable);

    return {
      ...resolvedConfig,
      deploymentManager:
        (userConfig.deploymentManager as DeploymentManagerConfig | undefined) ?? {},
      scenario: userConfig.scenario ?? { bases: [] },
    };
  },
});
