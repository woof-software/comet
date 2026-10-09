import type { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import { setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils.js';
import type { Log, TransactionReceipt } from 'ethers';
import { getHardhatEthers } from '../../plugins/deployment_manager/hardhat3/runtime.js';
import { impersonateAddress } from '../../plugins/scenario/utils/index.js';
import type { OpenBridgedProposal } from '../context/Gov.js';
import { AbiCoder, toNumber, toQuantity } from 'ethers';
import { applyL1ToL2Alias, isTenderlyLog } from './index.js';

const abiCoder = AbiCoder.defaultAbiCoder();

/*
The Scroll relayer applies an offset to the message sender.

applyL1ToL2Alias mimics the AddressAliasHelper.applyL1ToL2Alias fn that converts
an L1 address to its offset, L2 equivalent.
*/

export default async function relayScrollMessage(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  startingBlockNumber: number,
  tenderlyLogs?: any[]
) {
  const scrollMessenger = await governanceDeploymentManager.getContractOrThrow(
    'scrollMessenger'
  );
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const l2Messenger = await bridgeDeploymentManager.getContractOrThrow('l2Messenger');
  const l2ERC20Gateway = await bridgeDeploymentManager.getContractOrThrow('l2ERC20Gateway');
  const l2ETHGateway = await bridgeDeploymentManager.getContractOrThrow('l2ETHGateway');
  const l2WETHGateway = await bridgeDeploymentManager.getContractOrThrow('l2WETHGateway');
  const l2WstETHGateway = await bridgeDeploymentManager.getContractOrThrow('l2WstETHGateway');

  const scrollMessengerAddress = await scrollMessenger.getAddress();
  const bridgeReceiverAddress = await bridgeReceiver.getAddress();
  const l2MessengerAddress = await l2Messenger.getAddress();
  const l2ERC20GatewayAddress = await l2ERC20Gateway.getAddress();
  const l2ETHGatewayAddress = await l2ETHGateway.getAddress();
  const l2WETHGatewayAddress = await l2WETHGateway.getAddress();
  const l2WstETHGatewayAddress = await l2WstETHGateway.getAddress();
  const { provider: governanceProvider } = await getHardhatEthers(governanceDeploymentManager.hre);
  const { provider: bridgeProvider } = await getHardhatEthers(bridgeDeploymentManager.hre);

  const openBridgedProposals: OpenBridgedProposal[] = [];

  // Grab all events on the L1CrossDomainMessenger contract since the `startingBlockNumber`
  const filter = scrollMessenger.filters.SentMessage();
  const messageTopics = await filter.getTopicFilter();
  let messageSentEvents: Log[] = [];

  if (tenderlyLogs) {
    const topic = messageTopics[0];
    const tenderlyEvents = tenderlyLogs.filter(
      log => log.raw?.topics?.[0] === topic && log.raw?.address?.toLowerCase() === scrollMessengerAddress.toLowerCase()
    );
    const realEvents = await governanceProvider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: scrollMessengerAddress,
      topics: messageTopics
    });
    messageSentEvents = [...realEvents, ...tenderlyEvents];
  } else {
    messageSentEvents = await governanceProvider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: scrollMessengerAddress,
      topics: messageTopics
    });
  }

  for (let messageSentEvent of messageSentEvents) {
    let parsed;
    if (isTenderlyLog(messageSentEvent)) {
      parsed = scrollMessenger.interface.parseLog({
        topics: messageSentEvent.raw.topics,
        data: messageSentEvent.raw.data
      });
    } else {
      parsed = scrollMessenger.interface.parseLog(messageSentEvent);
    }

    if (!parsed) {
      throw new Error('SentMessage log could not be parsed');
    }
    const { sender, target, value, messageNonce, gasLimit, message } = parsed.args;

    await setNextBaseFeeToZero(bridgeDeploymentManager);

    let aliasAccount;
    if (bridgeDeploymentManager.network == 'scroll-goerli'){
      aliasAccount = await impersonateAddress(
        bridgeDeploymentManager,
        '0xD69c917c7F1C0a724A51c189B4A8F4F8C8E8cA0a'
      );
    } else {
      aliasAccount = await impersonateAddress(
        bridgeDeploymentManager,
        applyL1ToL2Alias(scrollMessengerAddress)
      );
    }

    let relayMessageTxn: TransactionReceipt | null;
    if (tenderlyLogs) {
      const callData = l2Messenger.interface.encodeFunctionData('relayMessage', [sender, target, value, messageNonce, message]);
      bridgeDeploymentManager.stashRelayMessage(
        l2MessengerAddress,
        callData,
        await aliasAccount.getAddress()
      );
    }
    relayMessageTxn = await (
      await l2Messenger.connect(aliasAccount).getFunction('relayMessage')(
        sender,
        target,
        value,
        messageNonce,
        message,
        { gasPrice: 0, gasLimit }
      )
    ).wait();
    if (relayMessageTxn === null) {
      throw new Error('Relay transaction was not mined');
    }

    const messageWithoutPrefix = message.slice(2); // strip out the 0x prefix
    const messageWithoutSigHash = '0x' + messageWithoutPrefix.slice(8);

    // Try to decode the SentMessage data to determine what type of cross-chain activity this is. So far,
    // there are two types:
    // 1. Bridging ERC20 token or ETH
    // 2. Cross-chain message passing
    if (target === l2ERC20GatewayAddress) {
      // 1a. Bridging ERC20 token
      const [ l1Token, _l2Token, _from, to, amount, _data ] = abiCoder.decode(
        ['address _l1Token', 'address _l2Token','address _from', 'address _to','uint256 _amount', 'bytes _data'],
        messageWithoutSigHash
      );

      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of ${l1Token} to user ${to}`
      );
    } else if (target === l2ETHGatewayAddress){
      // 1a. Bridging ETH
      const [ _from, to, amount, _data ] = abiCoder.decode(
        ['address _from', 'address _to', 'uint256 _amount', 'bytes _data'],
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
    }else if (target === l2WETHGatewayAddress){
      // 1c. Bridging WETH
      const [ _l1Token, _l2Token, _from, to, amount, _data ] = abiCoder.decode(
        ['address _l1Token', 'address _l2Token','address _from', 'address _to','uint256 _amount', 'bytes _data'],
        messageWithoutSigHash
      );

      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of WETH to user ${to}`
      );
    } else if (target === l2WstETHGatewayAddress){
      // 1d. Bridging WstETH
      const [ _l1Token, _l2Token, _from, to, amount, _data ] = abiCoder.decode(
        ['address _l1Token', 'address _l2Token','address _from', 'address _to','uint256 _amount', 'bytes _data'],
        messageWithoutSigHash
      );

      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of WstETH to user ${to}`
      );
    } else if (target === bridgeReceiverAddress) {
      // Cross-chain message passing
      const proposalCreatedEvent = relayMessageTxn.logs.find(event => event.address.toLowerCase() === bridgeReceiverAddress.toLowerCase());
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
