import { expect } from 'chai';
import { strict as assert } from 'assert';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import { Dog } from '../../../build/types';
import { DeploymentManager } from '../DeploymentManager';
import { storeAliases } from '../Aliases';
import { tempDir } from './TestHelpers';

describe('DeploymentManager contract and configuration accessors', () => {
  let dir: string;
  let manager: DeploymentManager;
  let dog: Dog;
  before(async () => {
    dog = await (await hre.ethers.getContractFactory('Dog')).deploy('accessor dog', hre.ethers.constants.AddressZero, []) as Dog;
    await dog.deployed();
  });
  beforeEach(async () => {
    dir = await fs.mkdtemp(tempDir());
    manager = new DeploymentManager('test-network', 'test-deployment', hre, { baseDir: dir });
    manager.contractsCache = new Map([['pet', dog]]);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns undefined for an optional missing contract and reports the deployment for a required one', async () => {
    expect(await manager.contract('missing')).to.equal(undefined);
    await assert.rejects(manager.getContractOrThrow('missing'), error =>
      error instanceof Error && error.message === 'test-network/test-deployment deployment missing missing');
  });

  it('connects a single returned contract to the explicit signer without changing the cached object', async () => {
    const signer = (await hre.ethers.getSigners())[1];
    const result = await manager.contract<Dog>('pet', signer);
    assert.ok(result);
    expect(result.address).to.equal(dog.address);
    expect(await result.signer.getAddress()).to.equal(signer.address);
    expect(await result.name()).to.equal('accessor dog');
    expect(manager.contractsCache?.get('pet')).to.equal(dog);
    expect(await dog.signer.getAddress()).not.to.equal(signer.address);
  });

  it('connects all returned contracts to the explicit signer', async () => {
    const signer = (await hre.ethers.getSigners())[1];
    manager.contractsCache?.set('anotherName', dog);
    const result = await manager.getContracts(signer);
    expect(Object.keys(result)).to.eql(['pet', 'anotherName']);
    for (const contract of Object.values(result)) {
      expect(contract.address).to.equal(dog.address);
      expect(await contract.signer.getAddress()).to.equal(signer.address);
      expect(await contract.name()).to.equal('accessor dog');
    }
    expect(manager.contractsCache?.get('pet')).to.equal(dog);
  });

  it('reads an alias from the requested network and deployment without confusing other pairs', async () => {
    const other = (await hre.ethers.getSigners())[2].address;
    await storeAliases(manager.cache, new Map([['pet', dog.address]]));
    await storeAliases(manager.cache.asDeployment('other-network', 'source-market'), new Map([['pet', other]]));
    expect(await manager.readAlias('test-network', 'test-deployment', 'pet')).to.equal(dog.address);
    expect(await manager.readAlias('other-network', 'source-market', 'pet')).to.equal(other);
    expect(await manager.readAlias('other-network', 'different-market', 'pet')).to.equal(undefined);
  });

  it('reads complete configuration data from memory and from disk in a fresh manager', async () => {
    manager.shouldWriteCacheToDisk(true);
    const config = { enabled: false, limit: 0, label: '', nested: { assets: ['apple', 'pear'] } };
    await manager.cache.storeCache({ rel: 'configuration.json' }, config);
    expect(await manager.readConfig()).to.eql(config);
    const fresh = new DeploymentManager(manager.network, manager.deployment, hre, { baseDir: dir });
    expect(fresh.cache.cache.size).to.equal(0);
    expect(await fresh.readConfig()).to.eql(config);
    expect(await manager.readConfig()).to.eql(config);
  });
});
