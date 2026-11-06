import { expect } from 'chai';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import * as migrations from '../Migration';
import * as forkUtils from '../../scenario/utils/hreForBase';
import { DeploymentManager } from '../DeploymentManager';
import { getVerifyArgs } from '../VerifyArgs';
import { isolateRelayFiles } from './RelayFileTestHelpers';
import { tempDir } from './TestHelpers';

describe('Migration simulation preparation files', () => {
  const originalSpider = DeploymentManager.prototype.spider;
  const originalLoad = migrations.loadMigrations;
  const originalFork = forkUtils.default;
  const originalStarted = forkUtils.migrationStarted;
  const args = ['Simulation dog', hre.ethers.constants.AddressZero, []];
  const relay = {
    messenger: '0x1111111111111111111111111111111111111111',
    callData: '0x1234', signer: '0x2222222222222222222222222222222222222222',
  };
  let isolated: ReturnType<typeof isolateRelayFiles>;
  let dir: string;
  let managers: DeploymentManager[];
  let forkCalls: string[];
  let preparedAddress: string;
  let runtime: HardhatRuntimeEnvironment;
  let forked: HardhatRuntimeEnvironment;
  let fixture: migrations.Migration<{ address: string }>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(tempDir());
    isolated = isolateRelayFiles();
    managers = [];
    forkCalls = [];
    runtime = {
      ...hre,
      network: { ...hre.network, name: 'simulation-test-network' },
      config: { ...hre.config, scenario: { ...hre.config.scenario, bases: [
        { name: 'local-simulation', network: 'simulation-test-network', deployment: 'test-deployment' },
      ] } },
    };
    forked = { ...runtime };
    // Use the local provider for the fork boundary; do not contact RPC or Tenderly services.
    Object.assign(forkUtils, {
      default: async (base: { name: string }) => { forkCalls.push(base.name); return forked; },
      migrationStarted: () => { /* Keep shared fork state unchanged. */ },
    });
    DeploymentManager.prototype.spider = async function () {
      this.cache.deploymentDir = dir;
      this.contractsCache = new Map();
      managers.push(this);
      return { roots: new Map(), aliases: new Map(), contracts: new Map() };
    };
    fixture = migrations.migration('simulation-files', {
      prepare: async manager => {
        const contract = await manager.deploy('pet', 'test/Dog.sol', args);
        preparedAddress = contract.address;
        // Explicit fixture operation: relay helpers can write independently of the general cache flag.
        manager.stashRelayMessage(relay.messenger, relay.callData, relay.signer);
        return { address: contract.address };
      },
      enact: async () => { throw new Error('Preparation tests must not enact'); },
    });
    Object.assign(migrations, { loadMigrations: async () => [fixture] });
    for (const name of ['relay.json', 'bytecodes.json', 'currentProposal.json']) {
      isolated.files.set(isolated.file(name), 'old simulation data');
    }
  });
  afterEach(async () => {
    DeploymentManager.prototype.spider = originalSpider;
    Object.assign(migrations, { loadMigrations: originalLoad });
    Object.assign(forkUtils, { default: originalFork, migrationStarted: originalStarted });
    isolated.restore();
    await fs.rm(dir, { recursive: true, force: true });
  });

  for (const mode of ['ordinary simulation', 'Tenderly', 'Tenderly VNet'] as const) {
    it(`records the intended preparation files for ${mode}`, async () => {
      await hre.tasks.migrate.action({
        migration: 'simulation-files', deployment: 'test-deployment', simulate: true,
        prepare: true, enact: false, overwrite: false, noEnacted: true,
        tenderly: mode === 'Tenderly', tenderlyVnet: mode === 'Tenderly VNet',
      }, runtime, undefined!);
      expect(forkCalls).to.eql(['local-simulation']);
      expect(managers).to.have.length(1);
      const manager = managers[0];
      expect(manager.hre).to.equal(forked);
      expect(manager.config.writeCacheToDisk).to.equal(false);
      expect(manager.cache.writeCacheToDisk).to.equal(false);
      expect(manager.config.saveBytecode).to.equal(mode !== 'ordinary simulation');
      expect(manager.config.verificationStrategy).to.equal('lazy');
      expect((await getVerifyArgs(manager.cache)).has(preparedAddress)).to.equal(true);
      expect(await manager.readArtifact(fixture)).to.eql({ address: preparedAddress });
      expect(await fs.readdir(dir)).to.eql([]);

      expect(isolated.removed.map(file => file.split('/').pop()))
        .to.eql(['relay.json', 'currentProposal.json', 'bytecodes.json']);
      const relayFile = isolated.file('relay.json');
      const bytecodeFile = isolated.file('bytecodes.json');
      expect(JSON.parse(isolated.files.get(relayFile)!)).to.eql([relay]);
      expect(isolated.files.has(isolated.file('currentProposal.json'))).to.equal(false);
      if (mode === 'ordinary simulation') {
        expect(isolated.files.has(bytecodeFile)).to.equal(false);
        expect(isolated.writes.map(write => write.file)).to.eql([relayFile]);
      } else {
        const artifact = await hre.artifacts.readArtifact('Dog');
        const expected = artifact.bytecode + new hre.ethers.utils.Interface(artifact.abi).encodeDeploy(args).slice(2);
        expect(JSON.parse(isolated.files.get(bytecodeFile)!)).to.eql([expected]);
        expect(isolated.writes.map(write => write.file)).to.eql([bytecodeFile, relayFile]);
      }
    });
  }
});
