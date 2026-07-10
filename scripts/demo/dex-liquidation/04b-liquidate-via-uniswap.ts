import { loadDemo } from '../lib/context';
import { withSnapshot } from '../lib/snapshot';
import { reportPosition, fmtToken } from '../lib/report';

/**
 * CASE 2 — Partial liquidation through the secondary market (Uniswap).
 * Empty swap data is passed to simulate error on 1Inch side.
 * Run:  npx hardhat run scripts/demo/dex-liquidation/04b-liquidate-via-uniswap.ts --network localhost
 */
async function main() {
  const { comet, module, wethInfo, deployer, borrower } = await loadDemo();

  await withSnapshot(async () => {
    console.log('════════════════════════════════════════════════════════════');
    console.log(' CASE 2 — Partial liquidation, collateral SWAPPED on Uniswap');
    console.log('════════════════════════════════════════════════════════════');

    await reportPosition(comet, borrower.address, 'Before liquidation');
    if (!(await comet.isLiquidatable(borrower.address))) {
      console.log('\nBorrower is not liquidatable yet — run 02-supply-and-borrow then 03-drop-price first.');
      return;
    }

    const collateralBefore = await comet.collateralBalanceOf(borrower.address, wethInfo.asset);
    const debtBefore = await comet.borrowBalanceOf(borrower.address);
    const reservesBefore = await comet.getReserves();

    console.log('\nKeeper calls liquidate() with empty 1Inch data simulating 1Inch swap error — the adapter uses its Uniswap route instead...');
    await (await module.connect(deployer).liquidate(deployer.address, borrower.address, ['0x'])).wait();

    const collateralAfter = await comet.collateralBalanceOf(borrower.address, wethInfo.asset);
    const debtAfter = await comet.borrowBalanceOf(borrower.address);
    const reservesAfter = await comet.getReserves();
    console.log(`\n  Collateral seized & sold: ${fmtToken(collateralBefore.sub(collateralAfter), 18, 'WETH')}`);
    console.log(`  Debt repaid:              ${fmtToken(debtBefore.sub(debtAfter), 6, 'USDC')}`);
    console.log(`  Protocol USDC reserves:   ${fmtToken(reservesBefore, 6, 'USDC')} → ${fmtToken(reservesAfter, 6, 'USDC')}  (+${fmtToken(reservesAfter.sub(reservesBefore), 6, 'USDC')} from the swap)`);

    await reportPosition(comet, borrower.address, 'After liquidation');
    console.log('\n✅ Same partial liquidation as case 1, but the collateral was sold on Uniswap (secondary market).');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
