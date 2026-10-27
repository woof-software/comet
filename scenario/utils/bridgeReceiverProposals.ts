import { BigNumber, Contract, utils } from 'ethers';
import { DeploymentManager } from '../../plugins/deployment_manager';

const PROPOSAL_CREATED_TOPIC = utils.id('ProposalCreated(address,uint256,address[],uint256[],string[],bytes[],uint256)');

export interface DecodedProposalCreatedArgs {
  id: BigNumber;
  targets: string[];
  values: BigNumber[];
  signatures: string[];
  calldatas: string[];
  eta: any;
}

// Decoded L2 BridgeReceiver ProposalCreated events; proposalIds (L2-local) drops already-simulated proposals.
export async function fetchBridgeReceiverProposals(
  bridgeDeploymentManager: DeploymentManager,
  l2StartingBlockNumber?: number,
  proposalIds?: BigNumber[]
): Promise<{ bridgeReceiver: Contract, events: DecodedProposalCreatedArgs[] }> {
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');

  console.log('Fetching recent ProposalCreated events from BridgeReceiver...');
  const latestBlockNumber = await bridgeDeploymentManager.hre.ethers.provider.getBlockNumber();
  const logs = await bridgeDeploymentManager.retry(() =>
    bridgeDeploymentManager.hre.ethers.provider.getLogs({
      fromBlock: l2StartingBlockNumber ?? latestBlockNumber - 1000,
      toBlock: 'latest',
      address: bridgeReceiver.address,
      topics: [PROPOSAL_CREATED_TOPIC]
    })
  );
  const events = logs
    .map((log): DecodedProposalCreatedArgs => {
      const args = bridgeReceiver.interface.parseLog(log).args;
      // `values` is Array.prototype.values on an ethers Result, so it's read by position
      return { id: args.id, targets: args.targets, values: args[3], signatures: args.signatures, calldatas: args.calldatas, eta: args.eta };
    })
    .filter((event) => !proposalIds || proposalIds.some((id) => id.toString() === event.id.toString()));
  return { bridgeReceiver, events };
}
