import type { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import { impersonateAddress } from '../../plugins/scenario/utils/index.js';
import { setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils.js';
import { AbiCoder, Contract, getAddress, hexlify, id, parseEther, toNumber, toQuantity, zeroPadValue } from 'ethers';
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

export async function simulateL2ToL1TokenBridging(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  l2StartingBlockNumber?: number,
  tenderlyLogs?: any[]
) {
  if(tenderlyLogs) {
    return;
  }
  console.log('Simulating L2→L1 token bridging for any executed Optimism proposals...');

  // L2 contracts
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const optimismL2Bridge = await bridgeDeploymentManager.getContractOrThrow('l2StandardBridge');
  const l2CrossDomainMessenger = await bridgeDeploymentManager.getContractOrThrow('l2CrossDomainMessenger');

  // L1 contracts
  const opL1CrossDomainMessenger = await governanceDeploymentManager.getContractOrThrow('opL1CrossDomainMessenger');
  const optimismL1Bridge = await governanceDeploymentManager.getContractOrThrow('opL1StandardBridge');
  const OPTIMISM_L1_PORTAL = '0xbEb5Fc579115071764c7423A4f12eDde41f106Ed';

  // Parse recent ProposalCreated events to find actions that bridge tokens from L2 to L1
  // ProposalCreated(address indexed rootMessageSender, uint256 id, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 eta)
  console.log('Fetching recent ProposalCreated events from BridgeReceiver...');
  const { provider: bridgeProvider } = await getHardhatEthers(bridgeDeploymentManager.hre);
  const { provider: governanceProvider } = await getHardhatEthers(governanceDeploymentManager.hre);
  const bridgeReceiverAddress = await bridgeReceiver.getAddress();
  const l2BridgeAddress = await optimismL2Bridge.getAddress();
  const l2MessengerAddress = await l2CrossDomainMessenger.getAddress();
  const l1MessengerAddress = await opL1CrossDomainMessenger.getAddress();
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
  const depositForBurnSignature = 'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)';

  for (const event of proposalCreatedEvents) {
    const decodedEvent = bridgeReceiver.interface.parseLog(event);
    if (!decodedEvent) {
      throw new Error('Optimism ProposalCreated log could not be parsed');
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
        console.log('Optimism L1 Portal address:', OPTIMISM_L1_PORTAL);
        console.log('Overriding slot', zeroPadValue('0x32', 32));
        console.log('l2CrossDomainMessenger:', zeroPadValue(l2MessengerAddress, 32));
        await governanceProvider.send('hardhat_setStorageAt', [
          OPTIMISM_L1_PORTAL,
          zeroPadValue('0x32', 32),
          zeroPadValue(l2MessengerAddress, 32)
        ]);

        await governanceProvider.send('hardhat_setStorageAt', [
          l1MessengerAddress,
          '0xcc',
          zeroPadValue(l2BridgeAddress, 32)
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
          await optimismL1Bridge.connect(domainMessengerSigner).getFunction('finalizeBridgeERC20')(
            remoteToken, localToken, bridgeReceiverAddress, to, amount, extraData,
            { gasPrice: 0, gasLimit: 2_500_000 }
          )
        ).wait();
        await governanceProvider.send('hardhat_setStorageAt', [
          OPTIMISM_L1_PORTAL,
          zeroPadValue('0x32', 32),
          zeroPadValue('0xdead', 32)
        ]);
      }

      // Look for L2→L1 CCTP depositForBurn calls (Circle CCTP bridge, e.g. native USDC)
      if (signatures[i] === depositForBurnSignature) {
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
    }
  }
}
