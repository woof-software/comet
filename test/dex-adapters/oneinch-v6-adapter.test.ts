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
  Route,
  WBTC_USDC_ROUTE,
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
  const COLLATERAL = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'; // WBTC
  const COLLATERAL_WHALE = '0x58De44c4E1CBb802118d35e232F763D98Dc7c8CC';
  const COLLATERAL_AMOUNT = ethers.utils.parseUnits('1', 8); // 1 WBTC
  const REAL_ROUTES: Record<string, Route> = { [COLLATERAL]: WBTC_USDC_ROUTE };
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
  let routes: Route[];
  let comet: CometInterface;
  let baseToken: string;
  let baseTokenErc20: ERC20;
  let collateralErc20: ERC20;
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
    collateralErc20 = ERC20__factory.connect(COLLATERAL, ethers.provider);

    routes = await buildRoutes(comet, baseToken, REAL_ROUTES);

    adapterFactory = (await ethers.getContractFactory(
      'OneInchV6CoreAdapter'
    )) as OneInchV6CoreAdapter__factory;
    adapter = await adapterFactory.deploy(
      COMET,
      moduleAddress,
      CORE_ROUTER,
      REDUNDANT_ROUTER,
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

      it('stores the swap route for the collateral', async () => {
        const route = await adapter.routes(COLLATERAL);
        const { currency0, currency1, fee, tickSpacing, hooks } = route.poolKey;
        expect({
          poolKey: { currency0, currency1, fee, tickSpacing, hooks },
          zeroForOne: route.zeroForOne,
        }).to.deep.equal(WBTC_USDC_ROUTE);
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
    await expect(adapter.connect(outsider).swap(COLLATERAL, '0x')).to.be.revertedWithCustomError(
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
      await fundFromWhale(COLLATERAL, COLLATERAL_WHALE, adapter.address, COLLATERAL_AMOUNT);
      amountIn = await collateralErc20.balanceOf(adapter.address);

      quote = await fetch1inchSwapData({
        chainId: CHAIN_ID,
        src: COLLATERAL,
        dst: baseToken,
        amount: amountIn.toString(),
        from: adapter.address,
        slippage: ONEINCH_SLIPPAGE_PCT,
        protocols: AMM_PROTOCOLS,
      });
    });

    after(async () => await snapshot.restore());

    it('swaps collateral into the base asset using 1Inch swap quote', async () => {
      minOut = await adapter.calculateMinAmountOut(COLLATERAL, amountIn);
      tx = await adapter.connect(moduleSigner).swap(COLLATERAL, quote);
      receipt = await tx.wait();
      received = await baseTokenErc20.balanceOf(moduleAddress);
    });

    it('emits the adapter Swap event', async () => {
      await expect(tx).to.emit(adapter, 'Swap').withArgs(COLLATERAL, amountIn, received);
    });

    it('routes the swap through the 1inch core router, not the redundant router', async () => {
      // The core path approves the 1inch router to pull the collateral.
      await expect(tx)
        .to.emit(collateralErc20, 'Approval')
        .withArgs(adapter.address, CORE_ROUTER, amountIn);

      const fallbackAllowanceReset = findEvent(
        receipt.logs,
        ERC20_EVENTS_IFACE,
        'Approval',
        (token, args) =>
          eq(token, COLLATERAL) &&
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
      expect(await collateralErc20.balanceOf(adapter.address)).to.equal(0);
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
        srcToken: COLLATERAL,
        dstToken: baseToken,
        srcReceiver: adapter.address,
        dstReceiver: adapter.address,
        amount: amountIn,
        minReturnAmount: minOut,
        flags: 0,
      });

      before(async () => {
        await fundFromWhale(COLLATERAL, COLLATERAL_WHALE, adapter.address, COLLATERAL_AMOUNT);
        amountIn = await collateralErc20.balanceOf(adapter.address);
        minOut = await adapter.calculateMinAmountOut(COLLATERAL, amountIn);
      });

      it('swapData is too short to hold a selector', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(COLLATERAL, '0x')
        ).to.be.revertedWithCustomError(adapter, 'InvalidSwapData');
      });

      it('swapData selector is not IOneInchV6.swap', async () => {
        const wrongSelector = ethers.utils.hexConcat(['0xdeadbeef', ethers.utils.hexZeroPad('0x', 32)]);
        await expect(
          adapter.connect(moduleSigner).swap(COLLATERAL, wrongSelector)
        ).to.be.revertedWithCustomError(adapter, 'InvalidSelector');
      });

      it('srcToken does not match the collateral', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(COLLATERAL, encodeSwap({ ...validDesc(), srcToken: baseToken }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidTokens');
      });

      it('dstToken does not match the base asset', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(COLLATERAL, encodeSwap({ ...validDesc(), dstToken: COLLATERAL }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidTokens');
      });

      it('dstReceiver is not the adapter', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(COLLATERAL, encodeSwap({ ...validDesc(), dstReceiver: moduleAddress }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidReceiver');
      });

      it('amount does not match the adapter collateral balance', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(COLLATERAL, encodeSwap({ ...validDesc(), amount: amountIn.add(1) }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidAmountIn');
      });

      it('minReturnAmount is below the adapter minimum', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(COLLATERAL, encodeSwap({ ...validDesc(), minReturnAmount: minOut.sub(1) }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidMinAmountOut');
      });
    });
  });

  context('redundant swap route', function () {
    const route = WBTC_USDC_ROUTE;

    let tx: ContractTransaction;
    let receipt: ContractReceipt;
    let amountIn: BigNumber;
    let minOut: BigNumber;
    let received: BigNumber;
    let quote: string;

    before(async () => {
      await fundFromWhale(COLLATERAL, COLLATERAL_WHALE, adapter.address, COLLATERAL_AMOUNT);
      amountIn = await collateralErc20.balanceOf(adapter.address);

      quote = await withCustomMinReturn(
        {
          chainId: CHAIN_ID,
          src: COLLATERAL,
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
      minOut = await adapter.calculateMinAmountOut(COLLATERAL, amountIn);
      tx = await adapter.connect(moduleSigner).swap(COLLATERAL, quote);
      receipt = await tx.wait();
      received = await baseTokenErc20.balanceOf(moduleAddress);
    });

    it('emits the adapter Swap event', async () => {
      await expect(tx).to.emit(adapter, 'Swap').withArgs(COLLATERAL, amountIn, received);
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
          eq(token, COLLATERAL) && eq(args.from, adapter.address) && eq(args.to, REDUNDANT_ROUTER)
      );
      expect(collateralToRouter?.args.value).to.equal(amountIn);
    });

    it('forwards the realized base output to the module', () => {
      expect(minOut).to.be.gt(0);
      expect(received).to.be.gte(minOut);
    });

    it('leaves no tokens on the adapter balance', async () => {
      expect(await collateralErc20.balanceOf(adapter.address)).to.equal(0);
      expect(await baseTokenErc20.balanceOf(adapter.address)).to.equal(0);
    });
  });
});
