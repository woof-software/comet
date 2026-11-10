import { CometContext } from '../context/CometContext';
import CometAsset from '../context/CometAsset';
import { exp } from '../../test/helpers';
import { max, min } from '../utils/assertions';

export interface ComparativeAmount {
  val: number;
  op: ComparisonOp;
}

export enum ComparisonOp {
  GTE,
  GT,
  LTE,
  LT,
  EQ,
}

// Returns the amount that needs to be transferred to satisfy a constraint
export function getToTransferAmount(
  amount: ComparativeAmount,
  existingBalance: bigint,
  decimals: number
): bigint {
  let toTransfer = 0n;
  switch (amount.op) {
    case ComparisonOp.EQ:
      toTransfer = exp(amount.val, decimals) - existingBalance;
      break;
    case ComparisonOp.GTE:
      // `toTransfer` should not be negative
      toTransfer = max(exp(amount.val, decimals) - existingBalance, 0n);
      break;
    case ComparisonOp.LTE:
      // `toTransfer` should not be positive
      toTransfer = min(exp(amount.val, decimals) - existingBalance, 0n);
      break;
    case ComparisonOp.GT:
      toTransfer = exp(amount.val, decimals) - existingBalance + 1n;
      break;
    case ComparisonOp.LT:
      toTransfer = exp(amount.val, decimals) - existingBalance - 1n;
      break;
    default:
      throw new Error(`Bad amount: ${JSON.stringify(amount)}`);
  }
  return toTransfer;
}

// `amount` should be the unit amount of an asset instead of the gwei amount
export function parseAmount(amount): ComparativeAmount {
  switch (typeof amount) {
    case 'bigint':
      return amount >= 0n
        ? { val: Number(amount), op: ComparisonOp.GTE }
        : { val: Number(amount), op: ComparisonOp.LTE };
    case 'number':
      return amount >= 0
        ? { val: amount, op: ComparisonOp.GTE }
        : { val: amount, op: ComparisonOp.LTE };
    case 'string':
      return matchGroup(amount, {
        GTE: />=\s*(-?\d+)/,
        GT: />\s*(-?\d+)/,
        LTE: /<=\s*(-?\d+)/,
        LT: /<\s*(-?\d+)/,
        EQ: /==\s*(-?\d+)/,
      });
    case 'object':
      return amount;
    default:
      throw new Error(`Unrecognized amount: ${JSON.stringify(amount)}`);
  }
}

function matchGroup(str, patterns): ComparativeAmount {
  for (const k in patterns) {
    const match = patterns[k].exec(str);
    if (match) return { val: match[1], op: ComparisonOp[k] };
  }
  throw new Error(`No match for ${str} in ${patterns}`);
}

export async function getAssetFromName(
  name: string,
  context: CometContext
): Promise<CometAsset> {
  let comet = await context.getComet(); // TODO: can optimize by taking this as an arg instead
  if (name.startsWith('$')) {
    const collateralAssetRegex = /asset[0-9]+/;
    const baseAssetRegex = /base/;
    let asset: string;
    if (collateralAssetRegex.test(name)) {
      // If name matches regex, e.g. '$asset10'
      const assetIndex = name.match(/[0-9]+/g)![0];
      ({ asset } = await comet.getAssetInfo(assetIndex));
    } else if (baseAssetRegex.test(name)) {
      // If name matches 'base'
      asset = await comet.baseToken();
    } else {
      throw new Error(`Invalid asset name: ${name}`);
    }
    return context.getAssetByAddress(asset);
  } else {
    // If name doesn't match regex, try to find the asset directly from the assets list
    return context.assets[name];
  }
}
