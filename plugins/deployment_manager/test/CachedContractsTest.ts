import { expect } from 'chai';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import { Contract } from 'ethers';
import { DeploymentManager } from '../DeploymentManager';
import { storeAliases } from '../Aliases';
import { storeBuildFile } from '../ContractMap';
import { deployBuild } from '../Deploy';
import { faucetTokenBuildFile, tokenArgs } from './DeployHelpers';
import { tempDir } from './TestHelpers';

describe('DeploymentManager loading cached contracts', () => {
  let dir: string;
  let first: Contract;
  let second: Contract;

  before(async () => {
    first = await deployBuild(faucetTokenBuildFile, tokenArgs, hre, { network: 'test-network' });
    second = await deployBuild(faucetTokenBuildFile, [123, 'Second token', 8, 'SECOND'], hre, { network: 'test-network' });
  });
  beforeEach(async () => {
    dir = await fs.mkdtemp(tempDir());
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('handles an empty alias set without creating contracts', async () => {
    const manager = new DeploymentManager('test-network', 'test-deployment', hre, { baseDir: dir });
    await manager.loadContractsFromExistingCache();
    expect(manager.contractsCache).to.equal(null);
    expect(manager.counter).to.equal(0);
    expect(await fs.readdir(dir)).to.eql([]);
  });

  for (const state of ['valid', 'missing', 'malformed JSON', 'invalid build structure'] as const) {
    it(`loads valid contracts from disk when the other build file is ${state}`, async () => {
      const config = { baseDir: dir, writeCacheToDisk: true };
      const saved = new DeploymentManager('test-network', 'test-deployment', hre, config);
      // Put the problematic alias first to check that it does not prevent loading later entries.
      await storeAliases(saved.cache, new Map([['first', first.address], ['second', second.address]]));
      await storeBuildFile(saved.cache, saved.network, second.address, faucetTokenBuildFile);
      if (state === 'valid') {
        await storeBuildFile(saved.cache, saved.network, first.address, faucetTokenBuildFile);
      } else if (state !== 'missing') {
        const file = saved.cache.getFilePath({ top: [saved.network, '.contracts', `${first.address}.json`] });
        await fs.writeFile(file, state === 'malformed JSON' ? '{unfinished' : JSON.stringify({ contract: 'MissingContract', contracts: {} }));
      }

      const fresh = new DeploymentManager(saved.network, saved.deployment, hre, { ...config });
      const [signer] = await hre.ethers.getSigners();
      const nonceBefore = await hre.ethers.provider.getTransactionCount(signer.address);
      expect(fresh.cache.cache.size).to.equal(0);
      await fresh.loadContractsFromExistingCache();
      expect(fresh.contractsCache?.size).to.equal(state === 'valid' ? 2 : 1);
      const restoredSecond = fresh.contractsCache?.get('second');
      expect(restoredSecond?.address).to.equal(second.address);
      expect(await restoredSecond?.symbol()).to.equal('SECOND');
      expect(await restoredSecond?.decimals()).to.equal(8);
      if (state === 'valid') {
        const restoredFirst = fresh.contractsCache?.get('first');
        expect(restoredFirst?.address).to.equal(first.address);
        expect(await restoredFirst?.symbol()).to.equal('TEST');
      } else {
        // Characterize the current partial-recovery policy: skip the invalid entry and continue.
        expect(fresh.contractsCache?.has('first')).to.equal(false);
      }
      expect(await hre.ethers.provider.getTransactionCount(signer.address)).to.equal(nonceBefore);
      expect(fresh.counter).to.equal(0);
    });
  }
});
