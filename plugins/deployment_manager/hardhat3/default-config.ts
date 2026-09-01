import relationConfigMap from '../../../deployments/relations.js';
import arbitrumBridgedUsdcRelationConfigMap from '../../../deployments/arbitrum/usdc.e/relations.js';
import arbitrumNativeUsdcRelationConfigMap from '../../../deployments/arbitrum/usdc/relations.js';
import arbitrumUsdtRelationConfigMap from '../../../deployments/arbitrum/usdt/relations.js';
import arbitrumWETHRelationConfigMap from '../../../deployments/arbitrum/weth/relations.js';
import baseAeroRelationConfigMap from '../../../deployments/base/aero/relations.js';
import baseUsdcRelationConfigMap from '../../../deployments/base/usdc/relations.js';
import baseUsdbcRelationConfigMap from '../../../deployments/base/usdbc/relations.js';
import baseUSDSRelationConfigMap from '../../../deployments/base/usds/relations.js';
import baseWethRelationConfigMap from '../../../deployments/base/weth/relations.js';
import lineaUsdcRelationConfigMap from '../../../deployments/linea/usdc/relations.js';
import lineaWethRelationConfigMap from '../../../deployments/linea/weth/relations.js';
import mainnetRelationConfigMap from '../../../deployments/mainnet/usdc/relations.js';
import mainnetUsdsRelationConfigMap from '../../../deployments/mainnet/usds/relations.js';
import mainnetUsdtRelationConfigMap from '../../../deployments/mainnet/usdt/relations.js';
import mainnetWbtcRelationConfigMap from '../../../deployments/mainnet/wbtc/relations.js';
import mainnetWethRelationConfigMap from '../../../deployments/mainnet/weth/relations.js';
import mainnetWstETHRelationConfigMap from '../../../deployments/mainnet/wsteth/relations.js';
import mantleRelationConfigMap from '../../../deployments/mantle/usde/relations.js';
import optimismRelationConfigMap from '../../../deployments/optimism/usdc/relations.js';
import optimismUsdtRelationConfigMap from '../../../deployments/optimism/usdt/relations.js';
import optimismWethRelationConfigMap from '../../../deployments/optimism/weth/relations.js';
import polygonRelationConfigMap from '../../../deployments/polygon/usdc/relations.js';
import polygonUsdtRelationConfigMap from '../../../deployments/polygon/usdt/relations.js';
import roninRelationConfigMap from '../../../deployments/ronin/weth/relations.js';
import roninWronRelationConfigMap from '../../../deployments/ronin/wron/relations.js';
import scrollRelationConfigMap from '../../../deployments/scroll/usdc/relations.js';
import unichainRelationConfigMap from '../../../deployments/unichain/usdc/relations.js';
import unichainWETHRelationConfigMap from '../../../deployments/unichain/weth/relations.js';

import type { DeploymentManagerConfig } from '../type-extensions.js';

const deploymentManagerConfig: DeploymentManagerConfig = {
  relationConfigMap,
  networks: {
    mainnet: {
      usdc: mainnetRelationConfigMap,
      weth: mainnetWethRelationConfigMap,
      usdt: mainnetUsdtRelationConfigMap,
      wsteth: mainnetWstETHRelationConfigMap,
      usds: mainnetUsdsRelationConfigMap,
      wbtc: mainnetWbtcRelationConfigMap,
    },
    polygon: {
      usdc: polygonRelationConfigMap,
      usdt: polygonUsdtRelationConfigMap,
    },
    arbitrum: {
      'usdc.e': arbitrumBridgedUsdcRelationConfigMap,
      usdc: arbitrumNativeUsdcRelationConfigMap,
      usdt: arbitrumUsdtRelationConfigMap,
      weth: arbitrumWETHRelationConfigMap,
    },
    base: {
      usdbc: baseUsdbcRelationConfigMap,
      weth: baseWethRelationConfigMap,
      usdc: baseUsdcRelationConfigMap,
      aero: baseAeroRelationConfigMap,
      usds: baseUSDSRelationConfigMap,
    },
    optimism: {
      usdc: optimismRelationConfigMap,
      usdt: optimismUsdtRelationConfigMap,
      weth: optimismWethRelationConfigMap,
    },
    mantle: {
      usde: mantleRelationConfigMap,
    },
    unichain: {
      usdc: unichainRelationConfigMap,
      weth: unichainWETHRelationConfigMap,
    },
    scroll: {
      usdc: scrollRelationConfigMap,
    },
    ronin: {
      weth: roninRelationConfigMap,
      wron: roninWronRelationConfigMap,
    },
    linea: {
      usdc: lineaUsdcRelationConfigMap,
      weth: lineaWethRelationConfigMap,
    },
  },
};

export default deploymentManagerConfig;
