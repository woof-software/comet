import { Constraint, World } from '../../plugins/scenario';
import { CometContext } from '../context/CometContext';
import { expect } from 'chai';
import { Requirements } from './Requirements';
import { CompoundGovernor__factory } from '../../build/types';
import { mineBlocks } from '../utils/hreUtils';
import { createProposal, succeedProposal, queueProposalById } from '../utils/governanceHelpers';

// OZ Governor ProposalState enum values for the states this constraint can drive to
const PROPOSAL_STATE = { pending: 0, active: 1, succeeded: 4, queued: 5 } as const;

export type GovProposalState = keyof typeof PROPOSAL_STATE;

/**
 * Establishes the precondition "a governance proposal exists in state X" before
 * the scenario body runs. Declared via the `proposal` requirement key; the
 * created proposal is handed off to the body on `context.proposal` (constraints
 * cannot return values to the body — same pattern as `context.migrations`).
 *
 * The proposal itself must never be the tx-under-test: bodies still perform and
 * return their own governance action so the scenario reports real gas.
 */
export class GovProposalConstraint<T extends CometContext, R extends Requirements> implements Constraint<T, R> {
  async solve(requirements: R, _context: T) {
    const proposalRequirements = requirements.proposal;
    if (!proposalRequirements) {
      return null;
    }

    const opts = proposalRequirements === true ? {} : proposalRequirements;
    const state: GovProposalState = opts.state ?? 'pending';

    return async (ctx: T) => {
      const dm = ctx.world.deploymentManager;
      const governor = CompoundGovernor__factory.connect((await ctx.getGovernor()).address, dm.hre.ethers.provider);
      const proposer = await ctx.getProposer(opts.proposer ?? 0);
      const actions = opts.actions ? await opts.actions(ctx) : undefined;

      const proposal = await createProposal(ctx, { proposer, actions });

      if (state === 'active') {
        const votingDelay = (await governor.votingDelay()).toNumber();
        await mineBlocks(dm, votingDelay + 1);
      } else if (state === 'succeeded') {
        await succeedProposal(ctx, governor, proposal);
      } else if (state === 'queued') {
        await succeedProposal(ctx, governor, proposal);
        await queueProposalById(ctx, governor, proposal.proposalId);
      }

      ctx.proposal = proposal;
      return ctx;
    };
  }

  async check(requirements: R, context: T, _world: World) {
    const proposalRequirements = requirements.proposal;
    if (!proposalRequirements) {
      return;
    }

    const opts = proposalRequirements === true ? {} : proposalRequirements;
    const state: GovProposalState = opts.state ?? 'pending';

    const proposal = context.proposal;
    expect(proposal, 'GovProposalConstraint must store the created proposal on context').to.not.be.undefined;

    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    expect(await governor.state(proposal!.proposalId)).to.equal(PROPOSAL_STATE[state]);
  }
}
