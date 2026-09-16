import { CometHarnessInterfaceExtendedAssetList, CometProxyAdmin, Configurator, FaucetToken, NonStandardFaucetFeeToken, PriceFeedWithRevert, SimplePriceFeed } from 'build/types';
import { expect, exp, ethers, MAX_ASSETS, presentValue, mulPrice, mulFactor, factorScale, BigNumber, takeSnapshot, SnapshotRestorer, makeConfigurator } from './helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('isLiquidatable', function () {
  // Constants
  const ONE_HOUR = 60 * 60;
  const baseTokenDecimals = 6;
  const collateralTokenDecimals = 18;
  // Configurator and protocol
  let comet: CometHarnessInterfaceExtendedAssetList;
  let configurator: Configurator;
  let configuratorProxyAddress: string;
  let proxyAdmin: CometProxyAdmin;
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
    const protocol = await makeConfigurator({ 
      assets: { 
        USDC: { decimals: baseTokenDecimals, initialPrice: 1 }, 
        ...collaterals 
      },
      baseTrackingBorrowSpeed: exp(1 / 86400, 15, 18), // 1 comp per day
      baseTrackingSupplySpeed: exp(1 / 86400, 15, 18), // 1 comp per day
    });
    const cometProxyAddress = protocol.cometProxyWithExtendedAssetList.address;
    comet = protocol.cometWithExtendedAssetList.attach(cometProxyAddress);
    configurator = protocol.configurator;
    configuratorProxyAddress = protocol.configuratorProxy.address;
    proxyAdmin = protocol.proxyAdmin;
    [alice, bob] = protocol.users;
    baseSymbol = protocol.base;
    baseToken = protocol.tokens[baseSymbol];
    collateralToken = protocol.tokens['ASSET0'];
    tokens = protocol.tokens;
    priceFeeds = protocol.priceFeeds;

    // Upgrade proxy to extended asset list implementation to support many assets
    const assetListFactory = protocol.assetListFactory;
    configurator = configurator.attach(configuratorProxyAddress);
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

    let snapshot: SnapshotRestorer;
 
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

      snapshot = await takeSnapshot();
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
      // Add 1 to the borrow balance to ensure that the user is no longer a borrower
      fullRepayAmount = (await comet.borrowBalanceOf(bob.address)).add(1);
      await baseToken.connect(bob).approve(comet.address, fullRepayAmount);
      await comet.connect(bob).supply(baseToken.address, fullRepayAmount);
    });

    it('user is no longer a borrower after full repayment (principal >= 0)', async () => {
      expect((await comet.userBasic(bob.address)).principal).to.be.greaterThanOrEqual(0);
    });

    it('borrow balance is zero after full repayment', async () => {
      expect(await comet.borrowBalanceOf(bob.address)).to.be.equal(0);
    });

    it('collateral balance remains unchanged after repayment', async () => {
      expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.eq(collateralBalanceBefore);
    });

    it('after full repayment principal >= 0 so user is not liquidatable', async () => {
      const principal = (await comet.userBasic(bob.address)).principal;
      expect(principal).to.be.greaterThanOrEqual(0);
    });

    it('user is no longer liquidatable after full repayment', async () => {
      expect(await comet.isLiquidatable(bob.address)).to.be.false;

      // Restore snapshot
      await snapshot.restore();
    });
  });

  // From the liquidatable state (debt grew past weighted collateral due to interest),
  // increasing the collateral asset price on the price feed raises the weighted
  // collateral value above the accrued debt, so the user recovers from liquidation
  // without any repayment or collateral deposit — only the oracle price changes.
  describe('recovers from liquidatable position via collateral price increase on price feed', function () {
    const NEW_COLLATERAL_PRICE:bigint = exp(220, 8);
    let principalBefore: BigNumber;
    let collateralBalanceBefore: BigNumber;

    before(async () => {
      principalBefore = (await comet.userBasic(bob.address)).principal;
      collateralBalanceBefore = (await comet.userCollateral(bob.address, collateralToken.address)).balance;
    });

    it('sanity check: user is a liquidatable borrower at start', async () => {
      expect(principalBefore).to.be.lessThan(0);
      expect(await comet.isLiquidatable(bob.address)).to.be.true;
    });

    it('sanity check: new price is greater than current price', async () => {
      expect(NEW_COLLATERAL_PRICE).to.be.greaterThan((await priceFeeds['ASSET0'].latestRoundData())[1]);
    });

    it('liquidity is negative at current collateral price', async () => {
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
      // Calculate collateral value in USD
      const collateralUSD = mulPrice(
        collateralBalanceBefore.toBigInt(),
        collateralPrice.toBigInt(),
        assetInfo.scale.toBigInt()
      );
      // Calculate weighted collateral value
      const weightedCollateral = mulFactor(collateralUSD, assetInfo.liquidateCollateralFactor);
      // Calculate liquidity
      const liquidity = debtUSD + weightedCollateral;
      // Check if liquidity is less than zero
      expect(liquidity).to.be.lessThan(0n);
    });

    it('collateral price is updated on the price feed', async () => {
      await priceFeeds['ASSET0'].setRoundData(1, NEW_COLLATERAL_PRICE, 0, 0, 1);
    });

    it('price feed reflects the new collateral price', async () => {
      const newPrice = (await priceFeeds['ASSET0'].latestRoundData())[1];
      expect(newPrice.toBigInt()).to.eq(NEW_COLLATERAL_PRICE);
    });

    it('principal unchanged after price feed update', async () => {
      expect((await comet.userBasic(bob.address)).principal).to.eq(principalBefore);
    });

    it('collateral balance unchanged after price feed update', async () => {
      expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.eq(collateralBalanceBefore);
    });

    it('user is no longer liquidatable after price increase', async () => {
      expect(await comet.isLiquidatable(bob.address)).to.be.false;
    });

    it('weighted collateral value exceeds debt value at new price (liquidity >= 0)', async () => {
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
      const collateralUSD = mulPrice(
        collateralBalanceBefore.toBigInt(),
        collateralPrice.toBigInt(),
        assetInfo.scale.toBigInt()
      );
      const weightedCollateral = mulFactor(collateralUSD, assetInfo.liquidateCollateralFactor);

      const liquidity = debtUSD + weightedCollateral;
      expect(liquidity).to.be.greaterThanOrEqual(0n);
    });
  });

  describe('edge cases', function () {
    // Simulates a scenario where the base token price feed becomes broken (reverts
    // on latestRoundData) for an unknown reason. Governance upgrades comet with
    // the broken feed via configurator + proxyAdmin, making isLiquidatable
    // unreachable (reverts). Once governance restores the original working price
    // feed and upgrades again, isLiquidatable resumes normal operation.
    describe('isLiquidatable reverts when base price feed is broken and recovers after restore', function () {
      let originalBasePriceFeed: string;
      let brokenPriceFeed: PriceFeedWithRevert;

      before(async () => {
        originalBasePriceFeed = await comet.baseTokenPriceFeed();
      });

      it('sanity check: bob is a borrower so isLiquidatable exercises the price feed', async () => {
        expect((await comet.userBasic(bob.address)).principal).to.be.lt(0);
        expect(await comet.isLiquidatable(bob.address)).to.be.false;
      });

      it('deploy broken price feed that reverts on latestRoundData', async () => {
        const factory = await ethers.getContractFactory('PriceFeedWithRevert');
        brokenPriceFeed = await factory.deploy(exp(1, 8), 8) as PriceFeedWithRevert;
        await brokenPriceFeed.deployed();
      });

      it('set broken price feed as base token price feed via configurator', async () => {
        await configurator.setBaseTokenPriceFeed(comet.address, brokenPriceFeed.address);
      });

      it('deploy and upgrade comet with broken price feed', async () => {
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);
      });

      it('comet base price feed is now the broken feed', async () => {
        expect(await comet.baseTokenPriceFeed()).to.eq(brokenPriceFeed.address);
      });

      it('isLiquidatable reverts due to broken base price feed', async () => {
        await expect(comet.isLiquidatable(bob.address)).to.be.revertedWithCustomError(brokenPriceFeed, 'Reverted');
      });

      it('restore original base price feed via configurator', async () => {
        await configurator.setBaseTokenPriceFeed(comet.address, originalBasePriceFeed);
      });

      it('deploy and upgrade comet to restore original price feed', async () => {
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);
      });

      it('comet base price feed is restored to original', async () => {
        expect(await comet.baseTokenPriceFeed()).to.eq(originalBasePriceFeed);
      });

      it('isLiquidatable works again after restoring price feed', async () => {
        expect(await comet.isLiquidatable(bob.address)).to.be.false;
      });
    });

    // Same scenario but with a collateral token (ASSET0) price feed. When the
    // collateral price feed becomes broken, isLiquidatable cannot compute the
    // collateral value for the borrower's position and reverts. After governance
    // restores the working feed and upgrades, isLiquidatable resumes normal operation.
    describe('isLiquidatable reverts when collateral price feed is broken and recovers after restore', function () {
      let originalCollateralPriceFeed: string;
      let brokenPriceFeed: PriceFeedWithRevert;

      before(async () => {
        originalCollateralPriceFeed = (await comet.getAssetInfo(0)).priceFeed;
      });

      it('sanity check: bob is a borrower with collateral so isLiquidatable exercises the collateral price feed', async () => {
        expect((await comet.userBasic(bob.address)).principal).to.be.lessThan(0);
        expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.be.greaterThan(0);
        expect(await comet.isLiquidatable(bob.address)).to.be.false;
      });

      it('deploy broken price feed that reverts on latestRoundData', async () => {
        const factory = await ethers.getContractFactory('PriceFeedWithRevert');
        brokenPriceFeed = await factory.deploy(exp(1, 8), 8) as PriceFeedWithRevert;
        await brokenPriceFeed.deployed();
      });

      it('broken price feed has correct decimals for comet compatibility', async () => {
        expect(await brokenPriceFeed.decimals()).to.be.equal(8);
      });

      it('set broken price feed for collateral asset via configurator', async () => {
        await configurator.updateAssetPriceFeed(comet.address, collateralToken.address, brokenPriceFeed.address);
      });

      it('deploy and upgrade comet with broken collateral price feed', async () => {
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);
      });

      it('comet collateral price feed is now the broken feed', async () => {
        expect((await comet.getAssetInfo(0)).priceFeed).to.be.equal(brokenPriceFeed.address);
      });

      it('isLiquidatable reverts due to broken collateral price feed', async () => {
        await expect(comet.isLiquidatable(bob.address)).to.be.revertedWithCustomError(brokenPriceFeed, 'Reverted');
      });

      it('restore original collateral price feed via configurator', async () => {
        await configurator.updateAssetPriceFeed(comet.address, collateralToken.address, originalCollateralPriceFeed);
      });

      it('deploy and upgrade comet to restore original collateral price feed', async () => {
        await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);
      });

      it('comet collateral price feed is restored to original', async () => {
        expect((await comet.getAssetInfo(0)).priceFeed).to.be.equal(originalCollateralPriceFeed);
      });

      it('isLiquidatable works again after restoring collateral price feed', async () => {
        expect(await comet.isLiquidatable(bob.address)).to.be.false;
      });
    }); 

    // Verifies that isLiquidatable correctly handles non-contiguous collateral
    // positions spanning both assetsIn (bits 0-15) and _reserved (bits 16-23).
    // Only 3 assets at indices 7, 15, 21 are supplied, proving the liquidity
    // loop correctly processes sparse asset bitmaps.
    describe('sparse collateral indices (assets 7, 15, 21) across assetsIn and _reserved', function () {
      const ASSET_INDICES = [7, 15, 21];
      const SUPPLY_COLLATERAL_AMOUNT = exp(1, collateralTokenDecimals);
      // Max borrow = 3 * ($200 * borrowCF 0.75) = 3 * $150 = $450
      // Borrow $5 below max to pass collateralization check
      const BORROW_AMOUNT = exp(ASSET_INDICES.length * 200 * 0.75 - 5, baseTokenDecimals);

      let dave: SignerWithAddress;

      before(async () => {
        dave = (await ethers.getSigners())[6];

        await baseToken.allocateTo(comet.address, BORROW_AMOUNT);

        for (const idx of ASSET_INDICES) {
          const asset = tokens[`ASSET${idx}`];
          await asset.allocateTo(dave.address, SUPPLY_COLLATERAL_AMOUNT);
          await asset.connect(dave).approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
          await comet.connect(dave).supply(asset.address, SUPPLY_COLLATERAL_AMOUNT);
        }
      });

      it('dave principal is zero before borrow', async () => {
        expect((await comet.userBasic(dave.address)).principal).to.eq(0);
      });

      it('only selected collateral balances are non-zero', async () => {
        for (let i = 0; i < MAX_ASSETS; i++) {
          const balance = (await comet.userCollateral(dave.address, tokens[`ASSET${i}`].address)).balance;
          ASSET_INDICES.includes(i) ? 
            expect(balance).to.equal(SUPPLY_COLLATERAL_AMOUNT) :
            expect(balance).to.equal(0);
        }
      });

      it('dave performs borrow near max capacity', async () => {
        await comet.connect(dave).withdraw(baseToken.address, BORROW_AMOUNT);
      });

      it('principal is negative after borrow', async () => {
        expect((await comet.userBasic(dave.address)).principal).to.be.lt(0);
      });

      it('borrow balance equals expected amount (with possible minor interest accrual)', async () => {
        const borrowBalance = await comet.borrowBalanceOf(dave.address);
        expect(borrowBalance).to.be.approximately(BORROW_AMOUNT, 1);
      });

      it('user is not liquidatable with sparse collateral positions', async () => {
        expect(await comet.isLiquidatable(dave.address)).to.be.false;
      });

      it('only 3 supplied collaterals contribute to liquidity and total exceeds debt', async () => {
        const principal = (await comet.userBasic(dave.address)).principal;
        const totalsBasic = await comet.totalsBasic();
        const presentValuePrincipal = presentValue(
          principal.toBigInt(),
          totalsBasic.baseSupplyIndex.toBigInt(),
          totalsBasic.baseBorrowIndex.toBigInt()
        );

        const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
        const baseScale = await comet.baseScale();
        let liquidity = mulPrice(presentValuePrincipal, basePrice, baseScale);

        let totalWeightedCollateral = 0n;

        for (let i = 0; i < MAX_ASSETS; i++) {
          const assetInfo = await comet.getAssetInfo(i);
          const balance = (await comet.userCollateral(dave.address, assetInfo.asset)).balance;

          if (balance.isZero()) continue;

          const price = await comet.getPrice(assetInfo.priceFeed);
          const collateralUSD = mulPrice(balance.toBigInt(), price.toBigInt(), assetInfo.scale.toBigInt());
          const weighted = mulFactor(collateralUSD, assetInfo.liquidateCollateralFactor);

          totalWeightedCollateral += weighted;
          liquidity += weighted;
        }

        // Each asset: 1 token * $200 * liquidateCF 0.8 = $160
        // Total from 3 assets: 3 * $160 = $480
        const perAssetExpected = mulFactor(
          mulPrice(SUPPLY_COLLATERAL_AMOUNT, exp(200, 8), exp(1, collateralTokenDecimals)),
          exp(0.8, 18)
        );
        expect(totalWeightedCollateral).to.eq(perAssetExpected * BigInt(ASSET_INDICES.length));
        expect(totalWeightedCollateral).to.be.greaterThan(-mulPrice(presentValuePrincipal, basePrice, baseScale));
        expect(liquidity).to.be.greaterThanOrEqual(0n);
      });
    });
  });

  // With all 24 collateral assets supplied and a near-max borrow, this verifies
  // that isLiquidatable correctly iterates over all 24 assets in the liquidity
  // computation. Each asset contributes equally (same price, same CF) and the
  // off-chain calculation mirrors the contract's loop to prove every asset is counted.
  describe('24 assets computation support', function () {
    const SUPPLY_COLLATERAL_AMOUNT = exp(1, collateralTokenDecimals);
    // Max borrow = MAX_ASSETS * ($200 * borrowCF 0.75) = 24 * $150 = $3600
    // Borrow $5 below max to pass collateralization check
    const BORROW_AMOUNT = exp(MAX_ASSETS * 200 * 0.75 - 5, baseTokenDecimals);

    let charlie: SignerWithAddress;

    before(async () => {
      charlie = (await ethers.getSigners())[5];

      // Ensure all collateral price feeds are at $200 (ASSET0 was left at $220
      // by the "collateral price increase" describe block)
      await priceFeeds['ASSET0'].setRoundData(1, exp(200, 8), 0, 0, 1);

      await baseToken.allocateTo(comet.address, BORROW_AMOUNT);

      for (let i = 0; i < MAX_ASSETS; i++) {
        const asset = tokens[`ASSET${i}`];
        await asset.allocateTo(charlie.address, SUPPLY_COLLATERAL_AMOUNT);
        await asset.connect(charlie).approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
        await comet.connect(charlie).supply(asset.address, SUPPLY_COLLATERAL_AMOUNT);
      }
    });

    it('comet supports 24 collateral assets', async () => {
      expect(await comet.numAssets()).to.eq(MAX_ASSETS);
    });

    it('charlie principal is zero before borrow', async () => {
      expect((await comet.userBasic(charlie.address)).principal).to.eq(0);
    });

    it('each of 24 collateral balances equals supply amount', async () => {
      for (let i = 0; i < MAX_ASSETS; i++) {
        expect(
          (await comet.userCollateral(charlie.address, tokens[`ASSET${i}`].address)).balance
        ).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
      }
    });

    it('charlie performs borrow near max capacity', async () => {
      await comet.connect(charlie).withdraw(baseToken.address, BORROW_AMOUNT);
    });

    it('principal is negative after borrow', async () => {
      expect((await comet.userBasic(charlie.address)).principal).to.be.lessThan(0);
    });

    it('borrow balance equals expected amount (with possible minor interest accrual)', async () => {
      const borrowBalance = await comet.borrowBalanceOf(charlie.address);
      expect(borrowBalance).to.be.approximately(BORROW_AMOUNT, 1); // 1 wei of possible rounding
    });

    it('user is not liquidatable with all 24 collaterals supporting the borrow', async () => {
      expect(await comet.isLiquidatable(charlie.address)).to.be.false;
    });

    it('all 24 collaterals are involved in liquidity calculation and total exceeds debt', async () => {
      const principal = (await comet.userBasic(charlie.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const presentValuePrincipal = presentValue(
        principal.toBigInt(),
        totalsBasic.baseSupplyIndex.toBigInt(),
        totalsBasic.baseBorrowIndex.toBigInt()
      );

      const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      const baseScale = await comet.baseScale();
      let liquidity = mulPrice(presentValuePrincipal, basePrice, baseScale);

      for (let i = 0; i < MAX_ASSETS; i++) {
        const assetInfo = await comet.getAssetInfo(i);
        const balance = (await comet.userCollateral(charlie.address, assetInfo.asset)).balance;
        const price = await comet.getPrice(assetInfo.priceFeed);
        const collateralUSD = mulPrice(balance.toBigInt(), price.toBigInt(), assetInfo.scale.toBigInt());
        const weighted = mulFactor(collateralUSD, assetInfo.liquidateCollateralFactor);

        liquidity += weighted;
      }

      expect(liquidity).to.be.greaterThanOrEqual(0n);
    });
  });
});
