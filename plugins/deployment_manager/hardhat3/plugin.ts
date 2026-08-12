import type { HardhatPlugin } from 'hardhat/types/plugins';

import { definePlugin } from 'hardhat/plugins';

import '../type-extensions.js';

// Registers the local deployment-manager integration with Hardhat 3.
// The config hook resolves `deploymentManager` from hardhat.config.ts so it is available at runtime as `hre.config.deploymentManager`.
const deploymentManagerPlugin: HardhatPlugin = definePlugin({
  id: 'comet-deployment-manager',
  hookHandlers: {
    config: () => import('./config-hook.js'),
  },
});

export default deploymentManagerPlugin;
