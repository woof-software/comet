import { expect } from 'chai';
import { strict as assert } from 'assert';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import { ContractFactory } from 'ethers';
import { Dog, TransparentUpgradeableProxy } from '../../../build/types';
import { Cache } from '../Cache';
import { storeBuildFile } from '../ContractMap';
import { readContract } from '../Import';
import { spider } from '../Spider';
import { FieldFunction, RelationConfigMap } from '../RelationConfig';
import { tempDir } from './TestHelpers';

describe('Spider traversal edge cases', () => {
  const network = 'test-network';
  const zero = hre.ethers.constants.AddressZero;
  let factory: ContractFactory;
  let dir: string;
  let cache: Cache;
  let root: Dog;
  let first: Dog;
  let second: Dog;
  // Relation callbacks accept Contract; this fixture supplies Dog contracts.
  const children: FieldFunction = async contract =>
    (await (contract as Dog).callStatic.puppers()).map(entry => entry.pup);

  before(async () => {
    factory = await hre.ethers.getContractFactory('Dog');
  });
  beforeEach(async () => {
    dir = await fs.mkdtemp(tempDir());
    cache = new Cache(network, 'test-deployment', false, dir);
    root = await factory.deploy('root', zero, []) as Dog;
    first = await factory.deploy('first', root.address, []) as Dog;
    second = await factory.deploy('second', root.address, []) as Dog;
    for (const dog of [root, first, second]) {
      await dog.deployed();
      const build = await readContract(cache, hre, 'contracts/test/Dog.sol:Dog', network, dog.address, true);
      await storeBuildFile(cache, network, dog.address, build);
    }
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('accepts the same alias and address encountered through repeated relationships', async () => {
    await (await root.addPup(first.address)).wait();
    await (await root.addPup(first.address)).wait();
    const config: RelationConfigMap = {
      root: { relations: { pups: { field: children, alias: 'child' } } },
    };
    const result = await spider(cache, network, hre, config, new Map([['root', root.address]]));
    expect([...result.aliases]).to.eql([['root', root.address], ['child', first.address]]);
    expect(result.contracts.size).to.equal(2);
    expect(await result.contracts.get('child')?.name()).to.equal('first');
  });

  it('accepts repeated matching addresses with different letter cases', async () => {
    const config: RelationConfigMap = {
      root: { relations: { pups: {
        field: async () => [first.address, first.address.toLowerCase()], alias: 'child',
      } } },
    };
    const result = await spider(cache, network, hre, config, new Map([['root', root.address]]));
    expect(result.aliases.get('child')).to.equal(first.address);
    expect(result.contracts.size).to.equal(2);
  });

  it('rejects an alias that resolves to two different contract addresses', async () => {
    await (await root.addPup(first.address)).wait();
    await (await root.addPup(second.address)).wait();
    const config: RelationConfigMap = {
      root: { relations: { pups: { field: children, alias: 'child' } } },
    };
    await assert.rejects(spider(cache, network, hre, config, new Map([['root', root.address]])), error =>
      error instanceof Error && error.message === `Had child -> ${first.address}, not ${second.address}`);
  });

  it('returns empty maps for empty roots', async () => {
    const result = await spider(cache, network, hre, {}, new Map());
    expect(result.roots.size).to.equal(0);
    expect(result.aliases.size).to.equal(0);
    expect(result.contracts.size).to.equal(0);
  });

  for (const kind of ['EOA', 'zero address'] as const) {
    it(`keeps a ${kind} root as an alias without creating a contract object`, async () => {
      const address = kind === 'EOA' ? (await hre.ethers.getSigners())[0].address : zero;
      const roots = new Map([['account', address]]);
      const result = await spider(cache, network, hre, {}, roots);
      expect([...result.roots]).to.eql([...roots]);
      expect([...result.aliases]).to.eql([['account', address]]);
      expect(result.contracts.size).to.equal(0);
    });
  }

  it('reports a proxy whose required implementation slot points to no contract', async () => {
    const [signer] = await hre.ethers.getSigners();
    const proxy = await (await hre.ethers.getContractFactory('TransparentUpgradeableProxy'))
      .deploy(root.address, signer.address, '0x') as TransparentUpgradeableProxy;
    await proxy.deployed();
    const build = await readContract(cache, hre,
      'contracts/vendor/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy',
      network, proxy.address, true);
    await storeBuildFile(cache, network, proxy.address, build);
    const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
    // Corrupt only this local proxy instance to reproduce a missing implementation.
    await hre.network.provider.send('hardhat_setStorageAt', [proxy.address, slot, hre.ethers.constants.HashZero]);
    expect(await hre.ethers.provider.getStorageAt(proxy.address, slot)).to.equal(hre.ethers.constants.HashZero);
    const config: RelationConfigMap = { proxy: { delegates: { field: { slot } } } };
    await assert.rejects(spider(cache, network, hre, config, new Map([['proxy', proxy.address]])),
      /Failed to crawl proxy:implementation at 0x0000000000000000000000000000000000000000/);
  });

  it('reflects a newly added relationship on a fresh traversal', async () => {
    await (await root.addPup(first.address)).wait();
    const config: RelationConfigMap = {
      root: { relations: { pups: { field: children, alias: '.name' } } },
    };
    const roots = new Map([['root', root.address]]);
    const before = await spider(cache, network, hre, config, roots);
    expect([...before.aliases]).to.eql([['root', root.address], ['first', first.address]]);

    await (await root.addPup(second.address)).wait();
    const after = await spider(cache, network, hre, config, roots);
    expect([...after.aliases]).to.eql([['root', root.address], ['first', first.address], ['second', second.address]]);
    expect(await after.contracts.get('second')?.name()).to.equal('second');
    expect(before.aliases.has('second')).to.equal(false);
    expect(before.contracts.size).to.equal(2);
    expect(after.contracts.size).to.equal(3);
  });
});
