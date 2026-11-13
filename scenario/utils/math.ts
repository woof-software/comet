import { BigNumber } from 'ethers';
import { CometInterface } from '../../build/types';
import CometActor from '../context/CometActor';
import { FACTOR_SCALE, SECONDS_PER_YEAR } from './constants';

export { exp } from '../../test/helpers';

/** Convert a per-year interest factor to per-second (Comet constructor truncation). */
export const perSecond = (perYear: BigNumber): BigNumber => perYear.div(SECONDS_PER_YEAR);

export const max = (...args: bigint[]): bigint => args.reduce((m, e) => (e > m ? e : m));

export const min = (...args: bigint[]): bigint => args.reduce((m, e) => (e < m ? e : m));

export const abs = (x: bigint): bigint => (x < 0n ? -x : x);

export function getExpectedBaseBalance(
  balance: bigint,
  baseIndexScale: bigint,
  borrowOrSupplyIndex: bigint
): bigint {
  const principalValue = (balance * baseIndexScale) / borrowOrSupplyIndex;
  const baseBalanceOf = (principalValue * borrowOrSupplyIndex) / baseIndexScale;
  return baseBalanceOf;
}

export function getInterest(balance: bigint, rate: bigint, seconds: bigint) {
  return (balance * rate * seconds) / 10n ** 18n;
}

/**
 * Estimates how many seconds until a borrower becomes liquidatable, i.e. until interest accrued
 * at the current borrow rate eats up the collateral buffer left above their debt.
 * @param comet Comet market the actor borrows from
 * @param actor Borrower to check
 * @param fudgeFactor Extra seconds added to the result, to land safely past the threshold
 * @returns Seconds until liquidatable, or 0 if the borrower is already underwater
 */
export async function secondsUntilLiquidatable(
  comet: CometInterface,
  actor: CometActor,
  fudgeFactor = 0n
): Promise<number> {
  const [baseBalance, baseScale, basePrice, borrowRate] = await Promise.all([
    actor.getCometBaseBalance(),
    comet.baseScale(),
    comet.baseTokenPriceFeed().then(feed => comet.getPrice(feed)),
    comet.getUtilization().then(utilization => comet.getBorrowRate(utilization)),
  ]);

  // Value of the debt in USD; negative while the account is borrowing
  const baseValue = (baseBalance * basePrice.toBigInt()) / baseScale.toBigInt();
  if (baseValue >= 0n) {
    throw new Error(`${actor.address} has no debt, so it can never become liquidatable`);
  }

  const buffer = await getLiquidationBuffer(comet, actor.address, baseValue);
  if (buffer < 0n) return 0;

  // Each second the debt grows by its value times the per-second borrow rate; divide the buffer by that
  return Number((buffer * FACTOR_SCALE) / (-baseValue * borrowRate.toBigInt()) + fudgeFactor);
}

// Copy of the liquidity sum in Comet's isLiquidatable: base value (negative for debt) plus all collateral values.
// Positive means a buffer left before liquidation, negative means the account is already liquidatable.
async function getLiquidationBuffer(
  comet: CometInterface,
  account: string,
  baseValue: bigint
): Promise<bigint> {
  const numAssets = await comet.numAssets();

  // Start every asset's read at once, then wait for all of them together
  const collateralReads: Promise<bigint>[] = [];
  for (let i = 0; i < numAssets; i++) {
    collateralReads.push(getCollateralLiquidationValue(comet, account, i));
  }

  let buffer = baseValue;
  for (const collateralValue of await Promise.all(collateralReads)) {
    buffer += collateralValue;
  }
  return buffer;
}

// Copy of how Comet's isLiquidatable values one collateral: USD value times the liquidate collateral factor.
// Returns 0 without reading the price when the account holds none of the asset.
async function getCollateralLiquidationValue(
  comet: CometInterface,
  account: string,
  assetIndex: number
): Promise<bigint> {
  const { asset, priceFeed, scale, liquidateCollateralFactor } = await comet.getAssetInfo(assetIndex);

  const balance = await comet.collateralBalanceOf(account, asset);
  if (balance.isZero()) return 0n; // No value if the account holds no of this asset

  const collateralPrice = await comet.getPrice(priceFeed);
  const collateralValue = balance.mul(collateralPrice).div(scale);
  return collateralValue.mul(liquidateCollateralFactor).div(FACTOR_SCALE).toBigInt();
}
