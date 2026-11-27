import { readFile } from 'fs/promises';

const statuses = [
  'pending', 'proposed', 'queued', 'pending-l2', 'executed',
  'defeated', 'cancelled', 'expired', 'failed-on-l2', 'needs-review',
] as const;

export interface MigrationRegistryEntry {
  status: typeof statuses[number];
  governanceChainId?: number;
  governor?: string;
  proposalId?: string;
  proposeTx?: string;
  executeTx?: string;
  destinationProposals?: DestinationProposal[];
}

export interface DestinationProposal {
  actionIndex: number;
  chainId: number;
  receiver: string;
  proposalId: string;
  createTx: string;
  status: 'queued' | 'expired' | 'executed';
  executeTx?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHex(value: unknown, bytes: number): boolean {
  return typeof value === 'string' && value.length === 2 + 2 * bytes && /^0x[0-9a-f]+$/i.test(value);
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isProposalId(value: unknown): boolean {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function validDestinations(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const actionIndexes = new Set<number>();
  for (const proposal of value) {
    if (!isRecord(proposal) ||
      typeof proposal.actionIndex !== 'number' || !Number.isSafeInteger(proposal.actionIndex) || proposal.actionIndex < 0 ||
      actionIndexes.has(proposal.actionIndex) || !isPositiveInteger(proposal.chainId) ||
      !isHex(proposal.receiver, 20) || !isProposalId(proposal.proposalId) || !isHex(proposal.createTx, 32) ||
      !['queued', 'expired', 'executed'].some(status => status === proposal.status) ||
      ((proposal.status === 'executed' || proposal.executeTx !== undefined) && !isHex(proposal.executeTx, 32))
    ) return false;
    actionIndexes.add(proposal.actionIndex);
  }
  return true;
}

export async function readMigrationRegistry(file: string): Promise<ReadonlyMap<string, MigrationRegistryEntry>> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }

  let registry: unknown;
  try {
    registry = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid migration registry ${file}: ${error.message}`);
  }
  if (!isRecord(registry) || registry.version !== 1 || !isRecord(registry.migrations)) {
    throw new Error(`Invalid migration registry ${file}: expected version 1 and a migrations object`);
  }

  const entries = new Map<string, MigrationRegistryEntry>();
  for (const [name, entry] of Object.entries(registry.migrations)) {
    if (!isRecord(entry) || !statuses.some(status => status === entry.status)) {
      throw new Error(`Invalid migration registry ${file}: invalid status for ${name}`);
    }

    const requiresProposal = entry.status !== 'pending' && entry.status !== 'needs-review';
    if (
      ((requiresProposal || entry.governanceChainId !== undefined) && !isPositiveInteger(entry.governanceChainId)) ||
      ((requiresProposal || entry.governor !== undefined) && !isHex(entry.governor, 20)) ||
      ((requiresProposal || entry.proposalId !== undefined) && !isProposalId(entry.proposalId)) ||
      ((requiresProposal || entry.proposeTx !== undefined) && !isHex(entry.proposeTx, 32)) ||
      (entry.executeTx !== undefined && !isHex(entry.executeTx, 32))
    ) {
      throw new Error(`Invalid migration registry ${file}: invalid or missing proposal data for ${name}`);
    }
    if (entry.destinationProposals !== undefined && !validDestinations(entry.destinationProposals)) {
      throw new Error(`Invalid migration registry ${file}: invalid destination proposals for ${name}`);
    }

    entries.set(name, entry as unknown as MigrationRegistryEntry);
  }
  return entries;
}
