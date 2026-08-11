import { BigNumber } from 'ethers';

// Convert all BigNumbers in an array into BigInts
export function convertToBigInt(arr) {
  const newArr = [];
  for (const v of arr) {
    if (Array.isArray(v)) {
      newArr.push(convertToBigInt(v));
    } else {
      newArr.push(v._isBigNumber ? BigInt(v) : v);
    }
  }
  return newArr;
}

export function dfn<T>(x: T | undefined | null, dflt: T): T {
  return x == undefined ? dflt : x;
}
  
export function toBigInt(f: bigint | BigNumber): bigint {
  if (typeof f === 'bigint') {
    return f;
  } else {
    return f.toBigInt();
  }
}