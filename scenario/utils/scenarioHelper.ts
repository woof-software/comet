import { exp } from 'test/helpers';
import { CometContext } from '../context/CometContext';

interface ScenarioConfig {
  bulker: {
    standardBase: number;
    wethBase: number;
    standardAsset: number;
    alternateAsset: number;
    minimalAsset: number;
    cometAllocation: number;
    borrowBase: number;
    borrowAsset: number;
    supplyAmount: number;
    withdrawAmount: number;
    timeIncrementOneDay: number;
    wethBorrowBase: bigint;
    wethTransferBase: bigint;
  };
  liquidation: {
    standardBase: number;
    mediumBase: number;
    largeBase: number;
    tinyBase: number;
    standardAsset: number;
    mediumAsset: number;
    tinyAsset: number;
    smallAsset: number;
    hundredAsset: number;
    largeAsset: number;
    denominator: number;
    alternateDenominator: number;
    numerator: number;
  };
  rewards: {
    assetAmount: number;
    baseAmount: number;
  };
  transfer: {
    baseAmount: number;
    assetAmount: number;
    alternateAsset: number;
    collateralAmount: number;
    baseBalanceTransfer: number;
    baseBalanceLarge: number;
    borrowAmountLarge: number;
    collateralBalanceSmall: number;
    collateralBalanceTiny: number;
  };
  withdraw: {
    baseAmount: number;
    alternateBase: number;
    assetAmount: number;
    alternateAsset: number;
    collateralAmount: number;
  };
  supply: {
    collateralAmount: number;
  };
  timing: {
    interestSeconds: number;
  };
  wsteth: {
    supplyCapSmall: number;
    supplyCapMedium: number;
    tokenBalance: number;
    cometBalance: number;
    cometPosition: number;
  };
  maticx: {
    supplyAmount: number;
    baseBorrowMultiplier: number;
    supplyCap: number;
    balanceTolerance: bigint;
    borrowCollateralFactor: number;
    liquidateCollateralFactor: number;
    liquidationFactor: number;
  };
  authorization: {
    expiryOffsetShort: number;
    expiryOffsetLong: number;
    expiryOffsetVeryLong: number;
    expiryOffsetAltered: number;
    expiryPastOffset: number;
    invalidVValue: number;
    maxSValuePlusOne: string;
  };
  configurator: {
    borrowCollateralFactor: number;
    liquidateCollateralFactor: number;
    liquidationFactor: number;
    supplyCap: number;
  };
  governance: {
    delayMultiplier: number;
    secondsPerDay: number;
    timelockDelayDays: number;
    timelockGracePeriodDays: number;
    timelockMinDelayDays: number;
    timelockMaxDelayDays: number;
    newFunctionExpectedValue: bigint;
    minBaseBalance: string;
    basePrice: number;
    baseBorrowMultiplier: bigint;
  };
  dogecoin: {
    totalSupply: number;
    decimals: number;
    price: number;
    allocateAmount: number;
    borrowCollateralFactor: number;
    liquidateCollateralFactor: number;
    liquidationFactor: number;
    supplyCap: number;
  };
  interestRate: {
    utilizationTolerance: number;
    supplyKink: number;
    supplyRateSlopeLow: number;
    supplyRateSlopeHigh: number;
    borrowKink: number;
    borrowRateBase: number;
    borrowRateSlopeLow: number;
    borrowRateSlopeHigh: number;
    utilizationBelowKink: number;
    utilizationAboveKink: number;
    expectedSupplyRateBelowKink: number;
    expectedBorrowRateBelowKink: number;
    expectedSupplyRateAboveKink: number;
    expectedBorrowRateAboveKink: number;
    rateTolerance: number;
    maxBorrowRate: number;
  };
  liquidationBot: {
    targetReserves: number;
    borrowCapacityUtilization: bigint;
    fudgeFactorTime: bigint;
    expectedCollateralReservesThreshold: number;
    flashLoanAmount: number;
    partialLiquidationScaleMultiplier: bigint;
    liquidationThresholdMultiplier: number;
    absorbEventIndex: number;
    absorbWithoutBuyingEventIndex: number;
  };
  liquidationScenario: {
    fudgeFactorLong: bigint;
    fudgeFactorShort: bigint;
    borrowCapacityUtilizationHigh: bigint;
    collateralDivisor: bigint;
    timeAdjustmentMultiplier: number;
  };
  mainnetBulker: {
    stethSupplyAmount: number;
    stethBalanceTolerance: bigint;
    wstethBalanceTolerance: bigint;
    stethWithdrawalTolerance: bigint;
    wstethWithdrawalTolerance: bigint;
    maxStethWithdrawalTolerance: bigint;
    sourceTokenBuffer: bigint;
    invalidAssetIndex: number;
  };
  rewardsScenario: {
    baseSupplyAmount: bigint;
    timeIncrementOneDay: number;
    minTimeDelta: number;
    albertBaseDivisor: bigint;
    compRewardsAmount: number;
    multiplierScale: bigint;
    multipliers: bigint[];
  };

  supplyScenario: {
    baseSupplyAmount: bigint;
    baseSupplyWithFees: bigint;
    baseBorrowWithFees: bigint;
    baseBorrowRepayAmount: bigint;
    baseBalance: bigint;
    baseBalanceMax: bigint;
    baseSupplySmall: bigint;
    baseSupplyAfterFees: bigint;
    usdtFeeBasisPoints: number;
    usdtMaxFee: number;
    usdtRemainingDebt: bigint;
    ethBalanceForGas: string;
    interestToleranceSmall: bigint;
    interestToleranceMedium: bigint;
    interestTimeFactorShort: bigint;
    interestTimeFactorLong: bigint;
    minBorrow: string;
  };
}

const defaultConfig: ScenarioConfig = {
  bulker: {
    standardBase: 1000000,
    wethBase: 10,
    standardAsset: 5000,
    alternateAsset: 5000,
    minimalAsset: 10,
    cometAllocation: 5000,
    borrowBase: 1000,
    borrowAsset: 500,
    supplyAmount: 0.01,
    withdrawAmount: 0.005,
    timeIncrementOneDay: 86400,
    wethBorrowBase: 5n,
    wethTransferBase: 2n,
  },
  liquidation: {
    standardBase: 100000,
    mediumBase: 1000,
    largeBase: 1000,
    tinyBase: 10,
    standardAsset: 200,
    mediumAsset: 1000,
    tinyAsset: 0.001,
    smallAsset: 0.5,
    hundredAsset: 100,
    largeAsset: 5000,
    denominator: 90,
    alternateDenominator: 100,
    numerator: 90,
  },
  rewards: {
    assetAmount: 10000,
    baseAmount: 1000,
  },
  transfer: {
    baseAmount: 1000,
    assetAmount: 5000,
    alternateAsset: 5000,
    collateralAmount: 100,
    baseBalanceTransfer: 1000,
    baseBalanceLarge: 10000,
    borrowAmountLarge: -10000,
    collateralBalanceSmall: 5000,
    collateralBalanceTiny: 1,
  },
  withdraw: {
    baseAmount: 1000,
    alternateBase: 1000,
    assetAmount: 3000,
    alternateAsset: 3000,
    collateralAmount: 100,
  },
  supply: {
    collateralAmount: 100,
  },
  timing: {
    interestSeconds: 110,
  },
  wsteth: {
    supplyCapSmall: 1,
    supplyCapMedium: 2,
    tokenBalance: 2,
    cometBalance: 5,
    cometPosition: 1,
  },
  maticx: {
    supplyAmount: 9000,
    baseBorrowMultiplier: 1000,
    supplyCap: 6_000_000,
    balanceTolerance: 1n,
    borrowCollateralFactor: 0.55,
    liquidateCollateralFactor: 0.60,
    liquidationFactor: 0.93,
  },
  authorization: {
    expiryOffsetShort: 10,
    expiryOffsetLong: 1_000,
    expiryOffsetVeryLong: 10000,
    expiryOffsetAltered: 100,
    expiryPastOffset: 1,
    invalidVValue: 26,
    maxSValuePlusOne: '0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A1',
  },
  configurator: {
    borrowCollateralFactor: 0.9e18,
    liquidateCollateralFactor: 1e18,
    liquidationFactor: 0.95e18,
    supplyCap: 1000000e8,
  },
  governance: {
    delayMultiplier: 2,
    secondsPerDay: 24 * 60 * 60,
    timelockDelayDays: 2,
    timelockGracePeriodDays: 14,
    timelockMinDelayDays: 2,
    timelockMaxDelayDays: 30,
    newFunctionExpectedValue: 101n,
    minBaseBalance: '>= 1000',
    basePrice: 1,
    baseBorrowMultiplier: 1000n,
  },
  dogecoin: {
    totalSupply: 1_000_000,
    decimals: 8,
    price: 1_000,
    allocateAmount: 100,
    borrowCollateralFactor: 0.8,
    liquidateCollateralFactor: 0.85,
    liquidationFactor: 0.95,
    supplyCap: 1_000,
  },
  interestRate: {
    utilizationTolerance: 0.00001,
    supplyKink: 0.8,
    supplyRateSlopeLow: 0.04,
    supplyRateSlopeHigh: 0.4,
    borrowKink: 0.8,
    borrowRateBase: 0.01,
    borrowRateSlopeLow: 0.05,
    borrowRateSlopeHigh: 0.3,
    utilizationBelowKink: 0.5,
    utilizationAboveKink: 0.85,
    expectedSupplyRateBelowKink: 0.02,
    expectedBorrowRateBelowKink: 0.035,
    expectedSupplyRateAboveKink: 0.052,
    expectedBorrowRateAboveKink: 0.065,
    rateTolerance: 0.001,
    maxBorrowRate: 1e18,
  },
  liquidationBot: {
    targetReserves: 20_000,
    borrowCapacityUtilization: 90n,
    fudgeFactorTime: 60n * 10n,
    expectedCollateralReservesThreshold: 1,
    flashLoanAmount: 10e6,
    partialLiquidationScaleMultiplier: 10n,
    liquidationThresholdMultiplier: 1_000_000,
    absorbEventIndex: 3,
    absorbWithoutBuyingEventIndex: 4,
  },
  liquidationScenario: {
    fudgeFactorLong: 6000n * 6000n,
    fudgeFactorShort: 60n * 10n,
    borrowCapacityUtilizationHigh: 90n,
    collateralDivisor: 1000n,
    timeAdjustmentMultiplier: 1.001,
  },
  mainnetBulker: {
    stethSupplyAmount: 0.1,
    stethBalanceTolerance: 2n,
    wstethBalanceTolerance: 1n,
    stethWithdrawalTolerance: 3n,
    wstethWithdrawalTolerance: 1n,
    maxStethWithdrawalTolerance: 2n,
    sourceTokenBuffer: 3n,
    invalidAssetIndex: -1,
  },
  rewardsScenario: {
    baseSupplyAmount: 100n,
    timeIncrementOneDay: 86400,
    minTimeDelta: 86400,
    albertBaseDivisor: 10n,
    compRewardsAmount: 100,
    multiplierScale: exp(1, 18),
    multipliers: [
      exp(55, 18),
      exp(10, 18),
      exp(1, 18),
      exp(0.01, 18),
      exp(0.00355, 18)
    ],
  },
  supplyScenario: {
    baseSupplyAmount: 100n,
    baseSupplyWithFees: 1000n,
    baseBorrowWithFees: -1000n,
    baseBorrowRepayAmount: -999n,
    baseBalance: 1010n,
    baseBalanceMax: 10n,
    baseSupplySmall: 10n,
    baseSupplyAfterFees: 999n,
    usdtFeeBasisPoints: 10,
    usdtMaxFee: 10,
    usdtRemainingDebt: -1n,
    ethBalanceForGas: '100',
    interestToleranceSmall: 1n,
    interestToleranceMedium: 2n,
    interestTimeFactorShort: 1n,
    interestTimeFactorLong: 4n,
    minBorrow: '<= -1000',
  },
};

export function getConfigForScenario(ctx: CometContext): ScenarioConfig {
  const config = JSON.parse(JSON.stringify(defaultConfig)) as ScenarioConfig;

  if (ctx.world.base.network === 'mainnet' && ctx.world.base.deployment === 'wbtc') {
    config.bulker.standardBase = 200;
    config.bulker.standardAsset = 400;
    config.bulker.alternateAsset = 400;
    config.bulker.cometAllocation = 200;
    config.bulker.borrowBase = 100;
    config.bulker.borrowAsset = 50;
    config.liquidation.standardBase = 1000;
    config.liquidation.mediumBase = 500;
    config.liquidation.standardAsset = 100;
    config.rewards.assetAmount = 100;
    config.rewards.baseAmount = 10;
    config.transfer.baseAmount = 100;
    config.transfer.assetAmount = 500;
    config.transfer.alternateAsset = 500;
    config.withdraw.baseAmount = 100;
    config.withdraw.assetAmount = 200;
    config.timing.interestSeconds = 70;
  }

  if (ctx.world.base.network === 'mainnet' && ctx.world.base.deployment === 'wsteth') {
    config.liquidation.standardBase = 10000;
    config.liquidation.mediumBase = 1000;
    config.liquidation.standardAsset = 100;
    config.liquidation.denominator = 84;
    config.timing.interestSeconds = 70;
  }

  if (ctx.world.base.network === 'mainnet' && ctx.world.base.deployment === 'weth') {
    config.liquidation.numerator = 60;
    config.liquidation.standardBase = 10000;
  }

  if (ctx.world.base.network === 'mainnet' && ctx.world.base.deployment === 'usds') {
    config.liquidation.standardAsset = 100;
  }

  if (ctx.world.base.network === 'base' && ctx.world.base.deployment === 'aero') {
    config.timing.interestSeconds = 110;
  }

  if (ctx.world.base.network === 'base' && ctx.world.base.deployment === 'usds') {
    config.liquidation.largeBase = 100;
    config.liquidation.mediumAsset = 99;
  }

  if (ctx.world.base.network === 'base' && ctx.world.base.deployment === 'weth') {
    config.liquidation.standardBase = 1000;
  }

  if (ctx.world.base.network === 'optimism' && ctx.world.base.deployment === 'weth') {
    config.liquidation.standardBase = 1000;
  }

  if (ctx.world.base.network === 'arbitrum' && ctx.world.base.deployment === 'usdc') {
    config.withdraw.assetAmount = 3500;
  }

  if (ctx.world.base.network === 'arbitrum' && ctx.world.base.deployment === 'usdt') {
    config.withdraw.assetAmount = 3500;
  }

  if (ctx.world.base.network === 'arbitrum' && ctx.world.base.deployment === 'usdc.e') {
    config.withdraw.assetAmount = 7000;
    config.bulker.standardAsset = 10000;
    config.bulker.alternateAsset = 10000;
    config.transfer.assetAmount = 10000;
    config.transfer.alternateAsset = 10000;
    config.liquidation.denominator = 84;
    config.liquidation.standardBase = 100000;
    config.liquidation.mediumBase = 50000;
    config.liquidation.standardAsset = 10000;
  }

  if (ctx.world.base.network === 'arbitrum' && ctx.world.base.deployment === 'weth') {
    config.liquidation.standardBase = 1000;
  }

  if (ctx.world.base.network === 'ronin' && ctx.world.base.deployment === 'weth') {
    config.transfer.baseAmount = 10;
    config.transfer.assetAmount = 200000;
    config.transfer.alternateAsset = 200000;
    config.rewards.assetAmount = 1000000;
    config.rewards.baseAmount = 200;
    config.withdraw.baseAmount = 10;
    config.withdraw.alternateBase = 10;
    config.withdraw.assetAmount = 100000;
    config.withdraw.alternateAsset = 10000;
    config.liquidation.standardBase = 150;
    config.liquidation.mediumBase = 50;
    config.liquidation.standardAsset = 5;
    config.bulker.standardAsset = 100000;
    config.bulker.alternateAsset = 100000;
    config.bulker.cometAllocation = 100;
    config.bulker.borrowBase = 10;
    config.bulker.borrowAsset = 10;
    config.bulker.standardBase = 100;
  }

  if (ctx.world.base.network === 'polygon' && ctx.world.base.deployment === 'usdc') {
    config.bulker.standardAsset = 200;
    config.bulker.alternateAsset = 200;
  }

  if (ctx.world.base.network === 'polygon' && ctx.world.base.deployment === 'usdt') {
    config.withdraw.assetAmount = 10000;
    config.transfer.assetAmount = 500000;
    config.transfer.baseAmount = 100;
  }

  if (ctx.world.base.network === 'scroll' && ctx.world.base.deployment === 'usdc') {
    config.bulker.standardAsset = 200;
    config.bulker.alternateAsset = 200;
  }

  if (ctx.world.base.network === 'sepolia' && ctx.world.base.deployment === 'usdc') {
    config.bulker.alternateAsset = 10;
  }

  if (ctx.world.base.network === 'linea' && ctx.world.base.deployment === 'usdc') {
    config.bulker.standardAsset = 500;
    config.bulker.alternateAsset = 500;
    config.supply.collateralAmount = 10;
    config.transfer.collateralAmount = 10;
    config.withdraw.collateralAmount = 10;    
  }

  if (ctx.world.base.network === 'linea' && ctx.world.base.deployment === 'weth') {
    config.liquidation.standardBase = 1000;
    config.rewards.assetAmount = 1000;
    config.rewards.baseAmount = 50;
    config.supply.collateralAmount = 10;
    config.transfer.collateralAmount = 10;
    config.withdraw.collateralAmount = 10;
  }

  if (ctx.world.base.network === 'unichain' && ctx.world.base.deployment === 'weth') {
    config.liquidation.standardBase = 1000;
    config.liquidation.mediumBase = 350;
    config.liquidation.standardAsset = 100;
    config.bulker.standardAsset = 500;
    config.bulker.cometAllocation = 500;
    config.bulker.borrowBase = 100;
    config.bulker.borrowAsset = 50;
    config.rewards.baseAmount = 100;
    config.rewards.assetAmount = 1000;
    config.transfer.baseAmount = 100;
    config.transfer.assetAmount = 500;
    config.transfer.alternateAsset = 500;
  }

  if (ctx.world.base.network === 'fuji' && ctx.world.base.deployment === 'usdc') {
    config.liquidation.standardAsset = 100;
  }

  return config;
}