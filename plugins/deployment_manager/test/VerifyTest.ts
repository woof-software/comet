import hre from 'hardhat';
import { expect } from 'chai';
import { strict as assert } from 'assert';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import * as fs from 'fs';
import * as path from 'path';
import { verifyContract } from '../Verify';
import { deployBuild } from '../Deploy';
import { buildToken, faucetTokenBuildFile, tokenArgs } from './DeployHelpers';
import { MockAgent, setGlobalDispatcher } from 'undici';

export function mockVerifySuccess(hre: HardhatRuntimeEnvironment) {
  // We use undici's intercepter to mock the HTTP requests because the Hardhat Etherscan plugin now uses
  // undici instead of node-fetch
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  let solcList = JSON.parse(fs.readFileSync(path.join(__dirname, './SolcList.json'), 'utf8'));

  // Note: we need to convince the prober task that this is goerli, which it's not.
  // So we'll fake the network name and the chain ID
  hre.config.etherscan.apiKey = {
    goerli: 'GOERLI_KEY',
  };
  hre.network.name = 'goerli';
  let sendOld = hre.network.provider.send.bind(hre.network.provider);
  hre.network.provider.send = function (...args) {
    if (args.length === 1 && args[0] === 'eth_chainId') {
      return Promise.resolve(5);
    } else {
      return sendOld(...args);
    }
  };

  const solcMockPool = mockAgent.get('https://solc-bin.ethereum.org');
  const etherscanMockPool = mockAgent.get('https://api-goerli.etherscan.io');

  solcMockPool.intercept({
    path: '/bin/list.json',
    method: 'GET'
  }).reply(200, solcList);

  etherscanMockPool.intercept({
    path: '/api',
    method: 'POST',
    body: /action=verifysourcecode/
  }).reply(200, {
    status: 1,
    message: 'OK',
    result: 'MYGUID',
  });

  etherscanMockPool.intercept({
    path: '/api',
    method: 'GET',
    query: {
      apikey: 'GOERLI_KEY',
      module: 'contract',
      action: 'checkverifystatus',
      guid: 'MYGUID',
    }
  }).reply(200, {
    status: 1,
    message: 'OK',
    result: 'Pass - Verified',
  });

  // Hardhat Etherscan now checks to see if a contract is already verified before verifying it
  etherscanMockPool.intercept({
    path: /api\?action=getsourcecode.*/,
    method: 'GET',
  }).reply(200, {
    status: 1,
    message: 'OK',
    result: 'Source code not found',
  });
}

describe('Verify', () => {
  describe('responses and retry limits', () => {
    const args = {
      via: 'artifacts' as const,
      address: '0x1111111111111111111111111111111111111111',
      constructorArguments: tokenArgs,
      contract: 'contracts/test/FaucetToken.sol:FaucetToken',
    };
    let runtime: HardhatRuntimeEnvironment;
    let attempts: number;
    let outcome: () => Promise<void>;

    beforeEach(() => {
      attempts = 0;
      // Keep the real shared HRE unchanged, replace only the verification task.
      runtime = {
        ...hre,
        run: (async (task, taskArgs) => {
          expect(task).to.equal('verify:verify');
          expect(taskArgs).to.eql({
            address: args.address,
            constructorArguments: args.constructorArguments,
            contract: args.contract,
          });
          attempts++;
          await outcome();
        }) as HardhatRuntimeEnvironment['run'],
      };
    });

    it('treats Already Verified as success even when raise is enabled', async () => {
      outcome = async () => { throw new Error('Contract is already VERIFIED'); };

      expect(await verifyContract(args, runtime, true)).to.equal(true);
      expect(attempts).to.equal(1);
    });

    for (const raise of [false, true]) {
      it(`handles a general verification error with raise=${raise} without retrying`, async () => {
        const failure = new Error('Explorer unavailable');
        outcome = async () => { throw failure; };

        if (raise) {
          // The original error must reach the caller unchanged.
          await assert.rejects(verifyContract(args, runtime, raise), (error) => error === failure);
        } else {
          expect(await verifyContract(args, runtime, raise)).to.equal(false);
        }
        expect(attempts).to.equal(1);
      });
    }

    describe('bytecode propagation retries', () => {
      let originalSetTimeout: typeof setTimeout;
      let delays: Array<number | undefined>;

      beforeEach(() => {
        originalSetTimeout = global.setTimeout;
        delays = [];
        // Record requested retry delays but run timers immediately.
        global.setTimeout = ((callback: () => void, delay?: number) => {
          delays.push(delay);
          return originalSetTimeout(callback, 0);
        }) as typeof setTimeout;
      });

      afterEach(() => {
        global.setTimeout = originalSetTimeout;
      });

      it('retries missing bytecode and stops as soon as verification succeeds', async () => {
        outcome = async () => {
          if (attempts <= 2) throw new Error('Contract does not have bytecode');
        };

        expect(await verifyContract(args, runtime, true, 3)).to.equal(true);
        expect(attempts).to.equal(3);
        expect(delays).to.eql([5000, 5000]);
      });

      for (const raise of [false, true]) {
        it(`stops after exhausting bytecode retries with raise=${raise}`, async () => {
          const failure = new Error('Contract does not have bytecode');
          outcome = async () => { throw failure; };

          if (raise) {
            await assert.rejects(verifyContract(args, runtime, raise, 2), (error) => error === failure);
          } else {
            expect(await verifyContract(args, runtime, raise, 2)).to.equal(false);
          }
          // Two retries mean three attempts, with no delay after the last failure.
          expect(attempts).to.equal(3);
          expect(delays).to.eql([5000, 5000]);
        });
      }

      it('does not wait or retry when the bytecode retry limit is zero', async () => {
        const failure = new Error('Contract does not have bytecode');
        outcome = async () => { throw failure; };

        await assert.rejects(verifyContract(args, runtime, true, 0), (error) => error === failure);
        expect(attempts).to.equal(1);
        expect(delays).to.eql([]);
      });
    });
  });

  describe('via artifacts', () => {
    it('verify from artifacts [success]', async () => {
      mockVerifySuccess(hre);
      let token = await buildToken();
      await verifyContract(
        { via: 'artifacts', address: token.address, constructorArguments: tokenArgs },
        hre,
        true
      );
    });
  });

  describe('via buildfile', () => {
    it('verify from build file', async () => {
      mockVerifySuccess(hre);
      let contract = await deployBuild(faucetTokenBuildFile, tokenArgs, hre, { network: 'test-network' });
      await verifyContract(
        { via: 'buildfile', contract, buildFile: faucetTokenBuildFile, deployArgs: tokenArgs },
        hre,
        true
      );
    });
  });
});
