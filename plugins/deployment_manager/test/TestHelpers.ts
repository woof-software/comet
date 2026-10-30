import * as os from 'os';
import * as path from 'path';

// Just a fast, boring random algo to generate tmp directories
function fakeRandom() {
  return Math.random().toString(36).substr(2, 5);
}

export function tempDir(): string {
  return path.join(os.tmpdir(), fakeRandom());
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Let pending Promise continuations finish without sleeping for an arbitrary duration.
export function flushPromises(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// Observe real timers and always remove test-owned timers, including leaked ones.
// Integration failure tests can shorten only the deployment retry waits.
export function recordTimers(shortenDeploymentWaits = false) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const delays: number[] = [];

  global.setTimeout = ((callback: (...args: any[]) => void, delay = 0, ...args: any[]) => {
    delays.push(delay);
    const actualDelay = shortenDeploymentWaits && (delay === 500 || delay === 5000) ? 0 : delay;
    const handle = originalSetTimeout(() => {
      pending.delete(handle);
      callback(...args);
    }, actualDelay);
    pending.add(handle);
    return handle;
  }) as typeof setTimeout;
  global.clearTimeout = ((handle) => {
    pending.delete(handle as ReturnType<typeof setTimeout>);
    originalClearTimeout(handle);
  }) as typeof clearTimeout;

  return {
    delays,
    pendingCount: () => pending.size,
    restore: () => {
      for (const handle of pending) originalClearTimeout(handle);
      pending.clear();
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    },
  };
}
