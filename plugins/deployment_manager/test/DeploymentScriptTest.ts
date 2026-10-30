import { expect } from 'chai';
import { strict as assert } from 'assert';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import * as path from 'path';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeploymentManager } from '../DeploymentManager';
import { getAliases } from '../Aliases';
import { getBuildFile } from '../ContractMap';
import { getRoots, putRoots } from '../Roots';
import { tempDir } from './TestHelpers';

const deploymentScript = `
export default async function(manager, spec) {
  const zero = manager.hre.ethers.constants.AddressZero;
  const father = await manager.deploy('father', 'test/Dog.sol', ['father', zero, []]);
  if (spec.failAfterFirst) {
    if (spec.saveRoots) {
      await manager.cache.storeMap({ rel: 'roots.json' }, new Map([['father', father.address]]));
    }
    throw new Error('Injected deployment script failure');
  }
  const child = await manager.deploy('child', 'test/Dog.sol', ['child', father.address, []]);
  return { child };
}
`;

describe('DeploymentManager deployment scripts', () => {
  let dir: string;
  let manager: DeploymentManager;
  let runtime: HardhatRuntimeEnvironment;
  let scriptFile: string;
  let signerAddress: string;
  let nonceBefore: number;

  function freshManager() {
    return new DeploymentManager('script-test-network', 'test-deployment', runtime, {
      baseDir: dir, writeCacheToDisk: true, verificationStrategy: 'none',
    });
  }
  beforeEach(async () => {
    dir = await fs.mkdtemp(tempDir());
    runtime = {
      ...hre,
      config: { ...hre.config, deploymentManager: { relationConfigMap: {
        child: { relations: { father: { field: 'father', alias: 'father' } } },
      } } },
    };
    manager = freshManager();
    scriptFile = manager.cache.getFilePath({ rel: 'deploy.ts' });
    await fs.mkdir(path.dirname(scriptFile), { recursive: true });
    await fs.writeFile(scriptFile, deploymentScript);
    signerAddress = (await hre.ethers.getSigners())[0].address;
    nonceBefore = await hre.ethers.provider.getTransactionCount(signerAddress);
  });
  afterEach(async () => {
    delete require.cache[scriptFile];
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function expectSubmissions(count: number) {
    expect(await hre.ethers.provider.getTransactionCount(signerAddress)).to.equal(nonceBefore + count);
  }

  it('runs a two-contract script twice and restores its saved graph in a fresh manager', async () => {
    const first = await manager.runDeployScript({});
    expect(first.old.count).to.equal(0);
    expect(first.old.spider.aliases.size).to.equal(0);
    expect(first.new.count).to.equal(2);
    expect(first.new.spider.contracts.size).to.equal(2);
    const father = first.new.spider.aliases.get('father');
    const child = first.new.spider.aliases.get('child');
    assert.ok(father);
    assert.ok(child);
    expect(await first.new.spider.contracts.get('child')?.father()).to.equal(father);
    expect([...first.new.spider.roots]).to.eql([['child', child]]);
    expect(first.old.start).to.be.instanceOf(Date);
    expect(first.new.start.getTime()).to.be.at.least(first.old.start.getTime());
    await expectSubmissions(2);

    const second = await manager.runDeployScript({});
    expect(second.old.count).to.equal(2);
    expect(second.new.count).to.equal(2);
    expect([...second.old.spider.aliases]).to.eql([...first.new.spider.aliases]);
    expect([...second.new.spider.aliases]).to.eql([...first.new.spider.aliases]);
    await expectSubmissions(2);

    const fresh = freshManager();
    expect(fresh.cache.cache.size).to.equal(0);
    const restored = await fresh.spider();
    expect([...restored.aliases]).to.eql([...first.new.spider.aliases]);
    expect(await restored.contracts.get('father')?.name()).to.equal('father');
    expect(await restored.contracts.get('child')?.father()).to.equal(father);
    expect((await getBuildFile(fresh.cache, fresh.network, father)).contract).to.equal('Dog');
    expect(fresh.counter).to.equal(0);
    await expectSubmissions(2);
  });

  it('reports a script without a default deployment function before submitting transactions', async () => {
    await fs.writeFile(scriptFile, 'export const description = "No deployment function";\n');
    await assert.rejects(manager.runDeployScript({}), error =>
      error instanceof Error && error.message === `Missing deploy function in ${scriptFile}.`);
    expect(manager.counter).to.equal(0);
    expect((await getAliases(manager.cache)).size).to.equal(0);
    await expectSubmissions(0);
  });

  for (const restart of [false, true]) {
    it(`recovers a partially completed script with saved roots and restart=${restart}`, async () => {
      await assert.rejects(manager.runDeployScript({ failAfterFirst: true, saveRoots: true }),
        /Injected deployment script failure/);
      const saved = await getAliases(manager.cache);
      const father = saved.get('father');
      assert.ok(father);
      expect([...saved]).to.eql([['father', father]]);
      expect([...await getRoots(manager.cache)]).to.eql([['father', father]]);
      expect((await getBuildFile(manager.cache, manager.network, father)).contract).to.equal('Dog');
      expect(manager.counter).to.equal(1);
      await expectSubmissions(1);

      const recovering = restart ? freshManager() : manager;
      // Clear the objects even for the same-instance case: recovery must rediscover the saved root.
      recovering.contractsCache = null;
      recovering.cache.clearMemory();
      const result = await recovering.runDeployScript({});
      expect([...result.old.spider.aliases]).to.eql([['father', father]]);
      expect(result.new.spider.aliases.get('father')).to.equal(father);
      expect(await result.new.spider.contracts.get('child')?.father()).to.equal(father);
      expect(result.old.count).to.equal(restart ? 0 : 1);
      expect(result.new.count).to.equal(restart ? 1 : 2);
      expect(result.new.spider.contracts.size).to.equal(2);
      expect((await getAliases(recovering.cache)).get('father')).to.equal(father);
      await expectSubmissions(2);
    });
  }

  it('requires explicit root recovery when only an alias and build file survived a script failure', async () => {
    await assert.rejects(manager.runDeployScript({ failAfterFirst: true, saveRoots: false }),
      /Injected deployment script failure/);
    // Record exactly what survived before another spider call can rebuild aliases.
    const savedAliases = await getAliases(manager.cache);
    const father = savedAliases.get('father');
    assert.ok(father);
    expect((await getBuildFile(manager.cache, manager.network, father)).contract).to.equal('Dog');
    expect((await getRoots(manager.cache)).size).to.equal(0);

    const fresh = freshManager();
    const undiscovered = await fresh.spider();
    expect(undiscovered.contracts.size).to.equal(0);
    expect(undiscovered.aliases.size).to.equal(0);
    await expectSubmissions(1);
    // Explicit recovery procedure: restore roots from the alias data captured before discovery.
    await putRoots(fresh.cache, savedAliases);
    const recovered = await fresh.runDeployScript({});
    expect(recovered.old.spider.aliases.get('father')).to.equal(father);
    expect(recovered.new.spider.aliases.get('father')).to.equal(father);
    expect(await recovered.new.spider.contracts.get('child')?.father()).to.equal(father);
    expect(fresh.counter).to.equal(1);
    await expectSubmissions(2);
  });
});
