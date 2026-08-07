import { expect } from 'chai';
import { utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';
import { forkedHreForBase } from '../../../../plugins/scenario/utils/hreForBase';

/*
Proposed Parameters
The following values apply identically to all six comets.

Parameter                          Proposed
Annual Supply Rate Base            0%
Annual Supply Rate Slope Low       0%
Supply Kink                        90%
Annual Supply Rate Slope High      0%

Affected markets:

Chain     Comet
Linea     USDC
Linea     WETH
Mantle    USDe
Ronin     WETH
Ronin     WRON
Scroll    USDC
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

  async enact(deploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      lineaMessageService,
      mantleL1CrossDomainMessenger,
      scrollMessenger,
      l1CCIPRouter,
    } = await deploymentManager.getContracts();

    // Linea (USDC + WETH)
    const lineaHre = await forkedHreForBase({ name: 'linea-usdc', network: 'linea', deployment: 'usdc' });
    const lineaUsdcDm = await deploymentManager.addBridgedDeploymentManager('linea', 'usdc', lineaHre);
    const {
      bridgeReceiver: lineaBridgeReceiver,
      configurator: lineaConfigurator,
      cometAdmin: lineaCometAdmin,
      comet: lineaUsdcComet,
    } = await lineaUsdcDm.getContracts();

    const lineaWethDm = await deploymentManager.addBridgedDeploymentManager('linea', 'weth', lineaHre);
    const { comet: lineaWethComet } = await lineaWethDm.getContracts();

    const lineaUsdcSetSupplyPerYearInterestRateBaseCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [lineaUsdcComet.address, supplyPerYearInterestRateBase]);
    const lineaUsdcSetSupplyPerYearInterestRateSlopeLowCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [lineaUsdcComet.address, supplyPerYearInterestRateSlopeLow]);
    const lineaUsdcSetSupplyKinkCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [lineaUsdcComet.address, supplyKink]);
    const lineaUsdcSetSupplyPerYearInterestRateSlopeHighCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [lineaUsdcComet.address, supplyPerYearInterestRateSlopeHigh]);
    const lineaUsdcDeployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(['address', 'address'], [lineaConfigurator.address, lineaUsdcComet.address]);

    const lineaWethSetSupplyPerYearInterestRateBaseCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [lineaWethComet.address, supplyPerYearInterestRateBase]);
    const lineaWethSetSupplyPerYearInterestRateSlopeLowCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [lineaWethComet.address, supplyPerYearInterestRateSlopeLow]);
    const lineaWethSetSupplyKinkCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [lineaWethComet.address, supplyKink]);
    const lineaWethSetSupplyPerYearInterestRateSlopeHighCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [lineaWethComet.address, supplyPerYearInterestRateSlopeHigh]);
    const lineaWethDeployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(['address', 'address'], [lineaConfigurator.address, lineaWethComet.address]);

    const lineaProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          // USDC Comet
          lineaConfigurator.address, lineaConfigurator.address,
          lineaConfigurator.address, lineaConfigurator.address,
          lineaCometAdmin.address,
          // WETH Comet
          lineaConfigurator.address, lineaConfigurator.address,
          lineaConfigurator.address, lineaConfigurator.address,
          lineaCometAdmin.address,
        ],
        [
          0, 0, 0, 0,
          0,
          0, 0, 0, 0,
          0,
        ],
        [
          // USDC Comet
          'setSupplyPerYearInterestRateBase(address,uint64)',
          'setSupplyPerYearInterestRateSlopeLow(address,uint64)',
          'setSupplyKink(address,uint64)',
          'setSupplyPerYearInterestRateSlopeHigh(address,uint64)',
          'deployAndUpgradeTo(address,address)',
          // WETH Comet
          'setSupplyPerYearInterestRateBase(address,uint64)',
          'setSupplyPerYearInterestRateSlopeLow(address,uint64)',
          'setSupplyKink(address,uint64)',
          'setSupplyPerYearInterestRateSlopeHigh(address,uint64)',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          // USDC Comet
          lineaUsdcSetSupplyPerYearInterestRateBaseCalldata,
          lineaUsdcSetSupplyPerYearInterestRateSlopeLowCalldata,
          lineaUsdcSetSupplyKinkCalldata,
          lineaUsdcSetSupplyPerYearInterestRateSlopeHighCalldata,
          lineaUsdcDeployAndUpgradeToCalldata,
          // WETH Comet
          lineaWethSetSupplyPerYearInterestRateBaseCalldata,
          lineaWethSetSupplyPerYearInterestRateSlopeLowCalldata,
          lineaWethSetSupplyKinkCalldata,
          lineaWethSetSupplyPerYearInterestRateSlopeHighCalldata,
          lineaWethDeployAndUpgradeToCalldata,
        ],
      ]
    );

    // Mantle (USDe)
    const mantleHre = await forkedHreForBase({ name: 'mantle-usde', network: 'mantle', deployment: 'usde' });
    const mantleDm = await deploymentManager.addBridgedDeploymentManager('mantle', 'usde', mantleHre);
    const {
      bridgeReceiver: mantleBridgeReceiver,
      configurator: mantleConfigurator,
      cometAdmin: mantleCometAdmin,
      comet: mantleUsdeComet,
    } = await mantleDm.getContracts();

    const mantleUsdeSetSupplyPerYearInterestRateBaseCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [mantleUsdeComet.address, supplyPerYearInterestRateBase]);
    const mantleUsdeSetSupplyPerYearInterestRateSlopeLowCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [mantleUsdeComet.address, supplyPerYearInterestRateSlopeLow]);
    const mantleUsdeSetSupplyKinkCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [mantleUsdeComet.address, supplyKink]);
    const mantleUsdeSetSupplyPerYearInterestRateSlopeHighCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [mantleUsdeComet.address, supplyPerYearInterestRateSlopeHigh]);
    const mantleUsdeDeployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(['address', 'address'], [mantleConfigurator.address, mantleUsdeComet.address]);

    const mantleProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          mantleConfigurator.address, mantleConfigurator.address,
          mantleConfigurator.address, mantleConfigurator.address,
          mantleCometAdmin.address,
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
          mantleUsdeSetSupplyPerYearInterestRateBaseCalldata,
          mantleUsdeSetSupplyPerYearInterestRateSlopeLowCalldata,
          mantleUsdeSetSupplyKinkCalldata,
          mantleUsdeSetSupplyPerYearInterestRateSlopeHighCalldata,
          mantleUsdeDeployAndUpgradeToCalldata,
        ],
      ]
    );

    // Ronin (WETH + WRON)
    const roninHre = await forkedHreForBase({ name: 'ronin-weth', network: 'ronin', deployment: 'weth' });
    const roninWethDm = await deploymentManager.addBridgedDeploymentManager('ronin', 'weth', roninHre);
    const {
      bridgeReceiver: roninBridgeReceiver,
      configurator: roninConfigurator,
      cometAdmin: roninCometAdmin,
      comet: roninWethComet,
    } = await roninWethDm.getContracts();

    const roninWronDm = await deploymentManager.addBridgedDeploymentManager('ronin', 'wron', roninHre);
    const { comet: roninWronComet } = await roninWronDm.getContracts();

    const roninWethSetSupplyPerYearInterestRateBaseCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [roninWethComet.address, supplyPerYearInterestRateBase]);
    const roninWethSetSupplyPerYearInterestRateSlopeLowCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [roninWethComet.address, supplyPerYearInterestRateSlopeLow]);
    const roninWethSetSupplyKinkCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [roninWethComet.address, supplyKink]);
    const roninWethSetSupplyPerYearInterestRateSlopeHighCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [roninWethComet.address, supplyPerYearInterestRateSlopeHigh]);
    const roninWethDeployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(['address', 'address'], [roninConfigurator.address, roninWethComet.address]);

    const roninWronSetSupplyPerYearInterestRateBaseCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [roninWronComet.address, supplyPerYearInterestRateBase]);
    const roninWronSetSupplyPerYearInterestRateSlopeLowCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [roninWronComet.address, supplyPerYearInterestRateSlopeLow]);
    const roninWronSetSupplyKinkCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [roninWronComet.address, supplyKink]);
    const roninWronSetSupplyPerYearInterestRateSlopeHighCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [roninWronComet.address, supplyPerYearInterestRateSlopeHigh]);
    const roninWronDeployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(['address', 'address'], [roninConfigurator.address, roninWronComet.address]);

    const roninProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          // WETH Comet
          roninConfigurator.address, roninConfigurator.address,
          roninConfigurator.address, roninConfigurator.address,
          roninCometAdmin.address,
          // WRON Comet
          roninConfigurator.address, roninConfigurator.address,
          roninConfigurator.address, roninConfigurator.address,
          roninCometAdmin.address,
        ],
        [
          0, 0, 0, 0,
          0,
          0, 0, 0, 0,
          0,
        ],
        [
          // WETH Comet
          'setSupplyPerYearInterestRateBase(address,uint64)',
          'setSupplyPerYearInterestRateSlopeLow(address,uint64)',
          'setSupplyKink(address,uint64)',
          'setSupplyPerYearInterestRateSlopeHigh(address,uint64)',
          'deployAndUpgradeTo(address,address)',
          // WRON Comet
          'setSupplyPerYearInterestRateBase(address,uint64)',
          'setSupplyPerYearInterestRateSlopeLow(address,uint64)',
          'setSupplyKink(address,uint64)',
          'setSupplyPerYearInterestRateSlopeHigh(address,uint64)',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          // WETH Comet
          roninWethSetSupplyPerYearInterestRateBaseCalldata,
          roninWethSetSupplyPerYearInterestRateSlopeLowCalldata,
          roninWethSetSupplyKinkCalldata,
          roninWethSetSupplyPerYearInterestRateSlopeHighCalldata,
          roninWethDeployAndUpgradeToCalldata,
          // WRON Comet
          roninWronSetSupplyPerYearInterestRateBaseCalldata,
          roninWronSetSupplyPerYearInterestRateSlopeLowCalldata,
          roninWronSetSupplyKinkCalldata,
          roninWronSetSupplyPerYearInterestRateSlopeHighCalldata,
          roninWronDeployAndUpgradeToCalldata,
        ],
      ]
    );

    const roninFee = await l1CCIPRouter.getFee(destinationChainSelectorRonin, [
      utils.defaultAbiCoder.encode(['address'], [roninBridgeReceiver.address]),
      roninProposalData,
      [],
      GHO_STABLE_TOKEN,
      '0x',
    ]);

    // Scroll (USDC)
    const scrollHre = await forkedHreForBase({ name: 'scroll-usdc', network: 'scroll', deployment: 'usdc' });
    const scrollDm = await deploymentManager.addBridgedDeploymentManager('scroll', 'usdc', scrollHre);
    const {
      bridgeReceiver: scrollBridgeReceiver,
      configurator: scrollConfigurator,
      cometAdmin: scrollCometAdmin,
      comet: scrollUsdcComet,
    } = await scrollDm.getContracts();

    const scrollUsdcSetSupplyPerYearInterestRateBaseCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [scrollUsdcComet.address, supplyPerYearInterestRateBase]);
    const scrollUsdcSetSupplyPerYearInterestRateSlopeLowCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [scrollUsdcComet.address, supplyPerYearInterestRateSlopeLow]);
    const scrollUsdcSetSupplyKinkCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [scrollUsdcComet.address, supplyKink]);
    const scrollUsdcSetSupplyPerYearInterestRateSlopeHighCalldata = utils.defaultAbiCoder.encode(['address', 'uint64'], [scrollUsdcComet.address, supplyPerYearInterestRateSlopeHigh]);
    const scrollUsdcDeployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(['address', 'address'], [scrollConfigurator.address, scrollUsdcComet.address]);

    const scrollProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          scrollConfigurator.address, scrollConfigurator.address,
          scrollConfigurator.address, scrollConfigurator.address,
          scrollCometAdmin.address,
        ],
        [
          0, 0, 0, 0,
          0
        ],
        [
          'setSupplyPerYearInterestRateBase(address,uint64)',
          'setSupplyPerYearInterestRateSlopeLow(address,uint64)',
          'setSupplyKink(address,uint64)',
          'setSupplyPerYearInterestRateSlopeHigh(address,uint64)',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          scrollUsdcSetSupplyPerYearInterestRateBaseCalldata,
          scrollUsdcSetSupplyPerYearInterestRateSlopeLowCalldata,
          scrollUsdcSetSupplyKinkCalldata,
          scrollUsdcSetSupplyPerYearInterestRateSlopeHighCalldata,
          scrollUsdcDeployAndUpgradeToCalldata,
        ],
      ]
    );

    const mainnetActions = [
      // 1. Linea proposal (USDC + WETH)
      {
        contract: lineaMessageService,
        signature: 'sendMessage(address,uint256,bytes)',
        args: [lineaBridgeReceiver.address, 0, lineaProposalData],
      },
      // 2. Mantle proposal (USDe)
      {
        contract: mantleL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [mantleBridgeReceiver.address, mantleProposalData, 2_500_000],
      },
      // 3. Approve GHO to pay the CCIP fee for the Ronin proposal
      {
        target: GHO_STABLE_TOKEN,
        signature: 'approve(address,uint256)',
        calldata: utils.defaultAbiCoder.encode(['address', 'uint256'], [l1CCIPRouter.address, roninFee.mul(2)]),
      },
      // 4. Ronin proposal (WETH + WRON)
      {
        contract: l1CCIPRouter,
        signature: 'ccipSend(uint64,(bytes,bytes,(address,uint256)[],address,bytes))',
        args: [
          destinationChainSelectorRonin,
          [
            utils.defaultAbiCoder.encode(['address'], [roninBridgeReceiver.address]),
            roninProposalData,
            [],
            GHO_STABLE_TOKEN,
            '0x',
          ],
        ],
      },
      // 5. Scroll proposal (USDC)
      {
        contract: scrollMessenger,
        signature: 'sendMessage(address,uint256,bytes,uint256)',
        args: [scrollBridgeReceiver.address, 0, scrollProposalData, 2_500_000],
        value: exp(0.2, 18),
      },
    ];

    const description = `# Zeroing Supply Rates on Deprecated Comets

## Proposal summary

Woof proposes to zero out supply rates on deprecated Comets: cUSDCv3 and cWETHv3 on Linea, cUSDev3 on Mantle, cWETHv3 and cWRONv3 on Ronin, and cUSDCv3 on Scroll. This proposal takes the governance steps recommended and necessary to update Compound III markets on each network. Simulations have confirmed the market’s readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario). The new parameters are based on the [recommendations from Gauntlet](https://www.comp.xyz/t/accelerating-deprecation-zeroing-supply-rates-on-deprecated-comets/7997/1).

Further detailed information can be found on the corresponding [proposal pull request](https://github.com/Compound-Foundation/comet/pull/12) and [forum discussion](https://www.comp.xyz/t/accelerating-deprecation-zeroing-supply-rates-on-deprecated-comets/7997).

## Specification

The following parameters apply identically to all six Comets:

| Parameter                      | Proposed |
| ------------------------------- | -------- |
| Annual Supply Rate Base         | 0%       |
| Annual Supply Rate Slope Low    | 0%       |
| Supply Kink                     | 90%      |
| Annual Supply Rate Slope High   | 0%       |

## Proposal Actions

The first action sends a message to the Linea network to zero out supply rates and upgrade the USDC and WETH Comets.

The second action sends a message to the Mantle network to zero out supply rates and upgrade the USDe Comet.

The third action approves the L1CCIPRouter to transfer GHO from the Timelock to pay for the proposal execution fee on Ronin.

The fourth action sends a CCIP message to the Ronin network to zero out supply rates and upgrade the WETH and WRON Comets.

The fifth action sends a message to the Scroll network to zero out supply rates and upgrade the USDC Comet.
`;

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

    async function verifySupplyRates(configurator: any, comet: any) {
      const configuration = await configurator.getConfiguration(comet.address);
      expect(configuration.supplyKink).to.equal(supplyKink);
      expect(configuration.supplyPerYearInterestRateSlopeLow).to.equal(supplyPerYearInterestRateSlopeLow);
      expect(configuration.supplyPerYearInterestRateSlopeHigh).to.equal(supplyPerYearInterestRateSlopeHigh);
      expect(configuration.supplyPerYearInterestRateBase).to.equal(supplyPerYearInterestRateBase);

      expect(await comet.supplyPerSecondInterestRateBase()).to.equal(0);
      expect(await comet.supplyPerSecondInterestRateSlopeLow()).to.equal(0);
      expect(await comet.supplyKink()).to.equal(supplyKink);
      expect(await comet.supplyPerSecondInterestRateSlopeHigh()).to.equal(0);
    }

    // Linea
    const lineaUsdcDm = deploymentManager.bridgedDeploymentManagers.get('linea:usdc') as DeploymentManager;
    const { configurator: lineaUsdcConfigurator, comet: lineaUsdcComet } = await lineaUsdcDm.getContracts();
    await verifySupplyRates(lineaUsdcConfigurator, lineaUsdcComet);

    const lineaWethDm = deploymentManager.bridgedDeploymentManagers.get('linea:weth') as DeploymentManager;
    const { configurator: lineaWethConfigurator, comet: lineaWethComet } = await lineaWethDm.getContracts();
    await verifySupplyRates(lineaWethConfigurator, lineaWethComet);

    // Mantle
    const mantleDm = deploymentManager.bridgedDeploymentManagers.get('mantle:usde') as DeploymentManager;
    const { configurator: mantleConfigurator, comet: mantleUsdeComet } = await mantleDm.getContracts();
    await verifySupplyRates(mantleConfigurator, mantleUsdeComet);

    // Ronin
    const roninWethDm = deploymentManager.bridgedDeploymentManagers.get('ronin:weth') as DeploymentManager;
    const { configurator: roninWethConfigurator, comet: roninWethComet } = await roninWethDm.getContracts();
    await verifySupplyRates(roninWethConfigurator, roninWethComet);

    const roninWronDm = deploymentManager.bridgedDeploymentManagers.get('ronin:wron') as DeploymentManager;
    const { configurator: roninWronConfigurator, comet: roninWronComet } = await roninWronDm.getContracts();
    await verifySupplyRates(roninWronConfigurator, roninWronComet);

    // Scroll
    const scrollDm = deploymentManager.bridgedDeploymentManagers.get('scroll:usdc') as DeploymentManager;
    const { configurator: scrollConfigurator, comet: scrollUsdcComet } = await scrollDm.getContracts();
    await verifySupplyRates(scrollConfigurator, scrollUsdcComet);
  },
});
