import type { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import type { OpenProposal } from '../context/Gov.js';

export async function isBridgeProposal(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  openProposal: OpenProposal
) {
  const bridgeNetwork = bridgeDeploymentManager.network;
  console.log(`Checking if proposal ${openProposal.id} is a bridge proposal on ${bridgeNetwork}`);
  switch (bridgeNetwork) {
    case 'arbitrum': {
      const inbox = await governanceDeploymentManager.getContractOrThrow('arbitrumInbox');
      const l1GatewayRouter = await governanceDeploymentManager.getContractOrThrow(
        'arbitrumL1GatewayRouter'
      );
      const targets = openProposal.targets;
      return targets.includes(await inbox.getAddress()) || targets.includes(await l1GatewayRouter.getAddress());
    }
    case 'polygon': {
      const {
        fxRoot,
        RootChainManager
      } = await governanceDeploymentManager.getContracts();
      const bridgeAddresses = (await Promise.all([fxRoot, RootChainManager]
        .filter(x => x)
        .map(x => x.getAddress())))
        .map(address => address.toLowerCase());
      const targets = openProposal.targets;
      return targets.some(t => bridgeAddresses.includes(t.toLowerCase()));
    }
    case 'base': {
      const baseL1CrossDomainMessenger = await governanceDeploymentManager.getContractOrThrow(
        'baseL1CrossDomainMessenger'
      );
      const baseL1StandardBridge = await governanceDeploymentManager.getContractOrThrow(
        'baseL1StandardBridge'
      );
      const baseL1USDSBridge = await governanceDeploymentManager.getContractOrThrow(
        'baseL1USDSBridge'
      );
      const targets = openProposal.targets;
      const bridgeContracts = [await baseL1CrossDomainMessenger.getAddress(), await baseL1StandardBridge.getAddress(), await baseL1USDSBridge.getAddress()];

      return targets.some(t => bridgeContracts.includes(t));
    }
    case 'linea': {
      const lineaMessageService = await governanceDeploymentManager.getContractOrThrow(
        'lineaMessageService'
      );
      const lineaL1USDCBridge = await governanceDeploymentManager.getContractOrThrow(
        'lineaL1USDCBridge'
      );
      const lineaL1TokenBridge = await governanceDeploymentManager.getContractOrThrow(
        'lineaL1TokenBridge'
      );
      const bridgeContracts = [
        await lineaMessageService.getAddress(),
        await lineaL1USDCBridge.getAddress(),
        await lineaL1TokenBridge.getAddress()
      ];
      const targets = openProposal.targets;
      return targets.some(t => bridgeContracts.includes(t));
    }
    // case 'linea': {
    //   const governor = await governanceDeploymentManager.getContractOrThrow('governor');
    //   const lineaMessageService = await governanceDeploymentManager.getContractOrThrow(
    //     'lineaMessageService'
    //   );
    //   const { targets } = await governor.getActions(openProposal.id);
    //   return targets.includes(await lineaMessageService.getAddress());
    // }
    case 'optimism': {
      const opL1CrossDomainMessenger = await governanceDeploymentManager.getContractOrThrow(
        'opL1CrossDomainMessenger'
      );
      const opL1StandardBridge = await governanceDeploymentManager.getContractOrThrow(
        'opL1StandardBridge'
      );
      const targets = openProposal.targets;
      const bridgeContracts = [await opL1CrossDomainMessenger.getAddress(), await opL1StandardBridge.getAddress()];
      return targets.some(t => bridgeContracts.includes(t));
    }
    case 'mantle': {
      const mantleL1CrossDomainMessenger = await governanceDeploymentManager.getContractOrThrow(
        'mantleL1CrossDomainMessenger'
      );
      const mantleL1StandardBridge = await governanceDeploymentManager.getContractOrThrow(
        'mantleL1StandardBridge'
      );
      const targets = openProposal.targets;
      const bridgeContracts = [
        await mantleL1CrossDomainMessenger.getAddress(),
        await mantleL1StandardBridge.getAddress()
      ];
      return targets.some(t => bridgeContracts.includes(t));
    }
    case 'unichain': {
      const unichainL1CrossDomainMessenger = await governanceDeploymentManager.getContractOrThrow(
        'unichainL1CrossDomainMessenger'
      );
      const unichainL1StandardBridge = await governanceDeploymentManager.getContractOrThrow(
        'unichainL1StandardBridge'
      );
      const targets = openProposal.targets;
      const bridgeContracts = [
        await unichainL1CrossDomainMessenger.getAddress(),
        await unichainL1StandardBridge.getAddress()
      ];
      return targets.some(t => bridgeContracts.includes(t));
    }
    case 'scroll': {
      const scrollMessenger = await governanceDeploymentManager.getContractOrThrow(
        'scrollMessenger'
      );
      const targets = openProposal.targets;
      return targets.includes(await scrollMessenger.getAddress());
    }
    case 'ronin': {
      const governor = await governanceDeploymentManager.getContractOrThrow('governor');
      const l1CCIPRouter = await governanceDeploymentManager.getContractOrThrow(
        'l1CCIPRouter'
      );
      const roninl1NativeBridge = await governanceDeploymentManager.getContractOrThrow(
        'roninl1NativeBridge'
      );
      const roninL1OnRamp = await governanceDeploymentManager.getContractOrThrow(
        'roninl1CCIPOnRamp'
      );
      const { targets } = await governor.getFunction('proposalDetails')(openProposal.id);
      const bridgeContracts = [
        await roninl1NativeBridge.getAddress(),
        await l1CCIPRouter.getAddress(),
        await roninL1OnRamp.getAddress()
      ];
      return targets.some(t => bridgeContracts.includes(t));
    }
    default: {
      const tag = `[${bridgeNetwork} -> ${governanceDeploymentManager.network}]`;
      throw new Error(`${tag} Unable to determine whether to relay Proposal ${openProposal.id}`);
    }
  }
}
