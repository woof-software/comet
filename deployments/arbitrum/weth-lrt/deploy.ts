import { Deployed, DeploymentManager } from '../../../plugins/deployment_manager';
import { DeploySpec, deployComet, exp } from '../../../src/deploy';

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

const MAINNET_TIMELOCK = '0x6d903f6003cca6255d85cca4d3b5e5146dc33925';

export default async function deploy(deploymentManager: DeploymentManager, deploySpec: DeploySpec): Promise<Deployed> {
  const trace = deploymentManager.tracer();
  const ethers = deploymentManager.hre.ethers;

  const ezETH = await deploymentManager.existing('ezETH', '0x2416092f143378750bb29b79eD961ab195CcEea5', 'arbitrum');
  const WETH = await deploymentManager.existing('WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'arbitrum');
  const COMP = await deploymentManager.existing('COMP', '0x354A6dA3fcde098F8389cad84b0182725c6C91dE', 'arbitrum');

  const wethConstantPriceFeed = await deploymentManager.deploy(
    'WETH:priceFeed',
    'pricefeeds/ConstantPriceFeed.sol',
    [
      8,                                             // decimals
      exp(1, 8)                                      // constantPrice
    ]
  );

  // Deploy scaling price feed for ezETH
  const ezETHScalingPriceFeed = await deploymentManager.deploy(
    'ezETH:priceFeed',
    'pricefeeds/ScalingPriceFeed.sol',
    [
      '0x11E1836bFF2ce9d6A5bec9cA79dc998210f3886d', // ezETH / ETH price feed
      8                                             // decimals
    ]
  );
  // Import shared contracts from the USDC.e market
  const cometAdmin = await deploymentManager.fromDep('cometAdmin', 'arbitrum', 'usdc.e');
  const cometFactory = await deploymentManager.fromDep('cometFactory', 'arbitrum', 'usdc.e');
  const $configuratorImpl = await deploymentManager.fromDep('configurator:implementation', 'arbitrum', 'usdc.e');
  const configurator = await deploymentManager.fromDep('configurator', 'arbitrum', 'usdc.e');
  const rewards = await deploymentManager.fromDep('rewards', 'arbitrum', 'usdc.e');
  const bulker = await deploymentManager.fromDep('bulker', 'arbitrum', 'usdc.e');
  const localTimelock = await deploymentManager.fromDep('timelock', 'arbitrum', 'usdc.e');
  const bridgeReceiver = await deploymentManager.fromDep('bridgeReceiver', 'arbitrum', 'usdc.e');

  // Deploy Comet
  const deployed = await deployComet(deploymentManager, deploySpec);

  return {
    ...deployed,
    bridgeReceiver,
    bulker,
    rewards,
    COMP
  };
}