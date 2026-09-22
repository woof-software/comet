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
  // Pull in existing assets
  const _WETH = await deploymentManager.existing(
    'WETH',
    '0x4200000000000000000000000000000000000006',
    'unichain'
  );
  const _weETH = await deploymentManager.existing(
    'weETH',
    '0x7DCC39B4d1C53CB31e1aBc0e358b43987FEF80f7',
    'unichain'
  );
  const _wstETH = await deploymentManager.existing(
    'wstETH',
    '0xc02fE7317D4eb8753a02c35fe019786854A92001',
    'unichain'
  );
  const _WBTC = await deploymentManager.existing(
    'WBTC',
    '0x927B51f251480a681271180DA4de28D44EC4AfB8',
    'unichain'
  );
  const _ezETH = await deploymentManager.existing(
    'ezETH',
    '0x2416092f143378750bb29b79eD961ab195CcEea5',
    'unichain'
  );
  const _UNI = await deploymentManager.existing(
    'UNI',
    '0x8f187aa05619a017077f5308904739877ce9ea21',
    'unichain'
  );
  const COMP = await deploymentManager.existing(
    'COMP',
    '0xdf78e4f0a8279942ca68046476919a90f2288656',
    'unichain'
  );

  // Import shared contracts from cUSDCv3
  const l2CrossDomainMessenger = await deploymentManager.fromDep('l2CrossDomainMessenger', 'unichain', 'usdc');
  const l2StandardBridge = await deploymentManager.fromDep('l2StandardBridge', 'unichain', 'usdc');
  const TokenMinter = await deploymentManager.fromDep('TokenMinter', 'unichain', 'usdc');

  const bulker = await deploymentManager.fromDep('bulker', 'unichain', 'usdc');
  const bridgeReceiver = await deploymentManager.fromDep('bridgeReceiver', 'unichain', 'usdc');

  // Deploy Comet
  const deployed = await deployComet(deploymentManager, deploySpec);

  return {
    ...deployed,
    bridgeReceiver,
    l2CrossDomainMessenger,
    l2StandardBridge,
    bulker,
    COMP,
    TokenMinter
  };
}
