import { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from 'build/types';
import { ethers, expect, exp, makeProtocol, oneMonth, oneDay, defaultAssets, UserBasic, SnapshotRestorer, takeSnapshot} from './helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber } from 'ethers';
import { TotalsBasicStructOutput } from 'build/types/CometHarnessInterfaceExtendedAssetList';

describe('accrue', function () {
  // Constants
  const FACTOR_SCALE = exp(1, 18);
  const INDEX_SCALE = exp(1, 15);
  const baseTokenDecimals = 6;
  const baseTokenScale = exp(1, baseTokenDecimals);
  const seedAmount = exp(10_000, baseTokenDecimals);

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
  let collaterals: { [symbol: string]: FaucetToken } = {};
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};

  // Accounts
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let dave: SignerWithAddress;



  before(async () => {
    const protocol = await makeProtocol(
      {
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
      }
    );
    comet = protocol.cometWithExtendedAssetList;
    baseToken = protocol.tokens.USDC as FaucetToken;
    for (const asset in protocol.tokens) {
      if (asset === 'USDC') continue;
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
    let supplyRatePerSecond: BigNumber;
    let borrowRatePerSecond: BigNumber;
    before(async function () {
      const block = await ethers.provider.getBlock('latest');
      timeBefore = block.timestamp;
      userBasicBefore = await comet.userBasic(alice.address);

      supplyRatePerSecond = BigNumber.from(config.supplyInterestRateBase).div(365 * oneDay);
      borrowRatePerSecond = BigNumber.from(config.borrowInterestRateBase).div(365 * oneDay);
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
      expect(await comet.accrueAccount(alice.address)).to.not.be.reverted;
    });

    it('utilization should still be 0 after accrue with no borrowers', async function () {
      expect(await comet.getUtilization()).to.equal(0);
    });

    it('supply index should increase after accrue', async function () {
      const { baseSupplyIndex } = await comet.totalsBasic();
      const currentBlock = await ethers.provider.getBlock('latest');
      const timeElapsed = currentBlock.timestamp - timeBefore;
      const yearTime = 365 * oneDay;

      const supplyPerSecond = BigNumber.from(config.supplyInterestRateBase).div(yearTime);
      const factorScale = await comet.factorScale();

      const expectedSupplyIndexAccrued = BigNumber.from(INDEX_SCALE).mul(supplyPerSecond).mul(timeElapsed).div(factorScale);
      const expectedSupplyIndex = BigNumber.from(INDEX_SCALE).add(expectedSupplyIndexAccrued);

      expect(baseSupplyIndex).to.equal(expectedSupplyIndex);
    });

    it('borrow index should increase after accrue', async function () {
      const { baseBorrowIndex } = await comet.totalsBasic();
      const currentBlock = await ethers.provider.getBlock('latest');
      const timeElapsed = currentBlock.timestamp - timeBefore;
      const yearTime = 365 * oneDay;

      const borrowPerSecond = BigNumber.from(config.borrowInterestRateBase).div(yearTime);
      const factorScale = await comet.factorScale();

      const expectedBorrowIndexAccrued = BigNumber.from(INDEX_SCALE).mul(borrowPerSecond).mul(timeElapsed).div(factorScale);
      const expectedBorrowIndex = BigNumber.from(INDEX_SCALE).add(expectedBorrowIndexAccrued);

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
      let timeElapsed: number;

      before(async function () {
        totalsBefore = await comet.totalsBasic();
        await baseToken.allocateTo(comet.address, seedAmount);
        await ethers.provider.send('evm_increaseTime', [oneDay]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
        totalsAfter = await comet.totalsBasic();
        timeElapsed = totalsAfter.lastAccrualTime - totalsBefore.lastAccrualTime;
      });

      describe('seeding reserves impact on index accrual over time', function () {
        it('supply index should continue accruing over time after seeding', async function () {
          const expectedSupplyIndex = totalsBefore.baseSupplyIndex.add(totalsBefore.baseSupplyIndex.mul(supplyRatePerSecond).mul(timeElapsed).div(exp(1, 18)));
          expect(totalsAfter.baseSupplyIndex).to.equal(expectedSupplyIndex);
        });

        it('borrow index should continue accruing over time after seeding', async function () {
          const expectedBorrowIndex = totalsBefore.baseBorrowIndex.add(totalsBefore.baseBorrowIndex.mul(borrowRatePerSecond).mul(timeElapsed).div(exp(1, 18)));
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
    let totalSupplyBaseAfterSupply: BigNumber;
    let userBasicBefore: UserBasic;

    before(async function () {
      totalsBefore = await comet.totalsBasic();
    });

    it('should allow supplying', async function () {
      await baseToken.allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve(comet.address, supplyAmount);
      await comet.connect(alice).supply(baseToken.address, supplyAmount);
    });

    it('last accrue should be with supply', async function () {
      const block = await ethers.provider.getBlock('latest');
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.lastAccrualTime).to.equal(block.timestamp);
    });

    it('utilization should be 0 with no borrowers', async function () {
      expect(await comet.getUtilization()).to.equal(0);
    });

    it('supply index should increase after supply', async function () {
      const totalsAfter = await comet.totalsBasic();
      const supplyRatePerSecond = BigNumber.from(config.supplyInterestRateBase).div(365 * oneDay);
      expect(totalsAfter.baseSupplyIndex).to.equal(totalsBefore.baseSupplyIndex.add(totalsBefore.baseSupplyIndex.mul(supplyRatePerSecond).mul(3).div(exp(1, 18))));
    });

    it('tracking supply index should not change after supply with utilization = 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.trackingSupplyIndex).to.equal(totalsBefore.trackingSupplyIndex);
    });

    it('total supply base should reflect supplied principal', async function () {
      const totalsAfter = await comet.totalsBasic();
      const expectedPrincipal = BigNumber.from(supplyAmount).mul(INDEX_SCALE).div(totalsAfter.baseSupplyIndex);
      expect(totalsAfter.totalSupplyBase).to.be.closeTo(expectedPrincipal, 1);
      totalSupplyBaseAfterSupply = totalsAfter.totalSupplyBase;
    });

    it('borrow index should increase after supply', async function () {
      const totalsAfter = await comet.totalsBasic();
      const borrowRatePerSecond = BigNumber.from(config.borrowInterestRateBase).div(365 * oneDay);
      expect(totalsAfter.baseBorrowIndex).to.equal(totalsBefore.baseBorrowIndex.add(totalsBefore.baseBorrowIndex.mul(borrowRatePerSecond).mul(3).div(exp(1, 18))));
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
      expect(totalsAfter.baseSupplyIndex).to.be.closeTo(totalsBefore.baseSupplyIndex.add(totalsBefore.baseSupplyIndex.mul(supplyRate).mul(oneMonth).div(exp(1, 18))), supplyRate.div(100));
    });

    it('tracking supply index should accrue with utilization = 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.trackingSupplyIndex).to.equal(BigNumber.from(0).add(BigNumber.from(config.baseTrackingSupplySpeed).mul(oneMonth + 1).mul(baseTokenScale).div(totalsAfter.totalSupplyBase)));
    });

    it('total supply base should not change after accrue', async function () {
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalSupplyBase).to.equal(totalSupplyBaseAfterSupply);
    });

    it('borrow index should accrue with utilization = 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      const borrowRatePerSecond = BigNumber.from(config.borrowInterestRateBase).div(365 * oneDay);
      expect(totalsAfter.baseBorrowIndex).to.be.closeTo(totalsBefore.baseBorrowIndex.add(totalsBefore.baseBorrowIndex.mul(borrowRatePerSecond).mul(oneMonth).div(exp(1, 18))), borrowRatePerSecond.div(100));
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
      const expectedTrackingIndex = userBasicBefore.baseTrackingIndex.add(BigNumber.from(config.baseTrackingSupplySpeed).mul(oneMonth + 1).mul(baseTokenScale).div(totalsAfter.totalSupplyBase));
      expect(userBasicAfter.baseTrackingIndex).to.be.closeTo(expectedTrackingIndex, 1);
    });

    it('user tracking accrued should accrue after supply interest', async function () {
      const userBasicAfter = await comet.userBasic(alice.address);
      const totalsAfter = await comet.totalsBasic();
      const expectedTrackingAccrued = userBasicBefore.principal.mul(totalsAfter.trackingSupplyIndex.sub(userBasicBefore.baseTrackingIndex)).div(INDEX_SCALE);
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

    let supplyRateBefore: BigNumber;
    let borrowRateBefore: BigNumber;

    before(async function () {
      // Bob supplies 1 WETH as collateral
      await collaterals.WETH.connect(bob).allocateTo(bob.address, exp(1, 18));
      await collaterals.WETH.connect(bob).approve(comet.address, exp(1, 18));
      await comet.connect(bob).supply(collaterals.WETH.address, exp(1, 18));

      expect(await comet.connect(bob).withdraw(baseToken.address, borrowAmount)).to.not.be.reverted;
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
      expect(totalsAfter.baseSupplyIndex).to.be.equal(totalsBefore.baseSupplyIndex.add(totalsBefore.baseSupplyIndex.mul(supplyRateBefore).mul(timeElapsed).div(exp(1, 18))));
    });

    it('tracking supply index should accrue with utilization > 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      const timeElapsed = totalsAfter.lastAccrualTime - totalsBefore.lastAccrualTime;
      expect(totalsAfter.trackingSupplyIndex).to.equal(totalsBefore.trackingSupplyIndex.add(BigNumber.from(config.baseTrackingSupplySpeed).mul(timeElapsed).mul(baseTokenScale).div(totalsBefore.totalSupplyBase)));
    });

    it('total supply base should not change after accrue with utilization > 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.totalSupplyBase).to.equal(totalsBefore.totalSupplyBase);
    });

    it('borrow index should accrue with utilization > 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      const timeElapsed = totalsAfter.lastAccrualTime - totalsBefore.lastAccrualTime;
      expect(totalsAfter.baseBorrowIndex).to.be.equal(totalsBefore.baseBorrowIndex.add(totalsBefore.baseBorrowIndex.mul(borrowRateBefore).mul(timeElapsed).div(exp(1, 18))));
    });

    it('tracking borrow index should accrue with utilization > 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      const timeElapsed = totalsAfter.lastAccrualTime - totalsBefore.lastAccrualTime;
      expect(totalsAfter.trackingBorrowIndex).to.equal(totalsBefore.trackingBorrowIndex.add(BigNumber.from(config.baseTrackingBorrowSpeed).mul(timeElapsed).mul(baseTokenScale).div(totalsBefore.totalBorrowBase)));
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
      const expectedBorrowTrackingIndex = userBasicBefore.baseTrackingIndex.add(BigNumber.from(config.baseTrackingBorrowSpeed).mul(oneMonth + 1).mul(baseTokenScale).div(totalsAfter.totalBorrowBase));
      expect(userBasicAfter.baseTrackingIndex).to.be.closeTo(expectedBorrowTrackingIndex, 1);
    });

    it('user tracking accrued should accrue after borrow interest', async function () {
      const userBasicAfter = await comet.userBasic(bob.address);
      const totalsAfter = await comet.totalsBasic();
      const expectedBorrowTrackingAccrued = userBasicBefore.principal.mul(-1).mul(totalsAfter.trackingBorrowIndex.sub(userBasicBefore.baseTrackingIndex)).div(INDEX_SCALE);
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
      const repayAmount = (await comet.borrowBalanceOf(bob.address)).add(100); // overpay to account for interest
      await baseToken.connect(bob).allocateTo(bob.address, repayAmount);
      await baseToken.connect(bob).approve(comet.address, repayAmount);
      await comet.connect(bob).supply(baseToken.address, repayAmount);
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
        expect(totalsAfter.baseSupplyIndex).to.be.equal(totalsBefore.baseSupplyIndex.add(totalsBefore.baseSupplyIndex.mul(await comet.getSupplyRate(0)).mul(1).div(exp(1, 18))));
      });

      it('tracking supply index should update after repay accrue', async function () {
        expect(totalsAfter.trackingSupplyIndex).to.equal(totalsBefore.trackingSupplyIndex.add(BigNumber.from(config.baseTrackingSupplySpeed).mul(1).mul(baseTokenScale).div(totalsBefore.totalSupplyBase)));
      });

      it('borrow index should update after repay accrue', async function () {
        expect(totalsAfter.baseBorrowIndex).to.be.equal(totalsBefore.baseBorrowIndex.add(totalsBefore.baseBorrowIndex.mul(await comet.getBorrowRate(0)).mul(1).div(exp(1, 18))));
      });

      it('tracking borrow index should not change after repay accrue', async function () {
        expect(totalsAfter.trackingBorrowIndex).to.equal(totalsBefore.trackingBorrowIndex);
      });

      it('user principal should not change after repay accrue', async function () {
        expect(userBasicAfter.principal).to.equal(userBasicBefore.principal);
      });

      it('user tracking index should not change after repay accrue', async function () {
        expect(userBasicAfter.baseTrackingIndex).to.be.closeTo(userBasicBefore.baseTrackingIndex, 2e8);
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

    let borrowedAmount: BigNumber;
    let liquidatedAmount: BigNumber;

    before(async function () {
      // Prepare position for liquidation
      await collaterals.WETH.connect(dave).allocateTo(dave.address, suppliedCollateral);
      await collaterals.WETH.connect(dave).approve(comet.address, suppliedCollateral);
      await comet.connect(dave).supply(collaterals.WETH.address, suppliedCollateral);

      const maxBorrow = await comet.getBorrowLimit(dave.address);
      borrowedAmount = maxBorrow;
      await comet.connect(dave).withdraw(baseToken.address, maxBorrow);

      // Drop WETH price by 20% to make position liquidatable
      const currentPrice = exp(3000, 8);
      const droppedPrice = BigNumber.from(currentPrice).mul(80).div(100); // 20% drop
      await priceFeeds.WETH.setPrice(droppedPrice);
    });

    it('position should be underwater', async function () {
      const isLiquidatable = await comet.isLiquidatable(dave.address);
      expect(isLiquidatable).to.equal(true);
    });

    it('should allow liquidation', async function () {
      const liquidateTx = await comet.connect(alice).absorb(alice.address, [dave.address]);
      const receipt = await liquidateTx.wait();
      liquidatedAmount = receipt.events?.filter((x) => x.event === 'AbsorbDebt')[0].args.basePaidOut;
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
        expect(totalsAfter.baseSupplyIndex).to.be.equal(totalsBefore.baseSupplyIndex.add(totalsBefore.baseSupplyIndex.mul(await comet.getSupplyRate(0)).mul(1).div(exp(1, 18))));
      });

      it('tracking supply index should update after liquidation accrue', async function () {
        expect(totalsAfter.trackingSupplyIndex).to.equal(totalsBefore.trackingSupplyIndex.add(BigNumber.from(config.baseTrackingSupplySpeed).mul(1).mul(baseTokenScale).div(totalsBefore.totalSupplyBase)));
      });

      it('borrow index should update after liquidation accrue', async function () {
        expect(totalsAfter.baseBorrowIndex).to.be.equal(totalsBefore.baseBorrowIndex.add(totalsBefore.baseBorrowIndex.mul(await comet.getBorrowRate(0)).mul(1).div(exp(1, 18))));
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
      await comet.accrueAccount(alice.address);
      await comet.accrueAccount(alice.address);
      await ethers.provider.send('evm_mine', []);
      await ethers.provider.send('evm_setAutomine', [true]);

      const totalsAfter = await comet.totalsBasic();
      const timeElapsed = totalsAfter.lastAccrualTime - totalsBefore.lastAccrualTime;

      // If the second call also accrued, indices would be double. Verify single accrual.
      const supplyRate = await comet.getSupplyRate(await comet.getUtilization());
      const borrowRate = await comet.getBorrowRate(await comet.getUtilization());
      const expectedSupplyIndex = totalsBefore.baseSupplyIndex.add(
        totalsBefore.baseSupplyIndex.mul(supplyRate).mul(timeElapsed).div(FACTOR_SCALE)
      );
      const expectedBorrowIndex = totalsBefore.baseBorrowIndex.add(
        totalsBefore.baseBorrowIndex.mul(borrowRate).mul(timeElapsed).div(FACTOR_SCALE)
      );
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
      await baseToken.connect(bob).approve(comet.address, supplyAmount);
      await comet.connect(bob).supply(baseToken.address, supplyAmount);

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
      const expectedBalance = BigNumber.from(userBasic.principal).mul(baseSupplyIndex).div(INDEX_SCALE);
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
      const uint40Max = BigNumber.from(2).pow(40).sub(1);
      const timeToSkip = uint40Max.sub(block.timestamp).add(1).toNumber();
      await ethers.provider.send('evm_increaseTime', [timeToSkip]);
      await ethers.provider.send('evm_mine', []);
      await expect(comet.accrueAccount(alice.address)).to.be.revertedWithCustomError(comet, 'TimestampTooLarge');
      await snapshot.restore();
    });

    it('should revert when supply rate is too high', async function () {
      const protocol = await makeProtocol(
        {
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
        },
      );
      const comet = protocol.cometWithExtendedAssetList;

      let collaterals: { [symbol: string]: FaucetToken } = {};
      let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};
      const baseToken = protocol.tokens.USDC as FaucetToken;
      for (const asset in protocol.tokens) {
        if (asset === 'USDC') continue;
        collaterals[asset] = protocol.tokens[asset] as FaucetToken;
      }
      for (const asset in protocol.priceFeeds) {
        priceFeeds[asset] = protocol.priceFeeds[asset];
      }
      const [alice, bob] = protocol.users;
      const supplyAmount = exp(1000, baseTokenDecimals);
      await baseToken.allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve(comet.address, supplyAmount);
      await comet.connect(alice).supply(baseToken.address, supplyAmount);

      const asset0Info = await comet.getAssetInfo(0);

      const priceAsset = (await priceFeeds.WETH.latestRoundData())[1];
      const priceBase = (await priceFeeds.USDC.latestRoundData())[1];

      const asset0Decimals = await collaterals.WETH.decimals();
      let amountCollateralToSupply: BigNumber;

      if (asset0Decimals > baseTokenDecimals) {
        const rescaleFactor = exp(1, asset0Decimals - baseTokenDecimals);
        amountCollateralToSupply = BigNumber.from(supplyAmount).mul(rescaleFactor).mul(priceBase).mul(FACTOR_SCALE).mul(50).div(asset0Info.borrowCollateralFactor).div(priceAsset).div(100);
      } else {
        const rescaleFactor = exp(1, baseTokenDecimals - asset0Decimals);
        amountCollateralToSupply = BigNumber.from(supplyAmount).mul(priceBase).mul(FACTOR_SCALE).mul(50).div(asset0Info.borrowCollateralFactor).div(priceAsset).div(rescaleFactor).div(100);
      }

      await collaterals.WETH.allocateTo(bob.address, amountCollateralToSupply);
      await collaterals.WETH.connect(bob).approve(comet.address, amountCollateralToSupply);
      await comet.connect(bob).supply(collaterals.WETH.address, amountCollateralToSupply);
      const borrowLimit = await comet.getBorrowLimit(bob.address);
      await comet.connect(bob).withdraw(baseToken.address, borrowLimit);

      const utilization = await comet.getUtilization();
      const supplyRate = await comet.getSupplyRate(utilization);
      const totals = await comet.totalsBasic();
      const uint64Max = BigNumber.from(2).pow(64).sub(1);
      const timeToOverflow = uint64Max.mul(FACTOR_SCALE).div(totals.baseSupplyIndex.mul(supplyRate)).add(1).toNumber();
      await ethers.provider.send('evm_increaseTime', [timeToOverflow]);
      await ethers.provider.send('evm_mine', []);
      await expect(comet.accrueAccount(alice.address)).to.be.revertedWithCustomError(comet, 'InvalidUInt64');
      await snapshot.restore();
    });

    it('should revert when borrow rate is too high', async function () {
      const protocol = await makeProtocol(
        {
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
        },
      );
      const comet = protocol.cometWithExtendedAssetList;

      let collaterals: { [symbol: string]: FaucetToken } = {};
      let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};
      const baseToken = protocol.tokens.USDC as FaucetToken;
      for (const asset in protocol.tokens) {
        if (asset === 'USDC') continue;
        collaterals[asset] = protocol.tokens[asset] as FaucetToken;
      }
      for (const asset in protocol.priceFeeds) {
        priceFeeds[asset] = protocol.priceFeeds[asset];
      }
      const [alice, bob] = protocol.users;
      const supplyAmount = exp(1000, baseTokenDecimals);
      await baseToken.allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve(comet.address, supplyAmount);
      await comet.connect(alice).supply(baseToken.address, supplyAmount);

      const asset0Info = await comet.getAssetInfo(0);

      const priceAsset = (await priceFeeds.WETH.latestRoundData())[1];
      const priceBase = (await priceFeeds.USDC.latestRoundData())[1];

      const asset0Decimals = await collaterals.WETH.decimals();
      let amountCollateralToSupply: BigNumber;

      if (asset0Decimals > baseTokenDecimals) {
        const rescaleFactor = exp(1, asset0Decimals - baseTokenDecimals);
        amountCollateralToSupply = BigNumber.from(supplyAmount).mul(rescaleFactor).mul(priceBase).mul(FACTOR_SCALE).mul(50).div(asset0Info.borrowCollateralFactor).div(priceAsset).div(100);
      } else {
        const rescaleFactor = exp(1, baseTokenDecimals - asset0Decimals);
        amountCollateralToSupply = BigNumber.from(supplyAmount).mul(priceBase).mul(FACTOR_SCALE).mul(50).div(asset0Info.borrowCollateralFactor).div(priceAsset).div(rescaleFactor).div(100);
      }

      await collaterals.WETH.allocateTo(bob.address, amountCollateralToSupply);
      await collaterals.WETH.connect(bob).approve(comet.address, amountCollateralToSupply);
      await comet.connect(bob).supply(collaterals.WETH.address, amountCollateralToSupply);
      const borrowLimit = await comet.getBorrowLimit(bob.address);
      await comet.connect(bob).withdraw(baseToken.address, borrowLimit);

      const utilization = await comet.getUtilization();
      const borrowRate = await comet.getBorrowRate(utilization);
      const totals = await comet.totalsBasic();
      const uint64Max = BigNumber.from(2).pow(64).sub(1);
      const timeToOverflow = uint64Max.mul(FACTOR_SCALE).div(totals.baseBorrowIndex.mul(borrowRate)).add(1).toNumber();
      await ethers.provider.send('evm_increaseTime', [timeToOverflow]);
      await ethers.provider.send('evm_mine', []);
      await expect(comet.accrueAccount(alice.address)).to.be.revertedWithCustomError(comet, 'InvalidUInt64');
      await snapshot.restore();
    });
  });
});
