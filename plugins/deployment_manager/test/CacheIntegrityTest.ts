import { expect } from 'chai';
import { strict as assert } from 'assert';
import * as fs from 'fs/promises';
import fsPromises from 'fs/promises';
import { Cache } from '../Cache';
import { deferred, tempDir } from './TestHelpers';

describe('Cache file integrity', () => {
  let dir: string;
  const spec = { rel: 'state.json' };
  const originalWrite = fsPromises.writeFile;
  const originalRename = fsPromises.rename;

  beforeEach(async () => {
    dir = await fs.mkdtemp(tempDir());
  });
  afterEach(async () => {
    Object.assign(fsPromises, { writeFile: originalWrite, rename: originalRename });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps the old JSON readable while a replacement is incomplete and publishes the complete new value', async () => {
    const writer = new Cache('test-network', 'test-deployment', true, dir);
    const oldValue = { version: 1, entries: ['old'] };
    const newValue = { version: 2, entries: ['new', 'complete'] };
    await writer.storeCache(spec, oldValue);
    const file = writer.getFilePath(spec);
    const started = deferred<void>();
    const resume = deferred<void>();
    let intercepted = false;
    let write: Promise<void> | undefined;
    try {
      // Pause with genuinely incomplete content in the temporary replacement file.
      Object.assign(fsPromises, {
        writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
          if (String(args[0]).startsWith(`${file}.tmp.`)) {
            intercepted = true;
            await originalWrite(args[0], '{unfinished');
            started.resolve();
            await resume.promise;
          }
          return originalWrite(...args);
        },
      });
      write = writer.storeCache(spec, newValue);
      // Surface an early write failure instead of leaving the synchronization wait hanging.
      await Promise.race([started.promise, write]);
      expect(intercepted).to.equal(true);
      const reader = new Cache(writer.network, writer.deployment, false, dir);
      expect(await reader.readCache(spec)).to.eql(oldValue);
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).to.eql(oldValue);

      resume.resolve();
      await write;
      const afterReplacement = new Cache(writer.network, writer.deployment, false, dir);
      expect(await afterReplacement.readCache(spec)).to.eql(newValue);
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).to.eql(newValue);
      expect(await fs.readdir(`${dir}/test-network/test-deployment`)).to.eql(['state.json']);
    } finally {
      resume.resolve();
      if (write) await write.catch(() => undefined);
    }
  });

  for (const boundary of ['write', 'rename'] as const) {
    it(`preserves the existing file and reports a ${boundary} failure`, async () => {
      const writer = new Cache('test-network', 'test-deployment', true, dir);
      const oldValue = { version: 1 };
      const newValue = { version: 2 };
      await writer.storeCache(spec, oldValue);
      const file = writer.getFilePath(spec);
      const failure = new Error(`Injected ${boundary} failure`);
      let intercepted = false;
      if (boundary === 'write') {
        Object.assign(fsPromises, {
          writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
            if (String(args[0]).startsWith(`${file}.tmp.`)) {
              intercepted = true;
              await originalWrite(args[0], '{unfinished');
              throw failure;
            }
            return originalWrite(...args);
          },
        });
      } else {
        Object.assign(fsPromises, {
          rename: async (...args: Parameters<typeof fs.rename>) => {
            if (String(args[1]) === file) {
              intercepted = true;
              throw failure;
            }
            return originalRename(...args);
          },
        });
      }
      await assert.rejects(writer.storeCache(spec, newValue), error => error === failure);
      expect(intercepted).to.equal(true);
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).to.eql(oldValue);
      const fresh = new Cache(writer.network, writer.deployment, false, dir);
      expect(await fresh.readCache(spec)).to.eql(oldValue);
      // A failed disk write currently leaves the newer value in the writer's memory.
      expect(await writer.readCache(spec)).to.eql(newValue);

      Object.assign(fsPromises, { writeFile: originalWrite, rename: originalRename });
      await writer.storeCache(spec, newValue);
      const afterRecovery = new Cache(writer.network, writer.deployment, false, dir);
      expect(await afterRecovery.readCache(spec)).to.eql(newValue);
    });
  }

  it('shows a lost update when independent instances save stale map snapshots', async () => {
    const first = new Cache('test-network', 'test-deployment', true, dir);
    const second = new Cache(first.network, first.deployment, true, dir);
    await first.storeMap(spec, new Map([['original', 1]]));
    first.clearMemory();
    // Both instances read before either update is published: no timing-dependent race is needed.
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      first.readMap<number>(spec), second.readMap<number>(spec),
    ]);
    expect([...firstSnapshot]).to.eql([['original', 1]]);
    expect([...secondSnapshot]).to.eql([['original', 1]]);
    firstSnapshot.set('first', 2);
    secondSnapshot.set('second', 3);
    await first.storeMap(spec, firstSnapshot);
    const fresh = new Cache(first.network, first.deployment, false, dir);
    expect([...(await fresh.readMap(spec))]).to.eql([['original', 1], ['first', 2]]);
    await second.storeMap(spec, secondSnapshot);

    const afterUpdates = new Cache(first.network, first.deployment, false, dir);
    const saved = await afterUpdates.readMap(spec);
    expect([...saved]).to.eql([['original', 1], ['second', 3]]);
    expect(saved.has('first')).to.equal(false);
    // This characterizes the current limitation, not a guarantee that concurrent updates merge.
    expect((await first.readMap(spec)).get('first')).to.equal(2);
  });
});
