/**
 * Create a (near-underwater) borrow position on a Comet test deployment across one or more collaterals,
 * then drop their price feeds to make the account liquidatable — the setup step for the slot-targeted
 * liquidation flow (seizure-plan-at.ts → liquidate-at-slot.ts).
 *
 * Flow (BORROWER):
 *   1. supply each collateral in COLLATERALS (optional, per amount),
 *   2. borrow up to BORROW_PCT % of the AGGREGATE borrow capacity (negative base = a real borrow),
 *   3. drop every collateral price feed by the same factor so the aggregate liquidation value falls to
 *      LIQUIDATABLE_HEALTH_BPS of the debt. The borrower is an admin of the (test) feeds, so it signs
 *      setPrice/setUseSourceFeed directly — no impersonation.
 *
 * Base liquidity is NOT supplied here — seed it in advance from a SEPARATE account. The borrower must
 * hold no base: otherwise `withdraw` is a lender withdrawal (paused on this deployment as
 * LendersWithdrawPaused) instead of a borrow.
 *
 * At the end it prints what was supplied/borrowed and each feed's price change, including the INITIAL
 * prices so you know what to restore afterwards.
 *
 * Env: RPC_URL, BORROWER_KEY.
 * Run:  npx ts-node scripts/dex-liquidation/create-borrow-position.ts
 */
import 'dotenv/config';
import { ethers, BigNumber } from 'ethers';

// ══════════════════════════════════════ CONSTANTS ══════════════════════════════════════
const COMET = '0xED74b401Ab74a07E4C0ce16D24dbdfcEa721e32E';

// Collaterals to supply and borrow against (each must be listed on the Comet). `amount` is in human
// units; set it to '0' to skip supplying that one but still borrow against an existing balance.
const COLLATERALS: { address: string, amount: string }[] = [
  { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', amount: '0.02' }, // WETH
  //{ address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', amount: '0.00077' }, // WBTC
];

// Supply the amounts above first (true), or borrow against collateral the account already holds (false).
const SUPPLY_COLLATERAL = false;

// How much of borrow capacity to draw (borrow), as a percent.
const BORROW_PCT = 99;

// Target liquidation health after the price drop, in bps of the debt. < 10000 ⇒ liquidatable.
// (Mirrors the fork test's ~98% drop; interest accrual only pushes it further under water over time.)
const LIQUIDATABLE_HEALTH_BPS = 9800;

// ═══════════════════════════════════════ ENV ═══════════════════════════════════════════
const provider = new ethers.providers.JsonRpcProvider(reqEnv('RPC_URL'));
const borrower = new ethers.Wallet(reqEnv('BORROWER_KEY'), provider);

const COMET_ABI = [
  'function baseToken() view returns (address)',
  'function baseTokenPriceFeed() view returns (address)',
  'function baseScale() view returns (uint64)',
  'function factorScale() view returns (uint64)',
  'function baseBorrowMin() view returns (uint256)',
  'function getPrice(address priceFeed) view returns (uint256)',
  'function getAssetInfoByAddress(address asset) view returns (tuple(uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))',
  'function balanceOf(address account) view returns (uint256)',
  'function collateralBalanceOf(address account, address asset) view returns (uint128)',
  'function borrowBalanceOf(address account) view returns (uint256)',
  'function isLiquidatable(address account) view returns (bool)',
  'function supply(address asset, uint256 amount)',
  'function withdraw(address asset, uint256 amount)',
  // Custom errors, so a callStatic revert decodes to a name instead of an opaque CALL_EXCEPTION.
  'error LendersWithdrawPaused()',
  'error BorrowersWithdrawPaused()',
  'error BorrowTooSmall()',
  'error NotCollateralized()',
  'error ExceedsSupportedUtilization()',
  'error Paused()',
  'error Unauthorized()',
];
const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
const FEED_ABI = ['function setPrice(int256)', 'function setUseSourceFeed(bool)'];

interface Coll {
  address: string; symbol: string; decimals: number; scale: BigNumber;
  bcf: BigNumber; lcf: BigNumber; lf: BigNumber; feed: string; priceInit: BigNumber;
  balance: BigNumber; valueBase: BigNumber; priceNew: BigNumber;
}

// ═════════════════════════════════════ HELPERS ═════════════════════════════════════════
function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function revertReason(e: unknown): string {
  const err = e as { errorName?: string, reason?: string, message?: string };
  return err.errorName ?? err.reason ?? err.message ?? String(e);
}

async function ensureAllowance(token: ethers.Contract, spender: string, amount: BigNumber): Promise<void> {
  if ((await token.allowance(borrower.address, spender)).gte(amount)) return;
  console.log(`  approving ${await token.symbol()}...`);
  await (await token.connect(borrower).approve(spender, ethers.constants.MaxUint256)).wait();
}

// ═══════════════════════════════════════ MAIN ══════════════════════════════════════════
async function main() {
  const comet = new ethers.Contract(COMET, COMET_ABI, provider);
  const baseAddr: string = await comet.baseToken();
  const baseScale: BigNumber = await comet.baseScale();
  const factorScale: BigNumber = await comet.factorScale();
  const base = new ethers.Contract(baseAddr, ERC20_ABI, provider);
  const baseDecimals: number = await base.decimals();
  const baseSymbol: string = await base.symbol();
  const basePrice: BigNumber = await comet.getPrice(await comet.baseTokenPriceFeed());

  // Fail fast: a borrower must not already hold base, or `withdraw` is a (paused) lender withdrawal
  // rather than a borrow.
  const borrowerBase: BigNumber = await comet.balanceOf(borrower.address);
  if (borrowerBase.gt(0)) {
    throw new Error(
      `Borrower ${borrower.address} already holds ${ethers.utils.formatUnits(borrowerBase, baseDecimals)} ${baseSymbol} of base supply. ` +
      `A borrower must hold no base — otherwise withdraw is a lender withdrawal (LendersWithdrawPaused here) and never creates a borrow. ` +
      `Use a fresh borrower account.`
    );
  }

  // ── 1. supply each collateral (optional) ──
  for (const c of COLLATERALS) {
    const token = new ethers.Contract(c.address, ERC20_ABI, provider);
    const [decimals, symbol] = [await token.decimals(), await token.symbol()];
    if (!SUPPLY_COLLATERAL || Number(c.amount) <= 0) continue;
    const amount = ethers.utils.parseUnits(c.amount, decimals);
    if ((await token.balanceOf(borrower.address)).lt(amount)) throw new Error(`Borrower lacks ${c.amount} ${symbol}.`);
    await ensureAllowance(token, COMET, amount);
    console.log(`Supplying ${c.amount} ${symbol}...`);
    await (await comet.connect(borrower).supply(c.address, amount)).wait();
  }

  // ── 2. aggregate borrow capacity across every collateral actually held ──
  let totalValue = BigNumber.from(0), capacity = BigNumber.from(0), liqLine = BigNumber.from(0);
  let sumValLf = BigNumber.from(0), sumValBcf = BigNumber.from(0);
  const active: Coll[] = [];
  for (const c of COLLATERALS) {
    const info = await comet.getAssetInfoByAddress(c.address);
    const token = new ethers.Contract(c.address, ERC20_ABI, provider);
    const balance: BigNumber = await comet.collateralBalanceOf(borrower.address, c.address);
    if (balance.isZero()) continue;
    const priceInit: BigNumber = await comet.getPrice(info.priceFeed);
    const valueBase = balance.mul(priceInit).mul(baseScale).div(info.scale.mul(basePrice));
    totalValue = totalValue.add(valueBase);
    capacity = capacity.add(valueBase.mul(info.borrowCollateralFactor).div(factorScale));
    liqLine = liqLine.add(valueBase.mul(info.liquidateCollateralFactor).div(factorScale));
    sumValLf = sumValLf.add(valueBase.mul(info.liquidationFactor));
    sumValBcf = sumValBcf.add(valueBase.mul(info.borrowCollateralFactor));
    active.push({
      address: c.address, symbol: await token.symbol(), decimals: await token.decimals(), scale: info.scale,
      bcf: info.borrowCollateralFactor, lcf: info.liquidateCollateralFactor, lf: info.liquidationFactor,
      feed: info.priceFeed, priceInit, balance, valueBase, priceNew: BigNumber.from(0),
    });
  }
  if (active.length === 0) throw new Error('Borrower holds none of COLLATERALS — set SUPPLY_COLLATERAL = true or fund the collaterals.');
  const lfAvg = sumValLf.div(totalValue);   // value-weighted liquidation factor (1e18)
  const bcfAvg = sumValBcf.div(totalValue); // value-weighted borrow collateral factor (1e18)

  const targetDebt = capacity.mul(BORROW_PCT).div(100);                       // intended TOTAL debt
  const existingDebt: BigNumber = await comet.borrowBalanceOf(borrower.address);
  if (existingDebt.gte(targetDebt)) {
    throw new Error(
      `Account already owes ${ethers.utils.formatUnits(existingDebt, baseDecimals)} ${baseSymbol} ≥ target ` +
      `${ethers.utils.formatUnits(targetDebt, baseDecimals)} ${baseSymbol} (${BORROW_PCT}% of capacity). Repay it or use a fresh borrower.`
    );
  }
  const borrowAmount = targetDebt.sub(existingDebt);                          // the additional withdraw

  const baseBorrowMin: BigNumber = await comet.baseBorrowMin();
  if (targetDebt.lt(baseBorrowMin)) {
    throw new Error(
      `Total debt ${ethers.utils.formatUnits(targetDebt, baseDecimals)} ${baseSymbol} < baseBorrowMin ` +
      `${ethers.utils.formatUnits(baseBorrowMin, baseDecimals)} ${baseSymbol}. Increase collateral amounts.`
    );
  }

  // Predict PARTIAL vs FULL from the AGGREGATE (value-weighted factors; exact when collaterals share
  // factors). A partial restores HF to 1.05 and leaves a residual; if the residual would fall to/below
  // baseBorrowMin, Comet's min-debt rule force-closes the WHOLE debt — see SeizureCalculations.sol.
  const THF = factorScale.mul(105).div(100); // TARGET_HEALTH_FACTOR = 1.05
  const tcAtDrop = capacity.mul(targetDebt).mul(LIQUIDATABLE_HEALTH_BPS).div(10000).div(liqLine); // dropFactor · capacity
  const denom = lfAvg.mul(THF).div(factorScale).sub(bcfAvg);
  let wanted = targetDebt.mul(THF).div(factorScale).sub(tcAtDrop).mul(factorScale).div(denom);
  const maxWanted = targetDebt.mul(factorScale).div(lfAvg);
  if (wanted.gt(maxWanted)) wanted = maxWanted;
  const seizedValue = wanted.mul(lfAvg).div(factorScale);
  const residual = targetDebt.gt(seizedValue) ? targetDebt.sub(seizedValue) : BigNumber.from(0);
  const minResidual = baseBorrowMin.mul(2);
  if (residual.lte(minResidual)) {
    throw new Error(
      `Would be a FULL liquidation, not partial: predicted residual after restoring to HF 1.05 is ~` +
      `${ethers.utils.formatUnits(residual, baseDecimals)} ${baseSymbol} ≤ 2× baseBorrowMin ` +
      `(${ethers.utils.formatUnits(minResidual, baseDecimals)} ${baseSymbol}). The debt is too small — increase collateral amounts.`
    );
  }

  // Surface the exact revert before sending a real tx.
  try {
    await comet.connect(borrower).callStatic.withdraw(baseAddr, borrowAmount);
  } catch (e) {
    throw new Error(`Borrow would revert: ${revertReason(e)}. ` +
      `(NotCollateralized ⇒ borrow exceeds the collateral limit — often an existing debt; ExceedsSupportedUtilization ⇒ pool needs more base liquidity.)`);
  }

  console.log(`Borrowing ${ethers.utils.formatUnits(borrowAmount, baseDecimals)} ${baseSymbol} → total debt ${ethers.utils.formatUnits(targetDebt, baseDecimals)} ${baseSymbol} (${BORROW_PCT}% of capacity)...`);
  await (await comet.connect(borrower).withdraw(baseAddr, borrowAmount)).wait();
  const borrowBalance: BigNumber = await comet.borrowBalanceOf(borrower.address);

  // ── 3. drop every collateral feed by the same factor until the aggregate is liquidatable ──
  // newPrice_i / oldPrice_i = targetLiquidationValue / currentLiquidationLine  (same for all feeds).
  const targetLiq = borrowBalance.mul(LIQUIDATABLE_HEALTH_BPS).div(10000);
  for (const c of active) {
    c.priceNew = c.priceInit.mul(targetLiq).div(liqLine);
    const feed = new ethers.Contract(c.feed, FEED_ABI, borrower);
    console.log(`Dropping ${c.symbol} feed ${c.feed}: ${c.priceInit} → ${c.priceNew}...`);
    await (await feed.setPrice(c.priceNew)).wait();
    await (await feed.setUseSourceFeed(false)).wait();
  }

  const liquidatable: boolean = await comet.isLiquidatable(borrower.address);

  // ── Summary ──
  const px = (p: BigNumber) => `$${ethers.utils.formatUnits(p, 8)}`;
  console.log('\n──────────── position created ────────────');
  console.log(`Borrower:        ${borrower.address}`);
  console.log('Collateral:');
  for (const c of active) {
    console.log(`  ${ethers.utils.formatUnits(c.balance, c.decimals)} ${c.symbol} (worth ${px(c.valueBase.mul(basePrice).div(baseScale))})`);
  }
  console.log(`Borrowed:        ${ethers.utils.formatUnits(borrowBalance, baseDecimals)} ${baseSymbol}`);
  console.log(`Partial residual:~${ethers.utils.formatUnits(residual, baseDecimals)} ${baseSymbol} (> baseBorrowMin ${ethers.utils.formatUnits(baseBorrowMin, baseDecimals)} ⇒ partial)`);
  console.log('Feed price drops (restore with setUseSourceFeed(true) OR setPrice(<initial>)):');
  for (const c of active) {
    console.log(`  ${c.symbol}: ${px(c.priceInit)} → ${px(c.priceNew)}   feed ${c.feed}   initial=${c.priceInit.toString()}`);
  }
  console.log(`isLiquidatable:  ${liquidatable}`);
  if (!liquidatable) console.log('⚠️  not liquidatable — lower LIQUIDATABLE_HEALTH_BPS and retry (or a feed rejected the price).');
  console.log('──────────────────────────────────────────');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
