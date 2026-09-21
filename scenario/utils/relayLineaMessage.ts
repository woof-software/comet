import { DeploymentManager } from '../../plugins/deployment_manager';
import { setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils';
import { constants, Contract, ethers, utils } from 'ethers';
import { Log } from '@ethersproject/abstract-provider';
import { OpenBridgedProposal } from '../context/Gov';
import { impersonateAddress } from '../../plugins/scenario/utils';
import { isTenderlyLog } from './index';

const LINEA_SETTER_ROLE_ACCOUNT = '0x2b0F9C76970975aec03784EFd763623757EF7652';
const DEPOSIT_FOR_BURN_SIGNATURE = 'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)';

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
  const openBridgedProposals: OpenBridgedProposal[] = [];
  // Grab all events on the L1CrossDomainMessenger contract since the `startingBlockNumber`
  const filter = lineaMessageService.filters.MessageSent();
  const filterRollingHash = lineaMessageService.filters.RollingHashUpdated();
  let messageSentEvents: Log[] = [];
  let rollingHashUpdatedEvents: Log[] = [];
  
  if (tenderlyLogs) {
  
    const msgTopic = lineaMessageService.interface.getEventTopic('MessageSent');
    const hashTopic = lineaMessageService.interface.getEventTopic('RollingHashUpdated');
  
    const tenderlyMsgEvents = tenderlyLogs.filter(log =>
      log.raw?.topics?.[0] === msgTopic &&
      log.raw?.address?.toLowerCase() === lineaMessageService.address.toLowerCase()
    );
  
    const tenderlyHashEvents = tenderlyLogs.filter(log =>
      log.raw?.topics?.[0] === hashTopic &&
      log.raw?.address?.toLowerCase() === lineaMessageService.address.toLowerCase()
    );
  
    // getLogs version:
    const fromBlock = Math.max(0, startingBlockNumber - 50000);
    const toBlock = await governanceDeploymentManager.hre.ethers.provider.getBlockNumber();

    const realMsgEvents = await fetchLogsInChunks(
      governanceDeploymentManager.hre.ethers.provider,
      filter,
      fromBlock,
      toBlock,
      lineaMessageService.address
    );

    const realHashEvents = await fetchLogsInChunks(
      governanceDeploymentManager.hre.ethers.provider,
      filterRollingHash,
      fromBlock,
      toBlock,
      lineaMessageService.address
    );

    messageSentEvents = [...realMsgEvents, ...tenderlyMsgEvents];
    rollingHashUpdatedEvents = [...realHashEvents, ...tenderlyHashEvents];
  } else {
    const fromBlock = Math.max(0, startingBlockNumber - 50000);
    const toBlock = await governanceDeploymentManager.hre.ethers.provider.getBlockNumber();

    messageSentEvents = await fetchLogsInChunks(
      governanceDeploymentManager.hre.ethers.provider,
      filter,
      fromBlock,
      toBlock,
      lineaMessageService.address
    );

    rollingHashUpdatedEvents = await fetchLogsInChunks(
      governanceDeploymentManager.hre.ethers.provider,
      filterRollingHash,
      fromBlock,
      toBlock,
      lineaMessageService.address
    );
  }

  for (let i = 0; i < messageSentEvents.length; i++) {
    const messageSentEvent = messageSentEvents[i];
    const rollingHashUpdatedEvent = rollingHashUpdatedEvents[i];

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

    const { _from, _to, _fee, _value, _nonce, _calldata, _messageHash } = parsedMessage.args;
    const { messageNumber, rollingHash, messageHash } = parsedRolling.args;

    if((await l2MessageService.lastAnchoredL1MessageNumber()).gte(messageNumber)) continue;

    await setNextBaseFeeToZero(bridgeDeploymentManager);

    const aliasSetterRoleAccount = await impersonateAddress(
      bridgeDeploymentManager,
      LINEA_SETTER_ROLE_ACCOUNT
    );

    let callData;
    // First the message's hash has to be added by a specific account in the "contract's queue"
    if((await l2MessageService.lastAnchoredL1MessageNumber()).lt(messageNumber)){
      if(tenderlyLogs) {
        callData = l2MessageService.interface.encodeFunctionData('anchorL1L2MessageHashes', [
          [messageHash],
          messageNumber,
          messageNumber,
          rollingHash
        ]);
        bridgeDeploymentManager.stashRelayMessage(
          l2MessageService.address,
          callData,
          aliasSetterRoleAccount.address
        );
      }
      await l2MessageService.connect(aliasSetterRoleAccount).anchorL1L2MessageHashes(
        [messageHash],
        messageNumber,
        messageNumber,
        rollingHash
      );
    }

    if(await l2MessageService.inboxL1L2MessageStatus(_messageHash) == 2) continue;

    let relayMessageTxn: { events: any[] };

    if(
      _from.toLowerCase() === timelock.address.toLowerCase()
      || _from.toLowerCase() === lineaL1TokenBridge.address.toLowerCase()
      || _from.toLowerCase() === lineaL1USDCBridge.address.toLowerCase()
    ){
      if(tenderlyLogs) {
        callData = l2MessageService.interface.encodeFunctionData('claimMessage', [
          _from,
          _to,
          _fee,
          _value,
          constants.AddressZero,
          _calldata,
          _nonce
        ]);
        const signer = await bridgeDeploymentManager.getSigner();
        bridgeDeploymentManager.stashRelayMessage(
          l2MessageService.address,
          callData,
          await signer.getAddress()
        );
      }
   

      relayMessageTxn = await (
        await l2MessageService.connect(signer).claimMessage(
          _from,
          _to,
          _fee,
          _value,
          constants.AddressZero,
          _calldata,
          _nonce,
          {
            gasPrice: 0,
            gasLimit: 10000000
          }
        )
      ).wait();
      
    } else continue;

    // Try to decode the SentMessage data to determine what type of cross-chain activity this is. So far,
    // there are two types:
    // 1. Bridging ERC20 token
    // 2. Cross-chain message passing
    if (_to.toLowerCase() === l2StandardBridge.address.toLowerCase()) {
      // Bridging ERC20 token
      const messageWithoutPrefix = _calldata.slice(2); // strip out the 0x prefix
      const messageWithoutSigHash = '0x' + messageWithoutPrefix.slice(8);

      // Bridging ERC20 token
      const [ l1Token, amount, to ] = ethers.utils.defaultAbiCoder.decode(
        ['address nativeToken', 'uint256 amount', 'address recipient'],
        messageWithoutSigHash
      );

      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of ${l1Token} to user ${to}`
      );
    }
    else if (_to.toLowerCase() === l2USDCBridge.address.toLowerCase()){
      const messageWithoutPrefix = _calldata.slice(2); // strip out the 0x prefix
      const messageWithoutSigHash = '0x' + messageWithoutPrefix.slice(8);
      const [ to, amount ] = ethers.utils.defaultAbiCoder.decode(
        ['address _recipient', 'uint256 _amount'],
        messageWithoutSigHash
      );
      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of USDC.e to user ${to}`
      );
    }
    else if (_to.toLowerCase() === bridgeReceiver.address.toLowerCase()) {
      // Cross-chain message passing
      const proposalCreatedEvent = relayMessageTxn.events.find(
        event => event.address === bridgeReceiver.address
      );
      const {
        args: { id, eta }
      } = bridgeReceiver.interface.parseLog(proposalCreatedEvent);

      // Add the proposal to the list of open bridged proposals to be executed after all the messages have been relayed
      openBridgedProposals.push({ id, eta });
    } else {
      // throw error only on last relay message and no proposal created event found
      if(messageSentEvents.indexOf(messageSentEvent) === messageSentEvents.length - 1 && openBridgedProposals.length === 0)
        throw new Error(`[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Unrecognized target for cross-chain message`);
    }
  }

  // Execute open bridged proposals now that all messages have been bridged
  for (let proposal of openBridgedProposals) {
    const { eta, id } = proposal;
    // Fast forward l2 time
    await setNextBlockTimestamp(bridgeDeploymentManager, eta.toNumber() + 1);

    // Execute queued proposal
    await setNextBaseFeeToZero(bridgeDeploymentManager);
    if(tenderlyLogs) {
      const callData = bridgeReceiver.interface.encodeFunctionData('executeProposal', [id]);
      const signer = await bridgeDeploymentManager.getSigner();

      bridgeDeploymentManager.stashRelayMessage(
        bridgeReceiver.address,
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

/**
 * Simulates the L1 side of Circle CCTP transfers initiated by executed Linea proposals.
 *
 * Executing a bridged proposal only burns USDC on Linea; the mint on Ethereum mainnet needs an off-chain
 * attestation that does not exist on a fork. For every `depositForBurn` action of the given proposals, mint
 * the burned amount to the `mintRecipient` on the governance network through the L1 CCTP TokenMinter.
 */
export async function simulateL2ToL1CCTPBridging(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  l2StartingBlockNumber: number,
  proposals: OpenBridgedProposal[],
  tenderlyLogs?: any[]
) {
  if (tenderlyLogs || proposals.length === 0) {
    return;
  }

  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const proposalIds = proposals.map(({ id }) => id.toString());

  // ProposalCreated(address indexed rootMessageSender, uint256 id, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 eta)
  const proposalCreatedEvents = await bridgeDeploymentManager.retry(() =>
    bridgeDeploymentManager.hre.ethers.provider.getLogs({
      fromBlock: l2StartingBlockNumber,
      toBlock: 'latest',
      address: bridgeReceiver.address,
      topics: [utils.id('ProposalCreated(address,uint256,address[],uint256[],string[],bytes[],uint256)')]
    })
  );

  for (const event of proposalCreatedEvents) {
    const { id, targets, signatures, calldatas } = bridgeReceiver.interface.parseLog(event).args;
    // Only handle the proposals that were just executed, so earlier ones are never minted twice
    if (!proposalIds.includes(id.toString())) continue;

    for (let i = 0; i < signatures.length; i++) {
      if (signatures[i] !== DEPOSIT_FOR_BURN_SIGNATURE) continue;

      const [amount, , mintRecipientBytes32, burnToken] = utils.defaultAbiCoder.decode(
        ['uint256', 'uint32', 'bytes32', 'address', 'bytes32', 'uint256', 'uint32'],
        calldatas[i]
      );
      const mintRecipient = utils.getAddress(utils.hexDataSlice(mintRecipientBytes32, 12));

      // L2: the domain of the chain the USDC was burned on, resolved through the target TokenMessenger
      const l2TokenMessenger = new Contract(
        targets[i],
        ['function localMessageTransmitter() view returns (address)'],
        bridgeDeploymentManager.hre.ethers.provider
      );
      const l2MessageTransmitter = new Contract(
        await l2TokenMessenger.localMessageTransmitter(),
        ['function localDomain() view returns (uint32)'],
        bridgeDeploymentManager.hre.ethers.provider
      );
      const sourceDomain = await l2MessageTransmitter.localDomain();

      // L1: the TokenMinter maps (sourceDomain, burnToken) to the local USDC and is only callable by the TokenMessenger
      const l1TokenMessenger = await governanceDeploymentManager.getContractOrThrow('CCTPTokenMessenger');
      const l1TokenMinter = new Contract(
        await l1TokenMessenger.localMinter(),
        ['function mint(uint32 sourceDomain, bytes32 burnToken, address recipientOne, address recipientTwo, uint256 amountOne, uint256 amountTwo) returns (address)'],
        await governanceDeploymentManager.getSigner()
      );
      const l1TokenMessengerSigner = await impersonateAddress(
        governanceDeploymentManager,
        l1TokenMessenger.address
      );
      await governanceDeploymentManager.hre.network.provider.send('hardhat_setBalance', [
        l1TokenMessengerSigner.address,
        '0x1000000000000000000',
      ]);

      console.log(
        `[${bridgeDeploymentManager.network} -> ${governanceDeploymentManager.network}] Simulating CCTP mint of ${amount} of ${burnToken} to ${mintRecipient}`
      );
      await (
        await l1TokenMinter.connect(l1TokenMessengerSigner).mint(
          sourceDomain,
          utils.hexZeroPad(burnToken, 32),
          mintRecipient,
          l1TokenMinter.address, // second recipient, same call shape as the Optimism and Arbitrum simulations
          amount,
          1
        )
      ).wait();
    }
  }
}

// Helper to fetch logs in chunks of 10,000 blocks
async function fetchLogsInChunks(provider: any, filter: any, fromBlock: number, toBlock: number, address: string) {
  const chunkSize = 10000;
  let logs: Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    const chunkLogs = await provider.getLogs({
      fromBlock: start,
      toBlock: end,
      address,
      topics: filter.topics!
    });
    logs = logs.concat(chunkLogs);
  }
  return logs;
}
