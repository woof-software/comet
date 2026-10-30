import { expect } from 'chai';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import * as verification from '../Verify';
import { Cache } from '../Cache';
import { deploy, deployBuild } from '../Deploy';
import { DeploymentManager } from '../DeploymentManager';
import { getVerifyArgs } from '../VerifyArgs';
import { faucetTokenBuildFile, tokenArgs } from './DeployHelpers';
import { tempDir } from './TestHelpers';

describe('Deployment verification strategies', () => {
  for (const via of ['artifacts', 'buildfile'] as const) {
    for (const strategy of ['none', 'eager', 'lazy'] as const) {
      it(`applies ${strategy} verification when deploying via ${via}`, async () => {
        const dir = await fs.mkdtemp(tempDir());
        const originalVerify = verification.verifyContract;
        const verified: verification.VerifyArgs[] = [];
        // Observe the deployment's strategy choice without contacting an explorer.
        Object.assign(verification, {
          verifyContract: async (args: verification.VerifyArgs) => {
            verified.push(args);
            return true;
          },
        });
        try {
          const cache = new Cache('test-network', 'test-deployment', true, dir);
          const opts = { cache, network: cache.network, verificationStrategy: strategy };
          const contract = via === 'artifacts'
            ? await deploy('test/FaucetToken.sol', tokenArgs, hre, opts)
            : await deployBuild(faucetTokenBuildFile, tokenArgs, hre, opts);
          const queued = await getVerifyArgs(cache);

          expect(verified.length).to.equal(strategy === 'eager' ? 1 : 0);
          expect(queued.size).to.equal(strategy === 'lazy' ? 1 : 0);
          if (strategy !== 'none') {
            const args = strategy === 'eager' ? verified[0] : queued.get(contract.address);
            expect(args?.via).to.equal(via);
            if (args?.via === 'artifacts') {
              expect(args.address).to.equal(contract.address);
              expect(args.constructorArguments).to.eql(tokenArgs);
              expect(args.contract).to.equal('contracts/test/FaucetToken.sol:FaucetToken');
            } else if (args?.via === 'buildfile') {
              expect(args.contract).to.equal(contract);
              expect(args.buildFile).to.eql(faucetTokenBuildFile);
              expect(args.deployArgs).to.eql(tokenArgs);
            }
          }
          // Confirm lazy arguments really reached disk; other strategies leave no queue file.
          const queueFile = cache.getFilePath({ rel: ['verify', 'args.json'] });
          if (strategy === 'lazy') {
            const saved = JSON.parse(await fs.readFile(queueFile, 'utf8'));
            expect(Object.keys(saved)).to.eql([contract.address]);
            expect(saved[contract.address].via).to.equal(via);
          } else {
            expect(await fs.stat(queueFile).then(() => true, () => false)).to.equal(false);
          }
        } finally {
          Object.assign(verification, { verifyContract: originalVerify });
          await fs.rm(dir, { recursive: true, force: true });
        }
      });
    }
  }

  for (const via of ['artifacts', 'buildfile'] as const) {
    it(`processes a saved lazy queue via ${via} in a fresh manager`, async () => {
      const dir = await fs.mkdtemp(tempDir());
      const previousDispatcher = getGlobalDispatcher();
      const agent = new MockAgent();
      agent.disableNetConnect();
      setGlobalDispatcher(agent);
      try {
        let artifactCalls = 0;
        const submitted: URLSearchParams[] = [];
        const pool = agent.get('https://verification.test');
        // Exercise real build-file verification, mocking only the explorer HTTP responses.
        pool.intercept({ path: '/api', method: 'POST' }).reply(200, (options) => {
          submitted.push(new URLSearchParams(String(options.body)));
          return { status: '1', message: 'OK', result: 'saved-queue-guid' };
        });
        pool.intercept({
          path: '/api', method: 'GET',
          query: { apikey: 'TEST_KEY', module: 'contract', action: 'checkverifystatus', guid: 'saved-queue-guid' },
        }).reply(200, { status: '1', message: 'OK', result: 'Pass - Verified' });
        const runtime: HardhatRuntimeEnvironment = {
          ...hre,
          config: { ...hre.config, etherscan: { ...hre.config.etherscan, apiKey: 'TEST_KEY' } },
          run: (async (task, args) => {
            if (task === 'verify:get-etherscan-endpoint') {
              return { network: 'test-network', urls: { apiURL: 'https://verification.test/api' } };
            }
            expect(task).to.equal('verify:verify');
            artifactCalls++;
            expect(args).to.eql({
              address: contract.address, constructorArguments: tokenArgs,
              contract: 'contracts/test/FaucetToken.sol:FaucetToken',
            });
          }) as HardhatRuntimeEnvironment['run'],
        };
        const config = { baseDir: dir, writeCacheToDisk: true, verificationStrategy: 'lazy' as const };
        const original = new DeploymentManager('test-network', 'test-deployment', runtime, config);
        const contract = via === 'artifacts'
          ? await original.deploy('token', 'test/FaucetToken.sol', tokenArgs)
          : await original._deployBuild(faucetTokenBuildFile, tokenArgs);
        expect(artifactCalls).to.equal(0);
        expect(submitted).to.have.length(0);

        // The new instance must deserialize the queue instead of reusing Contract objects in memory.
        const fresh = new DeploymentManager('test-network', 'test-deployment', runtime, { ...config });
        expect(fresh.cache.cache.size).to.equal(0);
        const restored = (await getVerifyArgs(fresh.cache)).get(contract.address);
        expect(restored?.via).to.equal(via);
        if (restored?.via === 'buildfile') {
          expect(restored.contract).not.to.equal(contract);
          expect(restored.contract.address).to.equal(contract.address);
          expect(restored.buildFile).to.eql(faucetTokenBuildFile);
          expect(restored.deployArgs).to.eql(tokenArgs);
        }
        await fresh.verifyContracts();
        expect(artifactCalls).to.equal(via === 'artifacts' ? 1 : 0);
        expect(submitted).to.have.length(via === 'buildfile' ? 1 : 0);
        if (via === 'buildfile') {
          expect(submitted[0].get('contractaddress')).to.equal(contract.address.toLowerCase());
          expect(submitted[0].get('contractname')).to.equal('contracts/FaucetToken.sol:FaucetToken');
          expect(submitted[0].get('constructorArguements')).to.equal(contract.interface.encodeDeploy(tokenArgs).slice(2));
          const source = JSON.parse(submitted[0].get('sourceCode')!);
          expect(source.language).to.equal('Solidity');
          expect(source.sources).to.be.an('object');
          agent.assertNoPendingInterceptors();
        }
        expect((await getVerifyArgs(fresh.cache)).size).to.equal(0);
        const queueFile = fresh.cache.getFilePath({ rel: ['verify', 'args.json'] });
        expect(JSON.parse(await fs.readFile(queueFile, 'utf8'))).to.eql({});
        await fresh.verifyContracts();
        expect(artifactCalls).to.equal(via === 'artifacts' ? 1 : 0);
        expect(submitted).to.have.length(via === 'buildfile' ? 1 : 0);
      } finally {
        setGlobalDispatcher(previousDispatcher);
        await agent.close();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
});
