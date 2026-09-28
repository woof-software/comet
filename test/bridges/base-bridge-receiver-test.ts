import { AbiCoder, ZeroAddress, keccak256 } from 'ethers';

import { ethers, event, expect, wait } from './../helpers.js';
import {
  BaseBridgeReceiverHarness__factory,
  Timelock__factory
} from '../../build/types/index.js';

const BRIDGE_RECEIVER_CALLDATA_ABI = ['address[]', 'uint256[]', 'string[]', 'bytes[]'];
const abiCoder = AbiCoder.defaultAbiCoder();

enum ProposalState {
  Queued = 0,
  Expired = 1,
  Executed = 2
}

export async function makeTimelock({ admin }: { admin: string }) {
  const [deployer] = await ethers.getSigners();
  const TimelockFactory = new Timelock__factory(deployer);
  const timelock = await TimelockFactory.deploy(
    admin,              // admin
    10 * 60,            // delay
    14 * 24 * 60 * 60,  // gracePeriod
    10 * 60,            // min delay
    30 * 24 * 60 * 60   // max delay
  );
  await timelock.waitForDeployment();
  return timelock;
}

async function makeBridgeReceiver({ initialize } = { initialize: true }) {
  const [_defaultSigner, govTimelockAdmin, ...signers] = await ethers.getSigners();

  const BaseBridgeReceiverFactory = new BaseBridgeReceiverHarness__factory(_defaultSigner);
  const baseBridgeReceiver = await BaseBridgeReceiverFactory.deploy();
  await baseBridgeReceiver.waitForDeployment();

  const govTimelock = await makeTimelock({ admin: govTimelockAdmin.address });
  const baseBridgeReceiverAddress = await baseBridgeReceiver.getAddress();
  const govTimelockAddress = await govTimelock.getAddress();
  const localTimelock = await makeTimelock({ admin: baseBridgeReceiverAddress });
  const localTimelockAddress = await localTimelock.getAddress();

  if (initialize) {
    await baseBridgeReceiver.initialize(
      govTimelockAddress,   // govTimelock
      localTimelockAddress  // localTimelock
    );
  }

  return {
    baseBridgeReceiver,
    govTimelock,
    localTimelock,
    signers
  };
}

export function encodeBridgeReceiverCalldata({ targets, values, signatures, calldatas }) {
  return abiCoder.encode(BRIDGE_RECEIVER_CALLDATA_ABI, [targets, values, signatures, calldatas]);
}

describe('BaseBridgeReceiver', function () {
  it('is initialized with empty storage values', async () => {
    const { baseBridgeReceiver } = await makeBridgeReceiver({initialize: false});

    expect(await baseBridgeReceiver.govTimelock()).to.eq(ZeroAddress);
    expect(await baseBridgeReceiver.localTimelock()).to.eq(ZeroAddress);
    expect(await baseBridgeReceiver.initialized()).to.eq(false);
  });

  it('initializing sets values', async () => {
    const {
      baseBridgeReceiver,
      govTimelock,
      localTimelock,
    } = await makeBridgeReceiver({ initialize: false });
    const govTimelockAddress = await govTimelock.getAddress();
    const localTimelockAddress = await localTimelock.getAddress();

    const tx = await wait(baseBridgeReceiver.initialize(govTimelockAddress, localTimelockAddress));

    expect(await baseBridgeReceiver.govTimelock()).to.eq(govTimelockAddress);
    expect(await baseBridgeReceiver.localTimelock()).to.eq(localTimelockAddress);
    expect(await baseBridgeReceiver.initialized()).to.eq(true);

    expect(event(tx, 0)).to.be.deep.equal({
      Initialized: {
        govTimelock: govTimelockAddress,
        localTimelock: localTimelockAddress
      }
    });
  });

  it('reverts on initialize if local timelock admin is not the bridge receiver', async () => {
    const {
      baseBridgeReceiver,
      govTimelock,
    } = await makeBridgeReceiver({initialize: false});
    const badLocalTimelock = await makeTimelock({ admin: ZeroAddress });
    const govTimelockAddress = await govTimelock.getAddress();
    const badLocalTimelockAddress = await badLocalTimelock.getAddress();

    await expect(
      baseBridgeReceiver.initialize(govTimelockAddress, badLocalTimelockAddress)
    ).to.be.revertedWithCustomError(baseBridgeReceiver, 'InvalidTimelockAdmin');
  });

  it('cannot be reinitialized', async () => {
    const {
      baseBridgeReceiver,
      govTimelock,
      localTimelock
    } = await makeBridgeReceiver({initialize: true});
    const govTimelockAddress = await govTimelock.getAddress();
    const localTimelockAddress = await localTimelock.getAddress();

    await expect(
      baseBridgeReceiver.initialize(govTimelockAddress, localTimelockAddress)
    ).to.be.revertedWithCustomError(baseBridgeReceiver, 'AlreadyInitialized');
  });

  it('processMessage > reverts if messageSender is not govTimelock', async () => {
    const {
      baseBridgeReceiver,
      signers
    } = await makeBridgeReceiver();

    const [unauthorizedSigner] = signers;
    const calldata = abiCoder.encode([], []);

    await expect(
      baseBridgeReceiver.processMessageExternal(
        unauthorizedSigner.address,
        calldata
      )
    ).to.be.revertedWithCustomError(baseBridgeReceiver, 'Unauthorized');
  });

  it('processMessage > reverts for bad data', async () => {
    const { baseBridgeReceiver, govTimelock, localTimelock } = await makeBridgeReceiver();
    const govTimelockAddress = await govTimelock.getAddress();
    const localTimelockAddress = await localTimelock.getAddress();

    const targets = Array(3).fill(localTimelockAddress);
    const values = Array(3).fill(0);
    const signatures = Array(3).fill('setDelay(uint256)');
    const calldatas = Array(3).fill(abiCoder.encode(['uint256'], [42]));
    const missingValue = abiCoder.encode(
      BRIDGE_RECEIVER_CALLDATA_ABI,
      [targets, values.slice(1), signatures, calldatas]
    );
    const missingSignature = abiCoder.encode(
      BRIDGE_RECEIVER_CALLDATA_ABI,
      [targets, values, signatures.slice(1), calldatas]
    );
    const missingCalldata = abiCoder.encode(
      BRIDGE_RECEIVER_CALLDATA_ABI,
      [targets, values, signatures, calldatas.slice(1)]
    );

    await expect(
      baseBridgeReceiver.processMessageExternal(govTimelockAddress, missingValue)
    ).to.be.revertedWithCustomError(baseBridgeReceiver, 'BadData');

    await expect(
      baseBridgeReceiver.processMessageExternal(govTimelockAddress, missingSignature)
    ).to.be.revertedWithCustomError(baseBridgeReceiver, 'BadData');

    await expect(
      baseBridgeReceiver.processMessageExternal(govTimelockAddress, missingCalldata)
    ).to.be.revertedWithCustomError(baseBridgeReceiver, 'BadData');
  });

  it('processMessage > reverts for repeated transactions', async () => {
    const { baseBridgeReceiver, govTimelock, localTimelock } = await makeBridgeReceiver();
    const govTimelockAddress = await govTimelock.getAddress();
    const localTimelockAddress = await localTimelock.getAddress();

    const calldata = encodeBridgeReceiverCalldata({
      targets: Array(2).fill(localTimelockAddress),
      values: Array(2).fill(0),
      signatures: Array(2).fill('setDelay(uint256)'),
      calldatas: [
        abiCoder.encode(['uint256'], [20 * 60]),
        abiCoder.encode(['uint256'], [20 * 60])
      ]
    });

    await expect(
      baseBridgeReceiver.processMessageExternal(govTimelockAddress, calldata)
    ).to.be.revertedWithCustomError(baseBridgeReceiver, 'TransactionAlreadyQueued');
  });

  it('processMessage > queues transactions and stores a proposal', async () => {
    const {
      baseBridgeReceiver,
      govTimelock,
      localTimelock
    } = await makeBridgeReceiver();
    const govTimelockAddress = await govTimelock.getAddress();
    const localTimelockAddress = await localTimelock.getAddress();

    expect(await baseBridgeReceiver.proposalCount()).to.eq(0);

    const targets = Array(2).fill(localTimelockAddress);
    const values = Array(2).fill(0n);
    const signatures = Array(2).fill('setDelay(uint256)');
    const calldatas = [
      abiCoder.encode(['uint256'], [42]),
      abiCoder.encode(['uint256'], [43])
    ];

    const calldata = encodeBridgeReceiverCalldata({ targets, values, signatures, calldatas });

    const tx = await wait(baseBridgeReceiver.processMessageExternal(govTimelockAddress, calldata));

    // increments proposal count
    expect(await baseBridgeReceiver.proposalCount()).to.eq(1);

    // creates a proposal
    const { id, eta, executed } = await baseBridgeReceiver.proposals(1);
    expect(id).to.eq(1);
    expect(eta).to.not.eq(0);
    expect(executed).to.be.false;

    // emits ProposalCreated event
    expect(event(tx, 2)).to.be.deep.equal({
      ProposalCreated: {
        rootMessageSender: govTimelockAddress,
        id,
        targets,
        values,
        signatures,
        calldatas,
        eta
      }
    });

    // queues 2 transactions
    expect(
      await localTimelock.queuedTransactions(
        keccak256(
          abiCoder.encode(
            ['address', 'uint256', 'string', 'bytes', 'uint256'],
            [targets[0], values[0], signatures[0], calldatas[0], eta]
          )
        )
      )
    ).to.be.true;

    expect(
      await localTimelock.queuedTransactions(
        keccak256(
          abiCoder.encode(
            ['address', 'uint256', 'string', 'bytes', 'uint256'],
            [targets[1], values[1], signatures[1], calldatas[1], eta]
          )
        )
      )
    ).to.be.true;
  });

  it('executeProposal > reverts if proposal is expired', async () => {
    const {
      baseBridgeReceiver,
      govTimelock,
      localTimelock
    } = await makeBridgeReceiver();
    const govTimelockAddress = await govTimelock.getAddress();
    const localTimelockAddress = await localTimelock.getAddress();

    expect(await baseBridgeReceiver.proposalCount()).to.eq(0);

    const calldata = encodeBridgeReceiverCalldata({
      targets: Array(2).fill(localTimelockAddress),
      values: Array(2).fill(0),
      signatures: Array(2).fill('setDelay(uint256)'),
      calldatas: [
        abiCoder.encode(['uint256'], [42]),
        abiCoder.encode(['uint256'], [43])
      ]
    });

    await baseBridgeReceiver.processMessageExternal(govTimelockAddress, calldata);

    // queues the proposal
    expect(await baseBridgeReceiver.state(1)).to.eq(ProposalState.Queued);

    const { eta } = await baseBridgeReceiver.proposals(1);
    const gracePeriod = await localTimelock.GRACE_PERIOD();

    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(eta + gracePeriod) + 1]);
    await ethers.provider.send('evm_mine', []);

    // proposal is expired
    expect(await baseBridgeReceiver.state(1)).to.eq(ProposalState.Expired);

    await expect(
      baseBridgeReceiver.executeProposal(1)
    ).to.be.revertedWithCustomError(baseBridgeReceiver, 'ProposalNotExecutable');
  });

  it('executeProposal > executes the proposal', async () => {
    const {
      baseBridgeReceiver,
      govTimelock,
      localTimelock
    } = await makeBridgeReceiver();
    const govTimelockAddress = await govTimelock.getAddress();
    const localTimelockAddress = await localTimelock.getAddress();

    expect(await baseBridgeReceiver.proposalCount()).to.eq(0);

    const delay = await localTimelock.delay();
    const newDelay = delay * 2n;

    const calldata = encodeBridgeReceiverCalldata({
      targets: Array(1).fill(localTimelockAddress),
      values: Array(1).fill(0),
      signatures: Array(1).fill('setDelay(uint256)'),
      calldatas: [
        abiCoder.encode(['uint256'], [newDelay])
      ]
    });

    await baseBridgeReceiver.processMessageExternal(govTimelockAddress, calldata);

    // queues the proposal
    expect(await baseBridgeReceiver.state(1)).to.eq(ProposalState.Queued);

    const { eta } = await baseBridgeReceiver.proposals(1);

    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(eta)]);

    const tx = await wait(baseBridgeReceiver.executeProposal(1));

    expect(await localTimelock.delay()).to.eq(newDelay);

    expect(event(tx, 2)).to.be.deep.equal({ ProposalExecuted: { id: 1n } });

    const updatedProposal = await baseBridgeReceiver.proposals(1);

    expect(updatedProposal.executed).to.be.true;
    expect(await baseBridgeReceiver.state(1)).to.eq(ProposalState.Executed);
  });

  it('executeProposal > reverts if proposal is already executed', async () => {
    const {
      baseBridgeReceiver,
      govTimelock,
      localTimelock
    } = await makeBridgeReceiver();
    const govTimelockAddress = await govTimelock.getAddress();
    const localTimelockAddress = await localTimelock.getAddress();

    expect(await baseBridgeReceiver.proposalCount()).to.eq(0);

    const calldata = encodeBridgeReceiverCalldata({
      targets: Array(1).fill(localTimelockAddress),
      values: Array(1).fill(0),
      signatures: Array(1).fill('setDelay(uint256)'),
      calldatas: [
        abiCoder.encode(['uint256'], [20 * 60])
      ]
    });

    await baseBridgeReceiver.processMessageExternal(govTimelockAddress, calldata);

    const { eta } = await baseBridgeReceiver.proposals(1);

    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(eta)]);

    await baseBridgeReceiver.executeProposal(1);

    await expect(
      baseBridgeReceiver.executeProposal(1)
    ).to.be.revertedWithCustomError(baseBridgeReceiver, 'ProposalNotExecutable');
  });

  it('state > reverts for proposal id = 0', async () => {
    const { baseBridgeReceiver } = await makeBridgeReceiver();

    await expect(
      baseBridgeReceiver.executeProposal(0)
    ).to.be.revertedWithCustomError(baseBridgeReceiver, 'InvalidProposalId');
  });

  it('state > reverts if proposal id is greater than proposalCount', async () => {
    const { baseBridgeReceiver } = await makeBridgeReceiver();

    const proposalCount = await baseBridgeReceiver.proposalCount();

    await expect(
      baseBridgeReceiver.executeProposal(proposalCount + 1n)
    ).to.be.revertedWithCustomError(baseBridgeReceiver, 'InvalidProposalId');
  });
});
