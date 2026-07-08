import hre from 'hardhat';
import { BigNumber } from 'ethers';
import { loadDemo } from '../lib/context';
import { withSnapshot } from '../lib/snapshot';
import { reportPosition, fmtToken } from '../lib/report';
import { fetch1inchSwap, oneInchRouteNames, CHAIN_ID, ONEINCH_SLIPPAGE_PCT, AMM_PROTOCOLS } from '../../../test/helpers';
import { ERC20__factory } from '../../../build/types';

/**
 * CASE 5 (04e) — Multi-collateral partial liquidation through 1inch.
 * Run:  npx hardhat run scripts/demo/dex-liquidation/04e-liquidate-multi-1inch.ts --network localhost
 */

const ACCRUAL_BUFFER_SECONDS = 30;

async function main() {
  const { comet, module, adapter, deployer, borrower } = await loadDemo();
  const provider = hre.ethers.provider;
  const usdcAddr = await comet.baseToken();

  await withSnapshot(async () => {
    console.log('════════════════════════════════════════════════════════════');
    console.log(' CASE 5 — Multi-collateral partial liquidation via 1inch');
    console.log('════════════════════════════════════════════════════════════');

    await reportPosition(comet, borrower.address, 'Before liquidation');
    if (!(await comet.isLiquidatable(borrower.address))) {
      console.log('\nBorrower is not liquidatable yet — run 02a-supply-and-borrow-multi then 03-drop-price (drop several collaterals) first.');
      return;
    }

    // Precompute the multi-collateral seizure plan at the exact block the liquidation will mine in.
    const t0 = (await provider.getBlock('latest')).timestamp;
    const execTimestamp = t0 + ACCRUAL_BUFFER_SECONDS;
    const probeId = await provider.send('evm_snapshot', []);
    await provider.send('evm_setNextBlockTimestamp', [execTimestamp]);
    await (await comet.connect(deployer).accrueAccount(borrower.address)).wait();
    const plan = await module.seizurePlan(borrower.address);
    await provider.send('evm_revert', [probeId]);

    // Quote each seized collateral on 1inch (fall back to the adapter's Uniswap route if 1inch can't route it).
    console.log(`\nSeizure plan spans ${plan.length} collateral(s) — quoting each on 1inch:`);
    const swapData: string[] = [];
    const seized: { symbol: string; asset: string; decimals: number }[] = [];
    for (const s of plan) {
      const info = await comet.getAssetInfoByAddress(s.asset);
      const decimals = info.scale.toString().length - 1;
      const symbol = await ERC20__factory.connect(s.asset, provider).symbol();
      let data = '0x';
      let via: string;
      try {
        const quote = await fetch1inchSwap({
          chainId: CHAIN_ID,
          src: s.asset,
          dst: usdcAddr,
          amount: s.seizedAmount.toString(),
          from: adapter.address,
          slippage: ONEINCH_SLIPPAGE_PCT,
          protocols: AMM_PROTOCOLS,
        });
        data = quote.data;
        via = `1inch (${oneInchRouteNames(quote.protocols).join('+') || 'route'})`;
      } catch {
        via = 'Uniswap fallback (1inch could not route)';
      }
      swapData.push(data);
      seized.push({ symbol, asset: s.asset, decimals });
      console.log(`  ${symbol}: seize ${fmtToken(s.seizedAmount, decimals, symbol)} → ${via}`);
    }

    const before = new Map<string, BigNumber>();
    for (const x of seized) before.set(x.asset, await comet.collateralBalanceOf(borrower.address, x.asset));
    const debtBefore = await comet.borrowBalanceOf(borrower.address);

    // Mine at the SAME timestamp we precomputed for, so the module recomputes the identical per-collateral seizures.
    console.log('\nKeeper calls liquidate() with per-collateral swap data...');
    await provider.send('evm_setNextBlockTimestamp', [execTimestamp]);
    await (await module.connect(deployer).liquidate(deployer.address, borrower.address, swapData)).wait();

    console.log('\nSeized & swapped into USDC:');
    for (const x of seized) {
      const after = await comet.collateralBalanceOf(borrower.address, x.asset);
      console.log(`  ${x.symbol}: ${fmtToken(before.get(x.asset)!.sub(after), x.decimals, x.symbol)}`);
    }
    const debtAfter = await comet.borrowBalanceOf(borrower.address);
    console.log(`  Debt repaid: ${fmtToken(debtBefore.sub(debtAfter), 6, 'USDC')}`);

    // Spotlight the collateral the module never touched.
    const seizedSet = new Set(seized.map((x) => x.asset.toLowerCase()));
    const untouched: string[] = [];
    const numAssets = await comet.numAssets();
    for (let i = 0; i < numAssets; i++) {
      const info = await comet.getAssetInfo(i);
      const bal = await comet.collateralBalanceOf(borrower.address, info.asset);
      if (bal.isZero() || seizedSet.has(info.asset.toLowerCase())) continue;
      const sym = await ERC20__factory.connect(info.asset, provider).symbol();
      untouched.push(fmtToken(bal, info.scale.toString().length - 1, sym));
    }
    if (untouched.length > 0) {
      console.log(`\n⚖️  Left fully untouched (proves partial liquidation): ${untouched.join(', ')}`);
    } else {
      console.log('\n⚠️  Every collateral was seized — the price drop was too deep for a partial demo; use a milder 03 drop.');
    }

    await reportPosition(comet, borrower.address, 'After liquidation');
    console.log('\n✅ Only some collaterals were partially seized and sold — the rest was left with the borrower.');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
