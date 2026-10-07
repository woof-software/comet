import type { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import { impersonateAddress } from '../../plugins/scenario/utils/index.js';
import { executeBridgedProposal } from './bridgeProposal.js';
import { setNextBaseFeeToZero } from './hreUtils.js';
import { AbiCoder, Contract } from 'ethers';
import type { Log } from 'ethers';
import type { OpenBridgedProposal } from '../context/Gov.js';
import { getHardhatEthers } from '../../plugins/deployment_manager/hardhat3/runtime.js';
import { isTenderlyLog } from './index.js';

type BridgeERC20Data = {
  syncData: string;
  user: string;
  rootToken: string;
  amount: bigint;
};

const abiCoder = AbiCoder.defaultAbiCoder();

function tryDecodeStateSyncedData(stateSyncedData: any): BridgeERC20Data | undefined {
  try {
    const { syncData } = abiCoder.decode(
      ['bytes32', 'bytes syncData'],
      stateSyncedData
    );
    const { user, rootToken, depositData } = abiCoder.decode(
      ['address user', 'address rootToken', 'bytes depositData'],
      syncData
    );
    const { amount } = abiCoder.decode(['uint256 amount'], depositData);
    return {
      syncData,
      user,
      rootToken,
      amount
    };
  } catch {
    return undefined;
  }
}

export default async function relayPolygonMessage(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  startingBlockNumber: number,
  tenderlyLogs?: any[]
) {
  const POLYGON_RECEIVER_ADDRESSS = '0x0000000000000000000000000000000000001001';
  const childChainManagerProxyAddress =
    bridgeDeploymentManager.network === 'polygon'
      ? '0xA6FA4fB5f76172d178d61B04b0ecd319C5d1C0aa'
      : '0xb5505a6d998549090530911180f38aC5130101c6';

  const stateSender = await governanceDeploymentManager.getContractOrThrow('stateSender');
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const fxChild = await bridgeDeploymentManager.getContractOrThrow('fxChild');
  const stateSenderAddress = await stateSender.getAddress();
  const bridgeReceiverAddress = await bridgeReceiver.getAddress();
  const fxChildAddress = await fxChild.getAddress();
  const { provider: governanceProvider } = await getHardhatEthers(governanceDeploymentManager.hre);
  const { provider: bridgeProvider } = await getHardhatEthers(bridgeDeploymentManager.hre);
  const childChainManager = new Contract(
    childChainManagerProxyAddress,
    [
      'function rootToChildToken(address rootToken) public view returns (address)',
      'function onStateReceive(uint256, bytes calldata data) external',
      'function DEPOSIT() public view returns (bytes32)'
    ],
    bridgeProvider
  );

  const openBridgedProposals: OpenBridgedProposal[] = [];

  const filter = stateSender.filters.StateSynced();
  const topics = await filter.getTopicFilter();
  let stateSyncedEvents: Log[] = [];

  if (tenderlyLogs) {
    const topic = topics[0];
    const tenderlyEvents = tenderlyLogs.filter(
      log => log.raw?.topics?.[0] === topic && log.raw?.address?.toLowerCase() === stateSenderAddress.toLowerCase()
    );
    const realEvents = await governanceProvider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: stateSenderAddress,
      topics
    });
    stateSyncedEvents = [...realEvents, ...tenderlyEvents];
  } else {
    stateSyncedEvents = await governanceProvider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: stateSenderAddress,
      topics
    });
  }

  for (const stateSyncedEvent of stateSyncedEvents) {
    let parsed;
    if (isTenderlyLog(stateSyncedEvent)) {
      parsed = stateSender.interface.parseLog({
        topics: stateSyncedEvent.raw.topics,
        data: stateSyncedEvent.raw.data
      });
    } else {
      parsed = stateSender.interface.parseLog(stateSyncedEvent);
    }
    if (!parsed) throw new Error('StateSynced log could not be parsed');
    // Try to decode the StateSynced data to determine what type of cross-chain activity this is. So far,
    // there are two types:
    // 1. Bridging ERC20 token
    // 2. Cross-chain message passing

    const { data: stateSyncedData } = parsed.args;

    const maybeBridgeERC20Data = tryDecodeStateSyncedData(stateSyncedData);

    if (maybeBridgeERC20Data !== undefined) {
      const depositSyncType = await childChainManager.DEPOSIT();
      const data = abiCoder.encode(
        ['bytes32', 'bytes'],
        [depositSyncType, maybeBridgeERC20Data.syncData]
      );
      const polygonReceiverSigner = await impersonateAddress(
        bridgeDeploymentManager,
        POLYGON_RECEIVER_ADDRESSS
      );
      await setNextBaseFeeToZero(bridgeDeploymentManager);

      if (tenderlyLogs) {
        const callData = childChainManager.interface.encodeFunctionData('onStateReceive', [123, data]);
        const signer = await bridgeDeploymentManager.getSigner();
        bridgeDeploymentManager.stashRelayMessage(
          await childChainManager.getAddress(),
          callData,
          await signer.getAddress()
        );
      } else {
        await(
          await childChainManager.connect(polygonReceiverSigner).getFunction('onStateReceive')(
            123, // stateId
            data, // data
            { gasPrice: 0 }
          )
        ).wait();
      }
      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${maybeBridgeERC20Data.amount} of ${maybeBridgeERC20Data.rootToken} to user ${maybeBridgeERC20Data.user}`
      );
    } else {
      // Cross-chain message passing
      const polygonReceiverSigner = await impersonateAddress(
        bridgeDeploymentManager,
        POLYGON_RECEIVER_ADDRESSS
      );

      await setNextBaseFeeToZero(bridgeDeploymentManager);

      if (tenderlyLogs) {
        const callData = fxChild.interface.encodeFunctionData('onStateReceive', [123, stateSyncedData]);
        bridgeDeploymentManager.stashRelayMessage(
          fxChildAddress,
          callData,
          await polygonReceiverSigner.getAddress()
        );
      }
      const onStateReceiveTxn = await (
        await fxChild.connect(polygonReceiverSigner).getFunction('onStateReceive')(
          123, // stateId
          stateSyncedData, // _data
          { gasPrice: 0 }
        )
      ).wait();

      if (!onStateReceiveTxn) throw new Error('Polygon relay transaction was not mined');
      const proposalCreatedEvent = onStateReceiveTxn.logs.find(
        event => event.address === bridgeReceiverAddress
      );
      if (!proposalCreatedEvent) throw new Error('ProposalCreated log not found');
      const parsedProposal = bridgeReceiver.interface.parseLog(proposalCreatedEvent);
      if (!parsedProposal) throw new Error('ProposalCreated log could not be parsed');
      const { id, eta } = parsedProposal.args;
      
      openBridgedProposals.push({ id, eta });
      if (tenderlyLogs) {
        const signer = await bridgeDeploymentManager.getSigner();
        const callData = bridgeReceiver.interface.encodeFunctionData('executeProposal', [id]);
        bridgeDeploymentManager.stashRelayMessage(
          bridgeReceiverAddress,
          callData,
          await signer.getAddress()
        );
      }
      else {
        await executeBridgedProposal(bridgeDeploymentManager, { id, eta });
      }
      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Executed bridged proposal ${id}`
      );
    }
  }

  return openBridgedProposals;
}
