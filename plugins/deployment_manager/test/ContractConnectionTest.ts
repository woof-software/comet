import { expect } from 'chai';
import { strict as assert } from 'assert';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import { Contract } from 'ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeploymentManager } from '../DeploymentManager';
import { getAliases } from '../Aliases';
import { getBuildFile, storeBuildFile } from '../ContractMap';
import { readContract } from '../Import';
import { putRoots } from '../Roots';
import { tempDir } from './TestHelpers';

describe('DeploymentManager contract connections', () => {
  const tokenArtifact = 'contracts/test/FaucetToken.sol:FaucetToken';
  const dogArtifact = 'contracts/test/Dog.sol:Dog';
  let token: Contract;
  let dog: Contract;
  let dir: string;
  let manager: DeploymentManager;
  let imports: Array<[string, string | undefined]>;
  let artifacts: string[];
  let nonceBefore: number;
  let signerAddress: string;

  before(async () => {
    const tokenFactory = await hre.ethers.getContractFactory('FaucetToken');
    token = await tokenFactory.deploy(123, 'Existing token', 8, 'EXISTING');
    await token.deployed();
    dog = await (await hre.ethers.getContractFactory('Dog')).deploy('Existing dog', hre.ethers.constants.AddressZero, []);
    await dog.deployed();
  });
  beforeEach(async () => {
    dir = await fs.mkdtemp(tempDir());
    imports = [];
    artifacts = [];
    const runtime: HardhatRuntimeEnvironment = {
      ...hre,
      artifacts: Object.assign(Object.create(hre.artifacts), {
        readArtifact: async (name: string) => {
          artifacts.push(name);
          return hre.artifacts.readArtifact(name);
        },
      }),
      config: { ...hre.config, deploymentManager: { relationConfigMap: {} } },
    };
    manager = new DeploymentManager('test-network', 'destination', runtime, {
      baseDir: dir, writeCacheToDisk: true,
    });
    manager.contractsCache = new Map();
    // Supply real cached builds so the import wrapper needs no explorer requests.
    for (const [contract, artifact] of [[token, tokenArtifact], [dog, dogArtifact]] as const) {
      const build = await readContract(manager.cache, hre, artifact, 'source-network', contract.address, true);
      await storeBuildFile(manager.cache, 'source-network', contract.address, build);
    }
    const originalImport = manager.import.bind(manager);
    manager.import = async (address, network) => {
      imports.push([address, network]);
      return originalImport(address, network);
    };
    signerAddress = (await hre.ethers.getSigners())[0].address;
    nonceBefore = await hre.ethers.provider.getTransactionCount(signerAddress);
  });
  afterEach(async () => {
    try {
      // Connecting and discovery must not submit any transaction.
      expect(await hre.ethers.provider.getTransactionCount(signerAddress)).to.equal(nonceBefore);
      expect(manager.counter).to.equal(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function expectAlias(alias: string, address: string) {
    expect(manager.contractsCache?.get(alias)?.address).to.equal(address);
    expect((await getAliases(manager.cache)).get(alias)).to.equal(address);
    const saved = JSON.parse(await fs.readFile(manager.cache.getFilePath({ rel: 'aliases.json' }), 'utf8'));
    expect(saved[alias]).to.equal(address);
  }

  it('connects to one existing address with its imported ABI and saves the alias', async () => {
    const result = await manager.existing('token', token.address, 'source-network');
    expect(result.address).to.equal(token.address);
    expect(await result.symbol()).to.equal('EXISTING');
    expect(imports).to.eql([[token.address, 'source-network']]);
    expect(artifacts).to.eql([]);
    await expectAlias('token', token.address);
  });

  it('reuses a known alias without importing a different requested address', async () => {
    await manager.putAlias('known', token);
    const result = await manager.existing('known', dog.address, 'source-network');
    expect(result.address).to.equal(token.address);
    expect(await result.symbol()).to.equal('EXISTING');
    expect(imports).to.eql([]);
    await expectAlias('known', token.address);
  });

  it('merges ABIs for multiple addresses and uses the last address as the target', async () => {
    const result = await manager.existing('combined', [dog.address, token.address], 'source-network');
    expect(result.address).to.equal(token.address);
    expect(result.interface.getFunction('puppers()').name).to.equal('puppers');
    expect(result.interface.getFunction('symbol()').name).to.equal('symbol');
    // The merged object points at the token, so execute only methods that token implements.
    expect(await result.symbol()).to.equal('EXISTING');
    expect(imports).to.have.deep.members([[dog.address, 'source-network'], [token.address, 'source-network']]);
    expect(imports).to.have.length(2);
    await expectAlias('combined', token.address);
  });

  it('uses an explicit artifact even when the alias and a different cached ABI already exist', async () => {
    await manager.putAlias('selected', dog);
    const wrongBuild = await getBuildFile(manager.cache, 'source-network', dog.address);
    await storeBuildFile(manager.cache, manager.network, token.address, wrongBuild);
    const result = await manager.existing('selected', token.address, manager.network, tokenArtifact);
    expect(result.address).to.equal(token.address);
    expect(await result.symbol()).to.equal('EXISTING');
    expect(result.interface.functions['puppers()']).to.equal(undefined);
    expect(imports).to.eql([]);
    expect(artifacts).to.eql([tokenArtifact]);
    await expectAlias('selected', token.address);
  });

  it('casts with the specified local artifact without importing or changing cached builds and aliases', async () => {
    const wrongBuild = await getBuildFile(manager.cache, 'source-network', token.address);
    await storeBuildFile(manager.cache, manager.network, dog.address, wrongBuild);
    const result = await manager.cast(dog.address, dogArtifact);
    expect(result.address).to.equal(dog.address);
    expect(await result.name()).to.equal('Existing dog');
    expect(result.interface.functions['symbol()']).to.equal(undefined);
    expect(artifacts).to.eql([dogArtifact]);
    expect(imports).to.eql([]);
    expect(await getBuildFile(manager.cache, manager.network, dog.address)).to.eql(wrongBuild);
    expect((await getAliases(manager.cache)).size).to.equal(0);
    expect(manager.contractsCache?.size).to.equal(0);
  });

  for (const present of [true, false]) {
    it(`retrieves a source deployment alias with present=${present} without importing or deploying`, async () => {
      const source = new DeploymentManager('source-network', 'source-market', manager.hre, {
        baseDir: dir, writeCacheToDisk: true,
      });
      await putRoots(source.cache, new Map([['sourceToken', token.address]]));
      const calls: Array<[string, string]> = [];
      // Keep source discovery real while directing spiderOther to the isolated test directory.
      manager.spiderOther = async (network, deployment) => {
        calls.push([network, deployment]);
        return source.spider();
      };
      if (present) {
        const result = await manager.fromDep('localToken', source.network, source.deployment, 'sourceToken');
        expect(result.address).to.equal(token.address);
        expect(await result.symbol()).to.equal('EXISTING');
        await expectAlias('localToken', token.address);
        expect(manager.contractsCache?.has('sourceToken')).to.equal(false);
      } else {
        await assert.rejects(manager.fromDep('localToken', source.network, source.deployment, 'missing'),
          /Unable to find contract source-network\/source-market:missing/);
        expect(manager.contractsCache?.size).to.equal(0);
        expect((await getAliases(manager.cache)).size).to.equal(0);
      }
      expect(calls).to.eql([['source-network', 'source-market']]);
      expect(imports).to.eql([]);
      expect(source.counter).to.equal(0);
    });
  }
});
