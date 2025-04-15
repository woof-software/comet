import {
  Deployed,
  DeploymentManager,
} from '../../../plugins/deployment_manager';
import { DeploySpec, deployComet } from '../../../src/deploy';

export default async function deploy(
  deploymentManager: DeploymentManager,
  deploySpec: DeploySpec
): Promise<Deployed> {
  const deployed = await deployContracts(deploymentManager, deploySpec);
  return deployed;
}

async function deployContracts(
  deploymentManager: DeploymentManager,
  deploySpec: DeploySpec
): Promise<Deployed> {
  const _trace = deploymentManager.tracer();

  const _USDT = await deploymentManager.existing('USDT', '0x6047828dc181963ba44974801FF68e538dA5eaF9', 'sonic');
  const _WS = await deploymentManager.existing('wS', '0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38', 'sonic');
  const _stS = await deploymentManager.existing('stS', '0xE5DA20F15420aD15DE0fa650600aFc998bbE3955', 'sonic');

  const _stSPriceFeed = await deploymentManager.deploy(
    'stS:priceFeed',
    'pricefeeds/PriceFeedWith4626Support.sol',
    [
      '0xE5DA20F15420aD15DE0fa650600aFc998bbE3955', // sUSDS / USD price feed
      '0xc76dFb89fF298145b417d221B2c747d84952e01d', // USDS / USD price feed
      8,                                            // decimals
      'stS / USD price feed',                       // description
    ],
    true
  );
  
  const l2CCIPRouter = await deploymentManager.existing(
    'l2CCIPRouter',
    '0xB4e1Ff7882474BB93042be9AD5E1fA387949B860',
    'sonic'
  );
  const l2CCIPOffRamp = await deploymentManager.existing(
    'l2CCIPOffRamp',
    '0x7c6963669EBFf136EE36c053EcF0089d59eE2287',
    'sonic'
  );
  const l2SonicBridge = await deploymentManager.existing(
    'l2SonicBridge',
    '0x9Ef7629F9B930168b76283AdD7120777b3c895b3',
    'sonic'
  );

  const _cometAdmin = await deploymentManager.fromDep('cometAdmin', 'sonic', 'usdc.e');
  const _cometFactory = await deploymentManager.fromDep('cometFactory', 'sonic', 'usdc.e');
  const _$configuratorImpl = await deploymentManager.fromDep('configurator:implementation', 'sonic', 'usdc.e');
  const _configurator = await deploymentManager.fromDep('configurator', 'sonic', 'usdc.e');
  const _rewards = await deploymentManager.fromDep('rewards', 'sonic', 'usdc.e');
  const bulker = await deploymentManager.fromDep('bulker', 'sonic', 'usdc.e');
  const localTimelock = await deploymentManager.fromDep('timelock', 'sonic', 'usdc.e');
  const bridgeReceiver = await deploymentManager.fromDep('bridgeReceiver', 'sonic', 'usdc.e');


  // Deploy Comet
  const deployed = await deployComet(deploymentManager, deploySpec, {}, true);


  return {
    ...deployed,
    bridgeReceiver,
    l2CCIPRouter,
    l2CCIPOffRamp,
    l2SonicBridge,
    bulker,
    localTimelock,
  };
}