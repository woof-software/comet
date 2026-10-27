import { BigNumber, Contract, ethers, providers } from 'ethers';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { impersonateAddress } from '../../plugins/scenario/utils';
import { setNextBaseFeeToZero } from './hreUtils';

const endpointInterface = new ethers.utils.Interface([
  'event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)',
  'event PacketDelivered((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver)',
  'function eid() view returns (uint32)',
  'function getReceiveLibrary(address receiver, uint32 srcEid) view returns (address lib, bool isDefault)',
  'function inboundNonce(address receiver, uint32 srcEid, bytes32 sender) view returns (uint64)',
  'function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce) view returns (bytes32)',
  'function verify((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 payloadHash)',
  'function lzReceive((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 guid, bytes message, bytes extraData) payable',
]);

const oftInterface = new ethers.utils.Interface([
  'event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
  'event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)',
  'function endpoint() view returns (address)',
  'function decimalConversionRate() view returns (uint256)',
]);

const PACKET_VERSION = 1;
const EXECUTOR_WORKER_ID = 1;
const OPTION_TYPE_LZRECEIVE = 1;
const OPTION_TYPE_NATIVE_DROP = 2;
const OPTION_TYPE_LZCOMPOSE = 3;
// Matches LayerZero's executor: execute302 gives the endpoint floor(optionGas * 64 / 63) + 19,000 gas.
const ENDPOINT_OVERHEAD_GAS = 19_000;
// OFTMsgCodec: sendTo(32) amountSD(8), then composeFrom + composeMsg only when composing.
const OFT_MESSAGE_LENGTH = 40;

// PacketV1Codec layout: version(1) nonce(8) srcEid(4) sender(32) dstEid(4) receiver(32) guid(32) message(rest).
function decodePacket(encodedPayload: string) {
  return {
    version: BigNumber.from(ethers.utils.hexDataSlice(encodedPayload, 0, 1)).toNumber(),
    nonce: BigNumber.from(ethers.utils.hexDataSlice(encodedPayload, 1, 9)),
    srcEid: BigNumber.from(ethers.utils.hexDataSlice(encodedPayload, 9, 13)).toNumber(),
    sender: ethers.utils.hexDataSlice(encodedPayload, 13, 45),
    dstEid: BigNumber.from(ethers.utils.hexDataSlice(encodedPayload, 45, 49)).toNumber(),
    receiver: ethers.utils.getAddress(ethers.utils.hexDataSlice(encodedPayload, 61, 81)),
    guid: ethers.utils.hexDataSlice(encodedPayload, 81, 113),
    message: ethers.utils.hexDataSlice(encodedPayload, 113),
  };
}

// Executor's lzReceive gas and value from type-3 options (OApp enforced options are already merged in).
// workerId(1) size(2) optionType(1) params(size - 1), repeated after the uint16 type prefix.
function decodeExecutorOptions(options: string): { gas: BigNumber, value: BigNumber } {
  const bytes = ethers.utils.arrayify(options);
  if (bytes.length < 2 || ((bytes[0] << 8) | bytes[1]) !== 3) {
    throw new Error(`Unsupported LayerZero options type: ${options}`);
  }

  let gas = BigNumber.from(0);
  let value = BigNumber.from(0);
  let offset = 2;

  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) {
      throw new Error(`Truncated LayerZero option header at byte ${offset}: ${options}`);
    }
    const workerId = bytes[offset];
    const size = (bytes[offset + 1] << 8) | bytes[offset + 2];
    const optionEnd = offset + 3 + size;
    if (size < 1 || optionEnd > bytes.length) {
      throw new Error(`Truncated LayerZero option at byte ${offset} (size ${size}): ${options}`);
    }
    const optionType = bytes[offset + 3];
    const params = bytes.slice(offset + 4, optionEnd);
    offset = optionEnd;

    if (workerId !== EXECUTOR_WORKER_ID) continue;

    if (optionType === OPTION_TYPE_LZRECEIVE) {
      if (params.length !== 16 && params.length !== 32) {
        throw new Error(`Malformed LayerZero lzReceive option (${params.length} param bytes): ${options}`);
      }
      gas = gas.add(BigNumber.from(params.slice(0, 16)));
      if (params.length === 32) {
        value = value.add(BigNumber.from(params.slice(16, 32)));
      }
    } else if (optionType === OPTION_TYPE_NATIVE_DROP) {
      // Doesn't affect lzReceive; the dropped native amount just isn't credited on the fork.
      console.log(`LayerZero native drop option not simulated: ${ethers.utils.hexlify(params)}`);
    } else if (optionType === OPTION_TYPE_LZCOMPOSE) {
      throw new Error(`LayerZero lzCompose option is not simulated: ${options}`);
    }
  }

  if (gas.isZero()) throw new Error(`No lzReceive gas in LayerZero options: ${options}`);

  return { gas, value };
}

// Intrinsic gas of a call's calldata.
function intrinsicGas(data: string): number {
  return ethers.utils.arrayify(data).reduce((sum, byte) => sum + (byte === 0 ? 4 : 16), 21_000);
}

type Packet = ReturnType<typeof decodePacket>;

type DeliveryContext = {
  tag: string;
  governanceDeploymentManager: DeploymentManager;
  l1Endpoint: Contract;
  l2Provider: providers.Provider;
  l2Receipts: Map<string, Promise<providers.TransactionReceipt>>;
};

function findPacketLog(logs: providers.Log[], emitter: string, topic: string, guid: string): providers.Log | undefined {
  return logs.find((receiptLog) =>
    receiptLog.address.toLowerCase() === emitter.toLowerCase()
    && receiptLog.topics[0] === topic
    && receiptLog.topics[1] === guid
  );
}

function bytes32ToAddress(value: string): string {
  return ethers.utils.getAddress(ethers.utils.hexDataSlice(value, 12, 32));
}

// Several packets can come from one L2 tx, so its receipt is fetched once.
function getL2Receipt({ l2Provider, l2Receipts }: DeliveryContext, txHash: string): Promise<providers.TransactionReceipt> {
  if (!l2Receipts.has(txHash)) {
    l2Receipts.set(txHash, l2Provider.getTransactionReceipt(txHash));
  }
  return l2Receipts.get(txHash);
}

// Rejects packets the L1 endpoint would never accept: wrong codec version, foreign srcEid, or a receiver
// bound to another endpoint.
async function validatePacket({ tag, l1Endpoint }: DeliveryContext, packet: Packet, l2Eid: number): Promise<void> {
  if (packet.version !== PACKET_VERSION) {
    throw new Error(`${tag} Unsupported packet version ${packet.version}`);
  }
  if (packet.srcEid !== l2Eid) {
    throw new Error(`${tag} Packet srcEid ${packet.srcEid} != L2 endpoint eid ${l2Eid}`);
  }
  const receiver = new ethers.Contract(packet.receiver, oftInterface, l1Endpoint.provider);
  let receiverEndpoint: string;
  try {
    receiverEndpoint = await receiver.endpoint();
  } catch (error) {
    throw new Error(`${tag} Receiver ${packet.receiver} is not a LayerZero OApp (no endpoint()): ${error.message}`);
  }
  if (receiverEndpoint.toLowerCase() !== l1Endpoint.address.toLowerCase()) {
    throw new Error(`${tag} Receiver ${packet.receiver} is not bound to L1 endpoint ${l1Endpoint.address}`);
  }
}

// Stands in for the DVN quorum: the configured receive library (the only caller the endpoint accepts)
// commits the payload hash. Nonces still in flight ahead of ours at the fork block get placeholder
// hashes, as if they were delivered first; nonces that already have a real hash are left untouched.
async function verifyPacket({ tag, governanceDeploymentManager, l1Endpoint }: DeliveryContext, packet: Packet): Promise<void> {
  const { lib } = await l1Endpoint.getReceiveLibrary(packet.receiver, packet.srcEid);
  const endpointAsLibrary = l1Endpoint.connect(await impersonateAddress(governanceDeploymentManager, lib));
  const commit = async (nonce: number | BigNumber, payloadHash: string) => {
    await setNextBaseFeeToZero(governanceDeploymentManager);
    await (await endpointAsLibrary.verify(
      [packet.srcEid, packet.sender, nonce], packet.receiver, payloadHash, { gasPrice: 0 }
    )).wait();
  };

  const lastDeliveredNonce = (await l1Endpoint.inboundNonce(packet.receiver, packet.srcEid, packet.sender)).toNumber();
  const packetNonce = packet.nonce.toNumber();
  for (let inFlightNonce = lastDeliveredNonce + 1; inFlightNonce < packetNonce; inFlightNonce++) {
    const existingHash = await l1Endpoint.inboundPayloadHash(packet.receiver, packet.srcEid, packet.sender, inFlightNonce);
    if (existingHash !== ethers.constants.HashZero) continue;
    console.log(`${tag} Nonce ${inFlightNonce} still in flight at fork block; committing placeholder`);
    await commit(inFlightNonce, ethers.utils.id(`in-flight:${inFlightNonce}`));
  }

  await commit(packet.nonce, ethers.utils.keccak256(ethers.utils.concat([packet.guid, packet.message])));
}

// Stands in for the executor: calls EndpointV2.lzReceive with the option value and the same gas a real
// LayerZero executor gives the endpoint (see ENDPOINT_OVERHEAD_GAS).
async function executePacket(
  { tag, governanceDeploymentManager, l1Endpoint }: DeliveryContext,
  packet: Packet,
  options: string
): Promise<providers.TransactionReceipt> {
  const { gas, value } = decodeExecutorOptions(options);
  console.log(`${tag} Delivering LayerZero packet ${packet.guid} (nonce ${packet.nonce}) to ${packet.receiver} with ${gas} executor gas`);

  const executor = await governanceDeploymentManager.getSigner();
  const origin = [packet.srcEid, packet.sender, packet.nonce];
  const data = endpointInterface.encodeFunctionData('lzReceive', [origin, packet.receiver, packet.guid, packet.message, '0x']);
  const gasLimit = gas.mul(64).div(63).add(ENDPOINT_OVERHEAD_GAS).add(intrinsicGas(data));
  try {
    await setNextBaseFeeToZero(governanceDeploymentManager);
    const tx = await executor.sendTransaction({ to: l1Endpoint.address, data, value, gasPrice: 0, gasLimit });

    const receipt = await tx.wait();
    return receipt;
  } catch (error) {
    throw new Error(`${tag} lzReceive of ${packet.guid} failed with ${gas} executor gas: ${error.message}`);
  }
}

// The endpoint must emit PacketDelivered. For OFTs, the amount and recipient encoded in the message must
// match OFTSent on L2 and OFTReceived on L1, each converted from shared decimals with its own chain's rate.
async function verifyDelivery(
  context: DeliveryContext,
  packet: Packet,
  receipt: providers.TransactionReceipt,
  sendTxHash: string
): Promise<void> {
  const { tag, l1Endpoint, l2Provider } = context;
  const delivered = receipt.logs.some((receiptLog) =>
    receiptLog.address.toLowerCase() === l1Endpoint.address.toLowerCase()
    && receiptLog.topics[0] === endpointInterface.getEventTopic('PacketDelivered')
  );
  if (!delivered) {
    throw new Error(`${tag} No PacketDelivered for ${packet.guid}`);
  }

  const l2Oft = bytes32ToAddress(packet.sender);
  const sendReceipt = await getL2Receipt(context, sendTxHash);
  const sentLog = findPacketLog(sendReceipt.logs, l2Oft, oftInterface.getEventTopic('OFTSent'), packet.guid);
  if (!sentLog) return;
  const receivedLog = findPacketLog(receipt.logs, packet.receiver, oftInterface.getEventTopic('OFTReceived'), packet.guid);
  if (!receivedLog) {
    throw new Error(`${tag} No OFTReceived for ${packet.guid}`);
  }
  if (ethers.utils.hexDataLength(packet.message) !== OFT_MESSAGE_LENGTH) {
    throw new Error(`${tag} OFT compose message in ${packet.guid} is not simulated`);
  }

  const sendTo = bytes32ToAddress(ethers.utils.hexDataSlice(packet.message, 0, 32));
  const amountSD = BigNumber.from(ethers.utils.hexDataSlice(packet.message, 32, 40));
  const [l2Rate, l1Rate] = await Promise.all([
    new ethers.Contract(l2Oft, oftInterface, l2Provider).decimalConversionRate(),
    new ethers.Contract(packet.receiver, oftInterface, l1Endpoint.provider).decimalConversionRate(),
  ]);
  const sent = oftInterface.parseLog(sentLog).args;
  const received = oftInterface.parseLog(receivedLog).args;

  if (!sent.amountReceivedLD.eq(amountSD.mul(l2Rate))) {
    throw new Error(`${tag} OFTSent ${sent.amountReceivedLD} != message amount ${amountSD} (shared) for ${packet.guid}`);
  }
  if (!received.amountReceivedLD.eq(amountSD.mul(l1Rate))) {
    throw new Error(`${tag} OFTReceived ${received.amountReceivedLD} != message amount ${amountSD} (shared) for ${packet.guid}`);
  }
  if (received.toAddress.toLowerCase() !== sendTo.toLowerCase()) {
    throw new Error(`${tag} OFTReceived recipient ${received.toAddress} != message recipient ${sendTo} for ${packet.guid}`);
  }
  console.log(`${tag} OFT delivered: ${received.amountReceivedLD} to ${received.toAddress}`);
}

// Delivers LayerZero V2 packets sent from L2 to L1 the way a DVN quorum and the executor would
// (see verifyPacket / executePacket), enforcing payload hash, nonce order and the OApp's peer check.
export async function simulateLayerZeroOFTDelivery(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  l2StartingBlockNumber: number,
  l2EndpointAddress: string,
  l1EndpointAddress: string,
  tenderlyLogs?: any[]
) {
  if (tenderlyLogs) {
    return;
  }

  const l2Provider = bridgeDeploymentManager.hre.ethers.provider;
  const l2Endpoint = new ethers.Contract(l2EndpointAddress, endpointInterface, l2Provider);
  const l1Endpoint = new ethers.Contract(l1EndpointAddress, endpointInterface, governanceDeploymentManager.hre.ethers.provider);
  const context: DeliveryContext = {
    tag: `[${bridgeDeploymentManager.network} -> ${governanceDeploymentManager.network}]`,
    governanceDeploymentManager,
    l1Endpoint,
    l2Provider,
    l2Receipts: new Map(),
  };
  const [l2Eid, l1Eid] = await Promise.all([l2Endpoint.eid(), l1Endpoint.eid()]);

  const packetSentLogs = await bridgeDeploymentManager.retry(() =>
    l2Provider.getLogs({
      fromBlock: l2StartingBlockNumber,
      toBlock: 'latest',
      address: l2EndpointAddress,
      topics: [endpointInterface.getEventTopic('PacketSent')]
    })
  );

  for (const packetSentLog of packetSentLogs) {
    const { encodedPayload, options } = endpointInterface.parseLog(packetSentLog).args;
    const packet = decodePacket(encodedPayload);
    if (packet.dstEid !== l1Eid) continue;

    // Packet version, srcEid and the receiver's endpoint
    await validatePacket(context, packet, l2Eid);

    // DVN quorum: payload hash committed by the receive library
    await verifyPacket(context, packet);

    // Executor: EndpointV2.lzReceive with the option value and the real executor's gas
    const receipt = await executePacket(context, packet, options);

    // PacketDelivered emitted; OFT amount and recipient match on both chains
    await verifyDelivery(context, packet, receipt, packetSentLog.transactionHash);
  }
}
