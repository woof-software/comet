import { exp } from '../../../test/helpers';
import { BulkerConfig } from './types';

export const bulkerConfig: BulkerConfig = {
  base: { supply: 1000000n, borrow: 1000n },
  asset: { supply: 5000n, supplyAlternate: 5000n, borrow: 500n },
  eth: { supply: exp(0.01, 18), withdraw: exp(0.005, 18) }, // ETH is used for supply and withdraw ETH (as native)
  weth: { borrow: 5n, transfer: 2n, supply: 10n }, // WETH is used for specific WETH scenarios
  cometAllocation: 5000n,
};