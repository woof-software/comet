import { DeploymentManager } from '../../plugins/deployment_manager';
import { getRoots } from '../../plugins/deployment_manager/Roots';
import { OpenProposal } from '../context/Gov';
import { utils } from 'ethers';

const EXCLUDED_ROOTS = ['comptrollerV2', 'comet', 'configurator', 'rewards', 'bulker', 'cometFactory'];

const CCTP_DOMAIN_TO_NETWORK: Record<number, string> = {
  0: 'mainnet',
  2: 'optimism',
  3: 'arbitrum',
  6: 'base',
  7: 'polygon',
  10: 'unichain',
};

const ROOT_TO_NETWORK: Record<string, string> = {
  fxRoot: 'polygon',
  RootChainManager: 'polygon',
  arbitrumInbox: 'arbitrum',
  arbitrumL1GatewayRouter: 'arbitrum',
  baseL1CrossDomainMessenger: 'base',
  baseL1StandardBridge: 'base',
  baseL1USDSBridge: 'base',
  opL1CrossDomainMessenger: 'optimism',
  opL1StandardBridge: 'optimism',
  mantleL1CrossDomainMessenger: 'mantle',
  mantleL1StandardBridge: 'mantle',
  unichainL1CrossDomainMessenger: 'unichain',
  unichainL1StandardBridge: 'unichain',
  scrollMessenger: 'scroll',
  scrollL1USDCGateway: 'scroll',
  lineaMessageService: 'linea',
  lineaL1TokenBridge: 'linea',
  lineaL1USDCBridge: 'linea',
  l1CCIPRouter: 'ronin',
  l1TokenAdminRegistry: 'ronin',
  roninl1CCIPOnRamp: 'ronin',
  roninl1NativeBridge: 'ronin',
};

// openProposal.signatures[i] is always '' (propose() takes no signatures array),
// so match depositForBurn by its calldata selector instead.
const DEPOSIT_FOR_BURN_SIGNATURE = 'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)';
const DEPOSIT_FOR_BURN_SELECTOR = utils.id(DEPOSIT_FOR_BURN_SIGNATURE).slice(0, 10);

function parseCCTPNetworks(openProposal: OpenProposal, cctpAddress: string): string[] {
  const networks: string[] = [];
  const cctpLower = cctpAddress.toLowerCase();

  for (let i = 0; i < openProposal.targets.length; i++) {
    if (openProposal.targets[i].toLowerCase() !== cctpLower) continue;

    const calldata = openProposal.calldatas[i];
    if (utils.hexDataSlice(calldata, 0, 4) !== DEPOSIT_FOR_BURN_SELECTOR) continue;

    // destinationDomain is the second param (uint32); params start after the selector
    const decoded = utils.defaultAbiCoder.decode(['uint256', 'uint32'], utils.hexDataSlice(calldata, 4, 68));
    const domain = decoded[1];
    const network = CCTP_DOMAIN_TO_NETWORK[domain];
    if (network) networks.push(network);
  }
  return networks;
}

export async function getProposalUnderlyingNetworks(
  governanceDeploymentManager: DeploymentManager,
  openProposal: OpenProposal
): Promise<string[]> {
  const roots = await getRoots(governanceDeploymentManager.cache);
  const targets = openProposal.targets.map(t => t.toLowerCase());

  const networks = new Set<string>();
  for (const [alias, address] of roots) {
    if (EXCLUDED_ROOTS.includes(alias)) continue;

    if (alias === 'CCTPTokenMessenger' && targets.includes(address.toLowerCase())) {
      for (const net of parseCCTPNetworks(openProposal, address)) {
        networks.add(net);
      }
      continue;
    }

    const network = ROOT_TO_NETWORK[alias];
    if (network && targets.includes(address.toLowerCase())) {
      networks.add(network);
    }
  }
  return [...new Set(networks)];
}

export async function isBridgeProposal(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  openProposal: OpenProposal
) {
  const underlyingNetworks = await getProposalUnderlyingNetworks(governanceDeploymentManager, openProposal);
  const otherUnderlyingNetworks = underlyingNetworks.filter(n => n !== bridgeDeploymentManager.network);

  // Skip the relay attempt entirely when the proposal doesn't target this network.
  const bridgeManagers = underlyingNetworks.includes(bridgeDeploymentManager.network)
    ? [bridgeDeploymentManager]
    : [];

  // Other L2s are relayed only when the migration registered them (addBridgedDeploymentManager),
  // so unrelated open proposals don't fork and relay networks the scenario doesn't target.
  const registeredManagers = [...governanceDeploymentManager.bridgedDeploymentManagers.values()];
  for (const bridgeNetwork of otherUnderlyingNetworks) {
    if (bridgeNetwork === governanceDeploymentManager.network) {
      bridgeManagers.push(governanceDeploymentManager);
      continue;
    }
    const dm = registeredManagers.find((m) => m.network === bridgeNetwork);
    if (dm) {
      bridgeManagers.push(dm);
    } else {
      console.log(`[${governanceDeploymentManager.network} -> ${bridgeNetwork}] Proposal ${openProposal.id} not relayed: network not targeted by this scenario`);
    }
  }
  return bridgeManagers;
}

