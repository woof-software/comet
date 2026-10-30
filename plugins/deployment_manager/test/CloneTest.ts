import { expect } from 'chai';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import { Contract } from 'ethers';
import { DeploymentManager } from '../DeploymentManager';
import { getAliases } from '../Aliases';
import { getBuildFile, storeBuildFile } from '../ContractMap';
import { deployBuild } from '../Deploy';
import { faucetTokenBuildFile, tokenArgs } from './DeployHelpers';
import { tempDir } from './TestHelpers';

describe('DeploymentManager conditional cloning', () => {
  let dir: string;
  let source: Contract;
  before(async () => {
    source = await deployBuild(faucetTokenBuildFile, tokenArgs, hre, { network: 'source-network' });
  });
  beforeEach(async () => {
    dir = await fs.mkdtemp(tempDir());
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  for (const state of ['missing', 'existing', 'forced', 'zero address'] as const) {
    it(`handles alias state '${state}' with the intended import and deployment counts`, async () => {
      const manager = new DeploymentManager('test-network', 'test-deployment', hre, {
        baseDir: dir, writeCacheToDisk: true, verificationStrategy: 'none',
      });
      manager.contractsCache = new Map();
      if (state !== 'missing') {
        await manager.putAlias('token', state === 'zero address'
          ? new hre.ethers.Contract(hre.ethers.constants.AddressZero, source.interface, hre.ethers.provider)
          : source);
      }
      // Seed the source network so clone uses the real import wrapper without HTTP.
      await storeBuildFile(manager.cache, 'source-network', source.address, faucetTokenBuildFile);
      const importCalls: Array<[string, string | undefined]> = [];
      const originalImport = manager.import.bind(manager);
      manager.import = async (address, network) => {
        importCalls.push([address, network]);
        return originalImport(address, network);
      };
      const signer = await manager.getSigner();
      const originalSend = signer.sendTransaction;
      let submissions = 0;
      signer.sendTransaction = async transaction => {
        if (await transaction.to == null) submissions++;
        return originalSend.call(signer, transaction);
      };
      try {
        const args = [321, 'Cloned token', 8, 'CLONE'];
        const reused = state === 'existing';
        const result = await manager.clone('token', source.address, args, 'source-network', state === 'forced', 0);
        expect(importCalls).to.eql(reused ? [] : [[source.address, 'source-network']]);
        expect(submissions).to.equal(reused ? 0 : 1);
        expect(manager.counter).to.equal(reused ? 0 : 1);
        expect(await result.symbol()).to.equal(reused ? 'TEST' : 'CLONE');
        expect(await result.name()).to.equal(reused ? 'Test Token' : 'Cloned token');
        expect(await result.decimals()).to.equal(reused ? 6 : 8);
        expect((await result.totalSupply()).toNumber()).to.equal(reused ? tokenArgs[0] : 321);
        if (reused) expect(result.address).to.equal(source.address);
        else {
          expect(result.address).not.to.equal(source.address);
          expect(result.address).not.to.equal(hre.ethers.constants.AddressZero);
          expect(await getBuildFile(manager.cache, manager.network, result.address)).to.eql(faucetTokenBuildFile);
        }
        expect(manager.contractsCache.get('token')?.address).to.equal(result.address);
        expect((await getAliases(manager.cache)).get('token')).to.equal(result.address);
        expect(JSON.parse(await fs.readFile(manager.cache.getFilePath({ rel: 'aliases.json' }), 'utf8')))
          .to.eql({ token: result.address });
      } finally {
        signer.sendTransaction = originalSend;
      }
    });
  }
});
