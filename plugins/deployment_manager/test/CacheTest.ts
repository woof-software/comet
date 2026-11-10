import { expect } from 'chai';
import * as fs from 'fs/promises';
import { tempDir } from './TestHelpers';
import { Cache } from '../Cache';
import { objectFromMap } from '../Utils';
import { getBuildFile, storeBuildFile } from '../ContractMap';
import { faucetTokenBuildFile } from './DeployHelpers';

describe('Cache', () => {
  describe('file availability and cache settings', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await fs.mkdtemp(tempDir());
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('returns undefined for a missing file and an empty map for a missing map file', async () => {
      const cache = new Cache('test-network', 'test-deployment', false, dir);
      expect(await cache.readCache({ rel: 'missing.json' })).to.equal(undefined);
      expect((await cache.readMap({ rel: 'missing-map.json' })).size).to.equal(0);
      expect(await fs.readdir(dir)).to.eql([]);
    });

    it('ignores malformed JSON without changing the file and reads a later valid replacement', async () => {
      const cache = new Cache('test-network', 'test-deployment', false, dir);
      const spec = { rel: 'broken.json' };
      const file = cache.getFilePath(spec);
      await fs.mkdir(`${dir}/test-network/test-deployment`, { recursive: true });
      await fs.writeFile(file, '{unfinished');
      expect(await cache.readCache(spec)).to.equal(undefined);
      expect((await cache.readMap(spec)).size).to.equal(0);
      expect(await fs.readFile(file, 'utf8')).to.equal('{unfinished');

      await fs.writeFile(file, JSON.stringify({ recovered: true }));
      expect(await cache.readCache(spec)).to.eql({ recovered: true });
    });

    it('applies disk-write flag changes to subsequent stores without flushing memory automatically', async () => {
      const cache = new Cache('test-network', 'test-deployment', false, dir);
      const spec = { rel: 'settings.json' };
      await cache.storeCache(spec, { version: 1 });
      expect(await cache.readCache(spec)).to.eql({ version: 1 });
      expect(await fs.readdir(dir)).to.eql([]);

      cache.writeCacheToDisk = true;
      expect(await fs.readdir(dir)).to.eql([]);
      await cache.storeCache(spec, { version: 2 });
      const file = cache.getFilePath(spec);
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).to.eql({ version: 2 });

      cache.writeCacheToDisk = false;
      await cache.storeCache(spec, { version: 3 });
      await cache.storeCache({ rel: 'memory-only.json' }, { saved: false });
      expect(await cache.readCache(spec)).to.eql({ version: 3 });
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).to.eql({ version: 2 });
      expect(await fs.readdir(`${dir}/test-network/test-deployment`)).to.eql(['settings.json']);
      cache.clearMemory();
      expect(await cache.readCache(spec)).to.eql({ version: 2 });
      expect(await cache.readCache({ rel: 'memory-only.json' })).to.equal(undefined);
    });

    it('isolates deployment data while sharing build files only within the same network', async () => {
      const first = new Cache('network-a', 'market-a', true, dir);
      const second = first.asDeployment('network-a', 'market-b');
      const otherNetwork = first.asDeployment('network-b', 'market-a');
      const spec = { rel: 'state.json' };
      const address = '0x1111111111111111111111111111111111111111';
      await first.storeCache(spec, { market: 'first' });
      await second.storeCache(spec, { market: 'second' });
      await otherNetwork.storeCache(spec, { market: 'other-network' });
      await storeBuildFile(first, first.network, address, faucetTokenBuildFile);

      expect(await first.readCache(spec)).to.eql({ market: 'first' });
      expect(await second.readCache(spec)).to.eql({ market: 'second' });
      expect(await otherNetwork.readCache(spec)).to.eql({ market: 'other-network' });
      expect(await getBuildFile(second, second.network, address)).to.eql(faucetTokenBuildFile);
      expect(await getBuildFile(otherNetwork, otherNetwork.network, address)).to.equal(undefined);
      // Repeat with independent instances to check disk isolation, not just shared memory keys.
      for (const [cache, expected] of [[first, 'first'], [second, 'second'], [otherNetwork, 'other-network']] as const) {
        const fresh = new Cache(cache.network, cache.deployment, false, dir);
        expect(await fresh.readCache(spec)).to.eql({ market: expected });
        expect(await getBuildFile(fresh, fresh.network, address))
          .to.eql(cache.network === first.network ? faucetTokenBuildFile : undefined);
      }
    });
  });

  it('read and store values in-memory', async () => {
    let cache = new Cache('test-network', 'test-deployment', false, tempDir());

    await cache.storeCache(['abc'], 5);

    expect(cache.cache).to.eql(new Map([['abc', 5]]));

    expect(await cache.readCache('abc')).to.eql(5);
  });

  it('preserves falsy values in memory when no cache files exist', async () => {
    const dir = await fs.mkdtemp(tempDir());
    const values = [0, false, ''];

    try {
      const cache = new Cache('test-network', 'test-deployment', false, dir);

      for (const [index, value] of values.entries()) {
        await cache.storeCache({ rel: `value-${index}` }, value);
      }

      const restored = await Promise.all(values.map((_, index) =>
        cache.readCache({ rel: `value-${index}` })
      ));

      expect(await fs.readdir(dir)).to.eql([]);
      expect(restored).to.eql(values);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('read and store values in-memory rel', async () => {
    let cache = new Cache('test-network', 'test-deployment', false, tempDir());

    await cache.storeCache({ rel: 'abc' }, 5);

    expect(cache.cache).to.eql(new Map([['test-network', new Map([['test-deployment', new Map([['abc', 5]])]])]]));

    expect(await cache.readCache({ rel: 'abc' })).to.eql(5);
  });

  it('read and store values to disk', async () => {
    let cache = new Cache('test-network', 'test-deployment', true, tempDir());

    await cache.storeCache(['abc'], 5);

    expect(cache.cache).to.eql(new Map([['abc', 5]]));

    expect(await cache.readCache('abc')).to.eql(5);

    cache.cache = new Map(); // Kill in-memory key

    expect(await cache.readCache('abc')).to.eql(5);
  });

  it('read and store values to disk rel', async () => {
    let cache = new Cache('test-network', 'test-deployment', true, tempDir());

    await cache.storeCache({ rel: 'abc' }, 5);

    expect(cache.cache).to.eql(new Map([['test-network', new Map([['test-deployment', new Map([['abc', 5]])]])]]));

    expect(await cache.readCache({ rel: 'abc' })).to.eql(5);

    cache.cache = new Map(); // Kill in-memory key

    expect(await cache.readCache({ rel: 'abc' })).to.eql(5);
  });

  it('restores falsy values from disk after clearing memory and in a fresh cache', async () => {
    const dir = await fs.mkdtemp(tempDir());
    const values = [0, false, ''];

    try {
      const cache = new Cache('test-network', 'test-deployment', true, dir);

      for (const [index, value] of values.entries()) {
        await cache.storeCache({ rel: `value-${index}` }, value);
      }

      cache.clearMemory();
      const restored = await Promise.all(values.map((_, index) =>
        cache.readCache({ rel: `value-${index}` })
      ));
      expect(restored).to.eql(values);

      const freshCache = new Cache('test-network', 'test-deployment', false, dir);
      const restoredInFreshCache = await Promise.all(values.map((_, index) =>
        freshCache.readCache({ rel: `value-${index}` })
      ));
      expect(restoredInFreshCache).to.eql(values);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  describe('map', () => {
    it('read and store values in-memory rel', async () => {
      let cache = new Cache('test-network', 'test-deployment', false, tempDir());

      await cache.storeMap({ rel: 'abc' }, new Map([['a', 5]]));

      expect(cache.cache).to.eql(new Map([['test-network', new Map([['test-deployment', new Map([['abc', new Map([['a', 5]])]])]])]]));

      expect(objectFromMap(await cache.readCache<Map<string, number>>({ rel: 'abc' }))).to.eql({a: 5});

      await cache.storeMap({ rel: 'abc' }, new Map([['a', 6]]));

      expect(objectFromMap(await cache.readCache<Map<string, number>>({ rel: 'abc' }))).to.eql({a: 6});
    });
  });

  describe('getFilePath', async () => {
    it('returns proper rel path', async () => {
      let dir = tempDir();
      let cache = new Cache('test-network', 'test-deployment', true, dir);

      expect(cache.getFilePath({ rel: 'abc.cool' })).to.equal(`${dir}/test-network/test-deployment/abc.cool`);
    });
  });
});
