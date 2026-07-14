import hre from 'hardhat';

export async function withSnapshot(body: () => Promise<void>): Promise<void> {
  const provider = hre.ethers.provider;
  const snapshotId: string = await provider.send('evm_snapshot', []);
  try {
    await body();
  } finally {
    await provider.send('evm_revert', [snapshotId]);
    console.log('\n↩️  State restored to the pre-liquidation setup — run another 04-* case next.');
  }
}
