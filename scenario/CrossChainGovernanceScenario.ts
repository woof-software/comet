import { scenario } from './context/CometContext';
import { expect } from 'chai';
import { utils } from 'ethers';
import { BaseBridgeReceiver, LineaBridgeReceiver, ScrollBridgeReceiver } from '../build/types';
import { calldata } from '../src/deploy';
import { isBridgedDeployment, matchesDeployment, createCrossChainProposal } from './utils';
import { ArbitrumBridgeReceiver } from '../build/types';

// This is a generic scenario that runs for all L2s and sidechains
scenario(
  'execute cross-chain governance proposal',
  {
    filter: async ctx => isBridgedDeployment(ctx)
  },
  async ({ comet, timelock, bridgeReceiver }, context) => {
    const currentTimelockDelay = await timelock.delay();
    const newTimelockDelay = currentTimelockDelay.mul(2);

    // Cross-chain proposal to change L2 timelock's delay and pause L2 Comet actions
    const setDelayCalldata = utils.defaultAbiCoder.encode(['uint'], [newTimelockDelay]);
    const pauseCalldata = await calldata(comet.populateTransaction.pause(true, true, true, true, true));
    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [timelock.address, comet.address],
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
  async ({ comet, timelock: localTimelock, bridgeReceiver: oldBridgeReceiver }, context, world) => {
    const dm = world.deploymentManager;
    const govDeploymentManager = world.auxiliaryDeploymentManager!;
    const fxChild = await dm.getContractOrThrow('fxChild');

    // Deploy new PolygonBridgeReceiver, bound to the current local Timelock
    const mainnetTimelock = (await govDeploymentManager.getContractOrThrow('timelock')).address;
    const newBridgeReceiver = await dm.deploy<BaseBridgeReceiver, [string, string, string]>(
      'newBridgeReceiver',
      'bridges/polygon/PolygonBridgeReceiver.sol',
      [
        fxChild.address,       // fxChild
        mainnetTimelock,       // govTimelock
        localTimelock.address  // localTimelock
      ]
    );

    // Process for handing the local Timelock over to the new BridgeReceiver (order matters, the old
    // BridgeReceiver stays the admin until the last call):
    // 1. Make the new BridgeReceiver the pending admin of the local Timelock
    // 2. Accept the admin role from the new BridgeReceiver
    const setPendingAdminCalldata = utils.defaultAbiCoder.encode(
      ['address'],
      [newBridgeReceiver.address]
    );
    const handOverLocalTimelockProposal = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [localTimelock.address, newBridgeReceiver.address],
        [0, 0],
        ['setPendingAdmin(address)', 'acceptLocalTimelockAdmin()'],
        [setPendingAdminCalldata, '0x']
      ]
    );

    expect(await localTimelock.admin()).to.eq(oldBridgeReceiver.address);

    await createCrossChainProposal(context, handOverLocalTimelockProposal, oldBridgeReceiver);

    expect(await localTimelock.admin()).to.eq(newBridgeReceiver.address);

    // Update alias now that the new BridgeReceiver is official
    await dm.putAlias('bridgeReceiver', newBridgeReceiver);

    // Now, test that the new BridgeReceiver is working properly via another cross-chain proposal
    const currentTimelockDelay = await localTimelock.delay();
    const newTimelockDelay = currentTimelockDelay.mul(2);

    const setDelayCalldata = utils.defaultAbiCoder.encode(['uint'], [newTimelockDelay]);
    const pauseCalldata = await calldata(comet.populateTransaction.pause(true, true, true, true, true));
    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [localTimelock.address, comet.address],
        [0, 0],
        ['setDelay(uint256)', 'pause(bool,bool,bool,bool,bool)'],
        [setDelayCalldata, pauseCalldata]
      ]
    );

    expect(await localTimelock.delay()).to.eq(currentTimelockDelay);
    expect(currentTimelockDelay).to.not.eq(newTimelockDelay);

    await createCrossChainProposal(context, l2ProposalData, newBridgeReceiver);

    expect(await localTimelock.delay()).to.eq(newTimelockDelay);
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
  async ({ comet, timelock: localTimelock, bridgeReceiver: oldBridgeReceiver }, context, world) => {
    const dm = world.deploymentManager;
    const governanceDeploymentManager = world.auxiliaryDeploymentManager;
    if (!governanceDeploymentManager) {
      throw new Error('cannot execute governance without governance deployment manager');
    }

    // Deploy new ArbitrumBridgeReceiver, bound to the current local Timelock
    const mainnetTimelock = (await governanceDeploymentManager.getContractOrThrow('timelock')).address;
    const newBridgeReceiver = await dm.deploy<ArbitrumBridgeReceiver, [string, string]>(
      'newBridgeReceiver',
      'bridges/arbitrum/ArbitrumBridgeReceiver.sol',
      [
        mainnetTimelock,       // govTimelock
        localTimelock.address  // localTimelock
      ]
    );

    // Process for handing the local Timelock over to the new BridgeReceiver (order matters, the old
    // BridgeReceiver stays the admin until the last call):
    // 1. Make the new BridgeReceiver the pending admin of the local Timelock
    // 2. Accept the admin role from the new BridgeReceiver
    const setPendingAdminCalldata = utils.defaultAbiCoder.encode(
      ['address'],
      [newBridgeReceiver.address]
    );
    const handOverLocalTimelockProposal = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [localTimelock.address, newBridgeReceiver.address],
        [0, 0],
        ['setPendingAdmin(address)', 'acceptLocalTimelockAdmin()'],
        [setPendingAdminCalldata, '0x']
      ]
    );

    expect(await localTimelock.admin()).to.eq(oldBridgeReceiver.address);

    await createCrossChainProposal(context, handOverLocalTimelockProposal, oldBridgeReceiver);

    expect(await localTimelock.admin()).to.eq(newBridgeReceiver.address);

    // Update alias now that the new BridgeReceiver is official
    await dm.putAlias('bridgeReceiver', newBridgeReceiver);

    // Now, test that the new BridgeReceiver is working properly via another cross-chain proposal
    const currentTimelockDelay = await localTimelock.delay();
    const newTimelockDelay = currentTimelockDelay.mul(2);

    const setDelayCalldata = utils.defaultAbiCoder.encode(['uint'], [newTimelockDelay]);
    const pauseCalldata = await calldata(comet.populateTransaction.pause(true, true, true, true, true));
    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [localTimelock.address, comet.address],
        [0, 0],
        ['setDelay(uint256)', 'pause(bool,bool,bool,bool,bool)'],
        [setDelayCalldata, pauseCalldata]
      ]
    );

    expect(await localTimelock.delay()).to.eq(currentTimelockDelay);
    expect(currentTimelockDelay).to.not.eq(newTimelockDelay);

    await createCrossChainProposal(context, l2ProposalData, newBridgeReceiver);

    expect(await localTimelock.delay()).to.eq(newTimelockDelay);
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
  async ({ comet, timelock: localTimelock, bridgeReceiver: oldBridgeReceiver }, context, world) => {
    const dm = world.deploymentManager;
    const governanceDeploymentManager = world.auxiliaryDeploymentManager;
    if (!governanceDeploymentManager) {
      throw new Error('cannot execute governance without governance deployment manager');
    }

    const l2MessageService = await dm.getContractOrThrow('l2MessageService');

    // Deploy new LineaBridgeReceiver, bound to the current local Timelock
    const mainnetTimelock = (await governanceDeploymentManager.getContractOrThrow('timelock')).address;
    const newBridgeReceiver = await dm.deploy<LineaBridgeReceiver, [string, string, string]>(
      'newBridgeReceiver',
      'bridges/linea/LineaBridgeReceiver.sol',
      [
        l2MessageService.address, // messageService
        mainnetTimelock,          // govTimelock
        localTimelock.address     // localTimelock
      ]
    );

    // Process for handing the local Timelock over to the new BridgeReceiver (order matters, the old
    // BridgeReceiver stays the admin until the last call):
    // 1. Make the new BridgeReceiver the pending admin of the local Timelock
    // 2. Accept the admin role from the new BridgeReceiver
    const setPendingAdminCalldata = utils.defaultAbiCoder.encode(
      ['address'],
      [newBridgeReceiver.address]
    );
    const handOverLocalTimelockProposal = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [localTimelock.address, newBridgeReceiver.address],
        [0, 0],
        ['setPendingAdmin(address)', 'acceptLocalTimelockAdmin()'],
        [setPendingAdminCalldata, '0x']
      ]
    );

    expect(await localTimelock.admin()).to.eq(oldBridgeReceiver.address);

    await createCrossChainProposal(context, handOverLocalTimelockProposal, oldBridgeReceiver);

    expect(await localTimelock.admin()).to.eq(newBridgeReceiver.address);

    // Update alias now that the new BridgeReceiver is official
    await dm.putAlias('bridgeReceiver', newBridgeReceiver);

    // Now, test that the new BridgeReceiver is working properly via another cross-chain proposal
    const currentTimelockDelay = await localTimelock.delay();
    const newTimelockDelay = currentTimelockDelay.mul(2);

    const setDelayCalldata = utils.defaultAbiCoder.encode(['uint'], [newTimelockDelay]);
    const pauseCalldata = await calldata(comet.populateTransaction.pause(true, true, true, true, true));
    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [localTimelock.address, comet.address],
        [0, 0],
        ['setDelay(uint256)', 'pause(bool,bool,bool,bool,bool)'],
        [setDelayCalldata, pauseCalldata]
      ]
    );

    expect(await localTimelock.delay()).to.eq(currentTimelockDelay);
    expect(currentTimelockDelay).to.not.eq(newTimelockDelay);

    await createCrossChainProposal(context, l2ProposalData, newBridgeReceiver);

    expect(await localTimelock.delay()).to.eq(newTimelockDelay);
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
  async ({ comet, timelock: localTimelock, bridgeReceiver: oldBridgeReceiver }, context, world) => {
    const dm = world.deploymentManager;
    const governanceDeploymentManager = world.auxiliaryDeploymentManager;
    if (!governanceDeploymentManager) {
      throw new Error('cannot execute governance without governance deployment manager');
    }

    const l2Messenger = await dm.getContractOrThrow('l2Messenger');

    // Deploy new ScrollBridgeReceiver, bound to the current local Timelock
    const mainnetTimelock = (await governanceDeploymentManager.getContractOrThrow('timelock')).address;
    const newBridgeReceiver = await dm.deploy<ScrollBridgeReceiver, [string, string, string]>(
      'newBridgeReceiver',
      'bridges/scroll/ScrollBridgeReceiver.sol',
      [
        l2Messenger.address,   // l2Messenger
        mainnetTimelock,       // govTimelock
        localTimelock.address  // localTimelock
      ]
    );

    // Process for handing the local Timelock over to the new BridgeReceiver (order matters, the old
    // BridgeReceiver stays the admin until the last call):
    // 1. Make the new BridgeReceiver the pending admin of the local Timelock
    // 2. Accept the admin role from the new BridgeReceiver
    const setPendingAdminCalldata = utils.defaultAbiCoder.encode(
      ['address'],
      [newBridgeReceiver.address]
    );
    const handOverLocalTimelockProposal = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [localTimelock.address, newBridgeReceiver.address],
        [0, 0],
        ['setPendingAdmin(address)', 'acceptLocalTimelockAdmin()'],
        [setPendingAdminCalldata, '0x']
      ]
    );

    expect(await localTimelock.admin()).to.eq(oldBridgeReceiver.address);

    await createCrossChainProposal(context, handOverLocalTimelockProposal, oldBridgeReceiver);

    expect(await localTimelock.admin()).to.eq(newBridgeReceiver.address);

    // Update alias now that the new BridgeReceiver is official
    await dm.putAlias('bridgeReceiver', newBridgeReceiver);

    // Now, test that the new BridgeReceiver is working properly via another cross-chain proposal
    const currentTimelockDelay = await localTimelock.delay();
    const newTimelockDelay = currentTimelockDelay.mul(2);

    const setDelayCalldata = utils.defaultAbiCoder.encode(['uint'], [newTimelockDelay]);
    const pauseCalldata = await calldata(comet.populateTransaction.pause(true, true, true, true, true));
    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [localTimelock.address, comet.address],
        [0, 0],
        ['setDelay(uint256)', 'pause(bool,bool,bool,bool,bool)'],
        [setDelayCalldata, pauseCalldata]
      ]
    );

    expect(await localTimelock.delay()).to.eq(currentTimelockDelay);
    expect(currentTimelockDelay).to.not.eq(newTimelockDelay);

    await createCrossChainProposal(context, l2ProposalData, newBridgeReceiver);

    expect(await localTimelock.delay()).to.eq(newTimelockDelay);
    expect(await comet.isAbsorbPaused()).to.eq(true);
    expect(await comet.isBuyPaused()).to.eq(true);
    expect(await comet.isSupplyPaused()).to.eq(true);
    expect(await comet.isTransferPaused()).to.eq(true);
    expect(await comet.isWithdrawPaused()).to.eq(true);
  }
);
