import 'dotenv/config';
import { BigNumber, Contract, providers, utils } from 'ethers';
import { randomUUID } from 'crypto';
import { readFile, rename, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { isDeepStrictEqual } from 'util';
import { DestinationProposal, MigrationRegistryEntry, readMigrationRegistry } from '../plugins/deployment_manager/MigrationRegistry';

// P7-3 pilot. These transaction hashes are the reviewed candidates for the two historical migrations.
// Run from the repo root with: yarn ts-node scripts/backfill-migration-registry.ts
const deployment = resolve(__dirname, '../deployments/mainnet/usdc');
const registryFile = join(deployment, 'migrations.json');
const pilot = [
  {
    name: '1777297641_update_supply_caps_on_mainnet',
    proposalId: '578',
    proposeTx: '0xff1ff2eb5de738da33fd80dd2e6b21b92ec47ba6b397f30f53a55c44cd24bfde',
    executeTx: '0x54a5496444fdd9a6c7cdcbb712c4027aa77acba1b25626b2c1532e1680555c65',
    actionTargets: [
      ...Array(6).fill('configurator'), 'cometAdmin',
      ...Array(2).fill('configurator'), 'cometAdmin',
      ...Array(3).fill('configurator'), 'cometAdmin',
    ],
  },
  {
    name: '1778758319_update_supply_caps_on_l2',
    proposalId: '584',
    proposeTx: '0x3c22c8cb6367849775c9d19f71c750434e13e595f46fb36f09719f1268c1daf0',
    executeTx: '0x870306a7ecea68f409b1465fdab0b46a954eaabd86a7dcc69d9206fc06bd171a',
    actionTargets: ['arbitrumInbox', 'arbitrumInbox', 'baseL1CrossDomainMessenger', 'lineaMessageService', 'mantleL1CrossDomainMessenger'],
  },
];

const arbitrum = { chainId: 42161, rpc: 'ARBITRUM_QUICKNODE_LINK', signature: 'createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)', payloadIndex: 7 };
type DestinationCandidate = Pick<DestinationProposal, 'chainId' | 'actionIndex' | 'proposalId' | 'createTx' | 'executeTx'> & {
  rpc: string;
  signature: string;
  payloadIndex: number;
};
const destinations: DestinationCandidate[] = [
  {
    ...arbitrum, actionIndex: 0, proposalId: '67',
    createTx: '0xc3da34235da10a5829e25eecc376f13455e0b3e76d2ee79961c6fc9bd2443599',
    executeTx: '0x216e7cf68b52cc010455735d936eb5a89499c9f188d10fcc19fee0be82fe6b71',
  },
  {
    ...arbitrum, actionIndex: 1, proposalId: '68',
    createTx: '0x63b8ce5847f6278c57a6173a3b4bf781d9a5fc305da442cf590c8ef75584b94f',
    executeTx: '0x9f29dfa4bf49b27bb8f5dd41d691ea204851151435badd8c2d962fa82b35f88a',
  },
  {
    chainId: 8453, rpc: 'BASE_QUICKNODE_LINK', actionIndex: 2, proposalId: '64',
    signature: 'sendMessage(address,bytes,uint32)', payloadIndex: 1,
    createTx: '0x4b8998c8c54cc11733c699757d4d0e24d9c830063f48925e44da1caf0c45f030',
    executeTx: '0xf2bc8b0a95b8d7c2e9b00d45b46a2bb761fbc5e313b38d1dab21b15b5c763704',
  },
  {
    chainId: 59144, rpc: 'LINEA_QUICKNODE_LINK', actionIndex: 3, proposalId: '8',
    signature: 'sendMessage(address,uint256,bytes)', payloadIndex: 2,
    createTx: '0x61406813bd54fd109d56c607c0bebe9ed7f231bedb61d4465a43c694ac621d68',
    executeTx: '0xa422454c1e7a32469a5ba2a66dfa1c95fa1a52e5b4f34b9e49c065ea70d4df54',
  },
  {
    chainId: 5000, rpc: 'MANTLE_QUICKNODE_LINK', actionIndex: 4, proposalId: '8',
    signature: 'sendMessage(address,bytes,uint32)', payloadIndex: 1,
    createTx: '0x1ba5956d827e8b5cee190dc687e7aaabd70dfacdff15df4e24a9c5b21c2a0135',
  },
];

const governorAbi = new utils.Interface([
  'event ProposalCreated(uint256 proposalId,address proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,uint256 startBlock,uint256 endBlock,string description)',
  'event ProposalExecuted(uint256 proposalId)',
]);
const receiverAbi = new utils.Interface([
  'event ProposalCreated(address indexed rootMessageSender,uint256 id,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,uint256 eta)',
  'event ProposalExecuted(uint256 indexed id)',
  'function state(uint256) view returns(uint8)',
]);

class NeedsReview extends Error {}

async function rpcProvider(variable: string, chainId: number) {
  const url = process.env[variable];
  if (!url) throw new Error(`Set ${variable} to verify the historical receipts`);
  const provider = new providers.StaticJsonRpcProvider(url, chainId);
  try {
    if (!BigNumber.from(await provider.send('eth_chainId', [])).eq(chainId)) {
      throw new Error('Unexpected chain');
    }
  } catch {
    throw new Error(`Unable to verify chain ${chainId} via ${variable}`);
  }
  return provider;
}

async function readEvent(provider: providers.Provider, hash: string, address: string, abi: utils.Interface, name: string) {
  const receipt = await provider.getTransactionReceipt(hash);
  const topic = abi.getEventTopic(name);
  const logs = receipt?.logs.filter(log => log.address.toLowerCase() === address.toLowerCase() && log.topics[0] === topic);
  if (receipt?.status !== 1 || logs.length !== 1) {
    throw new NeedsReview(`Expected one ${name} event from ${address} in ${hash}`);
  }
  return { args: abi.parseLog(logs[0]).args, blockNumber: receipt.blockNumber };
}

async function verifyDestination(
  provider: providers.Provider, candidate: DestinationCandidate, calldata: string, timelock: string
): Promise<DestinationProposal> {
  const bridgeAbi = new utils.Interface([`function ${candidate.signature}`]);
  const action = bridgeAbi.decodeFunctionData(candidate.signature, calldata);
  const receiver: string = action[0];
  const created = await readEvent(provider, candidate.createTx, receiver, receiverAbi, 'ProposalCreated');
  // Use positional fields because ethers Result.values is also an Array method.
  const actualPayload = utils.defaultAbiCoder.encode(['address[]', 'uint256[]', 'string[]', 'bytes[]'], created.args.slice(2, 6));
  if (created.args.id.toString() !== candidate.proposalId ||
      created.args.rootMessageSender.toLowerCase() !== timelock.toLowerCase() ||
      actualPayload !== action[candidate.payloadIndex]) {
    throw new NeedsReview(`Destination action ${candidate.actionIndex} does not match its L1 payload`);
  }

  const receiverContract = new Contract(receiver, receiverAbi, provider);
  const state = await receiverContract.state(candidate.proposalId);
  const status = (['queued', 'expired', 'executed'] as const)[state];
  if (!status) throw new NeedsReview(`Unknown receiver state for action ${candidate.actionIndex}`);
  if (status === 'executed' && !candidate.executeTx) {
    throw new NeedsReview(`Missing execution receipt for action ${candidate.actionIndex}`);
  }
  if (candidate.executeTx) {
    const executed = await readEvent(provider, candidate.executeTx, receiver, receiverAbi, 'ProposalExecuted');
    if (status !== 'executed' || executed.args.id.toString() !== candidate.proposalId || executed.blockNumber < created.blockNumber) {
      throw new NeedsReview(`Execution receipt does not match action ${candidate.actionIndex}`);
    }
  }
  const { actionIndex, chainId, proposalId, createTx, executeTx } = candidate;
  return { actionIndex, chainId, receiver, proposalId, createTx, status, ...(executeTx ? { executeTx } : {}) };
}

async function main() {
  const [aliases, roots, l1] = await Promise.all([
    readFile(join(deployment, 'aliases.json'), 'utf8').then(JSON.parse),
    readFile(join(deployment, 'roots.json'), 'utf8').then(JSON.parse),
    rpcProvider('MAINNET_QUICKNODE_LINK', 1),
  ]);
  const { governor, timelock } = aliases;
  const registry = new Map(await readMigrationRegistry(registryFile));
  let changed = false;
  for (const candidate of pilot) {
    const { name, proposalId, proposeTx, executeTx } = candidate;
    let entry: MigrationRegistryEntry = { status: 'needs-review' };
    try {
      const created = await readEvent(l1, proposeTx, governor, governorAbi, 'ProposalCreated');
      const migration = await readFile(join(deployment, 'migrations', `${name}.ts`), 'utf8');
      const description = migration.match(/const description = `([^`]+)`;/)?.[1];
      // Proposal 584 has a documented one-word difference between the on-chain text and the script.
      const onChainDescription = proposalId === '584'
        ? created.args.description.replace('update a Compound III markets', 'update Compound III markets')
        : created.args.description;
      const targets: string[] = created.args.targets;
      const expectedTargets = candidate.actionTargets.map(key => roots[key] ?? aliases[key]);
      if (!description || description !== onChainDescription ||
          created.args.proposalId.toString() !== proposalId || targets.length !== expectedTargets.length ||
          !targets.every((target, index) => target.toLowerCase() === expectedTargets[index]?.toLowerCase())) {
        throw new NeedsReview('Proposal description or action targets do not match the migration');
      }
      entry = { status: 'needs-review', governanceChainId: 1, governor, proposalId, proposeTx };
      const execution = await readEvent(l1, executeTx, governor, governorAbi, 'ProposalExecuted');
      if (execution.args.proposalId.toString() !== proposalId || execution.blockNumber < created.blockNumber) {
        throw new NeedsReview('L1 execution does not match the proposal');
      }
      entry.executeTx = executeTx;

      if (proposalId === '584') {
        entry.destinationProposals = await Promise.all(destinations.map(async destination => {
          const provider = await rpcProvider(destination.rpc, destination.chainId);
          return verifyDestination(provider, destination, created.args.calldatas[destination.actionIndex], timelock);
        }));
        entry.status = entry.destinationProposals.some(x => x.status === 'expired')
          ? 'failed-on-l2'
          : entry.destinationProposals.every(x => x.status === 'executed') ? 'executed' : 'pending-l2';
      } else {
        entry.status = 'executed';
      }
    } catch (error) {
      if (!(error instanceof NeedsReview)) throw error;
      console.warn(`${name}: ${error.message}`);
    }

    const previous = registry.get(name);
    if (previous) {
      if (!isDeepStrictEqual(previous, entry)) console.warn(`${name}: evidence differs from the existing entry. Review manually.`);
      continue;
    }
    registry.set(name, entry);
    changed = true;
    console.log(`${name}: ${entry.status}`);
  }

  if (!changed) {
    console.log('No registry changes');
    return;
  }

  const temporary = `${registryFile}.tmp.${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, migrations: Object.fromEntries(registry) }, null, 2) + '\n');
    await readMigrationRegistry(temporary);
    await rename(temporary, registryFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

main().catch(error => {
  // Provider errors can contain RPC URLs with credentials.
  console.error(`Backfill failed: ${error.code ?? error.name}`);
  if (!error.code) console.error(error.message);
  process.exitCode = 1;
});
