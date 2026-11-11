import relationConfigMap from '../../../deployments/relations';
import arbitrumBridgedUsdcRelationConfigMap from '../../../deployments/arbitrum/usdc.e/relations';
import arbitrumNativeUsdcRelationConfigMap from '../../../deployments/arbitrum/usdc/relations';
import arbitrumUsdtRelationConfigMap from '../../../deployments/arbitrum/usdt/relations';
import arbitrumWETHRelationConfigMap from '../../../deployments/arbitrum/weth/relations';
import baseAeroRelationConfigMap from '../../../deployments/base/aero/relations';
import baseUsdcRelationConfigMap from '../../../deployments/base/usdc/relations';
import baseUsdbcRelationConfigMap from '../../../deployments/base/usdbc/relations';
import baseUSDSRelationConfigMap from '../../../deployments/base/usds/relations';
import baseWethRelationConfigMap from '../../../deployments/base/weth/relations';
import lineaUsdcRelationConfigMap from '../../../deployments/linea/usdc/relations';
import lineaWethRelationConfigMap from '../../../deployments/linea/weth/relations';
import mainnetRelationConfigMap from '../../../deployments/mainnet/usdc/relations';
import mainnetUsdsRelationConfigMap from '../../../deployments/mainnet/usds/relations';
import mainnetUsdtRelationConfigMap from '../../../deployments/mainnet/usdt/relations';
import mainnetWbtcRelationConfigMap from '../../../deployments/mainnet/wbtc/relations';
import mainnetWethRelationConfigMap from '../../../deployments/mainnet/weth/relations';
import mainnetWstETHRelationConfigMap from '../../../deployments/mainnet/wsteth/relations';
import mantleRelationConfigMap from '../../../deployments/mantle/usde/relations';
import optimismRelationConfigMap from '../../../deployments/optimism/usdc/relations';
import optimismUsdtRelationConfigMap from '../../../deployments/optimism/usdt/relations';
import optimismWethRelationConfigMap from '../../../deployments/optimism/weth/relations';
import polygonRelationConfigMap from '../../../deployments/polygon/usdc/relations';
import polygonUsdtRelationConfigMap from '../../../deployments/polygon/usdt/relations';
import roninRelationConfigMap from '../../../deployments/ronin/weth/relations';
import roninWronRelationConfigMap from '../../../deployments/ronin/wron/relations';
import scrollRelationConfigMap from '../../../deployments/scroll/usdc/relations';
import unichainRelationConfigMap from '../../../deployments/unichain/usdc/relations';
import unichainWETHRelationConfigMap from '../../../deployments/unichain/weth/relations';

import type { DeploymentManagerConfig } from '../type-extensions';

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
