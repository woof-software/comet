import { AuthorizationConfig } from './types';

export const authorizationConfig: AuthorizationConfig = {
  expiryOffset: {
    failed: 10,
    valid: 1_000,
    extended: 10000,
    altered: 100,
    past: 1,
  },
  invalidVValue: 26n,
  maxSValuePlusOne: '0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A1',
};
