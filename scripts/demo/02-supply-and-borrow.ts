import { readFileSync } from 'fs';
import path from 'path';
import { constants, utils, BigNumber } from 'ethers';
import { setErc20Balance } from '../../test/helpers';
import { loadDemo } from './lib/context';
import { reportPosition, reportMarket, fmtToken } from './lib/report';

/**
 * STEP 2 — after deployment, the lender lends USDC, the borrower deposits WETH and borrows USDC up to (almost)
 * the limit. Funding amounts come from scripts/demo/demo.json; token slots come from the market config.
 * Run:  npx hardhat run scripts/demo/02-supply-and-borrow.ts --network localhost
 */

// Parses "2.5e18" / "10000e6" into base units.
const sci = (s: string): BigNumber => {
  const [mantissa, exponent = '0'] = s.split('e');
  return utils.parseUnits(mantissa, Number(exponent));
};

async function main() {
  const { comet, usdc, weth, wethInfo, lender, borrower } = await loadDemo();
  const demo = JSON.parse(readFileSync(path.join(__dirname, 'demo.json'), 'utf8')) as {
    lenderSupplyUSDC: string;
    collaterals: Record<string, string>;
  };
  const cfg = JSON.parse(
    readFileSync(path.join(__dirname, '../../deployments/localhost/usdc-dex/configuration.json'), 'utf8')
  ) as { baseTokenSlot: number; assets: Record<string, { slot: number }> };

  console.log('════════════════════════════════════════════════════════════');
  console.log(' STEP 2 — Lender lends USDC · Borrower deposits WETH & borrows');
  console.log('════════════════════════════════════════════════════════════');

  // 1) Fund the lender with USDC and supply it all as market liquidity.
  const lenderUsdc = sci(demo.lenderSupplyUSDC);
  await setErc20Balance(usdc.address, lender.address, lenderUsdc, cfg.baseTokenSlot);
  console.log(`\n1) Lender deposits ${fmtToken(lenderUsdc, 6, 'USDC')} into the market.`);
  await (await usdc.connect(lender).approve(comet.address, constants.MaxUint256)).wait();
  await (await comet.connect(lender).supply(usdc.address, lenderUsdc)).wait();

  // 2) Fund the borrower with WETH and deposit it all as collateral.
  const borrowerWeth = sci(demo.collaterals.WETH);
  await setErc20Balance(weth.address, borrower.address, borrowerWeth, cfg.assets.WETH.slot);
  console.log(`2) Borrower deposits ${fmtToken(borrowerWeth, 18, 'WETH')} as collateral.`);
  await (await weth.connect(borrower).approve(comet.address, constants.MaxUint256)).wait();
  await (await comet.connect(borrower).supply(weth.address, borrowerWeth)).wait();

  await reportPosition(comet, borrower.address, 'Borrower after depositing collateral (no debt yet)');

  // 3) Borrower borrows ~99% of the borrow limit.
  const price = await comet.getPrice(wethInfo.priceFeed);
  const collateralUsd = borrowerWeth.mul(price).div(wethInfo.scale);
  const borrowLimitUsd = collateralUsd.mul(wethInfo.borrowCollateralFactor).div(await comet.factorScale());
  const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
  const baseScale = await comet.baseScale();
  const borrowBase = borrowLimitUsd.mul(baseScale).div(basePrice).mul(99).div(100); // 99% of the borrow limit

  console.log(`\n3) Borrower borrows ${fmtToken(borrowBase, 6, 'USDC')} (99% of the borrow limit).`);
  await (await comet.connect(borrower).withdraw(usdc.address, borrowBase)).wait();

  await reportPosition(comet, borrower.address, 'Borrower after borrowing');
  await reportMarket(comet, 'Market');
  console.log('\n✅ The position is set up and HEALTHY. Next: 03-drop-price makes it liquidatable.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
