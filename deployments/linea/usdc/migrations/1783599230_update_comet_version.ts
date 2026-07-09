import { expect } from 'chai';
import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal, calldata } from '../../../../src/deploy';
import { forkedHreForBase } from '../../../../plugins/scenario/utils/hreForBase';

const USDC_COMET_LINEA = '0x8D38A3d6B3c3B7d96D6536DA7Eef94A9d7dbC991';
const WETH_COMET_LINEA = '0x60F2058379716A64a7A5d29219397e79bC552194';

////

const USDC_COMET_SCROLL = '0xB2f97c1Bd3bf02f5e74d13f02E3e26F93D77CE44';

export default migration('1783599230_update_comet_version', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      bridgeReceiver: lineaBridgeReceiver,
      cometAdmin: lineaCometAdmin,
      configurator: lineaConfigurator,
      cometFactory: lineaCometFactory
    } = await deploymentManager.getContracts();

    const {
      lineaMessageService,
      scrollMessenger,
      governor,
    } = await govDeploymentManager.getContracts();

    const cometFactoryV2Linea = new Contract(
      lineaCometFactory.address,
      [
        'function setVersion(((uint64,uint64,uint64),string))',
      ],
      await deploymentManager.getSigner()
    );

    const setVersionCalldataLinea = await calldata(
      cometFactoryV2Linea.populateTransaction.setVersion(
        [[1, 2, 1], '']
      )
    );
  
    const deployAndUpgradeToCalldataUsdcLinea = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [lineaConfigurator.address, USDC_COMET_LINEA]
    );
    const deployAndUpgradeToCalldataWethLinea = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [lineaConfigurator.address, WETH_COMET_LINEA]
    );

    const l2ProposalDataLinea = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          lineaCometFactory.address,
          lineaCometAdmin.address,
          lineaCometAdmin.address
        ],
        [
          0,
          0,
          0
        ],
        [
          'setVersion(((uint64,uint64,uint64),string))',
          'deployAndUpgradeTo(address,address)',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          setVersionCalldataLinea,
          deployAndUpgradeToCalldataUsdcLinea,
          deployAndUpgradeToCalldataWethLinea
        ]
      ]
    );

    // Scroll    
    const scrollHre = await forkedHreForBase({ name: 'scroll-usdc', network: 'scroll', deployment: 'usdc' });
    const scrollDm = await govDeploymentManager.addBridgedDeploymentManager('scroll', 'usdc', scrollHre);
    const {
      bridgeReceiver: scrollBridgeReceiver,
      configurator: scrollConfigurator,
      cometFactory: scrollCometFactory,
      cometAdmin: scrollCometAdmin,
    } = await scrollDm.getContracts();

    const cometFactoryV2Scroll = new Contract(
      scrollCometFactory.address,
      [
        'function setVersion(((uint64,uint64,uint64),string))',
      ],
      await scrollDm.getSigner()
    );

    const setVersionCalldataScroll = await calldata(
      cometFactoryV2Scroll.populateTransaction.setVersion(
        [[1, 2, 1], '']
      )
    );

    const deployAndUpgradeToCalldataUsdcScroll = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [scrollConfigurator.address, USDC_COMET_SCROLL]
    );

    const l2ProposalDataScroll = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          scrollCometFactory.address, scrollCometAdmin.address,
        ],
        [
          0, 0,
        ],
        [
          'setVersion(((uint64,uint64,uint64),string))',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          setVersionCalldataScroll, deployAndUpgradeToCalldataUsdcScroll,
        ]
      ]
    );

    const mainnetActions = [
      // 1. Update USDC and WETH Comet on Linea to the service patch version
      {
        contract: lineaMessageService,
        signature: 'sendMessage(address,uint256,bytes)',
        args: [lineaBridgeReceiver.address, 0, l2ProposalDataLinea],
      },
      // 2. Update USDC Comet to the service patch version
      {
        contract: scrollMessenger,
        signature: 'sendMessage(address,uint256,bytes,uint256)',
        args: [scrollBridgeReceiver.address, 0, l2ProposalDataScroll, 1_000_000],
        value: exp(0.05, 18)
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

  async verify(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager): Promise<void> {
    const {
      cometFactory: lineaCometFactory,
      configurator: lineaConfigurator,
    } = await deploymentManager.getContracts();

    expect(await lineaConfigurator.factory(USDC_COMET_LINEA)).to.equal(lineaCometFactory.address);
    expect(await lineaConfigurator.factory(WETH_COMET_LINEA)).to.equal(lineaCometFactory.address);

    const cometFactoryV2Linea = new Contract(
      lineaCometFactory.address,
      [
        'function version() view returns ((uint64,uint64,uint64),string)',
      ],
      await deploymentManager.getSigner()
    );

    const [version, alternative] = await cometFactoryV2Linea.version();
    expect(version).to.deep.equal([1, 2, 1]);
    expect(alternative).to.equal('');

    // Scroll
    const scrollDm = govDeploymentManager.bridgedDeploymentManagers.get('scroll:usdc') as DeploymentManager;
    const {
      configurator: scrollConfigurator,
      cometFactory: scrollCometFactory,
    } = await scrollDm.getContracts();

    expect(await scrollConfigurator.factory(USDC_COMET_SCROLL)).to.equal(scrollCometFactory.address);
    const scrollSigner = await scrollDm.getSigner();
    
    const cometFactoryV2Scroll = new Contract(
      scrollCometFactory.address,
      [
        'function version() view returns ((uint64,uint64,uint64),string)',
      ],
      scrollSigner
    );

    const [versionScroll, alternativeScroll] = await cometFactoryV2Scroll.version();
    expect(versionScroll).to.deep.equal([1, 2, 1]);
    expect(alternativeScroll).to.equal('');
  },
});
