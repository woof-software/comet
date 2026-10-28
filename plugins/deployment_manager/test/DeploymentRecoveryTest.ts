import { expect } from 'chai';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import fsPromises from 'fs/promises';
import * as verification from '../Verify';
import { Dog } from '../../../build/types';
import { DeploymentManager } from '../DeploymentManager';
import { getAliases } from '../Aliases';
import { getBuildFile } from '../ContractMap';
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

  for (const boundary of ['build-info read', 'verification', 'build-file cache write']) {
    it(`does not silently redeploy after a failure in ${boundary} following contract creation`, async () => {
      const dir = await fs.mkdtemp(tempDir());
      const manager = new DeploymentManager('test-network', 'test-deployment', hre, {
        baseDir: dir,
        writeCacheToDisk: true,
        verificationStrategy: boundary === 'verification' ? 'eager' : 'none',
      });
      const signer = await manager.getSigner();
      const originalSend = signer.sendTransaction;
      const originalRead = fsPromises.readFile;
      const originalVerify = verification.verifyContract;
      const originalStore = manager.cache.storeCache;
      const timers = recordTimers(true);
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
            if (!injected && manager.cache.getFilePath(spec).includes('/.contracts/')) inject();
            return originalStore.call(manager.cache, spec, data, transformer);
          };
        }

        let deployed: Dog | undefined;
        let caught: unknown;
        try {
          deployed = await manager.deploy(
            'pet', 'test/Dog.sol', ['recoverable', hre.ethers.constants.AddressZero, []], false, 1
          );
        } catch (error) {
          caught = error;
        }
        expect(injected).to.equal(true);
        expect(injectedAfterCreation).to.equal(true);
        for (const address of created) expect(await hre.ethers.provider.getCode(address)).not.to.equal('0x');

        if (deployed) {
          expect(caught).to.equal(undefined);
          expect(manager.counter).to.equal(1);
          expect((await manager.contract('pet'))?.address).to.equal(deployed.address);
          expect((await getAliases(manager.cache)).get('pet')).to.equal(deployed.address);
          expect(JSON.parse(await fs.readFile(
            manager.cache.getFilePath({ rel: 'aliases.json' }), 'utf8'
          ))).to.eql({ pet: deployed.address });
          const beforeRerun = created.length;
          expect((await manager.deploy('pet', 'test/Dog.sol', [])).address).to.equal(deployed.address);
          expect(created).to.have.length(beforeRerun);
        } else {
          // Either safe recovery or an explicit failure is acceptable; duplicates are not.
          expect(caught).not.to.equal(undefined);
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
