import {
} from './utils';
import { DeploymentManager } from '../../plugins/deployment_manager';
import fs from 'fs/promises';
import { forkedHreForBase } from '../../plugins/scenario/utils/hreForBase';
import { TransactionResponse } from '@ethersproject/abstract-provider';

const network = 'mainnet';
const deployment = 'usdc';

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

  const events = lines.map(line => {
    if (line.startsWith('blockNumber')) return null;
    const [blockNumber, transactionHash, event, args, timestamp] = line.split(';');
    return {
      blockNumber: parseInt(blockNumber),
      transactionHash,
      event,
      args: args,
      timestamp: new Date(timestamp).toISOString(),
    };
  });

  const parsedEvents = events.map((e) => {
    if (!e) return null; // skip null events
    // before parsing as a json remove double quotes around the keys
    e.args = e.args.replace(/""/g, '"').replace(/"{/g, '{').replace(/}"/g, '}');
    const args = JSON.parse(e.args);
    if (e.event === 'AbsorbDebt') {
      return {
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        event: e.event,
        args: {
          absorber: args.absorber,
          borrower: args.borrower,
          basePaidOut: BigInt(args.basePaidOut),
          usdValue: BigInt(args.usdValue),
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
          absorber: args.absorber,
          borrower: args.borrower,
          asset: args.asset,
          collateralAbsorbed: BigInt(args.collateralAbsorbed),
          usdValue: BigInt(args.usdValue),
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
          buyer: args.buyer,
          asset: args.asset,
          baseAmount: BigInt(args.baseAmount),
          collateralAmount: BigInt(args.collateralAmount),
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
