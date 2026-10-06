import type { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import { impersonateAddress } from '../../plugins/scenario/utils/index.js';
import { setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils.js';
import { AbiCoder, toNumber, toQuantity } from 'ethers';
import type { Log, TransactionReceipt } from 'ethers';
import { getHardhatEthers } from '../../plugins/deployment_manager/hardhat3/runtime.js';
import type { OpenBridgedProposal } from '../context/Gov.js';
import { applyL1ToL2Alias, isTenderlyLog } from './index.js';

const abiCoder = AbiCoder.defaultAbiCoder();

export default async function relayOptimismMessage(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  startingBlockNumber: number,
  tenderlyLogs?: any[]
) {
  const opL1CrossDomainMessenger = await governanceDeploymentManager.getContractOrThrow('opL1CrossDomainMessenger');
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const l2CrossDomainMessenger = await bridgeDeploymentManager.getContractOrThrow('l2CrossDomainMessenger');
  const l2StandardBridge = await bridgeDeploymentManager.getContractOrThrow('l2StandardBridge');
  const l1MessengerAddress = await opL1CrossDomainMessenger.getAddress();
  const bridgeReceiverAddress = await bridgeReceiver.getAddress();
  const l2MessengerAddress = await l2CrossDomainMessenger.getAddress();
  const l2StandardBridgeAddress = await l2StandardBridge.getAddress();
  const { provider: governanceProvider } = await getHardhatEthers(governanceDeploymentManager.hre);
  const { provider: bridgeProvider } = await getHardhatEthers(bridgeDeploymentManager.hre);

  const openBridgedProposals: OpenBridgedProposal[] = [];

  const filter = opL1CrossDomainMessenger.filters.SentMessage();
  const sentMessageTopics = await filter.getTopicFilter();
  let sentMessageEvents: Log[] = [];

  if (tenderlyLogs) {
    const topic = sentMessageTopics[0];
    const tenderlyEvents = tenderlyLogs.filter(
      log => log.raw?.topics?.[0] === topic && log.raw?.address?.toLowerCase() === l1MessengerAddress.toLowerCase()
    );
    const realEvents = await governanceProvider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: l1MessengerAddress,
      topics: sentMessageTopics
    });
    sentMessageEvents = [...realEvents, ...tenderlyEvents];
  } else {
    sentMessageEvents = await governanceProvider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: l1MessengerAddress,
      topics: sentMessageTopics
    });
  }

  for (let sentMessageEvent of sentMessageEvents) {
    let parsed;
    if (isTenderlyLog(sentMessageEvent)) {
      parsed = opL1CrossDomainMessenger.interface.parseLog({
        topics: sentMessageEvent.raw.topics,
        data: sentMessageEvent.raw.data
      });
    } else {
      parsed = opL1CrossDomainMessenger.interface.parseLog(sentMessageEvent);
    }

    if (!parsed) {
      throw new Error('SentMessage log could not be parsed');
    }
    const { target, sender, message, messageNonce, gasLimit } = parsed.args;

    const aliasedSigner = await impersonateAddress(
      bridgeDeploymentManager,
      applyL1ToL2Alias(l1MessengerAddress)
    );

    await setNextBaseFeeToZero(bridgeDeploymentManager);

    let relayMessageTxn: TransactionReceipt | null;
    if (tenderlyLogs) {
      const callData = l2CrossDomainMessenger.interface.encodeFunctionData('relayMessage', [
        messageNonce,
        sender,
        target,
        0,
        0,
        message
      ]);
      bridgeDeploymentManager.stashRelayMessage(
        l2MessengerAddress,
        callData,
        await aliasedSigner.getAddress()
      );
    }

    relayMessageTxn = await (
      await l2CrossDomainMessenger.connect(aliasedSigner).getFunction('relayMessage')(
        messageNonce,
        sender,
        target,
        0,
        0,
        message,
        { gasPrice: 0, gasLimit }
      )
    ).wait();
    if (relayMessageTxn === null) {
      throw new Error('Relay transaction was not mined');
    }

    // Try to decode the SentMessage data to determine what type of cross-chain activity this is. So far,
    // there are two types:
    // 1. Bridging ERC20 token or ETH
    // 2. Cross-chain message passing
    if (target === l2StandardBridgeAddress) {
      // Bridging ERC20 token
      const messageWithoutPrefix = message.slice(2); // strip out the 0x prefix
      const messageWithoutSigHash = '0x' + messageWithoutPrefix.slice(8);
      try {
        // 1a. Bridging ERC20 token
        const [ l1Token, _l2Token, _from, to, amount, _data ] = abiCoder.decode(
          ['address l1Token', 'address l2Token', 'address from', 'address to', 'uint256 amount', 'bytes data'],
          messageWithoutSigHash
        );

        console.log(
          `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of ${l1Token} to user ${to}`
        );
      } catch {
        // 1a. Bridging ETH
        const [ _from, to, amount, _data ] = abiCoder.decode(
          ['address from', 'address to', 'uint256 amount', 'bytes data'],
          messageWithoutSigHash
        );

        const oldBalance = await bridgeProvider.getBalance(to);
        const newBalance = oldBalance + amount;
        // This is our best attempt to mimic the deposit transaction type (not supported in Hardhat) that Optimism uses to deposit ETH to an L2 address
        await bridgeProvider.send('hardhat_setBalance', [
          to,
          toQuantity(newBalance),
        ]);

        console.log(
          `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of ETH to user ${to}`
        );
      }
    } else if (target === bridgeReceiverAddress) {
      // Cross-chain message passing
      try {
        const proposalCreatedEvent = relayMessageTxn.logs.find(event => event.address === bridgeReceiverAddress);
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
      } catch (e) {
        const firstLog = relayMessageTxn.logs[0];
        const relayEvent = firstLog && l2CrossDomainMessenger.interface.parseLog(firstLog);
        if (relayEvent?.name === 'FailedRelayedMessage') {
          console.log('Failed to relay message');
          continue;
        }
        throw e;
      }
    } else {
      throw new Error(`[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Unrecognized target for cross-chain message`);
    }

    // Execute open bridged proposals now that all messages have been bridged
    for (let proposal of openBridgedProposals) {
      const { eta, id } = proposal;
      // Fast forward l2 time
      await setNextBlockTimestamp(bridgeDeploymentManager, toNumber(eta) + 1);

      // Execute queued proposal
      await setNextBaseFeeToZero(bridgeDeploymentManager);

      if (tenderlyLogs) {
        const callData = bridgeReceiver.interface.encodeFunctionData('executeProposal', [id]);
        const signer = await bridgeDeploymentManager.getSigner();

        bridgeDeploymentManager.stashRelayMessage(
          bridgeReceiverAddress,
          callData,
          await signer.getAddress()
        );
      } else {
        await bridgeReceiver.executeProposal(id, { gasPrice: 0 });
      }
      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Executed bridged proposal ${id}`
      );
    }

    return openBridgedProposals;
  }
}
