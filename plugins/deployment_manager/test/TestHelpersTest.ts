import { expect } from 'chai';
import { recordTimers } from './TestHelpers';

describe('Scoped timer recording', () => {
  it('does not record or cancel unrelated timers during cleanup', async () => {
    const nativeSetTimeout = global.setTimeout;
    const timers = recordTimers();
    let unrelatedFinished = false;
    let trackedFinished = false;
    const unrelated = setTimeout(() => { unrelatedFinished = true; }, 5);
    try {
      timers.run(() => setTimeout(() => { trackedFinished = true; }, 1000));
      expect(timers.delays).to.eql([1000]);
      expect(timers.pendingCount()).to.equal(1);
      timers.restore();
      await new Promise(resolve => nativeSetTimeout(resolve, 25));
      expect(unrelatedFinished).to.equal(true);
      expect(trackedFinished).to.equal(false);
      expect(timers.pendingCount()).to.equal(0);
    } finally {
      clearTimeout(unrelated);
      timers.restore();
    }
  });

  for (const options of [{ immediate: true }, { shortenDeploymentWaits: true }]) {
    const mode = 'immediate' in options ? 'immediate timers' : 'shortened deployment waits';
    it(`preserves callback arguments and leaves outside timers unchanged with ${mode}`, async () => {
      const timers = recordTimers(options);
      let unrelatedFinished = false;
      const unrelated = setTimeout(() => { unrelatedFinished = true; }, 500);
      try {
        const result = await timers.run(() => new Promise(resolve => setTimeout(resolve, 500, 'value')));
        expect(result).to.equal('value');
        expect(timers.delays).to.eql([500]);
        expect(timers.pendingCount()).to.equal(0);
        expect(unrelatedFinished).to.equal(false);
      } finally {
        clearTimeout(unrelated);
        timers.restore();
      }
    });
  }
});
