import { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from 'build/types';
import { ethers, expect, exp, makeProtocol, oneMonth, defaultAssets, SnapshotRestorer, takeSnapshot } from './helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber } from 'ethers';

describe('balance tests', function () {
  const INDEX_SCALE = BigNumber.from(exp(1, 15));
  const FACTOR_SCALE = BigNumber.from(exp(1, 18));
  const baseTokenDecimals = 6;
  const seedAmount = BigNumber.from(exp(10_000, baseTokenDecimals));
  const supplyAmount = BigNumber.from(exp(100, baseTokenDecimals));
  const borrowAmount = BigNumber.from(exp(100, baseTokenDecimals));
  const collateralAmount = BigNumber.from(exp(1, 18));

  const config = {
    borrowInterestRateBase: exp(0.05, 18),
    supplyInterestRateBase: exp(0.05, 18),
    baseTrackingBorrowSpeed: exp(1 / 86400, 15, 18),
    baseTrackingSupplySpeed: exp(1 / 86400, 15, 18),
  };

  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken;
  let collaterals: { [symbol: string]: FaucetToken } = {};
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};

  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let dave: SignerWithAddress;

  let snapshot: SnapshotRestorer;

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
      if (asset === 'USDC') continue;
      collaterals[asset] = protocol.tokens[asset] as FaucetToken;
    }
    for (const asset in protocol.priceFeeds) {
      priceFeeds[asset] = protocol.priceFeeds[asset];
    }
    [alice, bob, dave] = protocol.users;

    // Seed reserves so borrowing is possible
    await baseToken.allocateTo(comet.address, seedAmount);

    // Alice supplies some USDC in the initial snapshot
    await baseToken.allocateTo(alice.address, supplyAmount);
    await baseToken.connect(alice).approve(comet.address, supplyAmount);
    await comet.connect(alice).supply(baseToken.address, supplyAmount);

    snapshot = await takeSnapshot();
  });

  describe('balanceOf tests', function () {
    describe('empty market', function () {
      after(async function () {
        await snapshot.restore();
      });
      it('returns 0 for account with no position', async function () {
        expect(await comet.balanceOf(dave.address)).to.equal(0);
      });

      it('returns 0 for account with borrow position', async function () {
        // Bob supplies WETH as collateral and borrows USDC
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(bob).withdraw(baseToken.address, supplyAmount);

        expect(await comet.balanceOf(bob.address)).to.equal(0);
      });
    });

    describe('formula verification', function () {
      after(async function () {
        await snapshot.restore();
      });

      it('balanceOf matches formula: principal * baseSupplyIndex / BASE_INDEX_SCALE', async function () {
        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();

        // expected = principal * baseSupplyIndex / 1e15
        const expected = BigNumber.from(userBasic.principal).mul(baseSupplyIndex).div(INDEX_SCALE);
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
      });

      it('balanceOf equals supplied amount at initial index', async function () {
        // principal = supplyAmount * INDEX_SCALE / baseSupplyIndex (rounds down)
        // balanceOf = principal * baseSupplyIndex / INDEX_SCALE
        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        const expected = BigNumber.from(userBasic.principal).mul(baseSupplyIndex).div(INDEX_SCALE);
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
        // At initial index (~1e15), rounding loss is at most 1 unit
        expect(supplyAmount.sub(expected)).to.be.lte(1);
      });

      it('uses accrued index, not stored index', async function () {
        const balanceBefore = await comet.balanceOf(alice.address);

        // Create some utilization so supply rate > 0
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(bob).withdraw(baseToken.address, exp(50, baseTokenDecimals));

        const { baseSupplyIndex: indexBefore, lastAccrualTime: t0 } = await comet.totalsBasic();
        const utilization = await comet.getUtilization();
        const supplyRate = await comet.getSupplyRate(utilization);
        const userBasic = await comet.userBasic(alice.address);
        const principal = BigNumber.from(userBasic.principal);

        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);

        // Replicate contract formula: newIndex = oldIndex + oldIndex * supplyRate * timeElapsed / FACTOR_SCALE
        const block = await ethers.provider.getBlock('latest');
        const timeElapsed = BigNumber.from(block.timestamp).sub(t0);
        const expectedIndex = indexBefore.add(indexBefore.mul(supplyRate.mul(timeElapsed)).div(FACTOR_SCALE));
        const expectedBalance = principal.mul(expectedIndex).div(INDEX_SCALE);

        expect(await comet.balanceOf(alice.address)).to.equal(expectedBalance);
        expect(expectedBalance).to.be.gt(balanceBefore);
      });
    });

    describe('after supply', function () {
      after(async function () {
        await snapshot.restore();
      });

      it('reflects supply amount immediately after supply', async function () {
        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        const expected = BigNumber.from(userBasic.principal).mul(baseSupplyIndex).div(INDEX_SCALE);
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
      });

      it('increases over time due to interest accrual', async function () {
        // Create utilization so supply earns interest
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(bob).withdraw(baseToken.address, exp(50, baseTokenDecimals));

        // Capture state after utilization is established
        const userBasic = await comet.userBasic(alice.address);
        const principal = BigNumber.from(userBasic.principal);
        const { baseSupplyIndex: indexBefore, lastAccrualTime: t0 } = await comet.totalsBasic();
        const utilization = await comet.getUtilization();
        const supplyRate = await comet.getSupplyRate(utilization);

        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);

        // Replicate contract formula: newIndex = oldIndex + oldIndex * supplyRate * timeElapsed / FACTOR_SCALE
        const { lastAccrualTime: t1 } = await comet.totalsBasic();
        const timeElapsed = BigNumber.from(t1).sub(t0);
        const expectedIndex = indexBefore.add(indexBefore.mul(supplyRate.mul(timeElapsed)).div(FACTOR_SCALE));
        const expectedBalance = principal.mul(expectedIndex).div(INDEX_SCALE);

        expect(await comet.balanceOf(alice.address)).to.equal(expectedBalance);
      });

      it('matches formula after accrual', async function () {
        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();

        // balanceOf = principal * baseSupplyIndex / BASE_INDEX_SCALE
        const expected = BigNumber.from(userBasic.principal).mul(baseSupplyIndex).div(INDEX_SCALE);
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
      });

      it('multiple suppliers have independent correct balances', async function () {
      // Dave also supplies a different amount
        const daveSupply = BigNumber.from(exp(200, baseTokenDecimals));
        await baseToken.allocateTo(dave.address, daveSupply);
        await baseToken.connect(dave).approve(comet.address, daveSupply);
        await comet.connect(dave).supply(baseToken.address, daveSupply);

        const aliceBasic = await comet.userBasic(alice.address);
        const daveBasic = await comet.userBasic(dave.address);
        const { baseSupplyIndex } = await comet.totalsBasic();

        const expectedAlice = BigNumber.from(aliceBasic.principal).mul(baseSupplyIndex).div(INDEX_SCALE);
        const expectedDave = BigNumber.from(daveBasic.principal).mul(baseSupplyIndex).div(INDEX_SCALE);

        expect(await comet.balanceOf(alice.address)).to.equal(expectedAlice);
        expect(await comet.balanceOf(dave.address)).to.equal(expectedDave);
      });
    });

    describe('after partial withdrawal', function () {
      after(async function () {
        await snapshot.restore();
      });

      it('decreases after partial withdrawal', async function () {
        const balanceBefore = await comet.balanceOf(alice.address);
        const withdrawAmount = BigNumber.from(exp(40, baseTokenDecimals));
        await comet.connect(alice).withdraw(baseToken.address, withdrawAmount);

        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        // balanceOf = principal * baseSupplyIndex / INDEX_SCALE
        const expectedAfter = BigNumber.from(userBasic.principal).mul(baseSupplyIndex).div(INDEX_SCALE);
        expect(await comet.balanceOf(alice.address)).to.equal(expectedAfter);
        expect(expectedAfter).to.be.lt(balanceBefore);
        expect(expectedAfter).to.be.gt(0);
      });

      it('balanceOf matches updated principal after partial withdrawal', async function () {
        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();

        const expected = BigNumber.from(userBasic.principal).mul(baseSupplyIndex).div(INDEX_SCALE);
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
      });
    });

    describe('after full withdrawal', function () {
      after(async function () {
        await snapshot.restore();
      });

      it('returns 0 after full withdrawal', async function () {
        const balance = await comet.balanceOf(alice.address);
        await comet.connect(alice).withdraw(baseToken.address, balance);

        expect(await comet.balanceOf(alice.address)).to.equal(0);
      });
    });

    describe('mutual exclusivity with borrowBalanceOf', function () {
      after(async function () {
        await snapshot.restore();
      });

      it('balanceOf > 0 implies borrowBalanceOf = 0', async function () {
        expect(await comet.balanceOf(alice.address)).to.be.gt(0);
        expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
      });

      it('borrowBalanceOf > 0 implies balanceOf = 0', async function () {
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(bob).withdraw(baseToken.address, supplyAmount);

        expect(await comet.borrowBalanceOf(bob.address)).to.be.gt(0);
        expect(await comet.balanceOf(bob.address)).to.equal(0);
      });

      it('both are 0 for account with no position', async function () {
        expect(await comet.balanceOf(dave.address)).to.equal(0);
        expect(await comet.borrowBalanceOf(dave.address)).to.equal(0);
      });
    });

    describe('main case behavior', function () {
      after(async function () {
        await snapshot.restore();
      });

      it('calling balanceOf does not change state', async function () {
        const totalsBefore = await comet.totalsBasic();
        const userBasicBefore = await comet.userBasic(alice.address);

        await comet.balanceOf(alice.address);

        const totalsAfter = await comet.totalsBasic();
        const userBasicAfter = await comet.userBasic(alice.address);

        expect(totalsAfter).to.deep.equal(totalsBefore);
        expect(userBasicAfter).to.deep.equal(userBasicBefore);
      });

      it('returns accrued value without explicit accrueAccount call', async function () {
      // Create utilization so supply earns interest
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(bob).withdraw(baseToken.address, exp(50, baseTokenDecimals));

        const balanceBefore = await comet.balanceOf(alice.address);

        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);

        // No accrueAccount call — balanceOf should still reflect accrued interest
        const balanceAfter = await comet.balanceOf(alice.address);
        expect(balanceAfter).to.be.gt(balanceBefore);
      });
    });

    describe('edge cases', function () {
      afterEach(async function () {
        await snapshot.restore();
      });

      it('very small supply (1 wei)', async function () {
        // Test that balanceOf formula works even when principal is very small and would round to 0 if not using high-precision math
        const smallAmount = BigNumber.from(1);
        await baseToken.allocateTo(alice.address, smallAmount);
        await baseToken.connect(alice).approve(comet.address, smallAmount);
        await comet.connect(alice).supply(baseToken.address, smallAmount);

        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        const expected = BigNumber.from(userBasic.principal).mul(baseSupplyIndex).div(INDEX_SCALE);
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
        expect(expected).to.be.gt(0);
      });

      it('large supply amount', async function () {
        const largeAmount = BigNumber.from(exp(10_000_000, baseTokenDecimals));
        await baseToken.allocateTo(alice.address, largeAmount);
        await baseToken.connect(alice).approve(comet.address, largeAmount);
        await comet.connect(alice).supply(baseToken.address, largeAmount);

        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        const expected = BigNumber.from(userBasic.principal).mul(baseSupplyIndex).div(INDEX_SCALE);
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
      });

      it('balanceOf at initial index equals supplied amount', async function () {
        // principal = supplyAmount * INDEX_SCALE / baseSupplyIndex (rounds down)
        // balanceOf = principal * baseSupplyIndex / INDEX_SCALE
        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        const expected = BigNumber.from(userBasic.principal).mul(baseSupplyIndex).div(INDEX_SCALE);
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
        // At initial index (~1e15), rounding loss is at most 1 unit
        expect(supplyAmount.sub(expected)).to.be.lte(1);
      });

      it('reverts with TimestampTooLarge when block.timestamp exceeds uint40', async function () {
        const block = await ethers.provider.getBlock('latest');
        const uint40Max = BigNumber.from(2).pow(40).sub(1);
        const timeToSkip = uint40Max.sub(block.timestamp).add(1).toNumber();
        await ethers.provider.send('evm_increaseTime', [timeToSkip]);
        await ethers.provider.send('evm_mine', []);

        await expect(comet.balanceOf(alice.address)).to.be.revertedWithCustomError(comet, 'TimestampTooLarge');
      });

      it('reverts with InvalidUInt64 when supply rate causes index overflow', async function () {
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
        const localComet = protocol.cometWithExtendedAssetList;
        const localBaseToken = protocol.tokens.USDC as FaucetToken;
        const localCollaterals: { [symbol: string]: FaucetToken } = {};
        const localPriceFeeds: { [symbol: string]: SimplePriceFeed } = {};
        for (const asset in protocol.tokens) {
          if (asset === 'USDC') continue;
          localCollaterals[asset] = protocol.tokens[asset] as FaucetToken;
        }
        for (const asset in protocol.priceFeeds) {
          localPriceFeeds[asset] = protocol.priceFeeds[asset];
        }
        const [localAlice, localBob] = protocol.users;

        const localSupplyAmount = BigNumber.from(exp(1000, baseTokenDecimals));
        await localBaseToken.allocateTo(localAlice.address, localSupplyAmount);
        await localBaseToken.connect(localAlice).approve(localComet.address, localSupplyAmount);
        await localComet.connect(localAlice).supply(localBaseToken.address, localSupplyAmount);

        const asset0Info = await localComet.getAssetInfo(0);
        const priceAsset = (await localPriceFeeds.WETH.latestRoundData())[1];
        const priceBase = (await localPriceFeeds.USDC.latestRoundData())[1];
        const asset0Decimals = await localCollaterals.WETH.decimals();
        let amountCollateralToSupply: BigNumber;

        if (asset0Decimals > baseTokenDecimals) {
          const rescaleFactor = exp(1, asset0Decimals - baseTokenDecimals);
          amountCollateralToSupply = localSupplyAmount.mul(rescaleFactor).mul(priceBase).mul(FACTOR_SCALE).mul(50).div(asset0Info.borrowCollateralFactor).div(priceAsset).div(100);
        } else {
          const rescaleFactor = exp(1, baseTokenDecimals - asset0Decimals);
          amountCollateralToSupply = localSupplyAmount.mul(priceBase).mul(FACTOR_SCALE).mul(50).div(asset0Info.borrowCollateralFactor).div(priceAsset).div(rescaleFactor).div(100);
        }

        await localCollaterals.WETH.allocateTo(localBob.address, amountCollateralToSupply);
        await localCollaterals.WETH.connect(localBob).approve(localComet.address, amountCollateralToSupply);
        await localComet.connect(localBob).supply(localCollaterals.WETH.address, amountCollateralToSupply);
        const borrowLimit = await localComet.getBorrowLimit(localBob.address);
        await localComet.connect(localBob).withdraw(localBaseToken.address, borrowLimit);

        const utilization = await localComet.getUtilization();
        const supplyRate = await localComet.getSupplyRate(utilization);
        const totals = await localComet.totalsBasic();
        const uint64Max = BigNumber.from(2).pow(64).sub(1);
        const timeToOverflow = uint64Max.mul(FACTOR_SCALE).div(totals.baseSupplyIndex.mul(supplyRate)).add(1).toNumber();
        await ethers.provider.send('evm_increaseTime', [timeToOverflow]);
        await ethers.provider.send('evm_mine', []);

        await expect(localComet.balanceOf(localAlice.address)).to.be.revertedWithCustomError(localComet, 'InvalidUInt64');
      });
    });

    describe('absolute interest rate validation', function () {
      before(async function () {
        // Create utilization so supply earns interest
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(bob).withdraw(baseToken.address, exp(50, baseTokenDecimals));
      });

      after(async function () {
        await snapshot.restore();
      });

      it('supply interest after one month matches rate model', async function () {
        const userBasic = await comet.userBasic(alice.address);
        const principal = BigNumber.from(userBasic.principal);
        const { baseSupplyIndex: indexBefore, lastAccrualTime: t0 } = await comet.totalsBasic();
        const utilization = await comet.getUtilization();
        const supplyRate = await comet.getSupplyRate(utilization);

        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);

        // Replicate contract formula: newIndex = oldIndex + oldIndex * supplyRate * timeElapsed / FACTOR_SCALE
        const block = await ethers.provider.getBlock('latest');
        const timeElapsed = BigNumber.from(block.timestamp).sub(t0);
        const expectedIndex = indexBefore.add(indexBefore.mul(supplyRate.mul(timeElapsed)).div(FACTOR_SCALE));
        const expectedBalance = principal.mul(expectedIndex).div(INDEX_SCALE);

        expect(await comet.balanceOf(alice.address)).to.equal(expectedBalance);
      });
    });
  });

  describe('borrowBalanceOf', function () {
    describe('initial state', function () {
      it('returns 0 for account with no position', async function () {
        expect(await comet.borrowBalanceOf(dave.address)).to.equal(0);
      });

      it('returns 0 for account with supply position', async function () {
        expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
      });
    });

    describe('formula verification', function () {
      before(async function () {        
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(bob).withdraw(baseToken.address, borrowAmount);
      });

      after(async function () {
        await snapshot.restore();
      });

      it('borrowBalanceOf matches formula: |principal| * baseBorrowIndex / BASE_INDEX_SCALE', async function () {
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();

        // expected = |principal| * baseBorrowIndex / 1e15
        const expected = BigNumber.from(userBasic.principal).mul(-1).mul(baseBorrowIndex).div(INDEX_SCALE);
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
      });

      it('borrowBalanceOf equals borrowed amount at initial index', async function () {
        // principal = borrowAmount * INDEX_SCALE / baseBorrowIndex (rounds up for borrows)
        // borrowBalanceOf = |principal| * baseBorrowIndex / INDEX_SCALE
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        const expected = BigNumber.from(userBasic.principal).mul(-1).mul(baseBorrowIndex).div(INDEX_SCALE);
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
        // At initial index (~1e15), rounding difference is at most 1 unit
        expect(expected.sub(borrowAmount).abs()).to.be.lte(1);
      });

      it('uses accrued index, not stored index', async function () {
        const borrowBefore = await comet.borrowBalanceOf(bob.address);

        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);

        // borrowBalanceOf should reflect accrued interest without explicit accrueAccount
        const borrowAfter = await comet.borrowBalanceOf(bob.address);
        expect(borrowAfter).to.be.gt(borrowBefore);
      });

      it('returns accrued value without explicit accrueAccount call', async function () {
        const borrowBefore = await comet.borrowBalanceOf(bob.address);
        const userBasic = await comet.userBasic(bob.address);
        const absPrincipal = BigNumber.from(userBasic.principal).mul(-1);
        const { baseBorrowIndex: indexBefore, lastAccrualTime: t0 } = await comet.totalsBasic();
        const utilization = await comet.getUtilization();
        const borrowRate = await comet.getBorrowRate(utilization);

        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);

        // Replicate contract formula: newIndex = oldIndex + oldIndex * borrowRate * timeElapsed / FACTOR_SCALE
        const block = await ethers.provider.getBlock('latest');
        const timeElapsed = BigNumber.from(block.timestamp).sub(t0);
        const expectedIndex = indexBefore.add(indexBefore.mul(borrowRate.mul(timeElapsed)).div(FACTOR_SCALE));
        const expectedBorrow = absPrincipal.mul(expectedIndex).div(INDEX_SCALE);

        // No accrueAccount call — borrowBalanceOf should still reflect accrued interest
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expectedBorrow);
        expect(expectedBorrow).to.be.gt(borrowBefore);
      });
    });

    describe('after borrow', function () {
      before(async function () {
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(bob).withdraw(baseToken.address, borrowAmount);
      });

      after(async function () {
        await snapshot.restore();
      });

      it('reflects borrow amount immediately after borrow', async function () {
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        const expected = BigNumber.from(userBasic.principal).mul(-1).mul(baseBorrowIndex).div(INDEX_SCALE);
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
      });

      it('increases over time due to interest accrual', async function () {
        const borrowBefore = await comet.borrowBalanceOf(bob.address);
        const userBasic = await comet.userBasic(bob.address);
        const absPrincipal = BigNumber.from(userBasic.principal).mul(-1);
        const { baseBorrowIndex: indexBefore, lastAccrualTime: t0 } = await comet.totalsBasic();
        const utilization = await comet.getUtilization();
        const borrowRate = await comet.getBorrowRate(utilization);

        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(bob.address);

        // Replicate contract formula: newIndex = oldIndex + oldIndex * borrowRate * timeElapsed / FACTOR_SCALE
        const { lastAccrualTime: t1 } = await comet.totalsBasic();
        const timeElapsed = BigNumber.from(t1).sub(t0);
        const expectedIndex = indexBefore.add(indexBefore.mul(borrowRate.mul(timeElapsed)).div(FACTOR_SCALE));
        const expectedBorrow = absPrincipal.mul(expectedIndex).div(INDEX_SCALE);

        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expectedBorrow);
        expect(expectedBorrow).to.be.gt(borrowBefore);
      });

      it('matches formula after accrual', async function () {
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();

        // borrowBalanceOf = |principal| * baseBorrowIndex / BASE_INDEX_SCALE
        const expected = BigNumber.from(userBasic.principal).mul(-1).mul(baseBorrowIndex).div(INDEX_SCALE);
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
      });

      it('multiple borrowers have independent correct balances', async function () {
      // Dave also borrows a different amount
        await collaterals.WETH.connect(dave).allocateTo(dave.address, collateralAmount);
        await collaterals.WETH.connect(dave).approve(comet.address, collateralAmount);
        await comet.connect(dave).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(dave).withdraw(baseToken.address, exp(50, baseTokenDecimals));

        const bobBasic = await comet.userBasic(bob.address);
        const daveBasic = await comet.userBasic(dave.address);
        const { baseBorrowIndex } = await comet.totalsBasic();

        const expectedBob = BigNumber.from(bobBasic.principal).mul(-1).mul(baseBorrowIndex).div(INDEX_SCALE);
        const expectedDave = BigNumber.from(daveBasic.principal).mul(-1).mul(baseBorrowIndex).div(INDEX_SCALE);

        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expectedBob);
        expect(await comet.borrowBalanceOf(dave.address)).to.equal(expectedDave);
      });
    });

    describe('after partial repay', function () {
      before(async function () {        
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(bob).withdraw(baseToken.address, borrowAmount);
      });

      after(async function () {
        await snapshot.restore();
      });

      it('decreases after partial repay', async function () {
        const borrowBefore = await comet.borrowBalanceOf(bob.address);

        // Repay 40 USDC
        const repayAmount = BigNumber.from(exp(40, baseTokenDecimals));
        await baseToken.connect(bob).allocateTo(bob.address, repayAmount);
        await baseToken.connect(bob).approve(comet.address, repayAmount);
        await comet.connect(bob).supply(baseToken.address, repayAmount);

        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        // borrowBalanceOf = |principal| * baseBorrowIndex / INDEX_SCALE
        const expectedAfter = BigNumber.from(userBasic.principal).mul(-1).mul(baseBorrowIndex).div(INDEX_SCALE);
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expectedAfter);
        expect(expectedAfter).to.be.lt(borrowBefore);
        expect(expectedAfter).to.be.gt(0);
      });

      it('matches updated principal after partial repay', async function () {
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();

        const expected = BigNumber.from(userBasic.principal).mul(-1).mul(baseBorrowIndex).div(INDEX_SCALE);
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
      });
    });

    describe('after full repay', function () {
      before(async function () {
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(bob).withdraw(baseToken.address, borrowAmount);
      });

      after(async function () {
        await snapshot.restore();
      });

      it('returns 0 after full repay', async function () {
        // Repay with a small buffer for accrued interest
        const repayAmount = (await comet.borrowBalanceOf(bob.address)).add(100);
        await baseToken.connect(bob).allocateTo(bob.address, repayAmount);
        await baseToken.connect(bob).approve(comet.address, repayAmount);
        await comet.connect(bob).supply(baseToken.address, repayAmount);

        expect(await comet.borrowBalanceOf(bob.address)).to.equal(0);
      });
    });

    describe('transition from borrower to supplier', function () {
      before(async function () {        
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(bob).withdraw(baseToken.address, borrowAmount);
      });

      after(async function () {
        await snapshot.restore();
      });

      it('borrowBalanceOf becomes 0 after overpay', async function () {
        // Overpay significantly
        const overpayAmount = borrowAmount.mul(2);
        await baseToken.connect(bob).allocateTo(bob.address, overpayAmount);
        await baseToken.connect(bob).approve(comet.address, overpayAmount);
        await comet.connect(bob).supply(baseToken.address, overpayAmount);

        expect(await comet.borrowBalanceOf(bob.address)).to.equal(0);
      });

      it('balanceOf becomes > 0 after overpay', async function () {
      // Excess should have become a supply position
        expect(await comet.balanceOf(bob.address)).to.be.gt(0);
      });
    });

    describe('edge cases', function () {
      afterEach(async function () {
        await snapshot.restore();
      });

      it('very small borrow', async function () {
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);

        // Comet enforces baseBorrowMin, so use that as the smallest valid borrow
        const minBorrow = await comet.baseBorrowMin();
        await comet.connect(bob).withdraw(baseToken.address, minBorrow);

        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        const expected = BigNumber.from(userBasic.principal).mul(-1).mul(baseBorrowIndex).div(INDEX_SCALE);
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
      });

      it('large borrow amount', async function () {
      // Use a collateral amount within the supply cap (default 100 WETH)
        const largeCollateral = BigNumber.from(exp(50, 18));
        await collaterals.WETH.connect(bob).allocateTo(bob.address, largeCollateral);
        await collaterals.WETH.connect(bob).approve(comet.address, largeCollateral);
        await comet.connect(bob).supply(collaterals.WETH.address, largeCollateral);

        // Seed more reserves to cover large borrow
        await baseToken.allocateTo(comet.address, exp(1_000_000, baseTokenDecimals));

        const borrowLimit = await comet.getBorrowLimit(bob.address);
        await comet.connect(bob).withdraw(baseToken.address, borrowLimit);

        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        const expected = BigNumber.from(userBasic.principal).mul(-1).mul(baseBorrowIndex).div(INDEX_SCALE);
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
      });

      it('borrowBalanceOf at initial index equals borrowed amount', async function () {
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(bob).withdraw(baseToken.address, borrowAmount);

        // principal = borrowAmount * INDEX_SCALE / baseBorrowIndex (rounds up for borrows)
        // borrowBalanceOf = |principal| * baseBorrowIndex / INDEX_SCALE
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        const expected = BigNumber.from(userBasic.principal).mul(-1).mul(baseBorrowIndex).div(INDEX_SCALE);
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
        // At initial index (~1e15), rounding difference is at most 1 unit
        expect(expected.sub(borrowAmount).abs()).to.be.lte(1);
      });

      it('borrowBalanceOf after liquidation (absorb)', async function () {
        await collaterals.WETH.connect(dave).allocateTo(dave.address, collateralAmount);
        await collaterals.WETH.connect(dave).approve(comet.address, collateralAmount);
        await comet.connect(dave).supply(collaterals.WETH.address, collateralAmount);

        const maxBorrow = await comet.getBorrowLimit(dave.address);
        await comet.connect(dave).withdraw(baseToken.address, maxBorrow);

        // Drop WETH price by 20% to make position liquidatable
        const droppedPrice = BigNumber.from(exp(3000, 8)).mul(80).div(100);
        await priceFeeds.WETH.setPrice(droppedPrice);

        expect(await comet.isLiquidatable(dave.address)).to.equal(true);

        await comet.connect(alice).absorb(alice.address, [dave.address]);

        expect(await comet.borrowBalanceOf(dave.address)).to.equal(0);
      });

      it('reverts with TimestampTooLarge when block.timestamp exceeds uint40', async function () {
        const block = await ethers.provider.getBlock('latest');
        const uint40Max = BigNumber.from(2).pow(40).sub(1);
        const timeToSkip = uint40Max.sub(block.timestamp).add(1).toNumber();
        await ethers.provider.send('evm_increaseTime', [timeToSkip]);
        await ethers.provider.send('evm_mine', []);

        await expect(comet.borrowBalanceOf(bob.address)).to.be.revertedWithCustomError(comet, 'TimestampTooLarge');
      });

      it('reverts with InvalidUInt64 when borrow rate causes index overflow', async function () {
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

        const localComet = protocol.cometWithExtendedAssetList;
        const localBaseToken = protocol.tokens.USDC as FaucetToken;
        const localCollaterals: { [symbol: string]: FaucetToken } = {};
        const localPriceFeeds: { [symbol: string]: SimplePriceFeed } = {};
        for (const asset in protocol.tokens) {
          if (asset === 'USDC') continue;
          localCollaterals[asset] = protocol.tokens[asset] as FaucetToken;
        }
        for (const asset in protocol.priceFeeds) {
          localPriceFeeds[asset] = protocol.priceFeeds[asset];
        }
        const [localAlice, localBob] = protocol.users;

        const localSupplyAmount = BigNumber.from(exp(1000, baseTokenDecimals));
        await localBaseToken.allocateTo(localAlice.address, localSupplyAmount);
        await localBaseToken.connect(localAlice).approve(localComet.address, localSupplyAmount);
        await localComet.connect(localAlice).supply(localBaseToken.address, localSupplyAmount);

        const asset0Info = await localComet.getAssetInfo(0);
        const priceAsset = (await localPriceFeeds.WETH.latestRoundData())[1];
        const priceBase = (await localPriceFeeds.USDC.latestRoundData())[1];
        const asset0Decimals = await localCollaterals.WETH.decimals();
        let amountCollateralToSupply: BigNumber;

        if (asset0Decimals > baseTokenDecimals) {
          const rescaleFactor = exp(1, asset0Decimals - baseTokenDecimals);
          amountCollateralToSupply = localSupplyAmount.mul(rescaleFactor).mul(priceBase).mul(FACTOR_SCALE).mul(50).div(asset0Info.borrowCollateralFactor).div(priceAsset).div(100);
        } else {
          const rescaleFactor = exp(1, baseTokenDecimals - asset0Decimals);
          amountCollateralToSupply = localSupplyAmount.mul(priceBase).mul(FACTOR_SCALE).mul(50).div(asset0Info.borrowCollateralFactor).div(priceAsset).div(rescaleFactor).div(100);
        }

        await localCollaterals.WETH.allocateTo(localBob.address, amountCollateralToSupply);
        await localCollaterals.WETH.connect(localBob).approve(localComet.address, amountCollateralToSupply);
        await localComet.connect(localBob).supply(localCollaterals.WETH.address, amountCollateralToSupply);
        const borrowLimit = await localComet.getBorrowLimit(localBob.address);
        await localComet.connect(localBob).withdraw(localBaseToken.address, borrowLimit);

        const utilization = await localComet.getUtilization();
        const borrowRate = await localComet.getBorrowRate(utilization);
        const totals = await localComet.totalsBasic();
        const uint64Max = BigNumber.from(2).pow(64).sub(1);
        const timeToOverflow = uint64Max.mul(FACTOR_SCALE).div(totals.baseBorrowIndex.mul(borrowRate)).add(1).toNumber();
        await ethers.provider.send('evm_increaseTime', [timeToOverflow]);
        await ethers.provider.send('evm_mine', []);

        await expect(localComet.borrowBalanceOf(localBob.address)).to.be.revertedWithCustomError(localComet, 'InvalidUInt64');
      });
    });

    describe('absolute interest rate validation', function () {
      before(async function () {        
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve(comet.address, collateralAmount);
        await comet.connect(bob).supply(collaterals.WETH.address, collateralAmount);
        await comet.connect(bob).withdraw(baseToken.address, borrowAmount);
      });

      after(async function () {
        await snapshot.restore();
      });

      it('borrow interest after one month matches rate model', async function () {
        const userBasic = await comet.userBasic(bob.address);
        const absPrincipal = BigNumber.from(userBasic.principal).mul(-1);
        const { baseBorrowIndex: indexBefore, lastAccrualTime: t0 } = await comet.totalsBasic();
        const utilization = await comet.getUtilization();
        const borrowRate = await comet.getBorrowRate(utilization);

        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);

        // Replicate contract formula: newIndex = oldIndex + oldIndex * borrowRate * timeElapsed / FACTOR_SCALE
        const block = await ethers.provider.getBlock('latest');
        const timeElapsed = BigNumber.from(block.timestamp).sub(t0);
        const expectedIndex = indexBefore.add(indexBefore.mul(borrowRate.mul(timeElapsed)).div(FACTOR_SCALE));
        const expectedBorrow = absPrincipal.mul(expectedIndex).div(INDEX_SCALE);

        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expectedBorrow);
      });
    });
  });
});
