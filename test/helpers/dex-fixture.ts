import hre, { ethers } from 'hardhat';
import { Signer } from 'ethers';
import {
  CometInterface,
  CometInterface__factory,
  ERC20,
  ERC20__factory,
  OneInchV6Adapter,
  OneInchV6Adapter__factory,
} from '../../build/types';
import { takeSnapshot, SnapshotRestorer } from './snapshot';
import {
  MarketConfig,
  RouteConfig,
  buildRoutes,
  buildRoutesFromList,
  CORE_ROUTER,
  REDUNDANT_ROUTER,
  SLIPPAGE_BPS,
} from './dex-router';
import { TOKENS } from './swap-routes';

/**
 * Mainnet-fork fixture for the dex adapters unit tests.
 */

// Everything a dex-adapter test needs after deploying the adapter on a mainnet fork.
export interface DexAdapterFixture {
  adapter: OneInchV6Adapter;
  adapterFactory: OneInchV6Adapter__factory;
  routes: RouteConfig[];
  comet: CometInterface;
  baseToken: string;
  baseTokenErc20: ERC20;
  wbtcErc20: ERC20;
  wstethErc20: ERC20;
  wethErc20: ERC20;
  moduleSigner: Signer;
  moduleAddress: string;
  snapshot: SnapshotRestorer;
}


export async function deployEmptyDexAdapter(collaterals: string[]): Promise<OneInchV6Adapter> {
  const adapterFactory = (await ethers.getContractFactory(
    'OneInchV6Adapter'
  )) as OneInchV6Adapter__factory;
  const adapter = await adapterFactory.deploy(
    CORE_ROUTER,
    REDUNDANT_ROUTER,
    TOKENS.WETH.address,
    SLIPPAGE_BPS,
    buildRoutesFromList(collaterals, {}),
    []
  );
  await adapter.deployed();

  return adapter;
}

// Resets the mainnet fork, deploys a OneInchV6Adapter for `market`, and snapshots the post-deploy state.
export async function setupDexAdapter(market: MarketConfig): Promise<DexAdapterFixture> {
  await hre.network.provider.request({
    method: 'hardhat_reset',
    params: [{ forking: { jsonRpcUrl: process.env.MAINNET_QUICKNODE_LINK } }],
  });

  const [, moduleSigner] = await ethers.getSigners();
  const moduleAddress = await moduleSigner.getAddress();

  const comet = CometInterface__factory.connect(market.comet, ethers.provider);
  const baseToken = await comet.baseToken();
  const baseTokenErc20 = ERC20__factory.connect(baseToken, ethers.provider);
  const wbtcErc20 = ERC20__factory.connect(TOKENS.WBTC.address, ethers.provider);
  const wstethErc20 = ERC20__factory.connect(TOKENS.WSTETH.address, ethers.provider);
  const wethErc20 = ERC20__factory.connect(TOKENS.WETH.address, ethers.provider);

  const routes = await buildRoutes(comet, market.routes);

  const adapterFactory = (await ethers.getContractFactory(
    'OneInchV6Adapter'
  )) as OneInchV6Adapter__factory;
  const adapter = await adapterFactory.deploy(
    CORE_ROUTER,
    REDUNDANT_ROUTER,
    TOKENS.WETH.address,
    SLIPPAGE_BPS,
    routes,
    []
  );
  await adapter.deployed();
  await adapter.connect(moduleSigner).initiateAdapter(market.comet);
  await adapter.connect(moduleSigner).setAssetList(await comet.assetList(), await comet.numAssets(), baseToken);

  const snapshot = await takeSnapshot();

  return {
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
  };
}
