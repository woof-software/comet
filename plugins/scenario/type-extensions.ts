import 'hardhat/types/config';
import type { ForkSpec } from './World.js';

export interface ScenarioConfig {
  bases: ForkSpec[];
}

declare module 'hardhat/types/config' {
  interface HardhatUserConfig {
    // optional?
    scenario: ScenarioConfig;
  }

  interface HardhatConfig {
    scenario: ScenarioConfig;
  }
}
