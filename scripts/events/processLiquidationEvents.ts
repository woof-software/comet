import {
} from './utils';
import { DeploymentManager } from '../../plugins/deployment_manager';
import fs from 'fs/promises';
import { forkedHreForBase } from '../../plugins/scenario/utils/hreForBase';
import { TransactionResponse } from '@ethersproject/abstract-provider';

const network = 'mainnet';
const deployment = 'usdt';

const main = async () => {
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
  
  // process csv to json from events_*network*_*deployment*
  const csvFilePath = `./scripts/events/reports/events_${network}_${deployment}.csv`;
  const csvContent = await fs.readFile(csvFilePath, 'utf-8');
  const lines = csvContent.split('\n').filter(line => line.trim() !== '');

  let i = 0;
  const events = lines.map(line => {
    i++;
    if (line.startsWith('blockNumber')) return null;
    if( i <= 10)console.log('Processing line:', line);
    
    // Split by comma, but handle quoted fields that may contain commas
    const parts = line.match(/(?:[^,"]+|"[^"]*")+/g) || [];
    if (parts.length < 5) {
      console.warn(`Skipping invalid line: ${line}`);
      return null;
    }
    
    const [blockNumber, transactionHash, event, args, timestamp] = parts;
    console.log('Parsed parts:', { blockNumber, transactionHash, event, args, timestamp });
    const date = new Date(timestamp);
    const parsedTimestamp = !isNaN(date.getTime()) ? date.toISOString() : timestamp;
    
    return {
      blockNumber: parseInt(blockNumber),
      transactionHash,
      event,
      args: args,
      timestamp: parsedTimestamp,
    };
  });
  i = 0;
  const parsedEvents = events.map((e) => {
    if(i <= 10) console.log('Parsing event:', e);
    if (!e || !e.args) return null; // skip null events or events without args
    // Remove outer quotes if present
    let argsStr = e.args;
    if (argsStr.startsWith('"') && argsStr.endsWith('"')) {
      argsStr = argsStr.slice(1, -1);
    }
    // before parsing as a json remove double quotes around the keys
    argsStr = argsStr.replace(/""/g, '"').replace(/"{/g, '{').replace(/}"/g, '}');
    if(i <= 10) console.log('After processing:', argsStr);
    const args = JSON.parse(argsStr);
    
    // Helper function to parse BigNumber objects or hex strings
    const parseBigInt = (val: any): bigint => {
      if (typeof val === 'object' && val?.type === 'BigNumber' && val?.hex) {
        return BigInt(val.hex);
      }
      if (typeof val === 'string') {
        return BigInt(val);
      }
      if (typeof val === 'number') {
        return BigInt(val);
      }
      return BigInt(val);
    };
    
    // Helper function to format price with decimals (8 decimals)
    const formatPrice = (value: bigint): string => {
      const num = Number(value) / 1e8;
      return num.toFixed(8).replace(/0+$/, '').replace(/\.$/, '0');
    };
    
    if (e.event === 'AbsorbDebt') {
      return {
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        event: e.event,
        args: {
          absorber: args[0],
          borrower: args[1],
          basePaidOut: parseBigInt(args[2]),
          usdValue: formatPrice(parseBigInt(args[3])),
        },
        timestamp: e.timestamp,
      };
    }
    if (e.event === 'AbsorbCollateral') {
      return {
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        event: e.event,
        args: {
          absorber: args[0],
          borrower: args[1],
          asset: args[2],
          collateralAbsorbed: parseBigInt(args[3]),
          usdValue: formatPrice(parseBigInt(args[4])),
        },
        timestamp: e.timestamp,
      };
    }
    if (e.event === 'BuyCollateral') {
      return {
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        event: e.event,
        args: {
          buyer: args[0],
          asset: args[1],
          baseAmount: parseBigInt(args[2]),
          collateralAmount: parseBigInt(args[3]),
        },
        timestamp: e.timestamp,
      };
    }
    return null; // skip unknown events
  }).filter(e => e !== null); // filter out null events
  // check that there are events
  if (parsedEvents.length === 0) {
    console.log('No events found');
    return;
  }

  // now get some of the params from args string of those events:
  /*
    event AbsorbDebt(address indexed absorber, address indexed borrower, uint basePaidOut, uint usdValue);
    event AbsorbCollateral(address indexed absorber, address indexed borrower, address indexed asset, uint collateralAbsorbed, uint usdValue);
    event BuyCollateral(address indexed buyer, address indexed asset, uint baseAmount, uint collateralAmount);
  */
  // NOTE: AbsorbDebt always appears in pair with one or more AbsorbCollateral events, BuyCollateral mostly appears in pair with AbsorbCollateral, but not always.
  // map the events to the new structure, use tx hash to pair events together
  const mappedEvents: any[] = [];
  const eventMap: { [txHash: string]: any } = {};

  parsedEvents.forEach(event => {
    if (!eventMap[event.transactionHash]) {
      eventMap[event.transactionHash] = {
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        timestamp: event.timestamp,
        events: [],
      };
    }
    eventMap[event.transactionHash].events.push(event);
  });

  // Process transactions sequentially to avoid overwhelming the provider
  const eventEntries = Object.values(eventMap);
  for (let i = 0; i < eventEntries.length; i++) {
    const event = eventEntries[i];
    const absorbDebtEvent = event.events.find((e: { event: string }) => e.event === 'AbsorbDebt');
    const absorbCollateralEvents = event.events.filter((e: { event: string }) => e.event === 'AbsorbCollateral');
    const buyCollateralEvents = event.events.filter((e: { event: string }) => e.event === 'BuyCollateral');

    // fetch tx caller from tx hash
    let txData: TransactionResponse;
    try {
      txData = await dm.hre.ethers.provider.getTransaction(event.transactionHash);
    } catch (err) {
      console.warn(`Error fetching transaction ${event.transactionHash}:`, err);
      continue;
    }
    if (!txData) {
      console.warn(`Transaction ${event.transactionHash} not found`);
      continue;
    } else {
      const progress = ((i + 1) / eventEntries.length * 100).toFixed(1);
      // log every 5% of progress
      if (i % Math.ceil(eventEntries.length / 20) === 0) {
        console.log(`Processing transaction ${txData.hash} (${progress}%)`);
      }
    }

    if (absorbDebtEvent) {
      mappedEvents.push({
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        timestamp: event.timestamp,
        caller: txData.from,
        liquidator: absorbDebtEvent.args.absorber,
        gasUsed: txData.gasLimit.toNumber(),
        borrower: absorbDebtEvent.args.borrower,
        basePaidOut: absorbDebtEvent.args.basePaidOut.toString(),
        basePaidOutUsdValue: absorbDebtEvent.args.usdValue.toString(),
        collateralAbsorbed: absorbCollateralEvents.map((e: { args: { asset: any, collateralAbsorbed: { toString: () => any }, usdValue: { toString: () => any } } }) => ({
          asset: e.args.asset,
          collateralAbsorbed: e.args.collateralAbsorbed.toString(),
          usdValue: e.args.usdValue.toString(),
        })),
        buyCollateral: buyCollateralEvents.map((e: { args: { buyer: any, asset: any, baseAmount: { toString: () => any }, collateralAmount: { toString: () => any } } }) => ({
          buyer: e.args.buyer,
          asset: e.args.asset,
          baseAmount: e.args.baseAmount.toString(),
          collateralAmount: e.args.collateralAmount.toString(),
        })),
      });
    } else {
      mappedEvents.push({
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        timestamp: event.timestamp,
        caller: txData.from,
        liquidator: null,
        gasUsed: txData.gasLimit.toNumber(),
        borrower: null,
        basePaidOut: '0',
        basePaidOutUsdValue: '0',
        collateralAbsorbed: [],
        buyCollateral: buyCollateralEvents.map((e: { args: { buyer: any, asset: any, baseAmount: { toString: () => any }, collateralAmount: { toString: () => any } } }) => ({
          buyer: e.args.buyer,
          asset: e.args.asset,
          baseAmount: e.args.baseAmount.toString(),
          collateralAmount: e.args.collateralAmount.toString(),
        })),
      });
    }
  }

  // write the mapped events to a json file
  const outputFilePath = `./scripts/events/reports/liquidation_events_${network}_${deployment}.json`;
  await fs.writeFile(outputFilePath, JSON.stringify(mappedEvents, null, 2));
  console.log(`Mapped events written to ${outputFilePath}`);
};


main().then().catch(console.error);
