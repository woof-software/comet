import { exp } from '../../../test/helpers';
import { AssetsConfig } from './types';

export const assetsConfig: AssetsConfig = {
  wsteth: {
    supplyCap: { small: exp(1, 18), medium: exp(2, 18) },
    tokenBalance: 2n,
    cometBalance: 50n,
    cometPosition: 1n,
  },
  maticx: {
    supplyAmount: exp(9000, 18),
    baseBorrowMultiplier: 1000n,
    supplyCap: exp(6_000_000, 18),
    balanceTolerance: 1n,
    borrowCollateralFactor: exp(0.55, 18),
    liquidateCollateralFactor: exp(0.60, 18),
    liquidationFactor: exp(0.93, 18),
  },
  dogecoin: {
    supplyAmount: 1_000_000n,
    decimals: 8n,
    price: 1_000n,
    allocateAmount: 100n,
    borrowCollateralFactor: exp(0.8, 18),
    liquidateCollateralFactor: exp(0.85, 18),
    liquidationFactor: exp(0.95, 18),
    supplyCap: 1_000n,
  },
};