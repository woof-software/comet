import type { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import { setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils.js';
import { AbiCoder, toNumber, ZeroAddress } from 'ethers';
import type { Log, TransactionReceipt } from 'ethers';
import { getHardhatEthers } from '../../plugins/deployment_manager/hardhat3/runtime.js';
import type { OpenBridgedProposal } from '../context/Gov.js';
import { impersonateAddress } from '../../plugins/scenario/utils/index.js';
import { isTenderlyLog } from './index.js';

const abiCoder = AbiCoder.defaultAbiCoder();

const LINEA_SETTER_ROLE_ACCOUNT = '0xc1C6B09D1eB6fCA0fF3cA11027E5Bc4AeDb47F67';

export default async function relayLineaMessage(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  startingBlockNumber: number,
  tenderlyLogs?: any[]
) {

  const lineaMessageService = await governanceDeploymentManager.getContractOrThrow(
    'lineaMessageService'
  );
  const signer = await bridgeDeploymentManager.getSigner();
  const lineaL1USDCBridge = await governanceDeploymentManager.getContractOrThrow(
    'lineaL1USDCBridge'
  );
  const timelock = await governanceDeploymentManager.getContractOrThrow(
    'timelock'
  );
  const lineaL1TokenBridge = await governanceDeploymentManager.getContractOrThrow(
    'lineaL1TokenBridge'
  );
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const l2USDCBridge = await bridgeDeploymentManager.getContractOrThrow('l2USDCBridge');
  const l2MessageService = await bridgeDeploymentManager.getContractOrThrow('l2MessageService');
  const l2StandardBridge = await bridgeDeploymentManager.getContractOrThrow('l2StandardBridge');
  const lineaMessageServiceAddress = await lineaMessageService.getAddress();
  const lineaL1USDCBridgeAddress = await lineaL1USDCBridge.getAddress();
  const timelockAddress = await timelock.getAddress();
  const lineaL1TokenBridgeAddress = await lineaL1TokenBridge.getAddress();
  const bridgeReceiverAddress = await bridgeReceiver.getAddress();
  const l2USDCBridgeAddress = await l2USDCBridge.getAddress();
  const l2MessageServiceAddress = await l2MessageService.getAddress();
  const l2StandardBridgeAddress = await l2StandardBridge.getAddress();
  const { provider: governanceProvider } = await getHardhatEthers(governanceDeploymentManager.hre);

  const openBridgedProposals: OpenBridgedProposal[] = [];
  // Grab all events on the L1CrossDomainMessenger contract since the `startingBlockNumber`
  const filter = lineaMessageService.filters.MessageSent();
  const filterRollingHash = lineaMessageService.filters.RollingHashUpdated();
  const messageTopics = await filter.getTopicFilter();
  const rollingHashTopics = await filterRollingHash.getTopicFilter();
  let messageSentEvents: Log[] = [];
  let rollingHashUpdatedEvents: Log[] = [];
  
  if (tenderlyLogs) {
  
    const msgTopic = messageTopics[0];
    const hashTopic = rollingHashTopics[0];
  
    const tenderlyMsgEvents = tenderlyLogs.filter(log =>
      log.raw?.topics?.[0] === msgTopic &&
      log.raw?.address?.toLowerCase() === lineaMessageServiceAddress.toLowerCase()
    );
  
    const tenderlyHashEvents = tenderlyLogs.filter(log =>
      log.raw?.topics?.[0] === hashTopic &&
      log.raw?.address?.toLowerCase() === lineaMessageServiceAddress.toLowerCase()
    );
  
    // getLogs version:
    const fromBlock = Math.max(0, startingBlockNumber - 50000);
    const toBlock = await governanceProvider.getBlockNumber();

    const realMsgEvents = await fetchLogsInChunks(
      governanceProvider,
      messageTopics,
      fromBlock,
      toBlock,
      lineaMessageServiceAddress
    );

    const realHashEvents = await fetchLogsInChunks(
      governanceProvider,
      rollingHashTopics,
      fromBlock,
      toBlock,
      lineaMessageServiceAddress
    );

    messageSentEvents = [...realMsgEvents, ...tenderlyMsgEvents];
    rollingHashUpdatedEvents = [...realHashEvents, ...tenderlyHashEvents];
  } else {
    const fromBlock = Math.max(0, startingBlockNumber - 50000);
    const toBlock = await governanceProvider.getBlockNumber();

    messageSentEvents = await fetchLogsInChunks(
      governanceProvider,
      messageTopics,
      fromBlock,
      toBlock,
      lineaMessageServiceAddress
    );

    rollingHashUpdatedEvents = await fetchLogsInChunks(
      governanceProvider,
      rollingHashTopics,
      fromBlock,
      toBlock,
      lineaMessageServiceAddress
    );
  }

  for (let i = 0; i < messageSentEvents.length; i++) {
    const messageSentEvent = messageSentEvents[i];
    const rollingHashUpdatedEvent = rollingHashUpdatedEvents[i];
    if (!rollingHashUpdatedEvent) {
      throw new Error('RollingHashUpdated log not found');
    }

    let parsedMessage, parsedRolling;

    if (isTenderlyLog(messageSentEvent)) {
      parsedMessage = lineaMessageService.interface.parseLog({
        topics: messageSentEvent.raw.topics,
        data: messageSentEvent.raw.data,
      });
    } else {
      parsedMessage = lineaMessageService.interface.parseLog(messageSentEvent);
    }

    if (isTenderlyLog(rollingHashUpdatedEvent)) {
      parsedRolling = lineaMessageService.interface.parseLog({
        topics: rollingHashUpdatedEvent.raw.topics,
        data: rollingHashUpdatedEvent.raw.data,
      });
    } else {
      parsedRolling = lineaMessageService.interface.parseLog(rollingHashUpdatedEvent);
    }

    if (!parsedMessage || !parsedRolling) {
      throw new Error('Linea message logs could not be parsed');
    }
    const { _from, _to, _fee, _value, _nonce, _calldata, _messageHash } = parsedMessage.args;
    const { messageNumber, rollingHash, messageHash } = parsedRolling.args;

    if(await l2MessageService.lastAnchoredL1MessageNumber() >= messageNumber) continue;

    await setNextBaseFeeToZero(bridgeDeploymentManager);

    const aliasSetterRoleAccount = await impersonateAddress(
      bridgeDeploymentManager,
      LINEA_SETTER_ROLE_ACCOUNT
    );

    let callData;
    // First the message's hash has to be added by a specific account in the "contract's queue"
    if(await l2MessageService.lastAnchoredL1MessageNumber() < messageNumber){
      if(tenderlyLogs) {
        callData = l2MessageService.interface.encodeFunctionData('anchorL1L2MessageHashes', [
          [messageHash],
          messageNumber,
          messageNumber,
          rollingHash
        ]);
        bridgeDeploymentManager.stashRelayMessage(
          l2MessageServiceAddress,
          callData,
          await aliasSetterRoleAccount.getAddress()
        );
      }
      await l2MessageService.connect(aliasSetterRoleAccount).getFunction('anchorL1L2MessageHashes')(
        [messageHash],
        messageNumber,
        messageNumber,
        rollingHash
      );
    }

    if(await l2MessageService.inboxL1L2MessageStatus(_messageHash) == 2n) continue;

    let relayMessageTxn: TransactionReceipt | null;

    if(
      _from.toLowerCase() === timelockAddress.toLowerCase()
      || _from.toLowerCase() === lineaL1TokenBridgeAddress.toLowerCase()
      || _from.toLowerCase() === lineaL1USDCBridgeAddress.toLowerCase()
    ){
      if(tenderlyLogs) {
        callData = l2MessageService.interface.encodeFunctionData('claimMessage', [
          _from,
          _to,
          _fee,
          _value,
          ZeroAddress,
          _calldata,
          _nonce
        ]);
        const signer = await bridgeDeploymentManager.getSigner();
        bridgeDeploymentManager.stashRelayMessage(
          l2MessageServiceAddress,
          callData,
          await signer.getAddress()
        );
      }
   

      relayMessageTxn = await (
        await l2MessageService.connect(signer).getFunction('claimMessage')(
          _from,
          _to,
          _fee,
          _value,
          ZeroAddress,
          _calldata,
          _nonce,
          {
            gasPrice: 0,
            gasLimit: 10000000
          }
        )
      ).wait();
      if (relayMessageTxn === null) {
        throw new Error('Linea relay transaction was not mined');
      }
      
    } else continue;

    // Try to decode the SentMessage data to determine what type of cross-chain activity this is. So far,
    // there are two types:
    // 1. Bridging ERC20 token
    // 2. Cross-chain message passing
    if (_to.toLowerCase() === l2StandardBridgeAddress.toLowerCase()) {
      // Bridging ERC20 token
      const messageWithoutPrefix = _calldata.slice(2); // strip out the 0x prefix
      const messageWithoutSigHash = '0x' + messageWithoutPrefix.slice(8);

      // Bridging ERC20 token
      const [ l1Token, amount, to ] = abiCoder.decode(
        ['address nativeToken', 'uint256 amount', 'address recipient'],
        messageWithoutSigHash
      );

      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of ${l1Token} to user ${to}`
      );
    }
    else if (_to.toLowerCase() === l2USDCBridgeAddress.toLowerCase()){
      const messageWithoutPrefix = _calldata.slice(2); // strip out the 0x prefix
      const messageWithoutSigHash = '0x' + messageWithoutPrefix.slice(8);
      const [ to, amount ] = abiCoder.decode(
        ['address _recipient', 'uint256 _amount'],
        messageWithoutSigHash
      );
      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of USDC.e to user ${to}`
      );
    }
    else if (_to.toLowerCase() === bridgeReceiverAddress.toLowerCase()) {
      // Cross-chain message passing
      const proposalCreatedEvent = relayMessageTxn.logs.find(
        event => event.address === bridgeReceiverAddress
      );
      if (!proposalCreatedEvent) {
        throw new Error('ProposalCreated log not found');
      }
      const parsedProposal = bridgeReceiver.interface.parseLog(proposalCreatedEvent);
      if (!parsedProposal) {
        throw new Error('ProposalCreated log could not be parsed');
      }
      const { id, eta } = parsedProposal.args;

      // Add the proposal to the list of open bridged proposals to be executed after all the messages have been relayed
      openBridgedProposals.push({ id, eta });
    } else {
      throw new Error(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Unrecognized target for cross-chain message`
      );
    }
  }

  // Execute open bridged proposals now that all messages have been bridged
  for (let proposal of openBridgedProposals) {
    const { eta, id } = proposal;
    // Fast forward l2 time
    await setNextBlockTimestamp(bridgeDeploymentManager, toNumber(eta) + 1);

    // Execute queued proposal
    await setNextBaseFeeToZero(bridgeDeploymentManager);
    if(tenderlyLogs) {
      const callData = bridgeReceiver.interface.encodeFunctionData('executeProposal', [id]);
      const signer = await bridgeDeploymentManager.getSigner();

      bridgeDeploymentManager.stashRelayMessage(
        bridgeReceiverAddress,
        callData,
        await signer.getAddress()
      );
    }else{
      await bridgeReceiver.executeProposal(id, { gasPrice: 0 });
    }
   
    console.log(
      `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Executed bridged proposal ${id}`
    );
  }
  return openBridgedProposals;
}

// Helper to fetch logs in chunks of 10,000 blocks
async function fetchLogsInChunks(provider: any, topics: (string | string[] | null)[], fromBlock: number, toBlock: number, address: string) {
  const chunkSize = 10000;
  let logs: Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    const chunkLogs = await provider.getLogs({
      fromBlock: start,
      toBlock: end,
      address,
      topics
    });
    logs = logs.concat(chunkLogs);
  }
  return logs;
}
