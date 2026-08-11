import { ethers, expect, exp, fastForward, makeProtocol, setTotalsBasic, toYears } from './helpers';
import { BigNumber } from 'ethers';

describe('total tracking index bounds', function () {
  describe('base scale of 6', function () {
    it('upper bound hit on tracking supply index', async () => {
      const baseMinForRewards = exp(10_000, 6); // 10k USDC
      const params = {
        trackingIndexScale: exp(1, 15),
        baseTrackingSupplySpeed: exp(1, 15),
        baseTrackingBorrowSpeed: exp(1, 15),
        baseMinForRewards
      };
      const protocol = await makeProtocol(params);
      const { comet } = protocol;

      const baseScale = (await comet.baseScale()).toBigInt();
      // Formula: MAX_UINT64 / (baseTrackingSupplySpeed * baseScale / baseMinForRewards)
      const secondsUntilOverflow = Number(2n**64n * (baseMinForRewards / baseScale) / params.baseTrackingSupplySpeed);

      // Assert there are at least 5.85 years until tracking index can overflow
      const expectedYearsUntilOverflow = 5.85;
      expect(toYears(secondsUntilOverflow)).to.be.approximately(expectedYearsUntilOverflow, 0.01);

      await setTotalsBasic(comet, {
        totalSupplyBase: BigNumber.from(baseMinForRewards), // 10k USDC base units
      });

      // Compute exact seconds remaining to reach lastAccrualTime + N, so first
      // accrue has timeElapsed = N (tracking = delta*N ≤ MAX_UINT64) and second
      // accrue has timeElapsed = 1 (tracking = delta*(N+1) > MAX_UINT64 → panic).
      const totals0 = await comet.totalsBasic();
      const currentTs0 = (await ethers.provider.getBlock('latest')).timestamp;
      const remaining0 = secondsUntilOverflow - (currentTs0 - Number(totals0.lastAccrualTime));
      await fastForward(remaining0);

      await comet.accrue(); // first accrue: timeElapsed = N, tracking = delta*N ≤ MAX_UINT64

      await expect(comet.accrue()).to.be.revertedWithPanic(0x11);
    });

    it('upper bound hit on tracking borrow index', async () => {
      const baseMinForRewards = exp(10_000, 6); // 10k USDC
      const params = {
        trackingIndexScale: exp(1, 15),
        baseTrackingSupplySpeed: exp(1, 15),
        baseTrackingBorrowSpeed: exp(1, 15),
        baseMinForRewards
      };
      const protocol = await makeProtocol(params);
      const { comet } = protocol;

      const baseScale = (await comet.baseScale()).toBigInt();
      // Formula: MAX_UINT64 / (baseTrackingBorrowSpeed * baseScale / baseMinForRewards)
      const secondsUntilOverflow = Number(2n**64n * (baseMinForRewards / baseScale) / params.baseTrackingBorrowSpeed);

      // Assert there are at least 5.85 years until tracking index can overflow
      const expectedYearsUntilOverflow = 5.85;
      expect(toYears(secondsUntilOverflow)).to.be.approximately(expectedYearsUntilOverflow, 0.01);

      await setTotalsBasic(comet, {
        totalBorrowBase: BigNumber.from(baseMinForRewards), // 10k USDC base units
      });

      const totals1 = await comet.totalsBasic();
      const currentTs1 = (await ethers.provider.getBlock('latest')).timestamp;
      const remaining1 = secondsUntilOverflow - (currentTs1 - Number(totals1.lastAccrualTime));
      await fastForward(remaining1);

      await comet.accrue(); // first accrue: timeElapsed = N, tracking = delta*N ≤ MAX_UINT64

      await expect(comet.accrue()).to.be.revertedWithPanic(0x11);
    });

    it('lower bound hit on tracking supply index', async () => {
      const params = {
        trackingIndexScale: exp(1, 15),
        baseTrackingSupplySpeed: exp(1, 15),
        baseTrackingBorrowSpeed: exp(1, 15),
      };
      const protocol = await makeProtocol(params);
      const { comet } = protocol;

      const t0 = await setTotalsBasic(comet, {
        totalSupplyBase: BigNumber.from(exp(1, 15)).mul(await comet.baseScale()), // 1e15 base units
      });

      await comet.accrue();
      const t1 = await comet.totalsBasic();

      // Tracking index should properly accrue
      expect(t1.trackingSupplyIndex).to.not.be.equal(t0.trackingSupplyIndex);

      const t2 = await setTotalsBasic(comet, {
        totalSupplyBase: BigNumber.from(exp(1, 15)).mul(await comet.baseScale()).mul(3), // 3e15 base units
      });

      await comet.accrue();
      const t3 = await comet.totalsBasic();

      // Lower bound has hit and tracking index no longer accrues
      expect(t3.trackingSupplyIndex).to.be.equal(t2.trackingSupplyIndex);
    });

    it('lower bound hit on tracking borrow index', async () => {
      const params = {
        trackingIndexScale: exp(1, 15),
        baseTrackingSupplySpeed: exp(1, 15),
        baseTrackingBorrowSpeed: exp(1, 15),
      };
      const protocol = await makeProtocol(params);
      const { comet } = protocol;

      const t0 = await setTotalsBasic(comet, {
        totalBorrowBase: BigNumber.from(exp(1, 15)).mul(await comet.baseScale()), // 1e15 base units
      });

      await comet.accrue();
      const t1 = await comet.totalsBasic();

      // Tracking index should properly accrue
      expect(t1.trackingBorrowIndex).to.not.be.equal(t0.trackingBorrowIndex);

      const t2 = await setTotalsBasic(comet, {
        totalBorrowBase: BigNumber.from(exp(1, 15)).mul(await comet.baseScale()).mul(3), // 3e15 base units
      });

      await comet.accrue();
      const t3 = await comet.totalsBasic();

      // Lower bound has hit and tracking index no longer accrues
      expect(t3.trackingBorrowIndex).to.be.equal(t2.trackingBorrowIndex);
    });
  });

  describe('base scale of 18', function () {
    it('upper bound hit on tracking supply index', async () => {
      const baseMinForRewards = exp(100, 18); // 100 WETH
      const params = {
        base: 'WETH',
        trackingIndexScale: exp(1, 15),
        baseTrackingSupplySpeed: exp(0.001, 15), // 86.4 units/day
        baseTrackingBorrowSpeed: exp(0.001, 15),
        baseMinForRewards
      };
      const protocol = await makeProtocol(params);
      const { comet } = protocol;

      const baseScale = (await comet.baseScale()).toBigInt();
      // Formula: MAX_UINT64 / (baseTrackingSupplySpeed * baseScale / baseMinForRewards)
      const secondsUntilOverflow = Number(2n**64n * (baseMinForRewards / baseScale) / params.baseTrackingSupplySpeed);

      // Assert there are at least 58.5 years until tracking index can overflow
      const expectedYearsUntilOverflow = 58.5;
      expect(toYears(secondsUntilOverflow)).to.be.approximately(expectedYearsUntilOverflow, 0.01);

      await setTotalsBasic(comet, {
        totalSupplyBase: BigNumber.from(baseMinForRewards), // 100 WETH base units
      });

      const totals2 = await comet.totalsBasic();
      const currentTs2 = (await ethers.provider.getBlock('latest')).timestamp;
      const remaining2 = secondsUntilOverflow - (currentTs2 - Number(totals2.lastAccrualTime));
      await fastForward(remaining2);

      await comet.accrue(); // first accrue: timeElapsed = N, tracking = delta*N ≤ MAX_UINT64

      await expect(comet.accrue()).to.be.revertedWithPanic(0x11);
    });

    it('upper bound hit on tracking borrow index', async () => {
      const baseMinForRewards = exp(100, 18); // 100 WETH
      const params = {
        base: 'WETH',
        trackingIndexScale: exp(1, 15),
        baseTrackingSupplySpeed: exp(0.001, 15), // 86.4 units/day
        baseTrackingBorrowSpeed: exp(0.001, 15),
        baseMinForRewards
      };
      const protocol = await makeProtocol(params);
      const { comet } = protocol;

      const baseScale = (await comet.baseScale()).toBigInt();
      // Formula: MAX_UINT64 / (baseTrackingBorrowSpeed * baseScale / baseMinForRewards)
      const secondsUntilOverflow = Number(2n**64n * (baseMinForRewards / baseScale) / params.baseTrackingBorrowSpeed);

      // Assert there are at least 58.5 years until tracking index can overflow
      const expectedYearsUntilOverflow = 58.5;
      expect(toYears(secondsUntilOverflow)).to.be.approximately(expectedYearsUntilOverflow, 0.01);

      await setTotalsBasic(comet, {
        totalBorrowBase: BigNumber.from(baseMinForRewards), // 10k USDC base units
      });

      const totals3 = await comet.totalsBasic();
      const currentTs3 = (await ethers.provider.getBlock('latest')).timestamp;
      const remaining3 = secondsUntilOverflow - (currentTs3 - Number(totals3.lastAccrualTime));
      await fastForward(remaining3);

      // First accrue: timeElapsed = N, tracking = delta*N ≤ MAX_UINT64
      await comet.accrue();

      await expect(comet.accrue()).to.be.revertedWithPanic(0x11);
    });

    it('lower bound hit on tracking supply index', async () => {
      const params = {
        base: 'WETH',
        trackingIndexScale: exp(1, 15),
        baseTrackingSupplySpeed: exp(0.001, 15), // 86.4 units/day
        baseTrackingBorrowSpeed: exp(0.001, 15),
      };
      const protocol = await makeProtocol(params);
      const { comet } = protocol;

      const t0 = await setTotalsBasic(comet, {
        totalSupplyBase: BigNumber.from(exp(1, 12)).mul(await comet.baseScale()), // 1e12 base units
      });

      await comet.accrue();
      const t1 = await comet.totalsBasic();

      // Tracking index should properly accrue
      expect(t1.trackingSupplyIndex).to.not.be.equal(t0.trackingSupplyIndex);

      const t2 = await setTotalsBasic(comet, {
        totalSupplyBase: BigNumber.from(exp(1, 13)).mul(await comet.baseScale()), // 1e13 base units
      });

      await comet.accrue();
      const t3 = await comet.totalsBasic();

      // Lower bound has hit and tracking index no longer accrues
      expect(t3.trackingSupplyIndex).to.be.equal(t2.trackingSupplyIndex);
    });

    it('lower bound hit on tracking borrow index', async () => {
      const params = {
        base: 'WETH',
        trackingIndexScale: exp(1, 15),
        baseTrackingSupplySpeed: exp(0.001, 15), // 86.4 units/day
        baseTrackingBorrowSpeed: exp(0.001, 15),
      };
      const protocol = await makeProtocol(params);
      const { comet } = protocol;

      const t0 = await setTotalsBasic(comet, {
        totalBorrowBase: BigNumber.from(exp(1, 12)).mul(await comet.baseScale()), // 1e12 base units
      });

      await comet.accrue();
      const t1 = await comet.totalsBasic();

      // Tracking index should properly accrue
      expect(t1.trackingBorrowIndex).to.not.be.equal(t0.trackingBorrowIndex);

      const t2 = await setTotalsBasic(comet, {
        totalBorrowBase: BigNumber.from(exp(1, 13)).mul(await comet.baseScale()), // 1e13 base units
      });

      await comet.accrue();
      const t3 = await comet.totalsBasic();

      // Lower bound has hit and tracking index no longer accrues
      expect(t3.trackingBorrowIndex).to.be.equal(t2.trackingBorrowIndex);
    });
  });
});


describe('user tracking index bounds', function () {
  // XXX test if small supply/borrow causes users to not accrue rewards
});