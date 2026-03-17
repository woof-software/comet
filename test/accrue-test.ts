import { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from 'build/types';
import { ethers, expect, exp, makeProtocol, presentValueBorrow, presentValueSupply, defaultAssets } from './helpers';
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

  const oneDay = 24 * 60 * 60;
  const oneMonth = 30 * oneDay;

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

  function calculateExpectedIndex(baseIndexBefore: BigNumber, ratePerSecond: BigNumber, timeElapsed: number): BigNumber {
    const indexAccrued = baseIndexBefore.mul(ratePerSecond).mul(timeElapsed).div(exp(1, 18));
    return baseIndexBefore.add(indexAccrued);
  }

  function calculateExpectedTrackingIndex(baseTrackingIndexBefore: BigNumber, trackingSpeed: BigNumber, timeElapsed: number, totalSupplyBase: BigNumber): BigNumber {
    const indexAccrued = trackingSpeed.mul(timeElapsed).mul(baseTokenScale).div(totalSupplyBase);
    return baseTrackingIndexBefore.add(indexAccrued);
  }

  function calculateExpectedUserTrackingAccrued(trackingIndexAfter: BigNumber, trackingIndexBefore: BigNumber, principal: BigNumber): BigNumber {
    const indexDifference = trackingIndexAfter.sub(trackingIndexBefore);
    return principal.mul(indexDifference).div(INDEX_SCALE);
  }

  async function makeUtilization(_comet: CometHarnessInterfaceExtendedAssetList, utilization: number) {
    if(utilization <= 0 || utilization >= 100) {
      throw new Error('Utilization must be between 0 and 100');
    }

    const _baseToken = new ethers.Contract(await _comet.baseToken(), [
      'function approve(address spender, uint256 amount) external returns (bool)',
      'function allocateTo(address to, uint256 amount) external',
      'function decimals() external view returns (uint8)',
    ], bob) as FaucetToken;

    const supplyAmount = BigNumber.from(exp(1000, await _baseToken.decimals()));

    await _baseToken.allocateTo(alice.address, supplyAmount);
    await _baseToken.connect(alice).approve(_comet.address, supplyAmount);
    await _comet.connect(alice).supply(_baseToken.address, supplyAmount);

    const asset0Info = await _comet.getAssetInfo(0);
    const asset0Address = asset0Info.asset;
    const asset0 = new ethers.Contract(asset0Address, [
      'function approve(address spender, uint256 amount) external returns (bool)',
      'function allocateTo(address to, uint256 amount) external',
      'function decimals() external view returns (uint8)',
    ], bob) as FaucetToken;

    const asset0PriceFeed = new ethers.Contract(asset0Info.priceFeed, [
      'function latestRoundData() external view returns (uint80 roundId, int256 price, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    ], bob) as SimplePriceFeed;

    const baseTokenPriceFeed = new ethers.Contract(await _comet.baseTokenPriceFeed(), [
      'function latestRoundData() external view returns (uint80 roundId, int256 price, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    ], bob) as SimplePriceFeed;

    const priceAsset0 = (await asset0PriceFeed.latestRoundData())[1];
    const priceBase = (await baseTokenPriceFeed.latestRoundData())[1];

    const baseTokenDecimals = await _baseToken.decimals();
    const asset0Decimals = await asset0.decimals();

    let amountCollateralToSupply: BigNumber;
    if(asset0Decimals > baseTokenDecimals) {
      const rescaleFactor = exp(1, asset0Decimals - baseTokenDecimals);
      amountCollateralToSupply = supplyAmount.mul(rescaleFactor).mul(priceBase).mul(FACTOR_SCALE).mul(utilization).div(asset0Info.borrowCollateralFactor).div(priceAsset0).div(100);
    } else {
      const rescaleFactor = exp(1, baseTokenDecimals - asset0Decimals);
      amountCollateralToSupply = supplyAmount.mul(priceBase).mul(FACTOR_SCALE).mul(utilization).div(asset0Info.borrowCollateralFactor).div(priceAsset0).div(rescaleFactor).div(100);
    }

    await asset0.allocateTo(bob.address, amountCollateralToSupply);
    await asset0.approve(_comet.address, amountCollateralToSupply);
    await _comet.connect(bob).supply(asset0.address, amountCollateralToSupply);
    const borrowLimit = await _comet.getBorrowLimit(bob.address);

    await _comet.connect(bob).withdraw(_baseToken.address, borrowLimit);
  }

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
    let userBasicBefore: [BigNumber, BigNumber, BigNumber, number, number] & { principal: BigNumber, baseTrackingIndex: BigNumber, baseTrackingAccrued: BigNumber, assetsIn: number, _reserved: number };
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

    it('supply and borrow indexes should be 1 in initial state', async function () {
      const { baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      // initial index should be index
      const indexScale = await comet.baseIndexScale();
      expect(baseSupplyIndex).to.be.equal(INDEX_SCALE);
      expect(baseSupplyIndex).to.be.equal(indexScale);
      expect(baseBorrowIndex).to.be.equal(indexScale);
    });

    it('tracking supply and borrow indexes should be 0 in initial state', async function () {
      const { trackingSupplyIndex, trackingBorrowIndex } = await comet.totalsBasic();
      expect(trackingSupplyIndex).to.be.equal(0);
      expect(trackingBorrowIndex).to.be.equal(0);
    });

    it('total supply and borrow should be 0 in initial state', async function () {
      const { totalSupplyBase, totalBorrowBase } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(0);
      expect(totalBorrowBase).to.equal(0);
    });

    it('accruing with no positions should be possible', async function () {
      expect(await comet.accrueAccount(alice.address)).to.not.be.reverted;
    });

    it('utilization should still be 0 after accrue with no borrowers', async function () {
      expect(await comet.getUtilization()).to.equal(0);
    });

    it('supply and borrow indexes should increase after accrue', async function () {
      const { baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const currentBlock = await ethers.provider.getBlock('latest');
      const timeElapsed = currentBlock.timestamp - timeBefore;
      const yearTime = 365 * oneDay;

      const supplyPerSecond = BigNumber.from(config.supplyInterestRateBase).div(yearTime);
      const borrowPerSecond = BigNumber.from(config.borrowInterestRateBase).div(yearTime);

      const factorScale = await comet.factorScale();

      const expectedSupplyIndexAccrued = BigNumber.from(INDEX_SCALE).mul(supplyPerSecond).mul(timeElapsed).div(factorScale);
      const expectedSupplyIndex = BigNumber.from(INDEX_SCALE).add(expectedSupplyIndexAccrued);

      const expectedBorrowIndexAccrued = BigNumber.from(INDEX_SCALE).mul(borrowPerSecond).mul(timeElapsed).div(factorScale);
      const expectedBorrowIndex = BigNumber.from(INDEX_SCALE).add(expectedBorrowIndexAccrued);

      expect(baseSupplyIndex).to.equal(expectedSupplyIndex);
      expect(baseBorrowIndex).to.equal(expectedBorrowIndex);
    });

    it('total supply and borrow should remain 0 after accrue', async function () {
      const { totalSupplyBase, totalBorrowBase } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(0);
      expect(totalBorrowBase).to.equal(0);
    });

    it('user position is not affected by accrue with no activity', async function () {
      const userBasicAfter = await comet.userBasic(alice.address);
      expect(userBasicAfter).to.deep.equal(userBasicBefore);
    });

    describe('seeding reserves', function () {
      let totalsBefore: TotalsBasicStructOutput;
      before(async function () {
        totalsBefore = await comet.totalsBasic();
        await baseToken.allocateTo(comet.address, seedAmount);
      });

      it('seeding should not affect accrual', async function () {
        expect(await comet.accrueAccount(alice.address)).to.not.be.reverted;
      });

      it('totals should not be affected by seeding reserves', async function () {
        const totalsAfter = await comet.totalsBasic();
        expect(totalsAfter.trackingSupplyIndex).to.equal(totalsBefore.trackingSupplyIndex);
        expect(totalsAfter.trackingBorrowIndex).to.equal(totalsBefore.trackingBorrowIndex);
        expect(totalsAfter.totalSupplyBase).to.equal(totalsBefore.totalSupplyBase);
        expect(totalsAfter.totalBorrowBase).to.equal(totalsBefore.totalBorrowBase);

        const expectedSupplyIndex = calculateExpectedIndex(totalsBefore.baseSupplyIndex, supplyRatePerSecond, 2);
        const expectedBorrowIndex = calculateExpectedIndex(totalsBefore.baseBorrowIndex, borrowRatePerSecond, 2);

        expect(totalsAfter.baseSupplyIndex).to.equal(expectedSupplyIndex);
        expect(totalsAfter.baseBorrowIndex).to.equal(expectedBorrowIndex);
      });

      it('user position should not be affected by seeding reserves', async function () {
        const userBasicAfter = await comet.userBasic(alice.address);
        expect(userBasicAfter).to.deep.equal(userBasicBefore);
      });
    });
  });

  describe('lending position', function () {
    let totalsBefore: TotalsBasicStructOutput;
    let userBasicBefore: [BigNumber, BigNumber, BigNumber, number, number] & { principal: BigNumber, baseTrackingIndex: BigNumber, baseTrackingAccrued: BigNumber, assetsIn: number, _reserved: number };

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

    it('should not start accruing with utilization = 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      const supplyRatePerSecond = BigNumber.from(config.supplyInterestRateBase).div(365 * oneDay);
      const borrowRatePerSecond = BigNumber.from(config.borrowInterestRateBase).div(365 * oneDay);

      expect(totalsAfter.baseSupplyIndex).to.equal(calculateExpectedIndex(totalsBefore.baseSupplyIndex, supplyRatePerSecond, 3));
      expect(totalsAfter.baseBorrowIndex).to.equal(calculateExpectedIndex(totalsBefore.baseBorrowIndex, borrowRatePerSecond, 3));

      expect(totalsAfter.trackingSupplyIndex).to.equal(totalsBefore.trackingSupplyIndex);
      expect(totalsAfter.trackingBorrowIndex).to.equal(totalsBefore.trackingBorrowIndex);
      expect(totalsAfter.totalSupplyBase).to.be.closeTo(supplyAmount, 1);
      expect(totalsAfter.totalBorrowBase).to.equal(totalsBefore.totalBorrowBase);
    });

    it('skip time and accrue', async function () {
    // Fast forward a month
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      userBasicBefore = await comet.userBasic(alice.address);

      await comet.accrueAccount(alice.address);
    });

    it('should accrue some supply interest with utilization = 0', async function () {
      const totalsAfter = await comet.totalsBasic();
      const supplyRate = await comet.getSupplyRate(0);
      const borrowRatePerSecond = BigNumber.from(config.borrowInterestRateBase).div(365 * oneDay);

      expect(totalsAfter.baseSupplyIndex).to.be.closeTo(calculateExpectedIndex(totalsBefore.baseSupplyIndex, supplyRate, oneMonth), supplyRate.div(100));
      expect(totalsAfter.baseBorrowIndex).to.be.closeTo(calculateExpectedIndex(totalsBefore.baseBorrowIndex, borrowRatePerSecond, oneMonth), borrowRatePerSecond.div(100));

      expect(totalsAfter.trackingSupplyIndex).to.equal(calculateExpectedTrackingIndex(BigNumber.from(0), BigNumber.from(config.baseTrackingSupplySpeed), oneMonth + 1, totalsAfter.totalSupplyBase));
      expect(totalsAfter.totalSupplyBase).to.be.closeTo(supplyAmount, 1);
      expect(totalsAfter.totalBorrowBase).to.equal(totalsBefore.totalBorrowBase);
    });

    it('user position should accrue supply interest', async function () {
      const userBasicAfter = await comet.userBasic(alice.address);
      const totalsAfter = await comet.totalsBasic();

      expect(userBasicAfter.principal).to.be.equal(userBasicBefore.principal);

      const expectedTrackingIndex = calculateExpectedTrackingIndex(userBasicBefore.baseTrackingIndex, BigNumber.from(config.baseTrackingSupplySpeed), oneMonth + 1, totalsAfter.totalSupplyBase);
      const expectedTrackingAccrued = calculateExpectedUserTrackingAccrued(totalsAfter.trackingSupplyIndex, userBasicBefore.baseTrackingIndex, userBasicBefore.principal);

      expect(userBasicAfter.baseTrackingIndex).to.be.closeTo(expectedTrackingIndex, 1);
      expect(userBasicAfter.baseTrackingAccrued).to.equal(expectedTrackingAccrued);
      expect(userBasicAfter.assetsIn).to.equal(userBasicBefore.assetsIn);
    });
  });

  describe('borrowing position', function () {
    const borrowAmount = exp(100, baseTokenDecimals);

    let totalsBefore: TotalsBasicStructOutput;
    let userBasicBefore: [BigNumber, BigNumber, BigNumber, number, number] & { principal: BigNumber, baseTrackingIndex: BigNumber, baseTrackingAccrued: BigNumber, assetsIn: number, _reserved: number };

    let supplyRateBefore: BigNumber;
    let borrowRateBefore: BigNumber;

    before(async function () {
      // Bob supplies 1 WETH as collateral
      await collaterals.WETH.connect(bob).allocateTo(bob.address, exp(1, 18));
      await collaterals.WETH.connect(bob).approve(comet.address, exp(1, 18));
      await comet.connect(bob).supply(collaterals.WETH.address, exp(1, 18));
    });

    it('should allow borrowing', async function () {
      expect(await comet.connect(bob).withdraw(baseToken.address, borrowAmount)).to.not.be.reverted;
    });

    it('utilization should be > 0 after borrowing', async function () {
      const utilization = await comet.getUtilization();
      expect(utilization).to.be.gt(0);
    });

    it('should allow accruing with utilization > 0', async function () {
      totalsBefore = await comet.totalsBasic();
      userBasicBefore = await comet.userBasic(bob.address);

      const utilization = await comet.getUtilization();
      supplyRateBefore = await comet.getSupplyRate(utilization);
      borrowRateBefore = await comet.getBorrowRate(utilization);

      // Fast forward a month
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(bob.address);
    });

    it('should start accruing with utilization > 0', async function () {
      const totalsAfter = await comet.totalsBasic();

      const timeElapsed = totalsAfter.lastAccrualTime - totalsBefore.lastAccrualTime;
      expect(totalsAfter.baseSupplyIndex).to.be.equal(calculateExpectedIndex(totalsBefore.baseSupplyIndex, supplyRateBefore, timeElapsed));
      expect(totalsAfter.baseBorrowIndex).to.be.equal(calculateExpectedIndex(totalsBefore.baseBorrowIndex, borrowRateBefore, timeElapsed));

      expect(totalsAfter.trackingSupplyIndex).to.equal(calculateExpectedTrackingIndex(totalsBefore.trackingSupplyIndex, BigNumber.from(config.baseTrackingSupplySpeed), timeElapsed, totalsBefore.totalSupplyBase));
      expect(totalsAfter.trackingBorrowIndex).to.equal(calculateExpectedTrackingIndex(totalsBefore.trackingBorrowIndex, BigNumber.from(config.baseTrackingBorrowSpeed), timeElapsed, totalsBefore.totalBorrowBase));

      expect(totalsAfter.totalSupplyBase).to.equal(totalsBefore.totalSupplyBase);
      expect(totalsAfter.totalBorrowBase).to.equal(totalsBefore.totalBorrowBase);    
    });

    it('user position should accrue interest', async function () {
      const userBasicAfter = await comet.userBasic(bob.address);
      const totalsAfter = await comet.totalsBasic();

      const expectedBorrowTrackingIndex = calculateExpectedTrackingIndex(userBasicBefore.baseTrackingIndex, BigNumber.from(config.baseTrackingBorrowSpeed), oneMonth + 1, totalsAfter.totalBorrowBase);
      const expectedBorrowTrackingAccrued = calculateExpectedUserTrackingAccrued(totalsAfter.trackingBorrowIndex, userBasicBefore.baseTrackingIndex, userBasicBefore.principal.mul(-1));

      expect(userBasicAfter.principal).to.be.equal(userBasicBefore.principal);
      expect(userBasicAfter.baseTrackingIndex).to.be.closeTo(expectedBorrowTrackingIndex, 1);
      expect(userBasicAfter.baseTrackingAccrued).to.equal(expectedBorrowTrackingAccrued);
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
      const borrowBalance = await comet.borrowBalanceOf(bob.address);
      expect(borrowBalance).to.equal(0);
    });

    it('utilization should be 0 after repay', async function () {
      const utilization = await comet.getUtilization();
      expect(utilization).to.equal(0);
    });

    it('user position should change to supply after repay', async function () {
      const userBasic = await comet.userBasic(bob.address);
      expect(userBasic.principal).to.be.gt(0);
    });

    it('accruing after repay should not affect user position', async function () {
      const totalsBefore = await comet.totalsBasic();
      const userBasicBefore = await comet.userBasic(bob.address);

      await comet.accrueAccount(bob.address);

      const totalsAfter = await comet.totalsBasic();
      const userBasicAfter = await comet.userBasic(bob.address);

      expect(totalsAfter.baseSupplyIndex).to.be.equal(calculateExpectedIndex(totalsBefore.baseSupplyIndex, await comet.getSupplyRate(0), 1));
      expect(totalsAfter.baseBorrowIndex).to.be.equal(calculateExpectedIndex(totalsBefore.baseBorrowIndex, await comet.getBorrowRate(0), 1));

      expect(totalsAfter.trackingSupplyIndex).to.equal(calculateExpectedTrackingIndex(totalsBefore.trackingSupplyIndex, BigNumber.from(config.baseTrackingSupplySpeed), 1, totalsBefore.totalSupplyBase));
      expect(totalsAfter.trackingBorrowIndex).to.equal(totalsBefore.trackingBorrowIndex);

      expect(userBasicAfter.principal).to.equal(userBasicBefore.principal);
      expect(userBasicAfter.baseTrackingIndex).to.be.closeTo(userBasicBefore.baseTrackingIndex, 2e8);
      expect(userBasicAfter.assetsIn).to.equal(userBasicBefore.assetsIn);
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

    it('accruing after liquidation should not affect user position', async function () {
      const totalsBefore = await comet.totalsBasic();
      const _userBasicBefore = await comet.userBasic(dave.address);

      await comet.accrueAccount(dave.address);

      const totalsAfter = await comet.totalsBasic();
      const userBasicAfter = await comet.userBasic(dave.address);

      expect(totalsAfter.baseSupplyIndex).to.be.equal(calculateExpectedIndex(totalsBefore.baseSupplyIndex, await comet.getSupplyRate(0), 1));
      expect(totalsAfter.baseBorrowIndex).to.be.equal(calculateExpectedIndex(totalsBefore.baseBorrowIndex, await comet.getBorrowRate(0), 1));

      expect(totalsAfter.trackingSupplyIndex).to.equal(calculateExpectedTrackingIndex(totalsBefore.trackingSupplyIndex, BigNumber.from(config.baseTrackingSupplySpeed), 1, totalsBefore.totalSupplyBase));
      expect(totalsAfter.trackingBorrowIndex).to.equal(totalsBefore.trackingBorrowIndex);

      expect(userBasicAfter.principal).to.equal(_userBasicBefore.principal);
      expect(userBasicAfter.baseTrackingIndex).to.equal(totalsAfter.trackingSupplyIndex);
      expect(userBasicAfter.baseTrackingAccrued).to.equal(_userBasicBefore.baseTrackingAccrued);
      expect(userBasicAfter.assetsIn).to.equal(_userBasicBefore.assetsIn);
    });
  });

  describe('edge cases', function () {
    let snapshot: string;
    beforeEach(async function () {
      snapshot = await ethers.provider.send('evm_snapshot', []);
    });

    it('should revert when skipping too much time', async function () {
      await ethers.provider.send('evm_increaseTime', [Number(exp(1, 18))]);
      await ethers.provider.send('evm_mine', []);
      await expect(comet.accrueAccount(alice.address)).to.be.revertedWithCustomError(comet, 'TimestampTooLarge');
      await ethers.provider.send('evm_revert', [snapshot]);
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
      await makeUtilization(comet, 50);

      await ethers.provider.send('evm_increaseTime', [10 * 365 * oneDay]);
      await ethers.provider.send('evm_mine', []);
      await expect(comet.accrueAccount(alice.address)).to.be.revertedWithCustomError(comet, 'InvalidUInt64');
      await ethers.provider.send('evm_revert', [snapshot]);
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
      await makeUtilization(comet, 50);

      await ethers.provider.send('evm_increaseTime', [10 * 365 * oneDay]);
      await ethers.provider.send('evm_mine', []);
      await expect(comet.accrueAccount(alice.address)).to.be.revertedWithCustomError(comet, 'InvalidUInt64');
      await ethers.provider.send('evm_revert', [snapshot]);
    });
  });
});
