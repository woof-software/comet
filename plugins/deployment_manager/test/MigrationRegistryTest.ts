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
});
