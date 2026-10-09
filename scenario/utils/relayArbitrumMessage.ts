import type { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import { getHardhatEthers } from '../../plugins/deployment_manager/hardhat3/runtime.js';
import { impersonateAddress } from '../../plugins/scenario/utils/index.js';
import { setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils.js';
import { AbiCoder, Contract, ZeroAddress, getAddress, getBytes, hexlify, id, toBigInt, toBeHex, toNumber, zeroPadValue } from 'ethers';
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
    const innerData = header + data.slice(headerLength + (11 * wordLength));
    const toValue = data.slice(headerLength + (2 * wordLength), headerLength + (3 * wordLength));
    let toAddress = toBeHex(BigInt(`0x${toValue}`));

    // if length of toAddress is less than 42, then it is padded with 0s and we need to add them after 0x
    if(toAddress.length < 42) {
      toAddress = `0x${toAddress.slice(2).padStart(40, '0')}`;
    }

    const messageNum = topics[1];
    return {
      data: innerData,
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
        // Mock ArbSys precompile (0x64) — Arbitrum precompiles don't exist in Hardhat's EVM,
        // but the L2 gateways call ArbSys.sendTxToL1 internally during outboundTransfer.
        // Bytecode 0x60206000f3 disassembles to: PUSH1 0x20 | PUSH1 0x00 | RETURN
        // which returns 32 zero bytes from uninitialized memory for any call.
        const { provider: bridgeProvider } = await getHardhatEthers(bridgeDeploymentManager.hre);
        await bridgeProvider.send('hardhat_setCode', [
          '0x0000000000000000000000000000000000000064',
          '0x60206000f3',
        ]);

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

export async function simulateL2ToL1TokenBridging(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  l2StartingBlockNumber?: number,
  tenderlyLogs?: any[],
  proposalId?: bigint
) {
  if(tenderlyLogs) {
    return;
  }
  console.log('Simulating L2→L1 token bridging for any executed Arbitrum proposals...');

  // L2 contracts
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');

  // Parse recent ProposalCreated events to find actions that bridge tokens from L2 to L1
  // ProposalCreated(address indexed rootMessageSender, uint256 id, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 eta)
  console.log('Fetching recent ProposalCreated events from BridgeReceiver...');
  const { provider: bridgeProvider } = await getHardhatEthers(bridgeDeploymentManager.hre);
  const { provider: governanceProvider } = await getHardhatEthers(governanceDeploymentManager.hre);
  const bridgeReceiverAddress = await bridgeReceiver.getAddress();
  const latestBlockNumber = await bridgeProvider.getBlockNumber();
  const proposalCreatedEvents = await bridgeDeploymentManager.retry(() =>
    bridgeProvider.getLogs({
      fromBlock: l2StartingBlockNumber ?? Math.max(0, latestBlockNumber - 1000),
      toBlock: 'latest',
      address: bridgeReceiverAddress,
      topics: [id('ProposalCreated(address,uint256,address[],uint256[],string[],bytes[],uint256)')]
    })
  );
  const outboundTransferSignature = 'outboundTransfer(address,address,uint256,bytes)';
  const outboundTransfer2Signature = 'outboundTransfer(address,address,uint256,uint256,uint256,bytes)';
  const depositForBurnSignature = 'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)';
  const ARBITRUM_GATEWAY_ROUTER = '0x5288c571Fd7aD117beA99bF60FE0846C4E84F933';
  const ARBITRUM_BRIDGE = '0x8315177ab297ba92a06054ce80a67ed4dbd7ed3a';
  const ARBITRUM_OUTBOX = '0x667e23ABd27E623c11d4CC00ca3EC4d0bD63337a';
  const MAINNET_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

  for (const event of proposalCreatedEvents) {
    const decodedEvent = bridgeReceiver.interface.parseLog(event);
    if (!decodedEvent) {
      throw new Error('Arbitrum ProposalCreated log could not be parsed');
    }
    const { id, targets, signatures, calldatas } = decodedEvent.args;

    if (proposalId !== undefined && id !== proposalId) {
      continue;
    }

    for (let i = 0; i < signatures.length; i++) {
      let bridgedTokens = false;

      // Look for L2→L1 outboundTransfer calls (standard Arbitrum gateway bridge)
      if (signatures[i] === outboundTransferSignature || signatures[i] === outboundTransfer2Signature) {
        bridgedTokens = true;
        const [l1Token, to, amount] = (() => {
          if (signatures[i] === outboundTransferSignature) {
            return abiCoder.decode(
              ['address', 'address', 'uint256', 'bytes'],
              calldatas[i]
            );
          } else if (signatures[i] === outboundTransfer2Signature) {
            return abiCoder.decode(
              ['address', 'address', 'uint256', 'uint256', 'uint256', 'bytes'],
              calldatas[i]
            );
          }
        })();
        console.log(`Simulating L2→L1 token bridging: ${amount.toString()} of ${l1Token} to ${to}`);

        const gatewayAddress = await (async () => {
          if(targets[i].toLowerCase() === ARBITRUM_GATEWAY_ROUTER.toLowerCase()) { // Arbitrum WETH gateway
            const router = new Contract(
              ARBITRUM_GATEWAY_ROUTER,
              ['function l1TokenToGateway(address l1Token) view returns (address)'],
              await governanceDeploymentManager.getSigner()
            );
            return await router.l1TokenToGateway(l1Token);
          }
          return targets[i];
        })();
        const l2Gateway = new Contract(
          gatewayAddress,
          ['function counterpartGateway() view returns (address)'],
          await bridgeDeploymentManager.getSigner()
        );
        const l1GatewayAddress = await l2Gateway.counterpartGateway();

        const l1Gateway = new Contract(
          l1GatewayAddress,
          [
            'function finalizeInboundTransfer(address _token, address _from, address _to, uint256 _amount, bytes calldata _data)',
            'function inbox() view returns (address)'
          ],
          await governanceDeploymentManager.getSigner()
        );
        // override 0x4 slot in outbox to L2 gateway
        await governanceProvider.send('hardhat_setStorageAt', [
          ARBITRUM_OUTBOX,
          '0x4',
          zeroPadValue(gatewayAddress, 32)
        ]);

        // impersonate outbox to call finalizeInboundTransfer, as if the message came from L2 gateway
        const outboxSigner = await impersonateAddress(
          governanceDeploymentManager,
          ARBITRUM_OUTBOX
        );

        await governanceProvider.send('hardhat_setBalance', [
          await outboxSigner.getAddress(),
          '0x1000000000000000000',
        ]);

        const arbitrumBridge = new Contract(
          ARBITRUM_BRIDGE,
          ['function executeCall(address to, uint256 value, bytes calldata data)'],
          outboxSigner
        );

        const data = l1Gateway.interface.encodeFunctionData(
          'finalizeInboundTransfer',
          [
            l1Token,
            ARBITRUM_GATEWAY_ROUTER,
            to, amount,
            abiCoder.encode(['uint256', 'bytes'], [0, '0x'])
          ]);
        console.log(`Relaying message to L1 gateway at ${l1GatewayAddress} with data: ${data}`);
        const bridgeTx = await arbitrumBridge.connect(outboxSigner).getFunction('executeCall')(
          await l1Gateway.getAddress(),
          l1Token.toLowerCase() === MAINNET_WETH.toLowerCase() ? amount : 0,
          data,
        );
        await (bridgeTx).wait();
        // stop impersonation after the call
        await governanceProvider.send('hardhat_stopImpersonatingAccount', [
          await outboxSigner.getAddress()
        ]);
        // override 0x4 slot in outbox to L2 gateway
        await governanceProvider.send('hardhat_setStorageAt', [
          ARBITRUM_OUTBOX,
          '0x4',
          zeroPadValue(ZeroAddress, 32)
        ]);
      }

      // Look for L2→L1 CCTP depositForBurn calls (Circle CCTP bridge, e.g. native USDC)
      if (signatures[i] === depositForBurnSignature) {
        bridgedTokens = true;
        const [amount, , mintRecipientBytes32, burnToken] = abiCoder.decode(
          ['uint256', 'uint32', 'bytes32', 'address', 'bytes32', 'uint256', 'uint32'],
          calldatas[i]
        );

        const mintRecipient = getAddress('0x' + hexlify(mintRecipientBytes32).slice(-40));

        try {
          // L2
          const l2CCTPTokenMessenger = await bridgeDeploymentManager.getContractOrThrow('CCTPMessageTransmitter');
          // Resolve L1 token via CCTP TokenMinter: burnToken (L2) → localToken (L1)
          const l1CCTPTokenMessenger = await governanceDeploymentManager.getContractOrThrow('CCTPTokenMessenger');
          const tokenMinterAddress = await l1CCTPTokenMessenger.localMinter();
          const L1TokenMinter = new Contract(
            tokenMinterAddress,
            ['function mint(uint32 sourceDomain, bytes32 burnToken, address recipientOne, address recipientTwo, uint256 amountOne, uint256 amountTwo) returns (address)'],
            await governanceDeploymentManager.getSigner()
          );
          const l1CCTPTokenMessengerSigner = await impersonateAddress(
            governanceDeploymentManager,
            await l1CCTPTokenMessenger.getAddress()
          );
          await governanceProvider.send('hardhat_setBalance', [
            await l1CCTPTokenMessengerSigner.getAddress(),
            '0x1000000000000000000',
          ]);
          const sourceDomain = await l2CCTPTokenMessenger.localDomain();
          const mintTx = await L1TokenMinter.connect(l1CCTPTokenMessengerSigner).getFunction('mint')(
            sourceDomain,
            zeroPadValue(burnToken, 32),
            mintRecipient,
            await L1TokenMinter.getAddress(), // mint to the token minter first, since some tokens (e.g. USDC) have a cap on max amount per mint, and the token minter can then transfer to the recipient
            amount,
            1
          );
          console.log('Simulated CCTP mint transaction:', mintTx.hash);
          await mintTx.wait();
        } catch (e) {
          console.log(`Warning: Could not simulate CCTP L2→L1 bridging for depositForBurn: ${e.message}`);
        }
      }
      if (bridgedTokens) {
        await governanceDeploymentManager.retry(() =>
          governanceProvider.send('evm_mine', [])
        );
      }
    }
  }
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
