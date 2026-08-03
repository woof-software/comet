import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';

export default migration('1785357113_zero_first_collateral_supply_cap', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      comet,
      cometAdmin,
      configurator,
    } = await deploymentManager.getContracts();

    const firstAssetInfo = await comet.getAssetInfo(0);

    const mainnetActions = [
      // 1. Set the first collateral asset's supply cap to 0
      {
        contract: configurator,
        signature: 'updateAssetSupplyCap(address,address,uint128)',
        args: [comet.address, firstAssetInfo.asset, 0],
      },
      // 2. Deploy and upgrade the USDC Comet implementation to apply the update
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, comet.address],
      },
    ];

    const description = 'TEST MIGRATION';

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

  async enacted(): Promise<boolean> {
    return false;
  },

  async verify(deploymentManager: DeploymentManager) {
    const { comet } = await deploymentManager.getContracts();
    const firstAssetInfo = await comet.getAssetInfo(0);
    expect(firstAssetInfo.supplyCap).to.equal(0);
  },
});
