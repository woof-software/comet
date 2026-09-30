import { DeploymentManager } from '../../plugins/deployment_manager';
import { setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils';
import { Log } from '@ethersproject/abstract-provider';
import { impersonateAddress } from '../../plugins/scenario/utils';
import { OpenBridgedProposal } from '../context/Gov';
import { BigNumber, ethers } from 'ethers';
import { applyL1ToL2Alias, isTenderlyLog } from './index';

/*
The Scroll relayer applies an offset to the message sender.

applyL1ToL2Alias mimics the AddressAliasHelper.applyL1ToL2Alias fn that converts
an L1 address to its offset, L2 equivalent.
*/

// Dedicated USDC gateway pair, not the generic L2StandardERC20Gateway; the L2 side isn't in any deployment's roots.
const L2_USDC_GATEWAY = '0x33B60d5Dd260d453cAC3782b0bDC01ce84672142';
// L1ScrollMessenger.xDomainMessageSender storage slot; spoofed below since a real L2->L1 proof isn't producible on a fork.
const L1_MESSENGER_X_DOMAIN_SENDER_SLOT = 201;

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

  const openBridgedProposals: OpenBridgedProposal[] = [];

  // Grab all events on the L1CrossDomainMessenger contract since the `startingBlockNumber`
  const filter = scrollMessenger.filters.SentMessage();
  let messageSentEvents: Log[] = [];

  if (tenderlyLogs) {
    const topic = scrollMessenger.interface.getEventTopic('SentMessage');
    const tenderlyEvents = tenderlyLogs.filter(
      log => log.raw?.topics?.[0] === topic && log.raw?.address?.toLowerCase() === scrollMessenger.address.toLowerCase()
    );
    const realEvents = await governanceDeploymentManager.hre.ethers.provider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: scrollMessenger.address,
      topics: filter.topics!
    });
    messageSentEvents = [...realEvents, ...tenderlyEvents];
  } else {
    messageSentEvents = await governanceDeploymentManager.hre.ethers.provider.getLogs({
      fromBlock: startingBlockNumber,
      toBlock: 'latest',
      address: scrollMessenger.address,
      topics: filter.topics!
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
        applyL1ToL2Alias(scrollMessenger.address)
      );
    }

    let relayMessageTxn;
    if (tenderlyLogs) {
      const callData = l2Messenger.interface.encodeFunctionData('relayMessage', [sender, target, value, messageNonce, message]);
      bridgeDeploymentManager.stashRelayMessage(
        l2Messenger.address,
        callData,
        aliasAccount.address
      );
    }
    relayMessageTxn = await (
      await l2Messenger.connect(aliasAccount).relayMessage(
        sender,
        target,
        value,
        messageNonce,
        message,
        { gasPrice: 0, gasLimit }
      )
    ).wait();

    const messageWithoutPrefix = message.slice(2); // strip out the 0x prefix
    const messageWithoutSigHash = '0x' + messageWithoutPrefix.slice(8);

    // Try to decode the SentMessage data to determine what type of cross-chain activity this is. So far,
    // there are two types:
    // 1. Bridging ERC20 token or ETH
    // 2. Cross-chain message passing
    if (target === l2ERC20Gateway.address) {
      // 1a. Bridging ERC20 token
      const [ l1Token, _l2Token, _from, to, amount, _data ] = ethers.utils.defaultAbiCoder.decode(
        ['address _l1Token', 'address _l2Token','address _from', 'address _to','uint256 _amount', 'bytes _data'],
        messageWithoutSigHash
      );

      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of ${l1Token} to user ${to}`
      );
    } else if (target === l2ETHGateway.address){
      // 1a. Bridging ETH
      const [ _from, to, amount, _data ] = ethers.utils.defaultAbiCoder.decode(
        ['address _from', 'address _to', 'uint256 _amount', 'bytes _data'],
        messageWithoutSigHash
      );

      const oldBalance = await bridgeDeploymentManager.hre.ethers.provider.getBalance(to);
      const newBalance = oldBalance.add(BigNumber.from(amount));
      // This is our best attempt to mimic the deposit transaction type (not supported in Hardhat) that Optimism uses to deposit ETH to an L2 address
      await bridgeDeploymentManager.hre.ethers.provider.send('hardhat_setBalance', [
        to,
        ethers.utils.hexStripZeros(newBalance.toHexString()),
      ]);

      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of ETH to user ${to}`
      );
    }else if (target === l2WETHGateway.address){
      // 1c. Bridging WETH
      const [ _l1Token, _l2Token, _from, to, amount, _data ] = ethers.utils.defaultAbiCoder.decode(
        ['address _l1Token', 'address _l2Token','address _from', 'address _to','uint256 _amount', 'bytes _data'],
        messageWithoutSigHash
      );

      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of WETH to user ${to}`
      );
    } else if (target === l2WstETHGateway.address){
      // 1d. Bridging WstETH
      const [ _l1Token, _l2Token, _from, to, amount, _data ] = ethers.utils.defaultAbiCoder.decode(
        ['address _l1Token', 'address _l2Token','address _from', 'address _to','uint256 _amount', 'bytes _data'],
        messageWithoutSigHash
      );

      console.log(
        `[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] Bridged over ${amount} of WstETH to user ${to}`
      );
    } else if (target === bridgeReceiver.address) {
      // Cross-chain message passing
      const proposalCreatedEvent = relayMessageTxn.events.find(event => event.address.toLowerCase() === bridgeReceiver.address.toLowerCase());
      const { args: { id, eta } } = bridgeReceiver.interface.parseLog(proposalCreatedEvent);

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
    await setNextBlockTimestamp(bridgeDeploymentManager, eta.toNumber() + 1);

    // Execute queued proposal
    await setNextBaseFeeToZero(bridgeDeploymentManager);
    if (tenderlyLogs) {
      const callData = bridgeReceiver.interface.encodeFunctionData('executeProposal', [id]);
      const signer = await bridgeDeploymentManager.getSigner();
      bridgeDeploymentManager.stashRelayMessage(
        bridgeReceiver.address,
        callData,
        signer.address
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

/**
 * Simulates the L1 side of a Scroll L2->L1 USDC withdrawal: reads SentMessage events targeting the L1 USDC
 * gateway, decodes the finalizeWithdrawERC20 call, and invokes it directly (real finalization needs a Merkle
 * proof of L2 state, not producible on a fork), impersonating the L1 messenger with xDomainMessageSender
 * spoofed to the L2 gateway.
 */
export async function simulateL2ToL1USDCBridging(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  l2StartingBlockNumber: number,
  tenderlyLogs?: any[]
) {
  if (tenderlyLogs) {
    return;
  }
  console.log('Simulating L2->L1 USDC withdrawals for any executed Scroll proposals...');

  const l2Messenger = await bridgeDeploymentManager.getContractOrThrow('l2Messenger');
  const l1Messenger = await governanceDeploymentManager.getContractOrThrow('scrollMessenger');
  const l1USDCGateway = await governanceDeploymentManager.getContractOrThrow('scrollL1USDCGateway');

  const latestBlockNumber = await bridgeDeploymentManager.hre.ethers.provider.getBlockNumber();
  const messageSentEvents = await bridgeDeploymentManager.retry(() =>
    bridgeDeploymentManager.hre.ethers.provider.getLogs({
      fromBlock: l2StartingBlockNumber,
      toBlock: latestBlockNumber,
      address: l2Messenger.address,
      topics: [l2Messenger.interface.getEventTopic('SentMessage')]
    })
  );

  for (const event of messageSentEvents) {
    const { target, message } = l2Messenger.interface.parseLog(event).args;
    // target = L1 destination (L1 USDC gateway), not the L2 sender
    if (target.toLowerCase() !== l1USDCGateway.address.toLowerCase()) continue;

    // strip the 4-byte finalizeWithdrawERC20 selector
    const [l1Token, l2Token, from, to, amount] = ethers.utils.defaultAbiCoder.decode(
      ['address', 'address', 'address', 'address', 'uint256', 'bytes'],
      '0x' + message.slice(10)
    );

    console.log(`[Scroll -> mainnet] Simulating L2->L1 withdrawal of ${amount} of ${l1Token} to ${to}`);

    await governanceDeploymentManager.hre.network.provider.send('hardhat_setStorageAt', [
      l1Messenger.address,
      ethers.utils.hexlify(L1_MESSENGER_X_DOMAIN_SENDER_SLOT),
      ethers.utils.hexZeroPad(L2_USDC_GATEWAY, 32)
    ]);
    const l1MessengerSigner = await impersonateAddress(governanceDeploymentManager, l1Messenger.address);
    await governanceDeploymentManager.hre.network.provider.send('hardhat_setBalance', [
      l1MessengerSigner.address,
      '0x1000000000000000000',
    ]);

    await (
      await l1USDCGateway.connect(l1MessengerSigner).finalizeWithdrawERC20(
        l1Token, l2Token, from, to, amount, '0x'
      )
    ).wait();
  }
}
