import { expect } from 'chai';
import type { Contract } from 'ethers';
import hre from 'hardhat';
import nock from 'nock';

import { getBuildFile } from '../ContractMap.js';
import { DeploymentManager } from '../DeploymentManager.js';
import type { Migration } from '../Migration.js';
import { expectedTemplate } from './MigrationTemplateTest.js';
import { buildToken, faucetTokenBuildFile, tokenArgs } from './DeployHelpers.js';
import { tempDir } from './TestHelpers.js';
import type { VerifyArgs } from '../Verify.js';
import { getVerifyArgs, putVerifyArgs } from '../VerifyArgs.js';
import { mockVerifySuccess } from './VerifyTest.js';
import { objectFromMap } from '../Utils.js';

export interface TestContracts {
  finn: Contract;
  molly: Contract;
  spot: Contract;
  proxy: Contract;
  finnImpl: Contract;
  proxyAdmin: Contract;
}

export async function setupContracts(deploymentManager: DeploymentManager): Promise<TestContracts> {
  const signers = await deploymentManager.getSigners();
  const proxyAdminArgs: string[] = [await signers[0].getAddress()];
  const proxyAdmin: Contract = await deploymentManager.deploy(
    'proxyAdmin',
    'vendor/proxy/transparent/ProxyAdmin.sol',
    proxyAdminArgs
  );

  const finnImpl: Contract = await deploymentManager.deploy(
    'finnImpl',
    'test/Dog.sol',
    ['finn:implementation', '0x0000000000000000000000000000000000000000', []]
  );

  const finnImplAddress = await finnImpl.getAddress();
  const proxyAdminAddress = await proxyAdmin.getAddress();
  const initializeDogTransaction = await finnImpl.initializeDog.populateTransaction(
    'finn',
    finnImplAddress,
    []
  );

  const proxy: Contract = await deploymentManager.deploy(
    'proxy',
    'vendor/proxy/transparent/TransparentUpgradeableProxy.sol',
    [finnImplAddress, proxyAdminAddress, initializeDogTransaction.data]
  );

  const proxyAddress = await proxy.getAddress();

  const molly: Contract = await deploymentManager.deploy(
    'molly',
    'test/Dog.sol',
    ['molly', proxyAddress, []]
  );

  const spot: Contract = await deploymentManager.deploy(
    'spot',
    'test/Dog.sol',
    ['spot', proxyAddress, []]
  );

  const finn = finnImpl.attach(proxyAddress) as Contract;

  await finn.addPup(await molly.getAddress());
  await finn.addPup(await spot.getAddress());

  return {
    finn,
    molly,
    spot,
    proxy,
    finnImpl,
    proxyAdmin,
  };
}

describe('DeploymentManager', () => {
  beforeEach(async () => {
    nock.disableNetConnect();
  });

  describe('deploy', () => {
    it('should deploy succesfully', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });
      const spot: Contract = await deploymentManager.deploy(
        'spot',
        'test/Dog.sol',
        ['spot', '0x0000000000000000000000000000000000000000', []]
      );
      // Check that we've cached the build file
      expect((await getBuildFile(deploymentManager.cache, 'test-network', await spot.getAddress())).contract).to.eql('Dog');
    });
  });

  describe('_deployBuild', () => {
    it('should deployBuild succesfully', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });
      let token = await deploymentManager._deployBuild(faucetTokenBuildFile, tokenArgs);
      expect(await token.symbol()).to.equal('TEST');
    });
  });

  describe('verifyContracts', () => {
    it('should verify contracts successfully', async function () {
      this.timeout(300_000);
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });
      // We have to deploy a contract because the Etherscan plugin checks the bytecode at the address
      let token = await buildToken();
      const tokenAddress = await token.getAddress();
      let verifyArgs: VerifyArgs = {
        via: 'artifacts',
        address: tokenAddress,
        constructorArguments: tokenArgs,
        contract: 'contracts/test/FaucetToken.sol:FaucetToken',
      };
      await putVerifyArgs(
        deploymentManager.cache,
        tokenAddress,
        verifyArgs
      );
      expect(objectFromMap(await getVerifyArgs(deploymentManager.cache))).to.eql({
        [tokenAddress]: verifyArgs
      });

      await mockVerifySuccess(hre);
      await deploymentManager.verifyContracts();

      // VerifyArgs cache should be cleared upon successful verification
      expect(objectFromMap(await getVerifyArgs(deploymentManager.cache))).to.eql({});
    });
  });

  describe('putAlias', () => {
    it('should update contract cache', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });
      const spot: Contract = await deploymentManager.deploy(
        'spot',
        'test/Dog.sol',
        ['spot', '0x0000000000000000000000000000000000000000', []]
      );
      const molly: Contract = await deploymentManager.deploy(
        'molly',
        'test/Dog.sol',
        ['molly', '0x0000000000000000000000000000000000000000', []]
      );
      await deploymentManager.putAlias('pet', spot);
      expect(await (await deploymentManager.contract('pet')).name()).to.equal('spot');
      await deploymentManager.putAlias('pet', molly);
      expect(await (await deploymentManager.contract('pet')).name()).to.equal('molly');
    });
  });

  describe('spider', () => {
    it('should spider succesfully', async () => {
      let deploymentManager = new DeploymentManager(
        'test-network',
        'test-deployment',
        hre, {
          importRetries: 0,
          writeCacheToDisk: true,
          baseDir: tempDir(),
        }
      );

      let { finn } = await setupContracts(
        deploymentManager
      );

      hre.config.deploymentManager.networks = {
        'test-network': {
          'test-deployment': {
            finn: {
              delegates: {
                field: {
                  slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
                },
              },
              relations: {
                father: {
                  alias: '.name',
                },
                pups: {
                  field: async (dog) => (await dog.puppers.staticCall()).map(({ pup }) => pup),
                  alias: ['.name'],
                },
              },
            },
          },
        },
      };

      await deploymentManager.spider({ finn });

      let check = {};
      for (let [alias, contract] of await deploymentManager.contracts()) {
        // Just make sure these contracts are working, too.
        const name = typeof contract.name === 'function' ? await contract.name() : null;
        check[alias] = name ? name : await contract.getAddress();
      }
      expect(check).to.eql({
        finn: 'finn',
        'finn:implementation': 'finn:implementation',
        molly: 'molly',
        spot: 'spot',
      });
    });
  });

  describe('contracts', () => {
    it('should get contracts succesfully', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });

      let { finn } = await setupContracts(
        deploymentManager
      );

      await deploymentManager.putAlias('mydog', finn);
      let contracts = await deploymentManager.contracts();

      expect(await contracts.get('mydog').name()).to.eql('finn');
    });
  });

  describe('contract', () => {
    it('should get contract succesfully', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });

      let { finn } = await setupContracts(
        deploymentManager
      );

      await deploymentManager.putAlias('mydog', finn);
      let contract = await deploymentManager.contract('mydog');
      expect(await contract.name()).to.eql('finn');
    });
  });

  describe('generateMigration', () => {
    it('should generate expected migration', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });

      expect(await deploymentManager.generateMigration('cool', 1)).to.equal('1_cool.ts');

      expect(
        await deploymentManager.cache.readCache({ rel: ['migrations', '1_cool.ts'] })
      ).to.equal(expectedTemplate);
    });
  });

  describe('storeArtifact & readArtifact', () => {
    it('should store and retrieve a given artifact', async () => {
      let baseDir = tempDir();
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir,
      });

      let migration: Migration<null> = {
        name: '1_cool',
        actions: {
          prepare: async () => null,
          enact: async () => { /* */ },
        },
      };

      expect(await deploymentManager.readArtifact(migration)).to.eql(undefined);

      expect(await deploymentManager.storeArtifact(migration, { dog: 'cool' })).to.eql(
        `${baseDir}/test-network/test-deployment/artifacts/1_cool.json`
      );

      expect(await deploymentManager.readArtifact(migration)).to.eql({ dog: 'cool' });

      deploymentManager.cache.clearMemory();

      expect(await deploymentManager.readArtifact(migration)).to.eql({ dog: 'cool' });
    });
  });
});
