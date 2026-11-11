import { BigNumber, ethers } from 'ethers';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { impersonateAddress } from '../../plugins/scenario/utils';

const PACKET_SENT_TOPIC = ethers.utils.id('PacketSent(bytes,bytes,address)');

// PacketV1Codec layout (LayerZero V2): version(1) nonce(8) srcEid(4) sender(32) dstEid(4)
// receiver(32) guid(32) message(rest), all packed as raw bytes.
function decodePacket(encodedPayload: string) {
  return {
    nonce: BigNumber.from(ethers.utils.hexDataSlice(encodedPayload, 1, 9)),
    srcEid: BigNumber.from(ethers.utils.hexDataSlice(encodedPayload, 9, 13)).toNumber(),
    sender: ethers.utils.hexDataSlice(encodedPayload, 13, 45),
    dstEid: BigNumber.from(ethers.utils.hexDataSlice(encodedPayload, 45, 49)).toNumber(),
    receiver: ethers.utils.hexDataSlice(encodedPayload, 49, 81),
    guid: ethers.utils.hexDataSlice(encodedPayload, 81, 113),
    message: ethers.utils.hexDataSlice(encodedPayload, 113),
  };
}

// Delivers a LayerZero OFT packet sent on L2 to its L1 receiver: reads the L2 endpoint's
// PacketSent events, then impersonates the L1 endpoint to call lzReceive directly on the
// receiver (the OFT Adapter), bypassing DVN/executor verification that a fork can't produce.
// The receiver only checks msg.sender == endpoint, so this mirrors the real inbound call shape.
export async function simulateLayerZeroOFTDelivery(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  l2StartingBlockNumber: number,
  l2Endpoint: string,
  l1Endpoint: string,
  mainnetEid: number,
  tenderlyLogs?: any[]
) {
  if (tenderlyLogs) {
    return;
  }
  console.log('Simulating LayerZero OFT deliveries for any executed proposals...');

  const latestBlockNumber = await bridgeDeploymentManager.hre.ethers.provider.getBlockNumber();
  const packetSentEvents = await bridgeDeploymentManager.retry(() =>
    bridgeDeploymentManager.hre.ethers.provider.getLogs({
      fromBlock: l2StartingBlockNumber,
      toBlock: latestBlockNumber,
      address: l2Endpoint,
      topics: [PACKET_SENT_TOPIC]
    })
  );

  for (const event of packetSentEvents) {
    const [encodedPayload] = ethers.utils.defaultAbiCoder.decode(['bytes', 'bytes', 'address'], event.data);
    const packet = decodePacket(encodedPayload);
    if (packet.dstEid !== mainnetEid) continue;

    const receiverAddress = ethers.utils.getAddress(ethers.utils.hexDataSlice(packet.receiver, 12, 32));
    console.log(`[Mantle -> mainnet] Simulating LayerZero OFT delivery of packet ${packet.guid} to ${receiverAddress}`);

    const endpointSigner = await impersonateAddress(governanceDeploymentManager, l1Endpoint);
    await governanceDeploymentManager.hre.network.provider.send('hardhat_setBalance', [
      endpointSigner.address,
      '0x1000000000000000000',
    ]);

    const oftAdapter = await governanceDeploymentManager.hre.ethers.getContractAt(
      ['function lzReceive(tuple(uint32 srcEid, bytes32 sender, uint64 nonce) origin, bytes32 guid, bytes message, address executor, bytes extraData) external payable'],
      receiverAddress
    );

    await (
      await oftAdapter.connect(endpointSigner).lzReceive(
        [packet.srcEid, packet.sender, packet.nonce],
        packet.guid,
        packet.message,
        ethers.constants.AddressZero,
        '0x',
        { gasPrice: 0, gasLimit: 2_500_000 }
      )
    ).wait();
  }
}
