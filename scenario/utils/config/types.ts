export interface CommonConfig {
    divisors: {
      transfer: bigint;
      borrow: bigint;
      percent: bigint;
      precision: bigint;
    };
    tolerances: {
      interest: { small: bigint, medium: bigint, large: bigint };
      balance: bigint;
    };
    timing: {
      oneDay: bigint;
      interestSeconds: bigint;
    };
    cometBalances: {
      base: bigint;
      collateral: { undercollateralized: bigint, asset0CometBalance: bigint };
    };
  }
  
export interface TransferConfig {
    baseAmount: bigint;
    assetAmount: bigint;
    collateralAmount: bigint;
    multiplier: { num: bigint, denom: bigint };
    result: { num: bigint, denom: bigint };
    remainingBalance: bigint;
    overLimit: bigint;
    principalToleranceValues: bigint[];
  }
  
export interface WithdrawConfig {
    baseAmount: bigint;
    assetAmount: bigint;
    collateralAmount: bigint;
    alternateBase: bigint;
    alternateAsset: bigint;
  }
  
export interface SupplyConfig {
    collateralAmount: bigint;
    baseSupplyAmount: bigint;
    baseSupplyWithFees: bigint;
    baseBorrowWithFees: bigint;
    baseBorrowRepayAmount: bigint;
    baseBalance: bigint;
    baseSupplySmall: bigint;
    baseSupplyAfterFees: bigint;
    usdtFeeBasisPoints: bigint;
    usdtMaxFee: bigint;
    usdtRemainingDebt: bigint;
    ethBalanceForGas: bigint;
    interestTimeFactor: { short: bigint, long: bigint };
  }
  
export interface BulkerConfig {
    base: { supply: bigint, borrow: bigint };
    asset: { supply: bigint, supplyAlternate: bigint, borrow: bigint };
    eth: { supply: bigint, withdraw: bigint };
    weth: { borrow: bigint, transfer: bigint, supply: bigint };
    cometAllocation: bigint;
  }
  
export interface LiquidationConfig {
    base: { borrowPrincipal: bigint, undercollateralized: bigint };
    asset: {
      smallPosition: number;
      supplyAmount: bigint;
    };
    factors: { denominator: bigint, alternateDenominator: bigint, numerator: bigint };
    timeMultiplier: number;
  }
  
export interface RewardsConfig {
    assetAmount: bigint;
    baseAmount: bigint;
    baseSupplyAmount: bigint;
    minTimeDelta: bigint;
    albertBaseDivisor: bigint;
    compRewardsAmount: bigint;
    multiplierScale: bigint;
    multipliers: bigint[];
  }
  
export interface AuthorizationConfig {
    expiryOffset: {
      failed: number;
      valid: number;
      extended: number;
      altered: number;
      past: number;
    };
    invalidVValue: bigint;
    maxSValuePlusOne: string;
  }
  
export interface GovernanceConfig {
    delayMultiplier: bigint;
    timelock: {
      delayDays: bigint;
      gracePeriodDays: bigint;
      minDelayDays: bigint;
      maxDelayDays: bigint;
    };
    newFunctionExpectedValue: bigint;
    minBaseBalance: bigint;
    basePrice: bigint;
    baseBorrowMultiplier: bigint;
  }
  
export interface InterestRateConfig {
    utilizationTolerance: bigint;
    supply: { kink: bigint, slopeLow: bigint, slopeHigh: bigint };
    borrow: { kink: bigint, base: bigint, slopeLow: bigint, slopeHigh: bigint, max: bigint };
    expected: {
      utilizationBelowKink: bigint;
      utilizationAboveKink: bigint;
      supplyRateBelowKink: bigint;
      borrowRateBelowKink: bigint;
      supplyRateAboveKink: bigint;
      borrowRateAboveKink: bigint;
    };
    rateTolerance: bigint;
  }
  
export interface ConfiguratorConfig {
    borrowCollateralFactor: bigint;
    liquidateCollateralFactor: bigint;
    liquidationFactor: bigint;
    supplyCap: bigint;
  }
  
export interface LiquidationBotConfig {
    targetReserves: bigint;
    borrowCapacityUtilization: bigint;
    fudgeFactorTime: bigint;
    expectedCollateralReservesThreshold: bigint;
    flashLoanAmount: bigint;
    partialLiquidationScaleMultiplier: bigint;
    liquidationThresholdMultiplier: bigint;
    absorbEventIndex: bigint;
    absorbWithoutBuyingEventIndex: bigint;
    scenario: {
      fudgeFactorLong: bigint;
      fudgeFactorShort: bigint;
      borrowCapacityUtilizationHigh: bigint;
      collateralDivisor: bigint;
    };
  }
  
export interface MainnetBulkerConfig {
    stethSupplyAmount: bigint;
    stethBalanceTolerance: bigint;
    wstethBalanceTolerance: bigint;
    stethWithdrawalTolerance: bigint;
    wstethWithdrawalTolerance: bigint;
    maxStethWithdrawalTolerance: bigint;
    sourceTokenBuffer: bigint;
  }
  

  
export interface V2Config {
    eth: { repayAmount: bigint, borrowAmount: bigint, finalRepayAmount: bigint };
    dai: { mintRedeemAmount: bigint };
    usdc: { mintRedeemAmount: bigint };
    wbtc: {
      approveAmount: bigint;
      repayBehalfAmount: bigint;
      borrowAmount: bigint;
      repayAmount: bigint;
    };
    borrowTolerance: bigint;
  }
  
export interface AssetsConfig {
    wsteth: {
      supplyCap: { small: bigint, medium: bigint };
      tokenBalance: bigint;
      cometBalance: bigint;
      cometPosition: bigint;
    };
    maticx: {
      supplyAmount: bigint;
      supplyCap: bigint;
      borrowCollateralFactor: bigint;
      liquidateCollateralFactor: bigint;
      liquidationFactor: bigint;
      baseBorrowMultiplier: bigint;
      balanceTolerance: bigint;
    };
    dogecoin: {
      supplyAmount: bigint;
      supplyCap: bigint;
      borrowCollateralFactor: bigint;
      liquidateCollateralFactor: bigint;
      liquidationFactor: bigint;
      decimals: bigint;
      price: bigint;
      allocateAmount: bigint;
    };
  }
  
  
export interface ScenarioConfig {
    common: CommonConfig;
    transfer: TransferConfig;
    withdraw: WithdrawConfig;
    supply: SupplyConfig;
    bulker: BulkerConfig;
    liquidation: LiquidationConfig;
    rewards: RewardsConfig;
    authorization: AuthorizationConfig;
    governance: GovernanceConfig;
    interestRate: InterestRateConfig;
    configurator: ConfiguratorConfig;
    liquidationBot: LiquidationBotConfig;
    mainnetBulker: MainnetBulkerConfig;
    compoundV2: V2Config;
    assets: AssetsConfig;
  }
  