import { getNumber } from 'ethers';
import type { EventLog } from 'ethers';
import { CometHarnessExtendedAssetList__factory } from '../build/types/index.js';
import type { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from '../build/types/index.js';
import type { HardhatEthersSigner as SignerWithAddress } from '@nomicfoundation/hardhat-ethers/types';
import { ethers, expect, exp, fastForward, getBlock, makeProtocol, wait, setTotalsBasic, oneMonth, oneDay, defaultAssets } from './helpers.js';
import { takeSnapshot } from './helpers/snapshot.js';
import type { SnapshotRestorer } from './helpers/snapshot.js';

type UserBasic = Awaited<ReturnType<CometHarnessInterfaceExtendedAssetList['userBasic']>>;
type TotalsBasicStructOutput = Awaited<ReturnType<CometHarnessInterfaceExtendedAssetList['totalsBasic']>>;

function expectApproximately(actual: bigint, expected: bigint, tolerance: bigint): void {
  const difference = actual >= expected ? actual - expected : expected - actual;
  expect(difference <= tolerance).to.equal(true, `difference ${difference} exceeds tolerance ${tolerance}`);
}

describe('accrue', function () {
  // Constants
  const FACTOR_SCALE = exp(1, 18);
  const INDEX_SCALE = exp(1, 15);
  const baseTokenDecimals = 6;
  const baseTokenScale = exp(1, baseTokenDecimals);
  const seedAmount = exp(10000, baseTokenDecimals);
  const supplyAmount = exp(100, baseTokenDecimals);
  const config = {
    borrowInterestRateBase: exp(0.05, 18),
    supplyInterestRateBase: exp(0.05, 18),
    baseTrackingBorrowSpeed: exp(1 / 86400, 15, 18), // 1 comp per day
    baseTrackingSupplySpeed: exp(1 / 86400, 15, 18), // 1 comp per day
  };
    // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken;
  let collaterals: {
        [symbol: string]: FaucetToken;
    } = {};
  let priceFeeds: {
        [symbol: string]: SimplePriceFeed;
    } = {};
    // Accounts
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let dave: SignerWithAddress;
  before(async () => {
    const protocol = await makeProtocol({
      base: 'USDC',
      borrowInterestRateBase: config.borrowInterestRateBase,
      supplyInterestRateBase: config.supplyInterestRateBase,
      baseTrackingBorrowSpeed: config.baseTrackingBorrowSpeed,
      baseTrackingSupplySpeed: config.baseTrackingSupplySpeed,
      assets: defaultAssets({}, {
        WETH: {
          decimals: 18,
          borrowCF: exp(0.8, 18),
          liquidateCF: exp(0.95, 18),
          liquidationFactor: exp(0.95, 18),
        },
      }),
    });
    comet = protocol.cometWithExtendedAssetList;
    baseToken = protocol.tokens.USDC as FaucetToken;
    for (const asset in protocol.tokens) {
      if (asset === 'USDC')
        continue;
      collaterals[asset] = protocol.tokens[asset] as FaucetToken;
    }
    for (const asset in protocol.priceFeeds) {
      priceFeeds[asset] = protocol.priceFeeds[asset];
    }
    [alice, bob, dave] = protocol.users;
  });
  describe('empty position', function () {
    let timeBefore: number;
    let userBasicBefore: UserBasic;
    let supplyRatePerSecond: bigint;
    let borrowRatePerSecond: bigint;
    before(async function () {
      const block = await ethers.provider.getBlock('latest');
      if (!block) throw new Error('Latest block not found');
      timeBefore = block.timestamp;
      userBasicBefore = await comet.userBasic(alice.address);
      supplyRatePerSecond = (BigInt(config.supplyInterestRateBase) / BigInt(365 * oneDay));
      borrowRatePerSecond = (BigInt(config.borrowInterestRateBase) / BigInt(365 * oneDay));
    });
    it('utilization should be 0 with no borrowers', async function () {
      expect(await comet.getUtilization()).to.equal(0);
    });
    it('supply index should be 1 in initial state', async function () {
      const { baseSupplyIndex } = await comet.totalsBasic();
      const indexScale = await comet.baseIndexScale();
      expect(baseSupplyIndex).to.be.equal(INDEX_SCALE);
      expect(baseSupplyIndex).to.be.equal(indexScale);
    });
    it('borrow index should be 1 in initial state', async function () {
      const { baseBorrowIndex } = await comet.totalsBasic();
      const indexScale = await comet.baseIndexScale();
      expect(baseBorrowIndex).to.be.equal(INDEX_SCALE);
      expect(baseBorrowIndex).to.be.equal(indexScale);
    });
    it('tracking supply index should be 0 in initial state', async function () {
      const { trackingSupplyIndex } = await comet.totalsBasic();
      expect(trackingSupplyIndex).to.be.equal(0);
    });
    it('tracking borrow index should be 0 in initial state', async function () {
      const { trackingBorrowIndex } = await comet.totalsBasic();
      expect(trackingBorrowIndex).to.be.equal(0);
    });
    it('total supply should be 0 in initial state', async function () {
      const { totalSupplyBase } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(0);
    });
    it('total borrow should be 0 in initial state', async function () {
      const { totalBorrowBase } = await comet.totalsBasic();
      expect(totalBorrowBase).to.equal(0);
    });
    it('accruing with no positions should be possible', async function () {
      expect(await comet.accrueAccount(alice.address)).to.not.be.revert(ethers);
    });
    it('utilization should still be 0 after accrue with no borrowers', async function () {
      expect(await comet.getUtilization()).to.equal(0);
    });
    it('supply index should increase after accrue', async function () {
      const { baseSupplyIndex } = await comet.totalsBasic();
      const currentBlock = await ethers.provider.getBlock('latest');
      if (!currentBlock) throw new Error('Latest block not found');
      const timeElapsed = currentBlock.timestamp - timeBefore;
      const yearTime = 365 * oneDay;
      const supplyPerSecond = (BigInt(config.supplyInterestRateBase) / BigInt(yearTime));
      const factorScale = await comet.factorScale();
      const expectedSupplyIndexAccrued = (((BigInt(INDEX_SCALE) * BigInt(supplyPerSecond)) * BigInt(timeElapsed)) / BigInt(factorScale));
      const expectedSupplyIndex = (BigInt(INDEX_SCALE) + BigInt(expectedSupplyIndexAccrued));
      expect(baseSupplyIndex).to.equal(expectedSupplyIndex);
    });
    it('borrow index should increase after accrue', async function () {
      const { baseBorrowIndex } = await comet.totalsBasic();
      const currentBlock = await ethers.provider.getBlock('latest');
      if (!currentBlock) throw new Error('Latest block not found');
      const timeElapsed = currentBlock.timestamp - timeBefore;
      const yearTime = 365 * oneDay;
      const borrowPerSecond = (BigInt(config.borrowInterestRateBase) / BigInt(yearTime));
      const factorScale = await comet.factorScale();
      const expectedBorrowIndexAccrued = (((BigInt(INDEX_SCALE) * BigInt(borrowPerSecond)) * BigInt(timeElapsed)) / BigInt(factorScale));
      const expectedBorrowIndex = (BigInt(INDEX_SCALE) + BigInt(expectedBorrowIndexAccrued));
      expect(baseBorrowIndex).to.equal(expectedBorrowIndex);
    });
    it('total supply should remain 0 after accrue', async function () {
      const { totalSupplyBase } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(0);
    });
    it('total borrow should remain 0 after accrue', async function () {
      const { totalBorrowBase } = await comet.totalsBasic();
      expect(totalBorrowBase).to.equal(0);
    });
    it('user position is not affected by accrue with no activity', async function () {
      const userBasicAfter = await comet.userBasic(alice.address);
      expect(userBasicAfter).to.deep.equal(userBasicBefore);
    });
    describe('seeding reserves', function () {
      let totalsBefore: TotalsBasicStructOutput;
      let totalsAfter: TotalsBasicStructOutput;
      let timeElapsed: bigint;
      before(async function () {
        totalsBefore = await comet.totalsBasic();
        await baseToken.allocateTo((await comet.getAddress()), seedAmount);
        await ethers.provider.send('evm_increaseTime', [oneDay]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
        totalsAfter = await comet.totalsBasic();
        timeElapsed = totalsAfter.lastAccrualTime - totalsBefore.lastAccrualTime;
      });
      describe('seeding reserves impact on index accrual over time', function () {
        it('supply index should continue accruing over time after seeding', async function () {
          const expectedSupplyIndex = (totalsBefore.baseSupplyIndex + BigInt((((totalsBefore.baseSupplyIndex * BigInt(supplyRatePerSecond)) * BigInt(timeElapsed)) / BigInt(exp(1, 18)))));
          expect(totalsAfter.baseSupplyIndex).to.equal(expectedSupplyIndex);
        });
        it('borrow index should continue accruing over time after seeding', async function () {
          const expectedBorrowIndex = (totalsBefore.baseBorrowIndex + BigInt((((totalsBefore.baseBorrowIndex * BigInt(borrowRatePerSecond)) * BigInt(timeElapsed)) / BigInt(exp(1, 18)))));
          expect(totalsAfter.baseBorrowIndex).to.equal(expectedBorrowIndex);
        });
      });
      describe('seeding reserves do not impact on protocol accounting', function () {
        it('tracking supply index should remain unchanged after seeding', async function () {
          expect(totalsAfter.trackingSupplyIndex).to.equal(totalsBefore.trackingSupplyIndex);
        });
        it('tracking borrow index should remain unchanged after seeding', async function () {
          expect(totalsAfter.trackingBorrowIndex).to.equal(totalsBefore.trackingBorrowIndex);
        });
        it('total supply base should remain unchanged after seeding', async function () {
          expect(totalsAfter.totalSupplyBase).to.equal(totalsBefore.totalSupplyBase);
        });
        it('total borrow base should remain unchanged after seeding', async function () {
          expect(totalsAfter.totalBorrowBase).to.equal(totalsBefore.totalBorrowBase);
        });
        it('user position should remain unchanged after seeding', async function () {
          const userBasicAfter = await comet.userBasic(alice.address);
          expect(userBasicAfter).to.deep.equal(userBasicBefore);
        });
      });
    });
  });
  describe('lending position', function () {
    let totalsBefore: TotalsBasicStructOutput;
    let totalSupplyBaseAfterSupply: bigint;
    let userBasicBefore: UserBasic;
    before(async function () {
      totalsBefore = await comet.totalsBasic();
    });
    it('should allow supplying', async function () {
      await baseToken.allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve((await comet.getAddress()), supplyAmount);
      await comet.connect(alice).supply((await baseToken.getAddress()), supplyAmount);
    });
    it('last accrue should be with supply', async function () {
      const block = await ethers.provider.getBlock('latest');
      if (!block) throw new Error('Latest block not found');
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.lastAccrualTime).to.equal(block.timestamp);
    });
    it('utilization should be 0 with no borrowers', async function () {
      expect(await comet.getUtilization()).to.equal(0);
    });
    it('supply index should increase after supply', async function () {
      const totalsAfter = await comet.totalsBasic();
      const supplyRatePerSecond = (BigInt(config.supplyInterestRateBase) / BigInt(365 * oneDay));
      expect(totalsAfter.baseSupplyIndex).to.equal((totalsBefore.baseSupplyIndex + BigInt((((totalsBefore.baseSupplyIndex * BigInt(supplyRatePerSecond)) * BigInt(3)) / BigInt(exp(1, 18))))));
    });
    it('tracking supply index should not change after supply with utilization = 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.trackingSupplyIndex).to.equal(totalsBefore.trackingSupplyIndex);
    });
    it('total supply base should reflect supplied principal', async function () {
      const totalsAfter = await comet.totalsBasic();
      const expectedPrincipal = ((BigInt(supplyAmount) * BigInt(INDEX_SCALE)) / BigInt(totalsAfter.baseSupplyIndex));
      expectApproximately(totalsAfter.totalSupplyBase, expectedPrincipal, 1n);
      totalSupplyBaseAfterSupply = totalsAfter.totalSupplyBase;
    });
    it('borrow index should increase after supply', async function () {
      const totalsAfter = await comet.totalsBasic();
      const borrowRatePerSecond = (BigInt(config.borrowInterestRateBase) / BigInt(365 * oneDay));
      expect(totalsAfter.baseBorrowIndex).to.equal((totalsBefore.baseBorrowIndex + BigInt((((totalsBefore.baseBorrowIndex * BigInt(borrowRatePerSecond)) * BigInt(3)) / BigInt(exp(1, 18))))));
    });
    it('tracking borrow index should not change after supply with utilization = 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.trackingBorrowIndex).to.equal(totalsBefore.trackingBorrowIndex);
    });
    it('total borrow base should not change after supply', async function () {
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalBorrowBase).to.equal(totalsBefore.totalBorrowBase);
    });
    it('skip time and accrue', async function () {
      // Fast forward a month
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      userBasicBefore = await comet.userBasic(alice.address);
      await comet.accrueAccount(alice.address);
    });
    it('supply index should accrue with utilization = 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      const supplyRate = await comet.getSupplyRate(0);
      expectApproximately(totalsAfter.baseSupplyIndex, (totalsBefore.baseSupplyIndex + BigInt((((totalsBefore.baseSupplyIndex * BigInt(supplyRate)) * BigInt(oneMonth)) / BigInt(exp(1, 18))))), (supplyRate / BigInt(100)));
    });
    it('tracking supply index should accrue with utilization = 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.trackingSupplyIndex).to.equal((BigInt(0) + BigInt((((BigInt(config.baseTrackingSupplySpeed) * BigInt(oneMonth + 1)) * BigInt(baseTokenScale)) / BigInt(totalsAfter.totalSupplyBase)))));
    });
    it('total supply base should not change after accrue', async function () {
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalSupplyBase).to.equal(totalSupplyBaseAfterSupply);
    });
    it('borrow index should accrue with utilization = 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      const borrowRatePerSecond = (BigInt(config.borrowInterestRateBase) / BigInt(365 * oneDay));
      expectApproximately(totalsAfter.baseBorrowIndex, (totalsBefore.baseBorrowIndex + BigInt((((totalsBefore.baseBorrowIndex * BigInt(borrowRatePerSecond)) * BigInt(oneMonth)) / BigInt(exp(1, 18))))), (borrowRatePerSecond / BigInt(100)));
    });
    it('total borrow base should not change after accrue', async function () {
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalBorrowBase).to.equal(totalsBefore.totalBorrowBase);
    });
    it('user principal should not change after accrue', async function () {
      const userBasicAfter = await comet.userBasic(alice.address);
      expect(userBasicAfter.principal).to.be.equal(userBasicBefore.principal);
    });
    it('user tracking index should accrue after supply interest', async function () {
      const userBasicAfter = await comet.userBasic(alice.address);
      const totalsAfter = await comet.totalsBasic();
      const expectedTrackingIndex = (userBasicBefore.baseTrackingIndex + BigInt((((BigInt(config.baseTrackingSupplySpeed) * BigInt(oneMonth + 1)) * BigInt(baseTokenScale)) / BigInt(totalsAfter.totalSupplyBase))));
      expectApproximately(userBasicAfter.baseTrackingIndex, expectedTrackingIndex, 1n);
    });
    it('user tracking accrued should accrue after supply interest', async function () {
      const userBasicAfter = await comet.userBasic(alice.address);
      const totalsAfter = await comet.totalsBasic();
      const expectedTrackingAccrued = ((userBasicBefore.principal * BigInt((totalsAfter.trackingSupplyIndex - BigInt(userBasicBefore.baseTrackingIndex)))) / BigInt(INDEX_SCALE));
      expect(userBasicAfter.baseTrackingAccrued).to.equal(expectedTrackingAccrued);
    });
    it('user assetsIn should not change after accrue', async function () {
      const userBasicAfter = await comet.userBasic(alice.address);
      expect(userBasicAfter.assetsIn).to.equal(userBasicBefore.assetsIn);
    });
  });
  describe('borrowing position', function () {
    const borrowAmount = exp(100, baseTokenDecimals);
    let totalsBefore: TotalsBasicStructOutput;
    let userBasicBefore: UserBasic;
    let supplyRateBefore: bigint;
    let borrowRateBefore: bigint;
    before(async function () {
      // Bob supplies 1 WETH as collateral
      await collaterals.WETH.connect(bob).allocateTo(bob.address, exp(1, 18));
      await collaterals.WETH.connect(bob).approve((await comet.getAddress()), exp(1, 18));
      await comet.connect(bob).supply((await collaterals.WETH.getAddress()), exp(1, 18));
      expect(await comet.connect(bob).withdraw((await baseToken.getAddress()), borrowAmount)).to.not.be.revert(ethers);
      totalsBefore = await comet.totalsBasic();
      userBasicBefore = await comet.userBasic(bob.address);
      const utilization = await comet.getUtilization();
      supplyRateBefore = await comet.getSupplyRate(utilization);
      borrowRateBefore = await comet.getBorrowRate(utilization);
    });
    it('utilization should be > 0 after borrowing', async function () {
      const utilization = await comet.getUtilization();
      expect(utilization).to.be.gt(0);
    });
    it('skip a month to accrue interest', async function () {
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
    });
    it('should allow accruing with utilization > 0', async function () {
      await comet.accrueAccount(bob.address);
    });
    it('supply index should accrue with utilization > 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      const timeElapsed = totalsAfter.lastAccrualTime - totalsBefore.lastAccrualTime;
      expect(totalsAfter.baseSupplyIndex).to.be.equal((totalsBefore.baseSupplyIndex + BigInt((((totalsBefore.baseSupplyIndex * BigInt(supplyRateBefore)) * BigInt(timeElapsed)) / BigInt(exp(1, 18))))));
    });
    it('tracking supply index should accrue with utilization > 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      const timeElapsed = totalsAfter.lastAccrualTime - totalsBefore.lastAccrualTime;
      expect(totalsAfter.trackingSupplyIndex).to.equal((totalsBefore.trackingSupplyIndex + BigInt((((BigInt(config.baseTrackingSupplySpeed) * BigInt(timeElapsed)) * BigInt(baseTokenScale)) / BigInt(totalsBefore.totalSupplyBase)))));
    });
    it('total supply base should not change after accrue with utilization > 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalSupplyBase).to.equal(totalsBefore.totalSupplyBase);
    });
    it('borrow index should accrue with utilization > 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      const timeElapsed = totalsAfter.lastAccrualTime - totalsBefore.lastAccrualTime;
      expect(totalsAfter.baseBorrowIndex).to.be.equal((totalsBefore.baseBorrowIndex + BigInt((((totalsBefore.baseBorrowIndex * BigInt(borrowRateBefore)) * BigInt(timeElapsed)) / BigInt(exp(1, 18))))));
    });
    it('tracking borrow index should accrue with utilization > 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      const timeElapsed = totalsAfter.lastAccrualTime - totalsBefore.lastAccrualTime;
      expect(totalsAfter.trackingBorrowIndex).to.equal((totalsBefore.trackingBorrowIndex + BigInt((((BigInt(config.baseTrackingBorrowSpeed) * BigInt(timeElapsed)) * BigInt(baseTokenScale)) / BigInt(totalsBefore.totalBorrowBase)))));
    });
    it('total borrow base should not change after accrue with utilization > 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalBorrowBase).to.equal(totalsBefore.totalBorrowBase);
    });
    it('user principal should not change after borrow accrue', async function () {
      const userBasicAfter = await comet.userBasic(bob.address);
      expect(userBasicAfter.principal).to.be.equal(userBasicBefore.principal);
    });
    it('user tracking index should accrue after borrow interest', async function () {
      const userBasicAfter = await comet.userBasic(bob.address);
      const totalsAfter = await comet.totalsBasic();
      const expectedBorrowTrackingIndex = (userBasicBefore.baseTrackingIndex + BigInt((((BigInt(config.baseTrackingBorrowSpeed) * BigInt(oneMonth + 1)) * BigInt(baseTokenScale)) / BigInt(totalsAfter.totalBorrowBase))));
      expectApproximately(userBasicAfter.baseTrackingIndex, expectedBorrowTrackingIndex, 1n);
    });
    it('user tracking accrued should accrue after borrow interest', async function () {
      const userBasicAfter = await comet.userBasic(bob.address);
      const totalsAfter = await comet.totalsBasic();
      const expectedBorrowTrackingAccrued = (((userBasicBefore.principal * BigInt(-1)) * BigInt((totalsAfter.trackingBorrowIndex - BigInt(userBasicBefore.baseTrackingIndex)))) / BigInt(INDEX_SCALE));
      expect(userBasicAfter.baseTrackingAccrued).to.equal(expectedBorrowTrackingAccrued);
    });
    it('user assetsIn should not change after borrow accrue', async function () {
      const userBasicAfter = await comet.userBasic(bob.address);
      expect(userBasicAfter.assetsIn).to.equal(userBasicBefore.assetsIn);
    });
  });
  describe('repay', function () {
    it('borrow position exists', async function () {
      const borrowBalance = await comet.borrowBalanceOf(bob.address);
      expect(borrowBalance).to.be.gt(0);
    });
    it('should allow repaying borrowed position', async function () {
      const repayAmount = ((await comet.borrowBalanceOf(bob.address)) + BigInt(100)); // overpay to account for interest
      await baseToken.connect(bob).allocateTo(bob.address, repayAmount);
      await baseToken.connect(bob).approve((await comet.getAddress()), repayAmount);
      await comet.connect(bob).supply((await baseToken.getAddress()), repayAmount);
    });
    it('borrow balance should be 0 after repay', async function () {
      expect(await comet.borrowBalanceOf(bob.address)).to.equal(0);
    });
    it('utilization should be 0 after repay', async function () {
      expect(await comet.getUtilization()).to.equal(0);
    });
    it('user position should change to supply after repay', async function () {
      const userBasic = await comet.userBasic(bob.address);
      expect(userBasic.principal).to.be.gt(0);
    });
    describe('accruing after repay', function () {
      let totalsBefore: TotalsBasicStructOutput;
      let totalsAfter: TotalsBasicStructOutput;
      let userBasicBefore: UserBasic;
      let userBasicAfter: UserBasic;
      before(async function () {
        totalsBefore = await comet.totalsBasic();
        userBasicBefore = await comet.userBasic(bob.address);
        await comet.accrueAccount(bob.address);
        totalsAfter = await comet.totalsBasic();
        userBasicAfter = await comet.userBasic(bob.address);
      });
      it('supply index should update after repay accrue', async function () {
        expect(totalsAfter.baseSupplyIndex).to.be.equal((totalsBefore.baseSupplyIndex + BigInt((((totalsBefore.baseSupplyIndex * BigInt(await comet.getSupplyRate(0))) * BigInt(1)) / BigInt(exp(1, 18))))));
      });
      it('tracking supply index should update after repay accrue', async function () {
        expect(totalsAfter.trackingSupplyIndex).to.equal((totalsBefore.trackingSupplyIndex + BigInt((((BigInt(config.baseTrackingSupplySpeed) * BigInt(1)) * BigInt(baseTokenScale)) / BigInt(totalsBefore.totalSupplyBase)))));
      });
      it('borrow index should update after repay accrue', async function () {
        expect(totalsAfter.baseBorrowIndex).to.be.equal((totalsBefore.baseBorrowIndex + BigInt((((totalsBefore.baseBorrowIndex * BigInt(await comet.getBorrowRate(0))) * BigInt(1)) / BigInt(exp(1, 18))))));
      });
      it('tracking borrow index should not change after repay accrue', async function () {
        expect(totalsAfter.trackingBorrowIndex).to.equal(totalsBefore.trackingBorrowIndex);
      });
      it('user principal should not change after repay accrue', async function () {
        expect(userBasicAfter.principal).to.equal(userBasicBefore.principal);
      });
      it('user tracking index should not change after repay accrue', async function () {
        expectApproximately(userBasicAfter.baseTrackingIndex, userBasicBefore.baseTrackingIndex, 200_000_000n);
      });
      it('user tracking accrued should not change after repay accrue', async function () {
        expect(userBasicAfter.baseTrackingAccrued).to.equal(userBasicBefore.baseTrackingAccrued);
      });
      it('user assetsIn should not change after repay accrue', async function () {
        expect(userBasicAfter.assetsIn).to.equal(userBasicBefore.assetsIn);
      });
    });
  });
  describe('liquidation', function () {
    const suppliedCollateral = exp(1, 18);
    let borrowedAmount: bigint;
    let liquidatedAmount: bigint;
    before(async function () {
      // Prepare position for liquidation
      await collaterals.WETH.connect(dave).allocateTo(dave.address, suppliedCollateral);
      await collaterals.WETH.connect(dave).approve((await comet.getAddress()), suppliedCollateral);
      await comet.connect(dave).supply((await collaterals.WETH.getAddress()), suppliedCollateral);
      const maxBorrow = await comet.getBorrowLimit(dave.address);
      borrowedAmount = maxBorrow;
      await comet.connect(dave).withdraw((await baseToken.getAddress()), maxBorrow);
      // Drop WETH price by 20% to make position liquidatable
      const currentPrice = exp(3000, 8);
      const droppedPrice = ((BigInt(currentPrice) * BigInt(80)) / BigInt(100)); // 20% drop
      await priceFeeds.WETH.setPrice(droppedPrice);
    });
    it('position should be underwater', async function () {
      const isLiquidatable = await comet.isLiquidatable(dave.address);
      expect(isLiquidatable).to.equal(true);
    });
    it('should allow liquidation', async function () {
      const liquidateTx = await comet.connect(alice).absorb(alice.address, [dave.address]);
      const receipt = await liquidateTx.wait();
      if (!receipt) throw new Error('Liquidation transaction receipt not found');
      const cometAddress = await comet.getAddress();
      const absorbDebt = receipt.logs.find((log): log is EventLog =>
        log.address.toLowerCase() === cometAddress.toLowerCase() &&
          'args' in log && log.fragment.name === 'AbsorbDebt'
      );
      if (!absorbDebt) throw new Error('AbsorbDebt event not found');
      liquidatedAmount = absorbDebt.args.basePaidOut;
      expect(liquidatedAmount).to.be.gt(borrowedAmount);
    });
    describe('accruing after liquidation', function () {
      let totalsBefore: TotalsBasicStructOutput;
      let totalsAfter: TotalsBasicStructOutput;
      let _userBasicBefore: UserBasic;
      let userBasicAfter: UserBasic;
      before(async function () {
        totalsBefore = await comet.totalsBasic();
        _userBasicBefore = await comet.userBasic(dave.address);
        await comet.accrueAccount(dave.address);
        totalsAfter = await comet.totalsBasic();
        userBasicAfter = await comet.userBasic(dave.address);
      });
      it('supply index should update after liquidation accrue', async function () {
        expect(totalsAfter.baseSupplyIndex).to.be.equal((totalsBefore.baseSupplyIndex + BigInt((((totalsBefore.baseSupplyIndex * BigInt(await comet.getSupplyRate(0))) * BigInt(1)) / BigInt(exp(1, 18))))));
      });
      it('tracking supply index should update after liquidation accrue', async function () {
        expect(totalsAfter.trackingSupplyIndex).to.equal((totalsBefore.trackingSupplyIndex + BigInt((((BigInt(config.baseTrackingSupplySpeed) * BigInt(1)) * BigInt(baseTokenScale)) / BigInt(totalsBefore.totalSupplyBase)))));
      });
      it('borrow index should update after liquidation accrue', async function () {
        expect(totalsAfter.baseBorrowIndex).to.be.equal((totalsBefore.baseBorrowIndex + BigInt((((totalsBefore.baseBorrowIndex * BigInt(await comet.getBorrowRate(0))) * BigInt(1)) / BigInt(exp(1, 18))))));
      });
      it('tracking borrow index should not change after liquidation accrue', async function () {
        expect(totalsAfter.trackingBorrowIndex).to.equal(totalsBefore.trackingBorrowIndex);
      });
      it('user principal should not change after liquidation accrue', async function () {
        expect(userBasicAfter.principal).to.equal(_userBasicBefore.principal);
      });
      it('user tracking index should update to current supply tracking index after liquidation accrue', async function () {
        expect(userBasicAfter.baseTrackingIndex).to.equal(totalsAfter.trackingSupplyIndex);
      });
      it('user tracking accrued should not change after liquidation accrue', async function () {
        expect(userBasicAfter.baseTrackingAccrued).to.equal(_userBasicBefore.baseTrackingAccrued);
      });
      it('user assetsIn should not change after liquidation accrue', async function () {
        expect(userBasicAfter.assetsIn).to.equal(_userBasicBefore.assetsIn);
      });
    });
  });
  describe('accrueAccount idempotency within the same block', function () {
    let snapshot: SnapshotRestorer;
    before(async function () {
      snapshot = await takeSnapshot();
    });
    after(async function () {
      await snapshot.restore();
    });
    it('calling accrueAccount twice in the same block should be a no-op', async function () {
      await ethers.provider.send('evm_increaseTime', [oneDay]);
      await ethers.provider.send('evm_mine', []);
      const totalsBefore = await comet.totalsBasic();
      await ethers.provider.send('evm_setAutomine', [false]);
      try {
        await comet.accrueAccount(alice.address);
        await comet.accrueAccount(alice.address);
        await ethers.provider.send('evm_mine', []);
      } finally {
        await ethers.provider.send('evm_setAutomine', [true]);
      }
      const totalsAfter = await comet.totalsBasic();
      const timeElapsed = totalsAfter.lastAccrualTime - totalsBefore.lastAccrualTime;
      // If the second call also accrued, indices would be double. Verify single accrual.
      const supplyRate = await comet.getSupplyRate(await comet.getUtilization());
      const borrowRate = await comet.getBorrowRate(await comet.getUtilization());
      const expectedSupplyIndex = (totalsBefore.baseSupplyIndex + BigInt((((totalsBefore.baseSupplyIndex * BigInt(supplyRate)) * BigInt(timeElapsed)) / BigInt(FACTOR_SCALE))));
      const expectedBorrowIndex = (totalsBefore.baseBorrowIndex + BigInt((((totalsBefore.baseBorrowIndex * BigInt(borrowRate)) * BigInt(timeElapsed)) / BigInt(FACTOR_SCALE))));
      expect(totalsAfter.baseSupplyIndex).to.equal(expectedSupplyIndex);
      expect(totalsAfter.baseBorrowIndex).to.equal(expectedBorrowIndex);
    });
  });
  describe('user state is not updated without explicit accrueAccount', function () {
    let snapshot: SnapshotRestorer;
    before(async function () {
      snapshot = await takeSnapshot();
    });
    after(async function () {
      await snapshot.restore();
    });
    it('alice tracking should remain stale when only bob triggers global accrue', async function () {
      const aliceBasicBefore = await comet.userBasic(alice.address);
      // Bob's supply triggers accrueInternal, advancing global state
      await baseToken.allocateTo(bob.address, supplyAmount);
      await baseToken.connect(bob).approve((await comet.getAddress()), supplyAmount);
      await comet.connect(bob).supply((await baseToken.getAddress()), supplyAmount);
      await ethers.provider.send('evm_increaseTime', [oneDay]);
      await ethers.provider.send('evm_mine', []);
      // Only bob is accrued here, alice's user-level state should not update
      await comet.accrueAccount(bob.address);
      const totalsAfter = await comet.totalsBasic();
      const aliceBasicAfter = await comet.userBasic(alice.address);
      // Global tracking index advanced
      expect(totalsAfter.trackingSupplyIndex).to.be.gt(aliceBasicBefore.baseTrackingIndex);
      // Alice's user-level state remains unchanged — no accrueAccount was called for her
      expect(aliceBasicAfter).to.deep.equal(aliceBasicBefore);
    });
  });
  describe('balanceOf increasing over time', function () {
    let snapshot: SnapshotRestorer;
    before(async function () {
      snapshot = await takeSnapshot();
    });
    after(async function () {
      await snapshot.restore();
    });
    it('supplier balanceOf should increase after index accrual', async function () {
      const balanceBefore = await comet.balanceOf(alice.address);
      expect(balanceBefore).to.be.gt(0);
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(alice.address);
      const balanceAfter = await comet.balanceOf(alice.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
      // Principal should remain unchanged
      const userBasic = await comet.userBasic(alice.address);
      const { baseSupplyIndex } = await comet.totalsBasic();
      const expectedBalance = ((BigInt(userBasic.principal) * BigInt(baseSupplyIndex)) / BigInt(INDEX_SCALE));
      expect(balanceAfter).to.equal(expectedBalance);
    });
  });
  describe('lastAccrualTime after standalone accrueAccount', function () {
    let snapshot: SnapshotRestorer;
    before(async function () {
      snapshot = await takeSnapshot();
    });
    after(async function () {
      await snapshot.restore();
    });
    it('lastAccrualTime should equal block.timestamp after accrueAccount', async function () {
      await ethers.provider.send('evm_increaseTime', [oneDay]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(alice.address);
      const block = await ethers.provider.getBlock('latest');
      if (!block) throw new Error('Latest block not found');
      const { lastAccrualTime } = await comet.totalsBasic();
      expect(lastAccrualTime).to.equal(block.timestamp);
    });
  });
  describe('edge cases', function () {
    let snapshot: SnapshotRestorer;
    beforeEach(async function () {
      snapshot = await takeSnapshot();
    });
    it('should revert when skipping too much time', async function () {
      const block = await ethers.provider.getBlock('latest');
      if (!block) throw new Error('Latest block not found');
      const uint40Max = ((BigInt(2) ** BigInt(40)) - BigInt(1));
      const timeToSkip = getNumber(((uint40Max - BigInt(block.timestamp)) + BigInt(1)));
      await ethers.provider.send('evm_increaseTime', [timeToSkip]);
      await ethers.provider.send('evm_mine', []);
      await expect(comet.accrueAccount(alice.address)).to.be.revertedWithCustomError(comet, 'TimestampTooLarge');
      await snapshot.restore();
    });
    it('should revert when supply rate is too high', async function () {
      const protocol = await makeProtocol({
        base: 'USDC',
        supplyInterestRateBase: exp(18, 18),
        assets: defaultAssets({}, {
          WETH: {
            decimals: 18,
            borrowCF: exp(0.8, 18),
            liquidateCF: exp(0.95, 18),
            liquidationFactor: exp(0.95, 18),
          },
        }),
      });
      const comet = protocol.cometWithExtendedAssetList;
      let collaterals: {
                [symbol: string]: FaucetToken;
            } = {};
      let priceFeeds: {
                [symbol: string]: SimplePriceFeed;
            } = {};
      const baseToken = protocol.tokens.USDC as FaucetToken;
      for (const asset in protocol.tokens) {
        if (asset === 'USDC')
          continue;
        collaterals[asset] = protocol.tokens[asset] as FaucetToken;
      }
      for (const asset in protocol.priceFeeds) {
        priceFeeds[asset] = protocol.priceFeeds[asset];
      }
      const [alice, bob] = protocol.users;
      const supplyAmount = exp(1000, baseTokenDecimals);
      await baseToken.allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve((await comet.getAddress()), supplyAmount);
      await comet.connect(alice).supply((await baseToken.getAddress()), supplyAmount);
      const asset0Info = await comet.getAssetInfo(0);
      const priceAsset = (await priceFeeds.WETH.latestRoundData())[1];
      const priceBase = (await priceFeeds.USDC.latestRoundData())[1];
      // ERC20 decimals is uint8, so it is safe to use as a numeric exponent.
      const asset0Decimals = getNumber(await collaterals.WETH.decimals());
      let amountCollateralToSupply: bigint;
      if (asset0Decimals > baseTokenDecimals) {
        const rescaleFactor = exp(1, asset0Decimals - baseTokenDecimals);
        amountCollateralToSupply = (((((((BigInt(supplyAmount) * BigInt(rescaleFactor)) * BigInt(priceBase)) * BigInt(FACTOR_SCALE)) * BigInt(50)) / BigInt(asset0Info.borrowCollateralFactor)) / BigInt(priceAsset)) / BigInt(100));
      }
      else {
        const rescaleFactor = exp(1, baseTokenDecimals - asset0Decimals);
        amountCollateralToSupply = (((((((BigInt(supplyAmount) * BigInt(priceBase)) * BigInt(FACTOR_SCALE)) * BigInt(50)) / BigInt(asset0Info.borrowCollateralFactor)) / BigInt(priceAsset)) / BigInt(rescaleFactor)) / BigInt(100));
      }
      await collaterals.WETH.allocateTo(bob.address, amountCollateralToSupply);
      await collaterals.WETH.connect(bob).approve((await comet.getAddress()), amountCollateralToSupply);
      await comet.connect(bob).supply((await collaterals.WETH.getAddress()), amountCollateralToSupply);
      const borrowLimit = await comet.getBorrowLimit(bob.address);
      await comet.connect(bob).withdraw((await baseToken.getAddress()), borrowLimit);
      const utilization = await comet.getUtilization();
      const supplyRate = await comet.getSupplyRate(utilization);
      const totals = await comet.totalsBasic();
      const uint64Max = ((BigInt(2) ** BigInt(64)) - BigInt(1));
      const timeToOverflow = getNumber((((uint64Max * BigInt(FACTOR_SCALE)) / BigInt((totals.baseSupplyIndex * BigInt(supplyRate)))) + BigInt(1)));
      await ethers.provider.send('evm_increaseTime', [timeToOverflow]);
      await ethers.provider.send('evm_mine', []);
      await expect(comet.accrueAccount(alice.address)).to.be.revertedWithCustomError(comet, 'InvalidUInt64');
      await snapshot.restore();
    });
    it('should revert when borrow rate is too high', async function () {
      const protocol = await makeProtocol({
        base: 'USDC',
        borrowInterestRateBase: exp(18, 18),
        assets: defaultAssets({}, {
          WETH: {
            decimals: 18,
            borrowCF: exp(0.8, 18),
            liquidateCF: exp(0.95, 18),
            liquidationFactor: exp(0.95, 18),
          },
        }),
      });
      const comet = protocol.cometWithExtendedAssetList;
      let collaterals: {
                [symbol: string]: FaucetToken;
            } = {};
      let priceFeeds: {
                [symbol: string]: SimplePriceFeed;
            } = {};
      const baseToken = protocol.tokens.USDC as FaucetToken;
      for (const asset in protocol.tokens) {
        if (asset === 'USDC')
          continue;
        collaterals[asset] = protocol.tokens[asset] as FaucetToken;
      }
      for (const asset in protocol.priceFeeds) {
        priceFeeds[asset] = protocol.priceFeeds[asset];
      }
      const [alice, bob] = protocol.users;
      const supplyAmount = exp(1000, baseTokenDecimals);
      await baseToken.allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve((await comet.getAddress()), supplyAmount);
      await comet.connect(alice).supply((await baseToken.getAddress()), supplyAmount);
      const asset0Info = await comet.getAssetInfo(0);
      const priceAsset = (await priceFeeds.WETH.latestRoundData())[1];
      const priceBase = (await priceFeeds.USDC.latestRoundData())[1];
      // ERC20 decimals is uint8, so it is safe to use as a numeric exponent.
      const asset0Decimals = getNumber(await collaterals.WETH.decimals());
      let amountCollateralToSupply: bigint;
      if (asset0Decimals > baseTokenDecimals) {
        const rescaleFactor = exp(1, asset0Decimals - baseTokenDecimals);
        amountCollateralToSupply = (((((((BigInt(supplyAmount) * BigInt(rescaleFactor)) * BigInt(priceBase)) * BigInt(FACTOR_SCALE)) * BigInt(50)) / BigInt(asset0Info.borrowCollateralFactor)) / BigInt(priceAsset)) / BigInt(100));
      }
      else {
        const rescaleFactor = exp(1, baseTokenDecimals - asset0Decimals);
        amountCollateralToSupply = (((((((BigInt(supplyAmount) * BigInt(priceBase)) * BigInt(FACTOR_SCALE)) * BigInt(50)) / BigInt(asset0Info.borrowCollateralFactor)) / BigInt(priceAsset)) / BigInt(rescaleFactor)) / BigInt(100));
      }
      await collaterals.WETH.allocateTo(bob.address, amountCollateralToSupply);
      await collaterals.WETH.connect(bob).approve((await comet.getAddress()), amountCollateralToSupply);
      await comet.connect(bob).supply((await collaterals.WETH.getAddress()), amountCollateralToSupply);
      const borrowLimit = await comet.getBorrowLimit(bob.address);
      await comet.connect(bob).withdraw((await baseToken.getAddress()), borrowLimit);
      const utilization = await comet.getUtilization();
      const borrowRate = await comet.getBorrowRate(utilization);
      const totals = await comet.totalsBasic();
      const uint64Max = ((BigInt(2) ** BigInt(64)) - BigInt(1));
      const timeToOverflow = getNumber((((uint64Max * BigInt(FACTOR_SCALE)) / BigInt((totals.baseBorrowIndex * BigInt(borrowRate)))) + BigInt(1)));
      await ethers.provider.send('evm_increaseTime', [timeToOverflow]);
      await ethers.provider.send('evm_mine', []);
      await expect(comet.accrueAccount(alice.address)).to.be.revertedWithCustomError(comet, 'InvalidUInt64');
      await snapshot.restore();
    });
  });
});


// Preserve the original exact accrual, reward-threshold and overflow regressions.
const cometErrors = {
  interface: CometHarnessExtendedAssetList__factory.createInterface(),
};

function projectBaseIndex(index: bigint, rate: bigint, time: bigint, factorScale = exp(1, 18)) {
  return index + index * rate * time / factorScale;
}

function projectTrackingIndex(index: bigint, speed: bigint, time: bigint, base: bigint, baseScale = exp(1, 6)) {
  return index + speed * time * baseScale / base;
}

describe('accrue accounting regressions', function () {
  let snapshotId: string;

  beforeEach(async () => {
    snapshotId = await ethers.provider.send('evm_snapshot', []);
  });

  afterEach(async () => {
    await ethers.provider.send('evm_revert', [snapshotId]);
  });

  it('fails if baseMinForRewards = 0', async () => {
    await expect(
      makeProtocol({
        baseMinForRewards: 0,
      })
    ).to.be.revertedWithCustomError(cometErrors, 'BadMinimum');
  });

  it('accrue initially succeeds and has the right parameters', async () => {
    const start = (await getBlock()).timestamp + 100;

    const params = {
      baseMinForRewards: 12331,
      baseTrackingSupplySpeed: 668,
      baseTrackingBorrowSpeed: 777,
      start
    };
    const { cometWithExtendedAssetList : comet } = await makeProtocol(params);

    const t0 = await comet.totalsBasic();
    expect(t0.trackingSupplyIndex).to.be.equal(0n);
    expect(t0.trackingBorrowIndex).to.be.equal(0n);
    expect(t0.baseSupplyIndex).to.be.equal(exp(1, 15));
    expect(t0.baseBorrowIndex).to.be.equal(exp(1, 15));
    expect(t0.totalSupplyBase).to.be.equal(0n);
    expect(t0.totalBorrowBase).to.be.equal(0n);

    expect(t0.lastAccrualTime).to.equal(start);

    const _a0 = await wait(comet.accrue());
    expect(await comet.baseMinForRewards()).to.be.equal(params.baseMinForRewards);
    expect(await comet.baseTrackingSupplySpeed()).to.be.equal(params.baseTrackingSupplySpeed);
    expect(await comet.baseTrackingBorrowSpeed()).to.be.equal(params.baseTrackingBorrowSpeed);
  });

  it('accrues correctly with no time elapsed', async () => {
    const { cometWithExtendedAssetList : comet } = await makeProtocol();

    const now = Math.floor(Date.now() / 1000);
    const _f0 = await wait(comet.setNow(now)); // this freezes the timestamp for the entire test

    const totals = {
      trackingSupplyIndex: 0,
      trackingBorrowIndex: 0,
      baseSupplyIndex: 2e15,
      baseBorrowIndex: 3e15,
      totalSupplyBase: 1000n,
      totalBorrowBase: 1000n,
      lastAccrualTime: 0,
      pauseFlags: 0,
    };
    const _s0 = await wait(comet.setTotalsBasic(totals));

    const t0 = await comet.totalsBasic();
    const _a1 = await wait(comet.accrue());
    const t1 = await comet.totalsBasic();
    const _a2 = await wait(comet.accrue());
    const t2 = await comet.totalsBasic();

    expect(t0.lastAccrualTime).to.be.equal(0n);
    expect(t0.totalSupplyBase).to.be.equal(totals.totalSupplyBase);
    expect(t0.totalBorrowBase).to.be.equal(totals.totalBorrowBase);

    expect(t1.lastAccrualTime).to.be.equal(now);
    expect(t2.lastAccrualTime).to.be.equal(now);
    expect(t2.baseSupplyIndex).to.be.equal(t1.baseSupplyIndex);
    expect(t2.baseBorrowIndex).to.be.equal(t1.baseBorrowIndex);
    expect(t2.trackingSupplyIndex).to.be.equal(t1.trackingSupplyIndex);
    expect(t2.trackingBorrowIndex).to.be.equal(t1.trackingBorrowIndex);
    expect(t2.totalSupplyBase).to.be.equal(t1.totalSupplyBase);
    expect(t2.totalSupplyBase).to.be.equal(t1.totalSupplyBase);
  });

  it('accrues correctly with time elapsed and less than min rewards', async () => {
    const start = (await getBlock()).timestamp + 100;
    const params = {
      baseMinForRewards: 12000n,
      trackingIndexScale: exp(1, 15),
      start,
    };
    const { cometWithExtendedAssetList : comet } = await makeProtocol(params);

    const t1 = await setTotalsBasic(comet, {
      totalSupplyBase: 11000n,
      totalBorrowBase: 11000n,
    });

    const utilization = await comet.getUtilization();
    const supplyRate = await comet.getSupplyRate(utilization);
    const borrowRate = await comet.getBorrowRate(utilization);

    await ethers.provider.send('evm_setAutomine', [false]);
    const _a1 = await comet.accrue();
    await ethers.provider.send('evm_mine', [start + 1000]);
    await ethers.provider.send('evm_setAutomine', [true]);

    const t2 = await comet.totalsBasic();

    const timeElapsed = t2.lastAccrualTime - t1.lastAccrualTime;
    expect(timeElapsed).to.be.equal(1000n);

    expect(t2.baseSupplyIndex).to.be.equal(projectBaseIndex(t1.baseSupplyIndex, supplyRate, timeElapsed));
    expect(t2.baseBorrowIndex).to.be.equal(projectBaseIndex(t1.baseBorrowIndex, borrowRate, timeElapsed));
    expect(t2.trackingSupplyIndex).to.be.equal(t1.trackingSupplyIndex);
    expect(t2.trackingBorrowIndex).to.be.equal(t1.trackingBorrowIndex);
  });

  it('accrues correctly with time elapsed and more than min rewards', async () => {
    const start = (await getBlock()).timestamp + 100;
    const params = {
      baseMinForRewards: exp(12000, 6),
      trackingIndexScale: exp(1, 15),
      start,
    };
    const { cometWithExtendedAssetList : comet } = await makeProtocol(params);

    const t0 = await comet.totalsBasic();
    const t1 = await setTotalsBasic(comet, {
      totalSupplyBase: exp(14000, 6),
      totalBorrowBase: exp(13000, 6),
    });

    const utilization = await comet.getUtilization();
    const supplyRate = await comet.getSupplyRate(utilization);
    const borrowRate = await comet.getBorrowRate(utilization);

    await ethers.provider.send('evm_setAutomine', [false]);
    const _a1 = await comet.accrue();
    await ethers.provider.send('evm_mine', [start + 1000]);
    await ethers.provider.send('evm_setAutomine', [true]);

    const t2 = await comet.totalsBasic();

    const supplySpeed = await comet.baseTrackingSupplySpeed();
    expect(supplySpeed).to.be.equal(params.trackingIndexScale);

    const borrowSpeed = await comet.baseTrackingBorrowSpeed();
    expect(borrowSpeed).to.be.equal(params.trackingIndexScale);

    const timeElapsed = t2.lastAccrualTime - t0.lastAccrualTime;
    expect(timeElapsed).to.be.equal(1000n);

    expect(t2.baseSupplyIndex).to.be.equal(projectBaseIndex(t1.baseSupplyIndex, supplyRate, timeElapsed));
    expect(t2.baseBorrowIndex).to.be.equal(projectBaseIndex(t1.baseBorrowIndex, borrowRate, timeElapsed));
    expect(t2.trackingSupplyIndex).to.be.equal(projectTrackingIndex(t1.trackingSupplyIndex, supplySpeed, timeElapsed, t1.totalSupplyBase));
    expect(t2.trackingBorrowIndex).to.be.equal(projectTrackingIndex(t1.trackingBorrowIndex, borrowSpeed, timeElapsed, t1.totalBorrowBase));
  });

  it('overflows if baseMinRewards is set too low and accrues no interest', async () => {
    const params = {
      baseMinForRewards: 12000,
      trackingIndexScale: exp(1, 15),
    };
    const { cometWithExtendedAssetList : comet } = await makeProtocol(params);

    const t0 = await comet.totalsBasic();
    await fastForward(998);
    const t1 = await setTotalsBasic(comet, {
      totalSupplyBase: 14000,
      totalBorrowBase: 13000,
    });
    await fastForward(2);
    await expect(comet.accrue()).to.be.revertedWithCustomError(comet, 'InvalidUInt64');
    const t2 = await comet.totalsBasic();

    const utilization = await comet.getUtilization();
    const supplyRate = await comet.getSupplyRate(utilization);
    const borrowRate = await comet.getBorrowRate(utilization);
    const timeElapsed = t2.lastAccrualTime - t0.lastAccrualTime;
    expect(timeElapsed).to.be.equal(0n);

    expect(t2.baseSupplyIndex).to.be.equal(projectBaseIndex(t1.baseSupplyIndex, supplyRate, timeElapsed));
    expect(t2.baseBorrowIndex).to.be.equal(projectBaseIndex(t1.baseBorrowIndex, borrowRate, timeElapsed));
    expect(t2.trackingSupplyIndex).to.be.equal(t1.trackingSupplyIndex);
    expect(t2.trackingBorrowIndex).to.be.equal(t1.trackingBorrowIndex);
  });

  it('reverts on overflows', async () => {
    const { cometWithExtendedAssetList : comet } = await makeProtocol();

    const t0 = await comet.totalsBasic();
    await fastForward(998);
    await setTotalsBasic(comet, {
      baseSupplyIndex: 2n ** 64n - 1n,
      totalSupplyBase: 14000,
      totalBorrowBase: 13000, // needs to have positive utilization for supply rate to be > 0
    });
    await fastForward(2);
    await expect(comet.accrue()).to.be.revertedWithPanic(0x11);

    await fastForward(998);
    await setTotalsBasic(comet, {
      baseSupplyIndex: t0.baseSupplyIndex,
      baseBorrowIndex: 2n ** 64n - 1n,
      totalSupplyBase: t0.totalSupplyBase,
      totalBorrowBase: t0.totalBorrowBase,
    });
    await fastForward(2);
    await expect(comet.accrue()).to.be.revertedWithPanic(0x11);
  });

  it('supports up to the maximum timestamp then breaks', async () => {
    const { cometWithExtendedAssetList : comet } = await makeProtocol();

    await fastForward(100);
    const _a0 = await wait(comet.accrue());

    await fastForward(2 ** 40);
    await expect(comet.accrue()).to.be.revertedWithCustomError(comet, 'TimestampTooLarge');
  });
});

describe('getNow timestamp bounds', function () {
  it('reverts if timestamp overflows', async () => {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();
    const snapshot = await takeSnapshot();
    try {
      await ethers.provider.send('evm_mine', [2 ** 40]);
      await expect(comet.getNow()).to.be.revertedWithCustomError(comet, 'TimestampTooLarge');
    } finally {
      await snapshot.restore();
    }
  });
});

describe('accrueAccount regressions', function () {
  it('has no effect when called on an address with no protocol activity', async () => {
    const { cometWithExtendedAssetList : comet, users: [unusedAccount] } = await makeProtocol();

    const userBasic0 = await comet.userBasic(unusedAccount.address);
    await comet.accrueAccount(unusedAccount.address);
    const userBasic1 = await comet.userBasic(unusedAccount.address);

    expect(userBasic0).to.deep.equal(userBasic1);
    expect(userBasic1.principal).to.eq(0n);
    expect(userBasic1.baseTrackingIndex).to.eq(0n);
    expect(userBasic1.baseTrackingAccrued).to.eq(0n);
    expect(userBasic1.assetsIn).to.eq(0n);
  });
});
