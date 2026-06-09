import { BigNumber } from 'ethers';
import { toBigInt } from './cast';

export type Numeric = number | bigint;

export function exp(i: number, d: Numeric = 0, r: Numeric = 6): bigint {
  const sign = i < 0 ? -1n : 1n;
  const parts = Math.abs(i).toString().split('.');
  const intPart = parts[0];
  const fracPart = (parts[1] || '').padEnd(Number(r), '0').slice(0, Number(r));
  const scaled = BigInt(intPart + fracPart);
  return sign * (scaled * 10n ** BigInt(d)) / 10n ** BigInt(r);
}

export function mulFactor(n: bigint | BigNumber, factor: bigint | BigNumber):bigint {
  return toBigInt(n) * toBigInt(factor) / exp(1, 18);
}

export function divPrice(n: bigint | BigNumber, price: bigint | BigNumber, toScale: bigint | BigNumber): bigint {
  return toBigInt(n) * toBigInt(toScale) / toBigInt(price);
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

export function mulPrice(n: bigint | BigNumber, price: bigint | BigNumber, fromScale: bigint | BigNumber): bigint {
  return toBigInt(n) * toBigInt(price) / toBigInt(fromScale);
}

export function annualize(n: bigint | BigNumber, secondsPerYear = 31536000n): number {
  return defactor(toBigInt(n) * secondsPerYear);
}

export function toYears(seconds: number, secondsPerYear = 31536000): number {
  return seconds / secondsPerYear;
}