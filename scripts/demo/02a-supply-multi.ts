import { readFileSync } from 'fs';
import path from 'path';
import { constants, utils, BigNumber } from 'ethers';
import { ERC20__factory } from '../../build/types';
import { setErc20Balance } from '../../test/helpers';
import { loadDemo } from './lib/context';
import { reportPosition, fmtToken } from './lib/report';

/**
 * STEP 2a (supply) — multi-collateral setup: the lender lends USDC and the borrower deposits every collateral
 * from scripts/demo/demo.json. Run 02a-borrow-multi next to open the borrow position.
 * Run:  npx hardhat run scripts/demo/02a-supply-multi.ts --network localhost
 */

// Parses "0.05e8" / "10000e6" into base units.
const sci = (s: string): BigNumber => {
  const [mantissa, exponent = '0'] = s.split('e');
  return utils.parseUnits(mantissa, Number(exponent));
};

async function main() {
  const { comet, usdc, lender, borrower } = await loadDemo();
  const demo = JSON.parse(readFileSync(path.join(__dirname, 'demo.json'), 'utf8')) as {
    lenderSupplyUSDC: string;
    collaterals: Record<string, string>;
  };
  const cfg = JSON.parse(
    readFileSync(path.join(__dirname, '../../deployments/localhost/usdc-dex/configuration.json'), 'utf8')
  ) as { baseTokenSlot: number; assets: Record<string, { address: string; slot: number; decimals: string }> };

  console.log('════════════════════════════════════════════════════════════');
  console.log(' STEP 2a (supply) — Lender lends USDC · Borrower deposits collaterals');
  console.log('════════════════════════════════════════════════════════════');

  // 1) Fund the lender with USDC and supply it as market liquidity.
  const lenderUsdc = sci(demo.lenderSupplyUSDC);
  await setErc20Balance(usdc.address, lender.address, lenderUsdc, cfg.baseTokenSlot);
  console.log(`\n1) Lender deposits ${fmtToken(lenderUsdc, 6, 'USDC')} into the market.`);
  await (await usdc.connect(lender).approve(comet.address, constants.MaxUint256)).wait();
  await (await comet.connect(lender).supply(usdc.address, lenderUsdc)).wait();

  // 2) Fund + deposit every configured collateral.
  console.log('2) Borrower deposits collateral:');
  for (const [symbol, amountStr] of Object.entries(demo.collaterals)) {
    const a = cfg.assets[symbol];
    const amount = sci(amountStr);
    await setErc20Balance(a.address, borrower.address, amount, a.slot);
    const token = ERC20__factory.connect(a.address, borrower);
    await (await token.approve(comet.address, constants.MaxUint256)).wait();
    await (await comet.connect(borrower).supply(a.address, amount)).wait();
    console.log(`   + ${fmtToken(amount, Number(a.decimals), symbol)}`);
  }

  await reportPosition(comet, borrower.address, 'Borrower after depositing collateral (no debt yet)');
  console.log('\n✅ Collateral supplied. Next: 02a-borrow-multi to open the borrow position.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
