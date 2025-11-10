import { BigNumber } from 'ethers';
import { CometExt, CometExtAssetList } from '../../build/types';

export const BASE_INDEX_SCALE = 1e15;

function toBigInt(f: bigint | BigNumber): bigint {
  if (typeof f === 'bigint') {
    return f;
  } else {
    return f.toBigInt();
  }
}

export function divPrice(n: bigint, price: bigint | BigNumber, toScale: bigint | BigNumber): bigint {
  return (n * toBigInt(toScale)) / toBigInt(price);
}

function presentValueSupply(baseSupplyIndex: bigint, principalValue: bigint): bigint {
  return (principalValue * baseSupplyIndex) / BigInt(BASE_INDEX_SCALE);
}

function presentValueBorrow(baseBorrowIndex: bigint, principalValue: bigint): bigint {
  return (principalValue * baseBorrowIndex) / BigInt(BASE_INDEX_SCALE);
}

function signed256(n: bigint): bigint {
  if (n > BigInt('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')) {
    throw new Error('InvalidInt256: value exceeds int256 max');
  }
  return n;
}

export async function presentValue(principalValue: bigint, comet: CometExt | CometExtAssetList): Promise<bigint> {
  const totalsBasic = await comet.totalsBasic();
  const baseSupplyIndex = totalsBasic.baseSupplyIndex.toBigInt();
  const baseBorrowIndex = totalsBasic.baseBorrowIndex.toBigInt();
  if (principalValue >= 0n) {
    return signed256(presentValueSupply(baseSupplyIndex, principalValue));
  } else {
    return -signed256(presentValueBorrow(baseBorrowIndex, -principalValue));
  }
}

function safe104(n: bigint): bigint {
  const maxUint104 = BigInt('0xffffffffffffffffffffffffffff');
  if (n > maxUint104) {
    throw new Error('InvalidUInt104: value exceeds uint104 max');
  }
  return n;
}

function signed104(n: bigint): bigint {
  const maxInt104 = BigInt('0x7fffffffffffffffffffffffffff');
  if (n > maxInt104) {
    throw new Error('InvalidInt104: value exceeds int104 max');
  }
  return n;
}

function principalValueSupply(baseSupplyIndex: bigint, presentValue: bigint): bigint {
  return safe104((presentValue * BigInt(BASE_INDEX_SCALE)) / baseSupplyIndex);
}

function principalValueBorrow(baseBorrowIndex: bigint, presentValue: bigint): bigint {
  return safe104((presentValue * BigInt(BASE_INDEX_SCALE) + baseBorrowIndex - 1n) / baseBorrowIndex);
}

export async function principalValue(presentValue: bigint, comet: CometExt | CometExtAssetList): Promise<bigint> {
  const totalsBasic = await comet.totalsBasic();
  const baseSupplyIndex = totalsBasic.baseSupplyIndex.toBigInt();
  const baseBorrowIndex = totalsBasic.baseBorrowIndex.toBigInt();
  if (presentValue >= 0n) {
    return signed104(principalValueSupply(baseSupplyIndex, presentValue));
  } else {
    return -signed104(principalValueBorrow(baseBorrowIndex, -presentValue));
  }
}
