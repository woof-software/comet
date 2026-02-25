import { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from 'build/types';
import { ethers, expect, exp, makeProtocol, presentValueBorrow, presentValueSupply, defaultAssets } from './helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber } from 'ethers';

describe('getReserves', function () {
  // Constants
  const baseTokenDecimals = 6;
  const seedAmount = exp(10_000, baseTokenDecimals);
  const supplyAmount = exp(100, baseTokenDecimals);

  const oneDay = 24 * 60 * 60;
  const oneMonth = 30 * oneDay;

  // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken;
  let collaterals: { [symbol: string]: FaucetToken } = {};
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};

  // Accounts
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let dave: SignerWithAddress;
  let charlie: SignerWithAddress;

  before(async () => {
    const protocol = await makeProtocol(
      {
        base: 'USDC',
        baseTrackingBorrowSpeed: exp(1 / 86400, 15, 18), // 1 comp per day
        baseTrackingSupplySpeed: exp(1 / 86400, 15, 18), // 1 comp per day
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
    [alice, bob, dave, charlie] = protocol.users;
  });

  describe('before seeding', function () {
    it('balance should be 0 before seeding', async function () {
      const balance = await baseToken.balanceOf(comet.address);
      expect(balance).to.equal(0);
    });

    it('total supply and borrow should be 0 before seeding', async function () {
      const { totalSupplyBase, totalBorrowBase } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(0);
      expect(totalBorrowBase).to.equal(0);
    });

    it('reserves should be 0 before seeding', async function () {
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(0);
    });
  });

  describe('seeding reserves', function () {
    it('should accept transferred base tokens', async function () {
      await baseToken.connect(alice).allocateTo(alice.address, seedAmount);
      await baseToken.connect(alice).transfer(comet.address, seedAmount);
    });

    it('balance should reflect seeding', async function () {
      const balance = await baseToken.balanceOf(comet.address);
      expect(balance).to.equal(seedAmount);
    });

    it('totalSupply and totalBorrow should still be 0 after seeding', async function () {
      const { totalSupplyBase, totalBorrowBase } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(0);
      expect(totalBorrowBase).to.equal(0);
    });

    it('reserves should equal seedAmount because only base token balance changed', async function () {
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(seedAmount);
    });

    it('should not create position off of seeding', async function () {
      const position = await comet.userBasic(alice.address);
      expect(position.principal).to.equal(0);
    });
  });

  describe('utilization = 0 after seeding', function () {
    it('utilization should be 0', async function () {
      expect(await comet.getUtilization()).to.equal(0);
    });

    it('skip time and accrue', async function () {
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(alice.address);
    });

    it('utilization should still be 0 after time skip', async function () {
      expect(await comet.getUtilization()).to.equal(0);
    });

    it('reserves should not change because utilization is 0', async function () {
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(seedAmount);
    });

    it('totalSupply and totalBorrow should still be 0', async function () {
      const { totalSupplyBase, totalBorrowBase } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(0);
      expect(totalBorrowBase).to.equal(0);
    });
  });

  describe('lending position', function () {
    before(async function () {
      // Alice supplies 100 USDC
      await baseToken.connect(alice).allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve(comet.address, supplyAmount);
      await comet.connect(alice).supply(baseToken.address, supplyAmount);
    });

    it('reserves should not be affected by supplying base tokens', async function () {
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(seedAmount);
    });

    it('total supply should reflect lending', async function () {
      const { totalSupplyBase } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(supplyAmount);
    });

    it('total borrow should still be 0 with no borrowers', async function () {
      const { totalBorrowBase } = await comet.totalsBasic();
      expect(totalBorrowBase).to.equal(0);
    });

    it('balance should reflect lending', async function () {
      const balance = await baseToken.balanceOf(comet.address);
      expect(balance).to.equal(seedAmount + supplyAmount);
    });

    describe('interest accrual with utilization = 0', function () {
      let baseSupplyIndexBefore: BigNumber;
      let baseBorrowIndexBefore: BigNumber;
      before(async function () {
        ({ baseSupplyIndex: baseSupplyIndexBefore, baseBorrowIndex: baseBorrowIndexBefore } = await comet.totalsBasic());
      });

      it('indexes should be > 0', async function () {
        const { baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
        expect(baseSupplyIndex).to.be.gt(0);
        expect(baseBorrowIndex).to.be.gt(0);
      });

      it('utilization should be 0 with no borrowers', async function () {
        expect(await comet.getUtilization()).to.equal(0);
      });

      it('skip time and accrue', async function () {
        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      });

      it('utilization should still be 0', async function () {
        expect(await comet.getUtilization()).to.equal(0);
      });

      it('supply index should stay the same', async function () {
        const { baseSupplyIndex } = await comet.totalsBasic();
        expect(baseSupplyIndex).to.equal(baseSupplyIndexBefore);
      });

      it('borrow index should increase regardless of utilization = 0', async function () {
        const { baseBorrowIndex } = await comet.totalsBasic();
        expect(baseBorrowIndex).to.be.gt(baseBorrowIndexBefore);
      });

      it('reserves should not be affected without interest accruing', async function () {
        const reserves = await comet.getReserves();
        expect(reserves).to.equal(seedAmount);
      });
    });

    it('reserves formula should hold with utilization = 0', async function () {
      const { totalSupplyBase } = await comet.totalsBasic();
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.sub(totalSupplyBase);
      const reserves = await comet.getReserves();

      expect(reserves).to.equal(expectedReserves);
    });
  });

  describe('borrowing position', function () {
    const borrowAmount = exp(100, baseTokenDecimals);

    before(async function () {
      // Bob supplies 1 WETH as collateral
      await collaterals.WETH.connect(bob).allocateTo(bob.address, exp(1, 18));
      await collaterals.WETH.connect(bob).approve(comet.address, exp(1, 18));
      await comet.connect(bob).supply(collaterals.WETH.address, exp(1, 18));
    });

    it('supplying collateral should not change total supply or borrow', async function () {
      const { totalSupplyBase, totalBorrowBase } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(supplyAmount);
      expect(totalBorrowBase).to.equal(0);
    });

    it('reserves should not be affected by supplying collateral', async function () {
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(seedAmount);
    });

    it('should allow borrowing against collateral', async function () {
      await comet.connect(bob).withdraw(baseToken.address, borrowAmount);
    });

    it('borrowBalance and totalBorrowBase should reflect borrow', async function () {
      const borrowBalance = await comet.borrowBalanceOf(bob.address);
      expect(borrowBalance).to.equal(borrowAmount);
      const { totalBorrowBase } = await comet.totalsBasic();
      expect(totalBorrowBase).to.be.gt(0);
    });

    it('reserves should not be affected by borrowing while interest did not yet accrue', async function () {
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(seedAmount);
    });

    describe('interest accrual with utilization > 0', function () {
      let totalSupplyBefore: BigNumber;
      let totalBorrowBefore: BigNumber;
      let baseSupplyIndexBefore: BigNumber;
      let baseBorrowIndexBefore: BigNumber;
      let utilizationBefore: BigNumber;

      before(async function () {
        // Save values before time skip
        const totals = await comet.totalsBasic();
        totalSupplyBefore = totals.totalSupplyBase;
        totalBorrowBefore = totals.totalBorrowBase;
        baseSupplyIndexBefore = totals.baseSupplyIndex;
        baseBorrowIndexBefore = totals.baseBorrowIndex;
        utilizationBefore = await comet.getUtilization();

        // Fast forward a month
        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);
      });

      it('utilization should be > 0 before time skip', async function () {
        expect(utilizationBefore).to.be.gt(0);
      });

      it('totalSupplyBase should remain the same (no interest without accrue)', async function () {
        const { totalSupplyBase } = await comet.totalsBasic();
        expect(totalSupplyBase).to.equal(totalSupplyBefore);
      });

      it('totalBorrowBase principal should remain the same before accrue', async function () {
        const { totalBorrowBase } = await comet.totalsBasic();
        expect(totalBorrowBase).to.equal(totalBorrowBefore);
      });

      it('supply and borrow rates should be > 0', async function () {
        const utilization = await comet.getUtilization();
        const supplyRate = await comet.getSupplyRate(utilization);
        const borrowRate = await comet.getBorrowRate(utilization);
        expect(supplyRate).to.be.gt(0);
        expect(borrowRate).to.be.gt(0);
      });

      it('borrow rate should be greater than supply rate', async function () {
        const utilization = await comet.getUtilization();
        const supplyRate = await comet.getSupplyRate(utilization);
        const borrowRate = await comet.getBorrowRate(utilization);
        expect(borrowRate).to.be.gt(supplyRate);
      });

      it('indices should increase after accrual and match calculated values', async function () {
        const utilization = await comet.getUtilization();
        const supplyRate = await comet.getSupplyRate(utilization);
        const borrowRate = await comet.getBorrowRate(utilization);

        const expectedSupplyIndex = baseSupplyIndexBefore.toBigInt() +
          (BigNumber.from(baseSupplyIndexBefore).mul(supplyRate).mul(oneMonth).div(exp(1, 18))).toBigInt();
        const expectedBorrowIndex = baseBorrowIndexBefore.toBigInt() +
          (BigNumber.from(baseBorrowIndexBefore).mul(borrowRate).mul(oneMonth).div(exp(1, 18))).toBigInt();

        // Accrue to update indices
        await comet.accrueAccount(alice.address);

        const { baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
        expect(baseSupplyIndex).to.be.gt(baseSupplyIndexBefore);
        expect(baseBorrowIndex).to.be.gt(baseBorrowIndexBefore);
        // Small tolerance due to block timestamp rounding
        expect(baseSupplyIndex.toBigInt()).to.be.closeTo(expectedSupplyIndex, exp(1, 8));
        expect(baseBorrowIndex.toBigInt()).to.be.closeTo(expectedBorrowIndex, exp(1, 8));
      });

      it('reserves should grow with interest accrual', async function () {
        const reserves = await comet.getReserves();
        expect(reserves).to.be.gt(seedAmount);
      });

      it('reserves should match the formula: balance + totalBorrow - totalSupply', async function () {
        const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
        const totalSupply_ = presentValueSupply(baseSupplyIndex, totalSupplyBase);
        const totalBorrow_ = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
        const balance = await baseToken.balanceOf(comet.address);
        const expectedReserves = balance.add(totalBorrow_).sub(totalSupply_);
        const reserves = await comet.getReserves();
        expect(reserves).to.equal(expectedReserves);
      });
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

    it('reserves should not be affected by interest accrual with utilization = 0', async function () {
      const reservesBefore = await comet.getReserves();

      // Fast forward a month
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);

      const reserves = await comet.getReserves();
      expect(reserves).to.equal(reservesBefore);
    });
  });

  describe('liquidation', function () {
    const suppliedCollateral = exp(1, 18);

    let totalBorrowBefore: BigNumber;
    let totalSupplyBefore: BigNumber;

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

      await comet.accrueAccount(dave.address);
    });

    it('position should be underwater', async function () {
      const isLiquidatable = await comet.isLiquidatable(dave.address);
      expect(isLiquidatable).to.equal(true);
    });

    it('reserves should decrease by liquidatedAmount minus accrued interest spread', async function () {
      const totalsBefore = await comet.totalsBasic();
      totalBorrowBefore = totalsBefore.totalBorrowBase;
      totalSupplyBefore = totalsBefore.totalSupplyBase;

      const liquidateTx = await comet.connect(alice).absorb(alice.address, [dave.address]);
      const receipt = await liquidateTx.wait();
      liquidatedAmount = receipt.events?.filter((x) => x.event === 'AbsorbDebt')[0].args.basePaidOut;
      expect(liquidatedAmount).to.be.gt(borrowedAmount);
    });

    it('total borrow should decrease after liquidation', async function () {
      const { totalBorrowBase: totalBorrowAfter } = await comet.totalsBasic();
      expect(totalBorrowAfter.add(borrowedAmount)).to.be.gt(totalBorrowBefore);
      expect(totalBorrowAfter).to.be.equal(0);
    });

    it('total supply should not change after liquidation', async function () {
      const { totalSupplyBase: totalSupplyAfter } = await comet.totalsBasic();
      expect(totalSupplyAfter).to.be.equal(totalSupplyBefore);
    });

    let newReserves: BigNumber;
    it('save reserves after liquidation for comparison', async function () {
      newReserves = await comet.getReserves();
      expect(newReserves).to.be.gt(0);
    });

    it('reserves after liquidation should match formula', async function () {
      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const totalSupply_ = presentValueSupply(baseSupplyIndex, totalSupplyBase);
      const totalBorrow_ = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      expect(newReserves).to.equal(balance.add(totalBorrow_).sub(totalSupply_));
    });

    it('wait some time to accrue some interest', async function () {
      // Fast forward a month
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
    });

    it('reserves should not be affected by interest accrual with utilization = 0 after liquidation', async function () {
      expect(newReserves).to.equal(await comet.getReserves());
    });
  });

  describe('negative reserves', function () {
    describe('forming negative reserves', function () {
      it('should allow borrowing all available base tokens (using reserves)', async function () {
        await collaterals.WETH.connect(charlie).allocateTo(charlie.address, exp(80, 18));
        await collaterals.WETH.connect(charlie).approve(comet.address, exp(80, 18));
        await comet.connect(charlie).supply(collaterals.WETH.address, exp(80, 18));

        const currentBalance = await baseToken.balanceOf(comet.address);
        await comet.connect(charlie).withdraw(baseToken.address, currentBalance);
        expect(await baseToken.balanceOf(charlie.address)).to.equal(currentBalance);
      });

      it('skip time for interest to accrue', async function () {
        await ethers.provider.send('evm_increaseTime', [oneMonth * 3]);
        await ethers.provider.send('evm_mine', []);
      });

      it('total borrow should exceed total supply', async function () {
        const { totalSupplyBase, totalBorrowBase } = await comet.totalsBasic();
        const reserves = await comet.getReserves();
        expect(totalBorrowBase).to.be.gt(totalSupplyBase);
        expect(await baseToken.balanceOf(comet.address)).to.equal(0);
        expect(reserves).to.be.greaterThan(totalBorrowBase.sub(totalSupplyBase));
      });
    });

    describe('liquidation causing negative reserves', function () {
      it('position should become liquidatable after price drop', async function () {
        // Drop WETH price by 20% to make Charlie's position liquidatable
        const [, currentPrice] = await priceFeeds.WETH.latestRoundData();
        const droppedPrice = currentPrice.mul(80).div(100);
        await priceFeeds.WETH.setPrice(droppedPrice);
        await comet.accrueAccount(charlie.address);

        const isLiquidatable = await comet.isLiquidatable(charlie.address);
        expect(isLiquidatable).to.equal(true);
      });

      it('reserves should become negative after liquidation', async function () {
        const reservesBefore = await comet.getReserves();

        await comet.connect(bob).absorb(bob.address, [charlie.address]);

        const reservesAfter = await comet.getReserves();
        expect(reservesAfter).to.be.lt(reservesBefore);
        expect(reservesAfter).to.be.lt(0);
      });
    });

    describe('buying collateral to restore reserves', function () {
      let collateralReservesBefore: BigNumber;
      let reservesBefore: BigNumber;

      before(async function () {
        reservesBefore = await comet.getReserves();
      });

      it('collateral reserves should be available for purchase', async function () {
        collateralReservesBefore = await comet.getCollateralReserves(collaterals.WETH.address);
        expect(collateralReservesBefore).to.be.gt(0);
      });

      it('should allow buying collateral', async function () {
        const availableCollateral = (await comet.getCollateralReserves(collaterals.WETH.address)).mul(95).div(100);
        const priceWETH = await comet.getPrice((await comet.getAssetInfoByAddress(collaterals.WETH.address)).priceFeed);
        const priceBase = await comet.getPrice(await comet.baseTokenPriceFeed());

        const amountToPay = availableCollateral.mul(priceWETH).div(priceBase).div(exp(1, 12)); // adjust for price feed decimals
        await baseToken.connect(dave).allocateTo(dave.address, amountToPay);
        await baseToken.connect(dave).approve(comet.address, amountToPay);

        await comet.connect(dave).buyCollateral(collaterals.WETH.address, availableCollateral, amountToPay, dave.address);
      });

      it('collateral reserves should decrease after buying collateral', async function () {
        const collateralReservesAfter = await comet.getCollateralReserves(collaterals.WETH.address);
        expect(collateralReservesAfter).to.be.equal(0);
      });

      it('reserves should increase after buying collateral', async function () {
        const reservesAfter = await comet.getReserves();
        expect(reservesAfter).to.be.gt(reservesBefore);
      });

      it('reserves should be positive after buying collateral even if they were negative before', async function () {
        const reservesAfter = await comet.getReserves();
        expect(reservesAfter).to.be.gt(0);
      });
    });
  });
});

describe('getCollateralReserves', function () {
  // Constants
  const baseTokenDecimals = 6;
  const seedAmount = exp(10_000, baseTokenDecimals);
  const supplyAmount = exp(100, baseTokenDecimals);
  const suppliedCollateral = exp(1, 18); // 1 WETH

  const oneDay = 24 * 60 * 60;
  const oneMonth = 30 * oneDay;

  // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken;
  let collaterals: { [symbol: string]: FaucetToken } = {};
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};

  // Accounts
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  before(async () => {
    const protocol = await makeProtocol(
      {
        base: 'USDC',
        baseTrackingSupplySpeed: 0,
        baseTrackingBorrowSpeed: 0,
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
    [alice, bob] = protocol.users;
  });

  describe('collateral reserves should be 0 initially', function () {
    it('all collateral reserves should be 0', async function () {
      for (const asset of Object.keys(collaterals)) {
        const reserves = await comet.getCollateralReserves(collaterals[asset].address);
        expect(reserves).to.equal(0);
      }
    });
  });

  describe('lending position should not affect collateral reserves', function () {
    before(async function () {
      // Seeding
      await baseToken.connect(alice).allocateTo(alice.address, seedAmount);
      await baseToken.connect(alice).transfer(comet.address, seedAmount);

      // Creating lending position
      await baseToken.connect(alice).allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve(comet.address, supplyAmount);
      await comet.connect(alice).supply(baseToken.address, supplyAmount);
    });

    it('collateral reserves should still be 0 after lending', async function () {
      for (const asset of Object.keys(collaterals)) {
        const reserves = await comet.getCollateralReserves(collaterals[asset].address);
        expect(reserves).to.equal(0);
      }
    });
  });

  describe('borrowing position should not affect collateral reserves', function () {
    before(async function () {
      // Prepare borrowing position for Bob by supplying collateral
      await collaterals.WETH.connect(bob).allocateTo(bob.address, suppliedCollateral);
      await collaterals.WETH.connect(bob).approve(comet.address, suppliedCollateral);
      await comet.connect(bob).supply(collaterals.WETH.address, suppliedCollateral);
    });

    it('collateral reserves should be 0 after supplying collateral', async function () {
      const wethReserves = await comet.getCollateralReserves(collaterals.WETH.address);
      expect(wethReserves).to.equal(0);
    });

    it('should allow borrowing against collateral', async function () {
      const maxBorrow = await comet.getBorrowLimit(bob.address);
      await comet.connect(bob).withdraw(baseToken.address, maxBorrow);
    });

    it('collateral reserves should be 0 after borrowing', async function () {
      const wethReserves = await comet.getCollateralReserves(collaterals.WETH.address);
      expect(wethReserves).to.equal(0);
    });

    it('collateral reserves should be 0 after time skip and accrual', async function () {
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(bob.address);

      const wethReserves = await comet.getCollateralReserves(collaterals.WETH.address);
      expect(wethReserves).to.equal(0);
    });
  });

  describe('liquidation should create collateral reserves', function () {
    before(async function () {
      // Drop WETH price by 20% to make Bob's position liquidatable
      const [, currentPrice] = await priceFeeds.WETH.latestRoundData();
      const droppedPrice = currentPrice.mul(80).div(100);
      await priceFeeds.WETH.setPrice(droppedPrice);
      await comet.accrueAccount(bob.address);
    });

    it('position should be liquidatable', async function () {
      const isLiquidatable = await comet.isLiquidatable(bob.address);
      expect(isLiquidatable).to.equal(true);
    });

    it('collateral reserves should still be 0 before absorb', async function () {
      const wethReserves = await comet.getCollateralReserves(collaterals.WETH.address);
      expect(wethReserves).to.equal(0);
    });

    it('collateral reserves should equal seized collateral after absorb', async function () {
      await comet.connect(alice).absorb(alice.address, [bob.address]);

      const wethReserves = await comet.getCollateralReserves(collaterals.WETH.address);
      expect(wethReserves).to.equal(suppliedCollateral);
    });

    it('non-liquidated collateral reserves should remain 0', async function () {
      const compReserves = await comet.getCollateralReserves(collaterals.COMP.address);
      const wbtcReserves = await comet.getCollateralReserves(collaterals.WBTC.address);
      expect(compReserves).to.equal(0);
      expect(wbtcReserves).to.equal(0);
    });

    it('collateral reserves should not change with time', async function () {
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);

      const wethReserves = await comet.getCollateralReserves(collaterals.WETH.address);
      expect(wethReserves).to.equal(suppliedCollateral);
    });
  });
});

describe('getReserves with supplyInterestRateBase > 0', function () {
  // Constants
  const baseTokenDecimals = 6;
  const seedAmount = exp(10_000, baseTokenDecimals);
  const supplyAmount = exp(100, baseTokenDecimals);

  const oneDay = 24 * 60 * 60;
  const oneMonth = 30 * oneDay;

  // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken;
  let collaterals: { [symbol: string]: FaucetToken } = {};

  // Accounts
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  before(async () => {
    const protocol = await makeProtocol(
      {
        base: 'USDC',
        supplyInterestRateBase: exp(0.01, 18), // 1% base supply rate
        baseTrackingSupplySpeed: 0,
        baseTrackingBorrowSpeed: 0,
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
    [alice, bob] = protocol.users;
  });

  describe('supply rate at utilization = 0', function () {
    it('supplyPerSecondInterestRateBase should be > 0', async function () {
      const rateBase = await comet.supplyPerSecondInterestRateBase();
      expect(rateBase).to.be.gt(0);
    });

    it('utilization should be 0 with no borrows', async function () {
      expect(await comet.getUtilization()).to.equal(0);
    });

    it('supply rate should be > 0 even at utilization = 0', async function () {
      const utilization = await comet.getUtilization();
      expect(utilization).to.equal(0);
      const supplyRate = await comet.getSupplyRate(utilization);
      expect(supplyRate).to.be.gt(0);
    });

    it('supply rate at utilization = 0 should equal supplyPerSecondInterestRateBase', async function () {
      const rateBase = await comet.supplyPerSecondInterestRateBase();
      const supplyRate = await comet.getSupplyRate(0);
      expect(supplyRate).to.equal(rateBase);
    });
  });

  describe('reserves decrease with supply rate base > 0 and no borrows', function () {
    let reservesAfterSeed: BigNumber;
    let baseSupplyIndexBefore: BigNumber;

    before(async function () {
      // Seed reserves
      await baseToken.connect(alice).allocateTo(alice.address, seedAmount);
      await baseToken.connect(alice).transfer(comet.address, seedAmount);
      reservesAfterSeed = await comet.getReserves();
    });

    it('reserves should be equal to seedAmount before the supply', async function () {
      expect(reservesAfterSeed).to.be.eq(seedAmount);
    });

    it('should allow supplying base tokens', async function () {
      // Alice supplies base tokens
      await baseToken.connect(alice).allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve(comet.address, supplyAmount);
      await comet.connect(alice).supply(baseToken.address, supplyAmount);
    });

    it('utilization should still be 0', async function () {
      expect(await comet.getUtilization()).to.equal(0);
    });

    it('save base supply index before accrual', async function () {
      ({ baseSupplyIndex: baseSupplyIndexBefore } = await comet.totalsBasic());
      expect(baseSupplyIndexBefore).to.be.gt(0);
    });

    it('skip time and accrue', async function () {
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(alice.address);
    });

    it('supply index should increase even with utilization = 0', async function () {
      const { baseSupplyIndex } = await comet.totalsBasic();
      expect(baseSupplyIndex).to.be.gt(baseSupplyIndexBefore);
    });

    it('utilization should remain 0', async function () {
      expect(await comet.getUtilization()).to.equal(0);
    });

    it('reserves should decrease because supply interest accrues without borrow interest to offset it', async function () {
      const reserves = await comet.getReserves();
      expect(reserves).to.be.lt(reservesAfterSeed);
    });

    it('reserves formula should hold: balance - totalSupply(presentValue) + totalBorrow(presentValue)', async function () {
      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const totalSupply_ = presentValueSupply(baseSupplyIndex, totalSupplyBase);
      const totalBorrow_ = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.add(totalBorrow_).sub(totalSupply_);
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(expectedReserves);
      expect(totalBorrow_).to.equal(0);
    });
  });

  describe('reserves with supply rate base > 0 and borrows', function () {
    let reservesBefore: BigNumber;
    let baseSupplyIndexBefore: BigNumber;
    let baseBorrowIndexBefore: BigNumber;

    before(async function () {
      // Bob supplies WETH as collateral and borrows
      await collaterals.WETH.connect(bob).allocateTo(bob.address, exp(1, 18));
      await collaterals.WETH.connect(bob).approve(comet.address, exp(1, 18));
      await comet.connect(bob).supply(collaterals.WETH.address, exp(1, 18));
      await comet.connect(bob).withdraw(baseToken.address, supplyAmount);

      reservesBefore = await comet.getReserves();
      const totals = await comet.totalsBasic();
      baseSupplyIndexBefore = totals.baseSupplyIndex;
      baseBorrowIndexBefore = totals.baseBorrowIndex;
    });

    it('utilization should be > 0 with borrows', async function () {
      expect(await comet.getUtilization()).to.be.gt(0);
    });

    it('supply rate should be higher than base rate due to utilization', async function () {
      const rateBase = await comet.supplyPerSecondInterestRateBase();
      const utilization = await comet.getUtilization();
      const supplyRate = await comet.getSupplyRate(utilization);
      expect(supplyRate).to.be.gt(rateBase);
    });

    it('skip time and accrue', async function () {
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(alice.address);
    });

    it('both supply and borrow indices should increase', async function () {
      const { baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      expect(baseSupplyIndex).to.be.gt(baseSupplyIndexBefore);
      expect(baseBorrowIndex).to.be.gt(baseBorrowIndexBefore);
    });

    it('reserves should still grow because borrow interest exceeds supply interest', async function () {
      const reserves = await comet.getReserves();
      expect(reserves).to.be.gt(reservesBefore);
    });

    it('reserves formula should hold', async function () {
      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const totalSupply_ = presentValueSupply(baseSupplyIndex, totalSupplyBase);
      const totalBorrow_ = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.add(totalBorrow_).sub(totalSupply_);
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(expectedReserves);
    });
  });
});
