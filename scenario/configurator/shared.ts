import { BigNumber, ethers } from 'ethers';
import { CometContext } from '../context/CometContext';

// Based on contract's internal precision: FACTOR_SCALE=1e18 with 4 decimal places
export const FACTOR_SCALE = 10n ** 18n;
export const MIN_FACTOR_INCREMENT = FACTOR_SCALE / 10n ** 4n;

export type ArrayMethods = keyof Omit<any[], number>;

export type NamedKeys<T> = {
  [K in keyof T as K extends number | `${number}` | ArrayMethods ? never : K]: T[K];
};

export type Normalize<T> = T extends BigNumber
  ? bigint
  : T extends string | number | boolean
  ? T
  : [NamedKeys<T>] extends [Record<string, never>]
  ? T extends (infer U)[]
    ? Normalize<U>[]
    : T
  : { [K in keyof NamedKeys<T>]: Normalize<NamedKeys<T>[K]> };

export type NormalizedStruct<T> = Normalize<NamedKeys<T>>;

/**
 * Hybrid array-objects with both numeric and named keys are stripped to plain
 * objects with native bigint values, safe to destructure, compare, and serialize.
 */
export function normalizeStructOutput<T>(value: T): NormalizedStruct<T> {
  function normalize(val: any): any {
    if (BigNumber.isBigNumber(val)) {
      return val.toBigInt();
    }
    if (val && typeof val === 'object') {
      const namedKeys = Object.keys(val).filter((key) => isNaN(Number(key)));
      if (namedKeys.length > 0) {
        return Object.fromEntries(namedKeys.map((key) => [key, normalize(val[key])]));
      }
      if (Array.isArray(val)) {
        return val.map(normalize);
      }
    }
    return val;
  }

  return normalize(value) as NormalizedStruct<T>;
}

export function getMinSupplyCapIncrement(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

export async function deployCometFactory(context: CometContext, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;
  const cometFactory = await dm.deploy('test:cometFactory', 'CometFactoryWithExtendedAssetList.sol', [], force);

  return cometFactory.address;
}

export async function deployPriceFeed(context: CometContext, alias: string, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;
  const PRICE_FEED_DECIMALS = 8;
  const PRICE_FEED_ANSWER = 1 * 10 ** PRICE_FEED_DECIMALS;

  const priceFeed = await dm.deploy(
    `test:${alias}PriceFeed`,
    'test/SimplePriceFeed.sol',
    [PRICE_FEED_ANSWER, PRICE_FEED_DECIMALS],
    force
  );

  return priceFeed.address;
}

export async function deployTimelock(context: CometContext, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;
  const admin = context.actors.admin;
  const timelock = await dm.deploy('test:timelock', 'test/SimpleTimelock.sol', [admin.address], force);

  return timelock.address;
}

export async function deployMockERC20(context: CometContext, alias: string, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;

  const mockERC20 = await dm.deploy(
    `mockERC20:${alias}`,
    'test/FaucetToken.sol',
    [0, 'Mock Token', 18, 'MOCK'],
    force
  );

  return mockERC20.address;
}

export async function deployCometExt(context: CometContext, force?: boolean): Promise<string> {
  const dm = context.world.deploymentManager;

  const extConfiguration = {
    name32: ethers.utils.formatBytes32String('MOCK'),
    symbol32: ethers.utils.formatBytes32String('cMOCKv3')
  };

  const cometExt = await dm.deploy(
    'test:comet:implementation:implementation',
    'CometExt.sol',
    [extConfiguration],
    force
  );

  return cometExt.address;
}
