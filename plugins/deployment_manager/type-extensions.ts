import 'hardhat/types/config';
import type { RelationConfigMap } from './RelationConfig.js';

export interface DeploymentManagerConfig {
  relationConfigMap?: RelationConfigMap;
  networks?: {
    [network: string]: {
      [deployment: string]: RelationConfigMap;
    };
  };
}

declare module 'hardhat/types/config' {
  interface HardhatUserConfig {
    deploymentManager?: DeploymentManagerConfig;
  }

  interface HardhatConfig {
    deploymentManager: DeploymentManagerConfig;
  }
}
