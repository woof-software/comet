import { expect } from 'chai';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import * as path from 'path';

import { tempDir } from './TestHelpers';
import { Cache } from '../Cache';
import { getBuildFile, storeBuildFile } from '../ContractMap';
import { deploy, deployBuild } from '../Deploy';
import { BuildFile } from '../Types';
import { faucetTokenBuildFile, tokenArgs } from './DeployHelpers';

describe('ContractMap', () => {
  describe('storeBuildFile/getBuildFile', () => {
    for (const via of ['artifacts', 'buildfile'] as const) {
      it(`preserves the complete ${via} build file in memory and for a fresh disk reader`, async () => {
        const dir = await fs.mkdtemp(tempDir());
        try {
          let expected: BuildFile;
          if (via === 'artifacts') {
            // Read compiler output independently, rather than using the cache as its own oracle.
            const debugFile = path.join(process.cwd(), 'artifacts/contracts/test/FaucetToken.sol/FaucetToken.dbg.json');
            const debug = JSON.parse(await fs.readFile(debugFile, 'utf8'));
            const buildInfo = JSON.parse(await fs.readFile(path.resolve(path.dirname(debugFile), debug.buildInfo), 'utf8'));
            expected = { ...buildInfo.output, contract: 'FaucetToken' };
          } else {
            expected = faucetTokenBuildFile;
          }
          const cache = new Cache('test-network', 'test-deployment', true, dir);
          const opts = { cache, network: cache.network, verificationStrategy: 'none' as const };
          const contract = via === 'artifacts'
            ? await deploy('test/FaucetToken.sol', tokenArgs, hre, opts)
            : await deployBuild(faucetTokenBuildFile, tokenArgs, hre, opts);

          expect(await getBuildFile(cache, cache.network, contract.address)).to.eql(expected);
          const file = path.join(dir, cache.network, '.contracts', `${contract.address.toLowerCase()}.json`);
          expect(JSON.parse(await fs.readFile(file, 'utf8'))).to.eql(expected);
          // A new reader starts with no shared memory and must load the persisted build file.
          const fresh = new Cache(cache.network, 'another-deployment', false, dir);
          expect(fresh.cache.size).to.equal(0);
          expect(await getBuildFile(fresh, cache.network, contract.address)).to.eql(expected);
          expect(await getBuildFile(fresh, 'other-network', contract.address)).to.equal(undefined);
          expect(await fs.readdir(path.join(dir, cache.network))).to.eql(['.contracts']);
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      });
    }

    it('gets what it stores', async () => {
      const cache = new Cache('test-network', 'test-deployment', false, tempDir());
      const address = '0x0000000000000000000000000000000000000000';
      await storeBuildFile(cache, 'test-network', address, faucetTokenBuildFile);
      const buildFile = await getBuildFile(cache, 'test-network', address);
      const noBuildFile = await getBuildFile(cache, 'no-test-network', address);
      expect(buildFile).to.eql(faucetTokenBuildFile);
      expect(noBuildFile).to.eql(undefined);
    });

    it('stores deploys in the right place', async () => {
      const cache = new Cache('test-network', 'test-deployment', false, tempDir());
      await deploy('test/FaucetToken.sol', tokenArgs, hre, { cache, network: 'test-network' });
      const contracts = cache.cache.get('test-network').get('.contracts');
      const noContracts = cache.cache.get('no-test-network');
      expect(contracts.size).to.eql(1);
      expect(noContracts).to.eql(undefined);
    });
  });
});
