import hre from 'hardhat';
import { loadDemo } from '../lib/context';
import { withSnapshot } from '../lib/snapshot';
import { reportPosition, fmtToken } from '../lib/report';
import { fetch1inchSwap, oneInchRouteNames, CHAIN_ID, ONEINCH_SLIPPAGE_PCT, AMM_PROTOCOLS } from '../../../test/helpers';

/**
 * CASE 1 — Partial liquidation through 1inch.
 * Run:  npx hardhat run scripts/demo/dex-liquidation/04a-liquidate-via-1inch.ts --network localhost
 */

// The liquidation is mined this many seconds in the future; the borrower's debt keeps accruing until then.
const ACCRUAL_BUFFER_SECONDS = 30;

async function main() {
  const { comet, module, seizureView, adapter, wethInfo, usdc, deployer, borrower } = await loadDemo();
  const provider = hre.ethers.provider;

  await withSnapshot(async () => {
    console.log('════════════════════════════════════════════════════════════');
    console.log(' CASE 1 — Partial liquidation, collateral SWAPPED on 1inch');
    console.log('════════════════════════════════════════════════════════════');

    await reportPosition(comet, borrower.address, 'Before liquidation');
    if (!(await comet.isLiquidatable(borrower.address))) {
      console.log('\nBorrower is not liquidatable yet — run 02-supply-and-borrow then 03-drop-price first.');
      return;
    }

    const seizureNow = (await module.seizurePlan(borrower.address))[0].seizedAmount;

    const t0 = (await provider.getBlock('latest')).timestamp;
    const execTimestamp = t0 + ACCRUAL_BUFFER_SECONDS;
    const seizedAmount = (await seizureView.seizurePlanAt(borrower.address, execTimestamp))[0].seizedAmount;

    console.log('\nModule will swap WETH into USDC on 1inch:');
    console.log(`  seizure now:            ${fmtToken(seizureNow, 18, 'WETH')}`);
    console.log(`  seizure at liquidation: ${fmtToken(seizedAmount, 18, 'WETH')}  (debt accrues ~${ACCRUAL_BUFFER_SECONDS}s until then)`);
    console.log(`Quoting ${fmtToken(seizedAmount, 18, 'WETH')} on 1inch...`);

    const quote = await fetch1inchSwap({
      chainId: CHAIN_ID,
      src: wethInfo.asset,
      dst: usdc.address,
      amount: seizedAmount.toString(),
      from: adapter.address,
      slippage: ONEINCH_SLIPPAGE_PCT,
      protocols: AMM_PROTOCOLS,
    });
    const swapData = quote.data;
    const route = oneInchRouteNames(quote.protocols);
    console.log(`  1inch routed the swap through: ${route.length ? route.join(' + ') : '(not reported)'}`);

    const collateralBefore = await comet.collateralBalanceOf(borrower.address, wethInfo.asset);
    const debtBefore = await comet.borrowBalanceOf(borrower.address);
    const reservesBefore = await comet.getReserves();

    // Mine the liquidation at the SAME timestamp we precomputed for, so the module accrues to the identical state
    // and recomputes exactly `seizedAmount` — matching the amount baked into the 1inch calldata.
    console.log('Keeper calls liquidate() with the 1inch swap data...');
    await provider.send('evm_setNextBlockTimestamp', [execTimestamp]);
    await (await module.connect(deployer).liquidate(deployer.address, borrower.address, [swapData])).wait();

    const collateralAfter = await comet.collateralBalanceOf(borrower.address, wethInfo.asset);
    const debtAfter = await comet.borrowBalanceOf(borrower.address);
    const reservesAfter = await comet.getReserves();
    console.log(`\n  Collateral seized & sold: ${fmtToken(collateralBefore.sub(collateralAfter), 18, 'WETH')}`);
    console.log(`  Debt repaid:              ${fmtToken(debtBefore.sub(debtAfter), 6, 'USDC')}`);
    console.log(`  Protocol USDC reserves:   ${fmtToken(reservesBefore, 6, 'USDC')} → ${fmtToken(reservesAfter, 6, 'USDC')}  (+${fmtToken(reservesAfter.sub(reservesBefore), 6, 'USDC')} from the swap)`);

    await reportPosition(comet, borrower.address, 'After liquidation');
    console.log('\n✅ The borrower is healthy again — only PART of the collateral was seized (partial liquidation).');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
