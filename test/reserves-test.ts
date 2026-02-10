import { CometHarnessInterfaceExtendedAssetList, FaucetToken } from 'build/types';
import { ethers, expect, exp, makeProtocol, presentValueBorrow, presentValueSupply, defaultAssets } from './helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber } from 'ethers';

describe.only('getReserves', function () {
  // Constants
  const baseTokenDecimals = 6;
  const seedAmount = exp(10_000, baseTokenDecimals);

  const oneDay = 24 * 60 * 60;
  const oneMonth = 30 * oneDay;
  // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken;
  let collaterals: { [symbol: string]: FaucetToken } = {};
  // Accounts
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let dave: SignerWithAddress;

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
    [alice, bob, dave] = protocol.users;
  });

  describe('before seeding', function () {
    it('balance should be 0 before seeding', async function () {
      const balance = await baseToken.balanceOf(comet.address);
      expect(balance).to.equal(0);
    });

    it('total supply and borrow should be 0 before seeding', async function () {
      const {
        totalSupplyBase,
        totalBorrowBase
      } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(0);
      expect(totalBorrowBase).to.equal(0);
    });

    it('reserves should 0 before seeding', async function () {
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(0);
    });
  });

  describe('seeding reserves', function () {
    it('should accept transferred base tokens', async function () {
      await baseToken.connect(alice).allocateTo(alice.address, seedAmount);
      const tx = await baseToken.connect(alice).transfer(comet.address, seedAmount);
      await tx.wait();
    });

    it('balance should reflect seeding', async function () {
      const balance = await baseToken.balanceOf(comet.address);
      expect(balance).to.equal(seedAmount);
    });

    it('reserves should reflect transferred base tokens', async function () {
      let reserves = await comet.getReserves();
      expect(reserves).to.equal(seedAmount);
    });

    it('should not create position off of seeding', async function () {
      const position = await comet.userBasic(alice.address);
      expect(position.principal).to.equal(0);
    });

    it('reserves should not grow with utilization = 0', async function () {
      expect(await comet.getUtilization()).to.equal(0);
      // Fast forward a month
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);

      await comet.accrueAccount(alice.address);
      const reserves = await comet.getReserves();
      expect(await comet.getUtilization()).to.equal(0);
      expect(reserves).to.equal(seedAmount);
    });

    it('total supply and borrow should be 0 after seeding', async function () {
      const {
        totalSupplyBase,
        totalBorrowBase
      } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(0);
      expect(totalBorrowBase).to.equal(0);
    });
  });

  describe('lending position', function () {
    before(async function () {
      // Alice supplies 100 USDC
      const supplyAmount = exp(100, baseTokenDecimals);
      await baseToken.connect(alice).allocateTo(alice.address, supplyAmount);
      await baseToken.connect(alice).approve(comet.address, supplyAmount);
      const supplyTx = await comet.connect(alice).supply(baseToken.address, supplyAmount);
      await supplyTx.wait();
    });

    it('reserves should not be affected by supplying base tokens', async function () {
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(seedAmount);
    });

    it('total supply should reflect lending', async function () {
      const { totalSupplyBase } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(exp(100, baseTokenDecimals));
    });

    it('total borrow should still be 0 with no borrowers', async function () {
      const { totalBorrowBase } = await comet.totalsBasic();
      expect(totalBorrowBase).to.equal(0);
    });

    it('balance should reflect lending', async function () {
      const balance = await baseToken.balanceOf(comet.address);
      expect(balance).to.equal(seedAmount + (exp(100, baseTokenDecimals)));
    });

    it('reserves should not be affected by interest accrual with utilization = 0', async function () {
      expect(await comet.getUtilization()).to.equal(0);
      // Fast forward a month
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);

      await comet.accrueAccount(alice.address);
      const reserves = await comet.getReserves();
      expect(await comet.getUtilization()).to.equal(0);
      expect(reserves).to.equal(seedAmount);
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
    before(async function () {
      // Bob supplies 1 WETH as collateral
      await collaterals.WETH.connect(bob).allocateTo(bob.address, exp(1, 18));
      await collaterals.WETH.connect(bob).approve(comet.address, exp(1, 18));
      const collateralTx = await comet.connect(bob).supply(collaterals.WETH.address, exp(1, 18));
      await collateralTx.wait();
    });

    it('supplying collateral should not change total supply or borrow', async function () {
      const {
        totalSupplyBase,
        totalBorrowBase
      } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(exp(100, baseTokenDecimals)); // previous supply
      expect(totalBorrowBase).to.equal(0);
    });

    it('reserves should not be affected by supplying collateral', async function () {
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(seedAmount);
    });

    it('should allow borrowing against collateral', async function () {
      const borrowAmount = exp(100, baseTokenDecimals);
      const borrowTx = await comet.connect(bob).withdraw(baseToken.address, borrowAmount);
      await borrowTx.wait();
      expect(await baseToken.balanceOf(bob.address)).to.equal(borrowAmount);
    });

    it('reserves should not be affected by borrowing while interest did not yet accrue', async function () {
      const reserves = await comet.getReserves();
      expect(reserves).to.equal(seedAmount);
    });

    it('reserves should grow with interest accrual', async function () {
      // Fast forward a month
      await ethers.provider.send('evm_increaseTime', [oneMonth]);
      await ethers.provider.send('evm_mine', []);

      const reserves = await comet.getReserves();
      const { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
      expect(totalSupplyBase).to.equal(exp(100, baseTokenDecimals));
      expect(totalBorrowBase).to.be.gt(0);
      const utilization = await comet.getUtilization();
      expect(utilization).to.be.gt(0);

      const supplyRate = await comet.getSupplyRate(utilization);
      const borrowRate = await comet.getBorrowRate(utilization);

      const supplyIndex = baseSupplyIndex.toBigInt() + (BigNumber.from(baseSupplyIndex).mul(supplyRate).mul(oneMonth).div(exp(1, 18))).toBigInt(); 
      const borrowIndex = baseBorrowIndex.toBigInt() + (BigNumber.from(baseBorrowIndex).mul(borrowRate).mul(oneMonth).div(exp(1, 18))).toBigInt();

      const totalSupply_ = presentValueSupply(supplyIndex, totalSupplyBase);
      const totalBorrow_ = presentValueBorrow(borrowIndex, totalBorrowBase);
      const balance = await baseToken.balanceOf(comet.address);
      const expectedReserves = balance.add(totalBorrow_).sub(totalSupply_);
      expect(reserves).to.be.gt(seedAmount);
      expect(reserves).to.equal(expectedReserves);
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
      const repayTx = await comet.connect(bob).supply(baseToken.address, repayAmount);
      await repayTx.wait();
      expect(await comet.borrowBalanceOf(bob.address)).to.equal(0);
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
    let reservesBefore: BigNumber;
    let totalBorrowBefore: BigNumber;
    let totalSupplyBefore: BigNumber;

    let borrowedAmount: BigNumber;
    let liquidatedAmount: BigNumber;
    before(async function () {
      // prepare position for liquidation
      await collaterals.WETH.connect(dave).allocateTo(dave.address, exp(1, 18));
      await collaterals.WETH.connect(dave).approve(comet.address, exp(1, 18));
      const collateralTx = await comet.connect(dave).supply(collaterals.WETH.address, exp(1, 18));
      await collateralTx.wait();

      const maxBorrow = await comet.getBorrowLimit(dave.address);
      borrowedAmount = maxBorrow;
      const borrowTx = await comet.connect(dave).withdraw(baseToken.address, maxBorrow);
      await borrowTx.wait();

      // skip time until position is underwater
      let i = 0;
      while (!(await comet.isLiquidatable(dave.address)) && i < 100) {
        await ethers.provider.send('evm_increaseTime', [oneDay]);
        await ethers.provider.send('evm_mine', []);

        await comet.accrueAccount(dave.address);
        i++;
      }
    });

    it('position should be underwater', async function () {
      const isLiquidatable = await comet.isLiquidatable(dave.address);
      expect(isLiquidatable).to.equal(true);
    });

    it('save values before liquidation', async function () {
      reservesBefore = await comet.getReserves();
      ({
        totalBorrowBase: totalBorrowBefore,
        totalSupplyBase: totalSupplyBefore,
      } = await comet.totalsBasic());
    });

    it('should allow liquidation of underwater position', async function () {
      const liquidateTx = await comet.connect(alice).absorb(alice.address, [dave.address]);
      const receipt = await liquidateTx.wait();
      liquidatedAmount = receipt.events?.filter((x) => x.event === 'AbsorbDebt')[0].args.basePaidOut;
      expect(liquidatedAmount).to.be.gt(borrowedAmount);
    });

    it('total borrow should decrease after liquidation', async function () {
      const { totalBorrowBase: totalBorrowAfter } = await comet.totalsBasic();
      // total borrow should decrease by more than the amount repaid due to debt accruing
      expect(totalBorrowAfter.add(borrowedAmount)).to.be.gt(totalBorrowBefore); 
      expect(totalBorrowAfter).to.be.equal(0);
    });

    it('total supply should not change after liquidation', async function () {
      const { totalSupplyBase: totalSupplyAfter } = await comet.totalsBasic();
      expect(totalSupplyAfter).to.be.equal(totalSupplyBefore);
    });

    it('reserves should decrease proportionally to liquidated debt after liquidation', async function () {
      const reservesAfter = await comet.getReserves();
      // reserves should decrease by at least the amount repaid due to interest accruing on the remaining debt
      expect(reservesAfter.add(liquidatedAmount)).to.be.lte(reservesBefore);
    });



















  });
});
  