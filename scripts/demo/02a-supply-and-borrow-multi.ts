import { readFileSync } from 'fs';
import path from 'path';
import { constants, utils, BigNumber } from 'ethers';
import { ERC20__factory } from '../../build/types';
import { setErc20Balance } from '../../test/helpers';
import { loadDemo } from './lib/context';
import { positionSummary, reportPosition, reportMarket, fmtToken } from './lib/report';

/**
 * STEP 2a — multi-collateral option of step 2. The lender lends USDC; the borrower deposits all configured
 * collaterals from scripts/demo/demo.json and borrows up to the combined limit.
 * Run:  npx hardhat run scripts/demo/02a-supply-and-borrow-multi.ts --network localhost
 */

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
  console.log(' STEP 2a — Multi-collateral: borrower supplies WETH + extras & borrows');
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

  // 3) Borrow ~99% of the combined borrow limit.
  const s = await positionSummary(comet, borrower.address);
  const borrowBase = s.borrowLimitUsd.sub(s.debtUsd).mul(s.baseScale).div(s.basePrice).mul(99).div(100);
  console.log(`\n3) Borrower borrows ${fmtToken(borrowBase, 6, 'USDC')} (99% of the combined borrow limit).`);
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
