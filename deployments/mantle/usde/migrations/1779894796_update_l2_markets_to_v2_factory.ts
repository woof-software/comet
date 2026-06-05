import { expect } from 'chai';
import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal, calldata } from '../../../../src/deploy';

const config = {
  mantle: {
    USDe: {
      comet: '0x606174f62cd968d8e684c645080fa694c1D7786E',
      newExt: '0xb9740Aee0640165794AD68b29F3809020A41FaAa',
    },
  },
};

const factoryConfig = {
  mantle: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
};

export default migration('1779894796_update_l2_markets_to_v2_factory', {
  async prepare() {    
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      mantleL1CrossDomainMessenger,
    } = await govDeploymentManager.getContracts();

    // Mantle
    const {
      bridgeReceiver: mantleBridgeReceiver,
      configurator: mantleConfigurator,
      cometAdmin: mantleCometAdmin,
    } = await deploymentManager.getContracts();

    const setFactoryCalldataMantleUsde = await calldata(
      mantleConfigurator.populateTransaction.setFactory(config.mantle.USDe.comet, factoryConfig.mantle)
    );
    const setExtensionDelegateCalldataMantleUsde = await calldata(
      mantleConfigurator.populateTransaction.setExtensionDelegate(config.mantle.USDe.comet, config.mantle.USDe.newExt)
    );
    const deployAndUpgradeToCalldataMantleUsde = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [mantleConfigurator.address, config.mantle.USDe.comet]
    );

    const mantleProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          mantleConfigurator.address, mantleConfigurator.address, mantleCometAdmin.address,
        ],
        [
          0, 0, 0,
        ],
        [
          'setFactory(address,address)',
          'setExtensionDelegate(address,address)',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          setFactoryCalldataMantleUsde, setExtensionDelegateCalldataMantleUsde, deployAndUpgradeToCalldataMantleUsde,
        ]
      ]
    );

    const mainnetActions = [
      // 7. Mantle proposal
      {
        contract: mantleL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [mantleBridgeReceiver.address, mantleProposalData, 1_500_000],
      },
    ];

    const description = `DESCRIPTION`;
    const txn = await deploymentManager.retry(async () =>
      trace(
        await governor.propose(...(await proposal(mainnetActions, description)))
      ), 0, 300_000
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

  async verify(deploymentManager: DeploymentManager): Promise<void> {
    const newCometAbi = [
      'function MAX_SUPPORTED_UTILIZATION() external view returns (uint256)',
      'function symbol() external view returns (string)',
      'function name() external view returns (string)',
      'function extensionDelegate() external view returns (address)',
    ];

    const expectedMaxUtilization = exp(2, 18);

    // Mantle
    const {
      configurator: mantleConfigurator,
    } = await deploymentManager.getContracts();

    expect(await mantleConfigurator.factory(config.mantle.USDe.comet)).to.equal(factoryConfig.mantle);

    expect((await mantleConfigurator.getConfiguration(config.mantle.USDe.comet)).extensionDelegate).to.equal(config.mantle.USDe.newExt);

    const mantleSigner = await deploymentManager.getSigner();

    const newCometMantleUsde = new Contract(
      config.mantle.USDe.comet, 
      newCometAbi,
      mantleSigner
    );

    expect(await newCometMantleUsde.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometMantleUsde.symbol()).to.equal('cUSDev3');
    expect(await newCometMantleUsde.name()).to.equal('Compound USDe');
    expect(await newCometMantleUsde.extensionDelegate()).to.equal(config.mantle.USDe.newExt);
  },
});
