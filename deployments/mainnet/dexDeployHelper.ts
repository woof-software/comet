import { Deployed, DeploymentManager } from '../../plugins/deployment_manager';
import { DeploySpec, exp, wait } from '../../src/deploy';
import { ethers } from 'ethers';
import {
  RouteConfig,
  buildRoutesFromList,
  CORE_ROUTER,
  REDUNDANT_ROUTER,
  SLIPPAGE_BPS,
  TOKENS,
} from '../../test/helpers';

/**
 * Shared builder for the DEX-liquidation test markets (usdc-dex, usdc-dex-1, usdc-dex-24).
 *
 * Deploys, on a mainnet fork, a fresh Comet wired to a LiquidationModule + OneInchV6Adapter using real assets
 * that 1Inch and Uniswap V4 can quote/swap. Collateral price feeds are mock `SimplePriceFeed`s so scenarios can
 * drop prices via `setRoundData`. Interest rates and borrowMin are zero so the seizure plan is stable.
 *
 * The number of collaterals (1 / 5 / 24) and which of them carry a Uniswap route is fully parameterized, so the
 * `scenario/liquidation/dex` filters can pin each scenario to a market by `numAssets`.
 */

// Compound timelock — module DAO (holds DEFAULT_ADMIN_ROLE) and market governor/pause guardian.
const GOVERNOR = '0x6d903f6003cca6255D85CcA4D3B5E5146dC33925';
const INCENTIVE_BPS = 500; // 5%

export interface DexCollateral {
  info: { address: string, slot?: number | string };
  decimals: number;
  price: bigint; // mock oracle price, 8 decimals; keep it at/under the real market price so DEX swaps clear.
}

export interface DexMarketSpec {
  /** Comet name/symbol (<=32 bytes each). */
  name: string;
  symbol: string;
  /** Collaterals to list, in order. */
  collaterals: DexCollateral[];
  /** Uniswap V4 routes keyed by collateral address; any collateral absent here stays route-less (swept/absorbed). */
  routes: Record<string, RouteConfig>;
}

export async function deployDexMarket(
  deploymentManager: DeploymentManager,
  _deploySpec: DeploySpec,
  spec: DexMarketSpec
): Promise<Deployed> {
  const { name, symbol, collaterals, routes } = spec;
  const signer = await deploymentManager.getSigner();
  const trace = deploymentManager.tracer();

  // Real mainnet tokens.
  const USDC = await deploymentManager.existing('USDC', TOKENS.USDC.address);
  for (const { info } of collaterals) {
    await deploymentManager.existing(await tokenAlias(info.address), info.address);
  }

  // Mock price feeds (controllable via setRoundData in scenarios).
  const usdcPriceFeed = await deploymentManager.deploy('USDC:priceFeed', 'test/SimplePriceFeed.sol', [exp(1, 8), 8], true);
  const priceFeeds: Record<string, string> = {};
  for (const { info, price } of collaterals) {
    const feed = await deploymentManager.deploy(`${await tokenAlias(info.address)}:priceFeed`, 'test/SimplePriceFeed.sol', [price, 8], true);
    priceFeeds[info.address] = feed.address;
  }

  // DEX adapter. Route-less collaterals resolve to an unset route and are swept back to Comet on liquidation.
  const collateralAddresses = collaterals.map((c) => c.info.address);
  const routeList = buildRoutesFromList(collateralAddresses, routes);
  const adapter = await deploymentManager.deploy(
    'dexAdapter',
    'dex-adapters/core/OneInchV6Adapter.sol',
    [CORE_ROUTER, REDUNDANT_ROUTER, TOKENS.WETH.address, SLIPPAGE_BPS, routeList],
    true
  );

  // Base liquidation module (signer is the initial executor/pauser/multisig; DAO holds DEFAULT_ADMIN_ROLE).
  const liquidationModule = await deploymentManager.deploy(
    'liquidationModule',
    'liquidation-module/LiquidationModule.sol',
    [adapter.address, signer.address, [signer.address], [signer.address], INCENTIVE_BPS],
    true
  );

  // Extension delegate + asset-list factory.
  const assetListFactory = await deploymentManager.deploy('assetListFactory', 'AssetListFactory.sol', [], true);
  const cometExt = await deploymentManager.deploy(
    'comet:implementation:implementation',
    'CometExtAssetList.sol',
    [
      {
        name32: ethers.utils.formatBytes32String(name),
        symbol32: ethers.utils.formatBytes32String(symbol),
      },
      assetListFactory.address,
    ],
    true
  );

  const cometAdmin = await deploymentManager.deploy('cometAdmin', 'CometProxyAdmin.sol', [signer.address], true);

  const assetConfigs = collaterals.map(({ info, decimals }) => ({
    asset: info.address,
    priceFeed: priceFeeds[info.address],
    decimals,
    borrowCollateralFactor: exp(0.8, 18),
    liquidateCollateralFactor: exp(0.85, 18),
    liquidationFactor: exp(0.9, 18),
    supplyCap: exp(150000, decimals),
  }));

  const configuration = {
    governor: GOVERNOR,
    pauseGuardian: GOVERNOR,
    extensionDelegate: cometExt.address,
    liquidationModule: liquidationModule.address,
    baseToken: USDC.address,
    baseTokenPriceFeed: usdcPriceFeed.address,
    supplyKink: exp(0.8, 18),
    supplyPerYearInterestRateBase: exp(0, 18),
    supplyPerYearInterestRateSlopeLow: exp(0, 18),
    supplyPerYearInterestRateSlopeHigh: exp(0, 18),
    borrowKink: exp(0.8, 18),
    borrowPerYearInterestRateBase: exp(0, 18),
    borrowPerYearInterestRateSlopeLow: exp(0, 18),
    borrowPerYearInterestRateSlopeHigh: exp(0, 18),
    storeFrontPriceFactor: exp(1, 18),
    trackingIndexScale: exp(1, 15),
    baseTrackingSupplySpeed: exp(0, 15),
    baseTrackingBorrowSpeed: exp(0, 15),
    baseMinForRewards: exp(1, 6),
    baseBorrowMin: 0,
    targetReserves: 0,
    assetConfigs,
  };

  // Comet
  const cometImpl = await deploymentManager.deploy('comet:implementation', 'CometWithExtendedAssetList.sol', [configuration], true);
  const cometProxy = await deploymentManager.deploy(
    'comet',
    'vendor/proxy/transparent/TransparentUpgradeableProxy.sol',
    [cometImpl.address, cometAdmin.address, []],
    true
  );
  const comet = await deploymentManager.cast(cometProxy.address, 'contracts/CometInterface.sol:CometInterface');
  trace(await wait(comet.connect(signer).initializeStorage()));

  // Configurator + factory, kept consistent for framework tooling. Deliberately do NOT deployAndUpgradeTo.
  const cometFactory = await deploymentManager.deploy('cometFactory', 'CometFactoryWithExtendedAssetList.sol', [], true);
  const configuratorImpl = await deploymentManager.deploy('configurator:implementation', 'Configurator.sol', [], true);
  const configuratorProxy = await deploymentManager.deploy(
    'configurator',
    'ConfiguratorProxy.sol',
    [configuratorImpl.address, cometAdmin.address, (await configuratorImpl.populateTransaction.initialize(signer.address)).data],
    true
  );
  const configurator = configuratorImpl.attach(configuratorProxy.address);
  trace(await wait(configurator.connect(signer).setFactory(comet.address, cometFactory.address)));
  trace(await wait(configurator.connect(signer).setConfiguration(comet.address, configuration)));

  const rewards = await deploymentManager.deploy('rewards', 'CometRewards.sol', [signer.address], true);

  // Hand governance to the timelock/DAO.
  trace(await wait(configurator.connect(signer).transferGovernor(GOVERNOR)));
  trace(await wait(cometAdmin.connect(signer).transferOwnership(GOVERNOR)));
  trace(await wait(rewards.connect(signer).transferGovernor(GOVERNOR)));

  return { comet, configurator, cometAdmin, rewards, cometFactory };
}

// deploymentManager aliases can't contain the market's real token symbols dynamically, so derive a stable
// alias from the token registry.
export async function tokenAlias(address: string): Promise<string> {
  const entry = Object.entries(TOKENS).find(([, t]) => t.address.toLowerCase() === address.toLowerCase());
  return entry ? entry[0] : address;
}
