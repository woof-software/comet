import { expect } from 'chai';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import { Dog } from '../../../build/types';
import { World } from '../../scenario/World';
import { DeploymentManager } from '../DeploymentManager';
import { getAliases } from '../Aliases';
import { tempDir } from './TestHelpers';

describe('DeploymentManager snapshot restoration', () => {
  let dir: string;
  let manager: DeploymentManager;
  let first: Dog;
  let second: Dog;
  const progress = { rel: 'progress.json' };

  beforeEach(async () => {
    dir = await fs.mkdtemp(tempDir());
    const factory = await hre.ethers.getContractFactory('Dog');
    first = await factory.deploy('before', hre.ethers.constants.AddressZero, []) as Dog;
    second = await factory.deploy('after', hre.ethers.constants.AddressZero, []) as Dog;
    await first.deployed();
    await second.deployed();
    manager = new DeploymentManager('test-network', 'test-deployment', hre, {
      baseDir: dir, writeCacheToDisk: false, verificationStrategy: 'eager',
    });
    manager.contractsCache = new Map();
    await manager.putAlias('pet', first);
    await manager.cache.storeCache(progress, { step: 1 });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps forked aliases and cached values isolated from later map updates', async () => {
    const saved = manager.fork();
    await manager.putAlias('pet', second);
    await manager.cache.storeCache(progress, { step: 2 });
    expect((await getAliases(saved.cache)).get('pet')).to.equal(first.address);
    expect(saved.contractsCache?.get('pet')?.address).to.equal(first.address);
    expect(await saved.cache.readCache(progress)).to.eql({ step: 1 });
    expect((await getAliases(manager.cache)).get('pet')).to.equal(second.address);
    expect(await manager.cache.readCache(progress)).to.eql({ step: 2 });
  });

  it('preserves the forked verification strategy after changing the active manager', () => {
    const saved = manager.fork();
    manager.setVerificationStrategy('lazy');
    expect(manager.config.verificationStrategy).to.equal('lazy');
    // The snapshot must keep its own settings rather than sharing the active config object.
    expect(saved.config.verificationStrategy).to.equal('eager');
  });

  it('preserves consistent disabled disk-write flags in the fork after enabling active writes', () => {
    const saved = manager.fork();
    manager.shouldWriteCacheToDisk(true);
    expect({ config: manager.config.writeCacheToDisk, cache: manager.cache.writeCacheToDisk })
      .to.eql({ config: true, cache: true });
    expect({ config: saved.config.writeCacheToDisk, cache: saved.cache.writeCacheToDisk })
      .to.eql({ config: false, cache: false });
  });

  it('restores on-chain state, aliases, memory and settings through World snapshot and revert', async () => {
    const world = new World({ name: 'local-snapshot', network: 'hardhat', deployment: manager.deployment });
    // Use the real local HRE without World.initialize(), which creates an external fork.
    world.deploymentManager = manager;
    const snapshot = await world._snapshot();
    let reverted = false;
    try {
      await (await first.addPup(second.address)).wait();
      expect(await first.callStatic.puppers()).to.have.length(1);
      await manager.putAlias('pet', second);
      await manager.cache.storeCache(progress, { step: 2 });
      manager.setVerificationStrategy('lazy');
      // Toggle only after the memory updates; this test must not write files to disk.
      manager.shouldWriteCacheToDisk(true);
      await world._revert(snapshot);
      reverted = true;
      const restored = world.deploymentManager;
      expect(restored).not.to.equal(manager);
      expect(await first.callStatic.puppers()).to.have.length(0);
      expect((await getAliases(restored.cache)).get('pet')).to.equal(first.address);
      expect(restored.contractsCache?.get('pet')?.address).to.equal(first.address);
      expect(await restored.cache.readCache(progress)).to.eql({ step: 1 });
      expect(await fs.readdir(dir)).to.eql([]);
      expect({
        strategy: restored.config.verificationStrategy,
        configWrites: restored.config.writeCacheToDisk,
        cacheWrites: restored.cache.writeCacheToDisk,
      }).to.eql({ strategy: 'eager', configWrites: false, cacheWrites: false });
    } finally {
      if (!reverted) await world._revert(snapshot);
    }
  });
});
