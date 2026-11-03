import { expect } from 'chai';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import * as verification from '../Verify';
import { Cache } from '../Cache';
import { DeploymentManager } from '../DeploymentManager';
import { getVerifyArgs } from '../VerifyArgs';
import { tempDir } from './TestHelpers';

describe('DeploymentManager runtime settings', () => {
  let dir: string;
  const originalVerify = verification.verifyContract;
  beforeEach(async () => { dir = await fs.mkdtemp(tempDir()); });
  afterEach(async () => {
    Object.assign(verification, { verifyContract: originalVerify });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('queues subsequent deployments after switching the same manager from eager to lazy verification', async () => {
    const verified: verification.VerifyArgs[] = [];
    Object.assign(verification, {
      verifyContract: async (args: verification.VerifyArgs) => { verified.push(args); return true; },
    });
    const manager = new DeploymentManager('test-network', 'test-deployment', hre, {
      baseDir: dir, writeCacheToDisk: true, verificationStrategy: 'eager',
    });
    manager.contractsCache = new Map();
    const args = ['first', hre.ethers.constants.AddressZero, []];
    const first = await manager.deploy('first', 'test/Dog.sol', args);
    expect(verified).to.have.length(1);
    expect(verified[0].via === 'artifacts' && verified[0].address).to.equal(first.address);
    expect((await getVerifyArgs(manager.cache)).size).to.equal(0);

    manager.setVerificationStrategy('lazy');
    const second = await manager.deploy('second', 'test/Dog.sol', ['second', hre.ethers.constants.AddressZero, []]);
    expect(manager.config.verificationStrategy).to.equal('lazy');
    expect(verified).to.have.length(1);
    const queued = await getVerifyArgs(manager.cache);
    expect([...queued.keys()]).to.eql([second.address]);
    const saved = new Cache(manager.network, manager.deployment, false, dir);
    expect([...(await getVerifyArgs(saved)).keys()]).to.eql([second.address]);
    expect(manager.counter).to.equal(2);
  });

  it('keeps both disk-write flags consistent and writes new files only while enabled', async () => {
    const manager = new DeploymentManager('test-network', 'test-deployment', hre, {
      baseDir: dir, writeCacheToDisk: false,
    });
    const flags = () => ({ config: manager.config.writeCacheToDisk, cache: manager.cache.writeCacheToDisk });
    await manager.cache.storeCache({ rel: 'before.json' }, { value: 'before' });
    expect(flags()).to.eql({ config: false, cache: false });
    expect(await manager.cache.readCache({ rel: 'before.json' })).to.eql({ value: 'before' });
    expect(await fs.readdir(dir)).to.eql([]);

    manager.shouldWriteCacheToDisk(true);
    await manager.cache.storeCache({ rel: 'enabled.json' }, { value: 'on disk' });
    expect(flags()).to.eql({ config: true, cache: true });
    const fresh = new Cache(manager.network, manager.deployment, false, dir);
    expect(await fresh.readCache({ rel: 'enabled.json' })).to.eql({ value: 'on disk' });

    manager.shouldWriteCacheToDisk(false);
    await manager.cache.storeCache({ rel: 'after.json' }, { value: 'after' });
    expect(flags()).to.eql({ config: false, cache: false });
    expect(await manager.cache.readCache({ rel: 'after.json' })).to.eql({ value: 'after' });
    expect(await fs.readdir(`${dir}/test-network/test-deployment`)).to.eql(['enabled.json']);
    manager.cache.clearMemory();
    expect(await manager.cache.readCache({ rel: 'enabled.json' })).to.eql({ value: 'on disk' });
    expect(await manager.cache.readCache({ rel: 'before.json' })).to.equal(undefined);
    expect(await manager.cache.readCache({ rel: 'after.json' })).to.equal(undefined);
  });
});
