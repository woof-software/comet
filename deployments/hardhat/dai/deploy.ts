import { Deployed, DeploymentManager } from '../../../plugins/deployment_manager';
import { FaucetToken, SimplePriceFeed } from '../../../build/types';
import { DeploySpec, cloneGov, exp, wait } from '../../../src/deploy';
import { ethers } from 'ethers';
// Adapter constants + route builder come from the DEX-adapter test helpers, as in deployments/mainnet/usdc-dex.
import { buildRoutesFromList, CORE_ROUTER, REDUNDANT_ROUTER, SLIPPAGE_BPS, TOKENS } from '../../../test/helpers';

// Executor incentive (bps) on the DEX route. The DAO constant additionally holds admin + pauser roles
// on every module by default (see LiquidationAccessControl), which scenarios impersonate.
const INCENTIVE_BPS = 500; // 5%

async function makeToken(
  deploymentManager: DeploymentManager,
  amount: number,
  name: string,
  decimals: number,
  symbol: string
): Promise<FaucetToken> {
  const mint = (BigInt(amount) * 10n ** BigInt(decimals)).toString();
  return deploymentManager.deploy(symbol, 'test/FaucetToken.sol', [mint, name, decimals, symbol]);
}

async function makePriceFeed(
  deploymentManager: DeploymentManager,
  alias: string,
  initialPrice: number,
  decimals: number
): Promise<SimplePriceFeed> {
  return deploymentManager.deploy(alias, 'test/SimplePriceFeed.sol', [initialPrice * 1e8, decimals]);
}

/**
 * Local (non-forked) development market wired with the liquidation module + DEX adapter, so the
 * liquidation scenarios (which filter on `getLiquidationModuleAddress`) run on `--bases development`.
 *
 * NOTE: This mirrors deployments/mainnet/usdc-dex — it deploys the Comet implementation directly and
 * deliberately does NOT call `deployAndUpgradeTo`. The Comet constructor initializes the module
 * (`setAssetList`) and `initializeStorage` calls `initiateModule`; a second implementation deploy would
 * re-initialize the same module and revert `AlreadySet`. The module is therefore deployed only here for
 * development; other markets provide an already-deployed module address.
 */
export default async function deploy(deploymentManager: DeploymentManager, _deploySpec: DeploySpec): Promise<Deployed> {
  const trace = deploymentManager.tracer();
  const signer = await deploymentManager.getSigner();

  // Governance contracts (timelock becomes the market governor / pause guardian).
  const { fauceteer, timelock } = await cloneGov(deploymentManager);

  const DAI = await makeToken(deploymentManager, 10000000, 'DAI', 18, 'DAI');
  const GOLD = await makeToken(deploymentManager, 20000000, 'GOLD', 8, 'GOLD');
  const SILVER = await makeToken(deploymentManager, 30000000, 'SILVER', 10, 'SILVER');

  const daiPriceFeed = await makePriceFeed(deploymentManager, 'DAI:priceFeed', 1, 8);
  const goldPriceFeed = await makePriceFeed(deploymentManager, 'GOLD:priceFeed', 0.5, 8);
  const silverPriceFeed = await makePriceFeed(deploymentManager, 'SILVER:priceFeed', 0.05, 8);

  // DEX adapter — GOLD/SILVER have no on-chain DEX routes on the dev network, so every route is Unset
  // and keeper liquidations fall back to the pure absorb path.
  const routes = buildRoutesFromList([GOLD.address, SILVER.address], {});
  const adapter = await deploymentManager.deploy(
    'dexAdapter',
    'dex-adapters/core/OneInchV6Adapter.sol',
    [CORE_ROUTER, REDUNDANT_ROUTER, TOKENS.WETH.address, SLIPPAGE_BPS, routes],
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
        name32: ethers.utils.formatBytes32String('Compound DAI'),
        symbol32: ethers.utils.formatBytes32String('cDAIv3'),
      },
      assetListFactory.address,
    ],
    true
  );

  const cometAdmin = await deploymentManager.deploy('cometAdmin', 'CometProxyAdmin.sol', [signer.address], true);

  const assetConfigs = [
    {
      asset: GOLD.address,
      priceFeed: goldPriceFeed.address,
      decimals: 8,
      borrowCollateralFactor: exp(0.9, 18),
      liquidateCollateralFactor: exp(0.91, 18),
      liquidationFactor: exp(0.95, 18),
      supplyCap: exp(1000000, 8),
    },
    {
      asset: SILVER.address,
      priceFeed: silverPriceFeed.address,
      decimals: 10,
      borrowCollateralFactor: exp(0.4, 18),
      liquidateCollateralFactor: exp(0.5, 18),
      liquidationFactor: exp(0.9, 18),
      supplyCap: exp(500000, 10),
    },
  ];

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

  const rewards = await deploymentManager.deploy('rewards', 'CometRewards.sol', [signer.address], true);
  trace(await wait(rewards.connect(signer).setRewardConfig(comet.address, GOLD.address)));

  // Seed rewards with GOLD.
  await deploymentManager.idempotent(
    async () => (await GOLD.balanceOf(rewards.address)).eq(0),
    async () => {
      trace(`Sending some GOLD to CometRewards`);
      const amount = exp(2_000_000, 8);
      trace(await wait(GOLD.connect(signer).transfer(rewards.address, amount)));
    }
  );

  // Mint some tokens to the fauceteer.
  await Promise.all(
    ([[DAI, 1e8], [GOLD, 2e6], [SILVER, 1e7]] as [FaucetToken, number][]).map(([asset, units]) => {
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
