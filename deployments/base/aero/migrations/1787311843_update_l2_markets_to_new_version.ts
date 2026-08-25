import { expect } from 'chai';
import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

const config = {
  base: {
    AERO: {
      comet: '0x784efeB622244d2348d4F2522f8860B96fbEcE89',
      newExt: '0x7E5873DD6a92802b280D8d59DEc2aa6Ce0EEB13A',
    },
    WETH: {
      comet: '0x46e6b214b524310239732D51387075E0e70970bf',
      newExt: '0xF3BBe5807feA997d540939Cbf138c134b11e3CF1',
    },
  },
};

const factoryConfig = {
  base: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
};

export default migration('1787311843_update_l2_markets_to_new_version', {
  async prepare() {    
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      baseL1CrossDomainMessenger,
    } = await govDeploymentManager.getContracts();

    // Base
    const {
      bridgeReceiver : baseBridgeReceiver,
      configurator: baseConfigurator,
      cometAdmin: baseCometAdmin,
    } = await deploymentManager.getContracts();

    // AERO and WETH
    const deployAndUpgradeToCalldataBaseAero = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [baseConfigurator.address, config.base.AERO.comet]
    );
    const deployAndUpgradeToCalldataBaseWeth = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [baseConfigurator.address, config.base.WETH.comet]
    );

    const baseProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          baseCometAdmin.address,
          baseCometAdmin.address,
        ],
        [
          0, 0,
        ],
        [
          'deployAndUpgradeTo(address,address)',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          deployAndUpgradeToCalldataBaseAero,
          deployAndUpgradeToCalldataBaseWeth,
        ]
      ]
    );

    const mainnetActions = [
      // 2. Base proposal AERO + WETH
      {
        contract: baseL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [baseBridgeReceiver.address, baseProposalData, 3_000_000]
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

    // Base
    const {
      configurator: baseConfigurator,
    } = await deploymentManager.getContracts();

    expect(await baseConfigurator.factory(config.base.AERO.comet)).to.equal(factoryConfig.base);
    expect(await baseConfigurator.factory(config.base.WETH.comet)).to.equal(factoryConfig.base);

    expect((await baseConfigurator.getConfiguration(config.base.AERO.comet)).extensionDelegate).to.equal(config.base.AERO.newExt);
    expect((await baseConfigurator.getConfiguration(config.base.WETH.comet)).extensionDelegate).to.equal(config.base.WETH.newExt);

    const baseSigner = await deploymentManager.getSigner();

    const baseCometFactoryV2 = new Contract(
      factoryConfig.base,
      [
        'function version() view returns ((uint64,uint64,uint64),string)',
      ],
      baseSigner
    );

    const [version, alternative] = await baseCometFactoryV2.version();
    expect(version).to.deep.equal([1, 2, 1]);
    expect(alternative).to.equal('');

    const newCometBaseAero = new Contract(
      config.base.AERO.comet, 
      newCometAbi,
      baseSigner
    );

    expect(await newCometBaseAero.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometBaseAero.symbol()).to.equal('cAEROv3');
    expect(await newCometBaseAero.name()).to.equal('Compound AERO');
    expect(await newCometBaseAero.extensionDelegate()).to.equal(config.base.AERO.newExt);

    const newCometBaseWeth = new Contract(
      config.base.WETH.comet, 
      newCometAbi,
      baseSigner
    );

    expect(await newCometBaseWeth.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometBaseWeth.symbol()).to.equal('cWETHv3');
    expect(await newCometBaseWeth.name()).to.equal('Compound WETH');
    expect(await newCometBaseWeth.extensionDelegate()).to.equal(config.base.WETH.newExt);
  },
});
