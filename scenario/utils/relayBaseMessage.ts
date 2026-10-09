import type { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import { impersonateAddress } from '../../plugins/scenario/utils/index.js';
import { setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils.js';
import { AbiCoder, id, parseEther, toNumber, toQuantity, zeroPadValue } from 'ethers';
import type { Log, TransactionReceipt } from 'ethers';
import { getHardhatEthers } from '../../plugins/deployment_manager/hardhat3/runtime.js';
import type { OpenBridgedProposal } from '../context/Gov.js';
import { applyL1ToL2Alias, isTenderlyLog } from './index.js';

const abiCoder = AbiCoder.defaultAbiCoder();
/*
The Base relayer applies an offset to the message sender.

applyL1ToL2Alias mimics the AddressAliasHelper.applyL1ToL2Alias fn that converts
an L1 address to its offset, L2 equivalent.

https://basescan.org/address/0x4200000000000000000000000000000000000007#code
*/

export default async function relayBaseMessage(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  startingBlockNumber: number,
  tenderlyLogs?: any[]
) {
  const baseL1CrossDomainMessenger = await governanceDeploymentManager.getContractOrThrow('baseL1CrossDomainMessenger');
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const l2CrossDomainMessenger = await bridgeDeploymentManager.getContractOrThrow('l2CrossDomainMessenger');
  const l2StandardBridge = await bridgeDeploymentManager.getContractOrThrow('l2StandardBridge');
  const l2USDSBridge = await bridgeDeploymentManager.contract('l2USDSBridge');
  const l1MessengerAddress = await baseL1CrossDomainMessenger.getAddress();
  const bridgeReceiverAddress = await bridgeReceiver.getAddress();
  const l2MessengerAddress = await l2CrossDomainMessenger.getAddress();
  const l2StandardBridgeAddress = await l2StandardBridge.getAddress();
  const l2USDSBridgeAddress = l2USDSBridge && await l2USDSBridge.getAddress();
  const { provider: governanceProvider } = await getHardhatEthers(governanceDeploymentManager.hre);
  const { provider: bridgeProvider } = await getHardhatEthers(bridgeDeploymentManager.hre);

  const openBridgedProposals: OpenBridgedProposal[] = [];

  // Grab all events on the L1CrossDomainMessenger contract since the `startingBlockNumber`
  const filter = baseL1CrossDomainMessenger.filters.SentMessage();
  const sentMessageTopics = await filter.getTopicFilter();
  let sentMessageEvents: Log[] = [];

  if (tenderlyLogs) {
    const sentMessageTopic = sentMessageTopics[0];

    const tenderlySentMessageEvents = tenderlyLogs.filter(log =>
      log.raw?.topics?.[0] === sentMessageTopic &&
      log.raw?.address?.toLowerCase() === l1MessengerAddress.toLowerCase()
    );

    const realSentMessageEvents = await governanceProvider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: l1MessengerAddress,
      topics: sentMessageTopics,
    });

    sentMessageEvents = [...realSentMessageEvents, ...tenderlySentMessageEvents];
  } else {
    sentMessageEvents = await governanceProvider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: l1MessengerAddress,
      topics: sentMessageTopics,
    });
  }

  for (let sentMessageEvent of sentMessageEvents) {
    let parsedLog;

    if (isTenderlyLog(sentMessageEvent)) {
      parsedLog = baseL1CrossDomainMessenger.interface.parseLog({
        topics: sentMessageEvent.raw.topics,
        data: sentMessageEvent.raw.data,
      });
    } else {
      parsedLog = baseL1CrossDomainMessenger.interface.parseLog(sentMessageEvent);
    }

    if (!parsedLog) {
      throw new Error('SentMessage log could not be parsed');
    }
    const { target, sender, message, messageNonce, gasLimit } = parsedLog.args;

    const aliasedSigner = await impersonateAddress(
      bridgeDeploymentManager,
      applyL1ToL2Alias(l1MessengerAddress)
    );

    let relayMessageTxn: TransactionReceipt | null;
    await setNextBaseFeeToZero(bridgeDeploymentManager);

    if (tenderlyLogs) {
      const callData = l2CrossDomainMessenger.interface.encodeFunctionData(
        'relayMessage',
        [messageNonce, sender, target, 0, 0, message]
      );
      bridgeDeploymentManager.stashRelayMessage(
        l2MessengerAddress,
        callData,
        await aliasedSigner.getAddress()
      );
    }

    relayMessageTxn = await (
      await l2CrossDomainMessenger
        .connect(aliasedSigner)
        .getFunction('relayMessage')(messageNonce, sender, target, 0, 0, message, {
          gasPrice: 0,
          gasLimit,
        })
    ).wait();
    if (relayMessageTxn === null) {
      throw new Error('Relay transaction was not mined');
    }

    // Try to decode the SentMessage data to determine what type of cross-chain activity this is. So far,
    // there are two types:
    // 1. Bridging ERC20 token or ETH
    // 2. Cross-chain message passing
    if (target === l2StandardBridgeAddress || (l2USDSBridge && target === l2USDSBridgeAddress)) {
      // Bridging ERC20 token
      const messageWithoutPrefix = message.slice(2); // strip out the 0x prefix
      const messageWithoutSigHash = '0x' + messageWithoutPrefix.slice(8);
      try {
        // 1a. Bridging ERC20 token
        const { _l2Token, l1Token, _from, to, amount, _data } =
          abiCoder.decode(
            ['address l2Token', 'address l1Token', 'address from', 'address to', 'uint256 amount', 'bytes data'],
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
      if (relayMessageTxn) {
        const proposalCreatedEvent = relayMessageTxn.logs.find(
          (event) => event.address === bridgeReceiverAddress
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
      }
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

export async function simulateL2ToL1TokenBridging(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  l2StartingBlockNumber?: number,
  tenderlyLogs?: any[]
) {
  if(tenderlyLogs) {
    return;
  }
  console.log('Simulating L2→L1 token bridging for any executed Base proposals...');

  // L2 contracts
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const baseL2Bridge = await bridgeDeploymentManager.getContractOrThrow('l2StandardBridge');
  const l2CrossDomainMessenger = await bridgeDeploymentManager.getContractOrThrow('l2CrossDomainMessenger');

  // L1 contracts
  const baseL1CrossDomainMessenger = await governanceDeploymentManager.getContractOrThrow('baseL1CrossDomainMessenger');
  const baseL1Bridge = await governanceDeploymentManager.getContractOrThrow('baseL1StandardBridge');
  const BASE_L1_PORTAL = '0x49048044D57e1C92A77f79988d21Fa8fAF74E97e';

  // Parse recent ProposalCreated events to find actions that bridge tokens from L2 to L1
  // ProposalCreated(address indexed rootMessageSender, uint256 id, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 eta)
  console.log('Fetching recent ProposalCreated events from BridgeReceiver...');
  const { provider: bridgeProvider } = await getHardhatEthers(bridgeDeploymentManager.hre);
  const { provider: governanceProvider } = await getHardhatEthers(governanceDeploymentManager.hre);
  const bridgeReceiverAddress = await bridgeReceiver.getAddress();
  const baseL2BridgeAddress = await baseL2Bridge.getAddress();
  const l2MessengerAddress = await l2CrossDomainMessenger.getAddress();
  const l1MessengerAddress = await baseL1CrossDomainMessenger.getAddress();
  const latestBlockNumber = await bridgeProvider.getBlockNumber();
  const proposalCreatedEvents = await bridgeDeploymentManager.retry(() =>
    bridgeProvider.getLogs({
      fromBlock: l2StartingBlockNumber ?? Math.max(0, latestBlockNumber - 1000),
      toBlock: 'latest',
      address: bridgeReceiverAddress,
      topics: [id('ProposalCreated(address,uint256,address[],uint256[],string[],bytes[],uint256)')]
    })
  );

  const bridgeERC20ToSignature = 'bridgeERC20To(address,address,address,uint256,uint32,bytes)';

  for (const event of proposalCreatedEvents) {
    const decodedEvent = bridgeReceiver.interface.parseLog(event);
    if (!decodedEvent) {
      throw new Error('Base ProposalCreated log could not be parsed');
    }
    const { signatures, calldatas } = decodedEvent.args;


    for (let i = 0; i < signatures.length; i++) {
      if (signatures[i] === bridgeERC20ToSignature) {
        const [localToken, remoteToken, to, amount, , extraData] = abiCoder.decode(
          ['address', 'address', 'address', 'uint256', 'uint32', 'bytes'],
          calldatas[i]
        );

        console.log(`Simulating L2→L1 bridgeERC20To: ${amount.toString()} of ${remoteToken} to ${to}`);

        console.log('Setting up L1 state to simulate finalizeBridgeERC20...');
        console.log('Base L1 Portal address:', BASE_L1_PORTAL);
        console.log('Overriding slot', zeroPadValue('0x32', 32));
        console.log('l2CrossDomainMessenger:', zeroPadValue(l2MessengerAddress, 32));
        await governanceProvider.send('hardhat_setStorageAt', [
          BASE_L1_PORTAL,
          zeroPadValue('0x32', 32),
          zeroPadValue(l2MessengerAddress, 32)
        ]);

        await governanceProvider.send('hardhat_setStorageAt', [
          l1MessengerAddress,
          '0xcc',
          zeroPadValue(baseL2BridgeAddress, 32)
        ]);

        const domainMessengerSigner = await impersonateAddress(
          governanceDeploymentManager,
          l1MessengerAddress
        );

        await governanceProvider.send('hardhat_setBalance', [
          await domainMessengerSigner.getAddress(),
          toQuantity(parseEther('1')),
        ]);

        await (
          await baseL1Bridge.connect(domainMessengerSigner).getFunction('finalizeBridgeERC20')(
            remoteToken, localToken, bridgeReceiverAddress, to, amount, extraData,
            { gasPrice: 0, gasLimit: 2_500_000 }
          )
        ).wait();

        await governanceProvider.send('hardhat_setStorageAt', [
          BASE_L1_PORTAL,
          zeroPadValue('0x32', 32),
          zeroPadValue('0xdead', 32)
        ]);
      }
    }
  }
}
