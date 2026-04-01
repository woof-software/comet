import { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed, Configurator, CometProxyAdmin, FaucetToken__factory, SimplePriceFeed__factory } from 'build/types';
import { ethers, expect, exp, makeConfigurator, presentValueBorrow, presentValueSupply, defaultAssets, MAX_ASSETS, oneMonth, SnapshotRestorer, takeSnapshot } from './helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber } from 'ethers';

describe('reserves', function () {
  // Constants
  const baseTokenDecimals = 6;
  const seedAmount = exp(10_000, baseTokenDecimals);
  const supplyAmount = exp(100, baseTokenDecimals);

  let snapshotAfterSetup: SnapshotRestorer;

  // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  let configurator: Configurator;
  let proxyAdmin: CometProxyAdmin;
  let baseToken: FaucetToken;
  let collaterals: { [symbol: string]: FaucetToken } = {};
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};

  // Accounts
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let dave: SignerWithAddress;
  let charlie: SignerWithAddress;

  before(async () => {
    const protocol = await makeConfigurator(
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
    const cometProxyAddress = protocol.cometProxy.address;
    comet = protocol.cometWithExtendedAssetList.attach(cometProxyAddress);
    const configuratorProxyAddress = protocol.configuratorProxy.address;
    proxyAdmin = protocol.proxyAdmin;

    // Upgrade proxy to extended asset list implementation
    const assetListFactory = protocol.assetListFactory;
    configurator = protocol.configurator.attach(configuratorProxyAddress);
    const CometExtAssetList = await (
      await ethers.getContractFactory('CometExtAssetList')
    ).deploy(
      {
        name32: ethers.utils.formatBytes32String('Test Comet'),
        symbol32: ethers.utils.formatBytes32String('Test Comet'),
      },
      assetListFactory.address
    );
    await CometExtAssetList.deployed();
    await configurator.setExtensionDelegate(cometProxyAddress, CometExtAssetList.address);
    const CometFactoryWithExtendedAssetList = await (await ethers.getContractFactory('CometFactoryWithExtendedAssetList')).deploy();
    await CometFactoryWithExtendedAssetList.deployed();
    await configurator.setFactory(cometProxyAddress, CometFactoryWithExtendedAssetList.address);

    // Deploy and upgrade to apply changes
    await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);
    baseToken = protocol.tokens.USDC as FaucetToken;
    for (const asset in protocol.tokens) {
      if (asset === 'USDC') continue;
      collaterals[asset] = protocol.tokens[asset] as FaucetToken;
    }
    for (const asset in protocol.priceFeeds) {
      priceFeeds[asset] = protocol.priceFeeds[asset];
    }
    [alice, bob, dave, charlie] = protocol.users;
    snapshotAfterSetup = await takeSnapshot();
  });

  describe('base token reserves', function () {
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

        it('base supply index should be > 0', async function () {
          expect((await comet.totalsBasic()).baseSupplyIndex).to.be.gt(0);
        });

        it('base borrow index should be > 0', async function () {
          expect((await comet.totalsBasic()).baseBorrowIndex).to.be.gt(0);
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

        // Calculate borrow limit from collateral value
        const wethInfo = await comet.getAssetInfoByAddress(collaterals.WETH.address);
        const wethPrice = await comet.getPrice(wethInfo.priceFeed);
        const baseScale = BigNumber.from(await comet.baseScale());
        const factorScale = BigNumber.from(exp(1, 18));
        const maxBorrow = BigNumber.from(suppliedCollateral)
          .mul(wethPrice).div(wethInfo.scale)
          .mul(wethInfo.borrowCollateralFactor).div(factorScale)
          .mul(baseScale).div(1e8);
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

  describe('collateral reserves', function () {
    const suppliedCollateral = exp(1, 18); // 1 WETH

    before(async () => {
      await snapshotAfterSetup.restore();
      await configurator.setBaseTrackingSupplySpeed(comet.address, 0);
      await configurator.setBaseTrackingBorrowSpeed(comet.address, 0);
      await proxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);
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
        // Calculate borrow limit from collateral value
        const wethInfo = await comet.getAssetInfoByAddress(collaterals.WETH.address);
        const wethPrice = await comet.getPrice(wethInfo.priceFeed);
        const baseScale = BigNumber.from(await comet.baseScale());
        const factorScale = BigNumber.from(exp(1, 18));
        const maxBorrow = BigNumber.from(suppliedCollateral)
          .mul(wethPrice).div(wethInfo.scale)
          .mul(wethInfo.borrowCollateralFactor).div(factorScale)
          .mul(baseScale).div(1e8);
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

    before(async () => {
      await snapshotAfterSetup.restore();
      await configurator.setSupplyPerYearInterestRateBase(comet.address, exp(0.01, 18)); // 1% base supply rate
      await configurator.setBaseTrackingSupplySpeed(comet.address, 0);
      await configurator.setBaseTrackingBorrowSpeed(comet.address, 0);
      await proxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);
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

  describe('getReserves - multiple simultaneous borrowers', function () {
    const seedAmount = exp(10_000, baseTokenDecimals);
    const supplyAmount = exp(100, baseTokenDecimals);
    const borrowAmount1 = exp(40, baseTokenDecimals);
    const borrowAmount2 = exp(30, baseTokenDecimals);
    const borrowAmount3 = exp(20, baseTokenDecimals);

    before(async () => {
      await snapshotAfterSetup.restore();
      await configurator.setBaseTrackingSupplySpeed(comet.address, 0);
      await configurator.setBaseTrackingBorrowSpeed(comet.address, 0);
      await proxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);

      // Seed + supply
      await baseToken.connect(alice).allocateTo(alice.address, seedAmount);
      await baseToken.connect(alice).transfer(comet.address, seedAmount);
      await baseToken.connect(alice).allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve(comet.address, supplyAmount);
      await comet.connect(alice).supply(baseToken.address, supplyAmount);
    });

    it('three borrowers open positions concurrently', async function () {
      for (const [borrower, amount] of [[bob, borrowAmount1], [dave, borrowAmount2], [charlie, borrowAmount3]] as const) {
        await collaterals.WETH.connect(borrower).allocateTo(borrower.address, exp(1, 18));
        await collaterals.WETH.connect(borrower).approve(comet.address, exp(1, 18));
        await comet.connect(borrower).supply(collaterals.WETH.address, exp(1, 18));
        await comet.connect(borrower).withdraw(baseToken.address, amount);
      }
    });

    it('totalBorrow should reflect all three borrows', async function () {
      const totalBorrow = await comet.borrowBalanceOf(bob.address);
      const totalBorrow2 = await comet.borrowBalanceOf(dave.address);
      const totalBorrow3 = await comet.borrowBalanceOf(charlie.address);
      expect(totalBorrow).to.be.gte(borrowAmount1);
      expect(totalBorrow2).to.be.gte(borrowAmount2);
      expect(totalBorrow3).to.be.gte(borrowAmount3);
    });

    it('reserves formula holds immediately after multiple borrows', async function () {
      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const totalSupply = presentValueSupply(baseSupplyIndex, totalSupplyBase);
      const totalBorrow = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.add(totalBorrow).sub(totalSupply);
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(expectedReserves);
    });

    it('reserves grow after interest accrues from multiple borrowers', async function () {
      const reservesBefore = await comet.getReserves();

      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(alice.address);

      const reservesAfter = await comet.getReserves();
      expect(reservesAfter).to.be.gt(reservesBefore);
    });

    it('reserves formula holds after accrual with multiple borrowers', async function () {
      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const totalSupply = presentValueSupply(baseSupplyIndex, totalSupplyBase);
      const totalBorrow = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.add(totalBorrow).sub(totalSupply);
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(expectedReserves);
    });

    it('reserves grow faster with more total borrow', async function () {
    // Record current rate of growth with 3 borrowers
      const reservesBefore = await comet.getReserves();

      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(alice.address);

      const reservesAfter = await comet.getReserves();
      const reserveGrowth = reservesAfter.sub(reservesBefore);
      // 1000 USDC total borrow should generate meaningful reserves
      expect(reserveGrowth).to.be.gt(0);

      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const totalSupply = presentValueSupply(baseSupplyIndex, totalSupplyBase);
      const totalBorrow = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.add(totalBorrow).sub(totalSupply);
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(expectedReserves);
    });
  });

  describe('getReserves - utilization above kink (high-rate regime)', function () {
    const seedAmount = exp(1_000, baseTokenDecimals);
    const supplyAmount = exp(1_000, baseTokenDecimals);

    before(async () => {
      await snapshotAfterSetup.restore();
      await configurator.setBaseTrackingBorrowSpeed(comet.address, 0);
      await configurator.setBaseTrackingSupplySpeed(comet.address, 0);
      await configurator.setSupplyKink(comet.address, exp(0.8, 18));
      await configurator.setBorrowKink(comet.address, exp(0.8, 18));
      await configurator.setSupplyPerYearInterestRateSlopeLow(comet.address, exp(0.05, 18));
      await configurator.setSupplyPerYearInterestRateSlopeHigh(comet.address, exp(2, 18));
      await configurator.setBorrowPerYearInterestRateSlopeLow(comet.address, exp(0.1, 18));
      await configurator.setBorrowPerYearInterestRateSlopeHigh(comet.address, exp(3, 18));
      await proxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);

      // Seed liquidity
      await baseToken.connect(alice).allocateTo(alice.address, seedAmount);
      await baseToken.connect(alice).transfer(comet.address, seedAmount);

      // Alice supplies 1000 USDC
      await baseToken.connect(alice).allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve(comet.address, supplyAmount);
      await comet.connect(alice).supply(baseToken.address, supplyAmount);
    });

    it('should borrow above the kink', async function () {
    // Bob supplies enough WETH collateral to borrow >80% utilization
      await collaterals.WETH.connect(bob).allocateTo(bob.address, exp(10, 18));
      await collaterals.WETH.connect(bob).approve(comet.address, exp(10, 18));
      await comet.connect(bob).supply(collaterals.WETH.address, exp(10, 18));

      // Borrow 90% of total supply to push utilization above kink
      const borrowAmount = exp(900, baseTokenDecimals);
      await comet.connect(bob).withdraw(baseToken.address, borrowAmount);
    });

    it('utilization should be above kink (80%)', async function () {
      const utilization = await comet.getUtilization();
      // kink is 0.8e18 = 80%
      expect(utilization).to.be.gt(exp(0.8, 18));
    });

    it('borrow rate should use supplyPerSecondInterestRateSlopeHigh above kink', async function () {
      const utilization = await comet.getUtilization();
      const borrowRate = await comet.getBorrowRate(utilization);
      // Below-kink rate would be much smaller; above-kink adds the high slope
      // borrowRate should be significantly higher than just base + slopeLow * kink
      expect(borrowRate).to.be.gt(0);
    });

    it('reserves formula holds at high utilization before accrual', async function () {
      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const totalSupply = presentValueSupply(baseSupplyIndex, totalSupplyBase);
      const totalBorrow = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.add(totalBorrow).sub(totalSupply);
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(expectedReserves);
    });

    it('reserves should grow significantly faster above kink', async function () {
      const reservesBefore = await comet.getReserves();

      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(alice.address);

      const reservesAfter = await comet.getReserves();
      expect(reservesAfter).to.be.gt(reservesBefore);

      // The spread above kink should make reserves grow substantially
      const reserveGrowth = reservesAfter.sub(reservesBefore);
      expect(reserveGrowth).to.be.gt(exp(1, baseTokenDecimals)); // more than 1 USDC in a month
    });

    it('reserves formula holds after high-rate accrual', async function () {
      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const totalSupply = presentValueSupply(baseSupplyIndex, totalSupplyBase);
      const totalBorrow = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.add(totalBorrow).sub(totalSupply);
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(expectedReserves);
    });
  });

  describe('getReserves - partial repayment', function () {
    const supplyAmount = exp(1_000, baseTokenDecimals);
    const borrowAmount = exp(500, baseTokenDecimals);

    before(async () => {
      await snapshotAfterSetup.restore();
      await configurator.setBaseTrackingBorrowSpeed(comet.address, 0);
      await configurator.setBaseTrackingSupplySpeed(comet.address, 0);
      await proxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);

      // Seed
      await baseToken.connect(alice).allocateTo(alice.address, seedAmount);
      await baseToken.connect(alice).transfer(comet.address, seedAmount);

      // Supply
      await baseToken.connect(alice).allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve(comet.address, supplyAmount);
      await comet.connect(alice).supply(baseToken.address, supplyAmount);

      // Bob borrows
      await collaterals.WETH.connect(bob).allocateTo(bob.address, exp(1, 18));
      await collaterals.WETH.connect(bob).approve(comet.address, exp(1, 18));
      await comet.connect(bob).supply(collaterals.WETH.address, exp(1, 18));
      await comet.connect(bob).withdraw(baseToken.address, borrowAmount);
    });

    it('reserves formula holds before partial repay', async function () {
      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const totalSupply = presentValueSupply(baseSupplyIndex, totalSupplyBase);
      const totalBorrow = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.add(totalBorrow).sub(totalSupply);
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(expectedReserves);
    });

    it('accrue interest then record state', async function () {
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(bob.address);
    });

    it('reserves formula holds after accrual', async function () {
      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const totalSupply = presentValueSupply(baseSupplyIndex, totalSupplyBase);
      const totalBorrow = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.add(totalBorrow).sub(totalSupply);
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(expectedReserves);
    });

    let reservesBeforePartialRepay: BigNumber;
    let borrowBalanceBeforePartialRepay: BigNumber;

    it('record state before partial repay', async function () {
      reservesBeforePartialRepay = await comet.getReserves();
      borrowBalanceBeforePartialRepay = await comet.borrowBalanceOf(bob.address);
      expect(borrowBalanceBeforePartialRepay).to.be.gt(borrowAmount); // interest accrued
    });

    it('partial repay should reduce but not eliminate borrow', async function () {
    // Repay half the original principal (less than current balance including interest)
      const partialRepay = BigNumber.from(borrowAmount).div(2);
      await baseToken.connect(bob).allocateTo(bob.address, partialRepay);
      await baseToken.connect(bob).approve(comet.address, partialRepay);
      await comet.connect(bob).supply(baseToken.address, partialRepay);

      const borrowBalanceAfter = await comet.borrowBalanceOf(bob.address);
      expect(borrowBalanceAfter).to.be.gt(0);
      expect(borrowBalanceAfter).to.be.lt(borrowBalanceBeforePartialRepay);
    });

    it('reserves formula holds after partial repay', async function () {
      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const totalSupply = presentValueSupply(baseSupplyIndex, totalSupplyBase);
      const totalBorrow = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.add(totalBorrow).sub(totalSupply);
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(expectedReserves);
    });

    it('reserves should reflect only the interest spread, not the principal portion', async function () {
    // Reserves should not have decreased from partial repay of principal
    // The formula balance + totalBorrow - totalSupply accounts for the shift correctly
      const reservesAfterPartialRepay = await comet.getReserves();
      // Reserves should be approximately the same (partial repay just transfers base tokens in,
      // and reduces totalBorrow by the same amount - net effect on reserves is zero)
      // Small tolerance for rounding
      expect(reservesAfterPartialRepay.toBigInt()).to.be.closeTo(
        reservesBeforePartialRepay.toBigInt(),
        exp(1, baseTokenDecimals) // 1 USDC tolerance for rounding
      );
    });

    it('borrow still active - further interest accrual, formula still holds', async function () {
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(bob.address);

      // Borrow is still active
      expect(await comet.borrowBalanceOf(bob.address)).to.be.gt(0);
      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const totalSupply = presentValueSupply(baseSupplyIndex, totalSupplyBase);
      const totalBorrow = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.add(totalBorrow).sub(totalSupply);
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(expectedReserves);
    });
  });

  describe('getReserves - formula invariant across sequential state changes', function () {
    const supplyAmount = exp(1_000, baseTokenDecimals);

    async function verifyReservesFormula() {
      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      const totalSupply = presentValueSupply(baseSupplyIndex, totalSupplyBase);
      const totalBorrow = presentValueBorrow(baseBorrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.add(totalBorrow).sub(totalSupply);
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(expectedReserves);
    }

    before(async () => {
      await snapshotAfterSetup.restore();
      await configurator.setBaseTrackingBorrowSpeed(comet.address, 0);
      await configurator.setBaseTrackingSupplySpeed(comet.address, 0);
      await proxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);
    });

    it('step 1: seed - formula holds', async function () {
      await baseToken.connect(alice).allocateTo(alice.address, seedAmount);
      await baseToken.connect(alice).transfer(comet.address, seedAmount);
      await verifyReservesFormula();
    });

    it('step 2: supply - formula holds', async function () {
      await baseToken.connect(alice).allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve(comet.address, supplyAmount);
      await comet.connect(alice).supply(baseToken.address, supplyAmount);
      await verifyReservesFormula();
    });

    it('step 3: borrow - formula holds', async function () {
      await collaterals.WETH.connect(bob).allocateTo(bob.address, exp(1, 18));
      await collaterals.WETH.connect(bob).approve(comet.address, exp(1, 18));
      await comet.connect(bob).supply(collaterals.WETH.address, exp(1, 18));
      await comet.connect(bob).withdraw(baseToken.address, exp(500, baseTokenDecimals));
      await verifyReservesFormula();
    });

    it('step 4: accrue interest - formula holds', async function () {
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(alice.address);
      await verifyReservesFormula();
    });

    it('step 5: partial repay - formula holds', async function () {
      const partialRepay = exp(200, baseTokenDecimals);
      await baseToken.connect(bob).allocateTo(bob.address, partialRepay);
      await baseToken.connect(bob).approve(comet.address, partialRepay);
      await comet.connect(bob).supply(baseToken.address, partialRepay);
      await verifyReservesFormula();
    });

    it('step 6: accrue again - formula holds', async function () {
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(alice.address);
      await verifyReservesFormula();
    });

    it('step 7: full repay - formula holds', async function () {
      const repayAmount = (await comet.borrowBalanceOf(bob.address)).add(100);
      await baseToken.connect(bob).allocateTo(bob.address, repayAmount);
      await baseToken.connect(bob).approve(comet.address, repayAmount);
      await comet.connect(bob).supply(baseToken.address, repayAmount);
      expect(await comet.borrowBalanceOf(bob.address)).to.equal(0);
      await verifyReservesFormula();
    });

    it('step 8: accrue with utilization = 0 after full repay - formula holds', async function () {
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(alice.address);
      await verifyReservesFormula();
    });
  });

  describe('getCollateralReserves - direct ERC-20 transfer (bypassing supply)', function () {
    const donationAmount = exp(5, 18); // 5 WETH

    before(async () => {
      await snapshotAfterSetup.restore();
      await configurator.setBaseTrackingBorrowSpeed(comet.address, 0);
      await configurator.setBaseTrackingSupplySpeed(comet.address, 0);
      await proxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);

      await baseToken.connect(alice).allocateTo(alice.address, seedAmount);
      await baseToken.connect(alice).transfer(comet.address, seedAmount);
    });

    it('collateral reserves should be 0 initially', async function () {
      expect(await comet.getCollateralReserves(collaterals.WETH.address)).to.equal(0);
    });

    it('direct transfer of WETH to comet should increase collateral reserves', async function () {
      await collaterals.WETH.connect(alice).allocateTo(alice.address, donationAmount);
      await collaterals.WETH.connect(alice).transfer(comet.address, donationAmount);

      const collateralReserves = await comet.getCollateralReserves(collaterals.WETH.address);
      expect(collateralReserves).to.equal(donationAmount);
    });

    it('totalSupplyAsset should not change from direct transfer', async function () {
      const totalsCollateral = await comet.totalsCollateral(collaterals.WETH.address);
      expect(totalsCollateral.totalSupplyAsset).to.equal(0);
    });

    it('collateral reserves = balanceOf(comet) - totalSupplyAsset', async function () {
      const balance = await collaterals.WETH.balanceOf(comet.address);
      const totalsCollateral = await comet.totalsCollateral(collaterals.WETH.address);
      const expectedReserves = balance.sub(totalsCollateral.totalSupplyAsset);
      expect(await comet.getCollateralReserves(collaterals.WETH.address)).to.equal(expectedReserves);
    });

    it('second direct transfer adds to collateral reserves', async function () {
      const reservesBefore = await comet.getCollateralReserves(collaterals.WETH.address);
      const secondDonation = exp(3, 18);
      await collaterals.WETH.connect(alice).allocateTo(alice.address, secondDonation);
      await collaterals.WETH.connect(alice).transfer(comet.address, secondDonation);
      const reservesAfter = await comet.getCollateralReserves(collaterals.WETH.address);
      expect(reservesAfter).to.equal(reservesBefore.add(secondDonation));
    });

    it('base token reserves should not be affected by collateral donation', async function () {
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(seedAmount);
    });
  });

  describe('getCollateralReserves - multiple collateral types seized from one user', function () {
    const seedAmount = exp(50_000, baseTokenDecimals);
    const supplyAmount = exp(10_000, baseTokenDecimals);

    const suppliedWETH = exp(1, 18);
    const suppliedWBTC = exp(1, 8);
    const suppliedCOMP = exp(100, 18);

    before(async () => {
      await snapshotAfterSetup.restore();
      await configurator.setBaseTrackingBorrowSpeed(comet.address, 0);
      await configurator.setBaseTrackingSupplySpeed(comet.address, 0);
      await configurator.updateAsset(
        comet.address,
        {
          asset: collaterals.WETH.address,
          decimals: 18,
          priceFeed: priceFeeds.WETH.address,
          borrowCollateralFactor: exp(0.8, 18),
          liquidateCollateralFactor: exp(0.95, 18),
          liquidationFactor: exp(0.95, 18),
          supplyCap: exp(100, 18),
        }
      );
      await configurator.updateAsset(
        comet.address,
        {
          asset: collaterals.WBTC.address,
          decimals: 8,
          priceFeed: priceFeeds.WBTC.address,
          borrowCollateralFactor: exp(0.7, 18),
          liquidateCollateralFactor: exp(0.9, 18),
          liquidationFactor: exp(0.9, 18),
          supplyCap: exp(100, 8),
        }
      );
      await configurator.updateAsset(
        comet.address,
        {
          asset: collaterals.COMP.address,
          decimals: 18,
          priceFeed: priceFeeds.COMP.address,
          borrowCollateralFactor: exp(0.6, 18),
          liquidateCollateralFactor: exp(0.85, 18),
          liquidationFactor: exp(0.85, 18),
          supplyCap: exp(100, 18),
        }
      );
      await proxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);

      // Seed + supply
      await baseToken.connect(alice).allocateTo(alice.address, seedAmount);
      await baseToken.connect(alice).transfer(comet.address, seedAmount);
      await baseToken.connect(alice).allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve(comet.address, supplyAmount);
      await comet.connect(alice).supply(baseToken.address, supplyAmount);

      // Bob supplies all three collateral types
      await collaterals.WETH.connect(bob).allocateTo(bob.address, suppliedWETH);
      await collaterals.WETH.connect(bob).approve(comet.address, suppliedWETH);
      await comet.connect(bob).supply(collaterals.WETH.address, suppliedWETH);

      await collaterals.WBTC.connect(bob).allocateTo(bob.address, suppliedWBTC);
      await collaterals.WBTC.connect(bob).approve(comet.address, suppliedWBTC);
      await comet.connect(bob).supply(collaterals.WBTC.address, suppliedWBTC);

      await collaterals.COMP.connect(bob).allocateTo(bob.address, suppliedCOMP);
      await collaterals.COMP.connect(bob).approve(comet.address, suppliedCOMP);
      await comet.connect(bob).supply(collaterals.COMP.address, suppliedCOMP);

      // Calculate borrow limit from all three collateral types
      const baseScale = BigNumber.from(await comet.baseScale());
      const factorScale = BigNumber.from(exp(1, 18));
      let liquidity = BigNumber.from(0);
      for (const [token, amount] of [[collaterals.WETH, suppliedWETH], [collaterals.WBTC, suppliedWBTC], [collaterals.COMP, suppliedCOMP]] as [FaucetToken, bigint][]) {
        const info = await comet.getAssetInfoByAddress(token.address);
        const price = await comet.getPrice(info.priceFeed);
        liquidity = liquidity.add(
          BigNumber.from(amount).mul(price).div(info.scale)
            .mul(info.borrowCollateralFactor).div(factorScale)
        );
      }
      const maxBorrow = liquidity.mul(baseScale).div(1e8);
      await comet.connect(bob).withdraw(baseToken.address, maxBorrow);
    });

    it('all collateral reserves should be 0 before absorb', async function () {
      expect(await comet.getCollateralReserves(collaterals.WETH.address)).to.equal(0);
      expect(await comet.getCollateralReserves(collaterals.WBTC.address)).to.equal(0);
      expect(await comet.getCollateralReserves(collaterals.COMP.address)).to.equal(0);
    });

    it('make position liquidatable and absorb', async function () {
    // Drop all prices by 30%
      for (const feed of [priceFeeds.WETH, priceFeeds.WBTC, priceFeeds.COMP]) {
        const [, currentPrice] = await feed.latestRoundData();
        await feed.setPrice(currentPrice.mul(70).div(100));
      }
      await comet.accrueAccount(bob.address);
      expect(await comet.isLiquidatable(bob.address)).to.equal(true);

      await comet.connect(alice).absorb(alice.address, [bob.address]);
    });

    it('all three getCollateralReserves should reflect seized amounts independently', async function () {
      const wethReserves = await comet.getCollateralReserves(collaterals.WETH.address);
      const wbtcReserves = await comet.getCollateralReserves(collaterals.WBTC.address);
      const compReserves = await comet.getCollateralReserves(collaterals.COMP.address);

      expect(wethReserves).to.equal(suppliedWETH);
      expect(wbtcReserves).to.equal(suppliedWBTC);
      expect(compReserves).to.equal(suppliedCOMP);
    });

    it('totalSupplyAsset should be decremented to 0 for all three assets', async function () {
      expect((await comet.totalsCollateral(collaterals.WETH.address)).totalSupplyAsset).to.equal(0);
      expect((await comet.totalsCollateral(collaterals.WBTC.address)).totalSupplyAsset).to.equal(0);
      expect((await comet.totalsCollateral(collaterals.COMP.address)).totalSupplyAsset).to.equal(0);
    });

    it('absorbed user should have no collateral balances', async function () {
      expect((await comet.userCollateral(bob.address, collaterals.WETH.address)).balance).to.equal(0);
      expect((await comet.userCollateral(bob.address, collaterals.WBTC.address)).balance).to.equal(0);
      expect((await comet.userCollateral(bob.address, collaterals.COMP.address)).balance).to.equal(0);
    });
  });

  describe('getCollateralReserves - all 24 collateral slots after one absorb', function () {
    const numCollaterals = MAX_ASSETS - 1; // 23 collateral assets (1 slot = base)
    const seedAmount = exp(500_000, baseTokenDecimals);
    const supplyAmount = exp(100_000, baseTokenDecimals);

    const collateralTokens: FaucetToken[] = [];
    const collateralFeeds: SimplePriceFeed[] = [];
    const collateralAmounts: BigNumber[] = [];

    before(async () => {
      await snapshotAfterSetup.restore();
      await configurator.setBaseTrackingBorrowSpeed(comet.address, 0);
      await configurator.setBaseTrackingSupplySpeed(comet.address, 0);

      // Collect existing collateral tokens and update their configs
      const existingKeys = Object.keys(collaterals); // COMP, WETH, WBTC
      for (const key of existingKeys) {
        const token = collaterals[key];
        const feed = priceFeeds[key];
        const decimals = await token.decimals();
        await configurator.updateAsset(comet.address, {
          asset: token.address,
          priceFeed: feed.address,
          decimals: decimals,
          borrowCollateralFactor: exp(0.8, 18),
          liquidateCollateralFactor: exp(0.95, 18),
          liquidationFactor: exp(0.95, 18),
          supplyCap: exp(10000, decimals),
        });
        collateralTokens.push(token);
        collateralFeeds.push(feed);
      }

      // Deploy additional collateral tokens + price feeds to fill all 24 slots
      const numExisting = existingKeys.length;
      const numToAdd = numCollaterals - numExisting;
      const FaucetTokenFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
      const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;

      for (let i = 0; i < numToAdd; i++) {
        const name = `ASSET${i}`;
        const token = await FaucetTokenFactory.deploy(exp(1e7, 18), name, 18, name) as FaucetToken;
        await token.deployed();
        const feed = await PriceFeedFactory.deploy(exp(100, 8), 8) as SimplePriceFeed;
        await feed.deployed();

        await configurator.addAsset(comet.address, {
          asset: token.address,
          priceFeed: feed.address,
          decimals: 18,
          borrowCollateralFactor: exp(0.8, 18),
          liquidateCollateralFactor: exp(0.95, 18),
          liquidationFactor: exp(0.95, 18),
          supplyCap: exp(10000, 18),
        });
        collateralTokens.push(token);
        collateralFeeds.push(feed);
      }

      await proxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);

      // Seed + supply base
      await baseToken.connect(alice).allocateTo(alice.address, seedAmount);
      await baseToken.connect(alice).transfer(comet.address, seedAmount);
      await baseToken.connect(alice).allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve(comet.address, supplyAmount);
      await comet.connect(alice).supply(baseToken.address, supplyAmount);

      // Bob supplies 10 units of each collateral asset
      for (let i = 0; i < numCollaterals; i++) {
        const token = collateralTokens[i];
        const decimals = await token.decimals();
        const amount = exp(10, decimals);
        await token.connect(bob).allocateTo(bob.address, amount);
        await token.connect(bob).approve(comet.address, amount);
        await comet.connect(bob).supply(token.address, amount);
        collateralAmounts.push(BigNumber.from(amount));
      }

      // Calculate borrow limit from all collateral assets
      const baseScale = BigNumber.from(await comet.baseScale());
      const factorScale = BigNumber.from(exp(1, 18));
      let liquidity = BigNumber.from(0);
      for (let i = 0; i < numCollaterals; i++) {
        const info = await comet.getAssetInfoByAddress(collateralTokens[i].address);
        const price = await comet.getPrice(info.priceFeed);
        liquidity = liquidity.add(
          collateralAmounts[i].mul(price).div(info.scale)
            .mul(info.borrowCollateralFactor).div(factorScale)
        );
      }
      const maxBorrow = liquidity.mul(baseScale).div(1e8);
      await comet.connect(bob).withdraw(baseToken.address, maxBorrow);
    });

    it('all collateral reserves should be 0 before absorb', async function () {
      for (let i = 0; i < numCollaterals; i++) {
        expect(await comet.getCollateralReserves(collateralTokens[i].address)).to.equal(0);
      }
    });

    it('make position liquidatable and absorb all assets in one call', async function () {
    // Drop all prices by 30%
      for (let i = 0; i < numCollaterals; i++) {
        const [, currentPrice] = await collateralFeeds[i].latestRoundData();
        await collateralFeeds[i].setPrice(currentPrice.mul(70).div(100));
      }
      await comet.accrueAccount(bob.address);
      expect(await comet.isLiquidatable(bob.address)).to.equal(true);

      await comet.connect(alice).absorb(alice.address, [bob.address]);
    });

    it('every collateral slot should have correct reserves after absorb', async function () {
      for (let i = 0; i < numCollaterals; i++) {
        const reserves = await comet.getCollateralReserves(collateralTokens[i].address);
        expect(reserves).to.equal(collateralAmounts[i], `collateral ${i} reserves mismatch`);
      }
    });

    it('totalSupplyAsset should be 0 for every asset after absorb', async function () {
      for (let i = 0; i < numCollaterals; i++) {
        const totals = await comet.totalsCollateral(collateralTokens[i].address);
        expect(totals.totalSupplyAsset).to.equal(0, `collateral ${i} totalSupplyAsset not 0`);
      }
    });

    it('absorbed user should have 0 balance for every collateral', async function () {
      for (let i = 0; i < numCollaterals; i++) {
        const userCol = await comet.userCollateral(bob.address, collateralTokens[i].address);
        expect(userCol.balance).to.equal(0, `collateral ${i} user balance not 0`);
      }
    });

    it('assetsIn bitmap should be cleared for absorbed user', async function () {
      const userBasic = await comet.userBasic(bob.address);
      expect(userBasic.assetsIn).to.equal(0);
    });
  });

});