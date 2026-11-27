import { BigNumber } from 'ethers';

const factorScale = BigInt(1e18);
const BASE_INDEX_SCALE = BigInt(1e15);

function toBigInt(f: bigint | BigNumber): bigint {
  if (typeof f === 'bigint') {
    return f;
  } else {
    return BigNumber.from(f).toBigInt();
  }
}

/**
 * @notice Multiplies a value by a price and normalizes by a scaling factor.
 * @dev Computes (n * price) / fromScale using bigint or BigNumber inputs.
 * @param n The value to scale (bigint or BigNumber)
 * @param price The price to multiply (bigint or BigNumber)
 * @param fromScale The scale to divide by (bigint or BigNumber)
 * @return Scaled value as bigint
 */
export function mulPrice(n: bigint | BigNumber, price: bigint | BigNumber, fromScale: bigint | BigNumber): bigint {
  return toBigInt(n) * toBigInt(price) / toBigInt(fromScale);
}

export function mulFactor(n: bigint | BigNumber, factor: bigint | BigNumber): bigint {
  return toBigInt(n) * toBigInt(factor) / factorScale;
}

export function divPrice(n: bigint | BigNumber, price: bigint | BigNumber, toScale: bigint | BigNumber): bigint {
  return toBigInt(n) * toBigInt(toScale) / toBigInt(price);
}

export function presentValueSupply(baseSupplyIndex: bigint | BigNumber, principalValue: bigint | BigNumber): bigint {
  return toBigInt(principalValue) * toBigInt(baseSupplyIndex) / BASE_INDEX_SCALE;
}

export function presentValueBorrow(baseBorrowIndex: bigint | BigNumber, principalValue: bigint | BigNumber): bigint {
  return toBigInt(principalValue) * toBigInt(baseBorrowIndex) / BASE_INDEX_SCALE;
}

export function presentValue(
  principalValue: bigint | BigNumber,
  baseSupplyIndex: bigint | BigNumber,
  baseBorrowIndex: bigint | BigNumber
): bigint {
  if (toBigInt(principalValue) >= 0n) {
    return presentValueSupply(baseSupplyIndex, principalValue);
  } else {
    return -presentValueBorrow(baseBorrowIndex, -principalValue);
  }
}

export function principalValueSupply(baseSupplyIndex: bigint | BigNumber, presentValue: bigint | BigNumber): bigint {
  return (toBigInt(presentValue) * BASE_INDEX_SCALE) / toBigInt(baseSupplyIndex);
}

export function principalValueBorrow(baseBorrowIndex: bigint | BigNumber, presentValue: bigint | BigNumber): bigint {
  return (toBigInt(presentValue) * BASE_INDEX_SCALE + toBigInt(baseBorrowIndex) - 1n) / toBigInt(baseBorrowIndex);
}

export function principalValue(
  presentValue: bigint | BigNumber,
  baseSupplyIndex: bigint | BigNumber,
  baseBorrowIndex: bigint | BigNumber
): bigint {
  if (toBigInt(presentValue) >= 0n) {
    return principalValueSupply(baseSupplyIndex, presentValue);
  } else {
    return -principalValueBorrow(baseBorrowIndex, -presentValue);
  }
}

export type Numeric = number | bigint;

export function exp(i: number, d: Numeric = 0, r: Numeric = 6): bigint {
  const sign = i < 0 ? -1n : 1n;
  const parts = Math.abs(i).toString().split('.');
  const intPart = parts[0];
  const fracPart = (parts[1] || '').padEnd(Number(r), '0').slice(0, Number(r));
  const scaled = BigInt(intPart + fracPart);
  return sign * (scaled * 10n ** BigInt(d)) / 10n ** BigInt(r);
}

// Division rounded towards infinity rather than towards zero.
export function ceilDiv(a: bigint | BigNumber, b: bigint | BigNumber): bigint {
  const numerator = toBigInt(a);
  const denominator = toBigInt(b);

  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

export function factor(f: number): bigint {
  return exp(f, 18);
}

export function defactor(f: bigint | BigNumber): number {
  return Number(toBigInt(f)) / 1e18;
}

// Truncates a factor to a certain number of decimals
export function truncateDecimals(factor: bigint | BigNumber, decimals = 4) {
  const descaleFactor = exp(1, 18) / exp(1, decimals);
  return (toBigInt(factor) / descaleFactor) * descaleFactor;
}

// Division rounded towards zero, the floor counterpart of ceilDiv. Pass the whole product on each
// side: the contracts value a weighted balance in a single division, and splitting it truncates the
// balance at every step, losing a unit of value each time.
export function mulDiv(numerator: bigint | BigNumber, denominator: bigint | BigNumber): bigint {
  return toBigInt(numerator) / toBigInt(denominator);
}

export function annualize(n: bigint | BigNumber, secondsPerYear = 31536000n): number {
  return defactor(toBigInt(n) * secondsPerYear);
}

export function toYears(seconds: number, secondsPerYear = 31536000): number {
  return seconds / secondsPerYear;
}
