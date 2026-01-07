import { ScenarioConfig } from './types';
import { CometContext } from '../../context/CometContext';

export function applyNetworkOverrides(
  config: ScenarioConfig,
  ctx: CometContext
): ScenarioConfig {
  const network = ctx?.world?.base?.network;
  const deployment = ctx?.world?.base?.deployment;

  if (!network || !deployment) {
    return config;
  }

  if (network === 'mainnet') {
    if (deployment === 'wbtc') {
      config.bulker.base.supply = 2n;
      config.bulker.asset.supply = 100n;
      config.bulker.asset.supplyAlternate = 100n;
      config.bulker.cometAllocation = 200n;
      config.bulker.base.borrow = 2n;
      config.bulker.asset.borrow = 2n;
      config.liquidation.base.borrowPrincipal = 1000n;
      config.liquidation.base.undercollateralized = 500n;
      config.liquidation.asset.supplyAmount = 100n;
      config.rewards.assetAmount = 100n;
      config.rewards.baseAmount = 10n;
      config.transfer.baseAmount = 100n;
      config.transfer.assetAmount = 500n;
      config.withdraw.baseAmount = 10n;
      config.withdraw.assetAmount = 20n;
      config.common.timing.interestSeconds = 70n;
      config.common.cometBalances.base = 2n;
    }

    if (deployment === 'wsteth') {
      config.liquidation.base.borrowPrincipal = 10000n;
      config.liquidation.base.undercollateralized = 1000n;
      config.liquidation.asset.supplyAmount = 100n;
      config.liquidation.factors.denominator = 84n;
      config.common.timing.interestSeconds = 70n;
    }

    if (deployment === 'weth') {
      config.liquidation.factors.numerator = 60n;
      config.liquidation.base.borrowPrincipal = 10000n;
    }

    if (deployment === 'usds') {
      config.liquidation.asset.supplyAmount = 100n;
    }

    if (deployment === 'usdt') {
      config.liquidation.base.undercollateralized = 1000n;
      config.liquidation.base.borrowPrincipal = 1000n; 
      config.liquidation.asset.smallPosition = 4;
      config.liquidation.asset.supplyAmount = 100n;
    }
  }

  if (network === 'base') {
    if (deployment === 'aero') {
      config.common.timing.interestSeconds = 110n;
    }

    if (deployment === 'usdc') {
      config.supply.collateralAmount = 4n;
      config.transfer.collateralAmount = 4n;
      config.withdraw.collateralAmount = 4n;
      config.rewards.assetAmount = 4n;
      config.rewards.baseAmount = 4n;
    }

    if (deployment === 'weth') {
      config.liquidation.base.borrowPrincipal = 1000n;
      config.common.cometBalances.base = 2n;
      config.rewards.assetAmount = 4n;
      config.rewards.baseAmount = 4n;
    }

    if (deployment === 'usdbc') {
      config.rewards.assetAmount = 4n;
    }
  }

  if (network === 'optimism') {
    if (deployment === 'weth') {
      config.liquidation.base.borrowPrincipal = 1000n;
      config.supply.collateralAmount = 4n;
      config.transfer.collateralAmount = 4n;
      config.transfer.baseAmount = 2n;
      config.withdraw.collateralAmount = 4n;
      config.common.cometBalances.collateral.asset0CometBalance = 4n;
    }

    if (deployment === 'usdc' || deployment === 'usdt') {
      config.bulker.base.borrow = 2n;
      config.common.cometBalances.collateral.asset0CometBalance = 20000n;
      config.transfer.assetAmount = 10000n;
      config.withdraw.assetAmount = 10000n;
    }
  }

  if (network === 'arbitrum') {
    if (deployment === 'usdc' || deployment === 'usdt') {
      config.withdraw.assetAmount = 3500n;
      config.withdraw.baseAmount = 100n;
      config.bulker.base.borrow = 2n;
      config.supply.collateralAmount = 4n;
      config.transfer.collateralAmount = 4n;
      config.withdraw.collateralAmount = 4n;
      config.common.cometBalances.collateral.asset0CometBalance = 20000n;
      config.transfer.assetAmount = 10000n;
    }

    if (deployment === 'usdc.e') {
      config.withdraw.assetAmount = 17000n;
      config.bulker.asset.supply = 10000n;
      config.bulker.asset.supplyAlternate = 10000n;
      config.bulker.base.borrow = 100n;
      config.transfer.assetAmount = 10000n;
      config.common.cometBalances.collateral.asset0CometBalance = 20000n;
      config.liquidation.factors.denominator = 84n;
      config.liquidation.base.borrowPrincipal = 100000n;
      config.liquidation.base.undercollateralized = 50000n;
      config.liquidation.asset.supplyAmount = 10000n;
    }

    if (deployment === 'weth') {
      config.liquidation.base.borrowPrincipal = 1000n;
      config.supply.collateralAmount = 4n;
      config.transfer.collateralAmount = 4n;
      config.withdraw.collateralAmount = 4n;
    }
  }

  if (network === 'ronin' && deployment === 'weth') {
    config.transfer.baseAmount = 4n;
    config.transfer.assetAmount = 200000n;
    config.transfer.collateralAmount = 4n;
    config.rewards.assetAmount = 1000000n;
    config.rewards.baseAmount = 200n;
    config.withdraw.baseAmount = 4n;
    config.withdraw.alternateBase = 10n;
    config.withdraw.assetAmount = 200000n;
    config.withdraw.alternateAsset = 100000n;
    config.liquidation.base.borrowPrincipal = 150n;
    config.liquidation.base.undercollateralized = 50n;
    config.liquidation.asset.supplyAmount = 5000n;
    config.bulker.asset.supply = 100000n;
    config.bulker.asset.supplyAlternate = 100000n;
    config.bulker.cometAllocation = 100n;
    config.bulker.base.borrow = 10n;
    config.bulker.asset.borrow = 10n;
    config.bulker.base.supply = 100n;
    config.supply.baseBalance = 2n;
    config.common.cometBalances.base = 4n;
    config.common.cometBalances.collateral.asset0CometBalance = 200000n;
  }

  if (network === 'polygon') {
    if (deployment === 'usdc') {
      config.bulker.asset.supply = 200n;
      config.bulker.asset.supplyAlternate = 200n;
    }

    if (deployment === 'usdt') {
      config.withdraw.assetAmount = 20000n;
      config.withdraw.baseAmount = 100n;
      config.transfer.assetAmount = 500000n;
      config.transfer.baseAmount = 100n;
      config.rewards.assetAmount = 20000n;
      config.rewards.baseAmount = 1000n;
      config.bulker.asset.supply = 200n;
      config.bulker.asset.supplyAlternate = 200n;
    }
  }

  if (network === 'scroll' && deployment === 'usdc') {
    config.bulker.asset.supply = 50n;
    config.bulker.asset.supplyAlternate = 50n;
    config.liquidationBot.scenario.borrowCapacityUtilizationHigh = 10n;
  }

  if (network === 'sepolia' && deployment === 'usdc') {
    config.bulker.asset.supplyAlternate = 10n;
  }

  if (network === 'linea') {
    if (deployment === 'usdc') {
      config.bulker.asset.supply = 500n;
      config.bulker.asset.supplyAlternate = 500n;
      config.supply.collateralAmount = 10n;
      config.transfer.collateralAmount = 10n;
      config.withdraw.collateralAmount = 10n;
      config.liquidationBot.scenario.borrowCapacityUtilizationHigh = 10n;
    }

    if (deployment === 'weth') {
      config.liquidation.base.borrowPrincipal = 1000n;
      config.rewards.assetAmount = 1000n;
      config.rewards.baseAmount = 50n;
      config.supply.collateralAmount = 10n;
      config.transfer.collateralAmount = 10n;
      config.withdraw.collateralAmount = 10n;
    }
  }

  if (network === 'unichain') {
    if (deployment === 'weth') {
      config.liquidation.base.borrowPrincipal = 10000n;
      config.liquidation.base.undercollateralized = 350n;
      config.liquidation.asset.supplyAmount = 250n;
      config.bulker.asset.supply = 500n;
      config.bulker.cometAllocation = 500n;
      config.bulker.base.borrow = 100n;
      config.bulker.asset.borrow = 50n;
      config.rewards.baseAmount = 100n;
      config.rewards.assetAmount = 1000n;
      config.transfer.baseAmount = 100n;
      config.transfer.assetAmount = 500n;
    }

    if (deployment === 'usdc') {
      config.liquidation.base.borrowPrincipal = 100000n;
      config.liquidationBot.scenario.fudgeFactorLong = 600n * 600n;
    }
  }

  if (network === 'fuji' && deployment === 'usdc') {
    config.liquidation.asset.supplyAmount = 100n;
  }

  return config;
}