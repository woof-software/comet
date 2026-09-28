import { ethers, expect, makeProtocol } from './helpers.js';

describe('getNow', function () {
  it('reverts if timestamp overflows', async () => {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();
    const snapshotId = await ethers.provider.send('evm_snapshot', []);
    try {
      await ethers.provider.send('evm_mine', [2**40]);
      await expect(comet.getNow()).to.be.revertedWithCustomError(comet, 'TimestampTooLarge');
    } finally {
      await ethers.provider.send('evm_revert', [snapshotId]);
    }
  });
});

describe('updateBaseBalance', function () {
  // XXX
  it.skip('accrues the right amount of rewards', async () => {
    // XXX
  });
});
