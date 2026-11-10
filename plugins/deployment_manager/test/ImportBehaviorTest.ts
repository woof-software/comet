import { expect } from 'chai';
import { strict as assert } from 'assert';
import { AsyncLocalStorage } from 'async_hooks';
import * as loader from '../../import/import';
import { importContract } from '../Import';
import { faucetTokenBuildFile } from './DeployHelpers';

describe('Import routing and retries', () => {
  const address = '0x1111111111111111111111111111111111111111';
  const originalLoad = loader.loadContract;
  const originalSetTimeout = global.setTimeout;
  const importScope = new AsyncLocalStorage<boolean>();
  const runImport = (...args: Parameters<typeof importContract>) =>
    importScope.run(true, () => importContract(...args));
  let calls: Array<[string, string, string]>;
  let delays: number[];
  let outcome: () => Promise<typeof faucetTokenBuildFile>;

  beforeEach(() => {
    calls = [];
    delays = [];
    // Keep the import/retry code real; replace the external loader and retry waits.
    Object.assign(loader, {
      loadContract: async (source: string, network: string, target: string) => {
        calls.push([source, network, target]);
        return outcome();
      },
    });
    global.setTimeout = ((callback: () => void, delay?: number) => {
      // Ignore unrelated background timers from Hardhat and HTTP clients.
      if (!importScope.getStore()) return originalSetTimeout(callback, delay);
      delays.push(delay ?? 0);
      return originalSetTimeout(callback, 0);
    }) as typeof setTimeout;
  });
  afterEach(() => {
    Object.assign(loader, { loadContract: originalLoad });
    global.setTimeout = originalSetTimeout;
  });

  for (const network of ['mainnet', 'unichain', 'scroll', 'optimism', 'base', 'arbitrum', 'ronin', 'sepolia']) {
    it(`selects the intended importer for ${network}`, async () => {
      outcome = async () => faucetTokenBuildFile;
      expect(await runImport(network, address, 0)).to.equal(faucetTokenBuildFile);
      expect(calls).to.eql([[network === 'sepolia' ? 'etherscan' : 'blockscout', network, address]]);
      expect(delays).to.eql([]);
    });
  }

  for (const network of ['mainnet', 'sepolia']) {
    it(`retries transient ${network} import errors and stops after success`, async () => {
      const failure = new Error('Explorer temporarily unavailable');
      outcome = async () => {
        if (calls.length <= 2) throw failure;
        return faucetTokenBuildFile;
      };
      expect(await runImport(network, address, 4, 4000)).to.equal(faucetTokenBuildFile);
      expect(calls).to.have.length(3);
      expect(delays).to.eql([4000, 8000]);
    });

    it(`exhausts ${network} import retries with capped delays and preserves the final error`, async () => {
      const failure = new Error('Explorer unavailable');
      outcome = async () => { throw failure; };
      await assert.rejects(runImport(network, address, 3, 6000), error => error === failure);
      expect(calls).to.have.length(4);
      expect(delays).to.eql([6000, 10000, 10000]);
    });

    it(`does not retry an unverified source response from ${network}`, async () => {
      const failure = new Error('Contract source code not verified');
      outcome = async () => { throw failure; };
      await assert.rejects(runImport(network, address, 3, 1000), error => error === failure);
      expect(calls).to.have.length(1);
      expect(delays).to.eql([]);
    });
  }
});
