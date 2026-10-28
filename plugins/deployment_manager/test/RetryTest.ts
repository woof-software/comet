import { expect } from 'chai';
import { strict as assert } from 'assert';
import hre from 'hardhat';
import { DeploymentManager } from '../DeploymentManager';
import { deferred, flushPromises, recordTimers, tempDir } from './TestHelpers';

describe('DeploymentManager retry behavior', () => {
  let manager: DeploymentManager;
  let timers: ReturnType<typeof recordTimers>;
  let resets: number;

  beforeEach(() => {
    manager = new DeploymentManager('test-network', 'test-deployment', hre, { baseDir: tempDir() });
    timers = recordTimers();
    resets = 0;
    manager.resetSignersPendingCounts = async () => { resets++; };
  });

  afterEach(() => {
    timers.restore();
  });

  it('returns immediate success without resetting nonces or retrying', async () => {
    let attempts = 0;
    const result = await manager.retry(async () => { attempts++; return 'done'; }, 3, 1000, 1);
    expect(result).to.equal('done');
    expect(attempts).to.equal(1);
    expect(resets).to.equal(0);
    expect(timers.delays).to.eql([1000]);
    expect(timers.pendingCount()).to.equal(0);
  });

  it('resets nonces and doubles retry delays until the action succeeds', async () => {
    let attempts = 0;
    const failure = new Error('Temporary failure');
    expect(await manager.retry(async () => {
      attempts++;
      if (attempts < 3) throw failure;
      return 'done';
    }, 3, 1000, 1)).to.equal('done');
    expect(attempts).to.equal(3);
    expect(resets).to.equal(2);
    expect(timers.delays).to.eql([1000, 1, 1000, 2, 1000]);
  });

  it('makes at most N+1 attempts and returns the final action error', async () => {
    let attempts = 0;
    const failure = new Error('Persistent failure');
    await assert.rejects(manager.retry(async () => {
      attempts++;
      throw failure;
    }, 2, 1000, 1), error => error === failure);
    expect(attempts).to.equal(3);
    expect(resets).to.equal(2);
    expect(timers.delays).to.eql([1000, 1, 1000, 2, 1000]);
  });

  it('does not reset or retry when retries=0', async () => {
    let attempts = 0;
    const failure = new Error('No retries allowed');
    await assert.rejects(manager.retry(async () => { attempts++; throw failure; }, 0, 1000, 1),
      error => error === failure);
    expect(attempts).to.equal(1);
    expect(resets).to.equal(0);
    expect(timers.delays).to.eql([1000]);
  });

  it('waits for a nonce reset before starting the next attempt', async () => {
    const reset = deferred<void>();
    let attempts = 0;
    manager.resetSignersPendingCounts = async () => { resets++; await reset.promise; };
    const result = manager.retry(async () => {
      attempts++;
      if (attempts === 1) throw new Error('Retry after reset');
      return 'done';
    }, 1, 1000, 1);
    try {
      await flushPromises();
      expect(resets).to.equal(1);
      expect(attempts).to.equal(1);
    } finally {
      reset.resolve();
    }
    expect(await result).to.equal('done');
    expect(attempts).to.equal(2);
  });

  it('stops before another attempt when the nonce reset itself fails', async () => {
    const resetFailure = new Error('Nonce reset failed');
    let attempts = 0;
    manager.resetSignersPendingCounts = async () => { resets++; throw resetFailure; };
    await assert.rejects(manager.retry(async () => {
      attempts++;
      throw new Error('Action failed');
    }, 2, 1000, 1), error => error === resetFailure);
    expect(attempts).to.equal(1);
    expect(resets).to.equal(1);
    expect(timers.delays).to.eql([1000]);
  });

  it('does not duplicate side effects if the original operation completes after a timeout retry', async () => {
    const first = deferred<void>();
    let attempts = 0;
    let sideEffects = 0;
    const result = manager.retry(async () => {
      attempts++;
      if (attempts === 1) await first.promise;
      sideEffects++;
      return 'done';
    }, 1, 5, 1);

    try {
      expect(await result).to.equal('done');
      expect(attempts).to.equal(2);
      expect(resets).to.equal(1);
      expect(sideEffects).to.equal(1);
      // The timed-out attempt is still alive and may finish after the retry.
      first.resolve();
      await flushPromises();
      expect(sideEffects, 'both attempts applied the action after a timeout').to.equal(1);
    } finally {
      first.resolve();
      await flushPromises();
    }
  });
});
