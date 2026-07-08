import { loadDemo } from '../lib/context';
import { withSnapshot } from '../lib/snapshot';
import { reportPosition, fmtToken } from '../lib/report';

/**
 * CASE 4 — Absorb a borrower whose collateral has been deactivated.
 * Run:  npx hardhat run scripts/demo/dex-liquidation/04d-absorb-deactivated.ts --network localhost
 */
async function main() {
  const { comet, module, wethInfo, deployer, borrower } = await loadDemo();

  await withSnapshot(async () => {
    console.log('════════════════════════════════════════════════════════════');
    console.log(' CASE 4 — Collateral deactivated → ABSORB');
    console.log('════════════════════════════════════════════════════════════');

    await reportPosition(comet, borrower.address, 'Before liquidation');
    if (!(await comet.isLiquidatable(borrower.address))) {
      console.log('\nBorrower is not liquidatable yet — run 02-supply-and-borrow then 03-drop-price first.');
      return;
    }

    console.log(`\nPause guardian deactivates WETH (asset #${wethInfo.offset})...`);
    await (await comet.connect(deployer).deactivateCollateral(wethInfo.offset)).wait();
    console.log(`  WETH deactivated: ${await comet.isCollateralDeactivated(wethInfo.offset)}`);

    const reservesBefore = await comet.getCollateralReserves(wethInfo.asset);
    const collateralBefore = await comet.collateralBalanceOf(borrower.address, wethInfo.asset);
    const debtBefore = await comet.borrowBalanceOf(borrower.address);
    console.log('Protocol absorbs the underwater borrower...');
    await (await module.connect(deployer).liquidate(deployer.address, borrower.address, ["0x"])).wait();

    const reservesAfter = await comet.getCollateralReserves(wethInfo.asset);
    const collateralAfter = await comet.collateralBalanceOf(borrower.address, wethInfo.asset);
    const debtAfter = await comet.borrowBalanceOf(borrower.address);
    console.log(`\n  Collateral swapped into USDC via 1Inch: ${fmtToken(collateralBefore.sub(collateralAfter), 18, 'WETH')}`);
    console.log(`  Protocol WETH reserves:          ${fmtToken(reservesBefore, 18, 'WETH')} → ${fmtToken(reservesAfter, 18, 'WETH')}`);
    console.log(`  Debt written down:               ${fmtToken(debtBefore.sub(debtAfter), 6, 'USDC')}`);

    await reportPosition(comet, borrower.address, 'After absorb');
    console.log('\n✅ The deactivated collateral was absorbed into reserves and the debt was written down.');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
