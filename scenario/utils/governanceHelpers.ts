import { utils } from 'ethers';
import type { CometContext } from '../context/CometContext';
import { CompoundGovernor__factory, CompoundGovernor } from '../../build/types';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { getLatestBlockTimestamp, mineBlocks, setNextBlockTimestamp } from './hreUtils';

/**
 * Result of creating a proposal — everything downstream scenarios need to
 * continue the lifecycle (vote / queue / execute / cancel) without re-deriving it.
 */
export interface CreatedProposal {
  proposalId: bigint;
  targets: string[];
  values: number[];
  calldatas: string[];
  description: string;
  descriptionHash: string;
  proposer: Awaited<ReturnType<CometContext['getProposer']>>;
  blockNumber: number; // block in which propose() was mined
}

/**
 * Build a representative, harmless proposal: bump the supply cap of asset 0 by 1
 * via Configurator.updateAssetSupplyCap. Used as the default action when a
 * scenario only needs "some valid proposal" to exist.
 */
export async function buildSupplyCapProposalActions(
  context: CometContext,
  descriptionTag = 'proposal'
): Promise<{ targets: string[], values: number[], calldatas: string[], description: string }> {
  const comet = await context.getComet();
  const configurator = await context.getConfigurator();

  const { asset: assetAddress } = await comet.getAssetInfo(0);
  const currentCap = (await comet.getAssetInfo(0)).supplyCap.toBigInt();
  const newSupplyCap = currentCap + 1n;

  const updateCapCalldata = utils.defaultAbiCoder.encode(
    ['address', 'address', 'uint128'],
    [comet.address, assetAddress, newSupplyCap]
  );

  const targets = [configurator.address];
  const values = [0];
  const calldatas = [
    utils.id('updateAssetSupplyCap(address,address,uint128)').slice(0, 10) + updateCapCalldata.slice(2)
  ];
  const description = `${descriptionTag}: update supply cap of asset 0 (${Date.now()})`;

  return { targets, values, calldatas, description };
}

/**
 * Pre-requirement helper: create a proposal and return everything needed to drive
 * it further. Pure setup — performs NO assertions and NO logging, so it can be
 * reused in any scenario whose pre-requirement is "a proposal has been created".
 *
 * @param context  scenario context
 * @param opts.proposer        signer to propose from; defaults to context.getProposer()
 *                             (an account with votes >= proposalThreshold)
 * @param opts.actions         proposal actions; defaults to a supply-cap bump on asset 0
 * @param opts.skipThresholdCheck  if true, does not require proposer to be above threshold
 *                                 (e.g. when proposing from a whitelisted low-vote account)
 */
export async function createProposal(
  context: CometContext,
  opts: {
    proposer?: Awaited<ReturnType<CometContext['getProposer']>>;
    actions?: { targets: string[], values: number[], calldatas: string[], description: string };
    descriptionTag?: string;
  } = {}
): Promise<CreatedProposal> {
  const dm = context.world.deploymentManager;
  const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

  const proposer = opts.proposer ?? (await context.getProposer());

  const actions = opts.actions ?? (await buildSupplyCapProposalActions(context, opts.descriptionTag));
  const { targets, values, calldatas, description } = actions;
  const descriptionHash = utils.keccak256(utils.toUtf8Bytes(description));

  // ── Create the proposal ──────────────────────────────────────────────────────
  // CompoundGovernor (OZ-based) signature: propose(targets, values, calldatas, description)
  await context.setNextBaseFeeToZero();
  const txn = await governor
    .connect(proposer)
    .propose(targets, values, calldatas, description, { gasPrice: 0 })
    .then((tx) => tx.wait());

  // ── Resolve the new proposalId from storage (deterministic) ───────────────────
  const proposalId = (await governor.latestProposalIds(proposer.address)).toBigInt();

  return {
    proposalId,
    targets,
    values,
    calldatas,
    description,
    descriptionHash,
    proposer,
    blockNumber: txn.blockNumber
  };
}

//──────────────────────────────────────────────────────────────────────────────
// Lifecycle helpers
//──────────────────────────────────────────────────────────────────────────────

export async function reachQuorum(
  context: CometContext,
  governor: CompoundGovernor,
  proposal: CreatedProposal
) {
  const quorumTarget = (await governor.quorum(proposal.blockNumber!)).toBigInt();
  const whales = await context.getCompWhales();
  let lastTxn = null;

  for (const whaleAddr of whales) {
    const votes = (await governor.proposalVotes(proposal.proposalId)).forVotes.toBigInt();
    if (votes >= quorumTarget) break;
    try {
      const whale = await context.world.impersonateAddress(whaleAddr, { value: 10n ** 18n, onGovNetwork: true });
      await context.setNextBaseFeeToZero();
      lastTxn = await governor.connect(whale).castVote(proposal.proposalId, 1, { gasPrice: 0 }).then((tx) => tx.wait());
    } catch (_) { /* already voted or other non-critical error */ }
  }
  return lastTxn;
}

export async function advancePastDeadline(
  dm: DeploymentManager,
  governor: CompoundGovernor,
  proposalId: bigint
): Promise<void> {
  const deadline = (await governor.proposalDeadline(proposalId)).toNumber();
  const now = await dm.hre.ethers.provider.getBlockNumber();
  if (now <= deadline) {
    await mineBlocks(dm, deadline - now + 1);
  }
}

export async function succeedProposal(
  context: CometContext,
  governor: CompoundGovernor,
  proposal: CreatedProposal
) {
  const dm = context.world.deploymentManager;
  const votingDelay = (await governor.votingDelay()).toNumber();
  await mineBlocks(dm, votingDelay + 1);
  const txn = await reachQuorum(context, governor, proposal);
  await advancePastDeadline(dm, governor, proposal.proposalId);
  return txn;
}

export async function queueProposalById(
  context: CometContext,
  governor: CompoundGovernor,
  proposalId: bigint
) {
  const proposer = await context.getProposer();
  await context.setNextBaseFeeToZero();
  return governor.connect(proposer)['queue(uint256)'](proposalId, { gasPrice: 0 }).then((tx) => tx.wait());
}

export async function executeProposalById(
  context: CometContext,
  governor: CompoundGovernor,
  proposalId: bigint
) {
  const dm = context.world.deploymentManager;
  const eta = (await governor.proposalEta(proposalId)).toNumber();
  const timestamp = await getLatestBlockTimestamp(dm);
  if (timestamp <= eta) {
    await setNextBlockTimestamp(dm, eta + 1);
  }
  const proposer = await context.getProposer();
  await context.setNextBaseFeeToZero();
  return governor.connect(proposer)['execute(uint256)'](proposalId, { gasPrice: 0, gasLimit: 30_000_000 }).then((tx) => tx.wait());
}
