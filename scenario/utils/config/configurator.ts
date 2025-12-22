import { exp } from '../../../test/helpers';
import { ConfiguratorConfig } from './types';

export const configuratorConfig: ConfiguratorConfig = {
  borrowCollateralFactor: exp(0.9, 18),
  liquidateCollateralFactor: exp(1, 18),
  liquidationFactor: exp(0.95, 18),
  supplyCap: exp(1000000, 8),
};