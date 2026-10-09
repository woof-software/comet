import type { StaticConstraint } from '../../plugins/scenario/index.js';
import type { IGovernorBravo, OpenProposal } from '../context/Gov.js';
import { IGovernorBravo__factory } from '../../build/types/index.js';
import { toNumber } from 'ethers';
import { getHardhatEthers } from '../../plugins/deployment_manager/hardhat3/runtime.js';
import { debug } from '../../plugins/scenario/index.js';
import { ProposalState } from '../context/Gov.js';
import type { CometContext } from '../context/CometContext.js';
import { fetchLogs } from '../utils/index.js';
import type { DeploymentManager } from '../../plugins/deployment_manager/index.js';
import { isBridgedDeployment, voteForOpenProposal, executeOpenProposalAndRelay } from '../utils/index.js';
import { getOpenBridgedProposals, executeBridgedProposal } from '../utils/bridgeProposal.js';

export async function getOpenProposals(deploymentManager: DeploymentManager, governor: IGovernorBravo): Promise<OpenProposal[]> {
  const timelockBuf = 30000; // XXX this should be timelock.delay + timelock.GRACE_PERIOD
  const votingDelay = toNumber(await governor.votingDelay());
  const votingPeriod = toNumber(await governor.votingPeriod());
  const searchBlocks = votingDelay + votingPeriod + timelockBuf;
  const { provider } = await getHardhatEthers(deploymentManager.hre);
  const block = await provider.getBlockNumber();
  const filter = governor.filters.ProposalCreated();
  const logs = await fetchLogs(governor, filter, Math.max(0, block - searchBlocks), block);
  const proposals: OpenProposal[] = [];
  if (logs) {
    for (let log of logs) {
      if (!('args' in log)) continue;
      const [id, proposer, targets, values, signatures, calldatas, startBlock, endBlock] = log.args;
      const state = toNumber(await governor.state(id));
      if ([
        ProposalState.Pending,
        ProposalState.Active,
        ProposalState.Succeeded,
        ProposalState.Queued,
      ].includes(state)) {
        proposals.push(
          {
            id,
            proposer,
            targets,
            values,
            signatures,
            calldatas,
            startBlock,
            endBlock
          }
        );
      }
    }
  }
  return proposals;
}

export class ProposalConstraint<T extends CometContext> implements StaticConstraint<T> {
  async solve() {
    return async function (ctx: T): Promise<T> {
      const govDeploymentManager = ctx.world.auxiliaryDeploymentManager || ctx.world.deploymentManager;
      const isBridged = isBridgedDeployment(ctx);
      const label = isBridged ?
        `[${ctx.world.base.auxiliaryBase} -> ${ctx.world.base.name}] {ProposalConstraint}`
        : `[${ctx.world.base.name}] {ProposalConstraint}`;

      const deploymentManager = ctx.world.deploymentManager;
      if (isBridged) {
        for (const proposal of await getOpenBridgedProposals(deploymentManager)) {
          debug(`${label} Processing pending bridged proposal ${proposal.id}`);
          await executeBridgedProposal(deploymentManager, proposal);
        }
      }

      const governanceDeploymentManager = ctx.world.auxiliaryDeploymentManager || deploymentManager;
      const governorContract = await governanceDeploymentManager.getContractOrThrow('governor');
      const governor = IGovernorBravo__factory.connect(await governorContract.getAddress(), governorContract.runner);
      const proposals = await getOpenProposals(governanceDeploymentManager, governor);

      for (const proposal of proposals) {
        await voteForOpenProposal(governanceDeploymentManager, proposal);
      }

      for (const proposal of proposals) {
        const { provider } = await getHardhatEthers(ctx.world.deploymentManager.hre);
        const preExecutionBlockNumber = await provider.getBlockNumber();
        let migrationData;
        if (ctx.migrations !== undefined) {
          migrationData = ctx.migrations.find(
            migrationData => migrationData.lastProposal === toNumber(proposal.id)
          );
        }

        // temporary hack to skip proposal 580
        if (proposal.id === 580n) {
          console.log('Skipping proposal 580');
          continue;
        }

        try {
          // Execute the proposal
          debug(`${label} Processing pending proposal ${proposal.id}`);
          await executeOpenProposalAndRelay(
            governanceDeploymentManager,
            ctx.world.deploymentManager,
            proposal
          );
          debug(`${label} Open proposal ${proposal.id} was executed`);
        } catch (err) {
          debug(`${label} Failed to execute proposal ${proposal.id}`, err.message);
          throw err;
        }

        try {
          // If there is a migration associated with this proposal, verify the migration
          if (migrationData) {
            await migrationData.migration.actions.verify(
              ctx.world.deploymentManager,
              govDeploymentManager,
              preExecutionBlockNumber
            );
            migrationData.verified = true;
            debug(`${label} Verified migration "${migrationData.migration.name}"`);
          }
        } catch (err) {
          debug(`${label} Failed to verify migration "${migrationData.migration.name}"`, err.message);
          throw err;
        }
      }

      // Verify all unverified migrations (e.g. ones that are not tied to proposals)
      if (ctx.migrations) {
        for (const migrationData of ctx.migrations) {
          if (migrationData.verified === true || migrationData.skipVerify === true) continue;
          await migrationData.migration.actions.verify(
            ctx.world.deploymentManager,
            govDeploymentManager,
            migrationData.preMigrationBlockNumber
          );
          migrationData.verified = true;
        }
      }

      // Re-set the assets in case they were updated via a proposal
      await ctx.setAssets();

      return ctx;
    };
  }

  async check() {
    return; // XXX
  }
}
