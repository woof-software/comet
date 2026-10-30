import { BigNumber, Contract, constants, utils } from 'ethers';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { setNextBaseFeeToZero } from './hreUtils';

const TRANSFER_EVENT_SIG = utils.id('Transfer(address,address,uint256)');
const OFT_SENT_EVENT_SIG = utils.id('OFTSent(bytes32,uint32,address,uint256,uint256)');
const PROPOSAL_EXECUTED_EVENT_SIG = utils.id('ProposalExecuted(uint256)');

// RootChain storage slot of `mapping(uint256 => HeaderBlock) headerBlocks`
const HEADER_BLOCKS_SLOT = 5;
const CHECKPOINT_INTERVAL = 10_000;

// Receipts trie with a single receipt: key rlp(0) = 0x80, hex-prefix encoded as a leaf path
const SINGLE_RECEIPT_LEAF_PATH = '0x2080';
const SINGLE_RECEIPT_BRANCH_MASK = '0x0080';

const ROOT_CHAIN_MANAGER_ABI = [
  'function checkpointManagerAddress() view returns (address)',
  'function childToRootToken(address) view returns (address)',
  'function exit(bytes)',
];
const ROOT_CHAIN_ABI = [
  'function currentHeaderBlock() view returns (uint256)',
  'function headerBlocks(uint256) view returns (bytes32 root, uint256 start, uint256 end, uint256 createdAt, address proposer)',
];

type ReceiptProof = {
  blockNumber: BigNumber;
  blockTime: BigNumber;
  transactionsRoot: string;
  receiptsRoot: string;
  receiptBytes: string;
  leafNode: string[];
};

const rlpUint = (value: BigNumber | number) =>
  BigNumber.from(value).isZero() ? '0x' : utils.hexlify(BigNumber.from(value));

// Receipt as stored in the receipts trie: [status, cumulativeGasUsed, logsBloom, logs], type-prefixed for typed txs
function encodeReceipt(rawReceipt: any): string {
  const encoded = utils.RLP.encode([
    rlpUint(rawReceipt.status),
    rlpUint(rawReceipt.cumulativeGasUsed),
    rawReceipt.logsBloom,
    rawReceipt.logs.map((log: any) => [log.address, log.topics, log.data]),
  ]);
  const txType = BigNumber.from(rawReceipt.type ?? 0).toNumber();
  return txType ? utils.hexConcat([utils.hexlify(txType), encoded]) : encoded;
}

// A LayerZero OFT send burns too (e.g. USDT0); those are delivered by the OFT simulation, not the PoS bridge
function isOFTSendBurn(rawReceipt: any, burnLog: any): boolean {
  const [, burner] = burnLog.topics;
  return rawReceipt.logs.some((log: any) =>
    log.topics[0] === OFT_SENT_EVENT_SIG &&
    log.topics[2] === burner &&
    BigNumber.from(utils.hexDataSlice(log.data, 32, 64)).eq(burnLog.data)
  );
}

// Rebuilds the receipt's trie proof and checks it against its block's receiptsRoot
async function buildReceiptProof(bridgeDeploymentManager: DeploymentManager, rawReceipt: any): Promise<ReceiptProof> {
  const block = await bridgeDeploymentManager.hre.ethers.provider.send('eth_getBlockByHash', [rawReceipt.blockHash, false]);
  if (block.transactions.length !== 1) {
    throw new Error('burn tx must be alone in its block');
  }

  const receiptBytes = encodeReceipt(rawReceipt);
  const leafNode = [SINGLE_RECEIPT_LEAF_PATH, receiptBytes];
  if (utils.keccak256(utils.RLP.encode(leafNode)) !== block.receiptsRoot) {
    throw new Error('rebuilt receipts root does not match the burn block');
  }

  return {
    blockNumber: BigNumber.from(block.number),
    blockTime: BigNumber.from(block.timestamp),
    transactionsRoot: block.transactionsRoot,
    receiptsRoot: block.receiptsRoot,
    receiptBytes,
    leafNode,
  };
}

// L1: writes a checkpoint covering only the burn block (so the block proof is empty); needs validator signatures otherwise
async function writeCheckpoint(
  governanceDeploymentManager: DeploymentManager,
  rootChain: Contract,
  proof: ReceiptProof
): Promise<BigNumber> {
  let headerNumber = (await rootChain.currentHeaderBlock()).add(CHECKPOINT_INTERVAL);
  while ((await rootChain.headerBlocks(headerNumber)).root !== constants.HashZero) {
    headerNumber = headerNumber.add(CHECKPOINT_INTERVAL);
  }

  const checkpointRoot = utils.solidityKeccak256(
    ['uint256', 'uint256', 'bytes32', 'bytes32'],
    [proof.blockNumber, proof.blockTime, proof.transactionsRoot, proof.receiptsRoot]
  );
  const { timestamp: createdAt } = await governanceDeploymentManager.hre.ethers.provider.getBlock('latest');

  // HeaderBlock fields in storage order: root, start, end, createdAt
  const checkpointFields = [checkpointRoot, proof.blockNumber, proof.blockNumber, createdAt];
  const headerSlot = BigNumber.from(
    utils.keccak256(utils.defaultAbiCoder.encode(['uint256', 'uint256'], [headerNumber, HEADER_BLOCKS_SLOT]))
  );
  for (let fieldIndex = 0; fieldIndex < checkpointFields.length; fieldIndex++) {
    await governanceDeploymentManager.hre.network.provider.send('hardhat_setStorageAt', [
      rootChain.address,
      utils.hexStripZeros(headerSlot.add(fieldIndex).toHexString()),
      utils.hexZeroPad(BigNumber.from(checkpointFields[fieldIndex]).toHexString(), 32),
    ]);
  }

  return headerNumber;
}

// Exit payload, as built by maticjs for RootChainManager.exit
function encodeExitPayload(headerNumber: BigNumber, proof: ReceiptProof, logIndex: number): string {
  return utils.RLP.encode([
    rlpUint(headerNumber),
    '0x', // block proof: the checkpoint holds only the burn block
    rlpUint(proof.blockNumber),
    rlpUint(proof.blockTime),
    proof.transactionsRoot,
    proof.receiptsRoot,
    proof.receiptBytes,
    utils.RLP.encode([proof.leafNode]),
    SINGLE_RECEIPT_BRANCH_MASK,
    rlpUint(logIndex),
  ]);
}

/*
Exits Polygon PoS bridge withdrawals made by executed bridged proposals: every burn (Transfer to 0x0) of a
PoS-mapped child token in a ProposalExecuted tx is exited on L1 through RootChainManager.exit with the real
receipt proof, releasing the root token to the burner's address. Only the checkpoint is written directly.
*/
export async function simulatePolygonPoSWithdrawals(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  l2StartingBlockNumber?: number,
  proposalIds?: BigNumber[]
): Promise<void> {
  const l2Provider = bridgeDeploymentManager.hre.ethers.provider;
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const executedLogs = await l2Provider.getLogs({
    fromBlock: l2StartingBlockNumber ?? (await l2Provider.getBlockNumber()) - 1000,
    toBlock: 'latest',
    address: bridgeReceiver.address,
    topics: [PROPOSAL_EXECUTED_EVENT_SIG],
  });
  const executionTxHashes = executedLogs
    .filter((log) => !proposalIds || proposalIds.some((id) => id.eq(log.topics[1])))
    .map((log) => log.transactionHash);

  const { address: rootChainManagerAddress } = await governanceDeploymentManager.getContractOrThrow('RootChainManager');
  const rootChainManager = new Contract(rootChainManagerAddress, ROOT_CHAIN_MANAGER_ABI, await governanceDeploymentManager.getSigner());

  for (const txHash of executionTxHashes) {
    try {
      // Raw RPC receipt, for logsBloom and the tx type
      const rawReceipt = await l2Provider.send('eth_getTransactionReceipt', [txHash]);
      const burnLogIndexes: number[] = [];
      for (let logIndex = 0; logIndex < rawReceipt.logs.length; logIndex++) {
        const log = rawReceipt.logs[logIndex];
        if (log.topics[0] !== TRANSFER_EVENT_SIG || log.topics[2] !== constants.HashZero) continue;
        if ((await rootChainManager.childToRootToken(log.address)) === constants.AddressZero) continue;
        if (isOFTSendBurn(rawReceipt, log)) continue;
        burnLogIndexes.push(logIndex);
      }
      if (burnLogIndexes.length === 0) continue;

      const proof = await buildReceiptProof(bridgeDeploymentManager, rawReceipt);
      const rootChain = new Contract(
        await rootChainManager.checkpointManagerAddress(),
        ROOT_CHAIN_ABI,
        governanceDeploymentManager.hre.ethers.provider
      );
      const headerNumber = await writeCheckpoint(governanceDeploymentManager, rootChain, proof);

      for (const logIndex of burnLogIndexes) {
        const burnLog = rawReceipt.logs[logIndex];
        console.log(
          `Simulating Polygon PoS L2→L1 exit: ${BigNumber.from(burnLog.data).toString()} of ${burnLog.address} ` +
          `to ${utils.hexDataSlice(burnLog.topics[1], 12)}`
        );
        await setNextBaseFeeToZero(governanceDeploymentManager);
        await (await rootChainManager.exit(encodeExitPayload(headerNumber, proof, logIndex), { gasPrice: 0 })).wait();
      }
    } catch (e) {
      console.log(`Warning: Could not simulate Polygon PoS L2→L1 exit for ${txHash}: ${e.message}`);
    }
  }
}
