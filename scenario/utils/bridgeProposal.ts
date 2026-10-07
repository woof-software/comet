import type { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import { BridgedProposalState } from '../context/Gov.js';
import type { OpenBridgedProposal } from '../context/Gov.js';
import { toNumber } from 'ethers';
import { getHardhatEthers } from '../../plugins/deployment_manager/hardhat3/runtime.js';
import { fetchLogs } from '../utils/index.js';
import { setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils.js';

export async function getOpenBridgedProposals(
  deploymentManager: DeploymentManager,
): Promise<OpenBridgedProposal[]> {
  const receiver = await deploymentManager.contract('bridgeReceiver');
  if (receiver === undefined) return [];
  const timelockBuf = deploymentManager.network === 'ronin' ? 500 : 500_000; // XXX using a high value because Arbitrum has fast block times
  const searchBlocks = timelockBuf;
  const { provider } = await getHardhatEthers(deploymentManager.hre);
  const block = await provider.getBlockNumber();
  const filter = receiver.filters.ProposalCreated();
  const logs = await fetchLogs(receiver, filter, Math.max(0, block - searchBlocks), block);
  const proposals: OpenBridgedProposal[] = [];
  if (logs) {
    for (let log of logs) {
      if (!('args' in log)) continue;
      const [, id, , , , , eta] = log.args;
      const state = toNumber(await receiver.getFunction('state')(id));
      if ([BridgedProposalState.Queued].includes(state)) {
        proposals.push({ id, eta });
      }
    }
  }
  return proposals;
}

export async function executeBridgedProposal(
  deploymentManager: DeploymentManager,
  proposal: OpenBridgedProposal,
) {
  const receiver = await deploymentManager.getContractOrThrow('bridgeReceiver');
  const { id, eta } = proposal;

  const { provider } = await getHardhatEthers(deploymentManager.hre);
  const blockNow = await provider.getBlock('latest');
  if (!blockNow) throw new Error('Latest bridge block not found');
  // fast forward l2 time
  await setNextBlockTimestamp(deploymentManager, Math.max(toNumber(eta) + 1, blockNow.timestamp + 1));

  // execute queued proposal
  await setNextBaseFeeToZero(deploymentManager);
  await receiver.getFunction('executeProposal')(id, { gasPrice: 0 });
}
