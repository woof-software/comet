import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { annualize, defactor, exp, factorScale } from '../test/helpers';
import { BigNumber } from 'ethers';
import { FuzzType } from './constraints/Fuzzing';
import { supportUtilizationLimit, isFreshMarket } from './utils';
import { getConfigForScenario } from './utils/scenarioHelper';
import { setNextBlockTimestamp } from './utils/hreUtils';

function calculateInterestRateSupply(
  utilization: BigNumber,
  kink: BigNumber,
  interestRateBase: BigNumber,
  interestRateSlopeLow: BigNumber,
  interestRateSlopeHigh: BigNumber,
  totalSupplyBase: BigNumber
): BigNumber {
  const factorScale = BigNumber.from(exp(1, 18));

  if (totalSupplyBase.isZero()) return BigNumber.from(0);
  
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
  async ({ comet }) => {
    let { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
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
        totalSupplyBase
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
    upgrade: {
      // TODO: Read types directly from Solidity?
      supplyPerYearInterestRateBase: { type: FuzzType.UINT64 },
      borrowPerYearInterestRateBase: { type: FuzzType.UINT64, max: (1e18).toString() /* 100% */ },
    }
  },
  async ({ comet }) => {
    let { totalSupplyBase, totalBorrowBase, baseSupplyIndex, baseBorrowIndex } = await comet.totalsBasic();
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
        totalSupplyBase
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
  async ({ comet }, context) => {
    const utilization = await comet.getUtilization();
    expect(defactor(utilization)).to.be.approximately(0.5, 0.00001);

    // Note: this is dependent on the `deployments/fuji/configuration.json` variables
    // TODO: Consider if there's a better way to test the live curve.
    if (context.world.base.network === 'fuji') {
      // (interestRateBase + interestRateSlopeLow * utilization) * utilization * (1 - reserveRate)
      // utilization = 50%
      // ( 1% + 2% * 50% ) * 50% * (100% - 10%)
      // ( 1% + 1% ) * 50% * 90% -> 1% * 90% = 0.9%
      expect(annualize(await comet.getSupplyRate(utilization))).to.be.approximately(0.009, 0.001);

      // interestRateBase + interestRateSlopeLow * utilization
      // utilization = 50%
      // ( 1% + 2% * 50% )
      expect(annualize(await comet.getBorrowRate(utilization))).to.be.approximately(0.02, 0.001);
    }
  }
);

scenario(
  'Comet#interestRate reverts for pushing utilization above 200%',
  {
    filter: async (ctx: CometContext) => await supportUtilizationLimit(ctx) && await isFreshMarket(ctx),
  },
  async ({ comet }, context: CometContext) => {
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
