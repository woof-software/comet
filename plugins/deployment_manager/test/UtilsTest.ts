import { expect } from 'chai';
import { strict as assert } from 'assert';
import { asyncCallWithTimeout } from '../Utils';
import { deferred, recordTimers } from './TestHelpers';

describe('Utils timeout cleanup', () => {
  let timers: ReturnType<typeof recordTimers>;

  beforeEach(() => {
    timers = recordTimers();
  });

  afterEach(() => {
    timers.restore();
  });

  it('returns a successful result and clears its timeout', async () => {
    expect(await timers.run(() => asyncCallWithTimeout(Promise.resolve('done'), 1000))).to.equal('done');
    expect(timers.pendingCount()).to.equal(0);
  });

  it('preserves the original rejection and clears its timeout', async () => {
    const failure = new Error('Action rejected');
    await assert.rejects(timers.run(() => asyncCallWithTimeout(Promise.reject(failure), 1000)), error => error === failure);
    // A rejected action must not leave its timeout running in the background.
    expect(timers.pendingCount()).to.equal(0);
  });

  it('reports a timeout and keeps that result after the original operation completes late', async () => {
    const action = deferred<string>();
    let sideEffects = 0;
    const originalOperation = action.promise.then(value => {
      sideEffects++;
      return value;
    });
    const timed = timers.run(() => asyncCallWithTimeout(originalOperation, 5));
    try {
      await assert.rejects(timed, /Async call timeout limit reached/);
      expect(timers.pendingCount()).to.equal(0);

      // Timeout reports an error; it does not cancel the original operation.
      action.resolve('late result');
      expect(await originalOperation).to.equal('late result');
      expect(sideEffects).to.equal(1);
      await assert.rejects(timed, /Async call timeout limit reached/);
      expect(timers.pendingCount()).to.equal(0);
    } finally {
      action.resolve('late result');
      await originalOperation;
      await timed.catch(() => undefined);
    }
  });
});
