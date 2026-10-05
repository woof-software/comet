import { DeploymentManager } from '../../plugins/deployment_manager';
import relayPolygonMessage from './relayPolygonMessage';
import { relayArbitrumMessage, relayArbitrumCCTPMint, simulateL2ToL1TokenBridging } from './relayArbitrumMessage';
import relayBaseMessage,{ simulateL2ToL1TokenBridging as simulateBaseL2ToL1TokenBridging} from './relayBaseMessage';
import relayLineaMessage from './relayLineaMessage';
import relayOptimismMessage, { simulateL2ToL1TokenBridging as simulateOptimismL2ToL1TokenBridging } from './relayOptimismMessage';
import relayMantleMessage, { simulateL2ToL1TokenBridging as simulateMantleL2ToL1TokenBridging } from './relayMantleMessage';
import { relayUnichainMessage, relayUnichainCCTPMint } from './relayUnichainMessage';
import relayScrollMessage, { simulateL2ToL1USDCBridging } from './relayScrollMessage';
import relayRoninMessage from './relayRoninMessage';

const L2_BLOCK_BUFFER = 5;

export default async function relayMessage(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  startingBlockNumber: number,
  tenderlyLogs?: any[]
) {
  const bridgeNetwork = bridgeDeploymentManager.network;
  if(bridgeNetwork === governanceDeploymentManager.network) return; // no need to relay if the proposal is on the same network
  console.log(`Relaying messages from ${governanceDeploymentManager.network} -> ${bridgeNetwork}`);
  let proposal;
  switch (bridgeNetwork) {
    case 'base': {
      const l2StartingBlockNumber = Math.max(0, await bridgeDeploymentManager.hre.ethers.provider.getBlockNumber() - L2_BLOCK_BUFFER);
      proposal = await relayBaseMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
      await simulateBaseL2ToL1TokenBridging(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        l2StartingBlockNumber,
        tenderlyLogs,
        proposal?.map(p => p.id)
      );
      return proposal;
    }
    case 'optimism': {
      const l2StartingBlockNumber = Math.max(0, await bridgeDeploymentManager.hre.ethers.provider.getBlockNumber() - L2_BLOCK_BUFFER);
      proposal = await relayOptimismMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
      await simulateOptimismL2ToL1TokenBridging(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        l2StartingBlockNumber,
        tenderlyLogs,
        proposal?.map(p => p.id)
      );
      return proposal;
    }
    case 'mantle': {
      const l2StartingBlockNumber = Math.max(0, await bridgeDeploymentManager.hre.ethers.provider.getBlockNumber() - L2_BLOCK_BUFFER);
      proposal = await relayMantleMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
      await simulateMantleL2ToL1TokenBridging(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        l2StartingBlockNumber,
        tenderlyLogs,
        proposal?.map(p => p.id)
      );
      return proposal;
    }
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
    case 'arbitrum': {
      const l2StartingBlockNumber = Math.max(0, await bridgeDeploymentManager.hre.ethers.provider.getBlockNumber() - L2_BLOCK_BUFFER);
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
      await simulateL2ToL1TokenBridging(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        l2StartingBlockNumber,
        tenderlyLogs,
        proposal?.map(p => p.id)
      );
      return proposal;
    }
    case 'linea':
      return await relayLineaMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
    case 'scroll': {
      // Only blocks mined by this relay, so earlier proposals' withdrawals aren't finalized again.
      const l2StartingBlockNumber = await bridgeDeploymentManager.hre.ethers.provider.getBlockNumber() + 1;
      proposal = await relayScrollMessage(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        startingBlockNumber,
        tenderlyLogs
      );
      await simulateL2ToL1USDCBridging(
        governanceDeploymentManager,
        bridgeDeploymentManager,
        l2StartingBlockNumber,
        tenderlyLogs
      );
      return proposal;
    }
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
