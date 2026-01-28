import fs from 'fs/promises';

const RPC_URL = 'https://rough-neat-glitter.quiknode.pro/255287d56db70b6a450ad0d295babf044d240732';
const CONTRACT = '0x3afdc9bca9213a35503b077a6072f3d0d5ab0840';
const GET_RESERVES_SELECTOR = '0x0902f1ac';

const START_BLOCK = 23740110;
const END_BLOCK = 23741110;
const DROP_THRESHOLD = 0.05; // 5% drop
const BATCH_SIZE = 1; // Check every N blocks

interface Reserves {
  value: bigint;
}

async function getReserves(blockNumber: number): Promise<Reserves> {
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

  const results: any[] = [];
  let previousReserves: Reserves | null = null;
  let previousBlock = START_BLOCK;

  for (let block = START_BLOCK; block <= END_BLOCK; block += BATCH_SIZE) {
    try {
      const reserves = await getReserves(block);

      if (previousReserves) {
        // Check for significant drops in reserve value
        const drop = previousReserves.value > 0n
          ? Number(previousReserves.value - reserves.value) / Number(previousReserves.value)
          : 0;

        if (drop > DROP_THRESHOLD) {
          results.push({
            blockRange: `${previousBlock}-${block}`,
            dropBlock: block,
            dropPercent: (drop * 100).toFixed(2),
            before: previousReserves.value.toString(),
            after: reserves.value.toString(),
          });
          console.log(
            `📉 Reserve dropped ${(drop * 100).toFixed(2)}% between blocks ${previousBlock} and ${block}`
          );
          console.log(`   Before: ${previousReserves.value.toString()}`);
          console.log(`   After:  ${reserves.value.toString()}\n`);
        }
      }

      console.log(`Block ${block}: Value=${reserves.value.toString()}`);

      previousReserves = reserves;
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

  console.log(`\n✅ Found ${results.length} significant drops`);
  console.log(`Results saved to ${outputPath}`);

  return results;
}

findReserveDrops().catch(console.error);
