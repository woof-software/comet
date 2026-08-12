import { expect } from 'chai';
import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal, calldata } from '../../../../src/deploy';

const config = {
  unichain: {
    USDC: {
      comet: '0x2c7118c4C88B9841FCF839074c26Ae8f035f2921',
      newExt: '0x0d4Bd55A755134950027cE1F43190A354e648e20',
    },
    WETH: {
      comet: '0x6C987dDE50dB1dcDd32Cd4175778C2a291978E2a',
      newExt: '0xF3BBe5807feA997d540939Cbf138c134b11e3CF1',
    },
  },
};

const factoryConfig = {
  unichain: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
};

const desiredVersion = {
  version: [1, 2, 1],
  alternative: ''
};

export default migration('1779894796_update_l2_markets_to_v2_factory', {
  async prepare() {    
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      unichainL1CrossDomainMessenger,
    } = await govDeploymentManager.getContracts();

    // Unichain
    const {
      bridgeReceiver: unichainBridgeReceiver,
      configurator: unichainConfigurator,
      cometAdmin: unichainCometAdmin,
    } = await deploymentManager.getContracts();

    const unichainFactoryV2 = new Contract(
      factoryConfig.unichain,
      [
        'function setVersion(((uint64,uint64,uint64) version, string alternative))',
      ],
      await deploymentManager.getSigner()
    );
    const setVersionCalldataUnichain = await calldata(
      unichainFactoryV2.populateTransaction.setVersion(desiredVersion)
    );

    const setFactoryCalldataUnichainUsdc = await calldata(
      unichainConfigurator.populateTransaction.setFactory(config.unichain.USDC.comet, factoryConfig.unichain)
    );
    const setExtensionDelegateCalldataUnichainUsdc = await calldata(
      unichainConfigurator.populateTransaction.setExtensionDelegate(config.unichain.USDC.comet, config.unichain.USDC.newExt)
    );
    const deployAndUpgradeToCalldataUnichainUsdc = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [unichainConfigurator.address, config.unichain.USDC.comet]
    );

    const setFactoryCalldataUnichainWeth = await calldata(
      unichainConfigurator.populateTransaction.setFactory(config.unichain.WETH.comet, factoryConfig.unichain)
    );
    const setExtensionDelegateCalldataUnichainWeth = await calldata(
      unichainConfigurator.populateTransaction.setExtensionDelegate(config.unichain.WETH.comet, config.unichain.WETH.newExt)
    );
    const deployAndUpgradeToCalldataUnichainWeth = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [unichainConfigurator.address, config.unichain.WETH.comet]
    );

    const unichainProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          factoryConfig.unichain,
          unichainConfigurator.address, unichainConfigurator.address, unichainCometAdmin.address,
          unichainConfigurator.address, unichainConfigurator.address, unichainCometAdmin.address,
        ],
        [
          0,
          0, 0, 0,
          0, 0, 0,
        ],
        [
          'setVersion(((uint64,uint64,uint64),string))',
          'setFactory(address,address)',
          'setExtensionDelegate(address,address)',
          'deployAndUpgradeTo(address,address)',
          'setFactory(address,address)',
          'setExtensionDelegate(address,address)',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          setVersionCalldataUnichain,
          setFactoryCalldataUnichainUsdc, setExtensionDelegateCalldataUnichainUsdc, deployAndUpgradeToCalldataUnichainUsdc,
          setFactoryCalldataUnichainWeth, setExtensionDelegateCalldataUnichainWeth, deployAndUpgradeToCalldataUnichainWeth,
        ]
      ]
    );

    const mainnetActions = [
      // 1. Unichain proposal
      {
        contract: unichainL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [unichainBridgeReceiver.address, unichainProposalData, 2_000_000],
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

    // Unichain
    const {
      configurator: unichainConfigurator,
    } = await deploymentManager.getContracts();
 
    expect(await unichainConfigurator.factory(config.unichain.USDC.comet)).to.equal(factoryConfig.unichain);
    expect(await unichainConfigurator.factory(config.unichain.WETH.comet)).to.equal(factoryConfig.unichain);
 
    expect((await unichainConfigurator.getConfiguration(config.unichain.USDC.comet)).extensionDelegate).to.equal(config.unichain.USDC.newExt);
    expect((await unichainConfigurator.getConfiguration(config.unichain.WETH.comet)).extensionDelegate).to.equal(config.unichain.WETH.newExt);
 
    const unichainSigner = await deploymentManager.getSigner();

    const unichainCometFactoryV2 = new Contract(
      factoryConfig.unichain,
      [
        'function version() view returns ((uint64,uint64,uint64),string)',
      ],
      unichainSigner
    );

    const [version, alternative] = await unichainCometFactoryV2.version();
    expect(version).to.deep.equal([1, 2, 1]);
    expect(alternative).to.equal('');

    const newCometUnichainUsdc = new Contract(
      config.unichain.USDC.comet, 
      newCometAbi,
      unichainSigner
    );
 
    expect(await newCometUnichainUsdc.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometUnichainUsdc.symbol()).to.equal('cUSDCv3');
    expect(await newCometUnichainUsdc.name()).to.equal('Compound USDC');
    expect(await newCometUnichainUsdc.extensionDelegate()).to.equal(config.unichain.USDC.newExt);
 
    const newCometUnichainWeth = new Contract(
      config.unichain.WETH.comet, 
      newCometAbi,
      unichainSigner
    );
 
    expect(await newCometUnichainWeth.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometUnichainWeth.symbol()).to.equal('cWETHv3');
    expect(await newCometUnichainWeth.name()).to.equal('Compound WETH');
    expect(await newCometUnichainWeth.extensionDelegate()).to.equal(config.unichain.WETH.newExt);
  },
});
