import hre from 'hardhat';
import { readFileSync, writeFileSync } from 'fs';
import { Contract, Signer, utils } from 'ethers';
import {
  SimplePriceFeed__factory,
  OneInchV6Adapter__factory,
  LiquidationModule__factory,
  AssetListFactory__factory,
  CometExtAssetList__factory,
  CometProxyAdmin__factory,
  CometWithExtendedAssetList__factory,
  TransparentUpgradeableProxy__factory,
  CometInterface__factory,
  Configurator__factory,
  ConfiguratorProxy__factory,
  CometFactoryWithExtendedAssetList__factory,
  CometRewards__factory,
} from '../../../build/types';
import { MARKETS, buildRoutesFromList, CORE_ROUTER, REDUNDANT_ROUTER, TOKENS } from '../../../test/helpers';
import { exp } from '../../../src/deploy';

/**
 * Localhost deployment for Demo. Deploy Comet with Dex Adapter and Liquidation Module.
 * Roles: signers[0] is the deployer, Comet's governor and pauseGuardian and the module's multisig/executor/pauser.
 * signers[1] is the lender, signers[2] the borrower.
 *
 * Run against a forked node:  npx hardhat node --fork $MAINNET_QUICKNODE_LINK
 *                             npx hardhat run deployments/localhost/usdc-dex/deploy.ts --network localhost
 */

const SLIPPAGE_BPS = 1000; // 10%
const INCENTIVE_BPS = 500; // 5%

type MarketConfigFile = {
  baseTokenAddress: string;
  baseTokenPrice: number;
  baseTokenSlot: number;
  borrowMin: string;
  storeFrontPriceFactor: number;
  targetReserves: string;
  rates: Record<string, number>;
  tracking: Record<string, string>;
  assets: Record<string, { address: string; price: number; decimals: string; slot: number; borrowCF: number; liquidateCF: number; liquidationFactor: number; supplyCap: string }>;
};

const factor = (n: number): bigint => exp(n, 18);
const sci = (s: string): bigint => {
  const [mantissa, exponent = '0'] = String(s).split('e');
  return exp(Number(mantissa), Number(exponent));
};

// Deploy a contract and wait for it to be mined.
  const dep = async <T extends Contract>(pending: Promise<T>): Promise<T> => {
    const contract = await pending;
    await contract.deployed();
    return contract;
  };

async function main() {
  const { ethers } = hre;
  const [deployer, lender, borrower] = await ethers.getSigners();
  const signer = deployer as unknown as Signer;

  if (hre.network.name === 'localhost' || hre.network.name === 'hardhat') {
    await hre.network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x0']);
  }

  const cfg = JSON.parse(readFileSync(`${__dirname}/configuration.json`, 'utf8')) as MarketConfigFile;
  const assetEntries = Object.entries(cfg.assets);

  console.log('Deploying Compound USDC (DEX demo)');
  console.log(`  deployer/admin: ${deployer.address}`);
  console.log(`  lender:         ${lender.address}`);
  console.log(`  borrower:       ${borrower.address}\n`);

  // Mock price feeds.
  const usdcPriceFeed = await dep(new SimplePriceFeed__factory(signer).deploy(exp(cfg.baseTokenPrice, 8), 8));
  const priceFeeds: Record<string, string> = {};
  for (const [symbol, a] of assetEntries) {
    const feed = await dep(new SimplePriceFeed__factory(signer).deploy(exp(a.price, 8), 8));
    priceFeeds[a.address] = feed.address;
    console.log(`  ${symbol} mock feed @ ${feed.address}  ($${a.price})`);
  }

  // DEX adapter.
  const collateralAddresses = assetEntries.map(([, a]) => a.address);
  const routes = buildRoutesFromList(collateralAddresses, MARKETS.usdc.routes);
  const adapter = await dep(
    new OneInchV6Adapter__factory(signer).deploy(CORE_ROUTER, REDUNDANT_ROUTER, TOKENS.WETH.address, SLIPPAGE_BPS, routes)
  );

  // Liquidation module.
  const liquidationModule = await dep(
    new LiquidationModule__factory(signer).deploy(adapter.address, deployer.address, [deployer.address], [deployer.address], INCENTIVE_BPS)
  );

  // Extension delegate + asset-list factory + proxy admin.
  const assetListFactory = await dep(new AssetListFactory__factory(signer).deploy());
  const cometExt = await dep(
    new CometExtAssetList__factory(signer).deploy(
      {
        name32: utils.formatBytes32String('Compound USDC (demo)'),
        symbol32: utils.formatBytes32String('cUSDCv3-dex'),
      },
      assetListFactory.address
    )
  );
  const cometAdmin = await dep(new CometProxyAdmin__factory(signer).deploy(deployer.address));

  const assetConfigs = assetEntries.map(([, a]) => ({
    asset: a.address,
    priceFeed: priceFeeds[a.address],
    decimals: Number(a.decimals),
    borrowCollateralFactor: factor(a.borrowCF),
    liquidateCollateralFactor: factor(a.liquidateCF),
    liquidationFactor: factor(a.liquidationFactor),
    supplyCap: sci(a.supplyCap),
  }));

  const configuration = {
    governor: deployer.address,
    pauseGuardian: deployer.address,
    extensionDelegate: cometExt.address,
    liquidationModule: liquidationModule.address,
    baseToken: cfg.baseTokenAddress,
    baseTokenPriceFeed: usdcPriceFeed.address,
    supplyKink: factor(cfg.rates.supplyKink),
    supplyPerYearInterestRateBase: factor(cfg.rates.supplyBase),
    supplyPerYearInterestRateSlopeLow: factor(cfg.rates.supplySlopeLow),
    supplyPerYearInterestRateSlopeHigh: factor(cfg.rates.supplySlopeHigh),
    borrowKink: factor(cfg.rates.borrowKink),
    borrowPerYearInterestRateBase: factor(cfg.rates.borrowBase),
    borrowPerYearInterestRateSlopeLow: factor(cfg.rates.borrowSlopeLow),
    borrowPerYearInterestRateSlopeHigh: factor(cfg.rates.borrowSlopeHigh),
    storeFrontPriceFactor: factor(cfg.storeFrontPriceFactor),
    trackingIndexScale: sci(cfg.tracking.indexScale),
    baseTrackingSupplySpeed: sci(cfg.tracking.baseSupplySpeed),
    baseTrackingBorrowSpeed: sci(cfg.tracking.baseBorrowSpeed),
    baseMinForRewards: sci(cfg.tracking.baseMinForRewards),
    baseBorrowMin: sci(cfg.borrowMin),
    targetReserves: sci(cfg.targetReserves),
    assetConfigs,
  };

  // Construct the Comet once + proxy + initializeStorage.
  const cometImpl = await dep(new CometWithExtendedAssetList__factory(signer).deploy(configuration));
  const cometProxy = await dep(
    new TransparentUpgradeableProxy__factory(signer).deploy(cometImpl.address, cometAdmin.address, '0x')
  );
  const comet = CometInterface__factory.connect(cometProxy.address, signer);
  await (await comet.initializeStorage()).wait();

  // Configurator + factory.
  const cometFactory = await dep(new CometFactoryWithExtendedAssetList__factory(signer).deploy());
  const configuratorImpl = await dep(new Configurator__factory(signer).deploy());
  const initData = configuratorImpl.interface.encodeFunctionData('initialize', [deployer.address]);
  const configuratorProxy = await dep(
    new ConfiguratorProxy__factory(signer).deploy(configuratorImpl.address, cometAdmin.address, initData)
  );
  const configurator = Configurator__factory.connect(configuratorProxy.address, signer);
  await (await configurator.setFactory(comet.address, cometFactory.address)).wait();
  await (await configurator.setConfiguration(comet.address, configuration)).wait();

  const rewards = await dep(new CometRewards__factory(signer).deploy(deployer.address));

  const roots = {
    comet: comet.address,
    configurator: configurator.address,
    cometAdmin: cometAdmin.address,
    rewards: rewards.address,
    cometFactory: cometFactory.address,
    liquidationModule: liquidationModule.address,
    dexAdapter: adapter.address,
  };
  writeFileSync(`${__dirname}/roots.json`, JSON.stringify(roots, null, 2) + '\n');

  console.log('\nComet deployed at:', comet.address);
  console.log('Wrote', `${__dirname}/roots.json`);
  console.log(`\nNext:  Run 02-supply-and-borrow or 02a-supply-and-borrow-multi`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
