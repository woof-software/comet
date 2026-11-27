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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHex(value: unknown, bytes: number): boolean {
  return typeof value === 'string' && value.length === 2 + 2 * bytes && /^0x[0-9a-f]+$/i.test(value);
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
      ((requiresProposal || entry.governanceChainId !== undefined) &&
        (typeof entry.governanceChainId !== 'number' || !Number.isSafeInteger(entry.governanceChainId) || entry.governanceChainId <= 0)) ||
      ((requiresProposal || entry.governor !== undefined) && !isHex(entry.governor, 20)) ||
      ((requiresProposal || entry.proposalId !== undefined) &&
        (typeof entry.proposalId !== 'string' || !/^[1-9][0-9]*$/.test(entry.proposalId))) ||
      ((requiresProposal || entry.proposeTx !== undefined) && !isHex(entry.proposeTx, 32)) ||
      (entry.executeTx !== undefined && !isHex(entry.executeTx, 32))
    ) {
      throw new Error(`Invalid migration registry ${file}: invalid or missing proposal data for ${name}`);
    }

    entries.set(name, entry as unknown as MigrationRegistryEntry);
  }
  return entries;
}
