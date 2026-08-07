/**
 * Show a liquidatable borrower's position and exactly how it will be liquidated (through which DEX
 * protocols, for what amounts) at a FUTURE, slot-aligned timestamp, and produce the
 * `liquidate(absorber, account, swapData)` calldata to sign in the Safe.
 *
 * You give it a rough lead time (e.g. ~5 or ~10 minutes from now via OFFSET_SECONDS); it snaps that up to
 * the next Ethereum slot boundary T (block.timestamp == GENESIS + 12k), asks the LiquidationSeizureView
 * for `seizurePlanAt(account, T)`, quotes 1inch for each seized collateral at those exact amounts, and
 * prints the liquidate calldata. Because the plan (and thus swapData amounts) is pinned to T, this
 * calldata must be executed in the slot whose timestamp is T — that is what liquidate-at-slot.ts does.
 *
 * Reporting style mirrors scripts/demo/* (reuses lib/report). Workflow: run this → paste `data` into a
 * Safe tx (to = MODULE, value 0) and collect signatures → set liquidate-at-slot.ts's SAFE_TX.data /
 * TARGET_TIMESTAMP to the values printed here.
 *
 * Env: RPC_URL, ONEINCH_API_KEY.
 * Run:  npx ts-node scripts/dex-liquidation/seizure-plan-at.ts
 */
import 'dotenv/config';
import { ethers, BigNumber } from 'ethers';
import { CometInterface__factory, ERC20__factory } from '../../build/types';
import { reportPosition, positionSummary, fmtToken, fmtUsd } from '../demo/lib/report';

// Node 23 provides a global `fetch` at runtime, but @types/node@16 does not type it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const httpFetch = (globalThis as any).fetch as (url: string, init?: any) => Promise<any>;

// ══════════════════════════════════════ CONSTANTS ══════════════════════════════════════
const COMET = '0xED74b401Ab74a07E4C0ce16D24dbdfcEa721e32E';
const MODULE = '0xD2B9A994961d2e15B2C4af17E7a97f1FF06C5444'; // DEX liquidation module (Safe tx `to`)
const ADAPTER = '0xcAAF148640b6cA2264a81ACE7cBfD5cAfbB00F8e';
const SEIZURE_VIEW = '0xA9bC3152b53Ea9A2Cb4546ef05ac17564193527E'; // must be bound to MODULE/COMET

const ACCOUNT = '0x480905619075F892304c470057c0De9BEe38f899'; // the underwater borrower to liquidate
const ABSORBER = '0x4c894222653870C5e5a346E2c293a75DAC8d77a8'; // recipient of the liquidation incentive

// Lead time until execution. Snapped up to the next slot boundary. e.g. 300 ≈ 5 min, 600 ≈ 10 min.
const OFFSET_SECONDS = 180;

// When the account is NOT liquidatable, the script proposes a uniform feed drop that brings the
// liquidation line to this % of the debt (< 10000 ⇒ liquidatable). You then setPrice manually.
const TARGET_HEALTH_BPS = 9800;

// 'oneinch' → quote 1inch per routed collateral; 'uniswap' → empty swapData (adapter's redundant Uniswap path).
const ROUTE: 'oneinch' | 'uniswap' = 'oneinch';
const ONEINCH_SLIPPAGE_PCT = 1;
// AMM whitelist so 1inch returns adapter-compatible `swap()` calldata (not permit2/limit-order routes).
const ONEINCH_PROTOCOLS = 'AMBIENT,BALANCER,BALANCER_V2,BALANCER_V3,BLACKHOLESWAP,CREAMSWAP,CURVE,CURVE_3CRV,CURVE_STABLE_NG,CURVE_V2,CURVE_V2_ETH_CRV,CURVE_V2_ETH_CVX,CURVE_V2_ETH_PAL,CURVE_V2_EURS_2_ASSET,CURVE_V2_LLAMMA,CURVE_V2_METAPOOL,CURVE_V2_SGT_2_ASSET,CURVE_V2_SPELL_2_ASSET,CURVE_V2_THRESHOLDNETWORK_2_ASSET,CURVE_V2_TRICRYPTO_NG,CURVE_V2_TWO_CRYPTO,CURVE_V2_TWOCRYPTO_META,CURVE_V2_TWOCRYPTO_NG,CURVE_V2_YFI_2_ASSET,DEFI_PLAZA,DEFISWAP,DFX_FINANCE,DFX_FINANCE_V3,DODO,DODO_V2,DODO_V3,DXSWAP,ELASTICSWAP,ETHEREUM_ELK,ETHEREUM_PANCAKESWAP_V2,ETHEREUM_WOMBATSWAP,EULERSWAP,FRAXSWAP,INTEGRAL,KYBER,KYBER_DMM,KYBERSWAP_ELASTIC,LIF3,LINKSWAP,LUASWAP,MAINNET_SOLIDLY,MAVERICK_V1,MAVERICK_V2,MINISWAP,MOONISWAP,NOMISWAP_STABLE,NOMISWAPEPCS,PANCAKESWAP_V3,RADIOSHACK,RINGSWAP_V2,SADDLE,SAKESWAP,SHELL,SHIBASWAP,SMARDEX,SMOOTHY_FINANCE,SOLIDLY_V3,SUSHI,SUSHISWAP_V3,SWERVE,SYNAPSE,TRADERJOE_V2_1,UNIFI,UNISWAP_V1,UNISWAP_V2,UNISWAP_V3,UNISWAP_V4,VALUELIQUID,VERSE,XFAI,XSIGMA';

const CHAIN_ID = 1;
const GENESIS = 1606824023; // mainnet beacon genesis
const SLOT_SECONDS = 12;

// ═══════════════════════════════════════ ENV ═══════════════════════════════════════════
const provider = new ethers.providers.JsonRpcProvider(reqEnv('RPC_URL'));

const VIEW_ABI = ['function seizurePlanAt(address account, uint256 timestamp) view returns (tuple(address asset, uint8 index, uint256 seizedAmount, uint256 seizedValue, uint256 wantedCollateralValue)[])'];
const ADAPTER_ABI = ['function routeKind(address collateral) view returns (uint8)'];
const MODULE_IFACE = new ethers.utils.Interface(['function liquidate(address absorber, address account, bytes[] swapData)']);
const ONEINCH_SWAP_SELECTOR = ethers.utils.id('swap(address,(address,address,address,address,uint256,uint256,uint256),bytes)').slice(0, 10);

interface Seizure { asset: string, index: number, seizedAmount: BigNumber, seizedValue: BigNumber, wantedCollateralValue: BigNumber }
interface OneInchQuote { data: string, dstAmount: string, protocols: unknown }

// ═════════════════════════════════════ HELPERS ═════════════════════════════════════════
function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Flatten 1inch's nested `protocols` routing into the distinct AMM names used (e.g. ['UNISWAP_V3']). */
function routeNames(protocols: unknown): string[] {
  const names = new Set<string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object' && typeof (n as { name?: unknown }).name === 'string') names.add((n as { name: string }).name);
  };
  walk(protocols);
  return [...names];
}

/** Fetch 1inch v6 `swap()` calldata (+ route + expected out) for one collateral → base swap of `amount`. */
async function fetch1inch(src: string, dst: string, amount: string, from: string): Promise<OneInchQuote> {
  const apiKey = reqEnv('ONEINCH_API_KEY');
  const qs = new URLSearchParams({
    src, dst, amount, from, origin: from, receiver: from,
    slippage: String(ONEINCH_SLIPPAGE_PCT),
    disableEstimate: 'true', allowPartialFill: 'false', usePermit2: 'false',
    protocols: ONEINCH_PROTOCOLS,
  });
  const url = `https://api.1inch.dev/swap/v6.0/${CHAIN_ID}/swap?${qs.toString()}`;

  for (let attempt = 1; ; attempt++) {
    const res = await httpFetch(url, { headers: { Authorization: `Bearer ${apiKey}`, accept: 'application/json' } });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 5) throw new Error(`1inch API ${res.status} after ${attempt} attempts`);
      await sleep(1500 * attempt);
      continue;
    }
    const body = await res.json();
    if (res.status !== 200) throw new Error(`1inch API ${res.status}: ${JSON.stringify(body)}`);
    const data: string = body.tx.data;
    if (data.slice(0, 10).toLowerCase() !== ONEINCH_SWAP_SELECTOR) {
      throw new Error(`1inch returned selector ${data.slice(0, 10)}, adapter only accepts swap() ${ONEINCH_SWAP_SELECTOR}. Try a more liquid amount/route.`);
    }
    return { data, dstAmount: body.dstAmount, protocols: body.protocols };
  }
}

// ═══════════════════════════════════════ MAIN ══════════════════════════════════════════
async function main() {
  if (!ethers.utils.isAddress(ACCOUNT) || BigNumber.from(ACCOUNT).isZero()) throw new Error('Set ACCOUNT.');
  if (!ethers.utils.isAddress(ABSORBER) || BigNumber.from(ABSORBER).isZero()) throw new Error('Set ABSORBER.');

  const comet = CometInterface__factory.connect(COMET, provider);
  const view = new ethers.Contract(SEIZURE_VIEW, VIEW_ABI, provider);
  const adapter = new ethers.Contract(ADAPTER, ADAPTER_ABI, provider);

  const baseAddr = await comet.baseToken();
  const baseErc = ERC20__factory.connect(baseAddr, provider);
  const baseDecimals = await baseErc.decimals();
  const baseSymbol = await baseErc.symbol();
  const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
  const baseScale = await comet.baseScale();

  console.log('════════════════════════════════════════════════════════════');
  console.log(` Liquidation plan for ${ACCOUNT}`);
  console.log('════════════════════════════════════════════════════════════');

  // 1. Position + liquidatable status (demo-style report).
  await reportPosition(comet, ACCOUNT, 'Borrower position (now)');
  if (!(await comet.isLiquidatable(ACCOUNT))) {
    // Not liquidatable → propose a uniform feed drop that brings the liquidation line to
    // TARGET_HEALTH_BPS% of the debt (a ×k on every price scales the whole line by k).
    const s = await positionSummary(comet, ACCOUNT);
    if (s.debtUsd.isZero()) { console.log('\nNo debt — nothing to liquidate.'); return; }
    const targetLine = s.debtUsd.mul(TARGET_HEALTH_BPS).div(10000);
    if (targetLine.gte(s.liqLineUsd)) {
      console.log(`\nAlready under the ${TARGET_HEALTH_BPS / 100}% target (liq line ${fmtUsd(s.liqLineUsd)} ≤ ${fmtUsd(targetLine)}). Lower TARGET_HEALTH_BPS.`);
      return;
    }
    console.log(`\n──────── Not liquidatable — proposed price drop to ~${TARGET_HEALTH_BPS / 100}% health ────────`);
    console.log(`  liquidation line ${fmtUsd(s.liqLineUsd)} → ${fmtUsd(targetLine)}  (< debt ${fmtUsd(s.debtUsd)} ⇒ liquidatable)`);
    const numAssets = await comet.numAssets();
    for (let i = 0; i < numAssets; i++) {
      const info = await comet.getAssetInfo(i);
      const bal = await comet.collateralBalanceOf(ACCOUNT, info.asset);
      if (bal.isZero()) continue;
      const price = await comet.getPrice(info.priceFeed);
      const newPrice = price.mul(targetLine).div(s.liqLineUsd); // price × (target / current line)
      const sym = await ERC20__factory.connect(info.asset, provider).symbol();
      console.log(`  ${sym.padEnd(6)} ${fmtUsd(price)} → ${fmtUsd(newPrice)}   feed ${info.priceFeed}   setPrice(${newPrice.toString()})`);
    }
    console.log('  For each feed: setPrice(<value>) + setUseSourceFeed(false), then re-run this script.');
    return;
  }

  // 2. Snap the desired execution time up to the next slot boundary.
  const T = GENESIS + Math.ceil((nowSec() + OFFSET_SECONDS - GENESIS) / SLOT_SECONDS) * SLOT_SECONDS;
  console.log(`\n──────── Execution slot ────────`);
  console.log(`  T = ${T}  (slot ${(T - GENESIS) / SLOT_SECONDS}, ${new Date(T * 1000).toISOString()}, in ~${T - nowSec()}s)`);

  // 3. Seizure plan at T (the view reverts NotLiquidatable if not liquidatable at T).
  let plan: Seizure[];
  try {
    plan = await view.seizurePlanAt(ACCOUNT, T);
  } catch (e) {
    throw new Error(`seizurePlanAt(account, ${T}) reverted — not liquidatable at T (or a stale SeizureView bound to a previous module). ${(e as Error).message}`);
  }

  // 4. Per-collateral: how it is seized, through which protocols, for what amounts.
  console.log(`\n──────── How the borrower will be liquidated (at T) ────────`);
  const swapData: string[] = [];
  let debtCoveredUsd = BigNumber.from(0);
  let expectedBaseOut = BigNumber.from(0);
  for (const s of plan) {
    const erc = ERC20__factory.connect(s.asset, provider);
    const [dec, sym] = [await erc.decimals(), await erc.symbol()];
    if (s.seizedAmount.isZero()) { swapData.push('0x'); console.log(`  ${sym.padEnd(6)} not seized`); continue; }
    debtCoveredUsd = debtCoveredUsd.add(s.seizedValue);
    const seized = `${fmtToken(s.seizedAmount, dec, sym)} (worth ${fmtUsd(s.wantedCollateralValue)}, covers ${fmtUsd(s.seizedValue)} debt)`;

    const hasRoute = Number(await adapter.routeKind(s.asset)) !== 0;
    if (ROUTE === 'oneinch' && hasRoute) {
      const q = await fetch1inch(s.asset, baseAddr, s.seizedAmount.toString(), ADAPTER);
      swapData.push(q.data);
      expectedBaseOut = expectedBaseOut.add(q.dstAmount);
      const names = routeNames(q.protocols);
      console.log(`  ${sym.padEnd(6)} seize ${seized}`);
      console.log(`         └─ 1inch → ${fmtToken(BigNumber.from(q.dstAmount), baseDecimals, baseSymbol)} via ${names.length ? names.join(' + ') : '(route not reported)'}`);
    } else {
      swapData.push('0x'); // route-less collateral (swept/absorbed) or Uniswap redundant path
      console.log(`  ${sym.padEnd(6)} seize ${seized}`);
      console.log(`         └─ ${hasRoute ? 'Uniswap redundant path (on-chain, empty swapData)' : 'no DEX route → swept back to Comet & absorbed in-kind'}`);
    }
  }

  const debt = await comet.borrowBalanceOf(ACCOUNT);
  const debtUsd = debt.mul(basePrice).div(baseScale);
  const kind = debtCoveredUsd.gte(debtUsd.sub(debtUsd.div(1000))) ? 'FULL — closes the whole debt' : 'PARTIAL — restores health, leaves residual debt';
  console.log(`\n  Debt covered by seizure: ${fmtUsd(debtCoveredUsd)} of ${fmtUsd(debtUsd)}  ⇒  ${kind}`);
  if (expectedBaseOut.gt(0)) console.log(`  Expected base from swaps: ~${fmtToken(expectedBaseOut, baseDecimals, baseSymbol)}`);

  // 5. The liquidate calldata for the Safe transaction.
  const calldata = MODULE_IFACE.encodeFunctionData('liquidate', [ABSORBER, ACCOUNT, swapData]);
  console.log(`\n──────── Safe transaction ────────`);
  console.log(`  to:     ${MODULE}`);
  console.log('  value:  0');
  console.log(`  data:   ${calldata}`);
  console.log(`\n──────── liquidate-at-slot.ts ────────`);
  console.log(`  TARGET_TIMESTAMP = ${T};`);
  console.log('  SAFE_TX.data     = <the `data` above>');
  console.log('════════════════════════════════════════════════════════════');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
