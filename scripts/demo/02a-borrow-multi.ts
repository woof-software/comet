import { loadDemo } from './lib/context';
import { positionSummary, reportPosition, reportMarket, fmtToken } from './lib/report';

/**
 * STEP 2a (borrow) — opens the borrow position on the multi-collateral setup created by 02a-supply-multi:
 * the borrower borrows ~99% of the combined borrow limit.
 * Run:  npx hardhat run scripts/demo/02a-borrow-multi.ts --network localhost
 */
async function main() {
  const { comet, usdc, borrower } = await loadDemo();

  console.log('════════════════════════════════════════════════════════════');
  console.log(' STEP 2a (borrow) — Borrow ~99% of the combined limit');
  console.log('════════════════════════════════════════════════════════════');

  const s = await positionSummary(comet, borrower.address);
  if (s.borrowLimitUsd.isZero()) {
    console.log('\nBorrower has no collateral — run 02a-supply-multi first.');
    return;
  }

  // 99% of the remaining borrow limit (debt is 0 right after supplying).
  const borrowBase = s.borrowLimitUsd.sub(s.debtUsd).mul(s.baseScale).div(s.basePrice).mul(99).div(100);
  console.log(`\nBorrower borrows ${fmtToken(borrowBase, 6, 'USDC')} (99% of the combined borrow limit).`);
  await (await comet.connect(borrower).withdraw(usdc.address, borrowBase)).wait();

  await reportPosition(comet, borrower.address, 'Borrower after borrowing');
  await reportMarket(comet, 'Market');
  console.log('\n✅ Multi-collateral position set up and HEALTHY.');
  console.log('   Next: 03-drop-price then 04e. For a partial multi-liquidation (seize 3, leave UNI):');
  console.log('   WETH_PRICE=1250 WBTC_PRICE=47000 LINK_PRICE=8 UNI_PRICE=6 npx hardhat run scripts/demo/03-drop-price.ts --network localhost');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
