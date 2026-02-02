import fs from 'fs/promises';

const RPC_URL = 'https://rough-neat-glitter.quiknode.pro/255287d56db70b6a450ad0d295babf044d240732';
const CONTRACT = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';

const GET_RESERVES_SELECTOR = '0x0902f1ac'; // getReserves()
const GET_ASSET_INFO_SELECTOR = '0xc8c7fe6b'; // getAssetInfo(uint8 i)
const NUM_ASSETS_SELECTOR = '0xa46fe83b'; // numAssets()
const GET_COLLATERAL_RESERVES_SELECTOR = '0x9ff567f8'; // getCollateralReserves(address asset)
const SYMBOL_SELECTOR = '0x95d89b41'; // symbol()
const DECIMALS_SELECTOR = '0x313ce567'; // decimals()
const GET_PRICE_SELECTOR = '0x41976e09'; // getPrice(address priceFeed)
const BASE_TOKEN_SELECTOR = '0xc55dae63'; // baseToken()
const BASE_TOKEN_PRICE_FEED_SELECTOR = '0xe7dad6bd'; // baseTokenPriceFeed()

const START_BLOCK = 23741754 ;
const USD_VALUE_THRESHOLD = 1000; // Only log changes > $1000
const END_BLOCK = 23741755;
const DROP_THRESHOLD = 0.05; // 5% drop
const BATCH_SIZE = 1; // Check every N blocks

interface Reserves {
  value: bigint;
}

interface AssetInfo {
  offset: number;
  asset: string;
  priceFeed: string;
  scale: bigint;
  borrowCollateralFactor: bigint;
  liquidateCollateralFactor: bigint;
  liquidationFactor: bigint;
  supplyCap: bigint;
}

interface AssetInfoWithMetadata extends AssetInfo {
  symbol: string;
  decimals: number;
}

interface CollateralReserves {
  [assetAddress: string]: bigint;
}

interface BaseTokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  priceFeed: string;
}

async function ethCall(contract: string, blockNumber: number, data: string): Promise<string> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [
        {
          to: contract,
          data: data,
        },
        '0x' + blockNumber.toString(16),
      ],
      id: 1,
    }),
  });

  const responseData: any = await response.json();
  if (responseData.error) {
    throw new Error(`RPC error at block ${blockNumber}: ${responseData.error.message}`);
  }
  return responseData.result;
}

async function getNumAssets(contract: string, blockNumber: number): Promise<number> {
  const result = await ethCall(contract, blockNumber, NUM_ASSETS_SELECTOR);
  return parseInt(result, 16);
}

async function getAssetInfo(contract: string, blockNumber: number, assetIndex: number): Promise<AssetInfo> {
  // getAssetInfo(uint8 i) - encode the function call with the index parameter
  const indexHex = assetIndex.toString(16).padStart(64, '0');
  const data = GET_ASSET_INFO_SELECTOR + indexHex;
  
  const result = await ethCall(contract, blockNumber, data);
  
  // Parse the returned AssetInfo struct (ABI encoded)
  // AssetInfo { offset, asset, priceFeed, scale, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor, supplyCap }
  // Each field is 32 bytes in ABI encoding
  const cleanResult = result.slice(2); // Remove '0x'
  
  const offset = parseInt(cleanResult.slice(0, 64), 16);
  const asset = '0x' + cleanResult.slice(64 + 24, 128); // address is 20 bytes, padded to 32
  const priceFeed = '0x' + cleanResult.slice(128 + 24, 192);
  const scale = BigInt('0x' + cleanResult.slice(192, 256));
  const borrowCollateralFactor = BigInt('0x' + cleanResult.slice(256, 320));
  const liquidateCollateralFactor = BigInt('0x' + cleanResult.slice(320, 384));
  const liquidationFactor = BigInt('0x' + cleanResult.slice(384, 448));
  const supplyCap = BigInt('0x' + cleanResult.slice(448, 512));
  
  return {
    offset,
    asset,
    priceFeed,
    scale,
    borrowCollateralFactor,
    liquidateCollateralFactor,
    liquidationFactor,
    supplyCap,
  };
}

async function getCollateralReserves(contract: string, blockNumber: number, assetAddress: string): Promise<bigint> {
  // getCollateralReserves(address asset) - encode the function call with the asset address
  const addressHex = assetAddress.slice(2).toLowerCase().padStart(64, '0');
  const data = GET_COLLATERAL_RESERVES_SELECTOR + addressHex;
  
  const result = await ethCall(contract, blockNumber, data);
  return BigInt(result);
}

async function getTokenSymbol(tokenAddress: string, blockNumber: number): Promise<string> {
  try {
    const result = await ethCall(tokenAddress, blockNumber, SYMBOL_SELECTOR);
    // ABI decode string: first 32 bytes = offset, next 32 bytes = length, then the string data
    const cleanResult = result.slice(2);
    const length = parseInt(cleanResult.slice(64, 128), 16);
    const symbolHex = cleanResult.slice(128, 128 + length * 2);
    return Buffer.from(symbolHex, 'hex').toString('utf8');
  } catch (e) {
    return tokenAddress.slice(0, 10) + '...';
  }
}

async function getTokenDecimals(tokenAddress: string, blockNumber: number): Promise<number> {
  try {
    const result = await ethCall(tokenAddress, blockNumber, DECIMALS_SELECTOR);
    return parseInt(result, 16);
  } catch (e) {
    return 18; // default to 18 decimals
  }
}

// Price is returned with 8 decimals (PRICE_SCALE = 1e8)
const PRICE_SCALE = 8;

async function getPrice(cometContract: string, priceFeedAddress: string, blockNumber: number): Promise<bigint> {
  try {
    const addressHex = priceFeedAddress.slice(2).toLowerCase().padStart(64, '0');
    const data = GET_PRICE_SELECTOR + addressHex;
    const result = await ethCall(cometContract, blockNumber, data);
    return BigInt(result);
  } catch (e) {
    console.error(`Error getting price for ${priceFeedAddress}:`, e);
    return 0n;
  }
}

async function getBaseToken(cometContract: string, blockNumber: number): Promise<string> {
  const result = await ethCall(cometContract, blockNumber, BASE_TOKEN_SELECTOR);
  return '0x' + result.slice(26); // Extract address from 32-byte response
}

async function getBaseTokenPriceFeed(cometContract: string, blockNumber: number): Promise<string> {
  const result = await ethCall(cometContract, blockNumber, BASE_TOKEN_PRICE_FEED_SELECTOR);
  return '0x' + result.slice(26); // Extract address from 32-byte response
}

async function getBaseTokenInfo(cometContract: string, blockNumber: number): Promise<BaseTokenInfo> {
  const address = await getBaseToken(cometContract, blockNumber);
  const priceFeed = await getBaseTokenPriceFeed(cometContract, blockNumber);
  const symbol = await getTokenSymbol(address, blockNumber);
  const decimals = await getTokenDecimals(address, blockNumber);
  return { address, symbol, decimals, priceFeed };
}

function calculateUsdValue(amount: bigint, decimals: number, price: bigint): number {
  // amount is in token decimals, price is in 8 decimals
  // USD value = (amount / 10^decimals) * (price / 10^8)
  const amountFloat = Number(amount) / (10 ** decimals);
  const priceFloat = Number(price) / (10 ** PRICE_SCALE);
  return amountFloat * priceFloat;
}

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatWithDecimals(value: bigint, decimals: number): string {
  const isNegative = value < 0n;
  const absValue = isNegative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const integerPart = absValue / divisor;
  const fractionalPart = absValue % divisor;
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0').slice(0, 6);
  return `${isNegative ? '-' : ''}${integerPart}.${fractionalStr}`;
}

async function getReserves(contract: string, blockNumber: number, selector: string): Promise<Reserves> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [
        {
          to: contract,
          data: selector,
        },
        '0x' + blockNumber.toString(16),
      ],
      id: 1,
    }),
  });

  const data: any = await response.json();
  if (data.error) {
    throw new Error(`RPC error at block ${blockNumber}: ${data.error.message}`);
  }

  const result = data.result;
  let value = BigInt(result);

  // Convert from unsigned to signed int256 (two's complement)
  const INT256_MAX = (1n << 255n) - 1n;
  if (value > INT256_MAX) {
    value = value - (1n << 256n);
  }

  return { value };
}

async function findReserveDrops() {
  console.log(`Scanning blocks ${START_BLOCK} to ${END_BLOCK} for reserve drops > ${(DROP_THRESHOLD * 100).toFixed(0)}%`);
  console.log(`Checking every ${BATCH_SIZE} blocks...\n`);

  // First, get base token info
  const baseTokenInfo = await getBaseTokenInfo(CONTRACT, START_BLOCK);
  console.log(`Base Token: ${baseTokenInfo.symbol} (${baseTokenInfo.address}) - ${baseTokenInfo.decimals} decimals`);
  console.log(`Base Token Price Feed: ${baseTokenInfo.priceFeed}\n`);

  // Get the number of assets and their addresses
  const numAssets = await getNumAssets(CONTRACT, START_BLOCK);
  console.log(`Found ${numAssets} collateral assets\n`);

  const assetInfos: AssetInfoWithMetadata[] = [];
  for (let i = 0; i < numAssets; i++) {
    const assetInfo = await getAssetInfo(CONTRACT, START_BLOCK, i);
    const symbol = await getTokenSymbol(assetInfo.asset, START_BLOCK);
    const decimals = await getTokenDecimals(assetInfo.asset, START_BLOCK);
    assetInfos.push({ ...assetInfo, symbol, decimals });
    console.log(`Asset ${i}: ${symbol} (${assetInfo.asset}) - ${decimals} decimals`);
  }
  console.log('');

  const results: any[] = [];
  let previousReserves: Reserves | null = null;
  let previousCollateralReserves: CollateralReserves | null = null;
  let previousBlock = START_BLOCK;

  for (let block = START_BLOCK; block <= END_BLOCK; block += BATCH_SIZE) {
    try {
      const reserves = await getReserves(CONTRACT, block, GET_RESERVES_SELECTOR);
      
      // Get collateral reserves for each asset
      const collateralReserves: CollateralReserves = {};
      for (const assetInfo of assetInfos) {
        collateralReserves[assetInfo.asset] = await getCollateralReserves(CONTRACT, block, assetInfo.asset);
      }

      if (previousReserves) {
        // Check for significant drops in base reserve value
        // Use absolute value in denominator to handle negative reserves becoming more negative
        const drop = previousReserves.value !== 0n
          ? Number(previousReserves.value - reserves.value) / Math.abs(Number(previousReserves.value))
          : 0;

        if (drop > DROP_THRESHOLD) {
          // Get base token price
          const basePrice = await getPrice(CONTRACT, baseTokenInfo.priceFeed, block);
          const basePriceFormatted = Number(basePrice) / (10 ** PRICE_SCALE);
          
          const beforeUsd = calculateUsdValue(previousReserves.value < 0n ? -previousReserves.value : previousReserves.value, baseTokenInfo.decimals, basePrice);
          const afterUsd = calculateUsdValue(reserves.value < 0n ? -reserves.value : reserves.value, baseTokenInfo.decimals, basePrice);
          const changeValue = previousReserves.value - reserves.value;
          const changeUsd = calculateUsdValue(changeValue < 0n ? -changeValue : changeValue, baseTokenInfo.decimals, basePrice);

          results.push({
            blockRange: `${previousBlock}-${block}`,
            dropBlock: block,
            dropPercent: (drop * 100).toFixed(2),
            before: previousReserves.value.toString(),
            beforeUsd: beforeUsd.toFixed(2),
            after: reserves.value.toString(),
            afterUsd: afterUsd.toFixed(2),
            type: 'base',
          });
          console.log(
            `\n📉 Base Reserve (${baseTokenInfo.symbol}) dropped ${(drop * 100).toFixed(2)}% between blocks ${previousBlock} and ${block}`
          );
          console.log(`   Price:  ${formatUsd(basePriceFormatted)} per ${baseTokenInfo.symbol}`);
          console.log(`   Before: ${formatWithDecimals(previousReserves.value, baseTokenInfo.decimals)} ${baseTokenInfo.symbol} (${formatUsd(previousReserves.value < 0n ? -beforeUsd : beforeUsd)})`);
          console.log(`   After:  ${formatWithDecimals(reserves.value, baseTokenInfo.decimals)} ${baseTokenInfo.symbol} (${formatUsd(reserves.value < 0n ? -afterUsd : afterUsd)})`);
          console.log(`   Change: ${formatUsd(changeUsd)}`);
        }
      }

      // Check for collateral reserve changes
      if (previousCollateralReserves) {
        for (const assetInfo of assetInfos) {
          const prevReserve = previousCollateralReserves[assetInfo.asset];
          const currReserve = collateralReserves[assetInfo.asset];
          
          if (prevReserve !== currReserve) {
            const change = currReserve - prevReserve;
            const absChange = change < 0n ? -change : change;
            
            // Get price from price feed
            const price = await getPrice(CONTRACT, assetInfo.priceFeed, block);
            const changeUsdValue = calculateUsdValue(absChange, assetInfo.decimals, price);
            
            // Only log if USD value > threshold
            if (changeUsdValue > USD_VALUE_THRESHOLD) {
              const priceFormatted = Number(price) / (10 ** PRICE_SCALE);
              
              console.log(`\n📊 Collateral Reserve Changed for ${assetInfo.symbol} at block ${block}`);
              console.log(`   Price:   ${formatUsd(priceFormatted)} per ${assetInfo.symbol}`);
              console.log(`   Before:  ${formatWithDecimals(prevReserve, assetInfo.decimals)} ${assetInfo.symbol} (${prevReserve.toString()} raw)`);
              console.log(`   After:   ${formatWithDecimals(currReserve, assetInfo.decimals)} ${assetInfo.symbol} (${currReserve.toString()} raw)`);
              console.log(`   Change:  ${change > 0n ? '+' : ''}${formatWithDecimals(change, assetInfo.decimals)} ${assetInfo.symbol}`);
              console.log(`   USD Value: ${formatUsd(changeUsdValue)}`);

              results.push({
                blockRange: `${previousBlock}-${block}`,
                dropBlock: block,
                asset: assetInfo.asset,
                symbol: assetInfo.symbol,
                decimals: assetInfo.decimals,
                price: price.toString(),
                priceFormatted: formatUsd(priceFormatted),
                before: prevReserve.toString(),
                beforeFormatted: formatWithDecimals(prevReserve, assetInfo.decimals),
                after: currReserve.toString(),
                afterFormatted: formatWithDecimals(currReserve, assetInfo.decimals),
                change: change.toString(),
                changeFormatted: formatWithDecimals(change, assetInfo.decimals),
                changeUsdValue: changeUsdValue.toFixed(2),
                type: 'collateral',
              });
            }
          }
        }
      }

      console.log(`Block ${block}: Base reserves=${reserves.value.toString()}`);

      previousReserves = reserves;
      previousCollateralReserves = collateralReserves;
      previousBlock = block;

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`Error at block ${block}:`, error);
    }
  }

  // Save results to file
  const outputPath = './scripts/events/reports/reserve_drops.json';
  await fs.mkdir('./scripts/events/reports', { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(results, null, 2));

  console.log(`\n✅ Found ${results.length} reserve changes`);
  console.log(`Results saved to ${outputPath}`);

  return results;
}

findReserveDrops().catch(console.error);
