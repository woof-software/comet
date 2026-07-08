import hre from 'hardhat';
import { utils } from 'ethers';
import { loadDemo } from '../lib/context';
import { withSnapshot } from '../lib/snapshot';
import { reportPosition, fmtToken } from '../lib/report';
import { SimplePriceFeed__factory } from '../../../build/types';

/**
 * CASE 6 (04f) — Partial liquidation DISABLED → the FULL collateral balance is seized.
 * Run:  npx hardhat run scripts/demo/dex-liquidation/04f-full-liquidation.ts --network localhost
 */

async function main() {
  const { comet, module, wethInfo, deployer, borrower } = await loadDemo();

  await withSnapshot(async () => {
    console.log('════════════════════════════════════════════════════════════');
    console.log(' CASE 6 — Partial liquidation DISABLED → full collateral seized');
    console.log('════════════════════════════════════════════════════════════');

    await reportPosition(comet, borrower.address, 'Before');
    if ((await comet.borrowBalanceOf(borrower.address)).isZero()) {
      console.log('\nBorrower has no debt — run 02-supply-and-borrow (+ 03-drop-price) first.');
      return;
    }

    // How much PARTIAL mode would take (only enough to restore health) — the reference point.
    if (await comet.isLiquidatable(borrower.address)) {
      const partial = (await module.seizurePlan(borrower.address))[0].seizedAmount;
      console.log(`\nPartial mode (cases 1‑2) would seize only ${fmtToken(partial, 18, 'WETH')} — just enough to restore health.`);
    }

    // Pauser disables partial liquidation → debt‑closing mode.
    console.log('\nPauser calls liquidationModeToggle(false)...');
    await (await module.connect(deployer).liquidationModeToggle(false)).wait();
    console.log(`  partialLiquidationEnabled = ${await module.partialLiquidationEnabled()}`);

    const plan = (await module.seizurePlan(borrower.address))[0].seizedAmount;
    console.log(`\nFull/debt-closing mode will seize ${fmtToken(plan, 18, 'WETH')} — the entire balance.`);

    const collateralBefore = await comet.collateralBalanceOf(borrower.address, wethInfo.asset);
    const debtBefore = await comet.borrowBalanceOf(borrower.address);

    // Absorb: seizes the collateral into reserves and writes off any shortfall as bad debt.
    console.log('Absorbing the borrower...');
    await (await module.connect(deployer).liquidate(deployer.address, borrower.address, ['0x'])).wait();

    const collateralAfter = await comet.collateralBalanceOf(borrower.address, wethInfo.asset);
    const debtAfter = await comet.borrowBalanceOf(borrower.address);
    console.log(`\n  Collateral seized: ${fmtToken(collateralBefore.sub(collateralAfter), 18, 'WETH')} of ${fmtToken(collateralBefore, 18, 'WETH')}  (FULL balance)`);
    console.log(`  Debt cleared:      ${fmtToken(debtBefore.sub(debtAfter), 6, 'USDC')}`);

    await reportPosition(comet, borrower.address, 'After full liquidation');
    console.log('\n✅ With partial liquidation disabled, the ENTIRE collateral balance was seized to close the debt.');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
