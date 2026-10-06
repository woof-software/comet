import type { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import { getHardhatEthers } from '../../plugins/deployment_manager/hardhat3/runtime.js';
import { impersonateAddress } from '../../plugins/scenario/utils/index.js';
import { setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils.js';
import { AbiCoder, getAddress, getBytes, hexlify, id, toBigInt, toBeHex, toNumber } from 'ethers';
import type { Log } from 'ethers';
import { sourceTokens } from '../../plugins/scenario/utils/TokenSourcer.js';
import type { OpenBridgedProposal } from '../context/Gov.js';
import { isTenderlyLog } from './index.js';

const abiCoder = AbiCoder.defaultAbiCoder();

export async function relayArbitrumMessage(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  startingBlockNumber: number,
  tenderlyLogs?: any[]
) {
  // L1 contracts
  const inbox = await governanceDeploymentManager.getContractOrThrow('arbitrumInbox'); // Inbox -> Bridge
  const bridge = await governanceDeploymentManager.getContractOrThrow('arbitrumBridge');

  // L2 contracts
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const inboxAddress = await inbox.getAddress();
  const bridgeAddress = await bridge.getAddress();
  const bridgeReceiverAddress = await bridgeReceiver.getAddress();
  const { provider } = await getHardhatEthers(governanceDeploymentManager.hre);

  let inboxMessageDeliveredEvents: Log[] = [];
  let messageDeliveredEvents: Log[] = [];
  const openBridgedProposals: OpenBridgedProposal[] = [];

  if (tenderlyLogs) {
    const inboxTopic = id('InboxMessageDelivered(uint256,bytes)');
    const bridgeTopic = id('MessageDelivered(uint256,bytes32,address,uint8,address,bytes32,uint256,uint64)');

    const tenderlyInboxEvents = tenderlyLogs.filter(log =>
      log.raw?.topics?.[0] === inboxTopic &&
      log.raw?.address?.toLowerCase() === inboxAddress.toLowerCase()
    );

    const tenderlyBridgeEvents = tenderlyLogs.filter(log =>
      log.raw?.topics?.[0] === bridgeTopic &&
      log.raw?.address?.toLowerCase() === bridgeAddress.toLowerCase()
    );

    const realInboxEvents = await provider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: inboxAddress,
      topics: [inboxTopic]
    });

    const realBridgeEvents = await provider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: bridgeAddress,
      topics: [bridgeTopic]
    });

    inboxMessageDeliveredEvents = [...realInboxEvents, ...tenderlyInboxEvents];
    messageDeliveredEvents = [...realBridgeEvents, ...tenderlyBridgeEvents];
  } else {
    inboxMessageDeliveredEvents = await provider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: inboxAddress,
      topics: [id('InboxMessageDelivered(uint256,bytes)')]
    });

    messageDeliveredEvents = await provider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: bridgeAddress,
      topics: [id('MessageDelivered(uint256,bytes32,address,uint8,address,bytes32,uint256,uint64)')]
    });
  }

  const dataAndTargets = inboxMessageDeliveredEvents.map((event) => {
    let data, topics;
    
    if (isTenderlyLog(event)) {
      data = event.raw.data;
      topics = event.raw.topics;
    } else {
      data = event.data;
      topics = event.topics;
    }

    const header = '0x';
    const headerLength = header.length;
    const wordLength = 2 * 32;
    const innnerData = header + data.slice(headerLength + (11 * wordLength));
    const toValue = data.slice(headerLength + (2 * wordLength), headerLength + (3 * wordLength));
    let toAddress = toBeHex(BigInt(`0x${toValue}`));
    
    // if lenght of toAddress is less than 42, then it is padded with 0s and we need to add them after 0x
    if(toAddress.length < 42) {
      toAddress = `0x${toAddress.slice(2).padStart(40, '0')}`;
    }

    const messageNum = topics[1];
    return {
      data: innnerData,
      toAddress,
      messageNum
    };
  });

  const senders = messageDeliveredEvents.map((event) => {
    let data, topics;
    
    if (isTenderlyLog(event)) {
      data = event.raw.data;
      topics = event.raw.topics;
    } else {
      data = event.data;
      topics = event.topics;
    }

    const decodedData = abiCoder.decode(
      [
        'address inbox',
        'uint8 kind',
        'address sender',
        'bytes32 messageDataHash',
        'uint256 baseFeeL1',
        'uint64 timestamp'
      ],
      data
    );
    const { sender } = decodedData;
    const messageNum = topics[1];
    return {
      sender,
      messageNum
    };
  });

  const bridgedMessages = dataAndTargets.map((dataAndTarget, i) => {
    if (dataAndTarget.messageNum !== senders[i].messageNum) {
      throw new Error(`Mismatched message numbers in Arbitrum bridged message to ${dataAndTarget.toAddress}`);
    }
    return {
      ...dataAndTarget,
      ...senders[i]
    };
  });

  for (let bridgedMessage of bridgedMessages) {
    const { sender, data, toAddress } = bridgedMessage;
    const arbitrumSigner = await impersonateAddress(
      bridgeDeploymentManager,
      sender
    );
    // if method name == finalizeInboundTransfer(address,address,address,uint256,bytes)
    if(data.slice(0, 10) == '0x2e567b36'){
      const _data = '0x' + data.slice(10, 266);
      const [token,, to, amount] = abiCoder.decode(
        ['address', 'address', 'address', 'uint256'],
        _data
      );
      // if token is mainnet ETH -> than source arbitrum weth
      if(token == '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'){
        if(tenderlyLogs) {
          const callData = bridgeReceiver.interface.encodeFunctionData(
            'sourceTokens',
            [
              {
                dm: bridgeDeploymentManager,
                amount: amount,
                asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
                address: to,
                blacklist: []
              }
            ]
          );

          bridgeDeploymentManager.stashRelayMessage(
            bridgeReceiverAddress,
            callData,
            await arbitrumSigner.getAddress()
          );
        }


        await sourceTokens({
          dm: bridgeDeploymentManager,
          amount: amount,
          asset: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
          address: to,
          blacklist: [],
        });

        continue;
      }
    }
    const transactionRequest = await arbitrumSigner.populateTransaction({
      to: toAddress,
      from: sender,
      data,
      gasPrice: 0
    });

    await setNextBaseFeeToZero(bridgeDeploymentManager);

    const tx = await (
      await arbitrumSigner.sendTransaction(transactionRequest)
    ).wait();
    if (tx === null) {
      throw new Error('Arbitrum relay transaction was not mined');
    }
    if(tenderlyLogs) {
      bridgeDeploymentManager.stashRelayMessage(
        toAddress,
        data,
        sender
      );
    }

    const proposalCreatedLog = tx.logs.find(
      event => event.address === bridgeReceiverAddress
    );
    if (proposalCreatedLog) {
      const parsedLog = bridgeReceiver.interface.parseLog(proposalCreatedLog);
      if (!parsedLog) {
        throw new Error('Arbitrum proposal log could not be parsed');
      }
      const { id, eta } = parsedLog.args;

      // fast forward l2 time
      await setNextBlockTimestamp(bridgeDeploymentManager, toNumber(eta) + 1);

      // execute queued proposal
      await setNextBaseFeeToZero(bridgeDeploymentManager);

      if(tenderlyLogs) {
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
      openBridgedProposals.push({
        id: toBigInt(id),
        eta: toBigInt(eta)
      });
    }
  }

  return openBridgedProposals;
}

export async function relayArbitrumCCTPMint(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  startingBlockNumber: number,
  tenderlyLogs?: any[]
){

  if(tenderlyLogs) {
    return;
  }
  // CCTP relay
  // L1 contracts
  const L1MessageTransmitter = await governanceDeploymentManager.getContractOrThrow('CCTPMessageTransmitter');
  // Arbitrum TokenMinter which is L2 contracts
  const TokenMinter = await bridgeDeploymentManager.existing('TokenMinter', '0xE7Ed1fa7f45D05C508232aa32649D89b73b8bA48', 'arbitrum');
  const transmitterAddress = await L1MessageTransmitter.getAddress();
  const tokenMinterAddress = await TokenMinter.getAddress();
  const { provider } = await getHardhatEthers(governanceDeploymentManager.hre);

  let depositForBurnEvents: Log[] = [];

  if (tenderlyLogs) {
    const messageSentTopic = id('MessageSent(bytes)');

    const tenderlyEvents = tenderlyLogs.filter(log =>
      log.raw?.topics?.[0] === messageSentTopic &&
      log.raw?.address?.toLowerCase() === transmitterAddress.toLowerCase()
    );

    const realEvents = await provider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: transmitterAddress,
      topics: [messageSentTopic]
    });

    depositForBurnEvents = [...realEvents, ...tenderlyEvents];
  } else {
    depositForBurnEvents = await provider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: transmitterAddress,
      topics: [id('MessageSent(bytes)')]
    });
  }

  // Decode message body
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

  // Impersonate the Arbitrum TokenMinter and mint token to recipient
  const ImpersonateLocalTokenMessenger = bridgeDeploymentManager.network === 'arbitrum' ? '0x19330d10d9cc8751218eaf51e8885d058642e08a' : '0x0';
  // Impersonate the Arbitrum TokenMinter and mint token to recipient
  for (let burnEvent of burnEvents) {
    const { recipient, amount, sourceDomain, burnToken } = burnEvent;
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
    if (tenderlyLogs) {
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
