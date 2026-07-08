import hre from 'hardhat';
import { utils } from 'ethers';
import { SimplePriceFeed__factory, ERC20__factory } from '../../build/types';
import { loadDemo } from './lib/context';
import { reportPosition } from './lib/report';

/**
 * STEP 3 — crash collateral prices so the borrower's debt exceeds its liquidation line.
 *
 * By default only WETH is dropped, to $1300 (set WETH_PRICE to change it). To also drop the other collaterals
 * (needed to make a multi-collateral position from 02a liquidatable) set <SYMBOL>_PRICE, e.g.:
 *   WETH_PRICE=800 WBTC_PRICE=40000 LINK_PRICE=8 UNI_PRICE=3 npx hardhat run scripts/demo/03-drop-price.ts --network localhost
 */
async function main() {
  const { comet, deployer, borrower } = await loadDemo();
  const provider = hre.ethers.provider;

  console.log('════════════════════════════════════════════════════════════');
  console.log(' STEP 3 — Crash collateral prices to push the borrower underwater');
  console.log('════════════════════════════════════════════════════════════');

  await reportPosition(comet, borrower.address, 'Before the price drop');

  // Build the set of drops: WETH defaults to $1300; every other collateral drops only if <SYMBOL>_PRICE is set.
  const numAssets = await comet.numAssets();
  const drops: { symbol: string; feed: string; price: string }[] = [];
  for (let i = 0; i < numAssets; i++) {
    const info = await comet.getAssetInfo(i);
    const symbol = (await ERC20__factory.connect(info.asset, provider).symbol()).toUpperCase();
    const envPrice = process.env[`${symbol}_PRICE`];
    const price = symbol === 'WETH' ? envPrice ?? '1300' : envPrice;
    if (price !== undefined) drops.push({ symbol, feed: info.priceFeed, price });
  }

  console.log(`\nDropping: ${drops.map((d) => `${d.symbol}→$${d.price}`).join(', ')}`);
  for (const d of drops) {
    await (await SimplePriceFeed__factory.connect(d.feed, deployer).setRoundData(0, utils.parseUnits(d.price, 8), 0, 0, 0)).wait();
  }

  await reportPosition(comet, borrower.address, 'After the price drop');

  const liquidatable = await comet.isLiquidatable(borrower.address);
  console.log(
    liquidatable
      ? '\n⚠️  The borrower is now LIQUIDATABLE. Next: run one of the 04-* liquidation cases (04e for multi-collateral).'
      : '\nStill healthy — drop further / drop more collaterals, e.g. WETH_PRICE=800 WBTC_PRICE=40000 LINK_PRICE=8 UNI_PRICE=3.'
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
