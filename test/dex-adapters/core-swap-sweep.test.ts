import { expect } from 'chai';
import hre, { ethers } from 'hardhat';
import { ContractReceipt, ContractTransaction, Signer } from 'ethers';
import {
  CometInterface,
  CometInterface__factory,
  ERC20,
  ERC20__factory,
  OneInchV6CoreAdapter,
  OneInchV6CoreAdapter__factory,
} from '../../build/types';
import {
  setErc20Balance,
  fetch1inchSwapData,
  eq,
  findEvent,
  takeSnapshot,
  SnapshotRestorer,
  buildRoutes,
  CORE_ROUTER,
  REDUNDANT_ROUTER,
  SLIPPAGE_BPS,
  ONEINCH_SLIPPAGE_PCT,
  ERC20_EVENTS_IFACE,
  SWAP_ROUTES,
  TOKENS_BY_NETWORK,
  TokenInfo,
} from '../helpers';

/**
 * Cross-network sweep: execute swap for every supported network, every Comet market and every configured collateral.
 * A network runs only when `ONEINCH_API_KEY` and its fork RPC env var is set.
 */

interface NetworkConfig {
  chainId: number;
  rpc?: string;
  weth: string;
  protocols?: string;
}

const NETWORKS: Record<string, NetworkConfig> = {
  mainnet: { chainId: 1, rpc: process.env.MAINNET_QUICKNODE_LINK, weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', protocols: "AMBIENT,BALANCER,BALANCER_V2,BALANCER_V3,BLACKHOLESWAP,CREAMSWAP,CURVE,CURVE_3CRV,CURVE_STABLE_NG,CURVE_V2,CURVE_V2_ETH_CRV,CURVE_V2_ETH_CVX,CURVE_V2_ETH_PAL,CURVE_V2_EURS_2_ASSET,CURVE_V2_LLAMMA,CURVE_V2_METAPOOL,CURVE_V2_SGT_2_ASSET,CURVE_V2_SPELL_2_ASSET,CURVE_V2_THRESHOLDNETWORK_2_ASSET,CURVE_V2_TRICRYPTO_NG,CURVE_V2_TWO_CRYPTO,CURVE_V2_TWOCRYPTO_META,CURVE_V2_TWOCRYPTO_NG,CURVE_V2_YFI_2_ASSET,DEFI_PLAZA,DEFISWAP,DFX_FINANCE,DFX_FINANCE_V3,DODO,DODO_V2,DODO_V3,DXSWAP,ELASTICSWAP,ETHEREUM_ELK,ETHEREUM_PANCAKESWAP_V2,ETHEREUM_WOMBATSWAP,EULERSWAP,FRAXSWAP,INTEGRAL,KYBER,KYBER_DMM,KYBERSWAP_ELASTIC,LIF3,LINKSWAP,LUASWAP,MAINNET_SOLIDLY,MAVERICK_V1,MAVERICK_V2,MINISWAP,MOONISWAP,NOMISWAP_STABLE,NOMISWAPEPCS,PANCAKESWAP_V3,RADIOSHACK,RINGSWAP_V2,SADDLE,SAKESWAP,SHELL,SHIBASWAP,SMARDEX,SMOOTHY_FINANCE,SOLIDLY_V3,SUSHI,SUSHISWAP_V3,SWERVE,SYNAPSE,TRADERJOE_V2_1,UNIFI,UNISWAP_V1,UNISWAP_V2,UNISWAP_V3,UNISWAP_V4,VALUELIQUID,VERSE,XFAI,XSIGMA"},
  base: { chainId: 8453, rpc: process.env.BASE_QUICKNODE_LINK, weth: '0x4200000000000000000000000000000000000006', protocols: "BASE_AERODROME,BASE_AERODROME_SLIPSTREAM,BASE_AERODROME_V3,BASE_BALANCER_V2,BASE_BALANCER_V3,BASE_BASESWAP_V3,BASE_CURVE,BASE_CURVE_V2_TRICRYPTO_NG,BASE_CURVE_V2_TWO_CRYPTO,BASE_DACKIE_SWAP,BASE_DFX_FINANCE_V3,BASE_DODO_V2,BASE_EQUALIZER,BASE_HORIZON_DEX,BASE_KOKONUT_SWAP,BASE_LUNARBASE,BASE_MAVERICK,BASE_MAVERICK_V2,BASE_PANCAKESWAP_V2,BASE_PANCAKESWAP_V3,BASE_PANCAKESWAP_V4,BASE_QUICKSWAP_V2,BASE_QUICKSWAP_V4,BASE_RINGSWAP_V2,BASE_ROCKET_SWAP,BASE_SMARDEX,BASE_SOLIDLY_V3,BASE_SUSHI_V2,BASE_SUSHI_V3,BASE_SWAP,BASE_SWAP_BASED,BASE_SYNTHSWAP,BASE_TESSERASWAP,BASE_UNISWAP_V2,BASE_UNISWAP_V3,BASE_UNISWAP_V4,BASE_VELOCIMETER_V2,BASE_WOOFI_V2,BASE_ZORA_V3,BASE_ZORA_V4,BASE_ZYBER_V3"},
  arbitrum: { chainId: 42161, rpc: process.env.ARBITRUM_QUICKNODE_LINK, weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', protocols: "ARBITRUM_ARBIDEX,ARBITRUM_ARBIDEX_V3,ARBITRUM_BALANCER_V2,ARBITRUM_BALANCER_V3,ARBITRUM_CAMELOT,ARBITRUM_CAMELOT_V3,ARBITRUM_CHRONOS,ARBITRUM_CHRONOS_V3,ARBITRUM_CURVE,ARBITRUM_CURVE_STABLE_NG,ARBITRUM_CURVE_V2,ARBITRUM_CURVE_V2_TRICRYPTO_NG,ARBITRUM_CURVE_V2_TWOCRYPTO_NG,ARBITRUM_DFX_FINANCE_V3,ARBITRUM_DODO,ARBITRUM_DODO_V2,ARBITRUM_DODO_V3,ARBITRUM_DXSWAP,ARBITRUM_ELK,ARBITRUM_INTEGRAL,ARBITRUM_KYBERSWAP_ELASTIC,ARBITRUM_MAVERICK_V2,ARBITRUM_PANCAKESWAP_V3,ARBITRUM_RAMSES,ARBITRUM_RAMSES_V2,ARBITRUM_RINGSWAP_V2,ARBITRUM_SADDLE,ARBITRUM_SHELL_OCEAN,ARBITRUM_SMARDEX,ARBITRUM_SOLIDLIZARD,ARBITRUM_SOLIDLY_V3,ARBITRUM_SUSHISWAP,ARBITRUM_SUSHISWAP_V3,ARBITRUM_SWAPFISH,ARBITRUM_SYNAPSE,ARBITRUM_TRADERJOE,ARBITRUM_TRADERJOE_V2,ARBITRUM_TRADERJOE_V2_1,ARBITRUM_TRADERJOE_V2_2,ARBITRUM_TRIDENT,ARBITRUM_UNISWAP_V3,ARBITRUM_UNISWAP_V4,ARBITRUM_VIRTUSWAP,ARBITRUM_WOMBATSWAP,ARBITRUM_WOOFI_V2,ARBITRUM_ZYBER,ARBITRUM_ZYBER_STABLE,ARBITRUM_ZYBER_V3,ARBSWAP,ARBSWAP_STABLE"},
  optimism: { chainId: 10, rpc: process.env.OPTIMISM_QUICKNODE_LINK, weth: '0x4200000000000000000000000000000000000006', protocols: "OPTIMISM_BALANCER_V2,OPTIMISM_BALANCER_V3,OPTIMISM_CURVE,OPTIMISM_ELK,OPTIMISM_KYBERSWAP_ELASTIC,OPTIMISM_SOLIDLY_V3,OPTIMISM_TRIDENT,OPTIMISM_UNISWAP_V3,OPTIMISM_UNISWAP_V4,OPTIMISM_VELODROME,OPTIMISM_VELODROME_V2,OPTIMISM_VELODROME_V3,OPTIMISM_WOMBATSWAP,OPTIMISM_WOOFI_V2"},
  polygon: { chainId: 137, rpc: process.env.POLYGON_QUICKNODE_LINK, weth: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', protocols: "COMETH,DFYN,FIREBIRD_FINANCE,IRONSWAP,MM_FINANCE,ONESWAP,POLYCAT_FINANCE,POLYDEX_FINANCE,POLYGON_APESWAP,POLYGON_BALANCER_V2,POLYGON_CURVE,POLYGON_CURVE_V2,POLYGON_DFX_FINANCE,POLYGON_DFX_FINANCE_V3,POLYGON_DODO,POLYGON_DODO_V2,POLYGON_DODO_V3,POLYGON_DYSTOPIA,POLYGON_ELK,POLYGON_GRAVITY,POLYGON_JETSWAP,POLYGON_KYBER_DMM,POLYGON_KYBERSWAP_ELASTIC,POLYGON_MAVERICK,POLYGON_MESHSWAP,POLYGON_MSTABLE,POLYGON_NERVE,POLYGON_PEARL,POLYGON_QUICKSWAP,POLYGON_QUICKSWAP_V3,POLYGON_RADIOSHACK,POLYGON_RETRO,POLYGON_SAFE_SWAP,POLYGON_SATIN,POLYGON_SATIN_4POOL,POLYGON_SMARDEX,POLYGON_SUSHISWAP,POLYGON_SUSHISWAP_V3,POLYGON_SWAAP,POLYGON_SYNAPSE,POLYGON_TRIDENT,POLYGON_UNIFI,POLYGON_UNISWAP_V3,POLYGON_UNISWAP_V4,POLYGON_VIRTUSWAP,POLYGON_WAULTSWAP,POLYGON_WOOFI,POLYGON_WOOFI_V2"},
  unichain: { chainId: 130, rpc: process.env.UNICHAIN_QUICKNODE_LINK, weth: '0x4200000000000000000000000000000000000006', protocols: "UNICHAIN_EULERSWAP,UNICHAIN_UNISWAP_V2,UNICHAIN_UNISWAP_V3,UNICHAIN_UNISWAP_V4,UNICHAIN_VELODROME_V3"},
  linea: { chainId: 59144, rpc: process.env.LINEA_QUICKNODE_LINK, weth: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', protocols: "LINEA_ECHODEX_V2,LINEA_ECHODEX_V3,LINEA_ETHEREX_LEGACY,LINEA_ETHEREX_V3,LINEA_LYNEX,LINEA_NILE,LINEA_NILE_V2,LINEA_PANCAKESWAP_V3,LINEA_SECTA_V2,LINEA_SECTA_V3,LINEA_SPARTA_DEX,LINEA_SUSHISWAP_V3,LINEA_SYNCSWAP,LINEA_WOOFI_V2"},
  mantle: { chainId: 5000, rpc: process.env.MANTLE_QUICKNODE_LINK, weth: '0xdEaddEaDdeadDEadDEADDEAddEADDEAddead1111'},
  scroll: { chainId: 534352, rpc: process.env.SCROLL_QUICKNODE_LINK, weth: '0x5300000000000000000000000000000000000004'},
};

describe('OneInchV6CoreAdapter core swap sweep', function () {
  this.timeout(600_000);

  for (const [network, markets] of Object.entries(SWAP_ROUTES)) {
    const net = NETWORKS[network];

    describe(network, function () {
      const registry = TOKENS_BY_NETWORK[network as keyof typeof TOKENS_BY_NETWORK] as Record<string, TokenInfo>;
      const fundingByAddress = new Map<string, TokenInfo>();
      const symbolByAddress = new Map<string, string>();
      for (const [symbol, token] of Object.entries(registry)) {
        fundingByAddress.set(token.address.toLowerCase(), token);
        symbolByAddress.set(token.address.toLowerCase(), symbol);
      }

      for (const [marketName, market] of Object.entries(markets)) {
        describe(`${marketName} comet`, function () {
          let adapter: OneInchV6CoreAdapter;
          let comet: CometInterface;
          let baseToken: string;
          let baseTokenErc20: ERC20;
          let moduleSigner: Signer;
          let moduleAddress: string;
          let snapshot: SnapshotRestorer;

          before(async function () {
            if (!net || !net.rpc) {
              throw new Error(`no fork RPC configured for ${network} (set its *_QUICKNODE_LINK env var)`);
            }
            await hre.network.provider.request({
              method: 'hardhat_reset',
              params: [{ forking: { jsonRpcUrl: net.rpc } }],
            });

            [, moduleSigner] = await ethers.getSigners();
            moduleAddress = await moduleSigner.getAddress();

            comet = CometInterface__factory.connect(market.comet, ethers.provider);
            baseToken = await comet.baseToken();
            baseTokenErc20 = ERC20__factory.connect(baseToken, ethers.provider);

            const routes = await buildRoutes(comet, market.routes);
            const factory = (await ethers.getContractFactory(
              'OneInchV6CoreAdapter'
            )) as OneInchV6CoreAdapter__factory;
            adapter = await factory.deploy(
              market.comet,
              moduleAddress,
              CORE_ROUTER,
              REDUNDANT_ROUTER,
              net.weth,
              SLIPPAGE_BPS,
              routes
            );
            await adapter.deployed();

            snapshot = await takeSnapshot();
          });

          afterEach(async () => await snapshot.restore());

          Object.keys(market.routes).forEach((routeAddress, assetIndex) => {
            const key = routeAddress.toLowerCase();
            const funding = fundingByAddress.get(key);
            if (!funding) {
              throw new Error(`collateral ${routeAddress} (${network}/${marketName}) is not in the token registry`);
            }
            const symbol = symbolByAddress.get(key) ?? routeAddress;

            it(`swaps ${symbol} into the base asset via the 1inch core router`, async function () {
              const collateral = (await comet.getAssetInfo(assetIndex)).asset;
              const collateralErc20 = ERC20__factory.connect(collateral, ethers.provider);

              await setErc20Balance(collateral, adapter.address, funding.amount, funding.slot);
              const amountIn = await collateralErc20.balanceOf(adapter.address);

              const quote = await fetch1inchSwapData({
                chainId: net.chainId,
                src: collateral,
                dst: baseToken,
                amount: amountIn.toString(),
                from: adapter.address,
                slippage: ONEINCH_SLIPPAGE_PCT,
                ...(net.protocols ? { protocols: net.protocols } : {}),
              });

              const minOut = await adapter.calculateMinAmountOut(collateral, amountIn);
              const tx: ContractTransaction = await adapter.connect(moduleSigner).swap(collateral, quote);
              const receipt: ContractReceipt = await tx.wait();
              const received = await baseTokenErc20.balanceOf(moduleAddress);

              // Emits the adapter Swap event.
              await expect(tx).to.emit(adapter, 'Swap').withArgs(collateral, amountIn, received);

              const routedThroughRedundant = findEvent(
                receipt.logs,
                ERC20_EVENTS_IFACE,
                'Transfer',
                (logToken, args) =>
                  eq(logToken, collateral) &&
                  eq(args.from, adapter.address) &&
                  eq(args.to, REDUNDANT_ROUTER)
              );
              // Report if routed through redundant router.
              if (routedThroughRedundant !== undefined) console.log(`${symbol} Routed through redundant router`);

              // Forwards the realized base output to the module.
              expect(minOut).to.be.gt(0);
              expect(received).to.be.gte(minOut);

              // Leaves no tokens on the adapter.
              expect(await collateralErc20.balanceOf(adapter.address)).to.equal(0);
              expect(await baseTokenErc20.balanceOf(adapter.address)).to.equal(0);
            });
          });
        });
      }
    });
  }
});
