import { ScenarioConfig } from './config/types';
import { commonConfig } from './config/common';
import { transferConfig } from './config/transfer';
import { withdrawConfig } from './config/withdraw';
import { supplyConfig } from './config/supply';
import { bulkerConfig } from './config/bulker';
import { liquidationConfig } from './config/liquidation';
import { rewardsConfig } from './config/rewards';
import { authorizationConfig } from './config/authorization';
import { governanceConfig } from './config/governance';
import { interestRateConfig } from './config/interestRate';
import { configuratorConfig } from './config/configurator';
import { liquidationBotConfig } from './config/liquidationBot';
import { mainnetBulkerConfig } from './config/mainnetBulker';
import { v2Config } from './config/v2';
import { assetsConfig } from './config/assets';
import { applyNetworkOverrides } from './config/networks';
import { CometContext } from '../context/CometContext';
import cloneDeep from 'lodash/cloneDeep';

function createDefaultConfig(): ScenarioConfig {
  return {
    common: commonConfig,
    transfer: transferConfig,
    withdraw: withdrawConfig,
    supply: supplyConfig,
    bulker: bulkerConfig,
    liquidation: liquidationConfig,
    rewards: rewardsConfig,
    authorization: authorizationConfig,
    governance: governanceConfig,
    interestRate: interestRateConfig,
    configurator: configuratorConfig,
    liquidationBot: liquidationBotConfig,
    mainnetBulker: mainnetBulkerConfig,
    pauseGuardian: {},
    withdrawReserves: {},
    compoundV2: v2Config,
    assets: assetsConfig,
    comet: {},
  };
}

export function getConfigForScenario(ctx: CometContext): ScenarioConfig {
  const config = cloneDeep(createDefaultConfig());
  return applyNetworkOverrides(config, ctx);
}

export * from './config/types';