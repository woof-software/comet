import hre from 'hardhat';
import { FlashbotsBundleProvider } from '@flashbots/ethers-provider-bundle';
import { BrowserProvider, Wallet } from 'ethers';
import type { Signer } from 'ethers';

import { DeploymentManager } from '../../plugins/deployment_manager/DeploymentManager.js';
import {
  CometInterface__factory,
  OnChainLiquidator__factory,
} from '../../build/types/index.js';
import {
  arbitragePurchaseableCollateral,
  liquidateUnderwaterBorrowers,
  getAssets,
} from './liquidateUnderwaterBorrowers.js';
import type { Asset } from './liquidateUnderwaterBorrowers.js';
import googleCloudLog, { LogSeverity } from './googleCloudLog.js';

const loopDelay = 5000;
const loopsUntilUpdateAssets = 1000;
let assets: Asset[] = [];

async function main() {
  let { DEPLOYMENT: deployment, LIQUIDATOR_ADDRESS: liquidatorAddress, USE_FLASHBOTS: useFlashbots, ETH_PK: ethPk } = process.env;
  if (!liquidatorAddress) {
    throw new Error('missing required env variable: LIQUIDATOR_ADDRESS');
  }
  if (!deployment) {
    throw new Error('missing required env variable: DEPLOYMENT');
  }
  if (useFlashbots && !ethPk) {
    throw new Error('missing required env variable: ETH_PK');
  }

  const connection = await hre.network.getOrCreate();
  const { ethers, networkName: network } = connection;
  const provider = new BrowserProvider(connection.provider);

  googleCloudLog(
    LogSeverity.INFO,
    `Liquidation Bot started ${JSON.stringify({network, deployment, liquidatorAddress, useFlashbots})}`
  );

  const dm = new DeploymentManager(
    network,
    deployment,
    hre,
    {
      writeCacheToDisk: false,
      verificationStrategy: 'eager',
    }
  );
  await dm.spider();

  const contracts = await dm.contracts();
  const cometContract = contracts.get('comet');
  if (!cometContract) {
    throw new Error(`no deployed Comet found for ${network}/${deployment}`);
  }
  const comet = CometInterface__factory.connect(
    await cometContract.getAddress(),
    cometContract.runner
  );

  // Flashbots provider requires passing in a standard provider
  let flashbotsProvider: FlashbotsBundleProvider | undefined;
  let signer: Signer;
  if (useFlashbots && useFlashbots.toLowerCase() === 'true') {
    // XXX use a designated auth signer
    // `authSigner` is an Ethereum private key that does NOT store funds and is NOT your bot's primary key.
    // This is an identifying key for signing payloads to establish reputation and whitelisting
    // In production, this should be used across multiple bundles to build relationship. In this example, we generate a new wallet each time
    const authSigner = Wallet.createRandom();

    if (network === 'mainnet') {
      // Flashbots publishes CommonJS ethers types, while this project uses ESM ethers types.
      flashbotsProvider = await FlashbotsBundleProvider.create(
        provider as unknown as Parameters<typeof FlashbotsBundleProvider.create>[0],
        authSigner as unknown as Parameters<typeof FlashbotsBundleProvider.create>[1],
      );
    } else {
      throw new Error(`Unsupported network: ${network}`);
    }

    // Note: A `Wallet` is used because it can sign a transaction for flashbots while a generic `Signer` cannot
    // See https://github.com/ethers-io/ethers.js/issues/1869
    const normalizedPrivateKey = ethPk.startsWith('0x') ? ethPk : `0x${ethPk}`;
    signer = new Wallet(normalizedPrivateKey, provider);
  } else {
    signer = await dm.getSigner();
  }

  const signerWithFlashbots = { signer, flashbotsProvider };

  const liquidator = OnChainLiquidator__factory.connect(
    liquidatorAddress,
    signer
  );

  let lastBlockNumber: number;
  let loops = 0;
  while (true) {
    if (assets.length == 0 || loops >= loopsUntilUpdateAssets) {
      googleCloudLog(LogSeverity.INFO, 'Updating assets');
      assets = await getAssets(comet);
      loops = 0;
    }

    const currentBlockNumber = await ethers.provider.getBlockNumber();

    googleCloudLog(LogSeverity.INFO, `currentBlockNumber: ${currentBlockNumber}`);

    if (currentBlockNumber !== lastBlockNumber) {
      lastBlockNumber = currentBlockNumber;
      const liquidationAttempted = await liquidateUnderwaterBorrowers(
        comet,
        liquidator,
        signerWithFlashbots,
        network,
        deployment
      );
      if (!liquidationAttempted) {
        await arbitragePurchaseableCollateral(
          comet,
          liquidator,
          assets,
          signerWithFlashbots,
          network,
          deployment
        );
      }
    } else {
      googleCloudLog(LogSeverity.INFO, `block already checked; waiting ${loopDelay}ms`);
      await new Promise(resolve => setTimeout(resolve, loopDelay));
    }

    loops += 1;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
