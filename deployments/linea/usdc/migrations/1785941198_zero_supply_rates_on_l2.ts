import { expect } from 'chai';
import { utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

/*
Proposed Parameters
The following values apply identically to all six comets in this proposal.

Parameter                          Proposed
Annual Supply Rate Base            0%
Annual Supply Rate Slope Low       0%
Supply Kink                        90%
Annual Supply Rate Slope High      0%
*/

const supplyPerYearInterestRateBase = '0';
const supplyPerYearInterestRateSlopeLow = '0';
const supplyKink = exp(0.9, 18);
const supplyPerYearInterestRateSlopeHigh = '0';

export default migration('1785941198_zero_supply_rates_on_l2', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const { governor, lineaMessageService } = await govDeploymentManager.getContracts();

    const {
      bridgeReceiver,
      configurator,
      cometAdmin,
      comet,
    } = await deploymentManager.getContracts();

    const setSupplyPerYearInterestRateBaseCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [comet.address, supplyPerYearInterestRateBase]);
    const setSupplyPerYearInterestRateSlopeLowCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [comet.address, supplyPerYearInterestRateSlopeLow]);
    const setSupplyKinkCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [comet.address, supplyKink]);
    const setSupplyPerYearInterestRateSlopeHighCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [comet.address, supplyPerYearInterestRateSlopeHigh]);
    const deployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(['address', 'address'], [configurator.address, comet.address]);

    const proposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          configurator.address, configurator.address,
          configurator.address, configurator.address,
          cometAdmin.address,
        ],
        [
          0, 0, 0, 0, 0
        ],
        [
          'setSupplyPerYearInterestRateBase(address,uint64)',
          'setSupplyPerYearInterestRateSlopeLow(address,uint64)',
          'setSupplyKink(address,uint64)',
          'setSupplyPerYearInterestRateSlopeHigh(address,uint64)',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          setSupplyPerYearInterestRateBaseCalldata,
          setSupplyPerYearInterestRateSlopeLowCalldata,
          setSupplyKinkCalldata,
          setSupplyPerYearInterestRateSlopeHighCalldata,
          deployAndUpgradeToCalldata,
        ],
      ]
    );

    const mainnetActions = [
      {
        contract: lineaMessageService,
        signature: 'sendMessage(address,uint256,bytes)',
        args: [bridgeReceiver.address, 0, proposalData],
      },
    ];

    const description = `DESCRIPTION`;

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
    const { configurator, comet } = await deploymentManager.getContracts();

    const configuration = await configurator.getConfiguration(comet.address);
    expect(configuration.supplyKink).to.equal(supplyKink);
    expect(configuration.supplyPerYearInterestRateSlopeLow).to.equal(supplyPerYearInterestRateSlopeLow);
    expect(configuration.supplyPerYearInterestRateSlopeHigh).to.equal(supplyPerYearInterestRateSlopeHigh);
    expect(configuration.supplyPerYearInterestRateBase).to.equal(supplyPerYearInterestRateBase);

    expect(await comet.supplyPerSecondInterestRateBase()).to.equal(0);
    expect(await comet.supplyPerSecondInterestRateSlopeLow()).to.equal(0);
    expect(await comet.supplyKink()).to.equal(supplyKink);
    expect(await comet.supplyPerSecondInterestRateSlopeHigh()).to.equal(0);
  },
});
