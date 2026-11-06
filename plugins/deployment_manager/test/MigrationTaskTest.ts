import { expect } from 'chai';
import { strict as assert } from 'assert';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import * as migrations from '../Migration';
import * as enacted from '../Enacted';
import * as forkUtils from '../../scenario/utils/hreForBase';
import { DeploymentManager } from '../DeploymentManager';
import { tempDir } from './TestHelpers';

describe('Migration task orchestration', () => {
  const originalSpider = DeploymentManager.prototype.spider;
  const originalClean = DeploymentManager.prototype.cleanCache;
  const originalLoad = migrations.loadMigrations;
  const originalEnacted = enacted.writeEnacted;
  const originalStarted = forkUtils.migrationStarted;
  const payload = { addresses: ['0x1111111111111111111111111111111111111111'], settings: { enabled: false, count: 0 }, steps: ['one', 'two'] };
  let dir: string;
  let runtime: HardhatRuntimeEnvironment;
  let fixture: migrations.Migration<typeof payload>;
  let managers: DeploymentManager[];
  let events: string[];
  let received: typeof payload | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(tempDir());
    managers = [];
    events = [];
    received = undefined;
    runtime = {
      ...hre,
      network: { ...hre.network, name: 'migration-test-network' },
      config: { ...hre.config, scenario: { ...hre.config.scenario, bases: [
        { name: 'local', network: 'migration-test-network', deployment: 'test-deployment' },
      ] } },
    };
    fixture = migrations.migration('test-artifact', {
      prepare: async () => { events.push('prepare'); return payload; },
      enact: async (_dm, _govDm, artifact) => { events.push('enact'); received = artifact; },
    });
    // Keep the task and artifact persistence real, isolating discovery and global auxiliary files.
    DeploymentManager.prototype.spider = async function () {
      this.cache.deploymentDir = dir;
      this.contractsCache = new Map();
      managers.push(this);
      return { roots: new Map(), aliases: new Map(), contracts: new Map() };
    };
    DeploymentManager.prototype.cleanCache = async () => { events.push('clean'); };
    Object.assign(migrations, {
      loadMigrations: async (paths: string[]) => {
        expect(paths).to.have.length(1);
        expect(paths[0]).to.include('/migration-test-network/test-deployment/migrations/test-artifact.ts');
        return [fixture];
      },
    });
    Object.assign(enacted, {
      writeEnacted: async (...[migration, dm, writeToFile]: Parameters<typeof enacted.writeEnacted>) => {
        expect(migration).to.equal(fixture);
        expect(dm).to.equal(managers[managers.length - 1]);
        expect(writeToFile).to.equal(true);
        events.push('mark enacted');
        return '';
      },
    });
    Object.assign(forkUtils, { migrationStarted: () => { /* Avoid changing shared fork state. */ } });
  });
  afterEach(async () => {
    DeploymentManager.prototype.spider = originalSpider;
    DeploymentManager.prototype.cleanCache = originalClean;
    Object.assign(migrations, { loadMigrations: originalLoad });
    Object.assign(enacted, { writeEnacted: originalEnacted });
    Object.assign(forkUtils, { migrationStarted: originalStarted });
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Invoke the real task action; these tests do not claim CLI argument parsing coverage.
  async function run(flags: { prepare?: boolean, enact?: boolean, overwrite?: boolean } = {}) {
    await hre.tasks.migrate.action({
      migration: fixture.name, deployment: 'test-deployment', prepare: false, enact: false,
      overwrite: false, noEnacted: false, simulate: false, tenderly: false, tenderlyVnet: false,
      ...flags,
    }, runtime, undefined!);
  }

  async function seedArtifact(value: typeof payload) {
    const cacheWriter = new DeploymentManager(runtime.network.name, 'test-deployment', runtime, {
      baseDir: dir, writeCacheToDisk: true,
    });
    return cacheWriter.storeArtifact(fixture, value);
  }

  it('defaults to preparation, then loads the exact saved artifact for enactment in a fresh manager', async () => {
    await run();
    expect(events).to.eql(['clean', 'prepare']);
    expect(received).to.equal(undefined);
    const first = managers[0];
    const file = first.cache.getFilePath({ rel: ['artifacts', `${fixture.name}.json`] });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).to.eql(payload);

    await run({ enact: true });
    expect(managers).to.have.length(2);
    expect(managers[1]).not.to.equal(first);
    expect(received).to.eql(payload);
    expect(received).not.to.equal(payload);
    expect(events).to.eql(['clean', 'prepare', 'clean', 'enact', 'clean', 'mark enacted']);
  });

  it('protects an existing artifact unless overwrite is enabled', async () => {
    const previous = { ...payload, steps: ['previous'] };
    const file = await seedArtifact(previous);
    await assert.rejects(run({ prepare: true, enact: true }), /Artifact already exists.*--overwrite/);
    expect(events).to.eql(['clean']);
    expect(received).to.equal(undefined);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).to.eql(previous);
  });

  it('overwrites an artifact when requested and marks enactment only after success', async () => {
    const file = await seedArtifact({ ...payload, steps: ['previous'] });
    await run({ prepare: true, enact: true, overwrite: true });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).to.eql(payload);
    expect(received).to.eql(payload);
    expect(events).to.eql(['clean', 'prepare', 'enact', 'clean', 'mark enacted']);
  });

  it('propagates a preparation failure without enacting, saving an artifact or marking enacted', async () => {
    const failure = new Error('Preparation failed');
    fixture.actions.prepare = async () => { events.push('prepare'); throw failure; };
    await assert.rejects(run({ prepare: true, enact: true }), error => error === failure);
    expect(events).to.eql(['clean', 'prepare']);
    expect(received).to.equal(undefined);
    expect(await managers[0].readArtifact(fixture)).to.equal(undefined);
  });

  it('preserves the preparation artifact and propagates enactment failure without marking enacted', async () => {
    const failure = new Error('Enactment failed');
    fixture.actions.enact = async (_dm, _govDm, artifact) => {
      events.push('enact');
      expect(artifact).to.eql(payload);
      throw failure;
    };
    await assert.rejects(run({ prepare: true, enact: true }), error => error === failure);
    expect(events).to.eql(['clean', 'prepare', 'enact']);
    const fresh = new DeploymentManager(runtime.network.name, 'test-deployment', runtime, { baseDir: dir });
    expect(await fresh.readArtifact(fixture)).to.eql(payload);
  });
});
