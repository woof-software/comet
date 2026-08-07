import { DeploymentManager } from '../../plugins/deployment_manager';

const ONE_MINUTE_IN_SECONDS = 60;
const ONE_HOUR_IN_SECONDS = 60 * ONE_MINUTE_IN_SECONDS;
const ONE_DAY_IN_SECONDS = 24 * ONE_HOUR_IN_SECONDS;
const ONE_WEEK_IN_SECONDS = 7 * ONE_DAY_IN_SECONDS;
const ONE_MONTH_IN_SECONDS = 30 * ONE_DAY_IN_SECONDS;
const ONE_YEAR_IN_SECONDS = 365 * ONE_DAY_IN_SECONDS;

export const duration = {
  minutes: function (val: number) {
    return val * ONE_MINUTE_IN_SECONDS;
  },
  hours: function (val: number) {
    return val * ONE_HOUR_IN_SECONDS;
  },
  days: function (val: number) {
    return val * ONE_DAY_IN_SECONDS;
  },
  weeks: function (val: number) {
    return val * ONE_WEEK_IN_SECONDS;
  },
  months: function (val: number) {
    return val * ONE_MONTH_IN_SECONDS;
  },
  years: function (val: number) {
    return val * ONE_YEAR_IN_SECONDS;
  },
};

export async function setNextBaseFeeToZero(dm: DeploymentManager) {
  await dm.hre.network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x0']);
}

// Directly sets an account's ETH balance via a single RPC (no block mined / tx signed),
// so scenarios can fund an impersonated signer for gas without the per-tx base-fee hack.
export async function setEtherBalance(dm: DeploymentManager, address: string, amount: bigint) {
  await dm.hre.network.provider.send('hardhat_setBalance', [address, '0x' + amount.toString(16)]);
}

export async function mineBlocks(dm: DeploymentManager, blocks: number) {
  const hex = `0x${blocks.toString(16)}`;

  await dm.hre.network.provider.send('hardhat_mine', [hex]);
}

export async function setNextBlockTimestamp(dm: DeploymentManager, timestamp: number) {
  await dm.hre.ethers.provider.send('evm_setNextBlockTimestamp', [timestamp]);
}