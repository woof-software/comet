const factorScale = BigInt(1e18);
const BASE_INDEX_SCALE = BigInt(1e15);

/**
 * @notice Multiplies a value by a price and normalizes by a scaling factor.
 * @dev Computes (n * price) / fromScale using bigint inputs.
 * @param n The value to scale (bigint)
 * @param price The price to multiply (bigint)
 * @param fromScale The scale to divide by (bigint)
 * @return Scaled value as bigint
 */
export function mulPrice(n: bigint, price: bigint, fromScale: bigint): bigint {
  return n * price / fromScale;
}

export function mulFactor(n: bigint, factor: bigint): bigint {
  return n * factor / factorScale;
}

export function divPrice(n: bigint, price: bigint, toScale: bigint): bigint {
  return n * toScale / price;
}

export function presentValueSupply(baseSupplyIndex: bigint, principalValue: bigint): bigint {
  return principalValue * baseSupplyIndex / BASE_INDEX_SCALE;
}

export function presentValueBorrow(baseBorrowIndex: bigint, principalValue: bigint): bigint {
  return principalValue * baseBorrowIndex / BASE_INDEX_SCALE;
}

export function presentValue(
  principalValue: bigint,
  baseSupplyIndex: bigint,
  baseBorrowIndex: bigint
): bigint {
  if (principalValue >= 0n) {
    return presentValueSupply(baseSupplyIndex, principalValue);
  } else {
    return -presentValueBorrow(baseBorrowIndex, -principalValue);
  }
}

export function principalValueSupply(baseSupplyIndex: bigint, presentValue: bigint): bigint {
  return (presentValue * BASE_INDEX_SCALE) / baseSupplyIndex;
}

export function principalValueBorrow(baseBorrowIndex: bigint, presentValue: bigint): bigint {
  return (presentValue * BASE_INDEX_SCALE + baseBorrowIndex - 1n) / baseBorrowIndex;
}

export function principalValue(
  presentValue: bigint,
  baseSupplyIndex: bigint,
  baseBorrowIndex: bigint
): bigint {
  if (presentValue >= 0n) {
    return principalValueSupply(baseSupplyIndex, presentValue);
  } else {
    return -principalValueBorrow(baseBorrowIndex, -presentValue);
  }
}
