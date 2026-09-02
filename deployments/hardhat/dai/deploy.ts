import { Deployed, DeploymentManager } from '../../../plugins/deployment_manager';
import { FaucetToken, SimplePriceFeed } from '../../../build/types';
import { DeploySpec, NetworkConfiguration, cloneGov, exp, wait } from '../../../src/deploy';
import { ethers } from 'ethers';
import {
  buildInitialCollateralSlippages,
  buildRoutesFromList,
  CORE_ROUTER,
  REDUNDANT_ROUTER,
  SLIPPAGE_BPS,
  TOKENS,
} from '../../../test/helpers';

// Executor incentive (bps) on the DEX route. The DAO constant additionally holds admin + pauser roles
// on every module by default (see LiquidationAccessControl), which scenarios impersonate.
const INCENTIVE_BPS = 500; // 5%

async function makeToken(
  deploymentManager: DeploymentManager,
  name: string,
  decimals: number,
  symbol: string
): Promise<FaucetToken> {
  return deploymentManager.deploy(symbol, 'test/FaucetToken.sol', [0, name, decimals, symbol]);
}

async function makePriceFeed(
  deploymentManager: DeploymentManager,
  alias: string,
  priceUsd: number
): Promise<SimplePriceFeed> {
  // SimplePriceFeed stores prices in 1e8 scale (same as Chainlink USD feeds).
  const price = Math.round(priceUsd * 1e8);
  return deploymentManager.deploy(alias, 'test/SimplePriceFeed.sol', [price, 8]);
}

/**
 * Local (non-forked) development market wired with the liquidation module + DEX adapter, so the
 * liquidation scenarios (which filter on `getLiquidationModuleAddress`) run on `--bases development`.
 *
 * Collaterals are declared in configuration.json and deployed here as FaucetTokens + SimplePriceFeeds.
 * This mirrors deployments/mainnet/usdc-dex — it deploys the Comet implementation directly and
 * deliberately does NOT call `deployAndUpgradeTo` (a second module init would revert `AlreadySet`).
 */
export default async function deploy(deploymentManager: DeploymentManager, _deploySpec: DeploySpec): Promise<Deployed> {
  const trace = deploymentManager.tracer();
  const signer = await deploymentManager.getSigner();
  const config = await deploymentManager.readConfig<NetworkConfiguration>();

  const assetEntries = Object.entries(config.assets);

  // Governance contracts (timelock becomes the market governor / pause guardian).
  const { fauceteer, timelock } = await cloneGov(deploymentManager);

  // Base token + feed first, then every collateral from configuration.json.
  // Protocol params below stay hardcoded (as before); configuration.json only drives the asset list.
  const DAI = await makeToken(deploymentManager, 'DAI', 18, 'DAI');
  const daiPriceFeed = await makePriceFeed(deploymentManager, 'DAI:priceFeed', 1);

  const collateralTokens: FaucetToken[] = [];
  const assetConfigs = [];
  for (const [symbol, assetConfig] of assetEntries) {
    const token = await makeToken(
      deploymentManager,
      symbol,
      assetConfig.decimals,
      symbol
    );
    const priceFeed = await makePriceFeed(deploymentManager, `${symbol}:priceFeed`, assetConfig.price!);
    collateralTokens.push(token);

    const [supplyCapAmount, supplyCapDecimals] = assetConfig.supplyCap.split('e').map(Number);
    assetConfigs.push({
      asset: token.address,
      priceFeed: priceFeed.address,
      decimals: Number(assetConfig.decimals),
      borrowCollateralFactor: exp(assetConfig.borrowCF, 18),
      liquidateCollateralFactor: exp(assetConfig.liquidateCF, 18),
      liquidationFactor: exp(assetConfig.liquidationFactor, 18),
      supplyCap: exp(supplyCapAmount, supplyCapDecimals),
    });
  }

  // No on-chain DEX routes on the local network — every route is Unset, so keeper liquidations fall
  // back to the pure absorb path.
  const routes = buildRoutesFromList(collateralTokens.map((token) => token.address), {});
  const adapter = await deploymentManager.deploy(
    'dexAdapter',
    'dex-adapters/core/OneInchV6Adapter.sol',
    // No per-collateral slippage overrides: every asset uses the global SLIPPAGE_BPS.
    [
      CORE_ROUTER,
      REDUNDANT_ROUTER,
      TOKENS.WETH.address,
      SLIPPAGE_BPS,
      routes,
      buildInitialCollateralSlippages(),
    ],
    true
  );

  // Base liquidation module. The signer holds multisig/executor/pauser roles for local testing.
  const liquidationModule = await deploymentManager.deploy(
    'liquidationModule',
    'liquidation-module/LiquidationModule.sol',
    [adapter.address, signer.address, [signer.address], [signer.address], INCENTIVE_BPS],
    true
  );

  // Extension delegate + asset-list factory (the module requires the extended asset list).
  const assetListFactory = await deploymentManager.deploy('assetListFactory', 'AssetListFactory.sol', [], true);
  const cometExt = await deploymentManager.deploy(
    'comet:implementation:implementation',
    'CometExtAssetList.sol',
    [
      {
        name32: ethers.utils.formatBytes32String(config.name),
        symbol32: ethers.utils.formatBytes32String(config.symbol),
      },
      assetListFactory.address,
    ],
    true
  );

  const cometAdmin = await deploymentManager.deploy('cometAdmin', 'CometProxyAdmin.sol', [signer.address], true);

  const configuration = {
    governor: timelock.address,
    pauseGuardian: timelock.address,
    extensionDelegate: cometExt.address,
    liquidationModule: liquidationModule.address,
    baseToken: DAI.address,
    baseTokenPriceFeed: daiPriceFeed.address,
    supplyKink: exp(0.8, 18),
    supplyPerYearInterestRateBase: exp(0, 18),
    supplyPerYearInterestRateSlopeLow: exp(0.0325, 18),
    supplyPerYearInterestRateSlopeHigh: exp(0.4, 18),
    borrowKink: exp(0.8, 18),
    borrowPerYearInterestRateBase: exp(0.015, 18),
    borrowPerYearInterestRateSlopeLow: exp(0.035, 18),
    borrowPerYearInterestRateSlopeHigh: exp(0.25, 18),
    storeFrontPriceFactor: exp(0.5, 18),
    trackingIndexScale: exp(1, 15),
    baseTrackingSupplySpeed: exp(0, 15),
    baseTrackingBorrowSpeed: exp(0, 15),
    baseMinForRewards: exp(1, 18),
    baseBorrowMin: exp(40, 18), // 40 DAI — sized so a $100 collateral position can borrow 2× minDebt within the BCF limit
    targetReserves: exp(5000000, 18),
    assetConfigs,
  };

  // Comet implementation + proxy. The constructor wires the module to this single implementation.
  const cometImpl = await deploymentManager.deploy('comet:implementation', 'CometWithExtendedAssetList.sol', [configuration], true);
  const cometProxy = await deploymentManager.deploy(
    'comet',
    'vendor/proxy/transparent/TransparentUpgradeableProxy.sol',
    [cometImpl.address, cometAdmin.address, []],
    true
  );
  const comet = await deploymentManager.cast(cometProxy.address, 'contracts/CometInterface.sol:CometInterface');
  trace(await wait(comet.connect(signer).initializeStorage()));

  // Configurator + factory kept consistent for framework tooling. Deliberately do NOT deployAndUpgradeTo
  // (it would re-init the module and revert AlreadySet).
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

  // Reward token is GOLD — always present in configuration.json assets.
  const rewards = await deploymentManager.deploy('rewards', 'CometRewards.sol', [signer.address], true);
  const GOLD = collateralTokens[assetEntries.findIndex(([symbol]) => symbol === 'GOLD')];
  trace(await wait(rewards.connect(signer).setRewardConfig(comet.address, GOLD.address)));

  // Seed rewards with GOLD.
  await deploymentManager.idempotent(
    async () => (await GOLD.balanceOf(rewards.address)).eq(0),
    async () => {
      trace(`Sending some GOLD to CometRewards`);
      const amount = exp(2_000_000, 8);
      trace(await wait(GOLD.connect(signer).allocateTo(rewards.address, amount)));
    }
  );

  // Mint some tokens to the fauceteer for every locally deployed asset.
  const faucetAssets: [FaucetToken, number][] = [
    [DAI, 1e8],
    ...collateralTokens.map((token): [FaucetToken, number] => [token, 1e7]),
  ];
  await Promise.all(
    faucetAssets.map(([asset, units]) => {
      return deploymentManager.idempotent(
        async () => (await asset.balanceOf(fauceteer.address)).eq(0),
        async () => {
          trace(`Minting ${units} ${await asset.symbol()} to fauceteer`);
          const amount = exp(units, await asset.decimals());
          trace(await wait(asset.connect(signer).allocateTo(fauceteer.address, amount)));
        }
      );
    })
  );

  // Hand governance to the timelock.
  trace(await wait(configurator.connect(signer).transferGovernor(timelock.address)));
  trace(await wait(cometAdmin.connect(signer).transferOwnership(timelock.address)));
  trace(await wait(rewards.connect(signer).transferGovernor(timelock.address)));

  return { comet, configurator, cometAdmin, rewards, cometFactory, fauceteer };
}
