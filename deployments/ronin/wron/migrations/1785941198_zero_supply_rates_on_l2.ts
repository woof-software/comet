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

const destinationChainSelectorRonin = '6916147374840168594';
const GHO_STABLE_TOKEN = '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f';

export default migration('1785941198_zero_supply_rates_on_l2', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const { governor, l1CCIPRouter } = await govDeploymentManager.getContracts();

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

    const fee = await l1CCIPRouter.getFee(destinationChainSelectorRonin, [
      utils.defaultAbiCoder.encode(['address'], [bridgeReceiver.address]),
      proposalData,
      [],
      GHO_STABLE_TOKEN,
      '0x',
    ]);

    const mainnetActions = [
      // 1. Approve GHO to pay the CCIP fee for the Ronin proposal
      {
        target: GHO_STABLE_TOKEN,
        signature: 'approve(address,uint256)',
        calldata: utils.defaultAbiCoder.encode(['address', 'uint256'], [l1CCIPRouter.address, fee.mul(2)]),
      },
      // 2. Zero out supply rates and upgrade the WRON Comet on Ronin.
      {
        contract: l1CCIPRouter,
        signature: 'ccipSend(uint64,(bytes,bytes,(address,uint256)[],address,bytes))',
        args: [
          destinationChainSelectorRonin,
          [
            utils.defaultAbiCoder.encode(['address'], [bridgeReceiver.address]),
            proposalData,
            [],
            GHO_STABLE_TOKEN,
            '0x',
          ],
        ],
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
