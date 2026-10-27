import { expect } from 'chai';
import hre from 'hardhat';
import nock from 'nock';
import * as fs from 'fs/promises';

import {
  Dog,
  ProxyAdmin,
  TransparentUpgradeableProxy,
} from '../../../build/types';

import { getBuildFile } from '../ContractMap';
import { DeploymentManager } from '../DeploymentManager';
import { Migration } from '../Migration';
import { expectedTemplate } from './MigrationTemplateTest';
import { buildToken, faucetTokenBuildFile, tokenArgs } from './DeployHelpers';
import { tempDir } from './TestHelpers';
import { VerifyArgs } from '../Verify';
import { getVerifyArgs, putVerifyArgs } from '../VerifyArgs';
import { mockVerifySuccess } from './VerifyTest';
import { objectFromMap } from '../Utils';
import { getAliases } from '../Aliases';

export interface TestContracts {
  finn: Dog;
  molly: Dog;
  spot: Dog;
  proxy: TransparentUpgradeableProxy;
  finnImpl: Dog;
  proxyAdmin: ProxyAdmin;
}

export async function setupContracts(deploymentManager: DeploymentManager): Promise<TestContracts> {
  const signers = await deploymentManager.getSigners();
  let proxyAdminArgs: string[] = [signers[0].address];
  let proxyAdmin: ProxyAdmin = await deploymentManager.deploy(
    'proxyAdmin',
    'vendor/proxy/transparent/ProxyAdmin.sol',
    proxyAdminArgs
  );

  let finnImpl: Dog = await deploymentManager.deploy(
    'finnImpl',
    'test/Dog.sol',
    ['finn:implementation', '0x0000000000000000000000000000000000000000', []]
  );

  let proxy: TransparentUpgradeableProxy = await deploymentManager.deploy(
    'proxy',
    'vendor/proxy/transparent/TransparentUpgradeableProxy.sol',
    [finnImpl.address, proxyAdmin.address, (
      await finnImpl.populateTransaction.initializeDog(
        'finn',
        finnImpl.address,
        []
      )
    ).data]);

  let molly: Dog = await deploymentManager.deploy(
    'molly',
    'test/Dog.sol',
    ['molly', proxy.address, []]
  );

  let spot: Dog = await deploymentManager.deploy(
    'spot',
    'test/Dog.sol',
    ['spot', proxy.address, []]
  );

  let finn = finnImpl.attach(proxy.address);

  await finn.addPup(molly.address);
  await finn.addPup(spot.address);

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
      let spot: Dog = await deploymentManager.deploy(
        'spot',
        'test/Dog.sol',
        ['spot', '0x0000000000000000000000000000000000000000', []]
      );
      // Check that we've cached the build file
      expect((await getBuildFile(deploymentManager.cache, 'test-network', spot.address)).contract).to.eql('Dog');
    });

    // Run the same steps for alias reuse and forced redeployment.
    for (const { name, force, expectedDeployments } of [
      { name: 'reuses an existing alias without submitting another deployment', force: false, expectedDeployments: 1 },
      { name: 'deploys a new contract and updates the alias when forced', force: true, expectedDeployments: 2 },
    ]) {
      it(name, async () => {
        // Keep cache files separate from real deployments.
        const dir = await fs.mkdtemp(tempDir());

        try {
          const manager = new DeploymentManager('test-network', 'test-deployment', hre, {
            importRetries: 0,
            writeCacheToDisk: true,
            verificationStrategy: 'none',
            baseDir: dir,
          });
          const signer = await manager.getSigner();
          const sendTransaction = signer.sendTransaction;
          let deploymentSubmissions = 0;

          // Count real deployment submissions, they have no recipient address.
          signer.sendTransaction = async (transaction) => {
            if (await transaction.to == null) deploymentSubmissions++;
            return sendTransaction.call(signer, transaction);
          };

          try {
            // Create the first contract under the 'pet' alias.
            const first: Dog = await manager.deploy(
              'pet', 'test/Dog.sol', ['first', hre.ethers.constants.AddressZero, []]
            );

            // Check the first deployment and its alias in memory and on disk.
            expect(deploymentSubmissions).to.equal(1);
            expect(manager.counter).to.equal(1);
            expect((await getAliases(manager.cache)).get('pet')).to.equal(first.address);
            expect(JSON.parse(await fs.readFile(
              manager.cache.getFilePath({ rel: 'aliases.json' }), 'utf8'
            ))).to.eql({ pet: first.address });

            // Reuse 'pet', or replace its address when force=true.
            const second: Dog = await manager.deploy(
              'pet', 'test/Dog.sol', ['second', hre.ethers.constants.AddressZero, []], force
            );

            // New constructor arguments apply only to a new contract.
            if (force) {
              expect(second.address).not.to.equal(first.address);
            } else {
              expect(second.address).to.equal(first.address);
            }
            expect(await first.name()).to.equal('first');
            expect(await second.name()).to.equal(force ? 'second' : 'first');
            expect(deploymentSubmissions).to.equal(expectedDeployments);
            expect(manager.counter).to.equal(expectedDeployments);

            // The contract lookup and both alias stores must agree.
            const currentContract = await manager.contract('pet');
            expect(currentContract?.address).to.equal(second.address);
            expect((await getAliases(manager.cache)).get('pet')).to.equal(second.address);
            expect(JSON.parse(await fs.readFile(
              manager.cache.getFilePath({ rel: 'aliases.json' }), 'utf8'
            ))).to.eql({ pet: second.address });
          } finally {
            // Restore the signer even if an assertion fails.
            signer.sendTransaction = sendTransaction;
          }
        } finally {
          // Remove the temporary cache files.
          await fs.rm(dir, { recursive: true, force: true });
        }
      });
    }
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
      let verifyArgs: VerifyArgs = {
        via: 'artifacts',
        address: token.address,
        constructorArguments: tokenArgs,
        contract: 'contracts/test/FaucetToken.sol:FaucetToken',
      };
      await putVerifyArgs(
        deploymentManager.cache,
        token.address,
        verifyArgs
      );
      expect(objectFromMap(await getVerifyArgs(deploymentManager.cache))).to.eql({
        [token.address]: verifyArgs
      });

      mockVerifySuccess(hre);
      await deploymentManager.verifyContracts();

      // VerifyArgs cache should be cleared upon successful verification
      expect(objectFromMap(await getVerifyArgs(deploymentManager.cache))).to.eql({});
    });

    describe('queue integrity', () => {
      let dir: string;
      let manager: DeploymentManager;
      const makeArgs = (address: string) => ({
        via: 'artifacts' as const,
        address,
        constructorArguments: tokenArgs,
        contract: 'contracts/test/FaucetToken.sol:FaucetToken',
      });
      const successful = makeArgs('0x1111111111111111111111111111111111111111');
      const failed = makeArgs('0x2222222222222222222222222222222222222222');
      const skipped = makeArgs('0x3333333333333333333333333333333333333333');

      beforeEach(async () => {
        dir = await fs.mkdtemp(tempDir());
        manager = new DeploymentManager('test-network', 'test-deployment', hre, {
          writeCacheToDisk: true,
          baseDir: dir,
        });
      });

      afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
      });

      async function expectQueue(expected: Record<string, VerifyArgs>) {
        // Check memory and the actual persisted queue independently.
        expect(objectFromMap(await getVerifyArgs(manager.cache))).to.eql(expected);
        expect(JSON.parse(await fs.readFile(
          manager.cache.getFilePath({ rel: ['verify', 'args.json'] }), 'utf8'
        ))).to.eql(expected);
      }

      it('keeps failed and filtered entries and retries only the remaining queue', async () => {
        // Put a failure first to check that returning false does not stop the queue.
        for (const args of [failed, successful, skipped]) {
          await putVerifyArgs(manager.cache, args.address, args);
        }
        const verified: VerifyArgs[] = [];
        manager.verifyContract = async (args) => {
          verified.push(args);
          return args.via === 'artifacts' && args.address === successful.address;
        };

        const filtered: Array<[string, VerifyArgs]> = [];
        await manager.verifyContracts(async (address, args) => {
          filtered.push([address, args]);
          return address !== skipped.address;
        });

        expect(filtered).to.eql([
          [failed.address, failed],
          [successful.address, successful],
          [skipped.address, skipped],
        ]);
        expect(verified).to.eql([failed, successful]);
        await expectQueue({ [failed.address]: failed, [skipped.address]: skipped });

        // On the next run, the successful entry must not be verified again.
        const retried: VerifyArgs[] = [];
        manager.verifyContract = async (args) => {
          retried.push(args);
          return true;
        };
        await manager.verifyContracts();

        expect(retried).to.eql([failed, skipped]);
        await expectQueue({});
      });

      it('propagates verification errors and preserves failed and unprocessed entries', async () => {
        for (const args of [successful, failed, skipped]) {
          await putVerifyArgs(manager.cache, args.address, args);
        }
        const failure = new Error('Verification unavailable');
        const verified: VerifyArgs[] = [];
        manager.verifyContract = async (args) => {
          verified.push(args);
          if (args.via === 'artifacts' && args.address === failed.address) throw failure;
          return true;
        };

        // A thrown error stops processing and must reach the caller unchanged.
        let caught: unknown;
        try {
          await manager.verifyContracts();
        } catch (error) {
          caught = error;
        }

        expect(caught).to.equal(failure);
        expect(verified).to.eql([successful, failed]);
        await expectQueue({ [failed.address]: failed, [skipped.address]: skipped });
      });
    });
  });

  describe('putAlias', () => {
    it('should update contract cache', async () => {
      let deploymentManager = new DeploymentManager('test-network', 'test-deployment', hre, {
        importRetries: 0,
        writeCacheToDisk: true,
        baseDir: tempDir(),
      });
      let spot: Dog = await deploymentManager.deploy(
        'spot',
        'test/Dog.sol',
        ['spot', '0x0000000000000000000000000000000000000000', []]
      );
      let molly: Dog = await deploymentManager.deploy(
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
                  field: async (dog) => (await dog.callStatic.puppers()).map(({ pup }) => pup),
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
        let name = contract.hasOwnProperty('name') ? await contract.name() : null;
        check[alias] = name ? name : contract.address;
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
