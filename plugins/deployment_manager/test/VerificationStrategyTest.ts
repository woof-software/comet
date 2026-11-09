import { expect } from 'chai';
import { strict as assert } from 'assert';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import { readFileSync } from 'fs';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import * as verification from '../Verify';
import { Cache } from '../Cache';
import { deploy, deployBuild } from '../Deploy';
import { DeploymentManager } from '../DeploymentManager';
import { getVerifyArgs } from '../VerifyArgs';
import { tokenArgs } from './DeployHelpers';
import { BuildFile } from '../Types';
import { recordTimers, tempDir } from './TestHelpers';

describe('Deployment verification strategies', () => {
  const artifactName = 'contracts/test/FaucetToken.sol:FaucetToken';
  let buildFile: BuildFile;
  let expectedSource: { language: string, sources: unknown, settings: Record<string, unknown> };
  let compilerVersion: string;

  before(async () => {
    const artifact = await hre.artifacts.readArtifact(artifactName);
    const build = await hre.artifacts.getBuildInfo(artifactName);
    assert.ok(build, 'Local compiler build info must exist for the verification fixture');
    const output = build.output.contracts[artifact.sourceName][artifact.contractName];
    const metadataText = (output as typeof output & { metadata?: string }).metadata;
    assert.ok(metadataText, 'Local compiler output must include metadata');
    const metadata = JSON.parse(metadataText);
    // Compiler metadata can contain source hashes only; verification needs the actual source text.
    metadata.sources = build.input.sources;
    compilerVersion = metadata.compiler.version;
    buildFile = {
      contract: artifact.contractName,
      contracts: {
        [artifactName]: {
          address: '', name: artifact.contractName, abi: artifact.abi, bin: artifact.bytecode,
          metadata: JSON.stringify(metadata), source: artifact.sourceName, constructorArgs: '',
        },
      },
      version: build.solcLongVersion,
    };
    const settings = { ...metadata.settings };
    delete settings.compilationTarget;
    expectedSource = { language: build.input.language, sources: build.input.sources, settings };
  });

  function assertBuildRequest(request: URLSearchParams) {
    expect(request.get('contractname')).to.equal(artifactName);
    expect(request.get('compilerversion')).to.equal(compilerVersion);
    const source = JSON.parse(request.get('sourceCode')!);
    expect(source).to.eql(expectedSource);
    expect(source.sources).to.have.property('contracts/test/FaucetToken.sol');
    expect(source.sources['contracts/test/FaucetToken.sol'].content).to.be.a('string').and.not.empty;
  }

  for (const via of ['artifacts', 'buildfile'] as const) {
    for (const strategy of ['none', 'eager', 'lazy'] as const) {
      const name = {
        none: `does not verify or queue verification when deploying via ${via} with strategy none`,
        eager: `verifies immediately without queuing when deploying via ${via} with strategy eager`,
        lazy: `queues verification without verifying immediately when deploying via ${via} with strategy lazy`,
      }[strategy];
      it(name, async () => {
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
            : await deployBuild(buildFile, tokenArgs, hre, opts);
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
              expect(args.buildFile).to.eql(buildFile);
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
          const request = new URLSearchParams(String(options.body));
          assertBuildRequest(request);
          submitted.push(request);
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
          : await original._deployBuild(buildFile, tokenArgs);
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
          expect(restored.buildFile).to.eql(buildFile);
          expect(restored.deployArgs).to.eql(tokenArgs);
        }
        await fresh.verifyContracts();
        expect(artifactCalls).to.equal(via === 'artifacts' ? 1 : 0);
        expect(submitted).to.have.length(via === 'buildfile' ? 1 : 0);
        if (via === 'buildfile') {
          expect(submitted[0].get('contractaddress')).to.equal(contract.address.toLowerCase());
          assertBuildRequest(submitted[0]);
          expect(submitted[0].get('constructorArguements')).to.equal(contract.interface.encodeDeploy(tokenArgs).slice(2));
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

  it('keeps a saved buildfile verification entry when metadata JSON is invalid without contacting the explorer', async () => {
    const dir = await fs.mkdtemp(tempDir());
    const previousDispatcher = getGlobalDispatcher();
    const originalError = console.error;
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      let explorerRequests = 0;
      const pool = agent.get('https://verification.test');
      // Count attempted requests too: a blocked network call must not look like a local rejection.
      pool.intercept({ path: '/api', method: 'POST' }).reply(200, () => {
        explorerRequests++;
        return { status: '1', message: 'OK', result: 'unexpected-request' };
      });
      pool.intercept({
        path: '/api', method: 'GET',
        query: { apikey: 'TEST_KEY', module: 'contract', action: 'checkverifystatus', guid: 'unexpected-request' },
      }).reply(200, () => {
        explorerRequests++;
        return { status: '1', message: 'OK', result: 'Pass - Verified' };
      });
      const runtime: HardhatRuntimeEnvironment = {
        ...hre,
        config: { ...hre.config, etherscan: { ...hre.config.etherscan, apiKey: 'TEST_KEY' } },
        run: (async task => {
          expect(task).to.equal('verify:get-etherscan-endpoint');
          return { network: 'test-network', urls: { apiURL: 'https://verification.test/api' } };
        }) as HardhatRuntimeEnvironment['run'],
      };
      const config = { baseDir: dir, writeCacheToDisk: true, verificationStrategy: 'lazy' as const };
      const original = new DeploymentManager('test-network', 'test-deployment', runtime, config);
      const contract = await original._deployBuild(buildFile, tokenArgs);
      const queueFile = original.cache.getFilePath({ rel: ['verify', 'args.json'] });
      const saved = JSON.parse(await fs.readFile(queueFile, 'utf8'));

      // Corrupt only metadata inside the persisted entry; the queue itself remains valid JSON.
      saved[contract.address].buildFile.contracts[artifactName].metadata = '{"compiler":';
      const damagedQueue = JSON.stringify(saved);
      await fs.writeFile(queueFile, damagedQueue);

      const fresh = new DeploymentManager('test-network', 'test-deployment', runtime, { ...config });
      expect(fresh.cache.cache.size).to.equal(0);
      await fresh.verifyContracts();

      // The manager uses raise=false: parsing failure is logged and the entry stays queued.
      expect(errors).to.have.length(2);
      expect(errors[0][0]).to.be.a('string').and.include(`Unable to verify contract at ${contract.address}: SyntaxError:`);
      expect(errors[1]).to.eql(['Continuing on anyway...']);
      expect(explorerRequests).to.equal(0);
      expect(Object.fromEntries(await getVerifyArgs(fresh.cache))).to.eql(saved);
      expect(await fs.readFile(queueFile, 'utf8')).to.equal(damagedQueue);
    } finally {
      console.error = originalError;
      setGlobalDispatcher(previousDispatcher);
      await agent.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  describe('saved buildfile queue and explorer responses', () => {
    let dir: string;
    let agent: MockAgent;
    let previousDispatcher: ReturnType<typeof getGlobalDispatcher>;
    let timers: ReturnType<typeof recordTimers>;
    let runtime: HardhatRuntimeEnvironment;
    let original: DeploymentManager;
    let address: string;
    let queueFile: string;
    let savedQueue: string;
    let errors: unknown[][];
    const originalError = console.error;
    const config = () => ({ baseDir: dir, writeCacheToDisk: true, verificationStrategy: 'lazy' as const });

    beforeEach(async () => {
      dir = await fs.mkdtemp(tempDir());
      previousDispatcher = getGlobalDispatcher();
      agent = new MockAgent();
      agent.disableNetConnect();
      setGlobalDispatcher(agent);
      timers = recordTimers({ immediate: true });
      errors = [];
      console.error = (...args: unknown[]) => { errors.push(args); };
      runtime = {
        ...hre,
        config: { ...hre.config, etherscan: { ...hre.config.etherscan, apiKey: 'TEST_KEY' } },
        run: (async task => {
          expect(task).to.equal('verify:get-etherscan-endpoint');
          return { network: 'test-network', urls: { apiURL: 'https://verification.test/api' } };
        }) as HardhatRuntimeEnvironment['run'],
      };
      original = new DeploymentManager('test-network', 'test-deployment', runtime, config());
      address = (await original._deployBuild(buildFile, tokenArgs)).address;
      queueFile = original.cache.getFilePath({ rel: ['verify', 'args.json'] });
      savedQueue = await fs.readFile(queueFile, 'utf8');
    });

    afterEach(async () => {
      console.error = originalError;
      timers.restore();
      setGlobalDispatcher(previousDispatcher);
      await agent.close();
      await fs.rm(dir, { recursive: true, force: true });
    });

    function submission(result = 'response-guid', status = '1') {
      agent.get('https://verification.test').intercept({ path: '/api', method: 'POST' })
        .reply(200, options => {
          const request = new URLSearchParams(String(options.body));
          assertBuildRequest(request);
          expect(request.get('contractaddress')).to.equal(address.toLowerCase());
          return { status, message: status === '1' ? 'OK' : 'NOTOK', result };
        });
    }

    function poll(result: string, status = '1') {
      agent.get('https://verification.test').intercept({
        path: '/api', method: 'GET',
        query: { apikey: 'TEST_KEY', module: 'contract', action: 'checkverifystatus', guid: 'response-guid' },
      }).reply(200, { status, message: status === '1' ? 'OK' : 'NOTOK', result });
    }

    for (const response of ['rejected submission', 'failed verification', 'unexpected status'] as const) {
      it(`retains the saved queue after ${response} and clears it only after a successful retry`, async () => {
        const reason = response === 'rejected submission' ? 'Rejected verification request'
          : response === 'failed verification' ? 'Fail - Unable to verify' : 'Unexpected verification status';
        submission(response === 'rejected submission' ? reason : 'response-guid',
          response === 'rejected submission' ? '0' : '1');
        if (response !== 'rejected submission') poll(reason, response === 'failed verification' ? '0' : '1');

        const fresh = new DeploymentManager(original.network, original.deployment, runtime, config());
        expect(fresh.cache.cache.size).to.equal(0);
        await timers.run(() => fresh.verifyContracts());
        agent.assertNoPendingInterceptors();
        expect(errors).to.have.length(2);
        expect(String(errors[0][0])).to.include(reason);
        expect(errors[1]).to.eql(['Continuing on anyway...']);
        expect(await fs.readFile(queueFile, 'utf8')).to.equal(savedQueue);
        expect(Object.fromEntries(await getVerifyArgs(fresh.cache))).to.eql(JSON.parse(savedQueue));

        // Retry in another fresh manager to prove recovery uses the persisted entry.
        submission();
        poll('Pass - Verified');
        const retrying = new DeploymentManager(original.network, original.deployment, runtime, config());
        await timers.run(() => retrying.verifyContracts());
        agent.assertNoPendingInterceptors();
        expect(errors).to.have.length(2);
        expect((await getVerifyArgs(retrying.cache)).size).to.equal(0);
        expect(JSON.parse(await fs.readFile(queueFile, 'utf8'))).to.eql({});
      });
    }

    it('keeps the entry on disk while pending and removes it after the explorer reports success', async () => {
      submission();
      const reads: string[] = [];
      const pool = agent.get('https://verification.test');
      for (const result of ['Pending in queue', 'Pass - Verified']) {
        pool.intercept({
          path: '/api', method: 'GET',
          query: { apikey: 'TEST_KEY', module: 'contract', action: 'checkverifystatus', guid: 'response-guid' },
        }).reply(200, () => {
          // The real queue file must survive both polling requests until success returns.
          reads.push(readFileSync(queueFile, 'utf8'));
          return { status: result === 'Pending in queue' ? '0' : '1', message: 'OK', result };
        });
      }
      const fresh = new DeploymentManager(original.network, original.deployment, runtime, config());
      await timers.run(() => fresh.verifyContracts());
      agent.assertNoPendingInterceptors();
      expect(reads).to.eql([savedQueue, savedQueue]);
      expect(errors).to.eql([]);
      expect((await getVerifyArgs(fresh.cache)).size).to.equal(0);
      expect(JSON.parse(await fs.readFile(queueFile, 'utf8'))).to.eql({});
      // A cleared entry must not trigger any further HTTP request.
      await timers.run(() => fresh.verifyContracts());
      expect(errors).to.eql([]);
    });
  });
});
