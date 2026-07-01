// TODO: Remove this test once all real comets are updated to have liquidation module and dex adapter.
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
  SLIPPAGE_BPS,
  ONEINCH_SLIPPAGE_PCT,
  ERC20_EVENTS_IFACE,
  SWAP_ROUTES,
  TOKENS_BY_NETWORK,
  TokenInfo,
  NETWORKS,
} from '../../test/helpers';

/**
 * Cross-network sweep: execute swap for every supported network, every Comet market and every configured collateral.
 * A network runs only when `ONEINCH_API_KEY` and its fork RPC env var is set.
 */

describe('OneInchV6CoreAdapter core & redundant swap sweep', function () {
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
              CORE_ROUTER,
              net.redundantRouter,
              net.weth,
              SLIPPAGE_BPS,
              routes
            );
            await adapter.deployed();
            // The Comet exposes numAssets()/getAssetInfo(), so it doubles as the IAssetList for route
            // validation. `moduleSigner` stands in for the liquidation module that calls initiateAdapter.
            await adapter.connect(moduleSigner).initiateAdapter(market.comet, market.comet, baseToken);

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
                  eq(args.to, net.redundantRouter)
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

            it(`swaps ${symbol} into the base asset via the Uniswap redundant router`, async function () {
              const collateral = (await comet.getAssetInfo(assetIndex)).asset;
              expect(await adapter.routeKind(collateral)).to.not.equal(0); // Check that route is set
              const collateralErc20 = ERC20__factory.connect(collateral, ethers.provider);

              await setErc20Balance(collateral, adapter.address, funding.amount, funding.slot);
              const amountIn = await collateralErc20.balanceOf(adapter.address);
              const quote = "0x";
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
                  eq(args.to, net.redundantRouter)
              );

              expect(routedThroughRedundant).to.not.be.undefined; // Check that swap was routed through redundant router
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
