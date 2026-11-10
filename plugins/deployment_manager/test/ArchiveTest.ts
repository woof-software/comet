import { expect } from 'chai';
import hre from 'hardhat';
import * as fs from 'fs/promises';
import fsPromises from 'fs/promises';
import * as path from 'path';
import { Contract } from 'ethers';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import * as importer from '../../import/import';
import { Cache } from '../Cache';
import { getArchivedBuildFile, getBuildFile, seedArchiveCache, storeBuildFile } from '../ContractMap';
import { DeploymentManager } from '../DeploymentManager';
import { deployBuild } from '../Deploy';
import { putRoots } from '../Roots';
import { faucetTokenBuildFile, tokenArgs } from './DeployHelpers';
import { tempDir } from './TestHelpers';

describe('Contract archive', () => {
  const network = 'archive-test-network';
  const address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const archiveRoot = path.join(process.cwd(), 'plugins/import/contracts-archive', network);
  const originalRead = fsPromises.readFile;
  const originalReaddir = fsPromises.readdir;
  let dir: string;
  let archiveDir: string;
  let cache: Cache;
  let reads: string[];
  let token: Contract;

  before(async () => {
    token = await deployBuild(faucetTokenBuildFile, tokenArgs, hre, { network });
  });
  beforeEach(async () => {
    dir = await fs.mkdtemp(tempDir());
    archiveDir = path.join(dir, 'archive');
    cache = new Cache(network, 'test-deployment', true, path.join(dir, 'cache'));
    reads = [];
    // Redirect only this test network's archive reads to real temporary files.
    // The repository's archive submodule is never written to.
    const redirected = (file: string) => file === archiveRoot || file.startsWith(`${archiveRoot}${path.sep}`)
      ? path.join(archiveDir, path.relative(archiveRoot, file)) : file;
    Object.assign(fsPromises, {
      readFile: async (...args: Parameters<typeof fs.readFile>) => {
        if (typeof args[0] === 'string') {
          reads.push(args[0]);
          args[0] = redirected(args[0]);
        }
        return originalRead(...args);
      },
      readdir: async (...args: Parameters<typeof fs.readdir>) => {
        if (typeof args[0] === 'string') args[0] = redirected(args[0]);
        return originalReaddir(...args);
      },
    });
  });
  afterEach(async () => {
    Object.assign(fsPromises, { readFile: originalRead, readdir: originalReaddir });
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function archiveFile(name: string, content: string) {
    await fs.mkdir(path.join(archiveDir, '.contracts'), { recursive: true });
    await fs.writeFile(path.join(archiveDir, '.contracts', name), content);
  }

  it('ignores an absent archive directory and returns undefined for a missing entry', async () => {
    await seedArchiveCache(cache, network);
    expect(cache.cache.size).to.equal(0);
    expect(await getArchivedBuildFile(network, address)).to.equal(undefined);
    await fs.mkdir(path.join(archiveDir, '.contracts'), { recursive: true });
    expect(await getArchivedBuildFile(network, address)).to.equal(undefined);
  });

  it('seeds valid JSON, skips malformed entries and unrelated extensions, and persists the valid build', async () => {
    const malformed = '0x2222222222222222222222222222222222222222';
    const ignored = '0x3333333333333333333333333333333333333333';
    await archiveFile(`${address}.json`, JSON.stringify(faucetTokenBuildFile));
    await archiveFile(`${malformed}.json`, '{unfinished');
    await archiveFile(`${ignored}.txt`, JSON.stringify(faucetTokenBuildFile));
    await seedArchiveCache(cache, network);
    expect(await getBuildFile(cache, network, address)).to.eql(faucetTokenBuildFile);
    expect(await getBuildFile(cache, network, malformed)).to.equal(undefined);
    expect(await getBuildFile(cache, network, ignored)).to.equal(undefined);
    expect(reads).not.to.include(path.join(archiveRoot, '.contracts', `${ignored}.txt`));
    const fresh = new Cache(network, 'another-deployment', false, cache.deploymentDir);
    expect(await getBuildFile(fresh, network, address)).to.eql(faucetTokenBuildFile);
  });

  it('returns undefined for malformed archive JSON and still reads an independent valid entry', async () => {
    const valid = '0x4444444444444444444444444444444444444444';
    await archiveFile(`${address}.json`, '{unfinished');
    await archiveFile(`${valid}.json`, JSON.stringify(faucetTokenBuildFile));
    expect(await getArchivedBuildFile(network, address)).to.equal(undefined);
    expect(await getArchivedBuildFile(network, valid)).to.eql(faucetTokenBuildFile);
  });

  it('normalizes mixed-case network and address inputs for direct reads and cache seeding', async () => {
    await archiveFile(`${address}.json`, JSON.stringify(faucetTokenBuildFile));
    const mixedNetwork = 'ArChIvE-TeSt-NeTwOrK';
    const mixedAddress = `0x${address.slice(2).toUpperCase()}`;
    expect(await getArchivedBuildFile(mixedNetwork, mixedAddress)).to.eql(faucetTokenBuildFile);
    await seedArchiveCache(cache, mixedNetwork);
    expect(await getBuildFile(cache, mixedNetwork, mixedAddress)).to.eql(faucetTokenBuildFile);
    expect(reads).to.include(path.join(archiveRoot, '.contracts', `${address}.json`));
  });

  it('preserves an existing disk-cached build file instead of replacing it with the archive version', async () => {
    const existing = { ...faucetTokenBuildFile, version: 'existing-cache-version' };
    await storeBuildFile(cache, network, address, existing);
    cache.clearMemory();
    await archiveFile(`${address}.json`, JSON.stringify(faucetTokenBuildFile));
    await seedArchiveCache(cache, network);
    expect(await getBuildFile(cache, network, address)).to.eql(existing);
    expect(reads).not.to.include(path.join(archiveRoot, '.contracts', `${address}.json`));
    const fresh = new Cache(network, 'other-deployment', false, cache.deploymentDir);
    expect(await getBuildFile(fresh, network, address)).to.eql(existing);
  });

  it('seeds the manager cache and discovers a real contract without an external import', async () => {
    await archiveFile(`${token.address.toLowerCase()}.json`, JSON.stringify(faucetTokenBuildFile));
    const manager = new DeploymentManager(network, 'test-deployment', hre, {
      baseDir: cache.deploymentDir, writeCacheToDisk: true,
    });
    await putRoots(manager.cache, new Map([['token', token.address]]));
    manager.cache.clearMemory();
    const originalImport = importer.loadContract;
    const previousDispatcher = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    let importCalls = 0;
    try {
      setGlobalDispatcher(agent);
      // Fail before importer retries or HTTP if discovery cannot use the seeded build file.
      Object.assign(importer, {
        loadContract: async () => {
          importCalls++;
          throw new Error('Contract source code not verified: external imports must not be needed');
        },
      });
      const discovered = await manager.spider();
      expect(importCalls).to.equal(0);
      expect(discovered.aliases.get('token')).to.equal(token.address);
      expect(await discovered.contracts.get('token')?.symbol()).to.equal('TEST');
      expect(await getBuildFile(manager.cache, network, token.address)).to.eql(faucetTokenBuildFile);
      expect(manager.counter).to.equal(0);
    } finally {
      Object.assign(importer, { loadContract: originalImport });
      setGlobalDispatcher(previousDispatcher);
      await agent.close();
    }
  });
});
