import { forkedHreForBase } from '../../plugins/scenario/utils/hreForBase';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { CometInterface, ERC20 } from '../../build/types';

const NETWORK = 'mainnet';
const DEPLOYMENT = 'usdt';
const FORK_BLOCK = 23741066;
const START_BLOCK = 23741067;
const END_BLOCK = 23741068;

const USDT_ADDRESS = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const DEUSD_ASSET_INDEX = 13;
const SDEUSD_ASSET_INDEX = 12;
const DROP_THRESHOLD = 0.05;
const MAINNET_RPC = 'https://rough-neat-glitter.quiknode.pro/255287d56db70b6a450ad0d295babf044d240732';

async function getBlockTransactionsFromRPC(blockNumber: number): Promise<string[]> {
  const response = await fetch(MAINNET_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_getBlockByNumber',
      params: ['0x' + blockNumber.toString(16), false], // false = only tx hashes
      id: 1,
    }),
  });

  const data: any = await response.json();
  if (data.error) {
    throw new Error(`RPC error: ${data.error.message}`);
  }

  const transactions = data.result?.transactions || [];
  return transactions;
}

function convertToSigned(value: bigint): bigint {
  const INT256_MAX = (1n << 255n) - 1n;
  if (value > INT256_MAX) {
    return value - (1n << 256n);
  }
  return value;
}

async function findTriggerTx() {
  console.log(`🔍 Finding trigger transaction for reserve drop`);
  console.log(`📍 Fork block: ${FORK_BLOCK}`);
  console.log(`📍 Start block: ${START_BLOCK}\n`);

  try {
    // Create forked HRE at the fork block
    const hre = await forkedHreForBase({
      name: '',
      network: NETWORK,
      deployment: DEPLOYMENT,
      blockNumber: FORK_BLOCK
    });

    const dm = new DeploymentManager(
      NETWORK,
      DEPLOYMENT,
      hre,
      {
        writeCacheToDisk: false,
        verificationStrategy: 'lazy',
      }
    );

    await dm.spider();
    const contracts = await dm.contracts();
    const comet = contracts.get('comet') as CometInterface;
    const usdt = await hre.ethers.getContractAt('ERC20', USDT_ADDRESS) as ERC20;

    console.log(`Comet: ${comet.address}`);
    
    // Get initial state at fork block
    const initialReserves = convertToSigned((await comet.getReserves()).toBigInt());
    const initialBalance = await usdt.balanceOf(comet.address);
    
    // Get price feed addresses
    const deUSDInfo = await comet.getAssetInfo(DEUSD_ASSET_INDEX);
    const sdeUSDInfo = await comet.getAssetInfo(SDEUSD_ASSET_INDEX);
    const deUSDFeed = await hre.ethers.getContractAt(
      ['function latestAnswer() view returns (int256)'],
      deUSDInfo.priceFeed
    );
    const sdeUSDFeed = await hre.ethers.getContractAt(
      ['function latestAnswer() view returns (int256)'],
      sdeUSDInfo.priceFeed
    );
    
    let initialDeUSDPrice = 0n;
    let initialSdeUSDPrice = 0n;
    try {
      initialDeUSDPrice = await deUSDFeed.latestAnswer();
    } catch (error) {
      console.log(`⚠️  deUSD price feed reverted`);
    }
    try {
      initialSdeUSDPrice = await sdeUSDFeed.latestAnswer();
    } catch (error) {
      console.log(`⚠️  sdeUSD price feed reverted`);
    }

    console.log(`Initial state at block ${FORK_BLOCK}:`);
    console.log(`  Reserves: ${initialReserves.toString()}`);
    console.log(`  Comet USDT Balance: ${initialBalance.toString()}`);
    console.log(`  deUSD feed: ${deUSDInfo.priceFeed}`);
    console.log(`  deUSD price: ${initialDeUSDPrice.toString()}`);
    console.log(`  sdeUSD feed: ${sdeUSDInfo.priceFeed}`);
    console.log(`  sdeUSD price: ${initialSdeUSDPrice.toString()}\n`);

    let found = false;

    // Process blocks one by one
    for (let blockNum = START_BLOCK; blockNum <= END_BLOCK && !found; blockNum++) {
      console.log(`\n📦 Processing block ${blockNum}...`);
      
      // Fetch transaction hashes from mainnet RPC
      const txHashes = await getBlockTransactionsFromRPC(blockNum);
      if (txHashes.length === 0) {
        console.log(`   No transactions in block`);
        continue;
      }

      console.log(`   Found ${txHashes.length} transactions`);

      // Create snapshot at fork block before processing this block's transactions
      const baseSnapshot = await hre.network.provider.request({
        method: 'evm_snapshot',
        params: [],
      }) as string;

      // Try adding transactions one by one using snapshot/revert
      for (let i = 0; i < txHashes.length && !found; i++) {
        console.log(`\n   Testing with ${i + 1} tx(s)...`);

        try {
          // Execute transactions from index 0 to i
          for (let j = 0; j <= i; j++) {
            const txHash = txHashes[j];
            console.log('    Executing tx:', txHash);
            const tx = await hre.ethers.provider.getTransaction(txHash);
            
            if (!tx) {
              throw new Error(`Could not fetch transaction ${txHash}`);
            }

            // Impersonate and execute
            await hre.network.provider.request({
              method: 'hardhat_impersonateAccount',
              params: [tx.from],
            });

            const signer = await hre.ethers.getSigner(tx.from);
            
            const txResult = await signer.sendTransaction({
              to: tx.to,
              data: tx.data,
              value: tx.value,
              gasLimit: tx.gasLimit,
              gasPrice: tx.gasPrice,
            });
            await txResult.wait();
          }

          // Check state after executing transactions 0..i
          const reserves = convertToSigned((await comet.getReserves()).toBigInt());
          const balance = await usdt.balanceOf(comet.address);
          
          let deUSDPrice = 0n;
          let sdeUSDPrice = 0n;
          try {
            deUSDPrice = await deUSDFeed.latestAnswer();
          } catch (error) {
            // Price feed can revert, use 0 as fallback
          }
          try {
            sdeUSDPrice = await sdeUSDFeed.latestAnswer();
          } catch (error) {
            // Price feed can revert, use 0 as fallback
          }

          const drop = initialReserves > 0n
            ? Number(initialReserves - reserves) / Number(initialReserves)
            : 0;

          console.log(`      Reserves: ${reserves.toString()}, Drop: ${(drop * 100).toFixed(2)}%`);

          if (drop > DROP_THRESHOLD) {
            const txHash = txHashes[i];
            const tx = await hre.ethers.provider.getTransaction(txHash);
            
            console.log(`\n✅ FOUND TRIGGER TX!`);
            console.log(`Block: ${blockNum}`);
            console.log(`TX Index: ${i + 1}/${txHashes.length}`);
            console.log(`TX Hash: ${txHash}`);
            console.log(`From: ${tx?.from}`);
            console.log(`To: ${tx?.to}`);
            console.log(`\nReserve Change:`);
            console.log(`  Before: ${initialReserves.toString()}`);
            console.log(`  After: ${reserves.toString()}`);
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

          // Revert to base snapshot before trying next transaction
          await hre.network.provider.request({
            method: 'evm_revert',
            params: [baseSnapshot],
          });

          // Create new snapshot for next iteration
          if (i < txHashes.length - 1) {
            await hre.network.provider.request({
              method: 'evm_snapshot',
              params: [],
            });
          }

        } catch (error: any) {
          console.log(`      ⚠️ Error: ${error.message}`);
          
          // Revert to base snapshot on error
          await hre.network.provider.request({
            method: 'evm_revert',
            params: [baseSnapshot],
          });

          // Create new snapshot for next iteration
          if (i < txHashes.length - 1) {
            await hre.network.provider.request({
              method: 'evm_snapshot',
              params: [],
            });
          }
        }
      }
    }

    if (!found) {
      console.log(`\n❌ No trigger transaction found in range`);
    }
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

findTriggerTx().catch(console.error);
