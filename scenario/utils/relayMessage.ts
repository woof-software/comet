import { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import relayPolygonMessage from './relayPolygonMessage.js';
import { relayArbitrumMessage, relayArbitrumCCTPMint } from './relayArbitrumMessage.js';
import relayBaseMessage from './relayBaseMessage.js';
import relayLineaMessage from './relayLineaMessage.js';
import relayOptimismMessage from './relayOptimismMessage.js';
import relayMantleMessage from './relayMantleMessage.js';
import { relayUnichainMessage, relayUnichainCCTPMint } from './relayUnichainMessage.js';
import relayScrollMessage from './relayScrollMessage.js';
import relayRoninMessage from './relayRoninMessage.js';

export default async function relayMessage(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  startingBlockNumber: number,
  tenderlyLogs?: any[]
) {
  const bridgeNetwork = bridgeDeploymentManager.network;
  console.log(`Relaying messages from ${governanceDeploymentManager.network} -> ${bridgeNetwork}`);
  let proposal;
  switch (bridgeNetwork) {
    case 'base':
      return await relayBaseMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
    case 'optimism':
      return await relayOptimismMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
    case 'mantle':
      return await relayMantleMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
    case 'unichain':
      proposal = await relayUnichainMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
      await relayUnichainCCTPMint(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
      return proposal;
    case 'polygon':
      return await relayPolygonMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
    case 'arbitrum':
      proposal = await relayArbitrumMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
      await relayArbitrumCCTPMint(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
      return proposal;
    case 'linea':
      return await relayLineaMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
    case 'scroll':
      return await relayScrollMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
    case 'ronin':
      return await relayRoninMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
    default:
      throw new Error(
        `No message relay implementation from ${bridgeNetwork} -> ${governanceDeploymentManager.network}`
      );
  }
}
