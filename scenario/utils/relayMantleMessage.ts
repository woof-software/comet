import type { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import { impersonateAddress } from '../../plugins/scenario/utils/index.js';
import { setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils.js';
import { AbiCoder, toNumber, toQuantity } from 'ethers';
import type { Log, TransactionReceipt } from 'ethers';
import { getHardhatEthers } from '../../plugins/deployment_manager/hardhat3/runtime.js';
import type { OpenBridgedProposal } from '../context/Gov.js';
import { applyL1ToL2Alias, isTenderlyLog } from './index.js';

const abiCoder = AbiCoder.defaultAbiCoder();

export default async function relayMantleMessage(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  startingBlockNumber: number,
  tenderlyLogs?: any[]
) {
  const mantleL1CrossDomainMessenger = await governanceDeploymentManager.getContractOrThrow('mantleL1CrossDomainMessenger');
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const l2CrossDomainMessenger = await bridgeDeploymentManager.getContractOrThrow('l2CrossDomainMessenger');
  const l2StandardBridge = await bridgeDeploymentManager.getContractOrThrow('l2StandardBridge');

  const mantleL1CrossDomainMessengerAddress = await mantleL1CrossDomainMessenger.getAddress();
  const bridgeReceiverAddress = await bridgeReceiver.getAddress();
  const l2CrossDomainMessengerAddress = await l2CrossDomainMessenger.getAddress();
  const l2StandardBridgeAddress = await l2StandardBridge.getAddress();
  const { provider: governanceProvider } = await getHardhatEthers(governanceDeploymentManager.hre);
  const { provider: bridgeProvider } = await getHardhatEthers(bridgeDeploymentManager.hre);

  const openBridgedProposals: OpenBridgedProposal[] = [];

  const filter = mantleL1CrossDomainMessenger.filters.SentMessage();
  const messageTopics = await filter.getTopicFilter();
  let sentMessageEvents: Log[] = [];

  if (tenderlyLogs) {
    const topic = messageTopics[0];
    const tenderlyParsed = tenderlyLogs.filter(log => log.raw?.topics?.[0] === topic);
    const realLogs = await governanceProvider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: mantleL1CrossDomainMessengerAddress,
      topics: messageTopics
    });
    sentMessageEvents = [...realLogs, ...tenderlyParsed];
  } else {
    sentMessageEvents = await governanceProvider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: mantleL1CrossDomainMessengerAddress,
      topics: messageTopics
    });
  }

  for (let sentMessageEvent of sentMessageEvents) {
    const parsed = isTenderlyLog(sentMessageEvent)
      ? mantleL1CrossDomainMessenger.interface.parseLog({
        topics: sentMessageEvent.raw.topics,
        data: sentMessageEvent.raw.data
      })
      : mantleL1CrossDomainMessenger.interface.parseLog(sentMessageEvent);
    if (!parsed) {
      throw new Error('SentMessage log could not be parsed');
    }
    const { target, sender, message, messageNonce } = parsed.args;

    const aliasedSigner = await impersonateAddress(
      bridgeDeploymentManager,
      applyL1ToL2Alias(mantleL1CrossDomainMessengerAddress)
    );

    await setNextBaseFeeToZero(bridgeDeploymentManager);

    let relayMessageTxn: TransactionReceipt | null;
    if (tenderlyLogs) {
      const callData = l2CrossDomainMessenger.interface.encodeFunctionData(
        'relayMessage',
        [messageNonce, sender, target, 0, 0, 0, message]
      );
      bridgeDeploymentManager.stashRelayMessage(
        l2CrossDomainMessengerAddress,
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
        0,
        message,
        { gasPrice: 0, gasLimit: 7_500_000 }
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
        const { l1Token, _l2Token, _from, to, amount, _data } = abiCoder.decode(
          ['address l1Token', 'address l2Token', 'address from', 'address to', 'uint256 amount', 'bytes data'],
          messageWithoutSigHash
        );

        console.log(
          `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of ${l1Token} to user ${to}`
        );
      } catch {
        // 1a. Bridging ETH
        const { _from, to, amount, _data } = abiCoder.decode(
          ['address from', 'address to', 'uint256 amount', 'bytes data'],
          messageWithoutSigHash
        );

        const oldBalance = await bridgeProvider.getBalance(to);
        const newBalance = oldBalance + amount;
        // This is our best attempt to mimic the deposit transaction type (not supported in Hardhat) that Mantle uses to deposit ETH to an L2 address
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
    } else {
      throw new Error(`[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Unrecognized target for cross-chain message`);
    }
  }

  // Execute open bridged proposals now that all messages have been bridged
  for (let proposal of openBridgedProposals) {
    const { eta, id } = proposal;
    // Fast forward l2 time
    await setNextBlockTimestamp(bridgeDeploymentManager, toNumber(eta) + 1);

    // Execute queued proposal
    await setNextBaseFeeToZero(bridgeDeploymentManager);

    if (tenderlyLogs) {
      const callData = bridgeReceiver.interface.encodeFunctionData(
        'executeProposal',
        [id]
      );
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
