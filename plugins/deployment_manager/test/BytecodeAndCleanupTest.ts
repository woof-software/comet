import { expect } from 'chai';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import { DeploymentManager } from '../DeploymentManager';
import { isolateRelayFiles } from './RelayFileTestHelpers';
import { tempDir } from './TestHelpers';

describe('DeploymentManager bytecode saving and cache cleanup', () => {
  let isolated: ReturnType<typeof isolateRelayFiles>;
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(tempDir());
    isolated = isolateRelayFiles();
  });
  afterEach(async () => {
    isolated.restore();
    await fs.rm(dir, { recursive: true, force: true });
  });

  for (const saveBytecode of [true, false]) {
    const name = saveBytecode
      ? 'saves deployment bytecode when saveBytecode is enabled'
      : 'does not save deployment bytecode when saveBytecode is disabled';
    it(name, async () => {
      const manager = new DeploymentManager('test-network', 'test-deployment', hre, {
        baseDir: dir, writeCacheToDisk: false, verificationStrategy: 'none', saveBytecode,
      });
      manager.contractsCache = new Map();
      const args = ['Apple dog', hre.ethers.constants.AddressZero, []];
      const artifact = await hre.artifacts.readArtifact('Dog');
      const expected = artifact.bytecode + new hre.ethers.utils.Interface(artifact.abi).encodeDeploy(args).slice(2);
      const contract = await manager.deploy('pet', 'test/Dog.sol', args);
      expect(contract.deployTransaction.data).to.equal(expected);
      const file = isolated.file('bytecodes.json');
      if (saveBytecode) {
        expect(JSON.parse(isolated.files.get(file)!)).to.eql([expected]);
        expect(isolated.writes.map(write => write.file)).to.eql([file]);
      } else {
        expect(isolated.files.has(file)).to.equal(false);
        expect(isolated.writes).to.eql([]);
      }
      // Reusing the alias must not record a second deployment entry.
      const reused = await manager.deploy('pet', 'test/Dog.sol', ['Ignored', hre.ethers.constants.AddressZero, []]);
      expect(reused.address).to.equal(contract.address);
      expect(manager.counter).to.equal(1);
      expect(isolated.writes).to.have.length(saveBytecode ? 1 : 0);
      expect(await fs.readdir(dir)).to.eql([]);
    });
  }

  for (const present of ['all', 'some', 'none'] as const) {
    it(`cleans only the three intended files with ${present} files present and tolerates repeated cleanup`, async () => {
      const manager = new DeploymentManager('test-network', 'test-deployment', hre);
      const names = ['relay.json', 'currentProposal.json', 'bytecodes.json'];
      const created = present === 'all' ? names : present === 'some' ? [names[1]] : [];
      for (const name of created) isolated.files.set(isolated.file(name), 'saved data');
      const unrelated = isolated.file('keep-me.json');
      isolated.files.set(unrelated, 'keep this content');
      await manager.cleanCache();
      expect(isolated.removed).to.eql(created.map(name => isolated.file(name)));
      expect([...isolated.files]).to.eql([[unrelated, 'keep this content']]);
      await manager.cleanCache();
      expect(isolated.removed).to.have.length(created.length);
      expect([...isolated.files]).to.eql([[unrelated, 'keep this content']]);
      expect(isolated.writes).to.eql([]);
    });
  }
});
