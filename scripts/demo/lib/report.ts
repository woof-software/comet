import { BigNumber, utils } from 'ethers';
import { CometInterface, ERC20__factory } from '../../../build/types';

// Formats an 8-decimal USD value as "$1,234.56".
export const fmtUsd = (x8: BigNumber): string =>
  '$' + Number(utils.formatUnits(x8, 8)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Formats a token amount as e.g. "2.5000 WETH".
export const fmtToken = (amount: BigNumber, decimals: number, symbol: string): string =>
  `${Number(utils.formatUnits(amount, decimals)).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${symbol}`.trim();

// Formats the health factor (liquidation line ÷ debt): null means no debt → "∞".
export const fmtHealthFactor = (hf: number | null): string =>
  hf === null ? '∞  (no debt)' : `${hf.toFixed(2)}  (liq. line ÷ debt — below 1.00 = liquidatable)`;

export interface CollateralRow {
  symbol: string;
  balance: BigNumber;
  decimals: number;
  price: BigNumber; // 8-decimal USD
  valueUsd: BigNumber; // 8-decimal USD
}

export interface PositionSummary {
  rows: CollateralRow[]; // one per collateral the borrower actually holds
  collateralUsd: BigNumber;
  borrowLimitUsd: BigNumber;
  liqLineUsd: BigNumber;
  debt: BigNumber; // base units
  debtUsd: BigNumber; // 8-decimal USD
  liquidatable: boolean;
  baseScale: BigNumber;
  basePrice: BigNumber; // 8-decimal USD
  healthFactor: number | null; // liquidation line ÷ debt; null when there is no debt (∞)
}

/**
 * Reads the borrower's position across every collateral it holds, summing values, borrow limit
 * and liquidation line.
 */
export async function positionSummary(comet: CometInterface, borrower: string): Promise<PositionSummary> {
  const factorScale = await comet.factorScale();
  const baseScale = await comet.baseScale();
  const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
  const numAssets = await comet.numAssets();
  const provider = comet.provider;

  const rows: CollateralRow[] = [];
  let collateralUsd = BigNumber.from(0);
  let borrowLimitUsd = BigNumber.from(0);
  let liqLineUsd = BigNumber.from(0);

  for (let i = 0; i < numAssets; i++) {
    const info = await comet.getAssetInfo(i);
    const balance = await comet.collateralBalanceOf(borrower, info.asset);
    if (balance.isZero()) continue;
    const price = await comet.getPrice(info.priceFeed);
    const valueUsd = balance.mul(price).div(info.scale);
    collateralUsd = collateralUsd.add(valueUsd);
    borrowLimitUsd = borrowLimitUsd.add(valueUsd.mul(info.borrowCollateralFactor).div(factorScale));
    liqLineUsd = liqLineUsd.add(valueUsd.mul(info.liquidateCollateralFactor).div(factorScale));
    const decimals = info.scale.toString().length - 1;
    const symbol = await ERC20__factory.connect(info.asset, provider).symbol();
    rows.push({ symbol, balance, decimals, price, valueUsd });
  }

  const debt = await comet.borrowBalanceOf(borrower);
  const debtUsd = debt.mul(basePrice).div(baseScale);
  const liquidatable = await comet.isLiquidatable(borrower);
  // Health factor = liquidation line ÷ debt (HF < 1 ⟺ liquidatable). ∞ (null) when there is no debt.
  const healthFactor = debtUsd.isZero() ? null : Number(liqLineUsd.toString()) / Number(debtUsd.toString());

  return { rows, collateralUsd, borrowLimitUsd, liqLineUsd, debt, debtUsd, liquidatable, baseScale, basePrice, healthFactor };
}

/** Prints the borrower's position. */
export async function reportPosition(comet: CometInterface, borrower: string, title: string): Promise<void> {
  const s = await positionSummary(comet, borrower);

  console.log(`\n──────── ${title} ────────`);
  if (s.rows.length === 0) {
    console.log('  Collateral:         (none)');
  } else {
    console.log('  Collateral:');
    for (const r of s.rows) {
      console.log(`    ${fmtToken(r.balance, r.decimals, r.symbol).padEnd(22)} (worth ${fmtUsd(r.valueUsd)}) @ ${fmtUsd(r.price)}`);
    }
    console.log(`  Total collateral:   ${fmtUsd(s.collateralUsd)}`);
  }
  console.log(`  Debt owed:          ${fmtUsd(s.debtUsd)}`);
  console.log(`  Borrow limit:       ${fmtUsd(s.borrowLimitUsd)}`);
  console.log(`  Liquidation line:   ${fmtUsd(s.liqLineUsd)}`);
  console.log(`  Health factor:      ${fmtHealthFactor(s.healthFactor)}`);

  let status: string;
  if (s.liquidatable) status = '🔴 LIQUIDATABLE — debt is above the liquidation line';
  else if (s.debtUsd.gt(s.borrowLimitUsd)) status = '🟠 AT RISK — over the borrow limit, not yet liquidatable';
  else status = '🟢 HEALTHY';
  console.log(`  Status:             ${status}`);
}

// Prints market-wide totals (base liquidity, reserves).
export async function reportMarket(comet: CometInterface, title: string): Promise<void> {
  const symbol = 'USDC';
  const totalSupply = await comet.totalSupply();
  const totalBorrow = await comet.totalBorrow();
  const reserves = await comet.getReserves();
  const decimals = Number(await comet.decimals());
  console.log(`\n──────── ${title} ────────`);
  console.log(`  Total supplied:     ${fmtToken(totalSupply, decimals, symbol)}`);
  console.log(`  Total borrowed:     ${fmtToken(totalBorrow, decimals, symbol)}`);
  console.log(`  Protocol reserves:  ${fmtToken(reserves, decimals, symbol)}`);
}
