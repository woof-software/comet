import { expect } from 'chai';
import { utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';
import { forkedHreForBase } from '../../../../plugins/scenario/utils/hreForBase';
import { applyL1ToL2Alias, estimateL2Transaction } from '../../../../scenario/utils/arbitrumUtils';

/*
Smoke test for the multichain proposal simulation added in PR #453.

NOT a real governance proposal — this exists only to exercise the simulation
plumbing end to end. It fans a single message out to three L2s, chosen because
they are exactly the three networks that PR #453 added `simulateL2ToL1TokenBridging`
for, and because they cover both bridge shapes:

  Base      OP-stack  -> sendMessage(address,bytes,uint32)
  Optimism  OP-stack  -> sendMessage(address,bytes,uint32)
  Arbitrum  retryable -> createRetryableTicket(...)

The payload on each chain is a single `deployAndUpgradeTo(configurator, comet)`.
That is a genuine bridged governance action that touches the full path
(L1 governor -> bridge -> L2 bridgeReceiver -> L2 timelock -> cometAdmin) while
changing no market configuration: it redeploys the Comet implementation from the
configuration already stored on chain, so it is idempotent by construction.

Run it against Hardhat forks:

  yarn hardhat migrate 1788290470_tenderly_multichain_smoke_test \
    --network mainnet --deployment usdc \
    --enact --simulate --no-enacted \
    --impersonate <COMP-whale-or-delegate>

Then against Tenderly, which is the case this migration exists for:

  yarn hardhat migrate 1788290470_tenderly_multichain_smoke_test \
    --network mainnet --deployment usdc \
    --enact --simulate --no-enacted --tenderly \
    --impersonate <COMP-whale-or-delegate>

Expect one shared simulation link for the L1 execution plus one per relayed
chain. `enacted()` returns false so the migration is never filtered out by
`loadMigrations` (plugins/deployment_manager/Migration.ts:35).
*/

const BRIDGE_GAS_LIMIT = 3_000_000;

export default migration('1788290470_tenderly_multichain_smoke_test', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      timelock,
      governor,
      baseL1CrossDomainMessenger,
      opL1CrossDomainMessenger,
      arbitrumInbox,
    } = await deploymentManager.getContracts();

    // --- Base -------------------------------------------------------------
    const baseHre = await forkedHreForBase({ name: 'base-weth', network: 'base', deployment: 'weth' });
    const baseDm = await deploymentManager.addBridgedDeploymentManager('base', 'weth', baseHre);
    const {
      bridgeReceiver: baseBridgeReceiver,
      configurator: baseConfigurator,
      cometAdmin: baseCometAdmin,
      comet: baseComet,
    } = await baseDm.getContracts();

    const baseProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [baseCometAdmin.address],
        [0],
        ['deployAndUpgradeTo(address,address)'],
        [utils.defaultAbiCoder.encode(['address', 'address'], [baseConfigurator.address, baseComet.address])],
      ]
    );

    // --- Optimism ---------------------------------------------------------
    const opHre = await forkedHreForBase({ name: 'optimism-weth', network: 'optimism', deployment: 'weth' });
    const opDm = await deploymentManager.addBridgedDeploymentManager('optimism', 'weth', opHre);
    const {
      bridgeReceiver: opBridgeReceiver,
      configurator: opConfigurator,
      cometAdmin: opCometAdmin,
      comet: opComet,
    } = await opDm.getContracts();

    const opProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [opCometAdmin.address],
        [0],
        ['deployAndUpgradeTo(address,address)'],
        [utils.defaultAbiCoder.encode(['address', 'address'], [opConfigurator.address, opComet.address])],
      ]
    );

    // --- Arbitrum ---------------------------------------------------------
    const arbitrumHre = await forkedHreForBase({ name: 'arbitrum-weth', network: 'arbitrum', deployment: 'weth' });
    const arbitrumDm = await deploymentManager.addBridgedDeploymentManager('arbitrum', 'weth', arbitrumHre);
    const {
      bridgeReceiver: arbitrumBridgeReceiver,
      configurator: arbitrumConfigurator,
      cometAdmin: arbitrumCometAdmin,
      comet: arbitrumComet,
      timelock: arbitrumTimelock,
    } = await arbitrumDm.getContracts();

    const arbitrumProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [arbitrumCometAdmin.address],
        [0],
        ['deployAndUpgradeTo(address,address)'],
        [utils.defaultAbiCoder.encode(['address', 'address'], [arbitrumConfigurator.address, arbitrumComet.address])],
      ]
    );

    const createRetryableTicketGasParams = await estimateL2Transaction(
      {
        from: applyL1ToL2Alias(timelock.address),
        to: arbitrumBridgeReceiver.address,
        data: arbitrumProposalData,
      },
      arbitrumDm
    );

    // --- L1 actions -------------------------------------------------------
    const mainnetActions = [
      // Base
      {
        contract: baseL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [baseBridgeReceiver.address, baseProposalData, BRIDGE_GAS_LIMIT],
      },
      // Optimism
      {
        contract: opL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [opBridgeReceiver.address, opProposalData, BRIDGE_GAS_LIMIT],
      },
      // Arbitrum
      {
        contract: arbitrumInbox,
        signature: 'createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)',
        args: [
          arbitrumBridgeReceiver.address,                   // address to
          0,                                                // uint256 l2CallValue
          createRetryableTicketGasParams.maxSubmissionCost, // uint256 maxSubmissionCost
          arbitrumTimelock.address,                         // address excessFeeRefundAddress
          arbitrumTimelock.address,                         // address callValueRefundAddress
          createRetryableTicketGasParams.gasLimit,          // uint256 gasLimit
          createRetryableTicketGasParams.maxFeePerGas * 2,  // uint256 maxFeePerGas
          arbitrumProposalData,                             // bytes calldata data
        ],
        value: createRetryableTicketGasParams.deposit.mul(2),
      },
    ];

    const description = `# [TEST ONLY] Multichain simulation smoke test

This is **not** a real governance proposal. It exists to exercise the multichain
proposal simulation added in PR #453 across Base, Optimism and Arbitrum.

Each chain receives a single \`deployAndUpgradeTo(configurator, comet)\`, which
redeploys the Comet implementation from the configuration already stored on
chain and therefore changes no market parameters.

Do not submit this on chain.`;

    const txn = await deploymentManager.retry(async () =>
      trace(
        await governor.propose(...(await proposal(mainnetActions, description)))
      ), 0, 600_000
    );

    const event = txn.events.find(
      (event: { event: string }) => event.event === 'ProposalCreated'
    );
    const [proposalId] = event.args;
    trace(`Created proposal ${proposalId}.`);
  },

  // Never treat this as enacted — otherwise loadMigrations filters it out and
  // `migrate` fails with "Unknown migration".
  async enacted(): Promise<boolean> {
    return false;
  },

  async verify(deploymentManager: DeploymentManager) {
    // Each bridged Comet should still be intact and governed by its own L2
    // timelock after the upgrade landed.
    for (const key of ['base:weth', 'optimism:weth', 'arbitrum:weth']) {
      const dm = deploymentManager.bridgedDeploymentManagers.get(key) as DeploymentManager;
      expect(dm, `missing bridged deployment manager for ${key}`).to.not.be.undefined;

      const { comet, timelock: l2Timelock } = await dm.getContracts();
      expect((await comet.governor()).toLowerCase()).to.equal(l2Timelock.address.toLowerCase());
      expect(await comet.numAssets()).to.be.greaterThan(0);
    }
  },
});
