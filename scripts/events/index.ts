import {
  escapeCsv,
  getAllEvents,
  getContractDeploymentData,
} from './utils';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { CometInterface } from '../../build/types';
import { getEtherscanUrl } from '../../plugins/import/etherscan';
import { eventsFetchSettings } from './constants';
import fs from 'fs/promises';
import { forkedHreForBase } from '../../plugins/scenario/utils/hreForBase';

const network = 'mainnet';
const deployment = 'usdc';

const main = async () => {
  console.log('Start Event Fetcher');

  const hre = await forkedHreForBase({ name: '', network: network, deployment: deployment });

  const dm = new DeploymentManager(
    network,
    deployment,
    hre,
    {
      writeCacheToDisk: true,
      verificationStrategy: 'eager',
    }
  );

  await dm.spider();
  const contracts = await dm.contracts();
  const comet = contracts.get('comet') as CometInterface;
  const { blockNumber: cometDeployedBlockNumber, hash } = await getContractDeploymentData(network, comet.address);
  const endBlock = await dm.hre.ethers.provider.getBlockNumber();

  console.log(`Comet address ${getEtherscanUrl(network)}/address/${comet.address}`);
  console.log(`Comet deployed transaction ${getEtherscanUrl(network)}/trx/${hash}`);
  console.log(`Comet deployed block ${cometDeployedBlockNumber}`);
  
  const fetchSettings = eventsFetchSettings[network];
  const events = await getAllEvents(comet, endBlock - 300, endBlock, dm, fetchSettings?.chunkSize, fetchSettings?.delaySeconds);
  console.log(events.length, 'events fetched');
  console.log(events);
  // putt all events in a csv file
  const csvData = await Promise.all(events.map(async event => {
    const timestamp = (await dm.hre.ethers.provider.getBlock(event.blockNumber))?.timestamp;
    return {
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      event: event.event,
      args: JSON.stringify(event.args),
      timestamp: new Date(timestamp*1000).toISOString(),
    };
  }));
  const headers = ['blockNumber', 'transactionHash', 'event', 'args', 'timestamp'];
  const csvContent =
    headers.join(',') + '\n' +
    csvData.map(e => headers.map(h => escapeCsv(String(e[h as keyof typeof e]))).join(',')).join('\n');
  const csvFilePath = `./events_${network}_${deployment}.csv`;

  await fs.mkdir('./', { recursive: true });
  await fs.writeFile(csvFilePath, csvContent);
  console.log(`Events saved to ${csvFilePath}`);
};

main().then().catch(console.error);
