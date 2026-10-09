import { getNumber } from 'ethers';
import type { HardhatEthersSigner as SignerWithAddress } from '@nomicfoundation/hardhat-ethers/types';
import type { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from '../build/types/index.js';
import { ethers, expect, exp, makeProtocol, oneMonth, defaultAssets, setTotalsBasic } from './helpers.js';
import { takeSnapshot } from './helpers/snapshot.js';
import type { SnapshotRestorer } from './helpers/snapshot.js';

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

describe('balance tests', function () {
  const INDEX_SCALE = BigInt(exp(1, 15));
  const FACTOR_SCALE = BigInt(exp(1, 18));
  const baseTokenDecimals = 6;
  const seedAmount = BigInt(exp(10000, baseTokenDecimals));
  const supplyAmount = BigInt(exp(100, baseTokenDecimals));
  const borrowAmount = BigInt(exp(100, baseTokenDecimals));
  const collateralAmount = BigInt(exp(1, 18));
  const config = {
    borrowInterestRateBase: exp(0.05, 18),
    supplyInterestRateBase: exp(0.05, 18),
    baseTrackingBorrowSpeed: exp(1 / 86400, 15, 18),
    baseTrackingSupplySpeed: exp(1 / 86400, 15, 18),
  };
  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken;
  let collaterals: {
        [symbol: string]: FaucetToken;
    } = {};
  let priceFeeds: {
        [symbol: string]: SimplePriceFeed;
    } = {};
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
      if (asset === 'USDC')
        continue;
      collaterals[asset] = protocol.tokens[asset] as FaucetToken;
    }
    for (const asset in protocol.priceFeeds) {
      priceFeeds[asset] = protocol.priceFeeds[asset];
    }
    [alice, bob, dave] = protocol.users;
    // Seed reserves so borrowing is possible
    await baseToken.allocateTo((await comet.getAddress()), seedAmount);
    // Alice supplies some USDC in the initial snapshot
    await baseToken.allocateTo(alice.address, supplyAmount);
    await baseToken.connect(alice).approve((await comet.getAddress()), supplyAmount);
    await comet.connect(alice).supply((await baseToken.getAddress()), supplyAmount);
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
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), supplyAmount);
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
        const expected = ((BigInt(userBasic.principal) * BigInt(baseSupplyIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
      });
      it('balanceOf equals supplied amount at initial index', async function () {
        // principal = supplyAmount * INDEX_SCALE / baseSupplyIndex (rounds down)
        // balanceOf = principal * baseSupplyIndex / INDEX_SCALE
        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        const expected = ((BigInt(userBasic.principal) * BigInt(baseSupplyIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
        // At initial index (~1e15), rounding loss is at most 1 unit
        expect((supplyAmount - BigInt(expected))).to.be.lte(1);
      });
      it('uses accrued index, not stored index', async function () {
        const balanceBefore = await comet.balanceOf(alice.address);
        // Create some utilization so supply rate > 0
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), exp(50, baseTokenDecimals));
        const { baseSupplyIndex: indexBefore, lastAccrualTime: t0 } = await comet.totalsBasic();
        const utilization = await comet.getUtilization();
        const supplyRate = await comet.getSupplyRate(utilization);
        const userBasic = await comet.userBasic(alice.address);
        const principal = BigInt(userBasic.principal);
        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);
        // Replicate contract formula: newIndex = oldIndex + oldIndex * supplyRate * timeElapsed / FACTOR_SCALE
        const block = await ethers.provider.getBlock('latest');
        if (!block) throw new Error('Latest block not found');
        const timeElapsed = (BigInt(block.timestamp) - BigInt(t0));
        const expectedIndex = (indexBefore + BigInt(((indexBefore * BigInt((supplyRate * BigInt(timeElapsed)))) / BigInt(FACTOR_SCALE))));
        const expectedBalance = ((principal * BigInt(expectedIndex)) / BigInt(INDEX_SCALE));
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
        const expected = ((BigInt(userBasic.principal) * BigInt(baseSupplyIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
      });
      it('increases over time due to interest accrual', async function () {
        // Create utilization so supply earns interest
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), exp(50, baseTokenDecimals));
        // Capture state after utilization is established
        const userBasic = await comet.userBasic(alice.address);
        const principal = BigInt(userBasic.principal);
        const { baseSupplyIndex: indexBefore, lastAccrualTime: t0 } = await comet.totalsBasic();
        const utilization = await comet.getUtilization();
        const supplyRate = await comet.getSupplyRate(utilization);
        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
        // Replicate contract formula: newIndex = oldIndex + oldIndex * supplyRate * timeElapsed / FACTOR_SCALE
        const { lastAccrualTime: t1 } = await comet.totalsBasic();
        const timeElapsed = (BigInt(t1) - BigInt(t0));
        const expectedIndex = (indexBefore + BigInt(((indexBefore * BigInt((supplyRate * BigInt(timeElapsed)))) / BigInt(FACTOR_SCALE))));
        const expectedBalance = ((principal * BigInt(expectedIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.balanceOf(alice.address)).to.equal(expectedBalance);
      });
      it('matches formula after accrual', async function () {
        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        // balanceOf = principal * baseSupplyIndex / BASE_INDEX_SCALE
        const expected = ((BigInt(userBasic.principal) * BigInt(baseSupplyIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
      });
      it('multiple suppliers have independent correct balances', async function () {
        // Dave also supplies a different amount
        const daveSupply = BigInt(exp(200, baseTokenDecimals));
        await baseToken.allocateTo(dave.address, daveSupply);
        await baseToken.connect(dave).approve((await comet.getAddress()), daveSupply);
        await comet.connect(dave).supply((await baseToken.getAddress()), daveSupply);
        const aliceBasic = await comet.userBasic(alice.address);
        const daveBasic = await comet.userBasic(dave.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        const expectedAlice = ((BigInt(aliceBasic.principal) * BigInt(baseSupplyIndex)) / BigInt(INDEX_SCALE));
        const expectedDave = ((BigInt(daveBasic.principal) * BigInt(baseSupplyIndex)) / BigInt(INDEX_SCALE));
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
        const withdrawAmount = BigInt(exp(40, baseTokenDecimals));
        await comet.connect(alice).withdraw((await baseToken.getAddress()), withdrawAmount);
        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        // balanceOf = principal * baseSupplyIndex / INDEX_SCALE
        const expectedAfter = ((BigInt(userBasic.principal) * BigInt(baseSupplyIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.balanceOf(alice.address)).to.equal(expectedAfter);
        expect(expectedAfter).to.be.lt(balanceBefore);
        expect(expectedAfter).to.be.gt(0);
      });
      it('balanceOf matches updated principal after partial withdrawal', async function () {
        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        const expected = ((BigInt(userBasic.principal) * BigInt(baseSupplyIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
      });
    });
    describe('after full withdrawal', function () {
      after(async function () {
        await snapshot.restore();
      });
      it('returns 0 after full withdrawal', async function () {
        const balance = await comet.balanceOf(alice.address);
        await comet.connect(alice).withdraw((await baseToken.getAddress()), balance);
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
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), supplyAmount);
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
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), exp(50, baseTokenDecimals));
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
        const smallAmount = 1n;
        await baseToken.allocateTo(alice.address, smallAmount);
        await baseToken.connect(alice).approve((await comet.getAddress()), smallAmount);
        await comet.connect(alice).supply((await baseToken.getAddress()), smallAmount);
        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        const expected = ((BigInt(userBasic.principal) * BigInt(baseSupplyIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
        expect(expected).to.be.gt(0);
      });
      it('large supply amount', async function () {
        const largeAmount = BigInt(exp(10000000, baseTokenDecimals));
        await baseToken.allocateTo(alice.address, largeAmount);
        await baseToken.connect(alice).approve((await comet.getAddress()), largeAmount);
        await comet.connect(alice).supply((await baseToken.getAddress()), largeAmount);
        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        const expected = ((BigInt(userBasic.principal) * BigInt(baseSupplyIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
      });
      it('balanceOf at initial index equals supplied amount', async function () {
        // principal = supplyAmount * INDEX_SCALE / baseSupplyIndex (rounds down)
        // balanceOf = principal * baseSupplyIndex / INDEX_SCALE
        const userBasic = await comet.userBasic(alice.address);
        const { baseSupplyIndex } = await comet.totalsBasic();
        const expected = ((BigInt(userBasic.principal) * BigInt(baseSupplyIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.balanceOf(alice.address)).to.equal(expected);
        // At initial index (~1e15), rounding loss is at most 1 unit
        expect((supplyAmount - BigInt(expected))).to.be.lte(1);
      });
      it('reverts with TimestampTooLarge when block.timestamp exceeds uint40', async function () {
        const block = await ethers.provider.getBlock('latest');
        if (!block) throw new Error('Latest block not found');
        const uint40Max = ((2n ** 40n) - 1n);
        const timeToSkip = getNumber(((uint40Max - BigInt(block.timestamp)) + 1n));
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
        const localCollaterals: {
                    [symbol: string]: FaucetToken;
                } = {};
        const localPriceFeeds: {
                    [symbol: string]: SimplePriceFeed;
                } = {};
        for (const asset in protocol.tokens) {
          if (asset === 'USDC')
            continue;
          localCollaterals[asset] = protocol.tokens[asset] as FaucetToken;
        }
        for (const asset in protocol.priceFeeds) {
          localPriceFeeds[asset] = protocol.priceFeeds[asset];
        }
        const [localAlice, localBob] = protocol.users;
        const localSupplyAmount = BigInt(exp(1000, baseTokenDecimals));
        await localBaseToken.allocateTo(localAlice.address, localSupplyAmount);
        await localBaseToken.connect(localAlice).approve((await localComet.getAddress()), localSupplyAmount);
        await localComet.connect(localAlice).supply((await localBaseToken.getAddress()), localSupplyAmount);
        const asset0Info = await localComet.getAssetInfo(0);
        const priceAsset = (await localPriceFeeds.WETH.latestRoundData())[1];
        const priceBase = (await localPriceFeeds.USDC.latestRoundData())[1];
        // ERC20 decimals is uint8, so using it as a numeric exponent is safe.
        const asset0Decimals = getNumber(await localCollaterals.WETH.decimals());
        let amountCollateralToSupply: bigint;
        if (asset0Decimals > baseTokenDecimals) {
          const rescaleFactor = exp(1, asset0Decimals - baseTokenDecimals);
          amountCollateralToSupply = (((((((localSupplyAmount * BigInt(rescaleFactor)) * BigInt(priceBase)) * BigInt(FACTOR_SCALE)) * 50n) / BigInt(asset0Info.borrowCollateralFactor)) / BigInt(priceAsset)) / 100n);
        }
        else {
          const rescaleFactor = exp(1, baseTokenDecimals - asset0Decimals);
          amountCollateralToSupply = (((((((localSupplyAmount * BigInt(priceBase)) * BigInt(FACTOR_SCALE)) * 50n) / BigInt(asset0Info.borrowCollateralFactor)) / BigInt(priceAsset)) / BigInt(rescaleFactor)) / 100n);
        }
        await localCollaterals.WETH.allocateTo(localBob.address, amountCollateralToSupply);
        await localCollaterals.WETH.connect(localBob).approve((await localComet.getAddress()), amountCollateralToSupply);
        await localComet.connect(localBob).supply((await localCollaterals.WETH.getAddress()), amountCollateralToSupply);
        const borrowLimit = await localComet.getBorrowLimit(localBob.address);
        await localComet.connect(localBob).withdraw((await localBaseToken.getAddress()), borrowLimit);
        const utilization = await localComet.getUtilization();
        const supplyRate = await localComet.getSupplyRate(utilization);
        const totals = await localComet.totalsBasic();
        const uint64Max = ((2n ** 64n) - 1n);
        const timeToOverflow = getNumber((((uint64Max * BigInt(FACTOR_SCALE)) / BigInt((totals.baseSupplyIndex * BigInt(supplyRate)))) + 1n));
        await ethers.provider.send('evm_increaseTime', [timeToOverflow]);
        await ethers.provider.send('evm_mine', []);
        await expect(localComet.balanceOf(localAlice.address)).to.be.revertedWithCustomError(localComet, 'InvalidUInt64');
      });
    });
    describe('absolute interest rate validation', function () {
      before(async function () {
        // Create utilization so supply earns interest
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), exp(50, baseTokenDecimals));
      });
      after(async function () {
        await snapshot.restore();
      });
      it('supply interest after one month matches rate model', async function () {
        const userBasic = await comet.userBasic(alice.address);
        const principal = BigInt(userBasic.principal);
        const { baseSupplyIndex: indexBefore, lastAccrualTime: t0 } = await comet.totalsBasic();
        const utilization = await comet.getUtilization();
        const supplyRate = await comet.getSupplyRate(utilization);
        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);
        // Replicate contract formula: newIndex = oldIndex + oldIndex * supplyRate * timeElapsed / FACTOR_SCALE
        const block = await ethers.provider.getBlock('latest');
        if (!block) throw new Error('Latest block not found');
        const timeElapsed = (BigInt(block.timestamp) - BigInt(t0));
        const expectedIndex = (indexBefore + BigInt(((indexBefore * BigInt((supplyRate * BigInt(timeElapsed)))) / BigInt(FACTOR_SCALE))));
        const expectedBalance = ((principal * BigInt(expectedIndex)) / BigInt(INDEX_SCALE));
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
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), borrowAmount);
      });
      after(async function () {
        await snapshot.restore();
      });
      it('borrowBalanceOf matches formula: |principal| * baseBorrowIndex / BASE_INDEX_SCALE', async function () {
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        // expected = |principal| * baseBorrowIndex / 1e15
        const expected = (((BigInt(userBasic.principal) * BigInt(-1)) * BigInt(baseBorrowIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
      });
      it('borrowBalanceOf equals borrowed amount at initial index', async function () {
        // principal = borrowAmount * INDEX_SCALE / baseBorrowIndex (rounds up for borrows)
        // borrowBalanceOf = |principal| * baseBorrowIndex / INDEX_SCALE
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        const expected = (((BigInt(userBasic.principal) * BigInt(-1)) * BigInt(baseBorrowIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
        // At initial index (~1e15), rounding difference is at most 1 unit
        expect(abs((expected - BigInt(borrowAmount)))).to.be.lte(1);
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
        const absPrincipal = (BigInt(userBasic.principal) * BigInt(-1));
        const { baseBorrowIndex: indexBefore, lastAccrualTime: t0 } = await comet.totalsBasic();
        const utilization = await comet.getUtilization();
        const borrowRate = await comet.getBorrowRate(utilization);
        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);
        // Replicate contract formula: newIndex = oldIndex + oldIndex * borrowRate * timeElapsed / FACTOR_SCALE
        const block = await ethers.provider.getBlock('latest');
        if (!block) throw new Error('Latest block not found');
        const timeElapsed = (BigInt(block.timestamp) - BigInt(t0));
        const expectedIndex = (indexBefore + BigInt(((indexBefore * BigInt((borrowRate * BigInt(timeElapsed)))) / BigInt(FACTOR_SCALE))));
        const expectedBorrow = ((absPrincipal * BigInt(expectedIndex)) / BigInt(INDEX_SCALE));
        // No accrueAccount call — borrowBalanceOf should still reflect accrued interest
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expectedBorrow);
        expect(expectedBorrow).to.be.gt(borrowBefore);
      });
    });
    describe('after borrow', function () {
      before(async function () {
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), borrowAmount);
      });
      after(async function () {
        await snapshot.restore();
      });
      it('reflects borrow amount immediately after borrow', async function () {
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        const expected = (((BigInt(userBasic.principal) * BigInt(-1)) * BigInt(baseBorrowIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
      });
      it('increases over time due to interest accrual', async function () {
        const borrowBefore = await comet.borrowBalanceOf(bob.address);
        const userBasic = await comet.userBasic(bob.address);
        const absPrincipal = (BigInt(userBasic.principal) * BigInt(-1));
        const { baseBorrowIndex: indexBefore, lastAccrualTime: t0 } = await comet.totalsBasic();
        const utilization = await comet.getUtilization();
        const borrowRate = await comet.getBorrowRate(utilization);
        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(bob.address);
        // Replicate contract formula: newIndex = oldIndex + oldIndex * borrowRate * timeElapsed / FACTOR_SCALE
        const { lastAccrualTime: t1 } = await comet.totalsBasic();
        const timeElapsed = (BigInt(t1) - BigInt(t0));
        const expectedIndex = (indexBefore + BigInt(((indexBefore * BigInt((borrowRate * BigInt(timeElapsed)))) / BigInt(FACTOR_SCALE))));
        const expectedBorrow = ((absPrincipal * BigInt(expectedIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expectedBorrow);
        expect(expectedBorrow).to.be.gt(borrowBefore);
      });
      it('matches formula after accrual', async function () {
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        // borrowBalanceOf = |principal| * baseBorrowIndex / BASE_INDEX_SCALE
        const expected = (((BigInt(userBasic.principal) * BigInt(-1)) * BigInt(baseBorrowIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
      });
      it('multiple borrowers have independent correct balances', async function () {
        // Dave also borrows a different amount
        await collaterals.WETH.connect(dave).allocateTo(dave.address, collateralAmount);
        await collaterals.WETH.connect(dave).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(dave).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(dave).withdraw((await baseToken.getAddress()), exp(50, baseTokenDecimals));
        const bobBasic = await comet.userBasic(bob.address);
        const daveBasic = await comet.userBasic(dave.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        const expectedBob = (((BigInt(bobBasic.principal) * BigInt(-1)) * BigInt(baseBorrowIndex)) / BigInt(INDEX_SCALE));
        const expectedDave = (((BigInt(daveBasic.principal) * BigInt(-1)) * BigInt(baseBorrowIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expectedBob);
        expect(await comet.borrowBalanceOf(dave.address)).to.equal(expectedDave);
      });
    });
    describe('after partial repay', function () {
      before(async function () {
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), borrowAmount);
      });
      after(async function () {
        await snapshot.restore();
      });
      it('decreases after partial repay', async function () {
        const borrowBefore = await comet.borrowBalanceOf(bob.address);
        // Repay 40 USDC
        const repayAmount = BigInt(exp(40, baseTokenDecimals));
        await baseToken.connect(bob).allocateTo(bob.address, repayAmount);
        await baseToken.connect(bob).approve((await comet.getAddress()), repayAmount);
        await comet.connect(bob).supply((await baseToken.getAddress()), repayAmount);
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        // borrowBalanceOf = |principal| * baseBorrowIndex / INDEX_SCALE
        const expectedAfter = (((BigInt(userBasic.principal) * BigInt(-1)) * BigInt(baseBorrowIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expectedAfter);
        expect(expectedAfter).to.be.lt(borrowBefore);
        expect(expectedAfter).to.be.gt(0);
      });
      it('matches updated principal after partial repay', async function () {
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        const expected = (((BigInt(userBasic.principal) * BigInt(-1)) * BigInt(baseBorrowIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
      });
    });
    describe('after full repay', function () {
      before(async function () {
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), borrowAmount);
      });
      after(async function () {
        await snapshot.restore();
      });
      it('returns 0 after full repay', async function () {
        // Repay with a small buffer for accrued interest
        const repayAmount = ((await comet.borrowBalanceOf(bob.address)) + 100n);
        await baseToken.connect(bob).allocateTo(bob.address, repayAmount);
        await baseToken.connect(bob).approve((await comet.getAddress()), repayAmount);
        await comet.connect(bob).supply((await baseToken.getAddress()), repayAmount);
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(0);
      });
    });
    describe('transition from borrower to supplier', function () {
      before(async function () {
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), borrowAmount);
      });
      after(async function () {
        await snapshot.restore();
      });
      it('borrowBalanceOf becomes 0 after overpay', async function () {
        // Overpay significantly
        const overpayAmount = (borrowAmount * 2n);
        await baseToken.connect(bob).allocateTo(bob.address, overpayAmount);
        await baseToken.connect(bob).approve((await comet.getAddress()), overpayAmount);
        await comet.connect(bob).supply((await baseToken.getAddress()), overpayAmount);
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
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        // Comet enforces baseBorrowMin, so use that as the smallest valid borrow
        const minBorrow = await comet.baseBorrowMin();
        await comet.connect(bob).withdraw((await baseToken.getAddress()), minBorrow);
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        const expected = (((BigInt(userBasic.principal) * BigInt(-1)) * BigInt(baseBorrowIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
      });
      it('large borrow amount', async function () {
        // Use a collateral amount within the supply cap (default 100 WETH)
        const largeCollateral = BigInt(exp(50, 18));
        await collaterals.WETH.connect(bob).allocateTo(bob.address, largeCollateral);
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), largeCollateral);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), largeCollateral);
        // Seed more reserves to cover large borrow
        await baseToken.allocateTo((await comet.getAddress()), exp(1000000, baseTokenDecimals));
        const borrowLimit = await comet.getBorrowLimit(bob.address);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), borrowLimit);
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        const expected = (((BigInt(userBasic.principal) * BigInt(-1)) * BigInt(baseBorrowIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
      });
      it('borrowBalanceOf at initial index equals borrowed amount', async function () {
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), borrowAmount);
        // principal = borrowAmount * INDEX_SCALE / baseBorrowIndex (rounds up for borrows)
        // borrowBalanceOf = |principal| * baseBorrowIndex / INDEX_SCALE
        const userBasic = await comet.userBasic(bob.address);
        const { baseBorrowIndex } = await comet.totalsBasic();
        const expected = (((BigInt(userBasic.principal) * BigInt(-1)) * BigInt(baseBorrowIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expected);
        // At initial index (~1e15), rounding difference is at most 1 unit
        expect(abs((expected - BigInt(borrowAmount)))).to.be.lte(1);
      });
      it('borrowBalanceOf after liquidation (absorb)', async function () {
        await collaterals.WETH.connect(dave).allocateTo(dave.address, collateralAmount);
        await collaterals.WETH.connect(dave).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(dave).supply((await collaterals.WETH.getAddress()), collateralAmount);
        const maxBorrow = await comet.getBorrowLimit(dave.address);
        await comet.connect(dave).withdraw((await baseToken.getAddress()), maxBorrow);
        // Drop WETH price by 20% to make position liquidatable
        const droppedPrice = ((BigInt(exp(3000, 8)) * 80n) / 100n);
        await priceFeeds.WETH.setPrice(droppedPrice);
        expect(await comet.isLiquidatable(dave.address)).to.equal(true);
        await comet.connect(alice).absorb(alice.address, [dave.address]);
        expect(await comet.borrowBalanceOf(dave.address)).to.equal(0);
      });
      it('reverts with TimestampTooLarge when block.timestamp exceeds uint40', async function () {
        const block = await ethers.provider.getBlock('latest');
        if (!block) throw new Error('Latest block not found');
        const uint40Max = ((2n ** 40n) - 1n);
        const timeToSkip = getNumber(((uint40Max - BigInt(block.timestamp)) + 1n));
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
        const localCollaterals: {
                    [symbol: string]: FaucetToken;
                } = {};
        const localPriceFeeds: {
                    [symbol: string]: SimplePriceFeed;
                } = {};
        for (const asset in protocol.tokens) {
          if (asset === 'USDC')
            continue;
          localCollaterals[asset] = protocol.tokens[asset] as FaucetToken;
        }
        for (const asset in protocol.priceFeeds) {
          localPriceFeeds[asset] = protocol.priceFeeds[asset];
        }
        const [localAlice, localBob] = protocol.users;
        const localSupplyAmount = BigInt(exp(1000, baseTokenDecimals));
        await localBaseToken.allocateTo(localAlice.address, localSupplyAmount);
        await localBaseToken.connect(localAlice).approve((await localComet.getAddress()), localSupplyAmount);
        await localComet.connect(localAlice).supply((await localBaseToken.getAddress()), localSupplyAmount);
        const asset0Info = await localComet.getAssetInfo(0);
        const priceAsset = (await localPriceFeeds.WETH.latestRoundData())[1];
        const priceBase = (await localPriceFeeds.USDC.latestRoundData())[1];
        // ERC20 decimals is uint8, so using it as a numeric exponent is safe.
        const asset0Decimals = getNumber(await localCollaterals.WETH.decimals());
        let amountCollateralToSupply: bigint;
        if (asset0Decimals > baseTokenDecimals) {
          const rescaleFactor = exp(1, asset0Decimals - baseTokenDecimals);
          amountCollateralToSupply = (((((((localSupplyAmount * BigInt(rescaleFactor)) * BigInt(priceBase)) * BigInt(FACTOR_SCALE)) * 50n) / BigInt(asset0Info.borrowCollateralFactor)) / BigInt(priceAsset)) / 100n);
        }
        else {
          const rescaleFactor = exp(1, baseTokenDecimals - asset0Decimals);
          amountCollateralToSupply = (((((((localSupplyAmount * BigInt(priceBase)) * BigInt(FACTOR_SCALE)) * 50n) / BigInt(asset0Info.borrowCollateralFactor)) / BigInt(priceAsset)) / BigInt(rescaleFactor)) / 100n);
        }
        await localCollaterals.WETH.allocateTo(localBob.address, amountCollateralToSupply);
        await localCollaterals.WETH.connect(localBob).approve((await localComet.getAddress()), amountCollateralToSupply);
        await localComet.connect(localBob).supply((await localCollaterals.WETH.getAddress()), amountCollateralToSupply);
        const borrowLimit = await localComet.getBorrowLimit(localBob.address);
        await localComet.connect(localBob).withdraw((await localBaseToken.getAddress()), borrowLimit);
        const utilization = await localComet.getUtilization();
        const borrowRate = await localComet.getBorrowRate(utilization);
        const totals = await localComet.totalsBasic();
        const uint64Max = ((2n ** 64n) - 1n);
        const timeToOverflow = getNumber((((uint64Max * BigInt(FACTOR_SCALE)) / BigInt((totals.baseBorrowIndex * BigInt(borrowRate)))) + 1n));
        await ethers.provider.send('evm_increaseTime', [timeToOverflow]);
        await ethers.provider.send('evm_mine', []);
        await expect(localComet.borrowBalanceOf(localBob.address)).to.be.revertedWithCustomError(localComet, 'InvalidUInt64');
      });
    });
    describe('absolute interest rate validation', function () {
      before(async function () {
        await collaterals.WETH.connect(bob).allocateTo(bob.address, collateralAmount);
        await collaterals.WETH.connect(bob).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(bob).supply((await collaterals.WETH.getAddress()), collateralAmount);
        await comet.connect(bob).withdraw((await baseToken.getAddress()), borrowAmount);
      });
      after(async function () {
        await snapshot.restore();
      });
      it('borrow interest after one month matches rate model', async function () {
        const userBasic = await comet.userBasic(bob.address);
        const absPrincipal = (BigInt(userBasic.principal) * BigInt(-1));
        const { baseBorrowIndex: indexBefore, lastAccrualTime: t0 } = await comet.totalsBasic();
        const utilization = await comet.getUtilization();
        const borrowRate = await comet.getBorrowRate(utilization);
        await ethers.provider.send('evm_increaseTime', [oneMonth]);
        await ethers.provider.send('evm_mine', []);
        // Replicate contract formula: newIndex = oldIndex + oldIndex * borrowRate * timeElapsed / FACTOR_SCALE
        const block = await ethers.provider.getBlock('latest');
        if (!block) throw new Error('Latest block not found');
        const timeElapsed = (BigInt(block.timestamp) - BigInt(t0));
        const expectedIndex = (indexBefore + BigInt(((indexBefore * BigInt((borrowRate * BigInt(timeElapsed)))) / BigInt(FACTOR_SCALE))));
        const expectedBorrow = ((absPrincipal * BigInt(expectedIndex)) / BigInt(INDEX_SCALE));
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(expectedBorrow);
      });
    });
  });
});


// Preserve exact total-debt and signed-principal regressions using fixed indices.
describe('totalBorrow', function () {
  it('has correct totalBorrow', async () => {
    const { cometWithExtendedAssetList : comet } = await makeProtocol();
    await setTotalsBasic(comet, {
      baseBorrowIndex: 2e15,
      totalBorrowBase: 50e6,
    });
    expect(await comet.totalBorrow()).to.eq(100_000_000n);
  });
});

describe('borrowBalanceOf fixed-index regressions', function () {
  it('returns borrow amount (when principal amount is negative)', async () => {
    const { cometWithExtendedAssetList : comet, users: [user] } = await makeProtocol();
    await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
      baseBorrowIndex: 3e15,
    });
    await comet.setBasePrincipal(user.address, -100e6); // borrow of $100 USDC
    const borrowBalanceOf = await comet.borrowBalanceOf(user.address);
    expect(borrowBalanceOf).to.eq(300_000_000n); // baseSupplyIndex = 3e15
  });

  it('returns 0 when principal amount is positive', async () => {
    const { cometWithExtendedAssetList : comet, users: [user] } = await makeProtocol();
    await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
      baseBorrowIndex: 3e15,
    });
    await comet.setBasePrincipal(user.address, 100e6);
    const borrowBalanceOf = await comet.borrowBalanceOf(user.address);
    expect(borrowBalanceOf).to.eq(0n);
  });
});
