import { expect } from 'chai';
import * as fs from 'fs/promises';
import { tempDir } from './TestHelpers';
import { Cache } from '../Cache';
import { objectFromMap } from '../Utils';

describe('Cache', () => {
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
