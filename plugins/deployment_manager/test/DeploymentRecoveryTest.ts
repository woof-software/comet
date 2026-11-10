import { expect } from 'chai';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import fsPromises from 'fs/promises';
import { Contract } from 'ethers';
import * as verification from '../Verify';
import { Dog } from '../../../build/types';
import { DeploymentManager } from '../DeploymentManager';
import { getAliases } from '../Aliases';
import { getBuildFile, storeBuildFile } from '../ContractMap';
import { Cache } from '../Cache';
import { faucetTokenBuildFile, tokenArgs } from './DeployHelpers';
import { putRoots } from '../Roots';
import { recordTimers, tempDir } from './TestHelpers';

describe('DeploymentManager recovery', () => {
  it('discovers saved roots and reuses a deployment in a fresh manager without a new transaction', async () => {
    const dir = await fs.mkdtemp(tempDir());
    try {
      const config = { baseDir: dir, writeCacheToDisk: true, verificationStrategy: 'none' as const };
      const original = new DeploymentManager('test-network', 'test-deployment', hre, config);
      const first: Dog = await original.deploy(
        'pet', 'test/Dog.sol', ['saved', hre.ethers.constants.AddressZero, []]
      );
      await putRoots(original.cache, new Map([['pet', first.address]]));
      const signer = await original.getSigner();
      const nonceBefore = await hre.ethers.provider.getTransactionCount(signer.address);

      // A fresh instance starts with no objects or aliases loaded in memory.
      const fresh = new DeploymentManager('test-network', 'test-deployment', hre, { ...config });
      expect(fresh.contractsCache).to.equal(null);
      expect(fresh.cache.cache.size).to.equal(0);
      const restored = await fresh.contract<Dog>('pet');
      expect(restored?.address).to.equal(first.address);
      expect(await restored?.name()).to.equal('saved');
      expect((await getBuildFile(fresh.cache, fresh.network, first.address)).contract).to.equal('Dog');

      // Different constructor arguments must not cause another deployment.
      const reused: Dog = await fresh.deploy(
        'pet', 'test/Dog.sol', ['must not be deployed', hre.ethers.constants.AddressZero, []]
      );
      expect(reused.address).to.equal(first.address);
      expect(await reused.name()).to.equal('saved');
      expect(await hre.ethers.provider.getTransactionCount(signer.address)).to.equal(nonceBefore);
      expect(original.counter).to.equal(1);
      expect(fresh.counter).to.equal(0);
      expect((await getAliases(fresh.cache)).get('pet')).to.equal(first.address);
      expect(JSON.parse(await fs.readFile(
        fresh.cache.getFilePath({ rel: 'aliases.json' }), 'utf8'
      ))).to.eql({ pet: first.address });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  const failures = [
    { via: 'artifacts', boundary: 'build-info read' },
    { via: 'artifacts', boundary: 'verification' },
    { via: 'artifacts', boundary: 'build-file cache write' },
    { via: 'clone', boundary: 'verification' },
    { via: 'clone', boundary: 'build-file cache write' },
  ] as const;
  for (const { via, boundary } of failures) {
    it(`does not silently redeploy via ${via} after a failure in ${boundary} following contract creation`, async () => {
      const dir = await fs.mkdtemp(tempDir());
      const manager = new DeploymentManager('test-network', 'test-deployment', hre, {
        baseDir: dir,
        writeCacheToDisk: true,
        verificationStrategy: boundary === 'verification' ? 'eager' : 'none',
      });
      // Clone goes through the real import and _deployBuild paths with a seeded local build.
      const source = via === 'clone'
        ? await (await hre.ethers.getContractFactory('FaucetToken')).deploy(...tokenArgs)
        : undefined;
      if (source) {
        await source.deployed();
        await storeBuildFile(manager.cache, 'source-network', source.address, faucetTokenBuildFile);
      }
      const signer = await manager.getSigner();
      const originalSend = signer.sendTransaction;
      const originalRead = fsPromises.readFile;
      const originalVerify = verification.verifyContract;
      const originalStore = manager.cache.storeCache;
      const timers = recordTimers({ shortenDeploymentWaits: true });
      const created: string[] = [];
      const failure = new Error(`Injected ${boundary} failure`);
      let injected = false;
      let injectedAfterCreation = false;
      const inject = () => {
        injected = true;
        injectedAfterCreation = created.length > 0;
        throw failure;
      };

      try {
        // Keep the deployment real and record every submitted contract address.
        signer.sendTransaction = async transaction => {
          const response = await originalSend.call(signer, transaction);
          if (await transaction.to == null) created.push(hre.ethers.utils.getContractAddress(response));
          return response;
        };
        if (boundary === 'build-info read') {
          Object.assign(fsPromises, {
            readFile: async (...args: Parameters<typeof fs.readFile>) => {
              if (!injected && String(args[0]).endsWith('/Dog.dbg.json')) inject();
              return originalRead(...args);
            },
          });
        } else if (boundary === 'verification') {
          // Unexpected verifier exceptions reach Deploy.ts's own retry wrapper.
          Object.assign(verification, {
            verifyContract: async () => {
              if (!injected) inject();
              return true;
            },
          });
        } else {
          manager.cache.storeCache = async (spec, data, transformer) => {
            if (!injected && manager.cache.getFilePath(spec).includes(`/${manager.network}/.contracts/`)) inject();
            return originalStore.call(manager.cache, spec, data, transformer);
          };
        }

        let deployed: Contract | undefined;
        let caught: unknown;
        try {
          deployed = await timers.run(() => source
            ? manager.clone('pet', source.address, tokenArgs, 'source-network', false, 1)
            : manager.deploy<Dog, [string, string, string[]]>(
              'pet', 'test/Dog.sol', ['recoverable', hre.ethers.constants.AddressZero, []], false, 1
            ));
        } catch (error) {
          caught = error;
        }
        expect(injected).to.equal(true);
        expect(injectedAfterCreation).to.equal(true);
        for (const address of created) expect(await hre.ethers.provider.getCode(address)).not.to.equal('0x');

        if (deployed) {
          expect(caught).to.equal(undefined);
          expect(deployed.address, 'recovery must return the first created contract').to.equal(created[0]);
          expect(manager.counter).to.equal(1);
          expect((await manager.contract('pet'))?.address).to.equal(deployed.address);
          expect((await getAliases(manager.cache)).get('pet')).to.equal(deployed.address);
          expect(JSON.parse(await fs.readFile(
            manager.cache.getFilePath({ rel: 'aliases.json' }), 'utf8'
          ))).to.eql({ pet: deployed.address });
          const savedBuild = await getBuildFile(manager.cache, manager.network, deployed.address);
          expect(savedBuild?.contract).to.equal(source ? 'FaucetToken' : 'Dog');
          const freshCache = new Cache(manager.network, manager.deployment, false, dir);
          expect(await getBuildFile(freshCache, manager.network, deployed.address)).to.eql(savedBuild);
          if (source) expect(savedBuild).to.eql(faucetTokenBuildFile);
          const beforeRerun = created.length;
          const reused = source
            ? await manager.clone('pet', source.address, [], 'source-network')
            : await manager.deploy('pet', 'test/Dog.sol', []);
          expect(reused.address).to.equal(deployed.address);
          expect(created).to.have.length(beforeRerun);
        } else {
          // Either safe recovery or an explicit failure is acceptable; duplicates are not.
          let cause = caught;
          const seen = new Set<unknown>();
          while (cause instanceof Error && cause !== failure && !seen.has(cause)) {
            seen.add(cause);
            cause = (cause as Error & { cause?: unknown }).cause;
          }
          expect(cause, 'the error must preserve the injected failure').to.equal(failure);
          expect(manager.counter).to.equal(0);
          expect((await getAliases(manager.cache)).get('pet')).to.equal(undefined);
        }
        expect(created, 'a post-creation failure submitted more than one deployment').to.have.length(1);
      } finally {
        signer.sendTransaction = originalSend;
        Object.assign(fsPromises, { readFile: originalRead });
        Object.assign(verification, { verifyContract: originalVerify });
        manager.cache.storeCache = originalStore;
        timers.restore();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
});
