import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import assert from 'node:assert/strict';
import { readMigrationRegistry } from '../MigrationRegistry';

describe('Migration registry', () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'comet-migration-registry-'));
    file = join(directory, 'migrations.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('allows deployments without a registry', async () => {
    expect((await readMigrationRegistry(file)).size).to.equal(0);
  });

  it('reads proposal evidence without losing precision and distinguishes missing entries', async () => {
    const proposal = {
      status: 'proposed',
      governanceChainId: 1,
      governor: '0x' + '1'.repeat(40),
      proposalId: '9007199254740993',
      proposeTx: '0x' + '2'.repeat(64),
    };
    await writeFile(file, JSON.stringify({
      version: 1,
      migrations: { archived: proposal, next: { status: 'pending' }, unknown: { status: 'needs-review' } },
    }));

    const registry = await readMigrationRegistry(file);
    expect(registry.get('archived')).to.deep.equal(proposal);
    expect(registry.get('next')?.status).to.equal('pending');
    expect(registry.get('unknown')?.status).to.equal('needs-review');
    expect(registry.get('not-recorded')).to.equal(undefined);
  });

  it('fails on malformed JSON and unsupported versions', async () => {
    await writeFile(file, '{');
    await assert.rejects(() => readMigrationRegistry(file), /Invalid migration registry .*migrations\.json/);
    await writeFile(file, JSON.stringify({ version: 2, migrations: {} }));
    await assert.rejects(() => readMigrationRegistry(file), /expected version 1/);
  });

  it('fails on unknown statuses and submitted entries without proposal data', async () => {
    await writeFile(file, JSON.stringify({ version: 1, migrations: { bad: { status: 'typo' } } }));
    await assert.rejects(() => readMigrationRegistry(file), /invalid status for bad/);
    await writeFile(file, JSON.stringify({ version: 1, migrations: { bad: { status: 'proposed' } } }));
    await assert.rejects(() => readMigrationRegistry(file), /missing proposal data for bad/);
  });

  it('retains separate evidence for two actions on the same destination chain', async () => {
    const receiver = '0x' + '1'.repeat(40);
    const createTx = '0x' + '2'.repeat(64);
    const executeTx = '0x' + '3'.repeat(64);
    const proposal = { chainId: 42161, receiver, createTx, status: 'executed', executeTx };
    const entry = {
      status: 'pending-l2', governanceChainId: 1, governor: receiver, proposalId: '584', proposeTx: createTx,
      destinationProposals: [
        { ...proposal, actionIndex: 0, proposalId: '67' },
        { ...proposal, actionIndex: 1, proposalId: '68' },
      ],
    };
    const write = () => writeFile(file, JSON.stringify({ version: 1, migrations: { bridged: entry } }));
    await write();
    expect((await readMigrationRegistry(file)).get('bridged')).to.deep.equal(entry);

    entry.destinationProposals[1].actionIndex = 0;
    await write();
    await assert.rejects(() => readMigrationRegistry(file), /invalid destination proposals for bridged/);
    entry.destinationProposals[1].actionIndex = 1;
    delete entry.destinationProposals[1].executeTx;
    await write();
    await assert.rejects(() => readMigrationRegistry(file), /invalid destination proposals for bridged/);
  });
});
