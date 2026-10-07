import { scenario } from './context/CometContext.js';
import { expect } from 'chai';
import { AbiCoder } from 'ethers';
import {
  ArbitrumBridgeReceiver__factory,
  LineaBridgeReceiver__factory,
  PolygonBridgeReceiver__factory,
  ScrollBridgeReceiver__factory,
  Timelock__factory
} from '../build/types/index.js';
import { calldata } from '../src/deploy/index.js';
import { isBridgedDeployment, matchesDeployment, createCrossChainProposal } from './utils/index.js';

const abiCoder = AbiCoder.defaultAbiCoder();

// This is a generic scenario that runs for all L2s and sidechains
scenario(
  'execute cross-chain governance proposal',
  {
    filter: async ctx => isBridgedDeployment(ctx)
  },
  async ({ comet, timelock, bridgeReceiver }, context) => {
    const currentTimelockDelay = await timelock.delay();
    const newTimelockDelay = currentTimelockDelay * 2n;

    // Cross-chain proposal to change L2 timelock's delay and pause L2 Comet actions
    const setDelayCalldata = abiCoder.encode(['uint'], [newTimelockDelay]);
    const pauseCalldata = await calldata(comet.pause.populateTransaction(true, true, true, true, true));
    const l2ProposalData = abiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [await timelock.getAddress(), await comet.getAddress()],
        [0, 0],
        ['setDelay(uint256)', 'pause(bool,bool,bool,bool,bool)'],
        [setDelayCalldata, pauseCalldata]
      ]
    );

    expect(await timelock.delay()).to.eq(currentTimelockDelay);
    expect(currentTimelockDelay).to.not.eq(newTimelockDelay);

    await createCrossChainProposal(context, l2ProposalData, bridgeReceiver);

    expect(await timelock.delay()).to.eq(newTimelockDelay);
    expect(await comet.isAbsorbPaused()).to.eq(true);
    expect(await comet.isBuyPaused()).to.eq(true);
    expect(await comet.isSupplyPaused()).to.eq(true);
    expect(await comet.isTransferPaused()).to.eq(true);
    expect(await comet.isWithdrawPaused()).to.eq(true);
  }
);

// This is a Polygon-specific scenario that tests the governance contract upgrade flow
scenario(
  'upgrade Polygon governance contracts and ensure they work properly',
  {
    filter: async ctx => matchesDeployment(ctx, [{network: 'polygon'}])
  },
  async ({ comet, configurator, proxyAdmin, timelock: oldLocalTimelock, bridgeReceiver: oldBridgeReceiver }, context, world) => {
    const dm = world.deploymentManager;
    const govDeploymentManager = world.auxiliaryDeploymentManager!;
    const fxChild = await dm.getContractOrThrow('fxChild');

    // Deploy new PolygonBridgeReceiver
    const newBridgeReceiverContract = await dm.deploy(
      'newBridgeReceiver',
      'bridges/polygon/PolygonBridgeReceiver.sol',
      [await fxChild.getAddress()]           // fxChild
    );
    const newBridgeReceiver = PolygonBridgeReceiver__factory.connect(
      await newBridgeReceiverContract.getAddress(), newBridgeReceiverContract.runner
    );

    // Deploy new local Timelock
    const secondsPerDay = 24 * 60 * 60;
    const newLocalTimelockContract = await dm.deploy(
      'newTimelock',
      'vendor/Timelock.sol',
      [
        await newBridgeReceiver.getAddress(), // admin
        2 * secondsPerDay,         // delay
        14 * secondsPerDay,        // grace period
        2 * secondsPerDay,         // minimum delay
        30 * secondsPerDay         // maxiumum delay
      ]
    );
    const newLocalTimelock = Timelock__factory.connect(
      await newLocalTimelockContract.getAddress(), newLocalTimelockContract.runner
    );

    // Initialize new PolygonBridgeReceiver
    const mainnetTimelock = await (await govDeploymentManager.getContractOrThrow('timelock')).getAddress();
    await newBridgeReceiver.initialize(
      mainnetTimelock,             // govTimelock
      await newLocalTimelock.getAddress()     // localTimelock
    );

    // Process for upgrading L2 governance contracts (order matters):
    // 1. Update the admin of Comet in Configurator to be the new Timelock
    // 2. Update the admin of CometProxyAdmin to be the new Timelock
    const transferOwnershipCalldata = abiCoder.encode(
      ['address'],
      [await newLocalTimelock.getAddress()]
    );
    const setGovernorCalldata = await calldata(
      configurator.setGovernor.populateTransaction(await comet.getAddress(), await newLocalTimelock.getAddress())
    );
    const deployAndUpgradeToCalldata = abiCoder.encode(
      ['address', 'address'],
      [await configurator.getAddress(), await comet.getAddress()]
    );
    const upgradeL2GovContractsProposal = abiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [await configurator.getAddress(), await proxyAdmin.getAddress(), await proxyAdmin.getAddress()],
        [0, 0, 0],
        [
          'setGovernor(address,address)',
          'deployAndUpgradeTo(address,address)',
          'transferOwnership(address)'
        ],
        [setGovernorCalldata, deployAndUpgradeToCalldata, transferOwnershipCalldata]
      ]
    );

    expect(await proxyAdmin.owner()).to.eq(await oldLocalTimelock.getAddress());
    expect(await comet.governor()).to.eq(await oldLocalTimelock.getAddress());

    await createCrossChainProposal(context, upgradeL2GovContractsProposal, oldBridgeReceiver);

    expect(await proxyAdmin.owner()).to.eq(await newLocalTimelock.getAddress());
    expect(await comet.governor()).to.eq(await newLocalTimelock.getAddress());

    // Update aliases now that the new Timelock and BridgeReceiver are official
    await dm.putAlias('timelock', newLocalTimelockContract);
    await dm.putAlias('bridgeReceiver', newBridgeReceiverContract);

    // Now, test that the new L2 governance contracts are working properly via another cross-chain proposal
    const currentTimelockDelay = await newLocalTimelock.delay();
    const newTimelockDelay = currentTimelockDelay * 2n;

    const setDelayCalldata = abiCoder.encode(['uint'], [newTimelockDelay]);
    const pauseCalldata = await calldata(comet.pause.populateTransaction(true, true, true, true, true));
    const l2ProposalData = abiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [await newLocalTimelock.getAddress(), await comet.getAddress()],
        [0, 0],
        ['setDelay(uint256)', 'pause(bool,bool,bool,bool,bool)'],
        [setDelayCalldata, pauseCalldata]
      ]
    );

    expect(await newLocalTimelock.delay()).to.eq(currentTimelockDelay);
    expect(currentTimelockDelay).to.not.eq(newTimelockDelay);

    await createCrossChainProposal(context, l2ProposalData, newBridgeReceiver);

    expect(await newLocalTimelock.delay()).to.eq(newTimelockDelay);
    expect(await comet.isAbsorbPaused()).to.eq(true);
    expect(await comet.isBuyPaused()).to.eq(true);
    expect(await comet.isSupplyPaused()).to.eq(true);
    expect(await comet.isTransferPaused()).to.eq(true);
    expect(await comet.isWithdrawPaused()).to.eq(true);
  }
);

scenario(
  'upgrade Arbitrum governance contracts and ensure they work properly',
  {
    filter: async ctx => matchesDeployment(ctx, [{network: 'arbitrum'}])
  },
  async ({ comet, configurator, proxyAdmin, timelock: oldLocalTimelock, bridgeReceiver: oldBridgeReceiver }, context, world) => {
    const dm = world.deploymentManager;
    const governanceDeploymentManager = world.auxiliaryDeploymentManager;
    if (!governanceDeploymentManager) {
      throw new Error('cannot execute governance without governance deployment manager');
    }

    // Deploy new ArbitrumBridgeReceiver
    const newBridgeReceiverContract = await dm.deploy(
      'newBridgeReceiver',
      'bridges/arbitrum/ArbitrumBridgeReceiver.sol',
      []
    );
    const newBridgeReceiver = ArbitrumBridgeReceiver__factory.connect(
      await newBridgeReceiverContract.getAddress(), newBridgeReceiverContract.runner
    );

    // Deploy new local Timelock
    const secondsPerDay = 24 * 60 * 60;
    const newLocalTimelockContract = await dm.deploy(
      'newTimelock',
      'vendor/Timelock.sol',
      [
        await newBridgeReceiver.getAddress(), // admin
        2 * secondsPerDay,         // delay
        14 * secondsPerDay,        // grace period
        2 * secondsPerDay,         // minimum delay
        30 * secondsPerDay         // maxiumum delay
      ]
    );
    const newLocalTimelock = Timelock__factory.connect(
      await newLocalTimelockContract.getAddress(), newLocalTimelockContract.runner
    );

    // Initialize new ArbitrumBridgeReceiver
    const mainnetTimelock = await (await governanceDeploymentManager.getContractOrThrow('timelock')).getAddress();
    await newBridgeReceiver.initialize(
      mainnetTimelock,             // govTimelock
      await newLocalTimelock.getAddress()     // localTimelock
    );

    // Process for upgrading L2 governance contracts (order matters):
    // 1. Update the admin of Comet in Configurator to be the new Timelock
    // 2. Update the admin of CometProxyAdmin to be the new Timelock
    const transferOwnershipCalldata = abiCoder.encode(
      ['address'],
      [await newLocalTimelock.getAddress()]
    );
    const setGovernorCalldata = await calldata(
      configurator.setGovernor.populateTransaction(await comet.getAddress(), await newLocalTimelock.getAddress())
    );
    const deployAndUpgradeToCalldata = abiCoder.encode(
      ['address', 'address'],
      [await configurator.getAddress(), await comet.getAddress()]
    );
    const upgradeL2GovContractsProposal = abiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [await configurator.getAddress(), await proxyAdmin.getAddress(), await proxyAdmin.getAddress()],
        [0, 0, 0],
        [
          'setGovernor(address,address)',
          'deployAndUpgradeTo(address,address)',
          'transferOwnership(address)'
        ],
        [setGovernorCalldata, deployAndUpgradeToCalldata, transferOwnershipCalldata]
      ]
    );

    expect(await proxyAdmin.owner()).to.eq(await oldLocalTimelock.getAddress());
    expect(await comet.governor()).to.eq(await oldLocalTimelock.getAddress());

    await createCrossChainProposal(context, upgradeL2GovContractsProposal, oldBridgeReceiver);

    expect(await proxyAdmin.owner()).to.eq(await newLocalTimelock.getAddress());
    expect(await comet.governor()).to.eq(await newLocalTimelock.getAddress());

    // Update aliases now that the new Timelock and BridgeReceiver are official
    await dm.putAlias('timelock', newLocalTimelockContract);
    await dm.putAlias('bridgeReceiver', newBridgeReceiverContract);

    // Now, test that the new L2 governance contracts are working properly via another cross-chain proposal
    const currentTimelockDelay = await newLocalTimelock.delay();
    const newTimelockDelay = currentTimelockDelay * 2n;

    const setDelayCalldata = abiCoder.encode(['uint'], [newTimelockDelay]);
    const pauseCalldata = await calldata(comet.pause.populateTransaction(true, true, true, true, true));
    const l2ProposalData = abiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [await newLocalTimelock.getAddress(), await comet.getAddress()],
        [0, 0],
        ['setDelay(uint256)', 'pause(bool,bool,bool,bool,bool)'],
        [setDelayCalldata, pauseCalldata]
      ]
    );

    expect(await newLocalTimelock.delay()).to.eq(currentTimelockDelay);
    expect(currentTimelockDelay).to.not.eq(newTimelockDelay);

    await createCrossChainProposal(context, l2ProposalData, newBridgeReceiver);

    expect(await newLocalTimelock.delay()).to.eq(newTimelockDelay);
    expect(await comet.isAbsorbPaused()).to.eq(true);
    expect(await comet.isBuyPaused()).to.eq(true);
    expect(await comet.isSupplyPaused()).to.eq(true);
    expect(await comet.isTransferPaused()).to.eq(true);
    expect(await comet.isWithdrawPaused()).to.eq(true);
  }
);

scenario.skip(
  'upgrade Linea governance contracts and ensure they work properly',
  {
    filter: async ctx => matchesDeployment(ctx, [{ network: 'linea-goerli' }])
  },
  async (
    {
      comet,
      configurator,
      proxyAdmin,
      timelock: oldLocalTimelock,
      bridgeReceiver: oldBridgeReceiver
    },
    context,
    world
  ) => {
    const dm = world.deploymentManager;
    const governanceDeploymentManager = world.auxiliaryDeploymentManager;
    if (!governanceDeploymentManager) {
      throw new Error('cannot execute governance without governance deployment manager');
    }

    const l2MessageService = await dm.getContractOrThrow('l2MessageService');

    // Deploy new LineaBridgeReceiver
    const newBridgeReceiverContract = await dm.deploy(
      'newBridgeReceiver',
      'bridges/linea/LineaBridgeReceiver.sol',
      [await l2MessageService.getAddress()]
    );
    const newBridgeReceiver = LineaBridgeReceiver__factory.connect(
      await newBridgeReceiverContract.getAddress(), newBridgeReceiverContract.runner
    );

    // Deploy new local Timelock
    const secondsPerDay = 24 * 60 * 60;
    const newLocalTimelockContract = await dm.deploy('newTimelock', 'vendor/Timelock.sol', [
      await newBridgeReceiver.getAddress(), // admin
      2 * secondsPerDay, // delay
      14 * secondsPerDay, // grace period
      2 * secondsPerDay, // minimum delay
      30 * secondsPerDay // maxiumum delay
    ]);
    const newLocalTimelock = Timelock__factory.connect(
      await newLocalTimelockContract.getAddress(), newLocalTimelockContract.runner
    );

    // Initialize new LineaBridgeReceiver
    const mainnetTimelock = await (await governanceDeploymentManager.getContractOrThrow('timelock')).getAddress();
    await newBridgeReceiver.initialize(
      mainnetTimelock, // govTimelock
      await newLocalTimelock.getAddress() // localTimelock
    );

    // Process for upgrading L2 governance contracts (order matters):
    // 1. Update the admin of Comet in Configurator to be the new Timelock
    // 2. Update the admin of CometProxyAdmin to be the new Timelock
    const transferOwnershipCalldata = abiCoder.encode(
      ['address'],
      [await newLocalTimelock.getAddress()]
    );
    const setGovernorCalldata = await calldata(
      configurator.setGovernor.populateTransaction(await comet.getAddress(), await newLocalTimelock.getAddress())
    );
    const deployAndUpgradeToCalldata = abiCoder.encode(
      ['address', 'address'],
      [await configurator.getAddress(), await comet.getAddress()]
    );
    const upgradeL2GovContractsProposal = abiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [await configurator.getAddress(), await proxyAdmin.getAddress(), await proxyAdmin.getAddress()],
        [0, 0, 0],
        [
          'setGovernor(address,address)',
          'deployAndUpgradeTo(address,address)',
          'transferOwnership(address)'
        ],
        [setGovernorCalldata, deployAndUpgradeToCalldata, transferOwnershipCalldata]
      ]
    );

    expect(await proxyAdmin.owner()).to.eq(await oldLocalTimelock.getAddress());
    expect(await comet.governor()).to.eq(await oldLocalTimelock.getAddress());

    await createCrossChainProposal(context, upgradeL2GovContractsProposal, oldBridgeReceiver);

    expect(await proxyAdmin.owner()).to.eq(await newLocalTimelock.getAddress());
    expect(await comet.governor()).to.eq(await newLocalTimelock.getAddress());

    // Update aliases now that the new Timelock and BridgeReceiver are official
    await dm.putAlias('timelock', newLocalTimelockContract);
    await dm.putAlias('bridgeReceiver', newBridgeReceiverContract);

    // Now, test that the new L2 governance contracts are working properly via another cross-chain proposal
    const currentTimelockDelay = await newLocalTimelock.delay();
    const newTimelockDelay = currentTimelockDelay * 2n;

    const setDelayCalldata = abiCoder.encode(['uint'], [newTimelockDelay]);
    const pauseCalldata = await calldata(
      comet.pause.populateTransaction(true, true, true, true, true)
    );
    const l2ProposalData = abiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [await newLocalTimelock.getAddress(), await comet.getAddress()],
        [0, 0],
        ['setDelay(uint256)', 'pause(bool,bool,bool,bool,bool)'],
        [setDelayCalldata, pauseCalldata]
      ]
    );

    expect(await newLocalTimelock.delay()).to.eq(currentTimelockDelay);
    expect(currentTimelockDelay).to.not.eq(newTimelockDelay);

    await createCrossChainProposal(context, l2ProposalData, newBridgeReceiver);

    expect(await newLocalTimelock.delay()).to.eq(newTimelockDelay);
    expect(await comet.isAbsorbPaused()).to.eq(true);
    expect(await comet.isBuyPaused()).to.eq(true);
    expect(await comet.isSupplyPaused()).to.eq(true);
    expect(await comet.isTransferPaused()).to.eq(true);
    expect(await comet.isWithdrawPaused()).to.eq(true);
  }
);

scenario(
  'upgrade Scroll governance contracts and ensure they work properly',
  {
    filter: async ctx => matchesDeployment(ctx, [{network: 'scroll'}])
  },
  async (
    {
      comet,
      configurator,
      proxyAdmin,
      timelock: oldLocalTimelock,
      bridgeReceiver: oldBridgeReceiver
    },
    context,
    world
  ) => {
    const dm = world.deploymentManager;
    const governanceDeploymentManager = world.auxiliaryDeploymentManager;
    if (!governanceDeploymentManager) {
      throw new Error('cannot execute governance without governance deployment manager');
    }

    const l2Messenger = await dm.getContractOrThrow('l2Messenger');

    // Deploy new ScrollBridgeReceiver
    const newBridgeReceiverContract = await dm.deploy(
      'newBridgeReceiver',
      'bridges/scroll/ScrollBridgeReceiver.sol',
      [await l2Messenger.getAddress()]
    );
    const newBridgeReceiver = ScrollBridgeReceiver__factory.connect(
      await newBridgeReceiverContract.getAddress(), newBridgeReceiverContract.runner
    );

    // Deploy new local Timelock
    const secondsPerDay = 24 * 60 * 60;
    const newLocalTimelockContract = await dm.deploy('newTimelock', 'vendor/Timelock.sol', [
      await newBridgeReceiver.getAddress(), // admin
      2 * secondsPerDay, // delay
      14 * secondsPerDay, // grace period
      2 * secondsPerDay, // minimum delay
      30 * secondsPerDay // maxiumum delay
    ]);
    const newLocalTimelock = Timelock__factory.connect(
      await newLocalTimelockContract.getAddress(), newLocalTimelockContract.runner
    );

    // Initialize new ScrollBridgeReceiver
    const mainnetTimelock = await (await governanceDeploymentManager.getContractOrThrow('timelock')).getAddress();
    await newBridgeReceiver.initialize(
      mainnetTimelock, // govTimelock
      await newLocalTimelock.getAddress() // localTimelock
    );

    // Process for upgrading L2 governance contracts (order matters):
    // 1. Update the admin of Comet in Configurator to be the new Timelock
    // 2. Update the admin of CometProxyAdmin to be the new Timelock
    const transferOwnershipCalldata = abiCoder.encode(
      ['address'],
      [await newLocalTimelock.getAddress()]
    );
    const setGovernorCalldata = await calldata(
      configurator.setGovernor.populateTransaction(await comet.getAddress(), await newLocalTimelock.getAddress())
    );
    const deployAndUpgradeToCalldata = abiCoder.encode(
      ['address', 'address'],
      [await configurator.getAddress(), await comet.getAddress()]
    );
    const upgradeL2GovContractsProposal = abiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [await configurator.getAddress(), await proxyAdmin.getAddress(), await proxyAdmin.getAddress()],
        [0, 0, 0],
        [
          'setGovernor(address,address)',
          'deployAndUpgradeTo(address,address)',
          'transferOwnership(address)'
        ],
        [setGovernorCalldata, deployAndUpgradeToCalldata, transferOwnershipCalldata]
      ]
    );

    expect(await proxyAdmin.owner()).to.eq(await oldLocalTimelock.getAddress());
    expect(await comet.governor()).to.eq(await oldLocalTimelock.getAddress());

    await createCrossChainProposal(context, upgradeL2GovContractsProposal, oldBridgeReceiver);

    expect(await proxyAdmin.owner()).to.eq(await newLocalTimelock.getAddress());
    expect(await comet.governor()).to.eq(await newLocalTimelock.getAddress());

    // Update aliases now that the new Timelock and BridgeReceiver are official
    await dm.putAlias('timelock', newLocalTimelockContract);
    await dm.putAlias('bridgeReceiver', newBridgeReceiverContract);

    // Now, test that the new L2 governance contracts are working properly via another cross-chain proposal
    const currentTimelockDelay = await newLocalTimelock.delay();
    const newTimelockDelay = currentTimelockDelay * 2n;

    const setDelayCalldata = abiCoder.encode(['uint'], [newTimelockDelay]);
    const pauseCalldata = await calldata(
      comet.pause.populateTransaction(true, true, true, true, true)
    );
    const l2ProposalData = abiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [await newLocalTimelock.getAddress(), await comet.getAddress()],
        [0, 0],
        ['setDelay(uint256)', 'pause(bool,bool,bool,bool,bool)'],
        [setDelayCalldata, pauseCalldata]
      ]
    );

    expect(await newLocalTimelock.delay()).to.eq(currentTimelockDelay);
    expect(currentTimelockDelay).to.not.eq(newTimelockDelay);

    await createCrossChainProposal(context, l2ProposalData, newBridgeReceiver);

    expect(await newLocalTimelock.delay()).to.eq(newTimelockDelay);
    expect(await comet.isAbsorbPaused()).to.eq(true);
    expect(await comet.isBuyPaused()).to.eq(true);
    expect(await comet.isSupplyPaused()).to.eq(true);
    expect(await comet.isTransferPaused()).to.eq(true);
    expect(await comet.isWithdrawPaused()).to.eq(true);
  }
);
