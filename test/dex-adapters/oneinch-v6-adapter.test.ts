import { expect } from 'chai';
import hre, { ethers } from 'hardhat';
import { ContractReceipt, ContractTransaction, Signer, BigNumber } from 'ethers';
import {
  CometInterface,
  CometInterface__factory,
  ERC20,
  ERC20__factory,
  OneInchV6CoreAdapter,
  OneInchV6CoreAdapter__factory,
} from '../../build/types';
import {
  fundFromWhale,
  fetch1inchSwapData,
  withCustomMinReturn,
  ONEINCH_V6_ROUTER_MAINNET,
  ONEINCH_V6_SWAP_ABI,
  RouteConfig,
  RouteKind,
  WBTC_USDC_ROUTE,
  WETH_USDC_ROUTE,
  WSTETH_USDC_ROUTE,
  buildRoutes,
  v4PoolId,
  eq,
  findEvent,
  SnapshotRestorer,
  takeSnapshot
} from '../helpers';

const MAINNET_RPC = process.env.MAINNET_QUICKNODE_LINK;
const ONEINCH_API_KEY = process.env.ONEINCH_API_KEY;
const CHAIN_ID = 1;

const suite = MAINNET_RPC && ONEINCH_API_KEY ? describe : describe.skip;

suite('OneInchV6CoreAdapter', function () {
  this.timeout(180_000);

  // Mainnet data
  const COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
  const CORE_ROUTER = ONEINCH_V6_ROUTER_MAINNET;
  const REDUNDANT_ROUTER = '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af';
  const POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90';

  const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
  const WBTC_WHALE = '0x58De44c4E1CBb802118d35e232F763D98Dc7c8CC';
  const WBTC_AMOUNT = ethers.utils.parseUnits('1', 8); // 1 WBTC

  const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
  const WSTETH_WHALE = '0x5313b39bf226ced2332C81eB97BB28c6fD50d1a3';
  const WSTETH_AMOUNT = ethers.utils.parseUnits('1', 18); // 1 wstETH

  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const WETH_WHALE = '0x4553e3Bc6327006A63C5aA4cdAC887f66b6A433E';
  const WETH_AMOUNT = ethers.utils.parseUnits('1', 18); // 1 WETH

  const REAL_ROUTES: Record<string, RouteConfig> = {
    [WBTC]: WBTC_USDC_ROUTE,
    [WSTETH]: WSTETH_USDC_ROUTE,
    [WETH]: WETH_USDC_ROUTE,
  };
  const POOL_MANAGER_SWAP_EVENT =
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)';

  // Swap parameters
  const SLIPPAGE_BPS = 500; // 5%
  const ONEINCH_SLIPPAGE_PCT = 1; // 1%
  // Restrict 1inch routing to signature-free AMMs so the core calldata can be used in fork.
  const AMM_PROTOCOLS = 'UNISWAP_V3,UNISWAP_V2,SUSHI,CURVE';

  const ERC20_EVENTS_IFACE = new ethers.utils.Interface([
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'event Approval(address indexed owner, address indexed spender, uint256 value)',
  ]);
  const POOL_MANAGER_IFACE = new ethers.utils.Interface([POOL_MANAGER_SWAP_EVENT]);

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
    // Fork mainnet at head.
    await hre.network.provider.request({
      method: 'hardhat_reset',
      params: [{ forking: { jsonRpcUrl: MAINNET_RPC } }],
    });

    [, moduleSigner] = await ethers.getSigners();
    moduleAddress = await moduleSigner.getAddress();

    comet = CometInterface__factory.connect(COMET, ethers.provider);
    baseToken = await comet.baseToken();
    baseTokenErc20 = ERC20__factory.connect(baseToken, ethers.provider);
    wbtcErc20 = ERC20__factory.connect(WBTC, ethers.provider);
    wstethErc20 = ERC20__factory.connect(WSTETH, ethers.provider);
    wethErc20 = ERC20__factory.connect(WETH, ethers.provider);

    routes = await buildRoutes(comet, REAL_ROUTES);

    adapterFactory = (await ethers.getContractFactory(
      'OneInchV6CoreAdapter'
    )) as OneInchV6CoreAdapter__factory;
    adapter = await adapterFactory.deploy(
      COMET,
      moduleAddress,
      CORE_ROUTER,
      REDUNDANT_ROUTER,
      WETH,
      SLIPPAGE_BPS,
      routes
    );
    await adapter.deployed();

    snapshot = await takeSnapshot();
  });

  context('constructor', function () {
    context('happy path', function () {
      it('sets comet to the provided market', async () => {
        expect(await adapter.comet()).to.equal(COMET);
      });

      it('sets baseAsset to the comet base token', async () => {
        expect(await adapter.baseAsset()).to.equal(baseToken);
      });

      it('sets module to the provided liquidation module', async () => {
        expect(await adapter.module()).to.equal(moduleAddress);
      });

      it('sets coreRouter to the provided core router', async () => {
        expect(await adapter.coreRouter()).to.equal(CORE_ROUTER);
      });

      it('sets redundantRouter to the provided redundant router', async () => {
        expect(await adapter.redundantRouter()).to.equal(REDUNDANT_ROUTER);
      });

      it('sets slippageBps to the provided slippage', async () => {
        expect(await adapter.slippageBps()).to.equal(SLIPPAGE_BPS);
      });

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

    context('reverts when', function () {
      it('a constructor address is zero', async () => {
        await expect(
          adapterFactory.deploy(
            COMET,
            ethers.constants.AddressZero,
            CORE_ROUTER,
            REDUNDANT_ROUTER,
            WETH,
            SLIPPAGE_BPS,
            routes
          )
        ).to.be.revertedWithCustomError(adapter, 'ZeroAddress');
      });

      it('slippage bps is out of bounds', async () => {
        const badSlippageBps = 10_001; // > BPS (100%)
        await expect(
          adapterFactory.deploy(
            COMET,
            moduleAddress,
            CORE_ROUTER,
            REDUNDANT_ROUTER,
            WETH,
            badSlippageBps,
            routes
          )
        )
          .to.be.revertedWithCustomError(adapter, 'SlippageOutOfBounds')
          .withArgs(badSlippageBps);
      });
    });
  });

  it('rejects swap() from a non-module caller', async () => {
    const [outsider] = await ethers.getSigners();
    await expect(adapter.connect(outsider).swap(WBTC, '0x')).to.be.revertedWithCustomError(
      adapter,
      'Unathorized'
    );
  });

  context('core swap router', function () {
    let tx: ContractTransaction;
    let receipt: ContractReceipt;
    let amountIn: BigNumber;
    let minOut: BigNumber;
    let received: BigNumber;
    let quote: string;

    before(async () => {
      await fundFromWhale(WBTC, WBTC_WHALE, adapter.address, WBTC_AMOUNT);
      amountIn = await wbtcErc20.balanceOf(adapter.address);

      quote = await fetch1inchSwapData({
        chainId: CHAIN_ID,
        src: WBTC,
        dst: baseToken,
        amount: amountIn.toString(),
        from: adapter.address,
        slippage: ONEINCH_SLIPPAGE_PCT,
        protocols: AMM_PROTOCOLS,
      });
    });

    after(async () => await snapshot.restore());

    it('swaps collateral into the base asset using 1Inch swap quote', async () => {
      minOut = await adapter.calculateMinAmountOut(WBTC, amountIn);
      tx = await adapter.connect(moduleSigner).swap(WBTC, quote);
      receipt = await tx.wait();
      received = await baseTokenErc20.balanceOf(moduleAddress);
    });

    it('emits the adapter Swap event', async () => {
      await expect(tx).to.emit(adapter, 'Swap').withArgs(WBTC, amountIn, received);
    });

    it('routes the swap through the 1inch core router', async () => {
      // The core path approves the 1inch router to pull the collateral.
      await expect(tx)
        .to.emit(wbtcErc20, 'Approval')
        .withArgs(adapter.address, CORE_ROUTER, amountIn);

      const fallbackAllowanceReset = findEvent(
        receipt.logs,
        ERC20_EVENTS_IFACE,
        'Approval',
        (token, args) =>
          eq(token, WBTC) &&
          eq(args.owner, adapter.address) &&
          eq(args.spender, CORE_ROUTER) &&
          args.value.eq(0)
      );
      expect(fallbackAllowanceReset, 'core swap must not fall back to the redundant router').to.be
        .undefined;
    });

    it('forwards the realized base output to the module', () => {
      expect(minOut).to.be.gt(0);
      expect(received).to.be.gte(minOut);
    });

    it('leaves no tokens on the adapter balance', async () => {
      expect(await wbtcErc20.balanceOf(adapter.address)).to.equal(0);
      expect(await baseTokenErc20.balanceOf(adapter.address)).to.equal(0);
    });

    context('reverts when', function () {
      let amountIn: BigNumber;
      let minOut: BigNumber;

      // Use locally crafted swap description instead of making excessive 1Inch API calls.
      const swapIface = new ethers.utils.Interface([ONEINCH_V6_SWAP_ABI]);
      const encodeSwap = (desc: Record<string, unknown>): string =>
        swapIface.encodeFunctionData('swap', [ethers.constants.AddressZero, desc, '0x']);
      const validDesc = () => ({
        srcToken: WBTC,
        dstToken: baseToken,
        srcReceiver: adapter.address,
        dstReceiver: adapter.address,
        amount: amountIn,
        minReturnAmount: minOut,
        flags: 0,
      });

      before(async () => {
        await fundFromWhale(WBTC, WBTC_WHALE, adapter.address, WBTC_AMOUNT);
        amountIn = await wbtcErc20.balanceOf(adapter.address);
        minOut = await adapter.calculateMinAmountOut(WBTC, amountIn);
      });

      it('swapData is too short to hold a selector', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, '0x')
        ).to.be.revertedWithCustomError(adapter, 'InvalidSwapData');
      });

      it('swapData selector is not IOneInchV6.swap', async () => {
        const wrongSelector = ethers.utils.hexConcat(['0xdeadbeef', ethers.utils.hexZeroPad('0x', 32)]);
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, wrongSelector)
        ).to.be.revertedWithCustomError(adapter, 'InvalidSelector');
      });

      it('srcToken does not match the collateral', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, encodeSwap({ ...validDesc(), srcToken: baseToken }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidTokens');
      });

      it('dstToken does not match the base asset', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, encodeSwap({ ...validDesc(), dstToken: WBTC }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidTokens');
      });

      it('dstReceiver is not the adapter', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, encodeSwap({ ...validDesc(), dstReceiver: moduleAddress }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidReceiver');
      });

      it('amount does not match the adapter collateral balance', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, encodeSwap({ ...validDesc(), amount: amountIn.add(1) }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidAmountIn');
      });

      it('minReturnAmount is below the adapter minimum', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, encodeSwap({ ...validDesc(), minReturnAmount: minOut.sub(1) }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidMinAmountOut');
      });
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
