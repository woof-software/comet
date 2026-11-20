import { FaucetToken } from '../../build/types';
import { CometContext } from '../context/CometContext';

const defaultConfig = {
  bulkerBase: 1000000,
  bulkerBase1: 10,
  bulkerAsset: 5000,
  bulkerAsset1: 5000,
  bulkerAsset2: 10,
  bulkerComet: 5000,
  bulkerBorrowBase: 1000,
  bulkerBorrowAsset: 500,
  liquidationBase: 100000,
  liquidationBase1: 1000,
  liquidationBase2: 1000,
  liquidationAsset: 200,
  liquidationAsset1: 1000,
  liquidationDenominator: 90,
  liquidationDenominator1: 100,
  liquidationNumerator: 90,
  rewardsAsset: 10000,
  rewardsBase: 1000,
  transferBase: 1000,
  transferAsset: 5000,
  transferAsset1: 5000,
  transferAsset2: 50,
  interestSeconds: 110,
  withdrawBase: 1000,
  withdrawAsset: 3000,
  withdrawBase1: 1000,
  withdrawAsset1: 3000,
  withdrawCollateral: 100,
  transferCollateral: 100,
  supplyCollateral: 100,
  supplyBase: 1000,
  reservesBase: 5000,
};

export function getConfigForScenario(ctx: CometContext, i?: number) {
  const config = { ...defaultConfig };
  if (ctx.world.base.network === 'mainnet' && ctx.world.base.deployment === 'wbtc') {
    config.bulkerBase = 50;
    config.bulkerAsset = 200;
    config.bulkerAsset1 = 200;
    config.bulkerComet = 50;
    config.bulkerBorrowBase = 25;
    config.withdrawBase = 25;
    config.withdrawAsset = 200;
    config.bulkerBorrowAsset = 50;
    config.liquidationBase = 1000;
    config.liquidationBase1 = 500;
    config.liquidationAsset = 100;
    config.rewardsAsset = 100;
    config.rewardsBase = 10;
    config.transferBase = 100;
    config.transferAsset = 500;
    config.transferAsset1 = 500;
    config.interestSeconds = 70;
  }

  if (ctx.world.base.network === 'mainnet' && ctx.world.base.deployment === 'wsteth') {
    config.liquidationBase = 10000;
    config.liquidationBase1 = 1000;
    config.liquidationAsset = 100;
    config.liquidationDenominator = 84;
    config.interestSeconds = 70;
  }

  if (ctx.world.base.network === 'mainnet' && ctx.world.base.deployment === 'weth') {
    config.liquidationNumerator = 60;
    config.liquidationBase = 10000;
  }

  if (ctx.world.base.network === 'mainnet' && ctx.world.base.deployment === 'usds') {
    config.liquidationAsset = 100;
  }

  if (ctx.world.base.network === 'mainnet' && ctx.world.base.deployment === 'usdc') {
    config.bulkerBase = 1000;
    config.bulkerAsset = 100;
    config.bulkerComet = 500;
    config.bulkerBorrowBase = 101;
    config.bulkerBorrowAsset = 1;
  }

  if (ctx.world.base.network === 'mainnet' && ctx.world.base.deployment === 'usdt') {
    if(i == 12) {
      config.supplyCollateral = 0;
      config.transferCollateral = 0;
      config.withdrawCollateral = 0;
    }
  }

  if (ctx.world.base.network === 'base' && ctx.world.base.deployment === 'aero') {
    config.interestSeconds = 110;
  }

  if (ctx.world.base.network === 'base' && ctx.world.base.deployment === 'usdc') {
    if(i == 4) {
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    }
  }

  if (ctx.world.base.network === 'base' && ctx.world.base.deployment === 'usdbc') {
    config.bulkerBase = 100000;
  }

  if (ctx.world.base.network === 'base' && ctx.world.base.deployment === 'usds') {
    config.liquidationBase2 = 100;
    config.liquidationAsset1 = 99;
  }

  if (ctx.world.base.network === 'base' && ctx.world.base.deployment === 'weth') {
    config.liquidationBase = 1000;
    if(i == 1) { // ezETH
      config.withdrawBase = 10;
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    } 

    if(i == 7) { // oETH
      config.withdrawBase = 1;
    }
  }

  if (ctx.world.base.network === 'optimism' && ctx.world.base.deployment === 'usdc') {
    config.bulkerAsset = 100000;
    config.bulkerAsset1 = 100000;
    config.transferAsset = 100000;
    config.transferAsset1 = 100000;
    config.rewardsAsset = 100000;
    config.withdrawAsset = 100000;
    if(i == 4) { // wUSDM
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    }
  }

  if (ctx.world.base.network === 'optimism' && ctx.world.base.deployment === 'usdt') {
    config.withdrawAsset = 100000;
    config.transferAsset = 100000;
    config.transferAsset1 = 100000;
    config.rewardsAsset = 100000;
    config.bulkerAsset = 200000;
    config.withdrawAsset = 140000;
  }

  if (ctx.world.base.network === 'optimism' && ctx.world.base.deployment === 'weth') {
    config.bulkerBorrowBase = 5;
    config.bulkerBorrowAsset = 5;
    config.bulkerComet = 100000;
    config.liquidationBase = 1000;
    config.withdrawBase = 20;
    config.rewardsBase = 20;
    config.liquidationBase = 20;
    config.supplyBase = 20;
    config.transferBase = 20;
    config.withdrawBase1 = 20;
    if(i == 5) { // ezETH
      config.withdrawBase = 10;
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    }
    if(i == 6) { // weETH
      config.withdrawBase = 10;
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    }
    if(i == 7) { // wrsETH
      config.withdrawBase = 10;
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    }
  }

  if (ctx.world.base.network === 'arbitrum' && ctx.world.base.deployment === 'usdc') {
    config.bulkerAsset = 100000;
    config.bulkerAsset1 = 100000;
    config.rewardsAsset = 200000;
    config.withdrawAsset = 200000;
    config.transferAsset = 500000;
    config.transferAsset1 = 500000;
    config.transferBase = 100;
    config.rewardsBase = 100;
    config.withdrawBase = 100;
    if(i == 5) { // ezETH
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    }
    if(i == 7) { // tETH
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    }
    if(i == 8) { // tBTC
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    }
  }

  if (ctx.world.base.network === 'arbitrum' && ctx.world.base.deployment === 'usdt') {
    config.rewardsAsset = 200000;
    config.withdrawAsset = 200000;
    config.bulkerAsset = 100000;
    config.bulkerAsset1 = 10000;
    config.transferAsset = 100000;
    config.transferAsset1 = 100000;
    if(i == 5) { // tBTC
      config.supplyCollateral = 1;
      config.transferCollateral = 1;
      config.withdrawCollateral = 1;
    }
    if(i == 6) { // tETH
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    }
  }

  if (ctx.world.base.network === 'arbitrum' && ctx.world.base.deployment === 'usdc.e') {
    config.rewardsAsset = 200000;
    config.withdrawAsset = 200000;
    config.bulkerBase = 100000;
    config.bulkerAsset = 100000;
    config.bulkerAsset1 = 100000;
    config.transferAsset = 500000;
    config.transferAsset1 = 500000;
    config.liquidationDenominator = 84;
    config.liquidationBase = 100000;
    config.liquidationBase1 = 50000;
    config.liquidationAsset = 10000;
  }

  if (ctx.world.base.network === 'arbitrum' && ctx.world.base.deployment === 'weth') {
    config.liquidationBase = 2;
    config.liquidationAsset = 10;
    config.bulkerBorrowBase = 100;
    config.withdrawBase = 2;
    config.rewardsAsset = 10;
    if(i == 7) { // ezETH
      config.withdrawBase = 10;
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    }
    if(i == 8) { // tETH
      config.withdrawBase = 10;
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    }
  }

  if (ctx.world.base.network === 'ronin' && ctx.world.base.deployment === 'weth') {
    config.supplyBase = 100;
    config.transferBase = 10;
    config.transferAsset = 4000000;
    config.transferAsset1 = 800000;
    config.rewardsAsset = 1000000;
    config.rewardsBase = 200;
    config.withdrawBase = 10;
    config.withdrawBase1 = 50;
    config.withdrawAsset = 4000000;
    config.withdrawAsset1 = 4000000;
    config.liquidationBase = 200;
    config.liquidationBase1 = 50;
    config.liquidationAsset = 6;
    config.bulkerAsset = 100000;
    config.bulkerAsset1 = 100000;
    config.bulkerComet = 100;
    config.bulkerBorrowBase = 10;
    config.bulkerBorrowAsset = 10;
    config.bulkerBase = 100;
  }

  if (ctx.world.base.network === 'polygon' && ctx.world.base.deployment === 'usdc') {
    config.bulkerAsset = 200;
    config.bulkerAsset1 = 200;
  }

  if (ctx.world.base.network === 'polygon' && ctx.world.base.deployment === 'usdt') {
    config.withdrawAsset = 20000;
    config.withdrawBase = 100;
    config.transferAsset = 10000000;
    config.transferBase = 100;
    config.rewardsAsset = 10000000;
    config.rewardsBase = 1000;
  }

  if (ctx.world.base.network === 'scroll' && ctx.world.base.deployment === 'usdc') {
    config.bulkerAsset = 200;
    config.bulkerAsset1 = 50;
    config.liquidationBase = 1000;
    config.liquidationAsset = 2;
    if(i == 1) { // tBTC
      config.supplyCollateral = 10;
      config.transferCollateral = 10;
      config.withdrawCollateral = 10;
    }
  }

  if(ctx.world.base.network === 'mantle' && ctx.world.base.deployment === 'usde') {
    if(i == 2) { // FBTC
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    }
  }

  if (ctx.world.base.network === 'linea' && ctx.world.base.deployment === 'usdc') {
    config.bulkerAsset = 10;
    config.bulkerAsset1 = 15;
    config.supplyCollateral = 10;
    config.transferCollateral = 10;
    config.withdrawCollateral = 10;    
  }

  if (ctx.world.base.network === 'linea' && ctx.world.base.deployment === 'weth') {
    config.liquidationBase = 1000;
    config.transferAsset1 = 2000;
    config.rewardsAsset = 1000;
    config.rewardsBase = 50;
    config.supplyCollateral = 10;
    config.transferCollateral = 10;
    config.withdrawCollateral = 10;
  }

  if (ctx.world.base.network === 'unichain' && ctx.world.base.deployment === 'weth') {
    config.liquidationBase = 250;
    config.liquidationBase1 = 350;
    config.liquidationAsset = 100;
    config.bulkerAsset = 100;
    config.bulkerComet = 100;
    config.bulkerBorrowBase = 100;
    config.bulkerBorrowAsset = 50;
    config.supplyCollateral = 10;
    config.transferCollateral = 10;
    config.withdrawCollateral = 10;
    if(i == 5) { // rsETH
      config.supplyCollateral = 2;
      config.transferCollateral = 2;
      config.withdrawCollateral = 2;
    }
    config.rewardsBase = 100;
    config.rewardsAsset = 250;
    config.transferBase = 100;
    config.transferAsset = 500;
    config.transferAsset1 = 500;
  }

  return config;
}

/// Amount of collateral (in whole units) the bulker scenarios supply for the asset at the given index
export function getBulkerCollateralAmount(ctx: CometContext, index: number) {
  const config = getConfigForScenario(ctx, index);
  return index === 1 ? config.bulkerAsset1 : config.bulkerAsset;
}

/**
 * @notice Deploys an ERC20 token that is not listed in the market, for scenarios that expect Comet to reject it
 */
export async function deployUnsupportedAsset(ctx: CometContext): Promise<FaucetToken> {
  return await ctx.world.deploymentManager.deploy(
    'unsupportedAsset',
    'test/FaucetToken.sol',
    [0, 'Unsupported Asset', 18, 'UNSUPPORTED']
  ) as FaucetToken;
}

// returns asset of collateral, supply amount, and borrow amount
// borrow amount is 1.5 times the market's minimum borrow, or $100 of base when that minimum is worth less than $10.
export async function getMinimumBorrowAmounts(context: CometContext, collateralIndex: number) {
  const comet = await context.getComet();
  const baseScale = (await comet.baseScale()).toBigInt();
  const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
  const priceScale = (await comet.priceScale()).toBigInt();
  const factorScale = (await comet.factorScale()).toBigInt();

  // baseBorrowMin is an amount of the base token, not USD. Some markets set it to almost nothing (1 wei of USDC),
  // which makes a meaningless borrow, so below $10 borrow $100 worth of base instead.
  const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
  const baseBorrowMinUsd = (baseBorrowMin * basePrice) / baseScale;
  const borrowAmount = baseBorrowMinUsd < 10n * priceScale
    ? (100n * priceScale * baseScale) / basePrice
    : (baseBorrowMin * 3n) / 2n;

  const {
    asset: collateralAddress,
    priceFeed: collateralPriceFeed,
    scale: collateralScaleBN,
    borrowCollateralFactor
  } = await comet.getAssetInfo(collateralIndex);
  const collateralAsset = context.getAssetByAddress(collateralAddress);
  const collateralScale = collateralScaleBN.toBigInt();
  const collateralPrice = (await comet.getPrice(collateralPriceFeed)).toBigInt();

  let supplyAmount = (borrowAmount * basePrice * collateralScale) / (baseScale * collateralPrice);
  supplyAmount = (supplyAmount * factorScale) / borrowCollateralFactor.toBigInt();
  supplyAmount = (supplyAmount * 11n) / 10n;

  return { collateralAsset, supplyAmount, borrowAmount };
}
