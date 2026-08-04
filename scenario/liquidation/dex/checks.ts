import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import {
  CometInterface,
  ERC20__factory,
  LiquidationModule,
  LiquidationModule__factory,
  OneInchV6Adapter,
  OneInchV6Adapter__factory,
  SimplePriceFeed__factory,
} from '../../../build/types';
import { fetch1inchSwapData, ONEINCH_SLIPPAGE_PCT, NETWORKS, TOKENS } from '../../../test/helpers';
import { CometContext } from '../../context/CometContext';
import { getLiquidationModuleAddress } from '../../utils';
import { getConfigForScenario } from '../../utils/scenarioHelper';
import { impersonateAddress } from '../../../plugins/scenario/utils';
import CometActor from '../../context/CometActor';
import { World } from '../../../plugins/scenario/World';

/**
 * Shared building blocks for the DEX-liquidation scenarios (scenario/liquidation/dex). Every scenario:
 *   1. builds a liquidatable position (supply collateral, borrow ~95%, drop prices),
 *   2. grants the keeper EXECUTOR_ROLE, optionally toggles full mode / pauses the DEX route,
 *   3. reads the seizure plan and assembles per-collateral swapData,
 *   4. runs module.liquidate and asserts the reusable check-sets defined in the coverage plan.
 */

const DAO = '0x6d903f6003cca6255D85CcA4D3B5E5146dC33925';
const UNDERWATER_NUMERATOR = 98n;
const UNDERWATER_DENOMINATOR = 100n;
const ROUTE_UNSET = 0;

// swap-routes.ts token registry keyed by address — the source of the balances-mapping slot and a reference
// funding amount.
const TOKEN_BY_ADDRESS: Record<string, { amount: bigint, slot: number | string }> = Object.fromEntries(
  Object.values(TOKENS).map((t) => [t.address.toLowerCase(), { amount: t.amount.toBigInt(), slot: t.slot }])
);

function tokenRegistry(address: string): { amount: bigint, slot: number | string } {
  const entry = TOKEN_BY_ADDRESS[address.toLowerCase()];
  if (!entry) throw new Error(`No swap-routes.ts TOKENS entry (amount/slot) for ${address}`);
  return entry;
}

// Sets an ERC-20 balance by poking its balances-mapping slot.
async function pokeErc20Balance(world: World, token: string, account: string, amount: bigint, slot: number | string) {
  const index = utils.keccak256(utils.defaultAbiCoder.encode(['address', 'uint256'], [account, slot]));
  const value = utils.hexZeroPad(BigNumber.from(amount).toHexString(), 32);
  await world.deploymentManager.hre.network.provider.request({
    method: 'hardhat_setStorageAt',
    params: [token, index, value],
  });
}

export type LiquidationMode = 'partial' | 'full';
export type Route = 'oneinch' | 'uniswap' | 'corrupt' | 'absorb';

export interface DexContracts {
  module: LiquidationModule;
  adapter: OneInchV6Adapter;
  comet: CometInterface;
}

export interface SuppliedCollateral {
  asset: string;
  amount: bigint;
  priceFeed: string;
  hasRoute: boolean;
}

interface CollateralSnapshot {
  collateralBalance: bigint; // borrower's collateralBalanceOf
  totalCollateral: bigint; // totalsCollateral(asset).totalSupplyAsset
  cometErc20: bigint; // asset.balanceOf(comet)
  reserves: bigint; // getCollateralReserves(asset)
}

export interface BeforeState {
  borrowBalance: bigint;
  totalBorrowBase: bigint;
  totalSupplyBase: bigint;
  keeperBase: bigint;
  cometBase: bigint;
  perCollateral: Map<string, CollateralSnapshot>;
}

export interface LiquidationEvents {
  swapped: Map<string, { amountIn: bigint, amountOut: bigint }>; // adapter Swap
  swept: Set<string>; // adapter RedundantSwapFailed
  dexLiquidate?: { baseReceived: bigint, baseRepaid: bigint, incentive: bigint };
}

// ─── contracts ───────────────────────────────────────────────────────────────

export async function getDexContracts(context: CometContext): Promise<DexContracts> {
  const ethers = context.world.deploymentManager.hre.ethers;
  const comet = await context.getComet();
  const module = LiquidationModule__factory.connect((await getLiquidationModuleAddress(context))!, ethers.provider);
  const adapter = OneInchV6Adapter__factory.connect(await module.dexAdapter(), ethers.provider);
  return { module, adapter, comet };
}

async function asDao(context: CometContext, world: World) {
  const dao = await impersonateAddress(world.deploymentManager, DAO);
  await context.setNextBaseFeeToZero();
  return dao;
}

export async function grantExecutor(context: CometContext, world: World, module: LiquidationModule, keeper: string) {
  const dao = await asDao(context, world);
  await module.connect(dao).grantRole(await module.EXECUTOR_ROLE(), keeper, { gasPrice: 0 });
}

/** Full mode closes the whole debt; partial (the deployed default) restores the target health factor. */
export async function setLiquidationMode(context: CometContext, world: World, module: LiquidationModule, mode: LiquidationMode) {
  if (mode === 'partial') return; // deployed default
  const dao = await asDao(context, world);
  await module.connect(dao).liquidationModeToggle(false, { gasPrice: 0 });
}

export async function pauseDexRoute(context: CometContext, world: World, module: LiquidationModule) {
  const dao = await asDao(context, world);
  await module.connect(dao).setDexRoutePaused(true, { gasPrice: 0 });
}

// ─── position building ─────────────────────────────────────────────────────--

export interface BuildPositionOptions {
  /** Keep only collaterals matching the predicate (by route presence). Defaults to all. */
  pick?: (hasRoute: boolean) => boolean;
  /** Use only the first `limit` matching collaterals (in asset-list order). Lets a scenario run on any Comet
   *  with at least this many collaterals and build a position out of exactly that many. Defaults to all. */
  limit?: number;
}

/**
 * Funds Comet's base and the borrower's collateral: supplies every selected collateral, borrows ~95% of the combined BCF capacity,
 * then drops every mock price by a factor derived from the actual debt/liquidity so the position lands mildly
 * under water (liquidatable, but partial mode still leaves debt). Returns the collaterals in the position.
 */
export async function buildLiquidatablePosition(
  context: CometContext,
  world: World,
  borrower: CometActor,
  options: BuildPositionOptions = {}
): Promise<{ supplied: SuppliedCollateral[], borrowBefore: bigint }> {
  const pick = options.pick ?? (() => true);
  const { comet, adapter } = await getDexContracts(context);

  const baseToken = await comet.baseToken();
  const baseScale = (await comet.baseScale()).toBigInt();
  const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
  const factorScale = (await comet.factorScale()).toBigInt();
  const numAssets = await comet.numAssets();

  // Candidate collaterals (listed, borrowable, matching the route predicate).
  const candidates: { info: Awaited<ReturnType<CometInterface['getAssetInfo']>>, hasRoute: boolean }[] = [];
  for (let i = 0; i < numAssets; i++) {
    const info = await comet.getAssetInfo(i);
    if (info.borrowCollateralFactor.toBigInt() === 0n) continue; // delisted
    const hasRoute = Number(await adapter.routeKind(info.asset)) !== ROUTE_UNSET;
    if (!pick(hasRoute)) continue;
    candidates.push({ info, hasRoute });
    if (options.limit != null && candidates.length >= options.limit) break; // only need the first `limit`
  }
  expect(candidates.length, 'no candidate collateral matched the position filter').to.be.greaterThan(0);

  // Fund Comet with base liquidity for the borrower to draw, straight into its balances slot.
  const liquidationBaseWei = BigInt(getConfigForScenario(context).liquidationBase) * baseScale;
  await pokeErc20Balance(world, baseToken, comet.address, liquidationBaseWei, tokenRegistry(baseToken).slot);

  const supplied: (SuppliedCollateral & { price: bigint })[] = [];
  let borrowCapacityWei = 0n;
  let liquidityWei = 0n; // Σ collateral base-value × LCF, at the original prices.
  for (const { info, hasRoute } of candidates) {
    const price = (await comet.getPrice(info.priceFeed)).toBigInt();
    // Fund the borrower with the registry's reference amount for this token via its storage slot (no whales).
    const { amount, slot } = tokenRegistry(info.asset);
    await pokeErc20Balance(world, info.asset, borrower.address, amount, slot);

    const asset = context.getAssetByAddress(info.asset);
    await asset.approve(borrower, comet.address);
    await borrower.safeSupplyAsset({ asset: info.asset, amount });

    supplied.push({ asset: info.asset, amount, priceFeed: info.priceFeed, hasRoute, price });
    const valueWei = (amount * price * baseScale) / (info.scale.toBigInt() * basePrice);
    borrowCapacityWei += (valueWei * info.borrowCollateralFactor.toBigInt()) / factorScale;
    liquidityWei += (valueWei * info.liquidateCollateralFactor.toBigInt()) / factorScale;
  }
  expect(supplied.length, 'no collateral to build a position').to.be.greaterThan(0);

  await borrower.withdrawAsset({ asset: baseToken, amount: (borrowCapacityWei * 95n) / 100n });
  expect(await comet.isLiquidatable(borrower.address), 'position should start healthy').to.be.false;

  // Drop every price by the same factor so the post-drop liquidatable liquidity is `UNDERWATER` × debt — mildly
  // under water. Deriving the factor from the actual debt/liquidity keeps the position inside the partial window
  // regardless of sourcing/rounding.
  const debtWei = (await comet.borrowBalanceOf(borrower.address)).toBigInt();
  const dropNum = UNDERWATER_NUMERATOR * debtWei;
  const dropDen = UNDERWATER_DENOMINATOR * liquidityWei;
  const oracleSigner = await world.deploymentManager.getSigner();
  for (const s of supplied) {
    const dropped = (s.price * dropNum) / dropDen;
    expect(dropped, 'dropped price must stay positive').to.be.greaterThan(0n);
    await SimplePriceFeed__factory.connect(s.priceFeed, oracleSigner).setRoundData(0, dropped, 0, 0, 0);
  }
  expect(await comet.isLiquidatable(borrower.address), 'position should be liquidatable after the price drop').to.be.true;

  const borrowBefore = (await comet.borrowBalanceOf(borrower.address)).toBigInt();
  return { supplied, borrowBefore };
}

// ─── swapData assembly ───────────────────────────────────────────────────────

/**
 * Builds the per-collateral swapData array aligned to the seizure plan. `decide(asset, hasRoute, index)` chooses
 * the route for each seized collateral:
 *   'oneinch' -> a live 1Inch quote (core swap),
 *   'uniswap'/'absorb' -> "0x" (skip the core swap: routed collateral goes through Uniswap, route-less is swept),
 *   'corrupt' -> a 1Inch quote whose minReturnAmount is raised so the router reverts and the swap falls back to Uniswap.
 */
export async function buildSwapData(
  context: CometContext,
  adapter: OneInchV6Adapter,
  plan: { asset: string, seizedAmount: BigNumber }[],
  baseToken: string,
  decide: (asset: string, hasRoute: boolean, index: number) => Route
): Promise<string[]> {
  const ethers = context.world.deploymentManager.hre.ethers;
  const net = NETWORKS[context.world.base.network];
  const oneInch = new ethers.utils.Interface([
    'function swap(address executor, (address srcToken,address dstToken,address srcReceiver,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags) desc, bytes data) returns (uint256,uint256)',
  ]);

  return Promise.all(
    plan.map(async (s, i) => {
      const hasRoute = Number(await adapter.routeKind(s.asset)) !== ROUTE_UNSET;
      const route = decide(s.asset, hasRoute, i);
      if (route === 'uniswap' || route === 'absorb' || !net) return '0x';

      const quote = await fetch1inchSwapData({
        chainId: net.chainId,
        src: s.asset,
        dst: baseToken,
        amount: s.seizedAmount.toString(),
        from: adapter.address,
        slippage: ONEINCH_SLIPPAGE_PCT,
        ...(net.protocols ? { protocols: net.protocols } : {}),
      });
      if (route === 'oneinch') return quote;

      // 'corrupt': keep every field the adapter validates intact, but raise minReturnAmount so the 1Inch router
      // reverts (ReturnAmountIsNotEnough) and the adapter falls back to the Uniswap redundant route.
      const [executor, desc, data] = oneInch.decodeFunctionData('swap', quote);
      const corruptedDesc = {
        srcToken: desc.srcToken,
        dstToken: desc.dstToken,
        srcReceiver: desc.srcReceiver,
        dstReceiver: desc.dstReceiver,
        amount: desc.amount,
        minReturnAmount: ethers.constants.MaxUint256,
        flags: desc.flags,
      };
      return oneInch.encodeFunctionData('swap', [executor, corruptedDesc, data]);
    })
  );
}

// ─── snapshot + event parsing ────────────────────────────────────────────────

export async function snapshotBefore(
  comet: CometInterface,
  borrower: string,
  keeper: string,
  baseToken: string,
  assets: string[]
): Promise<BeforeState> {
  const ethers = comet.provider;
  const totals = await comet.totalsBasic();
  const base = ERC20__factory.connect(baseToken, ethers);

  const perCollateral = new Map<string, CollateralSnapshot>();
  for (const asset of assets) {
    const erc20 = ERC20__factory.connect(asset, ethers);
    perCollateral.set(asset.toLowerCase(), {
      collateralBalance: (await comet.collateralBalanceOf(borrower, asset)).toBigInt(),
      totalCollateral: (await comet.totalsCollateral(asset)).totalSupplyAsset.toBigInt(),
      cometErc20: (await erc20.balanceOf(comet.address)).toBigInt(),
      reserves: (await comet.getCollateralReserves(asset)).toBigInt(),
    });
  }

  return {
    borrowBalance: (await comet.borrowBalanceOf(borrower)).toBigInt(),
    totalBorrowBase: totals.totalBorrowBase.toBigInt(),
    totalSupplyBase: totals.totalSupplyBase.toBigInt(),
    keeperBase: (await base.balanceOf(keeper)).toBigInt(),
    cometBase: (await base.balanceOf(comet.address)).toBigInt(),
    perCollateral,
  };
}

export function parseLiquidationEvents(
  receipt: { logs: { topics: string[], data: string }[] },
  adapter: OneInchV6Adapter,
  module: LiquidationModule
): LiquidationEvents {
  const swapped = new Map<string, { amountIn: bigint, amountOut: bigint }>();
  const swept = new Set<string>();
  let dexLiquidate: LiquidationEvents['dexLiquidate'];

  for (const log of receipt.logs) {
    try {
      const p = adapter.interface.parseLog(log);
      if (p.name === 'Swap')
        swapped.set((p.args.collateral as string).toLowerCase(), {
          amountIn: p.args.amountIn.toBigInt(),
          amountOut: p.args.amountOut.toBigInt(),
        });
      else if (p.name === 'RedundantSwapFailed') swept.add((p.args.collateral as string).toLowerCase());
      continue;
    } catch {
      /* not an adapter event */
    }
    try {
      const p = module.interface.parseLog(log);
      if (p.name === 'DexLiquidate')
        dexLiquidate = {
          baseReceived: p.args.baseReceived.toBigInt(),
          baseRepaid: p.args.baseRepaid.toBigInt(),
          incentive: p.args.incentive.toBigInt(),
        };
    } catch {
      /* not a module event */
    }
  }
  return { swapped, swept, dexLiquidate };
}

// ─── reusable check-sets ─────────────────────────────────────────────────────

/** [Base asset] — post-liquidation base/debt state. */
export async function checkBaseAsset(comet: CometInterface, borrower: string, before: BeforeState, mode: LiquidationMode) {
  const totals = await comet.totalsBasic();
  const borrowAfter = (await comet.borrowBalanceOf(borrower)).toBigInt();

  expect(borrowAfter, '[Base] borrowBalanceOf decreased').to.be.lessThan(before.borrowBalance);
  expect(totals.totalBorrowBase.toBigInt(), '[Base] totalBorrowBase decreased').to.be.lessThan(before.totalBorrowBase);
  expect(totals.totalSupplyBase.toBigInt(), '[Base] totalSupplyBase unchanged').to.equal(before.totalSupplyBase);
  expect(await comet.isLiquidatable(borrower), '[Base] no longer liquidatable').to.be.false;
  if (mode === 'partial') expect(borrowAfter, '[Base] partial mode leaves debt').to.be.greaterThan(0n);
  else expect(borrowAfter, '[Base] full mode closes the debt').to.equal(0n);
}

/** [Swapped asset] — a collateral sold on the DEX. */
export async function checkSwappedAsset(
  comet: CometInterface,
  adapter: OneInchV6Adapter,
  borrower: string,
  asset: string,
  seized: bigint,
  before: BeforeState,
  events: LiquidationEvents
) {
  const key = asset.toLowerCase();
  const b = before.perCollateral.get(key)!;
  const erc20 = ERC20__factory.connect(asset, comet.provider);

  expect(b.collateralBalance - (await comet.collateralBalanceOf(borrower, asset)).toBigInt(), '[Swapped] collateralBalanceOf decreased by seized').to.equal(seized);
  expect(b.totalCollateral - (await comet.totalsCollateral(asset)).totalSupplyAsset.toBigInt(), '[Swapped] totalCollateral decreased by seized').to.equal(seized);
  expect(b.cometErc20 - (await erc20.balanceOf(comet.address)).toBigInt(), '[Swapped] comet balance decreased by seized').to.equal(seized);
  expect((await comet.getCollateralReserves(asset)).toBigInt(), '[Swapped] collateral reserves unchanged').to.equal(b.reserves);

  const swap = events.swapped.get(key);
  expect(swap, '[Swapped] Swap event emitted').to.not.be.undefined;
  expect(swap!.amountIn, '[Swapped] Swap.amountIn equals seized').to.equal(seized);
  const minOut = (await adapter.calculateMinAmountOut(asset, swap!.amountIn)).toBigInt();
  expect(swap!.amountOut, '[Swapped] amountOut >= calculateMinAmountOut').to.be.gte(minOut);
}

/** [Absorbed asset] — a collateral whose swap failed or had no route (swept back to Comet). */
export async function checkAbsorbedAsset(
  comet: CometInterface,
  borrower: string,
  asset: string,
  seized: bigint,
  before: BeforeState,
  events: LiquidationEvents,
  fromSweep = true
) {
  const key = asset.toLowerCase();
  const b = before.perCollateral.get(key)!;
  const erc20 = ERC20__factory.connect(asset, comet.provider);

  expect(b.collateralBalance - (await comet.collateralBalanceOf(borrower, asset)).toBigInt(), '[Absorbed] collateralBalanceOf decreased by seized').to.equal(seized);
  expect(b.totalCollateral - (await comet.totalsCollateral(asset)).totalSupplyAsset.toBigInt(), '[Absorbed] totalCollateral decreased by seized').to.equal(seized);
  expect((await erc20.balanceOf(comet.address)).toBigInt(), '[Absorbed] comet balance unchanged').to.equal(b.cometErc20);
  expect((await comet.getCollateralReserves(asset)).toBigInt() - b.reserves, '[Absorbed] reserves grew by seized').to.equal(seized);

  expect(events.swapped.has(key), '[Absorbed] no Swap event for this collateral').to.be.false;
  // When the DEX route is paused the module absorbs directly and the adapter is never invoked, so
  // RedundantSwapFailed is not emitted; only the sweep path emits it.
  if (fromSweep) expect(events.swept.has(key), '[Absorbed] RedundantSwapFailed emitted').to.be.true;
}

/** [Proceeds] — where the base asset ended up (only when at least one collateral was swapped). */
export async function checkProceeds(comet: CometInterface, keeper: string, baseToken: string, before: BeforeState, events: LiquidationEvents) {
  expect(events.dexLiquidate, '[Proceeds] DexLiquidate event emitted').to.not.be.undefined;
  const base = ERC20__factory.connect(baseToken, comet.provider);
  expect((await base.balanceOf(keeper)).toBigInt() - before.keeperBase, '[Proceeds] keeper received the incentive').to.equal(events.dexLiquidate!.incentive);
  expect((await base.balanceOf(comet.address)).toBigInt() - before.cometBase, '[Proceeds] comet base grew by baseForComet').to.equal(events.dexLiquidate!.baseRepaid);
}

/** [No stranded] — no collateral or base left on the adapter or module. */
export async function checkNoStranded(adapter: OneInchV6Adapter, module: LiquidationModule, tokens: string[]) {
  const provider = adapter.provider;
  for (const token of tokens) {
    const erc20 = ERC20__factory.connect(token, provider);
    expect((await erc20.balanceOf(adapter.address)).toBigInt(), `[No stranded] adapter holds no ${token}`).to.equal(0n);
    expect((await erc20.balanceOf(module.address)).toBigInt(), `[No stranded] module holds no ${token}`).to.equal(0n);
  }
}

// ─── high-level runners ──────────────────────────────────────────────────────

export interface RunResult {
  dex: DexContracts;
  borrower: CometActor;
  keeper: CometActor;
  baseToken: string;
  plan: { asset: string, seizedAmount: BigNumber }[];
  before: BeforeState;
  events: LiquidationEvents;
  receipt: any;
}

/**
 * Full DEX-route run: build the position, grant the keeper, set the mode, read the seizure plan, assemble
 * swapData via `decide`, snapshot, and run module.liquidate. Returns everything the check-sets need.
 */
export async function runDexLiquidation(
  context: CometContext,
  world: World,
  borrower: CometActor,
  keeper: CometActor,
  opts: { mode: LiquidationMode, count: number, pick?: (hasRoute: boolean) => boolean, decide: (asset: string, hasRoute: boolean, index: number) => Route, pauseRoute?: boolean }
): Promise<RunResult> {
  const dex = await getDexContracts(context);
  const { module, adapter, comet } = dex;
  const baseToken = await comet.baseToken();

  await buildLiquidatablePosition(context, world, borrower, { pick: opts.pick, limit: opts.count });
  await grantExecutor(context, world, module, keeper.address);
  await setLiquidationMode(context, world, module, opts.mode);
  if (opts.pauseRoute) await pauseDexRoute(context, world, module);

  const plan = (await module.seizurePlan(borrower.address)).map((s) => ({ asset: s.asset, seizedAmount: s.seizedAmount }));
  const swapData = await buildSwapData(context, adapter, plan, baseToken, opts.decide);

  const before = await snapshotBefore(comet, borrower.address, keeper.address, baseToken, plan.map((s) => s.asset));

  await context.setNextBaseFeeToZero();
  const receipt = await (
    await module.connect(keeper.signer).liquidate(keeper.address, borrower.address, swapData, { gasPrice: 0 })
  ).wait();
  const events = parseLiquidationEvents(receipt, adapter, module);

  return { dex, borrower, keeper, baseToken, plan, before, events, receipt };
}

/** Asserts the DEX-route check-sets: every seized collateral is either [Swapped] or [Absorbed], plus [Base], [Proceeds], [No stranded]. */
export async function assertDexLiquidation(r: RunResult, mode: LiquidationMode) {
  const { comet, adapter, module } = r.dex;
  let anySwapped = false;

  for (const s of r.plan) {
    const seized = s.seizedAmount.toBigInt();
    if (r.events.swept.has(s.asset.toLowerCase())) {
      await checkAbsorbedAsset(comet, r.borrower.address, s.asset, seized, r.before, r.events);
    } else {
      anySwapped = true;
      await checkSwappedAsset(comet, adapter, r.borrower.address, s.asset, seized, r.before, r.events);
    }
  }

  await checkBaseAsset(comet, r.borrower.address, r.before, mode);
  if (anySwapped) await checkProceeds(comet, r.keeper.address, r.baseToken, r.before, r.events);
  await checkNoStranded(adapter, module, [...r.plan.map((s) => s.asset), r.baseToken]);
}

/** Asserts the paused-route run: every collateral absorbed in-kind, no swaps, keeper unpaid. */
export async function assertPausedAbsorb(r: RunResult, mode: LiquidationMode) {
  const { comet, adapter, module } = r.dex;

  expect(r.events.swapped.size, 'paused route emits no Swap').to.equal(0);
  expect(r.events.dexLiquidate, 'paused route emits no DexLiquidate').to.be.undefined;

  for (const s of r.plan) {
    // Adapter is never invoked when the route is paused, so RedundantSwapFailed is not emitted.
    await checkAbsorbedAsset(comet, r.borrower.address, s.asset, s.seizedAmount.toBigInt(), r.before, r.events, /* fromSweep */ false);
  }

  await checkBaseAsset(comet, r.borrower.address, r.before, mode);
  const base = ERC20__factory.connect(r.baseToken, comet.provider);
  expect((await base.balanceOf(r.keeper.address)).toBigInt(), 'paused route pays no incentive').to.equal(r.before.keeperBase);
  await checkNoStranded(adapter, module, [...r.plan.map((s) => s.asset), r.baseToken]);
}
