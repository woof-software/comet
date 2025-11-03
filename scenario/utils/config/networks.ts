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
      config.bulker.base.standard = 200n;
      config.bulker.asset.standard = 400n;
      config.bulker.asset.alternate = 400n;
      config.bulker.cometAllocation = 200n;
      config.bulker.base.borrow = 100n;
      config.bulker.asset.borrow = 50n;
      config.liquidation.base.standard = 1000n;
      config.liquidation.base.medium = 500n;
      config.liquidation.asset.standard = 100n;
      config.rewards.assetAmount = 100n;
      config.rewards.baseAmount = 10n;
      config.transfer.baseAmount = 100n;
      config.transfer.assetAmount = 500n;
      config.withdraw.baseAmount = 100n;
      config.withdraw.assetAmount = 200n;
      config.common.timing.interestSeconds = 70n;
    }

    if (deployment === 'wsteth') {
      config.liquidation.base.standard = 10000n;
      config.liquidation.base.medium = 1000n;
      config.liquidation.asset.standard = 100n;
      config.liquidation.factors.denominator = 84n;
      config.common.timing.interestSeconds = 70n;
    }

    if (deployment === 'weth') {
      config.liquidation.factors.numerator = 60n;
      config.liquidation.base.standard = 10000n;
    }

    if (deployment === 'usds') {
      config.liquidation.asset.standard = 100n;
    }
  }

  if (network === 'base') {
    if (deployment === 'aero') {
      config.common.timing.interestSeconds = 110n;
    }

    if (deployment === 'usds') {
      config.liquidation.base.large = 100n;
      config.liquidation.asset.medium = 99n;
    }

    if (deployment === 'weth') {
      config.liquidation.base.standard = 1000n;
    }
  }

  if (network === 'optimism') {
    if (deployment === 'usdc' || deployment === 'usdt') {
      config.withdraw.alternateAsset = 3000n;
    }
    
    if (deployment === 'weth') {
      config.liquidation.base.standard = 1000n;
    }
  }

  if (network === 'arbitrum') {
    if (deployment === 'usdc' || deployment === 'usdt') {
      config.withdraw.assetAmount = 3500n;
      config.bulker.base.borrow = 100n;
      config.bulker.asset.borrow = 50n;
      config.withdraw.baseAmount = 100n;    
      config.transfer.baseAmount = 100n;
    }

    if (deployment === 'usdc.e') {
      config.withdraw.assetAmount = 7000n;
      config.withdraw.alternateAsset = 10000n;
      config.bulker.asset.standard = 10000n;
      config.bulker.asset.alternate = 10000n;
      config.transfer.assetAmount = 10000n;
      config.liquidation.factors.denominator = 84n;
      config.liquidation.base.standard = 100000n;
      config.liquidation.base.medium = 50000n;
      config.liquidation.asset.standard = 10000n;
    }

    if (deployment === 'weth') {
      config.liquidation.base.standard = 1000n;
    }
  }

  if (network === 'ronin' && deployment === 'weth') {
    config.transfer.baseAmount = 10n;
    config.transfer.assetAmount = 200000n;
    config.rewards.assetAmount = 1000000n;
    config.rewards.baseAmount = 200n;
    config.withdraw.baseAmount = 10n;
    config.withdraw.alternateBase = 10n;
    config.withdraw.assetAmount = 100000n;
    config.withdraw.alternateAsset = 10000n;
    config.liquidation.base.standard = 150n;
    config.liquidation.base.medium = 50n;
    config.liquidation.asset.standard = 5n;
    config.bulker.asset.standard = 100000n;
    config.bulker.asset.alternate = 100000n;
    config.bulker.cometAllocation = 100n;
    config.bulker.base.borrow = 10n;
    config.bulker.asset.borrow = 10n;
    config.bulker.base.standard = 100n;
  }

  if (network === 'polygon') {
    if (deployment === 'usdc') {
      config.bulker.asset.standard = 200n;
      config.bulker.asset.alternate = 200n;
    }

    if (deployment === 'usdt') {
      config.withdraw.assetAmount = 10000n;
      config.transfer.assetAmount = 500000n;
      config.transfer.baseAmount = 100n;
    }
  }

  if (network === 'scroll' && deployment === 'usdc') {
    config.bulker.asset.standard = 200n;
    config.bulker.asset.alternate = 200n;
  }

  if (network === 'sepolia' && deployment === 'usdc') {
    config.bulker.asset.alternate = 10n;
  }

  if (network === 'linea') {
    if (deployment === 'usdc') {
      config.bulker.asset.standard = 500n;
      config.bulker.asset.alternate = 500n;
      config.supply.collateralAmount = 10n;
      config.transfer.collateralAmount = 10n;
      config.withdraw.collateralAmount = 10n;
    }

    if (deployment === 'weth') {
      config.liquidation.base.standard = 1000n;
      config.rewards.assetAmount = 1000n;
      config.rewards.baseAmount = 50n;
      config.supply.collateralAmount = 10n;
      config.transfer.collateralAmount = 10n;
      config.withdraw.collateralAmount = 10n;
    }
  }

  if (network === 'unichain' && deployment === 'weth') {
    config.liquidation.base.standard = 1000n;
    config.liquidation.base.medium = 350n;
    config.liquidation.asset.standard = 100n;
    config.bulker.asset.standard = 500n;
    config.bulker.cometAllocation = 500n;
    config.bulker.base.borrow = 100n;
    config.bulker.asset.borrow = 50n;
    config.rewards.baseAmount = 100n;
    config.rewards.assetAmount = 1000n;
    config.transfer.baseAmount = 100n;
    config.transfer.assetAmount = 500n;
  }

  if (network === 'fuji' && deployment === 'usdc') {
    config.liquidation.asset.standard = 100n;
  }

  return config;
}