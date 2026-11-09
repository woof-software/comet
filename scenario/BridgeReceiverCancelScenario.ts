import { CometContext, scenario } from './context/CometContext';
import { BridgedProposalState } from './context/Gov';
import { expect } from 'chai';
import { utils } from 'ethers';
import { BaseBridgeReceiver, Timelock__factory } from '../build/types';
import { calldata } from '../src/deploy';
import { impersonateAddress } from '../plugins/scenario/utils';
import { setEtherBalance, setNextBaseFeeToZero, setNextBlockTimestamp } from './utils/hreUtils';
import { applyL1ToL2Alias, expectRevertCustom, supportsProposalCancellation } from './utils';

// Delivers an L2 proposal to the BridgeReceiver the way the bridge does on L2 and leaves it queued. The relay helpers
// behind createCrossChainProposal execute every bridged proposal they deliver, which leaves the guardian no window.
async function queueBridgedProposal(context: CometContext, bridgeReceiver: BaseBridgeReceiver, l2ProposalData: string) {
  const dm = context.world.deploymentManager;
  const govTimelock = await bridgeReceiver.govTimelock();

  if (dm.network === 'polygon') {
    // The Polygon state receiver hands the synced message to fxChild, which calls processMessageFromRoot
    const fxChild = await dm.getContractOrThrow('fxChild');
    const stateReceiver = await impersonateAddress(dm, '0x0000000000000000000000000000000000001001');
    await setNextBaseFeeToZero(dm);
    await fxChild.connect(stateReceiver).onStateReceive(
      0,
      utils.defaultAbiCoder.encode(['address', 'address', 'bytes'], [govTimelock, bridgeReceiver.address, l2ProposalData]),
      { gasPrice: 0 }
    );
  } else if (dm.network === 'arbitrum' || dm.network === 'hardhat') {
    // Arbitrum executes the retryable ticket as a call from the aliased governing Timelock. The local development
    // deployment uses ArbitrumBridgeReceiver for the same reason: its only bridge dependency is that alias.
    const aliasedGovTimelock = await impersonateAddress(dm, applyL1ToL2Alias(govTimelock));
    await setNextBaseFeeToZero(dm);
    await aliasedGovTimelock.sendTransaction({ to: bridgeReceiver.address, data: l2ProposalData, gasPrice: 0 });
  } else {
    throw new Error(`No L2 delivery of bridged proposals implemented for ${dm.network}`);
  }

  const id = await bridgeReceiver.proposalCount();
  const { eta } = await bridgeReceiver.proposals(id);
  return { id, eta };
}

scenario(
  'BridgeReceiver#cancelProposal > guardian cancels a queued cross-chain proposal',
  {
    filter: async ctx => supportsProposalCancellation(ctx)
  },
  async ({ comet, bridgeReceiver }, context) => {
    const dm = context.world.deploymentManager;
    const localTimelock = Timelock__factory.connect(await bridgeReceiver.localTimelock(), dm.hre.ethers.provider);
    const guardianAddress = await bridgeReceiver.guardian();
    await setEtherBalance(dm, guardianAddress, 10n ** 18n);
    const guardian = await impersonateAddress(dm, guardianAddress);

    // Proposal pausing every Comet action
    const signature = 'pause(bool,bool,bool,bool,bool)';
    const pauseCalldata = await calldata(comet.populateTransaction.pause(true, true, true, true, true));
    const { id, eta } = await queueBridgedProposal(context, bridgeReceiver, utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [[comet.address], [0], [signature], [pauseCalldata]]
    ));
    const txHash = utils.keccak256(utils.defaultAbiCoder.encode(
      ['address', 'uint256', 'string', 'bytes', 'uint256'],
      [comet.address, 0, signature, pauseCalldata, eta]
    ));

    expect(await localTimelock.queuedTransactions(txHash)).to.be.true;

    await bridgeReceiver.connect(guardian).cancelProposal(id);

    expect(await bridgeReceiver.state(id)).to.eq(BridgedProposalState.Canceled);
    expect(await localTimelock.queuedTransactions(txHash)).to.be.false;
    // ProposalNotExecutable, not the Timelock's eta check: the cancellation blocks the execution
    await expectRevertCustom(bridgeReceiver.executeProposal(id), 'ProposalNotExecutable()');
  }
);

scenario(
  'BridgeReceiver#cancelProposal > guardian cannot cancel a cross-chain proposal that replaces the guardian',
  {
    filter: async ctx => supportsProposalCancellation(ctx)
  },
  async ({ bridgeReceiver, actors }, context) => {
    const dm = context.world.deploymentManager;
    const { albert: newGuardian } = actors;
    const guardianAddress = await bridgeReceiver.guardian();
    await setEtherBalance(dm, guardianAddress, 10n ** 18n);
    const guardian = await impersonateAddress(dm, guardianAddress);

    const { id, eta } = await queueBridgedProposal(context, bridgeReceiver, utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [bridgeReceiver.address],
        [0],
        ['setGuardian(address)'],
        [utils.defaultAbiCoder.encode(['address'], [newGuardian.address])]
      ]
    ));

    await expectRevertCustom(bridgeReceiver.connect(guardian).cancelProposal(id), 'ProposalNotCancelable()');

    await setNextBlockTimestamp(dm, eta.toNumber() + 1);
    await context.setNextBaseFeeToZero();
    await bridgeReceiver.executeProposal(id, { gasPrice: 0 });

    expect(await bridgeReceiver.guardian()).to.eq(newGuardian.address);
  }
);
