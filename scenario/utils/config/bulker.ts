import { exp } from '../../../test/helpers';
import { BulkerConfig } from './types';

export const bulkerConfig: BulkerConfig = {
  base: { standard: 1000000n, weth: 10n, borrow: 1000n },
  asset: { standard: 5000n, alternate: 5000n, minimal: 10n, borrow: 500n },
  cometAllocation: 5000n,
  supplyAmount: exp(0.01, 18),
  withdrawAmount: exp(0.005, 18),
  weth: { borrowBase: 5n, transferBase: 2n },
};