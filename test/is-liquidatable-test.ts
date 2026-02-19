import { CometHarnessInterfaceExtendedAssetList, FaucetToken, NonStandardFaucetFeeToken, SimplePriceFeed } from 'build/types';
import { expect, exp, makeProtocol, ethers, MAX_ASSETS, presentValue, mulPrice, mulFactor, factorScale, BigNumber, takeSnapshot, SnapshotRestorer } from './helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe.only('isLiquidatable', function () {
  // Constants
  const ONE_HOUR = 60 * 60;
  const baseTokenDecimals = 6;
  const collateralTokenDecimals = 18;
  // Configurator and protocol
  let comet: CometHarnessInterfaceExtendedAssetList;
  // Tokens
  let baseSymbol: string;
  let baseToken: FaucetToken | NonStandardFaucetFeeToken;
  let collateralToken: FaucetToken | NonStandardFaucetFeeToken;
  let tokens: Record<string, FaucetToken | NonStandardFaucetFeeToken>;
  // Price feeds
  let priceFeeds: Record<string, SimplePriceFeed>;
  // Users
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  before(async () => {
    const collaterals = Object.fromEntries(
      Array.from({ length: MAX_ASSETS }, (_, j) => [
        `ASSET${j}`,
        {
          decimals: collateralTokenDecimals,
          initialPrice: 200,
          borrowCF: exp(0.75, 18),
          liquidateCF: exp(0.8, 18),
        },
      ])
    );
    const protocol = await makeProtocol({ 
      assets: { 
        USDC: { decimals: baseTokenDecimals, initialPrice: 1 }, 
        ...collaterals 
      },
      baseTrackingBorrowSpeed: exp(1 / 86400, 15, 18), // 1 comp per day
      baseTrackingSupplySpeed: exp(1 / 86400, 15, 18), // 1 comp per day
    });
    comet = protocol.cometWithExtendedAssetList;
    [alice, bob] = protocol.users;
    baseSymbol = protocol.base;
    baseToken = protocol.tokens[baseSymbol];
    collateralToken = protocol.tokens['ASSET0'];
    tokens = protocol.tokens;
    priceFeeds = protocol.priceFeeds;
  });

  describe('empty market (no position)', function () {
    it('user principal should be >= 0', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.eq(0);
    });

    it('positive principal returns always false', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('wait and accrue state', async () => {
      // wait with empty comet for a while
      await ethers.provider.send('evm_increaseTime', [ONE_HOUR]); // 1 hr
      await ethers.provider.send('evm_mine', []);

      await comet.accrueAccount(alice.address);
    });

    it('time is not affecting on user with no position', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });
  });

  // Base token supply affects on user's principal, in case of supply
  // principal should be increased and should have no impact on liquidatable status (including accrue 
  // and principal already >= 0 and time passed)
  describe('base token supply increases principal, user remains not liquidatable', function () {
    const SUPPLY_AMOUNT = exp(1000, baseTokenDecimals);
    before(async () => {
      // Allocate tokens to alice
      await baseToken.allocateTo(alice.address, SUPPLY_AMOUNT);
    });

    it('sanity check: user principal should be zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.eq(0);
    });

    it('user perform supply operation', async () => {
      await baseToken.connect(alice).approve(comet.address, SUPPLY_AMOUNT);
      await comet.connect(alice).supply(baseToken.address, SUPPLY_AMOUNT);
    });

    it('user principal increased by supply amount', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.eq(SUPPLY_AMOUNT);
    });

    it('wait and accrue state', async () => {
      // wait with empty comet for a while
      await ethers.provider.send('evm_increaseTime', [ONE_HOUR]); // 1 hr
      await ethers.provider.send('evm_mine', []);

      await comet.accrueAccount(alice.address);
    });

    it('user should not be liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });
  });

  // Collateral token supply does not affect user's principal, it only increases
  // collateral balance and should have no impact on liquidatable status
  describe('collateral supply does not affect principal, user remains not liquidatable', function () {
    const SUPPLY_COLLATERAL_AMOUNT = exp(1, collateralTokenDecimals);
    let principalBefore: BigNumber;

    before(async () => {
      await collateralToken.allocateTo(bob.address, SUPPLY_COLLATERAL_AMOUNT);
      principalBefore = (await comet.userBasic(bob.address)).principal;
    });

    it('sanity check: user principal should be zero', async () => {
      expect((await comet.userBasic(bob.address)).principal).to.eq(0);
    });

    it('collateral balance before should be zero', async () => {
      expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.eq(0);
    });

    it('comet collateral token balance should be zero', async () => {
      expect(await collateralToken.balanceOf(comet.address)).to.eq(0);
    });

    it('user perform supply collateral operation', async () => {
      await collateralToken.connect(bob).approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
      await comet.connect(bob).supply(collateralToken.address, SUPPLY_COLLATERAL_AMOUNT);
    });

    it('wait and accrue state', async () => {
      // wait with empty comet for a while
      await ethers.provider.send('evm_increaseTime', [ONE_HOUR]); // 1 hr
      await ethers.provider.send('evm_mine', []);

      await comet.accrueAccount(bob.address);
    });

    it('user principal should not change after collateral supply', async () => {
      expect((await comet.userBasic(bob.address)).principal).to.eq(principalBefore);
    });

    it('collateral balance after equals supply amount', async () => {
      expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.eq(SUPPLY_COLLATERAL_AMOUNT);
    });

    it('comet collateral token balance equals supply amount', async () => {
      expect(await collateralToken.balanceOf(comet.address)).to.eq(SUPPLY_COLLATERAL_AMOUNT);
    });

    it('users borrow balance should be zero', async () => {
      expect(await comet.borrowBalanceOf(bob.address)).to.eq(0);
    });

    it('user should not be liquidatable', async () => {
      expect(await comet.isLiquidatable(bob.address)).to.be.false;
    });
  });

  // Borrowing base token makes principal negative (borrower). With 1 ASSET0 ($200)
  // as collateral and liquidateCF = 0.8, the weighted collateral value is $160.
  // A $100 borrow keeps liquidity positive ($160 - $100 = $60), so user is not liquidatable.
  describe('returns false when weighted collateral value exceeds debt value', function () {
    const BORROW_AMOUNT = exp(100, baseTokenDecimals);

    let principalBefore: BigNumber;
    let bobBaseBalanceBefore: BigNumber;
    let collateralBalanceBefore: BigNumber;

    before(async () => {
      principalBefore = (await comet.userBasic(bob.address)).principal;
      bobBaseBalanceBefore = await baseToken.balanceOf(bob.address);
      collateralBalanceBefore = (await comet.userCollateral(bob.address, collateralToken.address)).balance;
    });

    it('principal before should be zero', async () => {
      expect(principalBefore).to.eq(0);
    });

    it('bob base token balance before should be zero', async () => {
      expect(bobBaseBalanceBefore).to.eq(0);
    });

    it('bob performs withdraw (borrow) of base token', async () => {
      await comet.connect(bob).withdraw(baseToken.address, BORROW_AMOUNT);
    });

    it('principal after is negative (bob is now a borrower)', async () => {
      expect((await comet.userBasic(bob.address)).principal).to.be.lt(0);
    });

    it('borrow balance equals borrow amount', async () => {
      expect(await comet.borrowBalanceOf(bob.address)).to.eq(BORROW_AMOUNT);
    });

    it('bob received borrowed base tokens', async () => {
      expect(await baseToken.balanceOf(bob.address)).to.eq(BORROW_AMOUNT);
    });

    it('collateral balance unchanged after borrow', async () => {
      expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.eq(collateralBalanceBefore);
    });

    it('collateral value weighted by liquidateCF exceeds debt value', async () => {
      // Get present value of principal
      const principal = (await comet.userBasic(bob.address)).principal;
      const presentValuePrincipal = presentValue(
        principal.toBigInt(), 
        (await comet.totalsBasic()).baseSupplyIndex.toBigInt(), 
        (await comet.totalsBasic()).baseBorrowIndex.toBigInt()
      );

      // Get base token price and scale
      const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      const baseScale = await comet.baseScale();

      // Get debt value in USD
      const debtUSD = mulPrice(presentValuePrincipal, basePrice, baseScale);

      // Get collateral data
      const collateralPrice = await comet.getPrice((await comet.getAssetInfo(0)).priceFeed);
      const assetScale = (await comet.getAssetInfo(0)).scale;

      // Calculate collateral value in USD
      const collateralUSD = mulPrice(collateralBalanceBefore.toBigInt(), collateralPrice.toBigInt(), assetScale.toBigInt());

      // Calculate weighted collateral value
      const weightedCollateral = mulFactor(collateralUSD, (await comet.getAssetInfo(0)).liquidateCollateralFactor);

      // Check if weighted collateral value exceeds debt value
      expect(weightedCollateral).to.be.greaterThan(debtUSD);
    });

    it('user should not be liquidatable', async () => {
      expect(await comet.isLiquidatable(bob.address)).to.be.false;
    });
  });

  // Bob borrows 40 more base tokens (total ~$140 debt). After a 15% collateral price drop
  // ($200 → $170), the weighted collateral = $170 * 0.8 = $136, which is less than ~$140 debt.
  // Liquidity becomes negative, so the user is now liquidatable.
  // Note: max additional borrow is ~$50 (borrowCF=0.75 → capacity=$150, already borrowed $100)
  describe('returns true when price drop makes weighted collateral insufficient to cover debt', function () {
    const ADDITIONAL_BORROW_AMOUNT = exp(40, baseTokenDecimals);

    let principalBefore: BigNumber;
    let borrowBalanceBefore: BigNumber;
    let collateralBalanceBefore: BigNumber;

    before(async () => {
      principalBefore = (await comet.userBasic(bob.address)).principal;
      borrowBalanceBefore = await comet.borrowBalanceOf(bob.address);
      collateralBalanceBefore = (await comet.userCollateral(bob.address, collateralToken.address)).balance;
    });

    // Restore collateral price back to the original feed value (200)
    after(async () => {
      await priceFeeds['ASSET0'].setRoundData(1, exp(200, 8), 0, 0, 1);
    });

    it('principal before is negative (bob is already a borrower)', async () => {
      expect(principalBefore).to.be.lt(0);
    });

    it('bob performs additional borrow', async () => {
      await comet.connect(bob).withdraw(baseToken.address, ADDITIONAL_BORROW_AMOUNT);
    });

    it('borrow balance increased after additional borrow', async () => {
      expect(await comet.borrowBalanceOf(bob.address)).to.be.gt(borrowBalanceBefore);
    });

    it('user is not liquidatable before price drop', async () => {
      expect(await comet.isLiquidatable(bob.address)).to.be.false;
    });

    it('collateral price drops by 15%', async () => {
      const currentPrice = (await priceFeeds['ASSET0'].latestRoundData())[1];
      await priceFeeds['ASSET0'].setRoundData(1, currentPrice.mul(85).div(100), 0, 0, 1);
    });

    it('user becomes liquidatable after price drop', async () => {
      expect(await comet.isLiquidatable(bob.address)).to.be.true;
    });

    it('debt value exceeds weighted collateral value (liquidity < 0)', async () => {
      const principal = (await comet.userBasic(bob.address)).principal;
      const presentValuePrincipal = presentValue(
        principal.toBigInt(),
        (await comet.totalsBasic()).baseSupplyIndex.toBigInt(),
        (await comet.totalsBasic()).baseBorrowIndex.toBigInt()
      );

      const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      const baseScale = await comet.baseScale();

      // debtUSD is negative (signed debt value in USD)
      const debtUSD = mulPrice(presentValuePrincipal, basePrice, baseScale);

      const collateralPrice = await comet.getPrice((await comet.getAssetInfo(0)).priceFeed);
      const assetScale = (await comet.getAssetInfo(0)).scale;

      const collateralUSD = mulPrice(collateralBalanceBefore.toBigInt(), collateralPrice.toBigInt(), assetScale.toBigInt());
      const weightedCollateral = mulFactor(collateralUSD, (await comet.getAssetInfo(0)).liquidateCollateralFactor);

      // liquidity = debtUSD (negative) + weightedCollateral (positive)
      // liquidatable when liquidity < 0, meaning weighted collateral cannot cover the debt
      const liquidity = debtUSD + weightedCollateral;
      expect(liquidity).to.be.lessThan(0n);
    });
  });

  // Time in borrow position: with fixed prices, interest accrual on Bob's borrow
  // position eventually makes him liquidatable. We compute the approximate time
  // when liquidity becomes zero using the same index/interest model as the contract.
  describe('becomes liquidatable over time due to interest on borrow position', function () {
    const FACTOR_SCALE = factorScale;
    const SAFETY_NUMERATOR = 11n;   // 10% extra time beyond theoretical boundary
    const SAFETY_DENOMINATOR = 10n;

    let expectedTimeElapsed: bigint;
    let principalBefore: BigNumber;
    let collateralBalanceBefore: BigNumber;

    before(async () => {
      principalBefore = (await comet.userBasic(bob.address)).principal;
      collateralBalanceBefore = (await comet.userCollateral(bob.address, collateralToken.address)).balance;
    });

    it('sanity check: user is a borrower and not liquidatable at start', async () => {
      expect(principalBefore).to.be.lt(0);
      expect(await comet.isLiquidatable(bob.address)).to.be.false;
    });

    it('computes time until liquidity turns negative from interest accrual', async () => {
      const principal = (await comet.userBasic(bob.address)).principal;
      const totalsBasic = await comet.totalsBasic();

      const presentValuePrincipal = presentValue(
        principal.toBigInt(),
        totalsBasic.baseSupplyIndex.toBigInt(),
        totalsBasic.baseBorrowIndex.toBigInt()
      );

      const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      const baseScale = await comet.baseScale();

      // debtUSD0 is negative (signed debt value in USD)
      const debtUSD0Signed = mulPrice(presentValuePrincipal, basePrice, baseScale);
      const debtUSD0 = -debtUSD0Signed; // positive magnitude

      const assetInfo = await comet.getAssetInfo(0);
      const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
      const assetScale = assetInfo.scale;
      const collateralUSD = mulPrice(
        collateralBalanceBefore.toBigInt(),
        collateralPrice.toBigInt(),
        assetScale.toBigInt()
      );
      const weightedCollateral = mulFactor(
        collateralUSD,
        assetInfo.liquidateCollateralFactor
      );

      // At t0 we know weightedCollateral > debtUSD0 (not liquidatable)
      expect(weightedCollateral).to.be.greaterThan(debtUSD0);

      const utilization = await comet.getUtilization();
      const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt(); // per second, scaled by FACTOR_SCALE

      // Model: D(t) = D0 * (1 + r * t), where r = borrowRate / FACTOR_SCALE
      // Liquidity(t) = weightedCollateral - D(t)
      // Solve for Liquidity(t) = 0:
      //   weightedCollateral = D0 * (1 + r * t)
      //   => t = ((weightedCollateral / D0) - 1) / r
      //
      // Rearranged in integer arithmetic:
      //   t = (weightedCollateral - D0) * FACTOR_SCALE / (D0 * borrowRate)
      const numerator = (weightedCollateral - debtUSD0) * FACTOR_SCALE;
      const denominator = debtUSD0 * borrowRate;

      // Ceil division gives the smallest t where:
      //   weightedCollateral <= D0 * (1 + r * t)
      expectedTimeElapsed = (numerator + denominator - 1n) / denominator;

      // Step a bit further (≈10%) to safely move into the region where
      //   weightedCollateral < D0 * (1 + r * t)
      // despite integer rounding in the protocol math.
      expectedTimeElapsed = (expectedTimeElapsed * SAFETY_NUMERATOR) / SAFETY_DENOMINATOR + 1n;
    });

    it('accrues market state after the expected time elapsed', async () => {
      await ethers.provider.send('evm_increaseTime', [Number(expectedTimeElapsed)]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(bob.address);
    });

    it('user becomes liquidatable after enough time has passed', async () => {
      expect(await comet.isLiquidatable(bob.address)).to.be.true;
    });

    it('debt growth from interest makes weighted collateral insufficient (liquidity < 0)', async () => {
      // Get present value of principal
      const principal = (await comet.userBasic(bob.address)).principal;
      const presentValuePrincipal = presentValue(
        principal.toBigInt(),
        (await comet.totalsBasic()).baseSupplyIndex.toBigInt(),
        (await comet.totalsBasic()).baseBorrowIndex.toBigInt()
      );

      // Get base token price and scale
      const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      const baseScale = await comet.baseScale();

      // Get debt value in USD
      const debtUSD = mulPrice(presentValuePrincipal, basePrice, baseScale);

      // Get collateral data
      const collateralPrice = await comet.getPrice((await comet.getAssetInfo(0)).priceFeed);
      const assetScale = (await comet.getAssetInfo(0)).scale;

      // Calculate collateral value in USD
      const collateralUSD = mulPrice(
        collateralBalanceBefore.toBigInt(),
        collateralPrice.toBigInt(),
        assetScale.toBigInt()
      );

      // Calculate weighted collateral value
      const weightedCollateral = mulFactor(
        collateralUSD,
        (await comet.getAssetInfo(0)).liquidateCollateralFactor
      );

      // Calculate liquidity
      const liquidity = debtUSD + weightedCollateral;

      // Check if liquidity is less than zero
      expect(liquidity).to.be.lessThan(0n);
    });
  });

  // Starting from a liquidatable borrow position, the user can partially
  // repay their debt (remain a borrower) and become non-liquidatable again.
  describe('recovers from liquidatable position via partial repayment', function () {
    let principalBefore: BigNumber;
    let borrowBalanceBefore: BigNumber;
    let collateralBalanceBefore: BigNumber;
    let partialRepayAmount: BigNumber;
    let snapshot: SnapshotRestorer;

    before(async () => {
      principalBefore = (await comet.userBasic(bob.address)).principal;
      borrowBalanceBefore = await comet.borrowBalanceOf(bob.address);
      collateralBalanceBefore = (await comet.userCollateral(bob.address, collateralToken.address)).balance;
      partialRepayAmount = borrowBalanceBefore.div(2);

      await baseToken.allocateTo(bob.address, partialRepayAmount);

      snapshot = await takeSnapshot();
    });

    it('sanity check: user is a liquidatable borrower at start', async () => {
      expect(principalBefore).to.be.lt(0);
      expect(await comet.isLiquidatable(bob.address)).to.be.true;
    });

    it('partial repay amount is less than total debt', async () => {
      expect(partialRepayAmount).to.be.gt(0);
      expect(partialRepayAmount).to.be.lt(borrowBalanceBefore);
    });

    it('bob performs partial repayment by supplying base tokens', async () => {
      await baseToken.connect(bob).approve(comet.address, partialRepayAmount);
      await comet.connect(bob).supply(baseToken.address, partialRepayAmount);
    });

    it('user remains a borrower after partial repayment (principal stays negative)', async () => {
      expect((await comet.userBasic(bob.address)).principal).to.be.lt(0);
    });

    it('borrow balance decreases after partial repayment', async () => {
      expect(await comet.borrowBalanceOf(bob.address)).to.be.lt(borrowBalanceBefore);
    });

    it('collateral balance remains unchanged after repayment', async () => {
      expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.eq(collateralBalanceBefore);
    });

    it('liquidity becomes non-negative after partial repayment (user recovered but still a borrower)', async () => {
      const principal = (await comet.userBasic(bob.address)).principal;
      const totalsBasic = await comet.totalsBasic();

      const presentValuePrincipal = presentValue(
        principal.toBigInt(),
        totalsBasic.baseSupplyIndex.toBigInt(),
        totalsBasic.baseBorrowIndex.toBigInt()
      );

      const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      const baseScale = await comet.baseScale();

      const debtUSD = mulPrice(presentValuePrincipal, basePrice, baseScale);

      const assetInfo = await comet.getAssetInfo(0);
      const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
      const assetScale = assetInfo.scale;

      const collateralUSD = mulPrice(
        collateralBalanceBefore.toBigInt(),
        collateralPrice.toBigInt(),
        assetScale.toBigInt()
      );
      const weightedCollateral = mulFactor(
        collateralUSD,
        assetInfo.liquidateCollateralFactor
      );

      const liquidity = debtUSD + weightedCollateral;

      // User is still a borrower (principal < 0) but liquidity is now >= 0,
      // so the position is no longer liquidatable.
      expect(principal).to.be.lt(0);
      expect(liquidity).to.be.gte(0n);
    });

    it('user is no longer liquidatable after partial repayment', async () => {
      expect(await comet.isLiquidatable(bob.address)).to.be.false;
      await snapshot.restore();
    });
  });

  // From the same liquidatable state, full repayment recovers from liquidation
  // and repays all debt so the user is no longer a borrower (principal >= 0).
  describe('recovers from liquidatable position via full repayment, user is no longer a borrower', function () {
    let principalBefore: BigNumber;
    let borrowBalanceBefore: BigNumber;
    let collateralBalanceBefore: BigNumber;
    let fullRepayAmount: BigNumber;
 
    before(async () => {
      principalBefore = (await comet.userBasic(bob.address)).principal;
      borrowBalanceBefore = await comet.borrowBalanceOf(bob.address);
      collateralBalanceBefore = (await comet.userCollateral(bob.address, collateralToken.address)).balance;

      const bobBaseBalance = await baseToken.balanceOf(bob.address);
      const needToAllocate = borrowBalanceBefore.gt(bobBaseBalance)
        ? borrowBalanceBefore.sub(bobBaseBalance)
        : BigNumber.from(0);
      if (needToAllocate.gt(0)) {
        await baseToken.allocateTo(bob.address, needToAllocate);
      }
      fullRepayAmount = await comet.borrowBalanceOf(bob.address);
    });

    it('sanity check: user is a liquidatable borrower at start', async () => {
      expect(principalBefore).to.be.lt(0);
      expect(await comet.isLiquidatable(bob.address)).to.be.true;
    });

    it('full repay amount equals current borrow balance', async () => {
      expect(fullRepayAmount).to.eq(borrowBalanceBefore);
    });

    it('liquidity is negative before full repayment (user is liquidatable)', async () => {
      // Get present value of principal
      const totalsBasic = await comet.totalsBasic();
      const presentValuePrincipal = presentValue(
        principalBefore.toBigInt(),
        totalsBasic.baseSupplyIndex.toBigInt(),
        totalsBasic.baseBorrowIndex.toBigInt()
      );

      // Get base token price and scale
      const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      const baseScale = await comet.baseScale();
      const debtUSD = mulPrice(presentValuePrincipal, basePrice, baseScale);

      // Get collateral data
      const assetInfo = await comet.getAssetInfo(0);
      const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
      const assetScale = assetInfo.scale;
      const collateralUSD = mulPrice(
        collateralBalanceBefore.toBigInt(),
        collateralPrice.toBigInt(),
        assetScale.toBigInt()
      );
      const weightedCollateral = mulFactor(collateralUSD, assetInfo.liquidateCollateralFactor);
      const liquidity = debtUSD + weightedCollateral;
      expect(liquidity).to.be.lessThan(0n);
    });

    it('bob performs full repayment by supplying base tokens', async () => {
      await baseToken.connect(bob).approve(comet.address, fullRepayAmount);
      await comet.connect(bob).supply(baseToken.address, fullRepayAmount);
    });

    it('user is no longer a borrower after full repayment (principal >= 0)', async () => {
      expect((await comet.userBasic(bob.address)).principal).to.be.gte(0);
    });

    it('borrow balance is zero after full repayment', async () => {
      expect(await comet.borrowBalanceOf(bob.address)).to.eq(0);
    });

    it('collateral balance remains unchanged after repayment', async () => {
      expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.eq(collateralBalanceBefore);
    });

    it('after full repayment principal >= 0 so user is not liquidatable', async () => {
      const principal = (await comet.userBasic(bob.address)).principal;
      expect(principal).to.be.gte(0);
    });

    it('user is no longer liquidatable after full repayment', async () => {
      expect(await comet.isLiquidatable(bob.address)).to.be.false;
    });
  });
});
