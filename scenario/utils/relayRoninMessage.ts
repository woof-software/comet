import { DeploymentManager } from '../../plugins/deployment_manager';
import { impersonateAddress } from '../../plugins/scenario/utils';
import { setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils';
import { BigNumber, ethers } from 'ethers';
import { Log } from '@ethersproject/abstract-provider';
import { OpenBridgedProposal } from '../context/Gov';
import { isTenderlyLog, updateCCIPStats } from './index';

const roninChainSelector = '6916147374840168594';
const mainnetChainSelector = '5009297550715157269';

const MAINNET_CCIP_ROUTER = '0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D';
const MAINNET_RONIN_OFF_RAMP = '0x9a3Ed7007809CfD666999e439076B4Ce4120528D';

// CCIP 2.0 OnRamp event; the message itself is packed in encodedMessage (MessageV1Codec).
const onRampV2 = new ethers.utils.Interface([
  'event CCIPMessageSent(uint64 indexed destChainSelector, address indexed sender, bytes32 indexed messageId, address feeToken, uint256 tokenAmountBeforeTokenPoolFees, bytes encodedMessage, tuple(address issuer, uint32 destGasLimit, uint32 destBytesOverhead, uint256 feeTokenAmount, bytes extraArgs)[] receipts, bytes[] verifierBlobs)'
]);
const CCIP_MESSAGE_SENT_TOPIC = onRampV2.getEventTopic('CCIPMessageSent');

interface CCIPMessage {
  messageId: string;
  sourceChainSelector: BigNumber;
  sender: string;
  receiver: string;
  data: string;
  tokenAmounts: { token: string, amount: BigNumber }[];
}

// Decodes a MessageV1Codec-encoded message into the fields the relay needs.
function decodeCCIPMessageV1(messageId: string, encoded: string): CCIPMessage {
  const b = ethers.utils.arrayify(encoded);
  let o = 0;
  const take = (n: number) => { const s = b.slice(o, o + n); o += n; return s; };
  const uint = (n: number) => BigNumber.from(take(n));
  const lenPrefixed = (lenBytes: number) => take(uint(lenBytes).toNumber());
  const toAddress = (bytes: Uint8Array) => ethers.utils.getAddress(ethers.utils.hexlify(bytes.slice(-20)));

  if (take(1)[0] !== 1) throw new Error('Unsupported CCIP message version');
  const sourceChainSelector = uint(8);
  take(8 + 8 + 4 + 4 + 4 + 32); // destChainSelector, messageNumber, gas limits, finality, ccvAndExecutorHash
  lenPrefixed(1); // onRamp
  lenPrefixed(1); // offRamp
  const sender = toAddress(lenPrefixed(1));
  const receiver = toAddress(lenPrefixed(1));
  lenPrefixed(2); // destBlob
  const tokenTransfer = lenPrefixed(2);
  const data = ethers.utils.hexlify(lenPrefixed(2));

  // TokenTransferV1: version, amount, sourcePool, sourceToken, ... (at most one per message)
  const tokenAmounts = [];
  if (tokenTransfer.length > 0) {
    const amount = BigNumber.from(tokenTransfer.slice(1, 33));
    const sourceTokenStart = 34 + tokenTransfer[33];
    const sourceTokenLen = tokenTransfer[sourceTokenStart];
    const token = toAddress(tokenTransfer.slice(sourceTokenStart + 1, sourceTokenStart + 1 + sourceTokenLen));
    tokenAmounts.push({ token, amount });
  }
  return { messageId, sourceChainSelector, sender, receiver, data, tokenAmounts };
}

export default async function relayRoninMessage(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  startingBlockNumber: number,
  tenderlyLogs?: any[]
) {

  const l1CCIPOnRamp = await governanceDeploymentManager.getContractOrThrow('roninl1CCIPOnRamp');
  const l2Router = (await bridgeDeploymentManager.getContractOrThrow('l2CCIPRouter'));
  const l2CCIPOffRamp = (await bridgeDeploymentManager.getContractOrThrow('l2CCIPOffRamp'));
  const bridgeReceiver = (await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver'));
  const l1TokenAdminRegistry = await governanceDeploymentManager.getContractOrThrow('l1TokenAdminRegistry');
  const timelockMainnet = await governanceDeploymentManager.getContractOrThrow('timelock');

  const l2TokenAdminRegistry = await bridgeDeploymentManager.existing(
    'l2TokenAdminRegistry',
    '0x90e83d532A4aD13940139c8ACE0B93b0DdbD323a',
    'ronin'
  );

  const l2CCIPOnRamp = await bridgeDeploymentManager.getContractOrThrow('l2CCIPOnRamp');
  const l1CCIPRouter = await governanceDeploymentManager.existing('l1CCIPRouter', MAINNET_CCIP_ROUTER, 'mainnet');
  const l1CCIPOffRamp = await governanceDeploymentManager.existing('roninl1CCIPOffRamp', MAINNET_RONIN_OFF_RAMP, 'mainnet');

  const offRampSigner = await impersonateAddress(bridgeDeploymentManager, l2CCIPOffRamp.address);
  const l1OffRampSigner = await impersonateAddress(governanceDeploymentManager, l1CCIPOffRamp.address);

  const openBridgedProposals: OpenBridgedProposal[] = [];

  const toRoninTopics = [CCIP_MESSAGE_SENT_TOPIC, ethers.utils.hexZeroPad(BigNumber.from(roninChainSelector).toHexString(), 32)];
  let logsCCIP: Log[] = await governanceDeploymentManager.hre.ethers.provider.getLogs({
    fromBlock: startingBlockNumber,
    toBlock: 'latest',
    address: l1CCIPOnRamp.address,
    topics: toRoninTopics
  });

  if (tenderlyLogs) {
    const tenderlyEvents = tenderlyLogs.filter(
      log => log.raw?.topics?.[0] === toRoninTopics[0] &&
        log.raw?.topics?.[1] === toRoninTopics[1] &&
        log.raw?.address?.toLowerCase() === l1CCIPOnRamp.address.toLowerCase()
    );
    logsCCIP = [...logsCCIP, ...tenderlyEvents];
  }

  let routeReceipt: { events: any[] };
  let relayedToReceiver = 0;

  for (const log of logsCCIP) {
    const parsedLog = onRampV2.parseLog(isTenderlyLog(log) ? { topics: log.raw.topics, data: log.raw.data } : log);
    const internalMsg = decodeCCIPMessageV1(parsedLog.args.messageId, parsedLog.args.encodedMessage);
    if (internalMsg.receiver.toLowerCase() !== bridgeReceiver.address.toLowerCase()) {
      console.log(`[CCIP L1->L2] Skipping message with receiver ${internalMsg.receiver} not matching bridgeReceiver ${bridgeReceiver.address}`);
      continue;
    }

    console.log(`[CCIP L1->L2] Found CCIPMessageSent with messageId=${internalMsg.messageId}`);

    await bridgeDeploymentManager.hre.network.provider.request({
      method: 'hardhat_setBalance',
      params: [offRampSigner.address, '0x1000000000000000000000']
    });

    await setNextBaseFeeToZero(bridgeDeploymentManager);
    const any2EVMMessage = {
      messageId: internalMsg.messageId,
      sourceChainSelector: internalMsg.sourceChainSelector,
      sender: ethers.utils.defaultAbiCoder.encode(['address'], [internalMsg.sender]),
      data: internalMsg.data,
      destTokenAmounts: internalMsg.tokenAmounts.map((t: any) => ({
        token: t.token as string,
        amount: BigNumber.from(t.amount)
      })),
    };

    if (tenderlyLogs) {
      const callData = l2Router.interface.encodeFunctionData('routeMessage', [
        any2EVMMessage,
        25_000,
        10_000_000,
        internalMsg.receiver,
      ]);
      bridgeDeploymentManager.stashRelayMessage(
        l2Router.address,
        callData,
        offRampSigner.address
      );
      
      if (internalMsg.tokenAmounts.length) {
        for (const tokenTransferData of internalMsg.tokenAmounts) {
          const l1TokenPoolAddress = await l1TokenAdminRegistry.getPool(tokenTransferData.token);
          const l1TokenPool = new ethers.Contract(
            l1TokenPoolAddress,
            ['function getRemoteToken(uint64) external view returns (bytes)'],
            governanceDeploymentManager.hre.ethers.provider
          );
          const l2Token64 = await l1TokenPool.getRemoteToken(roninChainSelector);
          const l2TokenAddress = ethers.utils.defaultAbiCoder.decode(['address'], l2Token64)[0];
          const l2TokenPool = await l2TokenAdminRegistry.getPool(l2TokenAddress);
          
          const mintAmount = tokenTransferData.amount;
          const mintCallData = new ethers.utils.Interface([
            'function mint(address, uint256) external'
          ]).encodeFunctionData('mint', [internalMsg.receiver, mintAmount]);
          
          bridgeDeploymentManager.stashRelayMessage(
            l2TokenAddress,
            mintCallData,
            l2TokenPool
          );
        }
      }
    }
    const routeTx = await l2Router.connect(offRampSigner).routeMessage(
      any2EVMMessage,
      25_000,
      10_000_000,
      internalMsg.receiver,
    );

    routeReceipt = await routeTx.wait();

    if (internalMsg.tokenAmounts.length) {
      for (const tokenTransferData of internalMsg.tokenAmounts) {
        const l1TokenPoolAddress = await l1TokenAdminRegistry.getPool(tokenTransferData.token);
        const l1TokenPool = new ethers.Contract(
          l1TokenPoolAddress,
          ['function getRemoteToken(uint64) external view returns (bytes)'],
          governanceDeploymentManager.hre.ethers.provider
        );
        const l2Token64 = await l1TokenPool.getRemoteToken(roninChainSelector);
        const l2TokenAddress = ethers.utils.defaultAbiCoder.decode(['address'], l2Token64)[0];
        const l2TokenPool = await l2TokenAdminRegistry.getPool(l2TokenAddress);
        const l2Token = new ethers.Contract(
          l2TokenAddress,
          [
            'function balanceOf(address) external view returns (uint256)',
            'function mint(address, uint256) external',
            'function transfer(address, uint256) external'
          ],
          bridgeDeploymentManager.hre.ethers.provider
        );

        await bridgeDeploymentManager.hre.network.provider.request({
          method: 'hardhat_impersonateAccount',
          params: [l2TokenPool]
        });

        const signer = await impersonateAddress(bridgeDeploymentManager, l2TokenPool);
        await bridgeDeploymentManager.hre.network.provider.request({
          method: 'hardhat_setBalance',
          params: [l2TokenPool, '0x1000000000000000000000']
        });

        const poolBalance = await l2Token.balanceOf(l2TokenPool);
        const mintAmount = tokenTransferData.amount.sub(poolBalance);
        if (mintAmount.lte(0)) {
          console.log(`[CCIP L1->L2] No mint needed for ${l2TokenAddress}`);
          const transferTx = await l2Token.connect(signer).transfer(internalMsg.receiver, tokenTransferData.amount);
          await transferTx.wait();
          console.log(`[CCIP L1->L2] Transferred ${tokenTransferData.amount.toString()} of ${l2TokenAddress} to ${internalMsg.receiver}`);
        } else {
          console.log(`[CCIP L1->L2] Minting ${mintAmount.toString()} of ${l2TokenAddress} to ${internalMsg.receiver}`);
          const mintTx = await l2Token.connect(signer).mint(internalMsg.receiver, mintAmount);
          await mintTx.wait();
          console.log(`[CCIP L1->L2] Minted ${mintAmount.toString()} of ${l2TokenAddress} to ${internalMsg.receiver}`);
        }
      }
    }

    console.log(`[CCIP L1->L2] Routed message to ${internalMsg.receiver}`);
    relayedToReceiver++;
  
    const proposalCreatedEvents = routeReceipt.events?.filter(
      (ev: ethers.Event) =>
        ev.address.toLowerCase() === bridgeReceiver.address.toLowerCase() &&
        ev.topics[0] === bridgeReceiver.interface.getEventTopic('ProposalCreated')
    ) || [];
  
    console.log(`[CCIP L2] Found proposalCreatedEvents: ${JSON.stringify(proposalCreatedEvents)}`);
    for (const proposalCreatedEvent of proposalCreatedEvents) {
      const decoded = bridgeReceiver.interface.parseLog(proposalCreatedEvent);
      const { id, eta } = decoded.args;
      openBridgedProposals.push({ id, eta });
      console.log(`[CCIP L2] Queued proposal: id=${id.toString()}, eta=${eta.toString()}`);
    }
  }

  if (relayedToReceiver === 0) {
    throw new Error(`[${governanceDeploymentManager.network} -> ${bridgeDeploymentManager.network}] No CCIP message to bridgeReceiver found since block ${startingBlockNumber}`);
  }

  // L2 block before executing bridged proposals; bounds the L2->L1 scan below.
  const l2StartingBlockNumber = await bridgeDeploymentManager.hre.ethers.provider.getBlockNumber();

  for (const proposal of openBridgedProposals) {
    const { id, eta } = proposal;
    await setNextBlockTimestamp(bridgeDeploymentManager, eta.toNumber() + 1);
    await setNextBaseFeeToZero(bridgeDeploymentManager);

    if (tenderlyLogs) {
      const callData = bridgeReceiver.interface.encodeFunctionData('executeProposal', [id]);
      await updateCCIPStats(bridgeDeploymentManager, tenderlyLogs);
      const signer = await bridgeDeploymentManager.getSigner();
      bridgeDeploymentManager.stashRelayMessage(
        bridgeReceiver.address,
        callData,
        await signer.getAddress()
      );
    } else {
      await updateCCIPStats(bridgeDeploymentManager);
      const signer = await bridgeDeploymentManager.getSigner();
      await bridgeReceiver.connect(signer).executeProposal(id, { gasPrice: 0 });
      console.log(`[CCIP L2] Executed bridged proposal ${id.toString()}`);
    }
  }
  if (tenderlyLogs) return openBridgedProposals;

  // Process L2→L1 (Ronin→Mainnet) messages
  const logsCCIPL2ToL1: Log[] = await bridgeDeploymentManager.hre.ethers.provider.getLogs({
    fromBlock: l2StartingBlockNumber,
    toBlock: 'latest',
    address: l2CCIPOnRamp.address,
    topics: [CCIP_MESSAGE_SENT_TOPIC, ethers.utils.hexZeroPad(BigNumber.from(mainnetChainSelector).toHexString(), 32)]
  });

  const targetReceivers = [
    timelockMainnet.address.toLowerCase()
  ];

  for (const log of logsCCIPL2ToL1) {
    const parsedLog = onRampV2.parseLog(log);
    const internalMsg = decodeCCIPMessageV1(parsedLog.args.messageId, parsedLog.args.encodedMessage);
    if (!targetReceivers.includes(internalMsg.receiver.toLowerCase())) continue;
    console.log(`[CCIP L2->L1] Found CCIPMessageSent with messageId=${internalMsg.messageId}, receiver=${internalMsg.receiver}`);

    await governanceDeploymentManager.hre.network.provider.request({
      method: 'hardhat_setBalance',
      params: [l1CCIPOffRamp.address, '0x1000000000000000000000']
    });

    await setNextBaseFeeToZero(governanceDeploymentManager);

    const any2EVMMessage = {
      messageId: internalMsg.messageId,
      sourceChainSelector: internalMsg.sourceChainSelector,
      sender: ethers.utils.defaultAbiCoder.encode(['address'], [internalMsg.sender]),
      data: internalMsg.data,
      destTokenAmounts: internalMsg.tokenAmounts.map((t: any) => ({
        token: t.token as string,
        amount: BigNumber.from(t.amount)
      })),
    };

    const routeTx = await l1CCIPRouter.connect(l1OffRampSigner).routeMessage(
      any2EVMMessage,
      25_000,
      2_000_000,
      internalMsg.receiver,
    );

    await routeTx.wait();

    if (internalMsg.tokenAmounts.length) {
      for (const tokenTransferData of internalMsg.tokenAmounts) {
        const l2TokenPoolAddress = await l2TokenAdminRegistry.getPool(tokenTransferData.token);
        const l2TokenPool = new ethers.Contract(
          l2TokenPoolAddress,
          ['function getRemoteToken(uint64) external view returns (bytes)'],
          bridgeDeploymentManager.hre.ethers.provider
        );
        const l1Token64 = await l2TokenPool.getRemoteToken(mainnetChainSelector);
        const l1TokenAddress = ethers.utils.defaultAbiCoder.decode(['address'], l1Token64)[0];
        const l1TokenPool = await l1TokenAdminRegistry.getPool(l1TokenAddress);
        const l1Token = new ethers.Contract(
          l1TokenAddress,
          [
            'function balanceOf(address) external view returns (uint256)',
            'function transfer(address, uint256) external returns (bool)'
          ],
          governanceDeploymentManager.hre.ethers.provider
        );

        const poolSigner = await impersonateAddress(governanceDeploymentManager, l1TokenPool);
        await governanceDeploymentManager.hre.network.provider.request({
          method: 'hardhat_setBalance',
          params: [l1TokenPool, '0x1000000000000000000000']
        });

        const poolBalance = await l1Token.balanceOf(l1TokenPool);
        console.log(`[CCIP L2->L1] Token pool ${l1TokenPool} balance: ${poolBalance.toString()}, transferring ${tokenTransferData.amount.toString()} to ${internalMsg.receiver}`);

        const transferTx = await l1Token.connect(poolSigner).transfer(internalMsg.receiver, tokenTransferData.amount);
        await transferTx.wait();
        console.log(`[CCIP L2->L1] Transferred ${tokenTransferData.amount.toString()} of ${l1TokenAddress} to ${internalMsg.receiver}`);
      }
    }

    console.log(`[CCIP L2->L1] Routed message to ${internalMsg.receiver}`);
  }

  return openBridgedProposals;
}