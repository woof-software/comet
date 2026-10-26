import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { annualize, defactor, exp, factorScale } from '../test/helpers';
import { BigNumber } from 'ethers';
import { FuzzType } from './constraints/Fuzzing';
import {
  supportUtilizationLimit,
  supportsConfigurableMaxSupportedUtilization,
  isFreshMarket,
  withdrawFromInitialLender,
  getUsableCollateralIndices,
  getMinimumBorrowAmounts,
  matchesDeployment
} from './utils';
import { getConfigForScenario } from './utils/scenarioHelper';
import { setNextBlockTimestamp } from './utils/hreUtils';
import { UINT256_MAX } from './utils/constants';
import { log } from 'console';

function calculateInterestRateSupply(
  utilization: BigNumber,
  kink: BigNumber,
  interestRateBase: BigNumber,
  interestRateSlopeLow: BigNumber,
  interestRateSlopeHigh: BigNumber,
  totalSupplyBase: BigNumber,
  baseSupplyIndex: BigNumber,
  baseIndexScale: BigNumber,
  cometBaseBalance: BigNumber
): BigNumber {
  const factorScale = BigNumber.from(exp(1, 18));

  if (totalSupplyBase.isZero()) return BigNumber.from(0);

  // Without borrows lenders are paid from reserves, so the rate is cut once supplies reach the balance of Comet
  if (utilization.isZero() && !interestRateBase.isZero()) {
    const presentTotalSupply = totalSupplyBase.mul(baseSupplyIndex).div(baseIndexScale);
    if (presentTotalSupply.gte(cometBaseBalance)) return BigNumber.from(0);
  }
  
  if (utilization.lte(kink)) {
    const interestRateWithoutBase = interestRateSlopeLow.mul(utilization).div(factorScale);
    return interestRateBase.add(interestRateWithoutBase);
  } else {
    const rateSlopeLow = interestRateSlopeLow.mul(kink).div(factorScale);
    const rateSlopeHigh = interestRateSlopeHigh.mul(utilization.sub(kink)).div(factorScale);
    return interestRateBase.add(rateSlopeLow).add(rateSlopeHigh);
  }
}

function calculateInterestRateBorrow(
  utilization: BigNumber,
  kink: BigNumber,
  interestRateBase: BigNumber,
  interestRateSlopeLow: BigNumber,
  interestRateSlopeHigh: BigNumber,
  totalBorrowBase?: BigNumber,
): BigNumber {
  const factorScale = BigNumber.from(exp(1, 18));
  
  if(totalBorrowBase.isZero()) return BigNumber.from(0);
  
  if (utilization.lte(kink)) {
    const interestRateWithoutBase = interestRateSlopeLow.mul(utilization).div(factorScale);
    return interestRateBase.add(interestRateWithoutBase);
  } else {
    const rateSlopeLow = interestRateSlopeLow.mul(kink).div(factorScale);
    const rateSlopeHigh = interestRateSlopeHigh.mul(utilization.sub(kink)).div(factorScale);
    return interestRateBase.add(rateSlopeLow).add(rateSlopeHigh);
  }
}

function calculateUtilization(
  totalSupplyBase: BigNumber,
  totalBorrowBase: BigNumber,
  baseSupplyIndex: BigNumber,
  baseBorrowIndex: BigNumber,
  factorScale = BigNumber.from(exp(1, 18))
): BigNumber {
  if (totalSupplyBase.isZero()) {
    return BigNumber.from(0);
  } else {
    const totalSupply = totalSupplyBase.mul(baseSupplyIndex).div(factorScale);
    const totalBorrow = totalBorrowBase.mul(baseBorrowIndex).div(factorScale);
    return totalBorrow.mul(factorScale).div(totalSupply);
  }
}

scenario(
  'Comet#interestRate > rates using on-chain configuration constants',
  {},
  async ({ comet }, context: CometContext) => {
    let { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
    const baseIndexScale = await comet.baseIndexScale();
    const cometBaseBalance = BigNumber.from(await context.getAssetByAddress(await comet.baseToken()).balanceOf(comet.address));
    const supplyKink = await comet.supplyKink();
    const supplyPerSecondInterestRateBase = await comet.supplyPerSecondInterestRateBase();
    const supplyPerSecondInterestRateSlopeLow = await comet.supplyPerSecondInterestRateSlopeLow();
    const supplyPerSecondInterestRateSlopeHigh = await comet.supplyPerSecondInterestRateSlopeHigh();
    const borrowKink = await comet.borrowKink();
    const borrowPerSecondInterestRateBase = await comet.borrowPerSecondInterestRateBase();
    const borrowPerSecondInterestRateSlopeLow = await comet.borrowPerSecondInterestRateSlopeLow();
    const borrowPerSecondInterestRateSlopeHigh = await comet.borrowPerSecondInterestRateSlopeHigh();

    const actualUtilization = await comet.getUtilization();
    const expectedUtilization = calculateUtilization(totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex);

    expect(defactor(actualUtilization)).to.be.approximately(defactor(expectedUtilization), 0.00001);
    totalSupplyBase = (await comet.totalsBasic()).totalSupplyBase;
    expect(await comet.getSupplyRate(actualUtilization)).to.equal(
      calculateInterestRateSupply(
        actualUtilization,
        supplyKink,
        supplyPerSecondInterestRateBase,
        supplyPerSecondInterestRateSlopeLow,
        supplyPerSecondInterestRateSlopeHigh,
        totalSupplyBase,
        baseSupplyIndex,
        baseIndexScale,
        cometBaseBalance
      )
    );
    totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
    expect(await comet.getBorrowRate(actualUtilization)).to.equal(
      calculateInterestRateBorrow(
        actualUtilization,
        borrowKink,
        borrowPerSecondInterestRateBase,
        borrowPerSecondInterestRateSlopeLow,
        borrowPerSecondInterestRateSlopeHigh,
        totalBorrowBase
      )
    );
  }
);

scenario(
  'Comet#interestRate > below kink rates using hypothetical configuration constants',
  {
    filter: async (ctx: CometContext) => await supportsConfigurableMaxSupportedUtilization(ctx),
    upgrade: {
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.04, 18),
      supplyPerYearInterestRateSlopeHigh: exp(0.4, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(0.01, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.05, 18),
      borrowPerYearInterestRateSlopeHigh: exp(0.3, 18),
    },
    utilization: 0.5,
  },
  async ({ comet }) => {
    const utilization = await comet.getUtilization();
    expect(defactor(utilization)).to.be.approximately(0.5, 0.00001);
    expect(annualize(await comet.getSupplyRate(utilization))).to.be.approximately(0.02, 0.001);
    expect(annualize(await comet.getBorrowRate(utilization))).to.be.approximately(0.035, 0.001);
  }
);

scenario(
  'Comet#interestRate > above kink rates using hypothetical configuration constants',
  {
    filter: async (ctx: CometContext) => await supportsConfigurableMaxSupportedUtilization(ctx),
    upgrade: {
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.04, 18),
      supplyPerYearInterestRateSlopeHigh: exp(0.4, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(0.01, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.05, 18),
      borrowPerYearInterestRateSlopeHigh: exp(0.3, 18),
    },
    utilization: 0.85,
  },
  async ({ comet }) => {
    const utilization = await comet.getUtilization();
    expect(defactor(utilization)).to.be.approximately(0.85, 0.00001);
    expect(annualize(await comet.getSupplyRate(utilization))).to.be.approximately(0.052, 0.001);
    expect(annualize(await comet.getBorrowRate(utilization))).to.be.approximately(0.065, 0.001);
  }
);

scenario(
  'Comet#interestRate > rates using fuzzed configuration constants',
  {
    filter: async (ctx: CometContext) => await supportsConfigurableMaxSupportedUtilization(ctx),
    upgrade: {
      // TODO: Read types directly from Solidity?
      supplyPerYearInterestRateBase: { type: FuzzType.UINT64 },
      borrowPerYearInterestRateBase: { type: FuzzType.UINT64, max: (1e18).toString() /* 100% */ },
    }
  },
  async ({ comet }, context: CometContext) => {
    let { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
    const baseIndexScale = await comet.baseIndexScale();
    const cometBaseBalance = BigNumber.from(await context.getAssetByAddress(await comet.baseToken()).balanceOf(comet.address));
    const supplyKink = await comet.supplyKink();
    const supplyPerSecondInterestRateBase = await comet.supplyPerSecondInterestRateBase();
    const supplyPerSecondInterestRateSlopeLow = await comet.supplyPerSecondInterestRateSlopeLow();
    const supplyPerSecondInterestRateSlopeHigh = await comet.supplyPerSecondInterestRateSlopeHigh();
    const borrowKink = await comet.borrowKink();
    const borrowPerSecondInterestRateBase = await comet.borrowPerSecondInterestRateBase();
    const borrowPerSecondInterestRateSlopeLow = await comet.borrowPerSecondInterestRateSlopeLow();
    const borrowPerSecondInterestRateSlopeHigh = await comet.borrowPerSecondInterestRateSlopeHigh();


    const actualUtilization = await comet.getUtilization();
    const expectedUtilization = calculateUtilization(totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex);

    expect(defactor(actualUtilization)).to.be.approximately(defactor(expectedUtilization), 0.00001);
    totalSupplyBase = (await comet.totalsBasic()).totalSupplyBase;
    expect(await comet.getSupplyRate(actualUtilization)).to.equal(
      calculateInterestRateSupply(
        actualUtilization,
        supplyKink,
        supplyPerSecondInterestRateBase,
        supplyPerSecondInterestRateSlopeLow,
        supplyPerSecondInterestRateSlopeHigh,
        totalSupplyBase,
        baseSupplyIndex,
        baseIndexScale,
        cometBaseBalance
      )
    );
    totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
    expect(await comet.getBorrowRate(actualUtilization)).to.equal(
      calculateInterestRateBorrow(
        actualUtilization,
        borrowKink,
        borrowPerSecondInterestRateBase,
        borrowPerSecondInterestRateSlopeLow,
        borrowPerSecondInterestRateSlopeHigh,
        totalBorrowBase,
      )
    );
  }
);

// TODO: Scenario for testing custom configuration constants using a utilization constraint.
// XXX this test seems too fickle
scenario.skip(
  'Comet#interestRate > when utilization is 50%',
  { utilization: 0.5 },
  async ({ comet }) => {
    const utilization = await comet.getUtilization();
    expect(defactor(utilization)).to.be.approximately(0.5, 0.00001);
  }
);

scenario(
  'Comet#interestRate reverts for pushing utilization above 200%',
  {
    filter: async (ctx: CometContext) => await supportUtilizationLimit(ctx) && await isFreshMarket(ctx),
  },
  async ({ comet }, context: CometContext) => {
    // Only needed on development, where the market is deployed with a supply from the initial lender.
    // Withdrawing it leaves the market without lenders. On other bases there is no initial lender and this does nothing
    await withdrawFromInitialLender(context);

    const { albert, betty } = context.actors;
    const { asset, scale, borrowCollateralFactor, priceFeed } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const baseToken = context.getAssetByAddress(await comet.baseToken());

    const baseScale = (await comet.baseScale()).toBigInt();
    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const collateralScale = scale.toBigInt();
    const collateralPrice = (await comet.getPrice(priceFeed)).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();

    expect(await comet.getUtilization()).to.equal(0n);

    // Supplying at least the borrow minimum keeps the 3x borrow clear of BorrowTooSmall,
    // which withdraw checks before utilization
    const supplyAmount = baseBorrowMin > baseScale ? baseBorrowMin : baseScale;
    await context.sourceTokens(supplyAmount, baseToken.address, betty.address);
    await baseToken.approve(betty, comet.address);
    await betty.supplyAsset({ asset: baseToken.address, amount: supplyAmount });

    // A 3x borrow targets 300% utilization. The utilization check reverts before any base leaves Comet,
    // so the protocol does not need liquidity for the borrow.
    const borrowAmount = 3n * (await comet.totalSupply()).toBigInt();

    // The borrow principal is rounded up, so the debt can exceed the borrowed amount by up to
    // baseBorrowIndex / baseIndexScale wei. Every step rounds up so the collateral always covers the debt,
    // which keeps the borrow clear of NotCollateralized as well.
    const maxDebt = borrowAmount + (await comet.totalsBasic()).baseBorrowIndex.toBigInt() / baseIndexScale + 1n;
    const debtValue = (maxDebt * basePrice + baseScale - 1n) / baseScale;
    const collateralValue = (debtValue * factorScale + borrowCollateralFactor.toBigInt() - 1n) / borrowCollateralFactor.toBigInt();
    const collateralAmount = (collateralValue * collateralScale + collateralPrice - 1n) / collateralPrice;

    await context.sourceTokens(collateralAmount, collateralAsset.address, albert.address);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: collateralAsset.address, amount: collateralAmount });

    await expect(
      comet.connect(albert.signer).withdraw(baseToken.address, borrowAmount)
    ).to.be.revertedWithCustomError(comet, 'ExceedsSupportedUtilization');
  }
);

/**
 * @notice Verifies that supply index remains unchanged when market has no supplies
 * @dev `if (totalSupplyBase == 0) return 0;`
 *      When there are no lenders in the market, supply rate should be 0 and
 *      baseSupplyIndex should not accrue even after time passes.
 *      This prevents phantom interest accrual on an empty market.
 */
scenario(
  'Comet#interestRate > supply index does not change when there are no supplies',
  {
    filter: async (ctx: CometContext) => await supportUtilizationLimit(ctx) && await isFreshMarket(ctx),
    upgrade: {
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0.001, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.04, 18),
      supplyPerYearInterestRateSlopeHigh: exp(0.4, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(0.01, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.05, 18),
      borrowPerYearInterestRateSlopeHigh: exp(0.3, 18),
    },
  },
  async ({ comet }, context: CometContext) => {
    // Only needed on development, where the market is deployed with a supply from the initial lender.
    // Withdrawing it leaves the market without lenders. On other bases there is no initial lender and this does nothing
    await withdrawFromInitialLender(context);

    const ethers = context.world.deploymentManager.hre.ethers;

    // Get initial state
    const initialTotals = await comet.totalsBasic();
    const initialSupplyIndex = initialTotals.baseSupplyIndex;

    // Verify there are no supplies (totalSupplyBase == 0)
    expect(initialTotals.totalSupplyBase.toBigInt()).to.equal(0n);

    // Verify supply rate is 0 when there are no supplies
    const supplyRate = await comet.getSupplyRate(0);
    expect(supplyRate.toBigInt()).to.equal(0n);

    // Skip some time (1 hour)
    await ethers.provider.send('evm_increaseTime', [3600]);
    await ethers.provider.send('evm_mine', []);

    // Trigger accrue by calling accrueAccount
    await comet.accrueAccount(ethers.constants.AddressZero);

    // Get state after time skip
    const finalTotals = await comet.totalsBasic();
    const finalSupplyIndex = finalTotals.baseSupplyIndex;

    // Verify baseSupplyIndex has not changed
    expect(finalSupplyIndex.toBigInt()).to.equal(initialSupplyIndex.toBigInt());

    // Verify lastAccrualTime was updated (accrual happened but index didn't change)
    expect(finalTotals.lastAccrualTime).to.be.greaterThan(initialTotals.lastAccrualTime);
  }
);

/**
 * @notice Verifies that supply index does not grow when there are supplies but no reserves
 * @dev When lenders supply to the market but there are no reserves (or reserves are exhausted),
 *      the baseSupplyIndex should not increase because there are no funds to pay interest from.
 *      This prevents lenders from accruing interest that cannot be withdrawn (illiquidity protection).
 */
scenario(
  'Comet#interestRate > supply index does not grow without reserves even with supplies',
  {
    filter: async (ctx: CometContext) => await supportUtilizationLimit(ctx) && await isFreshMarket(ctx),
    upgrade: {
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0.001, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.04, 18),
      supplyPerYearInterestRateSlopeHigh: exp(0.4, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(0.01, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.05, 18),
      borrowPerYearInterestRateSlopeHigh: exp(0.3, 18),
    },
  },
  async ({ comet }, context: CometContext) => {
    // Only needed on development, where the market is deployed with a supply from the initial lender.
    // Withdrawing it leaves the market without lenders. On other bases there is no initial lender and this does nothing
    await withdrawFromInitialLender(context);

    const ethers = context.world.deploymentManager.hre.ethers;
    const { albert } = context.actors;

    const baseTokenAddress = await comet.baseToken();
    const baseToken = context.getAssetByAddress(baseTokenAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    const totalsBeforeSupply = await comet.totalsBasic();

    // Supply some base tokens to the market
    const supplyAmount = BigInt(getConfigForScenario(context).supplyBase) * baseScale;
    await context.sourceTokens(supplyAmount, baseToken.address, albert.address);
    await baseToken.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: baseToken.address, amount: supplyAmount });

    // Verify supply was successful
    const totalsAfterSupply = await comet.totalsBasic();
    expect(totalsAfterSupply.totalSupplyBase.toBigInt()).to.equal(totalsBeforeSupply.totalSupplyBase.toBigInt() + supplyAmount);
    
    // Get supply index before time skip
    const prevSupplyIndex = totalsAfterSupply.baseSupplyIndex;

    // Skip some time (1 hour)
    await ethers.provider.send('evm_increaseTime', [3600]);
    await ethers.provider.send('evm_mine', []);

    // Trigger accrue
    await comet.accrueAccount(ethers.constants.AddressZero);

    // Get state after time skip
    const finalTotals = await comet.totalsBasic();
    const finalSupplyIndex = finalTotals.baseSupplyIndex;

    // Verify baseSupplyIndex has not changed because there are no reserves to fund the interest
    expect(finalSupplyIndex.toBigInt()).to.equal(prevSupplyIndex.toBigInt());

    // Verify utilization is 0 (no borrows)
    expect((await comet.getUtilization()).toBigInt()).to.equal(0n);
  }
);

/**
 * @notice Verifies that supply index grows when there are both supplies and reserves
 * @dev When lenders supply to the market AND there are reserves available,
 *      the baseSupplyIndex should increase according to the base supply rate.
 *      Reserves fund the interest payments to lenders when there are no borrowers.
 */
scenario(
  'Comet#interestRate > supply index grows with reserves and supplies',
  {
    filter: async (ctx: CometContext) => await supportUtilizationLimit(ctx) && await isFreshMarket(ctx),
    upgrade: {
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0.001, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.04, 18),
      supplyPerYearInterestRateSlopeHigh: exp(0.4, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(0.01, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.05, 18),
      borrowPerYearInterestRateSlopeHigh: exp(0.3, 18),
    },
  },
  async ({ comet }, context: CometContext) => {
    // Only needed on development, where the market is deployed with a supply from the initial lender.
    // Withdrawing it leaves the market without lenders. On other bases there is no initial lender and this does nothing
    await withdrawFromInitialLender(context);

    const ethers = context.world.deploymentManager.hre.ethers;
    const { albert } = context.actors;

    const baseTokenAddress = await comet.baseToken();
    const baseToken = context.getAssetByAddress(baseTokenAddress);
    const baseScale = (await comet.baseScale()).toBigInt();

    // Supply some base tokens to the market
    const supplyAmount = BigInt(getConfigForScenario(context).supplyBase) * baseScale;
    await context.sourceTokens(supplyAmount, baseToken.address, albert.address);
    await baseToken.approve(albert, comet.address);
    await albert.supplyAsset({ asset: baseToken.address, amount: supplyAmount });

    // Add reserves to the market (send tokens directly to comet without supplying)
    const reservesAmount = BigInt(getConfigForScenario(context).reservesBase) * baseScale;
    await context.sourceTokens(reservesAmount, baseToken.address, comet.address);

    // Verify reserves are positive
    const reserves = await comet.getReserves();
    expect(reserves.toBigInt()).to.be.greaterThan(0n);

    // Get state before time skip
    const totalsBeforeAccrue = await comet.totalsBasic();
    const prevSupplyIndex = totalsBeforeAccrue.baseSupplyIndex;
    const prevLastAccrualTime = totalsBeforeAccrue.lastAccrualTime;

    // Verify supply rate is positive (base rate applies since utilization is 0 but reserves exist)
    const supplyRate = await comet.getSupplyRate(0);
    expect(supplyRate.toBigInt()).to.be.greaterThan(0n);

    // Skip some time (1 hour)
    await ethers.provider.send('evm_increaseTime', [3600]);
    await ethers.provider.send('evm_mine', []);

    // Trigger accrue
    await comet.accrueAccount(ethers.constants.AddressZero);

    // Get state after time skip
    const finalTotals = await comet.totalsBasic();
    const finalSupplyIndex = finalTotals.baseSupplyIndex;
    const timeElapsed = finalTotals.lastAccrualTime - prevLastAccrualTime;

    // Calculate expected supply index growth
    // accruedIndex = prevIndex + prevIndex * supplyRate * timeElapsed / 1e18
    const expectedAccruedIndex = prevSupplyIndex.add(
      prevSupplyIndex.mul(supplyRate).mul(timeElapsed).div(exp(1, 18))
    );

    // Verify baseSupplyIndex has grown
    expect(finalSupplyIndex).to.be.greaterThan(prevSupplyIndex);
    expect(finalSupplyIndex).to.equal(expectedAccruedIndex);

    // Verify utilization is still 0 (no borrows)
    expect((await comet.getUtilization()).toBigInt()).to.equal(0n);
  }
);

/**
 * @notice Verifies that supply interest accrual is capped by available reserves when there are no borrows
 * @dev In a new market with lenders but no borrowers, lenders earn the base supply rate funded from reserves.
 *      Without this safeguard, totalSupply() could exceed the actual token balance, causing illiquidity.
 *      Once reserves are exhausted (totalSupply >= balance), the supply index stops growing
 *      to ensure lenders can always withdraw their entitled amounts.
 */
scenario(
  'Comet#interestRate > supply interest does not exceed reserves without borrows',
  {
    filter: async (ctx: CometContext) => await supportUtilizationLimit(ctx) && await isFreshMarket(ctx),
    upgrade: {
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0.001, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.04, 18),
      supplyPerYearInterestRateSlopeHigh: exp(0.4, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(0.01, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.05, 18),
      borrowPerYearInterestRateSlopeHigh: exp(0.3, 18),
    },
  },
  async ({ comet }, context: CometContext) => {
    // Only needed on development, where the market is deployed with a supply from the initial lender.
    // Withdrawing it leaves the market without lenders. On other bases there is no initial lender and this does nothing
    await withdrawFromInitialLender(context);

    const ethers = context.world.deploymentManager.hre.ethers;
    const { albert, betty } = context.actors;

    const baseTokenAddress = await comet.baseToken();
    const baseToken = context.getAssetByAddress(baseTokenAddress);
    const baseScale = (await comet.baseScale()).toBigInt();

    // Supply base tokens to the market
    const supplyAmount = BigInt(getConfigForScenario(context).supplyBase) * baseScale;
    await context.sourceTokens(supplyAmount, baseToken.address, albert.address);
    await baseToken.approve(albert, comet.address);
    await albert.supplyAsset({ asset: baseToken.address, amount: supplyAmount });

    // Another user also supplies
    await context.sourceTokens(supplyAmount, baseToken.address, betty.address);
    await baseToken.approve(betty, comet.address);
    await betty.supplyAsset({ asset: baseToken.address, amount: supplyAmount });

    // Add reserves to the market
    const initialReserves = BigInt(getConfigForScenario(context).reservesBase) * baseScale;
    await context.sourceTokens(initialReserves, baseToken.address, comet.address);

    // Lenders, no borrows and unspent reserves: the market pays the base supply rate
    expect(await comet.getUtilization()).to.equal(0n);
    const supplyRate = (await comet.getSupplyRate(0)).toBigInt();
    expect(supplyRate).to.equal(await comet.supplyPerSecondInterestRateBase());

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const totalsBefore = await comet.totalsBasic();
    const indexBefore = totalsBefore.baseSupplyIndex.toBigInt();
    const principal = totalsBefore.totalSupplyBase.toBigInt();
    const cometBalance = await baseToken.balanceOf(comet.address);

    const accruedIndex = (elapsed: bigint) => indexBefore + indexBefore * supplyRate * elapsed / factorScale;
    const presentSupply = (index: bigint) => principal * index / baseIndexScale;

    // The cut-off checks the index stored before an accrual, so a single accrual applies the base rate to the whole
    // elapsed time. Solve for the first second at which that accrual lifts totalSupply() to the balance: the smallest
    // index whose present value reaches the balance, then the smallest elapsed time that grows the index to it.
    const exhaustionIndex = (cometBalance * baseIndexScale + principal - 1n) / principal;
    const timeToExhaust = ((exhaustionIndex - indexBefore) * factorScale + indexBefore * supplyRate - 1n) / (indexBefore * supplyRate);
    expect(presentSupply(accruedIndex(timeToExhaust - 1n))).to.be.lessThan(cometBalance);

    await setNextBlockTimestamp(context.world.deploymentManager, totalsBefore.lastAccrualTime + Number(timeToExhaust));
    await comet.accrueAccount(ethers.constants.AddressZero);

    const totalsAtExhaustion = await comet.totalsBasic();
    const elapsed = BigInt(totalsAtExhaustion.lastAccrualTime - totalsBefore.lastAccrualTime);
    expect(elapsed).to.equal(timeToExhaust);

    const indexAtExhaustion = accruedIndex(elapsed);
    const totalSupplyAtExhaustion = presentSupply(indexAtExhaustion);
    expect(totalsAtExhaustion.baseSupplyIndex).to.equal(indexAtExhaustion);
    expect(totalsAtExhaustion.totalSupplyBase).to.equal(principal);
    expect(await comet.totalSupply()).to.equal(totalSupplyAtExhaustion);
    expect(totalSupplyAtExhaustion).to.be.gte(cometBalance);
    expect(await comet.getReserves()).to.equal(cometBalance - totalSupplyAtExhaustion);

    // Supply now covers the whole balance, so the cut-off turns the supply rate off
    expect(await comet.getSupplyRate(0)).to.equal(0n);

    await ethers.provider.send('evm_increaseTime', [3600]); // 1 hour
    await ethers.provider.send('evm_mine', []);
    await comet.accrueAccount(ethers.constants.AddressZero);

    const finalTotals = await comet.totalsBasic();
    expect(finalTotals.lastAccrualTime).to.be.greaterThan(totalsAtExhaustion.lastAccrualTime);
    expect(finalTotals.baseSupplyIndex).to.equal(indexAtExhaustion);
    expect(await comet.totalSupply()).to.equal(totalSupplyAtExhaustion);
  }
);


/**
 * @notice Verifies that rates and indexes do not overflow before a borrower at max supported utilization is liquidated
 * @dev Rates and index increments are uint64 and pass through safe64, so an overflow reverts every accrual and
 *      locks the market. Above the limit operations cannot raise utilization, it only grows through interest:
 *      the debt grows faster than the supply, so utilization and rates keep rising. The borrower holds as much
 *      collateral as the supply cap allows, which keeps the position open the longest, and still becomes
 *      liquidatable long before the indexes overflow. Accruing every day compounds the indexes almost as fast as
 *      accruing every block.
 */
scenario(
  'Comet#interestRate > indexes do not overflow before a borrower at max supported utilization is liquidated',
  {
    // Development only: the collateral up to the supply cap comes from a faucet and the rates are set by an upgrade
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'hardhat', deployment: 'dai' }]),
    // Close to the rates of mainnet USDC, whose slope above the kink is far steeper than on development
    upgrade: {
      supplyKink: exp(0.9, 18),
      supplyPerYearInterestRateBase: exp(0, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.036, 18),
      supplyPerYearInterestRateSlopeHigh: exp(3.2, 18),
      borrowKink: exp(0.9, 18),
      borrowPerYearInterestRateBase: exp(0.015, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.028, 18),
      borrowPerYearInterestRateSlopeHigh: exp(3.6, 18),
    },
  },
  async ({ comet, actors }, context: CometContext, world) => {
    // Only needed on development, where the market is deployed with a supply from the initial lender.
    // Withdrawing it leaves the market without lenders. On other bases there is no initial lender and this does nothing
    await withdrawFromInitialLender(context);

    const { albert, betty, charles } = actors;
    const baseToken = context.getAssetByAddress(await comet.baseToken());
    const [collateralIndex] = await getUsableCollateralIndices(context);
    const { collateralAsset, supplyAmount, borrowAmount } = await getMinimumBorrowAmounts(context, collateralIndex);
    const maxSupportedUtilization = (await comet.maxSupportedUtilization()).toBigInt();

    // The smallest supply that still allows the borrow, with 1 wei more debt to cover the rounding of the principal
    const lenderSupply = ((borrowAmount + 1n) * factorScale + maxSupportedUtilization - 1n) / maxSupportedUtilization;
    await context.sourceTokens(lenderSupply, baseToken.address, albert.address);
    await baseToken.approve(albert, comet.address);
    await albert.supplyAsset({ asset: baseToken.address, amount: lenderSupply });

    // Borrows above total supply are paid out of reserves
    await context.sourceTokens(borrowAmount, baseToken.address, comet.address);

    // Charles only tries to borrow, so the collateral of betty takes the rest of the supply cap
    await context.sourceTokens(supplyAmount, collateralAsset.address, charles.address);
    await collateralAsset.approve(charles, comet.address);
    await charles.safeSupplyAsset({ asset: collateralAsset.address, amount: supplyAmount });

    const { supplyCap } = await comet.getAssetInfo(collateralIndex);
    const collateralAmount = supplyCap.toBigInt() - (await comet.totalsCollateral(collateralAsset.address)).totalSupplyAsset.toBigInt();
    await context.sourceTokens(collateralAmount, collateralAsset.address, betty.address);
    await collateralAsset.approve(betty, comet.address);
    await betty.safeSupplyAsset({ asset: collateralAsset.address, amount: collateralAmount });
    await betty.withdrawAsset({ asset: baseToken.address, amount: borrowAmount });

    const initialUtilization = await comet.getUtilization();
    expect(initialUtilization).to.be.lte(maxSupportedUtilization);
    expect(defactor(initialUtilization)).to.be.approximately(defactor(maxSupportedUtilization), 0.0001);

    // Liquidity for the withdrawal and the borrow below, so they revert on the limit and not on the balance of Comet
    const lenderWithdrawAmount = lenderSupply / 2n;
    await context.sourceTokens(borrowAmount, baseToken.address, comet.address);
    expect(await baseToken.balanceOf(comet.address)).to.be.gte(lenderWithdrawAmount + borrowAmount);

    const initialTotals = await comet.totalsBasic();
    let days = 0;
    while (!(await comet.isLiquidatable(betty.address))) {
      const totalsBefore = await comet.totalsBasic();
      const utilizationBefore = await comet.getUtilization();

      // Checked with callStatic, since a reverted transaction after the time travel leaves the nonce out of sync with the node
      await expect(
        comet.connect(albert.signer).callStatic.withdraw(baseToken.address, lenderWithdrawAmount)
      ).to.be.revertedWithCustomError(comet, 'ExceedsSupportedUtilization');
      await expect(
        comet.connect(charles.signer).callStatic.withdraw(baseToken.address, borrowAmount)
      ).to.be.revertedWithCustomError(comet, 'ExceedsSupportedUtilization');

      await world.increaseTime(24 * 60 * 60);
      await comet.accrueAccount(albert.address);

      const totalsAfter = await comet.totalsBasic();
      expect(totalsAfter.baseSupplyIndex).to.be.gt(totalsBefore.baseSupplyIndex);
      expect(totalsAfter.baseBorrowIndex).to.be.gt(totalsBefore.baseBorrowIndex);
      expect(await comet.getUtilization()).to.be.gt(utilizationBefore);
      days++;
    }

    const liquidationTotals = await comet.totalsBasic();
    log(
      `The borrower became liquidatable after ${days} days, starting at ${defactor(maxSupportedUtilization) * 100}% ` +
      `utilization. The supply index grew ${liquidationTotals.baseSupplyIndex.div(initialTotals.baseSupplyIndex)}x ` +
      `and the borrow index ${liquidationTotals.baseBorrowIndex.div(initialTotals.baseBorrowIndex)}x ` +
      `of the ${(2n ** 64n - 1n) / initialTotals.baseBorrowIndex.toBigInt()}x that fits uint64`
    );

    await comet.connect(charles.signer).absorb(charles.address, [betty.address]);
    expect(await comet.borrowBalanceOf(betty.address)).to.equal(0n);

    // Reserves cover the supply with the accrued interest, which the bad debt of the borrower leaves unpaid
    await context.sourceTokens((await comet.totalSupply()).toBigInt(), baseToken.address, comet.address);

    await albert.withdrawAsset({ asset: baseToken.address, amount: UINT256_MAX });
    expect(await comet.balanceOf(albert.address)).to.equal(0n);
  }
);
