import { forkedHreForBase } from '../../plugins/scenario/utils/hreForBase';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { CometInterface, ERC20Interface } from '../../build/types';

const NETWORK = 'mainnet';
const DEPLOYMENT = 'usdt';
const FORK_BLOCK = 23741065;
const START_BLOCK = 23741066;
const END_BLOCK = 23741110;

interface Reserves {
  value: bigint;
}

function convertToSigned(value: bigint): bigint {
  const INT256_MAX = (1n << 255n) - 1n;
  if (value > INT256_MAX) {
    return value - (1n << 256n);
  }
  return value;
}

async function getReserves(blockNumber: number | string): Promise<Reserves> {
  const blockTag = typeof blockNumber === 'number' ? '0x' + blockNumber.toString(16) : blockNumber;
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [
        {
          to: CONTRACT,
          data: GET_RESERVES_SELECTOR,
        },
        blockTag,
      ],
      id: 1,
    }),
  });

  const data: any = await response.json();
  if (data.error) {
    throw new Error(`RPC error: ${data.error.message}`);
  }

  let value = BigInt(data.result);
  value = convertToSigned(value);

  return { value };
}

async function getPriceFeed(assetIndex: number, blockNumber: number | string): Promise<string> {
  // getAssetInfo(assetIndex) returns a struct with priceFeed address
  const getAssetInfoSelector = '0xc8c7fe6b'; // getAssetInfo(uint8)
  const params = assetIndex.toString(16).padStart(64, '0');
  const blockTag = typeof blockNumber === 'number' ? '0x' + blockNumber.toString(16) : blockNumber;
  
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [
        {
          to: COMET,
          data: getAssetInfoSelector + params,
        },
        blockTag,
      ],
      id: 1,
    }),
  });

  const data: any = await response.json();
  
  // Parse result: getAssetInfo returns AssetInfo struct
  const result = data.result;
  //   0x
  //   000000000000000000000000000000000000000000000000000000000000000d
  //   00000000000000000000000015700b564ca08d9439c58ca5053166e8317aa138
  //   000000000000000000000000471a6299c027bd81ed4d66069dc510bd0569f4f8
  //   0000000000000000000000000000000000000000000000000de0b6b3a7640000
  //   0000000000000000000000000000000000000000000000000c3663566a580000
  //   0000000000000000000000000000000000000000000000000c7d713b49da0000
  //   0000000000000000000000000000000000000000000000000d529ae9e8600000
  //   000000000000000000000000000000000000000000069e10de76676d08000000
  
  if (data.error) {
    // Asset index doesn't exist or contract call reverted
    return '0x0000000000000000000000000000000000000000';
  }
  
  if (!result || result === '0x' || result.length < 300) {
    // Asset doesn't exist or isn't configured
    return '0x0000000000000000000000000000000000000000';
  }

  // AssetInfo struct layout: each field is 32 bytes (64 hex chars) when ABI-encoded
  // After "0x" prefix:
  // Field 1 (offset): positions 0-64 
  // Field 2 (asset): positions 64-128
  // Field 3 (priceFeed): positions 128 onward
  // The address is at positions 154-194 (40 chars)
  const cleanAddress = result.substring(154, 194); // 40 char address
  const feedAddress = '0x' + cleanAddress;
  return feedAddress;
}

async function getPrice(feedAddress: string, blockNumber: number | string): Promise<bigint> {
  // Call latestAnswer() on price feed
  const latestAnswerSelector = '0x50d25bcd';
  
  // Return 0 if feed address is placeholder or invalid
  if (!feedAddress || feedAddress === '0x0000000000000000000000000000000000000000') {
    return 0n;
  }
  
  try {
    const blockTag = typeof blockNumber === 'number' ? '0x' + blockNumber.toString(16) : blockNumber;
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [
          {
            to: feedAddress,
            data: latestAnswerSelector,
          },
          blockTag,
        ],
        id: 1,
      }),
    });

    const data: any = await response.json();
    if (data.error) {
      return 0n;
    }

    const result = data.result || '0x0';
    let price = BigInt(result);
    price = convertToSigned(price);
    return price;
  } catch (error) {
    return 0n;
  }
}

async function getCometBalance(blockNumber: number | string): Promise<bigint> {
  // balanceOf(comet) on USDT token
  const balanceOfSelector = '0x70a08231'; // balanceOf(address)
  const cometParam = COMET.slice(2).padStart(64, '0');
  
  try {
    const blockTag = typeof blockNumber === 'number' ? '0x' + blockNumber.toString(16) : blockNumber;
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [
          {
            to: USDT,
            data: balanceOfSelector + cometParam,
          },
          blockTag,
        ],
        id: 1,
      }),
    });

    const data: any = await response.json();
    if (data.error) {
      return 0n;
    }

    return BigInt(data.result || '0');
  } catch (error) {
    return 0n;
  }
}

async function getBlockTransactions(blockNumber: number): Promise<any[]> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_getBlockByNumber',
      params: ['0x' + blockNumber.toString(16), true],
      id: 1,
    }),
  });

  const data: any = await response.json();
  if (data.error) {
    throw new Error(`RPC error: ${data.error.message}`);
  }

  const txs = data.result?.transactions || [];
  // Reverse the transactions array to get them in correct execution order
  return txs.reverse();
}

async function replayTransaction(tx: any, afterBlockNumber: number): Promise<any> {
  // Use eth_call to simulate transaction
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [
        {
          from: tx.from,
          to: tx.to,
          data: tx.input,
          value: tx.value,
          gasPrice: tx.gasPrice,
        },
        '0x' + afterBlockNumber.toString(16),
      ],
      id: 1,
    }),
  });

  const data: any = await response.json();
  return data.result;
}

async function findTriggerTx() {
  console.log(`🔍 Finding trigger transaction for reserve drop`);
  console.log(`📍 Fork block: ${FORK_BLOCK}`);
  console.log(`📍 Start block: ${START_BLOCK}\n`);

  try {
    // Get initial reserves and prices at fork block
    const initialReserves = await getReserves(FORK_BLOCK);
    const initialBalance = await getCometBalance(FORK_BLOCK);
    const deUSDFeed = await getPriceFeed(13, FORK_BLOCK);
    const sdeUSDFeed = await getPriceFeed(12, FORK_BLOCK);
    const initialDeUSDPrice = await getPrice(deUSDFeed, FORK_BLOCK);
    const initialSdeUSDPrice = await getPrice(sdeUSDFeed, FORK_BLOCK);
    
    console.log(`Initial state at block ${FORK_BLOCK}:`);
    console.log(`  Reserves: ${initialReserves.value.toString()}`);
    console.log(`  Comet USDT Balance: ${initialBalance.toString()}`);
    console.log(`  deUSD feed: ${deUSDFeed}`);
    console.log(`  deUSD price: ${initialDeUSDPrice.toString()}`);
    console.log(`  sdeUSD feed: ${sdeUSDFeed}`);
    console.log(`  sdeUSD price: ${initialSdeUSDPrice.toString()}\n`);

    // Get transactions from start block
    let blockNum = START_BLOCK;
    let found = false;
    const DROP_THRESHOLD = 0.05;

    while (!found && blockNum <= 23741110) {
      console.log(`\n📦 Processing block ${blockNum}...`);
      const txs = await getBlockTransactions(blockNum);

      if (txs.length === 0) {
        console.log(`   No transactions in block ${blockNum}`);
        blockNum++;
        continue;
      }

      console.log(`   Found ${txs.length} transactions`);

      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i];
        console.log(`\n   TX ${i + 1}/${txs.length}: ${tx.hash}`);
        // console.log(`      From: ${tx.from}`);
        // console.log(`      To: ${tx.to}`);
        // console.log(`      Value: ${tx.value}`);

        try {
          // Simulate transaction
          await replayTransaction(tx, blockNum);

          // Check reserves and prices after transaction simulation
          const reserves = await getReserves('0x' + blockNum.toString(16));
          const balance = await getCometBalance('0x' + blockNum.toString(16));
          const deUSDPrice = await getPrice(deUSDFeed, '0x' + blockNum.toString(16));
          const sdeUSDPrice = await getPrice(sdeUSDFeed, '0x' + blockNum.toString(16));
          
          //   console.log(`      Reserves after: ${reserves.value.toString()}`);
          //   console.log(`      Comet USDT Balance: ${balance.toString()}`);
          //   console.log(`      deUSD price: ${deUSDPrice.toString()}`);
          //   console.log(`      sdeUSD price: ${sdeUSDPrice.toString()}`);

          const drop = initialReserves.value > 0n
            ? Number(initialReserves.value - reserves.value) / Number(initialReserves.value)
            : 0;

          if (drop > DROP_THRESHOLD) {
            console.log(`\n✅ FOUND TRIGGER TX!`);
            console.log(`Block: ${blockNum}`);
            console.log(`TX Index: ${i + 1}/${txs.length}`);
            console.log(`TX Hash: ${tx.hash}`);
            console.log(`\nReserve Change:`);
            console.log(`  Before: ${initialReserves.value.toString()}`);
            console.log(`  After: ${reserves.value.toString()}`);
            console.log(`  Drop: ${(drop * 100).toFixed(2)}%`);
            console.log(`\nComet USDT Balance Change:`);
            console.log(`  Before (@ ${FORK_BLOCK}): ${initialBalance.toString()}`);
            console.log(`  After (@ ${blockNum}): ${balance.toString()}`);
            console.log(`\ndeUSD Price Change:`);
            console.log(`  Before (@ ${FORK_BLOCK}): ${initialDeUSDPrice.toString()}`);
            console.log(`  After (@ ${blockNum}): ${deUSDPrice.toString()}`);
            console.log(`\nsdeUSD Price Change:`);
            console.log(`  Before (@ ${FORK_BLOCK}): ${initialSdeUSDPrice.toString()}`);
            console.log(`  After (@ ${blockNum}): ${sdeUSDPrice.toString()}`);
            found = true;
            break;
          }
        } catch (error) {
          console.log(`      ⚠️ Error: ${error}`);
        }
      }

      blockNum++;
    }

    if (!found) {
      console.log(`\n❌ No trigger transaction found in range`);
    }
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

findTriggerTx().catch(console.error);
