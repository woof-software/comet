import { expect } from 'chai';
import hre from 'hardhat';
import { Contract } from 'ethers';
import { Dog } from '../../../build/types';
import { Cache } from '../Cache';
import { readContract } from '../Import';
import { storeBuildFile } from '../ContractMap';
import { RelationConfigMap } from '../RelationConfig';
import { spider } from '../Spider';
import { tempDir } from './TestHelpers';

describe('Spider relationship rule selection', () => {
  const network = 'test-network';
  const zero = hre.ethers.constants.AddressZero;
  let cache: Cache;
  let root: Dog;
  let first: Dog;
  let second: Dog;
  const children = async (contract: Contract) =>
    (await (contract as Dog).callStatic.puppers()).map(entry => entry.pup);

  beforeEach(async () => {
    cache = new Cache(network, 'test-deployment', false, tempDir());
    const factory = await hre.ethers.getContractFactory('Dog');
    first = await factory.deploy('first', zero, []) as Dog;
    second = await factory.deploy('second', zero, []) as Dog;
    root = await factory.deploy('root', first.address, [first.address, second.address]) as Dog;
    for (const dog of [root, first, second]) {
      await dog.deployed();
      await storeBuildFile(cache, network, dog.address,
        await readContract(cache, hre, 'contracts/test/Dog.sol:Dog', network, dog.address, true));
    }
  });

  for (const selected of ['address', 'alias template', 'contract name'] as const) {
    it(`selects the ${selected} rule when more general rules compete`, async () => {
      const used: string[] = [];
      const rule = (name: string, address: string) => ({
        relations: { selected: { field: async () => { used.push(name); return address; }, alias: `${name}-child` } },
      });
      const config: RelationConfigMap = {
        Dog: rule('name', second.address),
        ...(selected !== 'contract name' && { root: rule('template', first.address) }),
        ...(selected === 'address' && { [root.address.toLowerCase()]: rule('address', first.address) }),
      };
      // Limit competing rules to the parent; discovered children use an address-specific leaf rule.
      config[first.address.toLowerCase()] = {};
      config[second.address.toLowerCase()] = {};
      const result = await spider(cache, network, hre, config, new Map([['root', root.address]]));
      const winner = selected === 'address' ? 'address' : selected === 'alias template' ? 'template' : 'name';
      const address = winner === 'name' ? second.address : first.address;
      expect(used).to.eql([winner]);
      expect([...result.aliases]).to.eql([['root', root.address], [`${winner}-child`, address]]);
      expect(result.contracts.get(`${winner}-child`)?.address).to.equal(address);
    });
  }

  it('uses the contract-name rule before a rule keyed by the final rendered alias', async () => {
    const used: string[] = [];
    const config: RelationConfigMap = {
      [root.address.toLowerCase()]: { relations: { branch: { field: 'father', alias: async () => 'rendered' } } },
      Dog: { relations: { selected: { field: async () => { used.push('name'); return second.address; }, alias: 'child' } } },
      rendered: { relations: { ignored: { field: async () => { used.push('rendered alias'); return root.address; } } } },
      [second.address.toLowerCase()]: {},
    };
    // The anonymous callback has no template key but renders to the alias 'rendered'.
    const result = await spider(cache, network, hre, config, new Map([['root', root.address]]));
    expect(used).to.eql(['name']);
    expect(result.aliases.get('rendered')).to.equal(first.address);
    expect(result.aliases.get('child')).to.equal(second.address);
  });

  it('assigns different templates to different array elements', async () => {
    const config: RelationConfigMap = {
      root: { relations: { pups: { field: children, alias: ['older', 'younger'] } } },
    };
    const result = await spider(cache, network, hre, config, new Map([['root', root.address]]));
    expect([...result.aliases]).to.eql([['root', root.address], ['older', first.address], ['younger', second.address]]);
    expect(await result.contracts.get('older')?.name()).to.equal('first');
    expect(await result.contracts.get('younger')?.name()).to.equal('second');
  });

  it('passes previously discovered contracts into field and alias callbacks', async () => {
    let contextualFieldCalls = 0;
    let contextualAliasCalls = 0;
    const config: RelationConfigMap = {
      root: { relations: {
        known: { field: 'father', alias: 'knownFather' },
        pups: {
          field: async (contract, context) => {
            contextualFieldCalls++;
            expect(context.known.map(entry => entry.address)).to.eql([first.address]);
            return (await children(contract)).filter(address => address !== context.known[0].address);
          },
          alias: async (contract, context, index, path) => {
            contextualAliasCalls++;
            expect(context.known[0].address).to.equal(first.address);
            expect(index).to.equal(0);
            expect(path[0].address).to.equal(root.address);
            return `${await contract.name()}-after-${await context.known[0].name()}`;
          },
        },
      } },
    };
    const result = await spider(cache, network, hre, config, new Map([['root', root.address]]));
    expect(contextualFieldCalls).to.equal(1);
    expect(contextualAliasCalls).to.equal(1);
    expect([...result.aliases]).to.eql([['root', root.address], ['knownFather', first.address], ['second-after-first', second.address]]);
    expect(await result.contracts.get('second-after-first')?.name()).to.equal('second');
  });
});
