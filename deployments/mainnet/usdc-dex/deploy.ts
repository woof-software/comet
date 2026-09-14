import { Deployed, DeploymentManager } from '../../../plugins/deployment_manager';
import { DeploySpec, exp, wait } from '../../../src/deploy';
import { ethers } from 'ethers';
// Routes + adapter constants come from the DEX-adapter test helpers (swap-routes.ts), as with the tests.
import {
  MARKETS,
  buildRoutesFromList,
  CORE_ROUTER,
  REDUNDANT_ROUTER,
  SLIPPAGE_BPS,
  TOKENS,
} from '../../../test/helpers';

/**
 * Fresh mainnet fork deployment of a Comet with Liquidation module and Dex Adapter.
 * Uses real assets compatible with 1Inch and Uniswap for quote generation and swap execution.
 * Deploys Dex adapter with swap routes, liquidation module and Comet.
 * Used as a test deployment for dex liquidation until real Comets are not updated to support liquidation module.
 */

const GOVERNOR = '0x6d903f6003cca6255D85CcA4D3B5E5146dC33925'; // Compound timelock and module's DAO.

const COLLATERALS: { info: { address: string; slot?: number | string }; decimals: number; price: bigint }[] = [
  { info: TOKENS.WBTC, decimals: 8, price: 5_882_352_941_176n },
  { info: TOKENS.WETH, decimals: 18, price: 156_250_000_000n },
  { info: TOKENS.WSTETH, decimals: 18, price: 156_250_000_000n },
  { info: TOKENS.UNI, decimals: 18, price: 273_972_602n },
  { info: TOKENS.LINK, decimals: 18, price: 714_285_714n },
];

// TODO use real executor addresses for non-test deployments.
const INCENTIVE_BPS = 500; // 5%

export default async function deploy(
  deploymentManager: DeploymentManager,
  deploySpec: DeploySpec
): Promise<Deployed> {
  const signer = await deploymentManager.getSigner();
  const trace = deploymentManager.tracer();

  // Real mainnet tokens.
  const USDC = await deploymentManager.existing('USDC', TOKENS.USDC.address);
  for (const { info } of COLLATERALS) {
    await deploymentManager.existing(await tokenAlias(info.address), info.address);
  }

  // Mock price feeds (controllable via setRoundData in scenarios).
  const usdcPriceFeed = await deploymentManager.deploy('USDC:priceFeed', 'test/SimplePriceFeed.sol', [exp(1, 8), 8], true);
  const priceFeeds: Record<string, string> = {};
  for (const { info, price } of COLLATERALS) {
    const feed = await deploymentManager.deploy(`${await tokenAlias(info.address)}:priceFeed`, 'test/SimplePriceFeed.sol', [price, 8], true);
    priceFeeds[info.address] = feed.address;
  }

  // DEX adapter (routes from swap-routes.ts; UNI is dropped so it stays route-less and is swept back to Comet
  // on liquidation).
  const collateralAddresses = COLLATERALS.map((c) => c.info.address);
  const usdcRoutesNoUni = Object.fromEntries(
    Object.entries(MARKETS.usdc.routes).filter(([addr]) => addr.toLowerCase() !== TOKENS.UNI.address.toLowerCase())
  );
  const routes = buildRoutesFromList(collateralAddresses, usdcRoutesNoUni);
  const adapter = await deploymentManager.deploy(
    'dexAdapter',
    'dex-adapters/core/OneInchV6Adapter.sol',
    // Last arg: per-collateral slippage overrides (none — use the global slippage for every route).
    [CORE_ROUTER, REDUNDANT_ROUTER, TOKENS.WETH.address, SLIPPAGE_BPS, routes, []],
    true
  );

  // DEX liquidation module.
  const liquidationModule = await deploymentManager.deploy(
    'liquidationModule',
    'liquidation-module/DexLiquidationModule.sol',
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
        name32: ethers.utils.formatBytes32String('Compound USDC (DEX)'),
        symbol32: ethers.utils.formatBytes32String('cUSDCv3-dex'),
      },
      assetListFactory.address,
    ],
    true
  );

  const cometAdmin = await deploymentManager.deploy('cometAdmin', 'CometProxyAdmin.sol', [signer.address], true);

  const assetConfigs = COLLATERALS.map(({ info, decimals }) => ({
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
async function tokenAlias(address: string): Promise<string> {
  const entry = Object.entries(TOKENS).find(([, t]) => t.address.toLowerCase() === address.toLowerCase());
  return entry ? entry[0] : address;
}
