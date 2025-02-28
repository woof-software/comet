import { Deployed, DeploymentManager } from '../../../plugins/deployment_manager';
import { DeploySpec, deployComet } from '../../../src/deploy';

const sUSDS_TO_USDS_PRICE_FEED_ADDRESS = '0x2483326d19f780Fb082f333Fe124e4C075B207ba';
const USDE_TO_USD_PRICE_FEED_ADDRESS = '0x37833E5b3fbbEd4D613a3e0C354eF91A42B81eeB';

export default async function deploy(deploymentManager: DeploymentManager, deploySpec: DeploySpec): Promise<Deployed> {
  // pull in existing assets
  // USDC native
  const _USDS = await deploymentManager.existing('USDS', '0x6491c05A82219b8D1479057361ff1654749b876b', 'arbitrum');
  const _sUSDS = await deploymentManager.existing('sUSDS', '0xdDb46999F8891663a8F2828d25298f70416d7610', 'arbitrum');
  
  const _usdsPriceFeed = await deploymentManager.deploy(
    'sUSDS:priceFeed',
    'pricefeeds/MultiplicativePriceFeed.sol',
    [
      sUSDS_TO_USDS_PRICE_FEED_ADDRESS, // sUSDS / USDS price feed
      USDE_TO_USD_PRICE_FEED_ADDRESS,   // USDS / USD price feed
      8,                                // decimals
      'sUSDS / USD price feed'   // description
    ],
    true
  );
  
  const _ARB = await deploymentManager.existing('ARB', '0x912ce59144191c1204e64559fe8253a0e49e6548', 'arbitrum');
  const _GMX = await deploymentManager.existing('GMX', '0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a', 'arbitrum');
  const _WETH = await deploymentManager.existing('WETH', '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', 'arbitrum');
  const _WBTC = await deploymentManager.existing('WBTC', '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', 'arbitrum');
  const COMP = await deploymentManager.existing('COMP', '0x354A6dA3fcde098F8389cad84b0182725c6C91dE', 'arbitrum');

  // Import shared contracts from the USDC.e market
  const _cometAdmin = await deploymentManager.fromDep('cometAdmin', 'arbitrum', 'usdc.e');
  const _cometFactory = await deploymentManager.fromDep('cometFactory', 'arbitrum', 'usdc.e');
  const _$configuratorImpl = await deploymentManager.fromDep('configurator:implementation', 'arbitrum', 'usdc.e');
  const _configurator = await deploymentManager.fromDep('configurator', 'arbitrum', 'usdc.e');
  const rewards = await deploymentManager.fromDep('rewards', 'arbitrum', 'usdc.e');
  const bulker = await deploymentManager.fromDep('bulker', 'arbitrum', 'usdc.e');
  const _localTimelock = await deploymentManager.fromDep('timelock', 'arbitrum', 'usdc.e');
  const bridgeReceiver = await deploymentManager.fromDep('bridgeReceiver', 'arbitrum', 'usdc.e');

  // Deploy Comet
  const deployed = await deployComet(deploymentManager, deploySpec, {}, true);

  return {
    ...deployed,
    bridgeReceiver, 
    bulker, 
    rewards,
    COMP
  };
}