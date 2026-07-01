import { expect } from 'chai';
import { ethers } from 'hardhat';
import { ContractReceipt, ContractTransaction, Signer, BigNumber } from 'ethers';
import { CometInterface, OneInchV6CoreAdapter, OneInchV6CoreAdapter__factory, ERC20, ERC20__factory } from '../../build/types';
import {
  setErc20Balance,
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
  CORE_ROUTER,
  SLIPPAGE_BPS,
  ERC20_EVENTS_IFACE,
  POOL_MANAGER_IFACE,
  multiRoute,
  poolRoute,
  ONEINCH_V6_SWAP_ABI,
  RouteConfig,
  TOKENS,
  MARKETS,
} from '../helpers';

describe('UniswapAdapter', function () {
  this.timeout(180_000);

  const market = MARKETS.usdc;

  let adapter: OneInchV6CoreAdapter;
  let adapterFactory: OneInchV6CoreAdapter__factory;
  let routes: RouteConfig[];
  let comet: CometInterface;
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
      adapterFactory,
      routes,
      comet,
      baseToken,
      baseTokenErc20,
      wbtcErc20,
      wstethErc20,
      wethErc20,
      moduleSigner,
      moduleAddress,
      snapshot,
    } = await setupDexAdapter(market));
  });

  context('constructor', function () {
    it('stores the single-hop swap route for the collateral', async () => {
      expect(await adapter.routeKind(TOKENS.WBTC.address)).to.equal(RouteKind.Single);
      const route = await adapter.singleRoutes(TOKENS.WBTC.address);
      const { currency0, currency1, fee, tickSpacing, hooks } = route.poolKey;
      expect({
        poolKey: { currency0, currency1, fee, tickSpacing, hooks },
        zeroForOne: route.zeroForOne,
      }).to.deep.equal({ poolKey: WBTC_USDC_ROUTE.poolKey, zeroForOne: WBTC_USDC_ROUTE.zeroForOne });
    });

    it('stores the multi-hop swap route for the collateral', async () => {
      expect(await adapter.routeKind(TOKENS.WSTETH.address)).to.equal(RouteKind.Multi);
      const path = await adapter.multiPath(TOKENS.WSTETH.address);
      const normalized = path.map((hop) => ({
        intermediateCurrency: hop.intermediateCurrency,
        fee: hop.fee,
        tickSpacing: hop.tickSpacing,
        hooks: hop.hooks,
        hookData: hop.hookData,
      }));
      expect(normalized).to.deep.equal(WSTETH_USDC_ROUTE.path);
    });

    context('reverts when', function () {
      const WRONG_TOKEN = ethers.utils.getAddress('0x000000000000000000000000000000000000dead');
      const HOOK = ethers.utils.getAddress('0x000000000000000000000000000000000000beef');
      const singleIndex = Object.keys(market.routes).indexOf(TOKENS.WBTC.address);
      const multiIndex = Object.keys(market.routes).indexOf(TOKENS.WSTETH.address);

      const deployAndInitiate = async (badRoutes: RouteConfig[]): Promise<ContractTransaction> => {
        const badAdapter = await adapterFactory.deploy(
          CORE_ROUTER,
          REDUNDANT_ROUTER,
          TOKENS.WETH.address,
          SLIPPAGE_BPS,
          badRoutes
        );
        await badAdapter.deployed();
        badAdapter.connect(moduleSigner).initiateAdapter(comet.address);
        return badAdapter.connect(moduleSigner).setAssetList(await comet.assetList(), await comet.numAssets(), baseToken);
      };

      it('weth is the zero address', async () => {
        await expect(
          adapterFactory.deploy(CORE_ROUTER, REDUNDANT_ROUTER, ethers.constants.AddressZero, SLIPPAGE_BPS, routes)
        ).to.be.revertedWithCustomError(adapter, 'ZeroAddress');
      });

      it('the routes count does not match the number of collaterals', async () => {
        await expect(deployAndInitiate(routes.slice(1)))
          .to.be.revertedWithCustomError(adapter, 'InvalidRoutesNumber');
      });

      it('a multi-hop route has an empty path', async () => {
        const collateral = (await comet.getAssetInfo(0)).asset;
        const badRoutes = [...routes];
        badRoutes[0] = { ...multiRoute([]), collateral };
        await expect(deployAndInitiate(badRoutes))
          .to.be.revertedWithCustomError(adapter, 'EmptyPath')
          .withArgs(collateral);
      });

      it('a single-pool route src token is not the collateral', async () => {
        const collateral = (await comet.getAssetInfo(singleIndex)).asset;
        const badRoutes = [...routes];
        // src = WRONG_TOKEN, dst = base asset; keyed under the real collateral.
        badRoutes[singleIndex] = { ...poolRoute(baseToken, WRONG_TOKEN, 3000, 60), collateral };
        await expect(deployAndInitiate(badRoutes))
          .to.be.revertedWithCustomError(adapter, 'InvalidRoute')
          .withArgs(collateral);
      });

      it('a single-pool route dst token is not the base asset', async () => {
        const collateral = (await comet.getAssetInfo(singleIndex)).asset;
        const badRoutes = [...routes];
        // src = collateral, dst = WRONG_TOKEN.
        badRoutes[singleIndex] = { ...poolRoute(WRONG_TOKEN, collateral, 3000, 60), collateral };
        await expect(deployAndInitiate(badRoutes))
          .to.be.revertedWithCustomError(adapter, 'InvalidRoute')
          .withArgs(collateral);
      });

      it('a multi-hop route final hop dst token is not the base asset', async () => {
        const collateral = (await comet.getAssetInfo(multiIndex)).asset;
        const original = routes[multiIndex];
        // Keep the path intact but point the final hop at WRONG_TOKEN instead of the base asset.
        const badPath = original.path.map((hop, i) =>
          i === original.path.length - 1 ? { ...hop, intermediateCurrency: WRONG_TOKEN } : hop
        );
        const badRoutes = [...routes];
        badRoutes[multiIndex] = { ...multiRoute(badPath), collateral };
        await expect(deployAndInitiate(badRoutes))
          .to.be.revertedWithCustomError(adapter, 'InvalidRoute')
          .withArgs(collateral);
      });

      it('a single-pool route has a non-zero hook', async () => {
        const collateral = (await comet.getAssetInfo(singleIndex)).asset;
        const badRoutes = [...routes];
        // Valid currencies (collateral -> base) but a non-zero hook on the pool key.
        badRoutes[singleIndex] = { ...poolRoute(baseToken, collateral, 3000, 60, HOOK), collateral };
        await expect(deployAndInitiate(badRoutes))
          .to.be.revertedWithCustomError(adapter, 'NonZeroHooks')
          .withArgs(collateral);
      });

      it('a multi-hop route has a non-zero hook', async () => {
        const collateral = (await comet.getAssetInfo(multiIndex)).asset;
        const original = routes[multiIndex];
        // Keep the currencies valid; set a non-zero hook on the first hop.
        const badPath = original.path.map((hop, i) => (i === 0 ? { ...hop, hooks: HOOK } : hop));
        const badRoutes = [...routes];
        badRoutes[multiIndex] = { ...multiRoute(badPath), collateral };
        await expect(deployAndInitiate(badRoutes))
          .to.be.revertedWithCustomError(adapter, 'NonZeroHooks')
          .withArgs(collateral);
      });

      it('a multi-hop route has non-empty hook data', async () => {
        const collateral = (await comet.getAssetInfo(multiIndex)).asset;
        const original = routes[multiIndex];
        // Keep the currencies valid; set non-empty hook data on the first hop.
        const badPath = original.path.map((hop, i) => (i === 0 ? { ...hop, hookData: '0x01' } : hop));
        const badRoutes = [...routes];
        badRoutes[multiIndex] = { ...multiRoute(badPath), collateral };
        await expect(deployAndInitiate(badRoutes))
          .to.be.revertedWithCustomError(adapter, 'NonZeroHooks')
          .withArgs(collateral);
      });
    });
  });

  it('sends collateral back to comet for a collateral without a configured route', async () => {
    const unsetCollateral = TOKENS.COMP.address;
    const amountIn = TOKENS.COMP.amount;
    const unsetColErc20 = ERC20__factory.connect(unsetCollateral, ethers.provider);
    await setErc20Balance(unsetCollateral, adapter.address, amountIn, TOKENS.COMP.slot);
    const minOut = await adapter.calculateMinAmountOut(unsetCollateral, amountIn);
    const swapIface = new ethers.utils.Interface([ONEINCH_V6_SWAP_ABI]);
    const swapData = swapIface.encodeFunctionData('swap', [
      ethers.constants.AddressZero,
      {
        srcToken: unsetCollateral,
        dstToken: baseToken,
        srcReceiver: adapter.address,
        dstReceiver: adapter.address,
        amount: amountIn,
        minReturnAmount: minOut,
        flags: 0,
      },
      '0x',
    ]);
    const cometBalBefore = await unsetColErc20.balanceOf(comet.address);
    await expect(
      adapter.connect(moduleSigner).swap(unsetCollateral, swapData)
    ).to.emit(adapter, "RedundantSwapFailed").withArgs(unsetCollateral, amountIn);
    
    expect(await unsetColErc20.balanceOf(comet.address)).to.equal(cometBalBefore.add(amountIn));
  });

  it('sends collateral back to comet when redundant router fails', async () => {
    const wbtc = TOKENS.WBTC;
    const wbtcIndex = Object.keys(market.routes).indexOf(wbtc.address);

    // Tamper WBTC's route to a pool that does not exist (valid currencies so it passes validation).
    const badRoutes = [...routes];
    badRoutes[wbtcIndex] = { ...poolRoute(baseToken, wbtc.address, 999, 13), collateral: wbtc.address };
    const badAdapter = await adapterFactory.deploy(
      CORE_ROUTER,
      REDUNDANT_ROUTER,
      TOKENS.WETH.address,
      SLIPPAGE_BPS,
      badRoutes
    );
    await badAdapter.deployed();
    await badAdapter.connect(moduleSigner).initiateAdapter(comet.address);
    await badAdapter.connect(moduleSigner).setAssetList(await comet.assetList(), await comet.numAssets(), baseToken);

    const amountIn = wbtc.amount;
    await setErc20Balance(wbtc.address, badAdapter.address, amountIn, wbtc.slot);

    const cometBalBefore = await wbtcErc20.balanceOf(comet.address);
    // Empty swap data skips the core route and goes straight to the redundant route. The router swap reverts
    // on the non-existent pool, so the adapter returns the pre-transferred collateral from the router to Comet.
    await expect(
      badAdapter.connect(moduleSigner).swap(wbtc.address, '0x')
    ).to.emit(badAdapter, 'RedundantSwapFailed').withArgs(wbtc.address, amountIn);

    expect(await wbtcErc20.balanceOf(comet.address)).to.equal(cometBalBefore.add(amountIn));
  });

  context('redundant swap route (single-pool swap)', function () {
    const wbtc = TOKENS.WBTC;
    const route = WBTC_USDC_ROUTE;

    let tx: ContractTransaction;
    let receipt: ContractReceipt;
    let amountIn: BigNumber;
    let minOut: BigNumber;
    let received: BigNumber;
    let quote: string;

    before(async () => {
      await setErc20Balance(wbtc.address, adapter.address, wbtc.amount, wbtc.slot);
      amountIn = await wbtcErc20.balanceOf(adapter.address);

      quote = await withCustomMinReturn(
        {
          chainId: CHAIN_ID,
          src: wbtc.address,
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
      minOut = await adapter.calculateMinAmountOut(wbtc.address, amountIn);
      tx = await adapter.connect(moduleSigner).swap(wbtc.address, quote);
      receipt = await tx.wait();
      received = await baseTokenErc20.balanceOf(moduleAddress);
    });

    it('emits the adapter Swap event', async () => {
      await expect(tx).to.emit(adapter, 'Swap').withArgs(wbtc.address, amountIn, received);
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
          eq(token, wbtc.address) && eq(args.from, adapter.address) && eq(args.to, REDUNDANT_ROUTER)
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
    const wsteth = TOKENS.WSTETH;
    const firstHopPoolKey = {
      currency0: WBTC_USDC_ROUTE.poolKey.currency0,
      currency1: wsteth.address,
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
      await setErc20Balance(wsteth.address, adapter.address, wsteth.amount, wsteth.slot);
      amountIn = await wstethErc20.balanceOf(adapter.address);

      quote = await withCustomMinReturn(
        {
          chainId: CHAIN_ID,
          src: wsteth.address,
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
      minOut = await adapter.calculateMinAmountOut(wsteth.address, amountIn);
      tx = await adapter.connect(moduleSigner).swap(wsteth.address, quote);
      receipt = await tx.wait();
      received = await baseTokenErc20.balanceOf(moduleAddress);
    });

    it('emits the adapter Swap event', async () => {
      await expect(tx).to.emit(adapter, 'Swap').withArgs(wsteth.address, amountIn, received);
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
          eq(token, wsteth.address) && eq(args.from, adapter.address) && eq(args.to, REDUNDANT_ROUTER)
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
    const weth = TOKENS.WETH;
    const poolKey = WETH_USDC_ROUTE.poolKey;

    let tx: ContractTransaction;
    let receipt: ContractReceipt;
    let amountIn: BigNumber;
    let minOut: BigNumber;
    let received: BigNumber;
    let quote: string;

    before(async () => {
      await setErc20Balance(weth.address, adapter.address, weth.amount, weth.slot);
      amountIn = await wethErc20.balanceOf(adapter.address);

      quote = await withCustomMinReturn(
        {
          chainId: CHAIN_ID,
          src: weth.address,
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
      minOut = await adapter.calculateMinAmountOut(weth.address, amountIn);
      tx = await adapter.connect(moduleSigner).swap(weth.address, quote);
      receipt = await tx.wait();
      received = await baseTokenErc20.balanceOf(moduleAddress);
    });

    it('emits the adapter Swap event', async () => {
      await expect(tx).to.emit(adapter, 'Swap').withArgs(weth.address, amountIn, received);
    });

    it('unwraps the WETH collateral and swaps native ETH through the V4 pool', () => {
      // The WETH collateral went to the UniversalRouter for exactly amountIn (to be unwrapped).
      const collateralToRouter = findEvent(
        receipt.logs,
        ERC20_EVENTS_IFACE,
        'Transfer',
        (token, args) =>
          eq(token, weth.address) && eq(args.from, adapter.address) && eq(args.to, REDUNDANT_ROUTER)
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

  context('redundant swap route (native ETH output)', function () {
    // Separate cWETHv3 (base = WETH) deployment: USDC -> ETH exercises the WRAP_ETH (native output) path.
    const usdc = TOKENS.USDC;
    const poolKey = WETH_USDC_ROUTE.poolKey; // same ETH/USDC pool, reversed direction

    let wethAdapter: OneInchV6CoreAdapter;
    let wethBaseToken: string;
    let wethBaseErc20: ERC20; // WETH
    let usdcErc20: ERC20;
    let wethModuleSigner: Signer;
    let wethModuleAddress: string;
    let wethSnapshot: SnapshotRestorer;

    let tx: ContractTransaction;
    let receipt: ContractReceipt;
    let amountIn: BigNumber;
    let minOut: BigNumber;
    let received: BigNumber;
    let quote: string;

    before(async () => {
      ({
        adapter: wethAdapter,
        baseToken: wethBaseToken,
        baseTokenErc20: wethBaseErc20,
        moduleSigner: wethModuleSigner,
        moduleAddress: wethModuleAddress,
        snapshot: wethSnapshot,
      } = await setupDexAdapter(MARKETS.weth));
      usdcErc20 = ERC20__factory.connect(usdc.address, ethers.provider);

      await setErc20Balance(usdc.address, wethAdapter.address, usdc.amount, usdc.slot);
      amountIn = await usdcErc20.balanceOf(wethAdapter.address);

      quote = await withCustomMinReturn(
        {
          chainId: CHAIN_ID,
          src: usdc.address,
          dst: wethBaseToken,
          amount: amountIn.toString(),
          from: wethAdapter.address,
          slippage: ONEINCH_SLIPPAGE_PCT,
          protocols: AMM_PROTOCOLS,
        },
        ethers.constants.MaxUint256
      );
    });

    after(async () => await wethSnapshot.restore());

    it('falls back to the Uniswap V4 route when the core swap reverts', async () => {
      minOut = await wethAdapter.calculateMinAmountOut(usdc.address, amountIn);
      tx = await wethAdapter.connect(wethModuleSigner).swap(usdc.address, quote);
      receipt = await tx.wait();
      received = await wethBaseErc20.balanceOf(wethModuleAddress);
    });

    it('emits the adapter Swap event', async () => {
      await expect(tx).to.emit(wethAdapter, 'Swap').withArgs(usdc.address, amountIn, received);
    });

    it('swaps to native ETH through the V4 pool and wraps it back to WETH', () => {
      // The USDC collateral went to the UniversalRouter for exactly amountIn.
      const collateralToRouter = findEvent(
        receipt.logs,
        ERC20_EVENTS_IFACE,
        'Transfer',
        (token, args) =>
          eq(token, usdc.address) && eq(args.from, wethAdapter.address) && eq(args.to, REDUNDANT_ROUTER)
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

      // The native ETH output was wrapped to WETH and sent to the adapter (WRAP_ETH).
      const wrappedToAdapter = findEvent(
        receipt.logs,
        ERC20_EVENTS_IFACE,
        'Transfer',
        (token, args) =>
          eq(token, wethBaseToken) &&
          eq(args.from, REDUNDANT_ROUTER) &&
          eq(args.to, wethAdapter.address)
      );
      expect(wrappedToAdapter, 'expected wrapped WETH sent from the router to the adapter').to.not.be
        .undefined;
    });

    it('forwards the realized base output to the module', () => {
      expect(minOut).to.be.gt(0);
      expect(received).to.be.gte(minOut);
    });

    it('leaves no tokens on the adapter balance', async () => {
      expect(await usdcErc20.balanceOf(wethAdapter.address)).to.equal(0);
      expect(await wethBaseErc20.balanceOf(wethAdapter.address)).to.equal(0);
    });
  });
});
