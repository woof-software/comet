import { BigNumber } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';

import { paramString } from '../../plugins/import/import';
import { get, getEtherscanApiKey, getEtherscanApiUrl } from '../../plugins/import/etherscan';
import { TransferEvent } from '../../build/types/Comet';
import { IncentivizationCampaignData } from './types';
import { CometInterface } from '../../build/types';

import {
  mkdir,
  writeFile,
  readFile,
} from 'fs/promises';
import { readdirSync } from 'fs';
import path from 'path';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { getEtherscanUrl } from '../../plugins/import/etherscan';
import { multicallAddresses, eventsFetchSettings } from './constants';
import { CampaignType } from './types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { ethers } from 'ethers';
import { delay } from '@nomiclabs/hardhat-etherscan/dist/src/etherscan/EtherscanService';

export const getAllEvents = async (comet: CometInterface, startBlock: number, endBlock: number, dm: DeploymentManager, chunkSize: number = 100000, delaySeconds: number = 5) => {
  let allEvents: any[] = [];

  for (let fromBlock = startBlock; fromBlock < endBlock; fromBlock += chunkSize) {
    const toBlock = Math.min(fromBlock + chunkSize - 1, endBlock);
    const filters = [
      comet.filters.Supply(),
      comet.filters.Withdraw(),
      comet.filters.SupplyCollateral(),
      comet.filters.AbsorbCollateral(),
      comet.filters.AbsorbDebt(),
      comet.filters.BuyCollateral(),
    ];
    try {
      const events = await dm.retry(() => {
        return Promise.all(filters.map(filter => comet.queryFilter(filter, fromBlock, toBlock)));
      }, 30);
      // now check if there are empty arrays and flatten the result
      allEvents = allEvents.concat(events.filter(eventArray => eventArray.length > 0).flat());
      console.log(`Fetched events from block ${fromBlock} to ${toBlock}`);
      await delay(delaySeconds * 1000);
    } catch (error) {
      throw new Error(`Error fetching events from block ${fromBlock} to ${toBlock}: ${error}`);
    }
  }

  return allEvents;
};

export const getContractDeploymentData = async (network: string, address: string): Promise<{ blockNumber: number, hash: string }> => {
  const params = {
    module: 'account',
    action: 'txlist',
    address,
    startblock: 0,
    endblock: 99999999,
    page: 1,
    offset: 10,
    sort: 'asc',
    apikey: getEtherscanApiKey(network)
  };
  const url = `${getEtherscanApiUrl(network)}?${paramString(params)}`;
  const result = await get(url, {});
  const firstTransaction = result.result[0];

  if (!firstTransaction) return null;

  return { blockNumber: +firstTransaction.blockNumber, hash: firstTransaction.hash, };
};

export function escapeCsv(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
