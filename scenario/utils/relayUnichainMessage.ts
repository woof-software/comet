import type { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import { impersonateAddress } from '../../plugins/scenario/utils/index.js';
import { setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils.js';
import { AbiCoder, toNumber, toQuantity, getBytes, hexlify, getAddress, id, toBigInt } from 'ethers';
import type { Log, TransactionReceipt } from 'ethers';
import { getHardhatEthers } from '../../plugins/deployment_manager/hardhat3/runtime.js';
import type { OpenBridgedProposal } from '../context/Gov.js';
import { applyL1ToL2Alias, isTenderlyLog } from './index.js';

const abiCoder = AbiCoder.defaultAbiCoder();

export async function relayUnichainMessage(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  startingBlockNumber: number,
  tenderlyLogs?: any[]
) {
  const unichainL1CrossDomainMessenger = await governanceDeploymentManager.getContractOrThrow('unichainL1CrossDomainMessenger');
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const l2CrossDomainMessenger = await bridgeDeploymentManager.getContractOrThrow('l2CrossDomainMessenger');
  const l2StandardBridge = await bridgeDeploymentManager.getContractOrThrow('l2StandardBridge');
  const l1MessengerAddress = await unichainL1CrossDomainMessenger.getAddress();
  const bridgeReceiverAddress = await bridgeReceiver.getAddress();
  const l2MessengerAddress = await l2CrossDomainMessenger.getAddress();
  const l2StandardBridgeAddress = await l2StandardBridge.getAddress();
  const { provider: governanceProvider } = await getHardhatEthers(governanceDeploymentManager.hre);
  const { provider: bridgeProvider } = await getHardhatEthers(bridgeDeploymentManager.hre);

  const openBridgedProposals: OpenBridgedProposal[] = [];

  // Grab all events on the L1CrossDomainMessenger contract since the `startingBlockNumber`
  const filter = unichainL1CrossDomainMessenger.filters.SentMessage();
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
      parsed = unichainL1CrossDomainMessenger.interface.parseLog({
        topics: sentMessageEvent.raw.topics,
        data: sentMessageEvent.raw.data
      });
    } else {
      parsed = unichainL1CrossDomainMessenger.interface.parseLog(sentMessageEvent);
    }

    if (!parsed) {
      throw new Error('SentMessage log could not be parsed');
    }
    const { sender, target, message, messageNonce, gasLimit } = parsed.args;
    const aliasedSigner = await impersonateAddress(
      bridgeDeploymentManager,
      applyL1ToL2Alias(l1MessengerAddress)
    );

    await setNextBaseFeeToZero(bridgeDeploymentManager);

    let relayMessageTxn: TransactionReceipt | null;
    if (tenderlyLogs) {
      const callData = l2CrossDomainMessenger.interface.encodeFunctionData('relayMessage', [messageNonce, sender, target, 0, 0, message]);
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
        gasLimit,
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
        // This is our best attempt to mimic the deposit transaction type (not supported in Hardhat) that Unichain uses to deposit ETH to an L2 address
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
      const signer = await bridgeDeploymentManager.getSigner();
      const callData = bridgeReceiver.interface.encodeFunctionData('executeProposal', [id]);
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

export async function relayUnichainCCTPMint(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  startingBlockNumber: number,
  tenderlyLogs?: any[]
){

  // CCTP relay
  // L1 contracts
  const L1MessageTransmitter = await governanceDeploymentManager.getContractOrThrow('CCTPMessageTransmitter');
  // L2 TokenMinter
  const TokenMinter = await bridgeDeploymentManager.getContractOrThrow('TokenMinter');
  const transmitterAddress = await L1MessageTransmitter.getAddress();
  const tokenMinterAddress = await TokenMinter.getAddress();
  const { provider: governanceProvider } = await getHardhatEthers(governanceDeploymentManager.hre);

  let depositForBurnEvents: Log[] = [];

  if (tenderlyLogs) {
    const messageSentTopic = id('MessageSent(bytes)');

    const tenderlyEvents = tenderlyLogs.filter(log =>
      log.raw?.topics?.[0] === messageSentTopic &&
      log.raw?.address?.toLowerCase() === transmitterAddress.toLowerCase()
    );

    const realEvents = await governanceProvider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: transmitterAddress,
      topics: [messageSentTopic]
    });

    depositForBurnEvents = [...realEvents, ...tenderlyEvents];
  } else {
    depositForBurnEvents = await governanceProvider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: transmitterAddress,
      topics: [id('MessageSent(bytes)')]
    });
  }

  // Decode message body
  console.log(`Found ${depositForBurnEvents.length} CCTP deposit for burn events`);

  const burnEvents = depositForBurnEvents.map((event) => {
    let data;
    
    if (isTenderlyLog(event)) {
      data = event.raw.data;
    } else {
      data = event.data;
    }

    const dataBytes = getBytes(data);
    // Since data is encodePacked, so can't simply decode via AbiCoder.decode
    const offset = 64;
    const length = {
      uint32: 4,
      uint64: 8,
      bytes32: 32,
      uint256: 32,
    };
    let start = offset;
    let end = start + length.uint32;
    // msgVersion, skip won't use
    start = end;
    end = start + length.uint32;
    // msgSourceDomain
    const msgSourceDomain = toNumber(dataBytes.slice(start, end));

    start = end;
    end = start + length.uint32;
    // msgDestinationDomain, skip won't use

    start = end;
    end = start + length.uint64;
    // msgNonce, skip won't use

    start = end;
    end = start + length.bytes32;
    // msgSender, skip won't use

    start = end;
    end = start + length.bytes32;
    // msgRecipient, skip won't use

    start = end;
    end = start + length.bytes32;
    // msgDestination, skip won't use

    start = end;
    end = start + length.uint32;
    // rawMsgBody version, skip won't use

    start = end;
    end = start + length.bytes32;
    // rawMsgBody burnToken
    const burnToken = hexlify(dataBytes.slice(start, end));

    start = end;
    end = start + length.bytes32;
    // rawMsgBody mintRecipient
    const mintRecipient = getAddress(hexlify(dataBytes.slice(start, end)).slice(-40));

    start = end;
    end = start + length.uint256;

    // rawMsgBody amount
    const amount = toBigInt(dataBytes.slice(start, end));

    start = end;
    end = start + length.bytes32;
    // rawMsgBody messageSender, skip won't use

    return {
      recipient: mintRecipient,
      amount: amount,
      sourceDomain: msgSourceDomain,
      burnToken: burnToken
    };
  });

  // Impersonate the Unichain TokenMinter and mint token to recipient
  const ImpersonateLocalTokenMessenger = bridgeDeploymentManager.network === 'unichain' ? await TokenMinter.localTokenMessenger() : '0x0';
  // Impersonate the Unichain TokenMinter and mint token to recipient
  for (let burnEvent of burnEvents) {
    const { recipient, amount, sourceDomain, burnToken } = burnEvent;
    // 0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
    console.log(`Minting ${amount} of ${burnToken.replace(/^0x0{24}/, '0x')} to ${recipient} on ${bridgeDeploymentManager.network}`);
    const localTokenMessengerSigner = await impersonateAddress(
      bridgeDeploymentManager,
      ImpersonateLocalTokenMessenger
    );

    const transactionRequest = await localTokenMessengerSigner.populateTransaction({
      to: tokenMinterAddress,
      from: ImpersonateLocalTokenMessenger,
      data: TokenMinter.interface.encodeFunctionData('mint', [sourceDomain, burnToken, getAddress(recipient), amount]),
      gasPrice: 0
    });

    await setNextBaseFeeToZero(bridgeDeploymentManager);
    if( tenderlyLogs ) {
      const callData = TokenMinter.interface.encodeFunctionData('mint', [sourceDomain, burnToken, getAddress(recipient), amount]);
      bridgeDeploymentManager.stashRelayMessage(
        tokenMinterAddress,
        callData,
        await localTokenMessengerSigner.getAddress()
      );
    } else {
      await (
        await localTokenMessengerSigner.sendTransaction(transactionRequest)
      ).wait();
    }
  }
}
