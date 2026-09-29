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
