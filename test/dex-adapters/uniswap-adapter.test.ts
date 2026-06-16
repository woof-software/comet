import { expect } from 'chai';
import { ethers } from 'hardhat';
import { ContractReceipt, ContractTransaction, Signer, BigNumber } from 'ethers';
import { OneInchV6CoreAdapter, ERC20 } from '../../build/types';
import {
  fundFromWhale,
  withCustomMinReturn,
  RouteKind,
  WBTC_USDC_ROUTE,
  WSTETH_USDC_ROUTE,
  WETH_USDC_ROUTE,
  v4PoolId,
  eq,
  findEvent,
  SnapshotRestorer,
  setupDexAdapter,
  CHAIN_ID,
  ONEINCH_SLIPPAGE_PCT,
  AMM_PROTOCOLS,
  POOL_MANAGER,
  REDUNDANT_ROUTER,
  ERC20_EVENTS_IFACE,
  POOL_MANAGER_IFACE,
  WBTC,
  WBTC_WHALE,
  WBTC_AMOUNT,
  WSTETH,
  WSTETH_WHALE,
  WSTETH_AMOUNT,
  WETH,
  WETH_WHALE,
  WETH_AMOUNT,
} from '../helpers';

const suite =
  process.env.MAINNET_QUICKNODE_LINK && process.env.ONEINCH_API_KEY ? describe : describe.skip;

suite('UniswapAdapter', function () {
  this.timeout(180_000);

  let adapter: OneInchV6CoreAdapter;
  let baseToken: string;
  let baseTokenErc20: ERC20;
  let wbtcErc20: ERC20;
  let wstethErc20: ERC20;
  let wethErc20: ERC20;
  let moduleSigner: Signer;
  let moduleAddress: string;
  let snapshot: SnapshotRestorer;

  before(async () => {
    ({
      adapter,
      baseToken,
      baseTokenErc20,
      wbtcErc20,
      wstethErc20,
      wethErc20,
      moduleSigner,
      moduleAddress,
      snapshot,
    } = await setupDexAdapter());
  });

  context('constructor', function () {
    it('stores the single-hop swap route for the collateral', async () => {
      expect(await adapter.routeKind(WBTC)).to.equal(RouteKind.Single);
      const route = await adapter.singleRoutes(WBTC);
      const { currency0, currency1, fee, tickSpacing, hooks } = route.poolKey;
      expect({
        poolKey: { currency0, currency1, fee, tickSpacing, hooks },
        zeroForOne: route.zeroForOne,
      }).to.deep.equal({ poolKey: WBTC_USDC_ROUTE.poolKey, zeroForOne: WBTC_USDC_ROUTE.zeroForOne });
    });

    it('stores the multi-hop swap route for the collateral', async () => {
      expect(await adapter.routeKind(WSTETH)).to.equal(RouteKind.Multi);
      const path = await adapter.multiPath(WSTETH);
      const normalized = path.map((hop) => ({
        intermediateCurrency: hop.intermediateCurrency,
        fee: hop.fee,
        tickSpacing: hop.tickSpacing,
        hooks: hop.hooks,
        hookData: hop.hookData,
      }));
      expect(normalized).to.deep.equal(WSTETH_USDC_ROUTE.path);
    });
  });

  context('redundant swap route (single-pool swap)', function () {
    const route = WBTC_USDC_ROUTE;

    let tx: ContractTransaction;
    let receipt: ContractReceipt;
    let amountIn: BigNumber;
    let minOut: BigNumber;
    let received: BigNumber;
    let quote: string;

    before(async () => {
      await fundFromWhale(WBTC, WBTC_WHALE, adapter.address, WBTC_AMOUNT);
      amountIn = await wbtcErc20.balanceOf(adapter.address);

      quote = await withCustomMinReturn(
        {
          chainId: CHAIN_ID,
          src: WBTC,
          dst: baseToken,
          amount: amountIn.toString(),
          from: adapter.address,
          slippage: ONEINCH_SLIPPAGE_PCT,
          protocols: AMM_PROTOCOLS,
        },
        ethers.constants.MaxUint256
      );
    });

    after(async () => await snapshot.restore());

    it('falls back to the Uniswap V4 route when the 1inch core swap reverts', async () => {
      minOut = await adapter.calculateMinAmountOut(WBTC, amountIn);
      tx = await adapter.connect(moduleSigner).swap(WBTC, quote);
      receipt = await tx.wait();
      received = await baseTokenErc20.balanceOf(moduleAddress);
    });

    it('emits the adapter Swap event', async () => {
      await expect(tx).to.emit(adapter, 'Swap').withArgs(WBTC, amountIn, received);
    });

    it('routes the swap through the Uniswap V4 redundant router', () => {
      // The Uniswap V4 PoolManager emitted Swap for configured pool, called by the UniversalRouter.
      const poolSwap = findEvent(
        receipt.logs,
        POOL_MANAGER_IFACE,
        'Swap',
        (emitter, args) => eq(emitter, POOL_MANAGER) && eq(args.id, v4PoolId(route.poolKey))
      );
      expect(poolSwap, 'expected a Uniswap V4 PoolManager Swap on the configured pool').to.not.be
        .undefined;
      expect(poolSwap?.args.sender).to.equal(REDUNDANT_ROUTER);

      // Collateral went to the UniversalRouter for exactly amountIn.
      const collateralToRouter = findEvent(
        receipt.logs,
        ERC20_EVENTS_IFACE,
        'Transfer',
        (token, args) =>
          eq(token, WBTC) && eq(args.from, adapter.address) && eq(args.to, REDUNDANT_ROUTER)
      );
      expect(collateralToRouter?.args.value).to.equal(amountIn);
    });

    it('forwards the realized base output to the module', () => {
      expect(minOut).to.be.gt(0);
      expect(received).to.be.gte(minOut);
    });

    it('leaves no tokens on the adapter balance', async () => {
      expect(await wbtcErc20.balanceOf(adapter.address)).to.equal(0);
      expect(await baseTokenErc20.balanceOf(adapter.address)).to.equal(0);
    });
  });

  context('redundant swap route (multi-hop swap)', function () {
    const firstHopPoolKey = {
      currency0: WBTC_USDC_ROUTE.poolKey.currency0,
      currency1: WSTETH,
      fee: 2500,
      tickSpacing: 50,
      hooks: ethers.constants.AddressZero,
    };
    const secondHopPoolKey = WBTC_USDC_ROUTE.poolKey;

    let tx: ContractTransaction;
    let receipt: ContractReceipt;
    let amountIn: BigNumber;
    let minOut: BigNumber;
    let received: BigNumber;
    let quote: string;

    before(async () => {
      await fundFromWhale(WSTETH, WSTETH_WHALE, adapter.address, WSTETH_AMOUNT);
      amountIn = await wstethErc20.balanceOf(adapter.address);

      quote = await withCustomMinReturn(
        {
          chainId: CHAIN_ID,
          src: WSTETH,
          dst: baseToken,
          amount: amountIn.toString(),
          from: adapter.address,
          slippage: ONEINCH_SLIPPAGE_PCT,
          protocols: AMM_PROTOCOLS,
        },
        ethers.constants.MaxUint256
      );
    });

    after(async () => await snapshot.restore());

    it('falls back to the Uniswap V4 route when the core swap reverts', async () => {
      minOut = await adapter.calculateMinAmountOut(WSTETH, amountIn);
      tx = await adapter.connect(moduleSigner).swap(WSTETH, quote);
      receipt = await tx.wait();
      received = await baseTokenErc20.balanceOf(moduleAddress);
    });

    it('emits the adapter Swap event', async () => {
      await expect(tx).to.emit(adapter, 'Swap').withArgs(WSTETH, amountIn, received);
    });

    it('routes the swap through both Uniswap V4 pools of the multi-hop path', () => {
      // First hop: wstETH -> WBTC.
      const firstHopSwap = findEvent(
        receipt.logs,
        POOL_MANAGER_IFACE,
        'Swap',
        (emitter, args) => eq(emitter, POOL_MANAGER) && eq(args.id, v4PoolId(firstHopPoolKey))
      );
      expect(firstHopSwap, 'expected a V4 PoolManager Swap on the wstETH/WBTC pool').to.not.be
        .undefined;
      expect(firstHopSwap?.args.sender).to.equal(REDUNDANT_ROUTER);

      // Second hop: WBTC -> USDC.
      const secondHopSwap = findEvent(
        receipt.logs,
        POOL_MANAGER_IFACE,
        'Swap',
        (emitter, args) => eq(emitter, POOL_MANAGER) && eq(args.id, v4PoolId(secondHopPoolKey))
      );
      expect(secondHopSwap, 'expected a V4 PoolManager Swap on the WBTC/USDC pool').to.not.be
        .undefined;
      expect(secondHopSwap?.args.sender).to.equal(REDUNDANT_ROUTER);

      // Input collateral went to the UniversalRouter for exactly amountIn.
      const collateralToRouter = findEvent(
        receipt.logs,
        ERC20_EVENTS_IFACE,
        'Transfer',
        (token, args) =>
          eq(token, WSTETH) && eq(args.from, adapter.address) && eq(args.to, REDUNDANT_ROUTER)
      );
      expect(collateralToRouter?.args.value).to.equal(amountIn);
    });

    it('forwards the realized base output to the module', () => {
      expect(minOut).to.be.gt(0);
      expect(received).to.be.gte(minOut);
    });

    it('leaves no tokens on the adapter balance', async () => {
      expect(await wstethErc20.balanceOf(adapter.address)).to.equal(0);
      expect(await wbtcErc20.balanceOf(adapter.address)).to.equal(0); // no intermediate WBTC left
      expect(await baseTokenErc20.balanceOf(adapter.address)).to.equal(0);
    });
  });

  context('redundant swap route (native ETH input)', function () {
    const poolKey = WETH_USDC_ROUTE.poolKey;

    let tx: ContractTransaction;
    let receipt: ContractReceipt;
    let amountIn: BigNumber;
    let minOut: BigNumber;
    let received: BigNumber;
    let quote: string;

    before(async () => {
      await fundFromWhale(WETH, WETH_WHALE, adapter.address, WETH_AMOUNT);
      amountIn = await wethErc20.balanceOf(adapter.address);

      quote = await withCustomMinReturn(
        {
          chainId: CHAIN_ID,
          src: WETH,
          dst: baseToken,
          amount: amountIn.toString(),
          from: adapter.address,
          slippage: ONEINCH_SLIPPAGE_PCT,
          protocols: AMM_PROTOCOLS,
        },
        ethers.constants.MaxUint256
      );
    });

    after(async () => await snapshot.restore());

    it('falls back to the Uniswap V4 route when the core swap reverts', async () => {
      minOut = await adapter.calculateMinAmountOut(WETH, amountIn);
      tx = await adapter.connect(moduleSigner).swap(WETH, quote);
      receipt = await tx.wait();
      received = await baseTokenErc20.balanceOf(moduleAddress);
    });

    it('emits the adapter Swap event', async () => {
      await expect(tx).to.emit(adapter, 'Swap').withArgs(WETH, amountIn, received);
    });

    it('unwraps the WETH collateral and swaps native ETH through the V4 pool', () => {
      // The WETH collateral went to the UniversalRouter for exactly amountIn (to be unwrapped).
      const collateralToRouter = findEvent(
        receipt.logs,
        ERC20_EVENTS_IFACE,
        'Transfer',
        (token, args) =>
          eq(token, WETH) && eq(args.from, adapter.address) && eq(args.to, REDUNDANT_ROUTER)
      );
      expect(collateralToRouter?.args.value).to.equal(amountIn);

      // The swap ran on the native ETH/USDC pool (currency0 == address(0)).
      const poolSwap = findEvent(
        receipt.logs,
        POOL_MANAGER_IFACE,
        'Swap',
        (emitter, args) => eq(emitter, POOL_MANAGER) && eq(args.id, v4PoolId(poolKey))
      );
      expect(poolSwap, 'expected a V4 PoolManager Swap on the ETH/USDC pool').to.not.be.undefined;
      expect(poolSwap?.args.sender).to.equal(REDUNDANT_ROUTER);
    });

    it('forwards the realized base output to the module', () => {
      expect(minOut).to.be.gt(0);
      expect(received).to.be.gte(minOut);
    });

    it('leaves no tokens on the adapter balance', async () => {
      expect(await wethErc20.balanceOf(adapter.address)).to.equal(0);
      expect(await baseTokenErc20.balanceOf(adapter.address)).to.equal(0);
    });
  });
});
