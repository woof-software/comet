import { encodeBytes32String } from 'ethers';
import type { Contract, Signer } from 'ethers';

import { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import type { Deployed } from '../../plugins/deployment_manager/index.js';
import { COMP_WHALES, wait } from './index.js';
import type { DeploySpec, ProtocolConfiguration } from './index.js';
import { getConfiguration } from './NetworkConfiguration.js';

export function sameAddress(a: string, b: string) {
  return BigInt(a) === BigInt(b);
}

// XXX make sure we are deploying clone contracts from the cache
//  to preserve local development speed and without network
export async function cloneGov(
  deploymentManager: DeploymentManager,
  voterAddress = COMP_WHALES.testnet[0],
  adminSigner?: Signer
): Promise<Deployed> {
  const trace = deploymentManager.tracer();
  const admin = adminSigner ?? await deploymentManager.getSigner();
  const adminAddress = await admin.getAddress();
  const clone = {
    comp: '0xc00e94cb662c3520282e6f5717214004a7f26888',
    governorBravoImpl: '0xef3b6e9e13706a8f01fe98fdcf66335dc5cfdeed',
    governorBravo: '0xc0da02939e1441f497fd74f78ce7decb17b66529',
  };

  const fauceteer = await deploymentManager.deploy('fauceteer', 'test/Fauceteer.sol', []);
  const timelock = await deploymentManager.deploy('timelock', 'test/SimpleTimelock.sol', [adminAddress]);

  const COMP = await deploymentManager.deploy('COMP', 'test/Comp.sol', [adminAddress]);

  const governorImpl = await deploymentManager.clone('governor:implementation', clone.governorBravoImpl, [], 'mainnet', true);
  const timelockAddress = await timelock.getAddress();
  const compAddress = await COMP.getAddress();
  const governorImplAddress = await governorImpl.getAddress();
  const governorProxy = await deploymentManager.clone('governor', clone.governorBravo, [
    timelockAddress,
    compAddress,
    adminAddress,
    governorImplAddress,
    await governorImpl.MIN_VOTING_PERIOD(),
    await governorImpl.MIN_VOTING_DELAY(),
    await governorImpl.MIN_PROPOSAL_THRESHOLD(),
  ]);
  const governor = governorImpl.attach(await governorProxy.getAddress()) as Contract;
  const governorAddress = await governor.getAddress();
  const fauceteerAddress = await fauceteer.getAddress();

  await deploymentManager.idempotent(
    async () => await COMP.balanceOf(adminAddress) >= await COMP.totalSupply() / 3n,
    async () => {
      trace(`Sending 1/4 of COMP to fauceteer, 1/4 to timelock`);
      const amount = await COMP.balanceOf(adminAddress) / 4n;
      trace(await wait((COMP.connect(admin) as Contract).transfer(fauceteerAddress, amount)));
      trace(await wait((COMP.connect(admin) as Contract).transfer(timelockAddress, amount)));
      trace(`COMP.balanceOf(${fauceteerAddress}): ${await COMP.balanceOf(fauceteerAddress)}`);
      trace(`COMP.balanceOf(${timelockAddress}): ${await COMP.balanceOf(timelockAddress)}`);
    }
  );

  await deploymentManager.idempotent(
    async () => await COMP.getCurrentVotes(voterAddress) === 0n,
    async () => {
      trace(`Delegating COMP votes to ${voterAddress}`);
      trace(await wait((COMP.connect(admin) as Contract).delegate(voterAddress)));
      trace(`COMP.getCurrentVotes(${voterAddress}): ${await COMP.getCurrentVotes(voterAddress)}`);
    }
  );

  await deploymentManager.idempotent(
    async () => await governor.proposalCount() === 0n,
    async () => {
      trace(`Initiating Governor using patched Timelock`);
      trace(await wait((governor.connect(admin) as Contract)._initiate(timelockAddress)));
    }
  );

  await deploymentManager.idempotent(
    async () => !sameAddress(await timelock.admin(), governorAddress),
    async () => {
      trace(`Transferring Governor of Timelock to ${governorAddress}`);
      trace(await wait((timelock.connect(admin) as Contract).setAdmin(governorAddress)));
    }
  );

  return { COMP, fauceteer, governor, timelock };
}

export async function deployNetworkComet(
  deploymentManager: DeploymentManager,
  deploySpec: DeploySpec = { all: true },
  configOverrides: ProtocolConfiguration = {},
  adminSigner?: Signer,
): Promise<Deployed> {
  function maybeForce(flag?: boolean): boolean {
    return deploySpec.all || flag;
  }

  const trace = deploymentManager.tracer();
  const admin = adminSigner ?? await deploymentManager.getSigner();
  const adminAddress = await admin.getAddress();

  const {
    name,
    symbol,
    governor, // NB: generally 'timelock' alias, not 'governor'
    pauseGuardian,
    baseToken,
    baseTokenPriceFeed,
    supplyKink,
    supplyPerYearInterestRateSlopeLow,
    supplyPerYearInterestRateSlopeHigh,
    supplyPerYearInterestRateBase,
    borrowKink,
    borrowPerYearInterestRateSlopeLow,
    borrowPerYearInterestRateSlopeHigh,
    borrowPerYearInterestRateBase,
    storeFrontPriceFactor,
    trackingIndexScale,
    baseTrackingSupplySpeed,
    baseTrackingBorrowSpeed,
    baseMinForRewards,
    baseBorrowMin,
    targetReserves,
    assetConfigs,
    rewardTokenAddress
  } = await getConfiguration(deploymentManager, configOverrides);

  /* Deploy contracts */

  const cometAdmin = await deploymentManager.deploy(
    'cometAdmin',
    'CometProxyAdmin.sol',
    [adminAddress],
    maybeForce()
  );

  const extConfiguration = {
    name32: encodeBytes32String(name),
    symbol32: encodeBytes32String(symbol)
  };

  const assetListFactory = await deploymentManager.deploy(
    'assetListFactory',
    'AssetListFactory.sol',
    [],
    maybeForce()
  );
  const assetListFactoryAddress = await assetListFactory.getAddress();
  const cometExt = await deploymentManager.deploy(
    'comet:implementation:implementation',
    'CometExtAssetList.sol',
    [extConfiguration, assetListFactoryAddress],
    maybeForce(deploySpec.cometExt)
  );
  const cometExtAddress = await cometExt.getAddress();

  const cometFactory = await deploymentManager.deploy(
    'cometFactory',
    'CometFactoryWithExtendedAssetList.sol',
    [],
    maybeForce(deploySpec.cometMain)
  );
  const cometFactoryAddress = await cometFactory.getAddress();

  const configuration = {
    governor,
    pauseGuardian,
    baseToken,
    baseTokenPriceFeed,
    extensionDelegate: cometExtAddress,
    supplyKink,
    supplyPerYearInterestRateSlopeLow,
    supplyPerYearInterestRateSlopeHigh,
    supplyPerYearInterestRateBase,
    borrowKink,
    borrowPerYearInterestRateSlopeLow,
    borrowPerYearInterestRateSlopeHigh,
    borrowPerYearInterestRateBase,
    storeFrontPriceFactor,
    trackingIndexScale,
    baseTrackingSupplySpeed,
    baseTrackingBorrowSpeed,
    baseMinForRewards,
    baseBorrowMin,
    targetReserves,
    assetConfigs,
  };

  const tmpCometImpl = await deploymentManager.deploy(
    'comet:implementation',
    'CometWithExtendedAssetList.sol',
    [configuration],
    maybeForce()
  );
  const tmpCometImplAddress = await tmpCometImpl.getAddress();
  const cometAdminAddress = await cometAdmin.getAddress();

  const cometProxy = await deploymentManager.deploy(
    'comet',
    'vendor/proxy/transparent/TransparentUpgradeableProxy.sol',
    [tmpCometImplAddress, cometAdminAddress, '0x'], // NB: temporary implementation contract
    maybeForce(),
  );

  const configuratorImpl = await deploymentManager.deploy(
    'configurator:implementation',
    'Configurator.sol',
    [],
    maybeForce()
  );
  const configuratorImplAddress = await configuratorImpl.getAddress();

  // If we deploy a new proxy, we initialize it to the current/new impl
  // If its an existing proxy, the impl we got for the alias must already be current
  // In other words, we shan't have deployed an impl in the last step unless there was no proxy too
  const configuratorProxy = await deploymentManager.deploy(
    'configurator',
    'ConfiguratorProxy.sol',
    [
      configuratorImplAddress,
      cometAdminAddress,
      (await configuratorImpl.getFunction('initialize').populateTransaction(adminAddress)).data,
    ],
    maybeForce()
  );
  const configuratorProxyAddress = await configuratorProxy.getAddress();

  const rewards = await deploymentManager.deploy(
    'rewards',
    'CometRewards.sol',
    [adminAddress],
    maybeForce(deploySpec.rewards)
  );

  /* Wire things up */

  // Now configure the configurator and actually deploy comet
  // Note: the success of these calls is dependent on who the admin is and if/when its been transferred
  //  scenarios can pass in an impersonated signer, but real deploys may require proposals for some states
  const configurator = configuratorImpl.attach(configuratorProxyAddress) as Contract;

  // Also get a handle for Comet, although it may not *actually* support the interface yet
  const cometProxyAddress = await cometProxy.getAddress();
  const comet = await deploymentManager.cast<Contract>(
    cometProxyAddress,
    'contracts/CometInterface.sol:CometInterface'
  );
  const cometAddress = await comet.getAddress();

  // Call initializeStorage if storage not initialized
  // Note: we now rely on the fact that anyone may call, which helps separate the proposal
  await deploymentManager.idempotent(
    async () => (await (comet.connect(admin) as Contract).totalsBasic()).lastAccrualTime === 0n,
    async () => {
      trace(`Initializing Comet at ${cometAddress}`);
      trace(await wait((comet.connect(admin) as Contract).initializeStorage()));
    }
  );

  // If we aren't admin, we'll need proposals to configure things
  const amAdmin = sameAddress(await cometAdmin.owner(), adminAddress);

  // Get the current impl addresses for the proxies, and determine if we've configurated
  const $configuratorImpl = await cometAdmin.getProxyImplementation(configuratorProxyAddress);
  const $cometImpl = await cometAdmin.getProxyImplementation(cometAddress);
  const isTmpImpl = sameAddress($cometImpl, tmpCometImplAddress);

  // Note: these next setup steps may require a follow-up proposal to complete, if we cannot admin here
  await deploymentManager.idempotent(
    async () => amAdmin && !sameAddress($configuratorImpl, configuratorImplAddress),
    async () => {
      trace(`Setting Configurator implementation to ${configuratorImplAddress}`);
      trace(await wait(
        (cometAdmin.connect(admin) as Contract).upgrade(configuratorProxyAddress, configuratorImplAddress)
      ));
    }
  );

  await deploymentManager.idempotent(
    async () => amAdmin && !sameAddress(await configurator.factory(cometAddress), cometFactoryAddress),
    async () => {
      trace(`Setting factory in Configurator to ${cometFactoryAddress}`);
      trace(await wait(
        (configurator.connect(admin) as Contract).setFactory(cometAddress, cometFactoryAddress)
      ));
    }
  );

  await deploymentManager.idempotent(
    async () => amAdmin && (isTmpImpl || deploySpec.all || deploySpec.cometMain || deploySpec.cometExt),
    async () => {
      trace(`Setting configuration in Configurator for ${cometAddress} (${isTmpImpl})`);
      trace(await wait(
        (configurator.connect(admin) as Contract).setConfiguration(cometAddress, configuration)
      ));

      trace(`Upgrading implementation of Comet...`);
      trace(await wait(
        (cometAdmin.connect(admin) as Contract).deployAndUpgradeTo(configuratorProxyAddress, cometAddress)
      ));

      trace(`New Comet implementation at ${await cometAdmin.getProxyImplementation(cometAddress)}`);
    }
  );

  await deploymentManager.idempotent(
    async () => amAdmin && rewardTokenAddress !== undefined
      && !sameAddress((await rewards.rewardConfig(cometAddress)).token, rewardTokenAddress),
    async () => {
      trace(`Setting reward token in CometRewards to ${rewardTokenAddress} for ${cometAddress}`);
      trace(await wait(
        (rewards.connect(admin) as Contract).setRewardConfig(cometAddress, rewardTokenAddress)
      ));
    }
  );

  /* Transfer to Gov */

  await deploymentManager.idempotent(
    async () => !sameAddress(await configurator.governor(), governor),
    async () => {
      trace(`Transferring governor of Configurator to ${governor}`);
      trace(await wait((configurator.connect(admin) as Contract).transferGovernor(governor)));
    }
  );

  await deploymentManager.idempotent(
    async () => !sameAddress(await cometAdmin.owner(), governor),
    async () => {
      trace(`Transferring ownership of CometProxyAdmin to ${governor}`);
      trace(await wait((cometAdmin.connect(admin) as Contract).transferOwnership(governor)));
    }
  );

  await deploymentManager.idempotent(
    async () => !sameAddress(await rewards.governor(), governor),
    async () => {
      trace(`Transferring governor of CometRewards to ${governor}`);
      trace(await wait((rewards.connect(admin) as Contract).transferGovernor(governor)));
    }
  );

  return { comet, configurator, rewards, cometFactory };
}
