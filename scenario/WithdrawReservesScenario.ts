import { scenario, CometContext } from './context/CometContext';
import {
  expectRevertCustom,
  setNextBlockTimestamp,
  duration,
  normalizeStructOutput,
  getLatestBlockTimestamp
} from './utils';
import { exp } from '../test/helpers';
import { expect } from 'chai';

// ─────────────────────────────────────────────────────────────────────────────
// Happy Path
// ─────────────────────────────────────────────────────────────────────────────

// HP-00
scenario('Comet#withdrawReserves > governor withdraws part of reserves', {}, async ({ comet, actors }, context) => {
  const { admin, albert } = actors;
  const dm = context.world.deploymentManager;

  const baseToken = context.getAssetByAddress(await comet.baseToken());

  const cometBalanceBefore = await baseToken.balanceOf(comet.address);
  const toBalanceBefore = await baseToken.balanceOf(albert.address);
  const totalsBasicBefore = normalizeStructOutput(await comet.totalsBasic());

  const targetTimestamp = (await getLatestBlockTimestamp(dm)) + duration.days(1);
  const reservesBefore = await getReservesByTimestamp(context, targetTimestamp);

  const withdrawAmount = reservesBefore / 10n;

  await setNextBlockTimestamp(dm, targetTimestamp);
  const txn = await comet
    .connect(admin.signer)
    .withdrawReserves(albert.address, withdrawAmount)
    .then((tx) => tx.wait());

  expect(await baseToken.balanceOf(comet.address)).to.equal(
    cometBalanceBefore - withdrawAmount,
    'Comet base token balance should decrease by the withdrawn amount'
  );
  expect(await baseToken.balanceOf(albert.address)).to.equal(
    toBalanceBefore + withdrawAmount,
    'Receiver base token balance should increase by the withdrawn amount'
  );
  expect((await comet.getReserves()).toBigInt()).to.equal(
    reservesBefore - withdrawAmount,
    'Comet reserves should decrease by the withdrawn amount'
  );
  expect(normalizeStructOutput(await comet.totalsBasic())).to.deep.equal(
    totalsBasicBefore,
    'Comet totalsBasic should remain unchanged after withdrawing reserves'
  );

  return txn; // return txn to measure gas
});

// HP-01
scenario('Comet#withdrawReserves > governor withdraws all reserves', {}, async ({ comet, actors }, context) => {
  const { admin, albert } = actors;
  const dm = context.world.deploymentManager;

  const baseToken = context.getAssetByAddress(await comet.baseToken());

  const cometBalanceBefore = await baseToken.balanceOf(comet.address);
  const toBalanceBefore = await baseToken.balanceOf(albert.address);

  const targetTimestamp = (await getLatestBlockTimestamp(dm)) + duration.days(1);
  const toWithdrawAmount = await getReservesByTimestamp(context, targetTimestamp);

  await setNextBlockTimestamp(dm, targetTimestamp);
  const txn = await comet
    .connect(admin.signer)
    .withdrawReserves(albert.address, toWithdrawAmount)
    .then((tx) => tx.wait());

  expect(await baseToken.balanceOf(comet.address)).to.equal(
    cometBalanceBefore - toWithdrawAmount,
    'Comet base token balance should decrease by the withdrawn amount'
  );
  expect(await baseToken.balanceOf(albert.address)).to.equal(
    toBalanceBefore + toWithdrawAmount,
    'Receiver base token balance should increase by the withdrawn amount'
  );

  expect((await comet.getReserves()).toBigInt()).to.equal(0n, 'Comet reserves should decrease by the withdrawn amount');

  return txn; // return txn to measure gas
});

// HP-02
scenario(
  'Comet#withdrawReserves > withdrawal succeeds while the protocol is paused',
  { pause: { all: true } },
  async ({ comet, actors }, context) => {
    const { admin, albert } = actors;
    const dm = context.world.deploymentManager;

    const baseToken = context.getAssetByAddress(await comet.baseToken());

    const cometBaseBalanceBefore = await baseToken.balanceOf(comet.address);
    const receiverBaseBalanceBefore = await baseToken.balanceOf(albert.address);

    const targetTimestamp = (await getLatestBlockTimestamp(dm)) + duration.hours(1);
    const toWithdrawAmount = await getReservesByTimestamp(context, targetTimestamp); // withdraw all reserves

    await setNextBlockTimestamp(dm, targetTimestamp);
    const txn = await comet
      .connect(admin.signer)
      .withdrawReserves(albert.address, toWithdrawAmount)
      .then((tx) => tx.wait());

    expect(await baseToken.balanceOf(comet.address)).to.equal(
      cometBaseBalanceBefore - toWithdrawAmount,
      'Comet base token balance should decrease by the withdrawn amount'
    );
    expect(await baseToken.balanceOf(albert.address)).to.equal(
      receiverBaseBalanceBefore + toWithdrawAmount,
      'Receiver base token balance should increase by the withdrawn amount'
    );
    expect((await comet.getReserves()).toBigInt()).to.equal(
      0n,
      'Comet reserves should decrease by the withdrawn amount'
    );

    return txn; // return txn to measure gas
  }
);

// HP-03
scenario(
  'Comet#withdrawReserves > governor withdraws reserves after time advances',
  {},
  async ({ comet, actors }, context) => {
    const { admin, albert } = actors;
    const dm = context.world.deploymentManager;

    const targetReserveBalance = (await comet.getReserves()).toBigInt();

    const targetTimestamp = (await getLatestBlockTimestamp(dm)) + duration.months(1);
    const expectedReserves = await getReservesByTimestamp(context, targetTimestamp);

    expect(expectedReserves).to.be.greaterThan(
      targetReserveBalance,
      'Expected reserves should be greater than current reserves after time advances'
    );

    const withdrawAmount = expectedReserves - targetReserveBalance; // withdraw the difference in reserves

    await setNextBlockTimestamp(dm, targetTimestamp);
    const txn = await comet
      .connect(admin.signer)
      .withdrawReserves(albert.address, withdrawAmount)
      .then((tx) => tx.wait());

    expect((await comet.getReserves()).toBigInt()).to.equal(
      targetReserveBalance,
      'Comet reserves should equal the target reserve amount after withdrawing the difference'
    );

    return txn; // return txn to measure gas
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Unhappy Path
// ─────────────────────────────────────────────────────────────────────────────

// UP-00
scenario('Comet#withdrawReserves > reverts if not called by governor', {}, async ({ comet, actors }) => {
  const { albert } = actors;
  const reservesBefore = (await comet.getReserves()).toBigInt();
  const toWithdrawAmount = reservesBefore;

  await expectRevertCustom(
    comet.connect(albert.signer).withdrawReserves(albert.address, toWithdrawAmount),
    'Unauthorized()'
  );
});

// UH-01
scenario(
  'Comet#withdrawReserves > reverts if not enough reserves are owned by protocol',
  {},
  async ({ comet, actors }) => {
    const { admin, albert } = actors;

    const reservesBefore = (await comet.getReserves()).toBigInt();
    const toWithdrawAmount = reservesBefore * 2n; // attempt to withdraw double the reserves

    await expectRevertCustom(
      comet.connect(admin.signer).withdrawReserves(albert.address, toWithdrawAmount),
      'InsufficientReserves()'
    );
  }
);

// UH-02
scenario('Comet#withdrawReserves > reverts when reserves are negative', {}, async ({ comet, actors }, context) => {
  const { admin, albert } = actors;

  const cometSigner = await context.world.impersonateAddress(comet.address, { value: 1n * 10n ** 18n }); // fund albert with 1 ETH for gas

  const baseToken = context.getAssetByAddress(await comet.baseToken()).token;
  const baseScale = (await comet.baseScale()).toBigInt();
  const cometBalance = await baseToken.balanceOf(comet.address);

  await baseToken.connect(cometSigner).transfer(albert.address, cometBalance); // transfer more than reserves to comet

  await expectRevertCustom(
    comet.connect(admin.signer).withdrawReserves(albert.address, 1n * baseScale), // attempt to withdraw 1 base token
    'InsufficientReserves()'
  );
});

// UH-03
scenario(
  'Comet#withdrawReserves > reverts when attempting to withdraw total supply base',
  {},
  async ({ comet, actors }, context) => {
    const { admin, albert } = actors;

    const totalsBasic = normalizeStructOutput(await comet.totalsBasic());

    await expectRevertCustom(
      comet.connect(admin.signer).withdrawReserves(albert.address, totalsBasic.totalSupplyBase),
      'InsufficientReserves()'
    );
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

// EC-00
scenario('Comet#withdrawReserves > withdraw 0 reserves', {}, async ({ comet, actors }, context) => {
  const { admin, albert } = actors;
  const txn = await comet
    .connect(admin.signer)
    .withdrawReserves(albert.address, 0n)
    .then((tx) => tx.wait());

  return txn; // return txn to measure gas
});

// EC-01
scenario('Comet#withdrawReserves > to comet address', {}, async ({ comet, actors }, context) => {
  const { admin } = actors;
  const baseScale = (await comet.baseScale()).toBigInt();
  const txn = await comet
    .connect(admin.signer)
    .withdrawReserves(comet.address, 1n * baseScale)
    .then((tx) => tx.wait()); // withdraw 1 base token

  return txn; // return txn to measure gas
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

function presentValue(principalValue: bigint, baseIndex_: bigint): bigint {
  const BASE_INDEX_SCALE = exp(1, 15);
  return (principalValue * baseIndex_) / BASE_INDEX_SCALE;
}

function mulFactor(baseIndex: bigint, factor: bigint): bigint {
  const FACTOR_SCALE = exp(1, 18);
  return (baseIndex * factor) / FACTOR_SCALE;
}

async function accruedInterestIndices(
  context: CometContext,
  timeElapsed: bigint,
  baseSupplyIndex: bigint,
  baseBorrowIndex: bigint
): Promise<{
  baseSupplyIndex: bigint;
  baseBorrowIndex: bigint;
}> {
  const comet = await context.getComet();
  const utilization = await comet.getUtilization();
  const supplyRate = (await comet.getSupplyRate(utilization)).toBigInt();
  const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();
  baseSupplyIndex += mulFactor(baseSupplyIndex, supplyRate * timeElapsed);
  baseBorrowIndex += mulFactor(baseBorrowIndex, borrowRate * timeElapsed);
  return { baseSupplyIndex, baseBorrowIndex };
}

async function getReservesByTimestamp(context: CometContext, targetTimestamp: number): Promise<bigint> {
  const comet = await context.getComet();
  const cometBalanceBefore = await context.getAssetByAddress(await comet.baseToken()).balanceOf(comet.address);
  const totalsBasic = normalizeStructOutput(await comet.totalsBasic());
  const { baseSupplyIndex, baseBorrowIndex } = await accruedInterestIndices(
    context,
    BigInt(targetTimestamp - totalsBasic.lastAccrualTime),
    totalsBasic.baseSupplyIndex,
    totalsBasic.baseBorrowIndex
  );
  const totalSupply = presentValue(baseSupplyIndex, totalsBasic.totalSupplyBase);
  const totalBorrow = presentValue(baseBorrowIndex, totalsBasic.totalBorrowBase);

  return cometBalanceBefore - totalSupply + totalBorrow;
}
