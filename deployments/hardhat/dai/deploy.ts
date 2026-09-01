import type { Contract } from 'ethers';

import { DeploymentManager } from '../../../plugins/deployment_manager/index.js';
import type { Deployed } from '../../../plugins/deployment_manager/index.js';
import { getHardhatEthers } from '../../../plugins/deployment_manager/hardhat3/runtime.js';
import type { Configurator, FaucetToken, SimplePriceFeed } from '../../../build/types/index.js';
import { cloneGov, deployComet, exp, sameAddress, wait } from '../../../src/deploy/index.js';
import type { DeploySpec } from '../../../src/deploy/index.js';

// Fixed test addresses for the dev market-admin role (impersonated by scenarios).
const MARKET_ADMIN = '0x1111111111111111111111111111111111111111';
const MARKET_ADMIN_PAUSE_GUARDIAN = '0x2222222222222222222222222222222222222222';

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

// TODO: Support configurable assets as well?
export default async function deploy(deploymentManager: DeploymentManager, deploySpec: DeploySpec): Promise<Deployed> {
  const trace = deploymentManager.tracer();
  const ethers = await getHardhatEthers(deploymentManager.hre);
  const signer = await deploymentManager.getSigner();
  const signerAddress = await signer.getAddress();

  // Deploy governance contracts
  const { fauceteer } = await cloneGov(deploymentManager);

  const DAI = await makeToken(deploymentManager, 10000000, 'DAI', 18, 'DAI');
  const GOLD = await makeToken(deploymentManager, 20000000, 'GOLD', 8, 'GOLD');
  const SILVER = await makeToken(deploymentManager, 30000000, 'SILVER', 10, 'SILVER');

  const daiPriceFeed = await makePriceFeed(deploymentManager, 'DAI:priceFeed', 1, 8);
  const goldPriceFeed = await makePriceFeed(deploymentManager, 'GOLD:priceFeed', 0.5, 8);
  const silverPriceFeed = await makePriceFeed(deploymentManager, 'SILVER:priceFeed', 0.05, 8);

  const daiPriceFeedAddress = await daiPriceFeed.getAddress();
  const goldAddress = await GOLD.getAddress();
  const goldPriceFeedAddress = await goldPriceFeed.getAddress();
  const silverAddress = await SILVER.getAddress();
  const silverPriceFeedAddress = await silverPriceFeed.getAddress();

  const assetConfig0 = {
    asset: goldAddress,
    priceFeed: goldPriceFeedAddress,
    decimals: (8).toString(),
    borrowCollateralFactor: (0.9e18).toString(),
    liquidateCollateralFactor: (0.91e18).toString(),
    liquidationFactor: (0.95e18).toString(),
    supplyCap: (1000000e8).toString(),
  };

  const assetConfig1 = {
    asset: silverAddress,
    priceFeed: silverPriceFeedAddress,
    decimals: (10).toString(),
    borrowCollateralFactor: (0.4e18).toString(),
    liquidateCollateralFactor: (0.5e18).toString(),
    liquidationFactor: (0.9e18).toString(),
    supplyCap: (500000e10).toString(),
  };

  // Deploy all Comet-related contracts
  const deployed = await deployComet(deploymentManager, deploySpec, {
    baseTokenPriceFeed: daiPriceFeedAddress,
    assetConfigs: [assetConfig0, assetConfig1],
  });
  const { rewards } = deployed;
  const configurator = deployed.configurator as unknown as Configurator;

  // Deploy + wire a MarketAdminPermissionChecker so the market-admin Configurator
  // scenarios are exercised on the local development base. On live networks this is
  // rolled out per-market via a gov_marketupdates migration; here we bake it into the
  // fresh dev deployment so the feature is enabled instead of left at address(0).
  const configuratorGovernor = await configurator.governor();
  const marketAdminPermissionChecker = await deploymentManager.deploy(
    'marketAdminPermissionChecker',
    'marketupdates/MarketAdminPermissionChecker.sol',
    [configuratorGovernor, MARKET_ADMIN, MARKET_ADMIN_PAUSE_GUARDIAN]
  );
  const marketAdminPermissionCheckerAddress = await marketAdminPermissionChecker.getAddress();

  // The Configurator governor is the timelock after deployComet, so impersonate it to
  // call the governor-only setter (dev base runs on the hardhat network).
  await deploymentManager.idempotent(
    async () =>
      !sameAddress(
        await configurator.marketAdminPermissionChecker(),
        marketAdminPermissionCheckerAddress
      ),
    async () => {
      trace(`Setting MarketAdminPermissionChecker in Configurator to ${marketAdminPermissionCheckerAddress}`);
      await ethers.provider.send('hardhat_impersonateAccount', [configuratorGovernor]);
      await ethers.provider.send('hardhat_setBalance', [
        configuratorGovernor,
        '0x' + (10n ** 18n).toString(16),
      ]);
      const govSigner = await ethers.getSigner(configuratorGovernor);
      trace(
        await wait(
          configurator
            .connect(govSigner)
            .setMarketAdminPermissionChecker(marketAdminPermissionCheckerAddress)
        )
      );
      await ethers.provider.send('hardhat_stopImpersonatingAccount', [configuratorGovernor]);
    }
  );

  const rewardsAddress = await rewards.getAddress();
  await deploymentManager.idempotent(
    async () => await GOLD.balanceOf(rewardsAddress) === 0n,
    async () => {
      trace(`Sending some GOLD to CometRewards`);
      const amount = exp(2_000_000, 8);
      trace(await wait((GOLD.connect(signer) as Contract).transfer(rewardsAddress, amount)));
      trace(`GOLD.balanceOf(${rewardsAddress}): ${await GOLD.balanceOf(rewardsAddress)}`);
    }
  );

  // Mint some tokens
  trace(`Attempting to mint as ${signerAddress}...`);

  const fauceteerAddress = await fauceteer.getAddress();
  const assetsAndUnits: Array<[Contract, number]> = [
    [DAI, 1e8],
    [GOLD, 2e6],
    [SILVER, 1e7],
  ];

  for (const [asset, units] of assetsAndUnits) {
    await deploymentManager.idempotent(
      async () => await asset.balanceOf(fauceteerAddress) === 0n,
      async () => {
        trace(`Minting ${units} ${await asset.symbol()} to fauceteer`);
        const amount = exp(units, await asset.decimals());
        trace(await wait((asset.connect(signer) as Contract).allocateTo(fauceteerAddress, amount)));
        trace(`asset.balanceOf(${signerAddress}): ${await asset.balanceOf(signerAddress)}`);
      }
    );
  }

  return { ...deployed, fauceteer };
}
