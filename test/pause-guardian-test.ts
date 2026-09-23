import { expect, makeProtocol } from './helpers.js';
import type { Comet } from './helpers.js';

describe('Pause Guardian', function () {
  it('Should pause supply', async function () {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();
    await assertNoActionsArePaused(comet);

    const txn = await comet.pause(true, false, false, false, false);

    await expect(txn)
      .to.emit(comet, 'PauseAction')
      .withArgs(true, false, false, false, false);

    expect(await comet.isSupplyPaused()).to.be.true;
    expect(await comet.isTransferPaused()).to.be.false;
    expect(await comet.isWithdrawPaused()).to.be.false;
    expect(await comet.isAbsorbPaused()).to.be.false;
    expect(await comet.isBuyPaused()).to.be.false;
  });

  it('Should pause transfer', async function () {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();
    await assertNoActionsArePaused(comet);

    const txn = await comet.pause(false, true, false, false, false);

    await expect(txn)
      .to.emit(comet, 'PauseAction')
      .withArgs(false, true, false, false, false);

    expect(await comet.isSupplyPaused()).to.be.false;
    expect(await comet.isTransferPaused()).to.be.true;
    expect(await comet.isWithdrawPaused()).to.be.false;
    expect(await comet.isAbsorbPaused()).to.be.false;
    expect(await comet.isBuyPaused()).to.be.false;
  });

  it('Should pause withdraw', async function () {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();
    await assertNoActionsArePaused(comet);

    const txn = await comet.pause(false, false, true, false, false);

    await expect(txn)
      .to.emit(comet, 'PauseAction')
      .withArgs(false, false, true, false, false);

    expect(await comet.isSupplyPaused()).to.be.false;
    expect(await comet.isTransferPaused()).to.be.false;
    expect(await comet.isWithdrawPaused()).to.be.true;
    expect(await comet.isAbsorbPaused()).to.be.false;
    expect(await comet.isBuyPaused()).to.be.false;
  });

  it('Should pause absorb', async function () {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();
    await assertNoActionsArePaused(comet);

    const txn = await comet.pause(false, false, false, true, false);

    await expect(txn)
      .to.emit(comet, 'PauseAction')
      .withArgs(false, false, false, true, false);

    expect(await comet.isSupplyPaused()).to.be.false;
    expect(await comet.isTransferPaused()).to.be.false;
    expect(await comet.isWithdrawPaused()).to.be.false;
    expect(await comet.isAbsorbPaused()).to.be.true;
    expect(await comet.isBuyPaused()).to.be.false;
  });

  it('Should pause buy', async function () {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();
    await assertNoActionsArePaused(comet);

    const txn = await comet.pause(false, false, false, false, true);

    await expect(txn)
      .to.emit(comet, 'PauseAction')
      .withArgs(false, false, false, false, true);

    expect(await comet.isSupplyPaused()).to.be.false;
    expect(await comet.isTransferPaused()).to.be.false;
    expect(await comet.isWithdrawPaused()).to.be.false;
    expect(await comet.isAbsorbPaused()).to.be.false;
    expect(await comet.isBuyPaused()).to.be.true;
  });

  it('Should unpause', async function () {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();
    await assertNoActionsArePaused(comet);

    const txn1 = await comet.pause(true, true, true, true, true);

    await expect(txn1)
      .to.emit(comet, 'PauseAction')
      .withArgs(true, true, true, true, true);

    await assertAllActionsArePaused(comet);

    const txn2 = await comet.pause(false, false, false, false, false);

    await expect(txn2)
      .to.emit(comet, 'PauseAction')
      .withArgs(false, false, false, false, false);

    await assertNoActionsArePaused(comet);
  });

  it('Should pause when called by governor', async function () {
    const { cometWithExtendedAssetList: comet, governor } = await makeProtocol();
    await assertNoActionsArePaused(comet);

    await comet.connect(governor).pause(true, true, true, true, true);

    await assertAllActionsArePaused(comet);
  });

  it('Should pause when called by pause guardian', async function () {
    const { cometWithExtendedAssetList: comet, pauseGuardian } = await makeProtocol();
    await assertNoActionsArePaused(comet);

    await comet.connect(pauseGuardian).pause(true, true, true, true, true);

    await assertAllActionsArePaused(comet);
  });

  it('Should revert if not called by governor or pause guardian', async function () {
    const { cometWithExtendedAssetList: comet, users } = await makeProtocol();
    await expect(
      comet.connect(users[0]).pause(true, true, true, true, true)
    ).to.be.revertedWithCustomError(comet, 'Unauthorized');
  });
});

async function assertNoActionsArePaused(comet: Comet) {
  // All pause flags should be false by default.
  expect(await comet.isSupplyPaused()).to.be.false;
  expect(await comet.isTransferPaused()).to.be.false;
  expect(await comet.isWithdrawPaused()).to.be.false;
  expect(await comet.isAbsorbPaused()).to.be.false;
  expect(await comet.isBuyPaused()).to.be.false;
}

async function assertAllActionsArePaused(comet: Comet) {
  expect(await comet.isSupplyPaused()).to.be.true;
  expect(await comet.isTransferPaused()).to.be.true;
  expect(await comet.isWithdrawPaused()).to.be.true;
  expect(await comet.isAbsorbPaused()).to.be.true;
  expect(await comet.isBuyPaused()).to.be.true;
}
