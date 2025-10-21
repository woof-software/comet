import { exp } from '../../../test/helpers';
import { LiquidationBotConfig } from './types';

export const liquidationBotConfig: LiquidationBotConfig = {
  targetReserves: 20_000n,
  borrowCapacityUtilization: 90n,
  fudgeFactorTime: 60n * 10n,
  expectedCollateralReservesThreshold: 1n,
  flashLoanAmount: 10_000_000n,
  partialLiquidationScaleMultiplier: 10n,
  liquidationThresholdMultiplier: 1_000_000n,
  absorbEventIndex: 3n,
  absorbWithoutBuyingEventIndex: 4n,
  scenario: {
    fudgeFactorLong: 6000n * 6000n,
    fudgeFactorShort: 60n * 10n,
    borrowCapacityUtilizationHigh: 90n,
    collateralDivisor: 1000n,
    timeAdjustmentMultiplier: exp(1.001, 18),
  },
};