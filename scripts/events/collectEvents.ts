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
  const latestTimestamp = (await dm.hre.ethers.provider.getBlock(endBlock))?.timestamp;

  console.log(`Comet address ${getEtherscanUrl(network)}/address/${comet.address}`);
  console.log(`Comet deployed transaction ${getEtherscanUrl(network)}/trx/${hash}`);
  console.log(`Comet deployed block ${cometDeployedBlockNumber}`);

  // Estimate seconds per block from the last 10 blocks
  const blocks = [];
  for (let i = 0; i < 10; i++) {
    const b = await dm.hre.ethers.provider.getBlock(endBlock - i);
    if (b) blocks.push(b);
  }

  if (blocks.length < 2) {
    throw new Error('Not enough blocks to estimate block time');
  }

  const newest = blocks[0];
  const oldest = blocks[blocks.length - 1];
  const secondsPerBlock = (newest.timestamp - oldest.timestamp) / (newest.number - oldest.number);

  // Target timestamp 1.5 years ago
  const oneAndHalfYearsAgo = latestTimestamp - (365 * 24 * 60 * 60 * 1.5);
  const blocksAgo = Math.round((latestTimestamp - oneAndHalfYearsAgo) / secondsPerBlock);
  const startBlock = Math.max(cometDeployedBlockNumber, endBlock - blocksAgo);

  console.log(`Estimated secondsPerBlock: ${secondsPerBlock.toFixed(2)}`);
  console.log(`Start block (≈1.5 years ago): ${startBlock}`);

  const fetchSettings = eventsFetchSettings[network];
  const events = await getAllEvents(comet, startBlock, endBlock, dm, fetchSettings?.chunkSize, fetchSettings?.delaySeconds);
  console.log(events.length, 'events fetched');

  // Cache blockNumber -> timestamp to avoid redundant requests
  const uniqueBlockNumbers = Array.from(new Set(events.map(e => e.blockNumber)));
  const blockTimestamps: Record<number, number> = {};

  // Fetch block timestamps in batches to avoid provider overload
  const BATCH_SIZE = 100;
  for (let i = 0; i < uniqueBlockNumbers.length; i += BATCH_SIZE) {
    const batch = uniqueBlockNumbers.slice(i, i + BATCH_SIZE);
    const blocks = await Promise.all(
      batch.map(blockNumber => dm.hre.ethers.provider.getBlock(blockNumber))
    );
    blocks.forEach((block, idx) => {
      if (block) {
        blockTimestamps[batch[idx]] = block.timestamp;
      }
    });

    if (i % BATCH_SIZE === 0) {
      const progress = ((i + batch.length) / uniqueBlockNumbers.length * 100).toFixed(1);
      console.log(`Fetched timestamps for ${i + batch.length}/${uniqueBlockNumbers.length} blocks (${progress}%)`);
    }
  }

  const csvData = events.map((event, i) => {
    const timestamp = blockTimestamps[event.blockNumber];
    if (i % Math.ceil(events.length / 20) === 0) {      // No need to await here, just log
      console.log(`Progress: ${Math.round((i / events.length) * 100)}%`);
    }
    return {
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      event: event.event,
      args: JSON.stringify(event.args),
      timestamp: new Date(timestamp * 1000).toISOString(),
    };
  });
  console.log(csvData.length, 'events processed');


  // process each event according to its type
  // and convert to CSV format
  
  // Convert each event to a structured object
  // and handle BigInt serialization for CSV

  const lines = csvData.map((e) => {
    const args = JSON.parse(e.args);
    if(e.event === 'AbsorbDebt') {
      return {
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        event: e.event,
        args: {
          absorber: args[0],
          borrower: args[1],
          basePaidOut: BigInt(args[2].hex),
          usdValue: BigInt(args[3].hex),
        },
        timestamp: e.timestamp,
      };
    }
    if(e.event === 'AbsorbCollateral') {
      return {
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        event: e.event,
        args: {
          absorber: args[0],
          borrower: args[1],
          asset: args[2],
          collateralAbsorbed: BigInt(args[3].hex),
          usdValue: BigInt(args[4].hex),
        },
        timestamp: e.timestamp,
      };
    }
    if(e.event === 'BuyCollateral') {
      return {
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        event: e.event,
        args: {
          buyer: args[0],
          asset: args[1],
          baseAmount: BigInt(args[2].hex),
          collateralAmount: BigInt(args[3].hex),
        },
        timestamp: e.timestamp,
      };
    }
    if(e.event === 'Supply') {
      return {
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        event: e.event,
        args: {
          from: args[0],
          dst: args[1],
          amount: BigInt(args[2].hex),
        },
        timestamp: e.timestamp,
      };
    }
    if(e.event === 'Withdraw') {
      return {
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        event: e.event,
        args: {
          src: args[0],
          to: args[1],
          baseAmount: BigInt(args[2].hex),
        },
        timestamp: e.timestamp,
      };
    }
    if(e.event === 'SupplyCollateral') {
      return {
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        event: e.event,
        args: {
          from: args[0],
          dst: args[1],
          asset: args[2],
          amount: BigInt(args[3].hex),
        },
        timestamp: e.timestamp,
      };
    }
    if(e.event === 'WithdrawCollateral') {
      return {
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        event: e.event,
        args: {
          src: args[0],
          to: args[1],
          asset: args[2],
          amount: BigInt(args[3].hex),
        },
        timestamp: e.timestamp,
      };
    }
    if(e.event === 'Transfer') {
      return {
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        event: e.event,
        args: {
          from: args[0],
          to: args[1],
          amount: BigInt(args[2].hex),
        },
        timestamp: e.timestamp,
      };
    }
    if(e.event === 'TransferCollateral') {
      return {
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        event: e.event,
        args: {
          from: args[0],
          to: args[1],
          asset: args[2],
          amount: BigInt(args[3].hex),
        },
        timestamp: e.timestamp,
      };
    }
    else {
      console.warn(`Unknown event type: ${e.event}. Skipping.`);
      return null;
    }
  });

  const headers = ['blockNumber', 'transactionHash', 'event', 'args', 'timestamp'];
  const csvContent =
    headers.join(';') + '\n' +
    lines
      .filter(e => e !== null)
      .map(e =>
        headers.map(h => {
          if (h === 'args') {
            // Serialize BigInt values in args
            return escapeCsv(
              JSON.stringify(
                e.args,
                (_, value) => typeof value === 'bigint' ? value.toString() : value
              )
            );
          }
          return escapeCsv(String(e[h as keyof typeof e]));
        }).join(';')
      ).join('\n');
  const csvFilePath = `./scripts/events/reports/events_${network}_${deployment}.csv`;

  await fs.mkdir('./scripts/events/reports', { recursive: true });
  await fs.writeFile(csvFilePath, csvContent);
  console.log(`Events saved to ${csvFilePath}`);
};

main().then().catch(console.error);
