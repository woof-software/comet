import { scenario } from './context/CometContext';
import { expect } from 'chai';
import { BigNumberish, utils } from 'ethers';
import { Timelock__factory } from '../build/types';
import { setNextBlockTimestamp } from './utils/hreUtils';
import { expectRevertCustom, queueBridgedProposal, supportsProposalOrdering } from './utils';

type Transaction = { target: string, signature: string, calldata: string };

function encodeProposal(txs: Transaction[]): string {
  return utils.defaultAbiCoder.encode(
    ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
    [txs.map((tx) => tx.target), txs.map(() => 0), txs.map((tx) => tx.signature), txs.map((tx) => tx.calldata)]
  );
}

// The message of the proposal at the zero-based `index` of a batch of `size` proposals
function encodeBatchedProposal(txs: Transaction[], batchId: string, index: number, size: number): string {
  return utils.defaultAbiCoder.encode(
    ['address[]', 'uint256[]', 'string[]', 'bytes[]', 'bytes32', 'uint256', 'uint256'],
    [txs.map((tx) => tx.target), txs.map(() => 0), txs.map((tx) => tx.signature), txs.map((tx) => tx.calldata), batchId, index, size]
  );
}

scenario(
  'BridgeReceiver#executeProposal > a batch delivered out of order executes in the order set on L1',
  {
    filter: async ctx => supportsProposalOrdering(ctx)
  },
  async ({ comet, configurator, proxyAdmin, bridgeReceiver, actors }, context) => {
    const dm = context.world.deploymentManager;
    const localTimelock = await bridgeReceiver.localTimelock();
    const { albert } = actors;

    // As on an L2, the local timelock governs the Comet: the Configurator and the proxy admin take its calls
    const governor = await context.world.impersonateAddress(await comet.governor(), { value: 10n ** 18n });
    await configurator.connect(governor).transferGovernor(localTimelock);
    await proxyAdmin.connect(governor).transferOwnership(localTimelock);

    // Position 0 sets a new base borrow minimum, position 1 deploys it: run the other way round, the upgrade would
    // deploy the old value
    const baseBorrowMin = await comet.baseBorrowMin();
    const newBaseBorrowMin = baseBorrowMin.add(1);
    const batchId = utils.id('BridgeReceiverOrderingScenario: set base borrow min, then upgrade');
    const setBaseBorrowMin = {
      target: configurator.address,
      signature: 'setBaseBorrowMin(address,uint104)',
      calldata: utils.defaultAbiCoder.encode(['address', 'uint104'], [comet.address, newBaseBorrowMin]),
    };
    const upgrade = {
      target: proxyAdmin.address,
      signature: 'deployAndUpgradeTo(address,address)',
      calldata: utils.defaultAbiCoder.encode(['address', 'address'], [configurator.address, comet.address]),
    };

    // Position 1 arrives first, and waits for the rest of the batch. Any address may try to execute it: albert does,
    // since a reverted call leaves the nonce of the deployment manager signer out of sync
    const { id: upgradeId } = await queueBridgedProposal(context, bridgeReceiver, encodeBatchedProposal([upgrade], batchId, 1, 2));
    await expectRevertCustom(bridgeReceiver.connect(albert.signer).executeProposal(upgradeId), 'BatchIncomplete()');

    // Position 0 completes the batch, position 1 still waits for it
    const { id: setBaseBorrowMinId, eta } = await queueBridgedProposal(
      context,
      bridgeReceiver,
      encodeBatchedProposal([setBaseBorrowMin], batchId, 0, 2)
    );
    await expectRevertCustom(bridgeReceiver.connect(albert.signer).executeProposal(upgradeId), 'ProposalOutOfOrder()');

    // Position 0 was queued last, so both etas are reached at its eta
    await setNextBlockTimestamp(dm, eta.toNumber() + 1);
    await context.setNextBaseFeeToZero();
    await bridgeReceiver.executeProposal(setBaseBorrowMinId, { gasPrice: 0 });

    // Configured, not deployed yet
    expect(await comet.baseBorrowMin()).to.eq(baseBorrowMin);

    await context.setNextBaseFeeToZero();
    await bridgeReceiver.executeProposal(upgradeId, { gasPrice: 0 });

    expect(await comet.baseBorrowMin()).to.eq(newBaseBorrowMin);
  }
);

scenario(
  'BridgeReceiver#executeProposal > a proposal outside any batch executes while a batch is pending',
  {
    filter: async ctx => supportsProposalOrdering(ctx)
  },
  async ({ bridgeReceiver }, context) => {
    const dm = context.world.deploymentManager;
    const localTimelock = Timelock__factory.connect(await bridgeReceiver.localTimelock(), dm.hre.ethers.provider);
    const delay = await localTimelock.delay();
    const setDelay = (newDelay: BigNumberish) => ({
      target: localTimelock.address,
      signature: 'setDelay(uint256)',
      calldata: utils.defaultAbiCoder.encode(['uint256'], [newDelay]),
    });
    const batchId = utils.id('BridgeReceiverOrderingScenario: batch around a proposal outside any batch');

    // Position 1 of a batch of 2 arrives, then a proposal outside any batch, which executes right away
    const { id: lastId } = await queueBridgedProposal(context, bridgeReceiver, encodeBatchedProposal([setDelay(delay.mul(3))], batchId, 1, 2));
    const { id: outsideId, eta: outsideEta } = await queueBridgedProposal(context, bridgeReceiver, encodeProposal([setDelay(delay.mul(2))]));
    await setNextBlockTimestamp(dm, outsideEta.toNumber() + 1);
    await context.setNextBaseFeeToZero();
    await bridgeReceiver.executeProposal(outsideId, { gasPrice: 0 });

    expect(await localTimelock.delay()).to.eq(delay.mul(2));

    // Position 0 completes the batch, which then executes in order
    const { id: firstId, eta } = await queueBridgedProposal(context, bridgeReceiver, encodeBatchedProposal([setDelay(delay.mul(4))], batchId, 0, 2));
    await setNextBlockTimestamp(dm, eta.toNumber() + 1);
    await context.setNextBaseFeeToZero();
    await bridgeReceiver.executeProposal(firstId, { gasPrice: 0 });
    await context.setNextBaseFeeToZero();
    await bridgeReceiver.executeProposal(lastId, { gasPrice: 0 });

    expect(await localTimelock.delay()).to.eq(delay.mul(3));
  }
);
