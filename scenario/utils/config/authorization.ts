import { AuthorizationConfig } from './types';

export const authorizationConfig: AuthorizationConfig = {
  expiryOffset: {
    short: 10n,
    long: 1_000n,
    veryLong: 10000n,
    altered: 100n,
    past: 1n,
  },
  invalidVValue: 26n,
  maxSValuePlusOne: '0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A1',
};
