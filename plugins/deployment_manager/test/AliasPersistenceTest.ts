import { expect } from 'chai';
import { strict as assert } from 'assert';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import fsPromises from 'fs/promises';
import { Cache } from '../Cache';
import { getAliases } from '../Aliases';
import { getBuildFile, storeBuildFile } from '../ContractMap';
import { DeploymentManager } from '../DeploymentManager';
import { faucetTokenBuildFile, tokenArgs } from './DeployHelpers';
import { tempDir } from './TestHelpers';

describe('DeploymentManager alias persistence failures', () => {
  for (const via of ['artifacts', 'clone'] as const) {
    it(`reports an alias write failure via ${via} and allows explicit repair without another deployment`, async () => {
      const dir = await fs.mkdtemp(tempDir());
      const manager = new DeploymentManager('test-network', 'test-deployment', hre, {
        baseDir: dir, writeCacheToDisk: true, verificationStrategy: 'none',
      });
      const originalRename = fsPromises.rename;
      const signer = await manager.getSigner();
      const originalSend = signer.sendTransaction;
      const created: string[] = [];
      let renameFailures = 0;
      const failure = new Error('Injected alias rename failure');
      try {
        const source = await (await hre.ethers.getContractFactory('FaucetToken')).deploy(...tokenArgs);
        await source.deployed();
        manager.contractsCache = new Map();
        await manager.putAlias('keep', source);
        await storeBuildFile(manager.cache, 'source-network', source.address, faucetTokenBuildFile);
        const nonceBefore = await signer.getTransactionCount();
        const aliasFile = manager.cache.getFilePath({ rel: 'aliases.json' });
        const previousAliases = await fs.readFile(aliasFile, 'utf8');
        signer.sendTransaction = async transaction => {
          const response = await originalSend.call(signer, transaction);
          if (await transaction.to == null) created.push(hre.ethers.utils.getContractAddress(response));
          return response;
        };
        Object.assign(fsPromises, {
          rename: async (...args: Parameters<typeof fs.rename>) => {
            if (String(args[1]) === aliasFile) {
              renameFailures++;
              throw failure;
            }
            return originalRename(...args);
          },
        });
        const args = [42, 'Recoverable token', 8, 'RECOVERED'];
        const run = () => via === 'clone'
          ? manager.clone('token', source.address, args, 'source-network', false, 0)
          : manager.deploy('token', 'test/FaucetToken.sol', args, false, 0);

        await assert.rejects(run(), error => error === failure);
        expect(renameFailures).to.equal(1);
        expect(created).to.have.length(1);
        expect(await signer.getTransactionCount()).to.equal(nonceBefore + 1);
        expect(await hre.ethers.provider.getCode(created[0])).not.to.equal('0x');
        expect(manager.counter).to.equal(1);
        expect(await fs.readFile(aliasFile, 'utf8')).to.equal(previousAliases);
        const fresh = new Cache(manager.network, manager.deployment, false, dir);
        expect(Object.fromEntries(await getAliases(fresh))).to.eql({ keep: source.address });
        expect((await getBuildFile(fresh, manager.network, created[0]))?.contract).to.equal('FaucetToken');

        // Repair only the failed alias step; do not assume memory or roots were rolled back.
        Object.assign(fsPromises, { rename: originalRename });
        const existing = new hre.ethers.Contract(created[0], source.interface, signer);
        await manager.putAlias('token', existing);
        const reused = await run();
        expect(reused.address).to.equal(created[0]);
        expect(await reused.symbol()).to.equal('RECOVERED');
        expect(created).to.have.length(1);
        expect(manager.counter).to.equal(1);
        expect(await signer.getTransactionCount()).to.equal(nonceBefore + 1);
        const repaired = new Cache(manager.network, manager.deployment, false, dir);
        expect(Object.fromEntries(await getAliases(repaired)))
          .to.eql({ keep: source.address, token: created[0] });
      } finally {
        signer.sendTransaction = originalSend;
        Object.assign(fsPromises, { rename: originalRename });
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
});
