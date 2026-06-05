import { expect } from 'chai';
import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal, calldata } from '../../../../src/deploy';

const config = {
  base: {
    AERO: {
      comet: '0x784efeB622244d2348d4F2522f8860B96fbEcE89',
      newExt: '0x68da9e5360129A74AD99993faFF282726d6e8165',
    },
    USDbC: {
      comet: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
      newExt: '0xFE9af7911DaFcf614901EAa5Ad5e28b3eFcBbeD3',
    },
    USDC: {
      comet: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
      newExt: '0xa7d85850FBb7e3d188CF45a4A8Aab79Ff2A7EECE',
    },
    USDS: {
      comet: '0x2c776041CCFe903071AF44aa147368a9c8EEA518',
      newExt: '0xcA324510c90A14E0329285fd29d4ebA654612B62',
    },
    WETH: {
      comet: '0x46e6b214b524310239732D51387075E0e70970bf',
      newExt: '0x90Bf44022627155395251422D7Ea2AdCf7458638',
    },
  },
};

const factoryConfig = {
  base: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
};

export default migration('1779894796_update_l2_markets_to_v2_factory', {
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

    // USDC, USDbC and USDS
    const setFactoryCalldataBaseUsdc = await calldata(
      baseConfigurator.populateTransaction.setFactory(config.base.USDC.comet, factoryConfig.base)
    );
    const setExtensionDelegateCalldataBaseUsdc = await calldata(
      baseConfigurator.populateTransaction.setExtensionDelegate(config.base.USDC.comet, config.base.USDC.newExt)
    );
    const deployAndUpgradeToCalldataBaseUsdc = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [baseConfigurator.address, config.base.USDC.comet]
    );

    const setFactoryCalldataBaseUsdbc = await calldata(
      baseConfigurator.populateTransaction.setFactory(config.base.USDbC.comet, factoryConfig.base)
    );
    const setExtensionDelegateCalldataBaseUsdbc = await calldata(
      baseConfigurator.populateTransaction.setExtensionDelegate(config.base.USDbC.comet, config.base.USDbC.newExt)
    );
    const deployAndUpgradeToCalldataBaseUsdbc = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [baseConfigurator.address, config.base.USDbC.comet]
    );

    const setFactoryCalldataBaseUsds = await calldata(
      baseConfigurator.populateTransaction.setFactory(config.base.USDS.comet, factoryConfig.base)
    );
    const setExtensionDelegateCalldataBaseUsds = await calldata(
      baseConfigurator.populateTransaction.setExtensionDelegate(config.base.USDS.comet, config.base.USDS.newExt)
    );
    const deployAndUpgradeToCalldataBaseUsds = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [baseConfigurator.address, config.base.USDS.comet]
    );

    const baseProposalDataPart1 = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          baseConfigurator.address, baseConfigurator.address, baseCometAdmin.address,
          baseConfigurator.address, baseConfigurator.address, baseCometAdmin.address,
          baseConfigurator.address, baseConfigurator.address, baseCometAdmin.address,
        ],
        [
          0, 0, 0,
          0, 0, 0,
          0, 0, 0,
        ],
        [
          'setFactory(address,address)',
          'setExtensionDelegate(address,address)',
          'deployAndUpgradeTo(address,address)',
          'setFactory(address,address)',
          'setExtensionDelegate(address,address)',
          'deployAndUpgradeTo(address,address)',
          'setFactory(address,address)',
          'setExtensionDelegate(address,address)',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          setFactoryCalldataBaseUsdc, setExtensionDelegateCalldataBaseUsdc, deployAndUpgradeToCalldataBaseUsdc,
          setFactoryCalldataBaseUsdbc, setExtensionDelegateCalldataBaseUsdbc, deployAndUpgradeToCalldataBaseUsdbc,
          setFactoryCalldataBaseUsds, setExtensionDelegateCalldataBaseUsds, deployAndUpgradeToCalldataBaseUsds,
        ]
      ]
    );

    // AERO and WETH
    const setFactoryCalldataBaseAero = await calldata(
      baseConfigurator.populateTransaction.setFactory(config.base.AERO.comet, factoryConfig.base)
    );
    const setExtensionDelegateCalldataBaseAero = await calldata(
      baseConfigurator.populateTransaction.setExtensionDelegate(config.base.AERO.comet, config.base.AERO.newExt)
    );
    const deployAndUpgradeToCalldataBaseAero = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [baseConfigurator.address, config.base.AERO.comet]
    );

    const setFactoryCalldataBaseWeth = await calldata(
      baseConfigurator.populateTransaction.setFactory(config.base.WETH.comet, factoryConfig.base)
    );
    const setExtensionDelegateCalldataBaseWeth = await calldata(
      baseConfigurator.populateTransaction.setExtensionDelegate(config.base.WETH.comet, config.base.WETH.newExt)
    );
    const deployAndUpgradeToCalldataBaseWeth = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [baseConfigurator.address, config.base.WETH.comet]
    );

    const baseProposalDataPart2 = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          baseConfigurator.address, baseConfigurator.address, baseCometAdmin.address,
          baseConfigurator.address, baseConfigurator.address, baseCometAdmin.address,
        ],
        [
          0, 0, 0,
          0, 0, 0,
        ],
        [
          'setFactory(address,address)',
          'setExtensionDelegate(address,address)',
          'deployAndUpgradeTo(address,address)',
          'setFactory(address,address)',
          'setExtensionDelegate(address,address)',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          setFactoryCalldataBaseAero, setExtensionDelegateCalldataBaseAero, deployAndUpgradeToCalldataBaseAero,
          setFactoryCalldataBaseWeth, setExtensionDelegateCalldataBaseWeth, deployAndUpgradeToCalldataBaseWeth,
        ]
      ]
    );

    const mainnetActions = [
      // 1. Base proposal USDC + USDbC + USDS
      {
        contract: baseL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [baseBridgeReceiver.address, baseProposalDataPart1, 3_000_000]
      },
      // 2. Base proposal AERO + WETH
      {
        contract: baseL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [baseBridgeReceiver.address, baseProposalDataPart2, 3_000_000]
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

    expect(await baseConfigurator.factory(config.base.USDC.comet)).to.equal(factoryConfig.base);
    expect(await baseConfigurator.factory(config.base.USDbC.comet)).to.equal(factoryConfig.base);
    expect(await baseConfigurator.factory(config.base.USDS.comet)).to.equal(factoryConfig.base);
    expect(await baseConfigurator.factory(config.base.AERO.comet)).to.equal(factoryConfig.base);
    expect(await baseConfigurator.factory(config.base.WETH.comet)).to.equal(factoryConfig.base);

    expect((await baseConfigurator.getConfiguration(config.base.USDC.comet)).extensionDelegate).to.equal(config.base.USDC.newExt);
    expect((await baseConfigurator.getConfiguration(config.base.USDbC.comet)).extensionDelegate).to.equal(config.base.USDbC.newExt);
    expect((await baseConfigurator.getConfiguration(config.base.USDS.comet)).extensionDelegate).to.equal(config.base.USDS.newExt);
    expect((await baseConfigurator.getConfiguration(config.base.AERO.comet)).extensionDelegate).to.equal(config.base.AERO.newExt);
    expect((await baseConfigurator.getConfiguration(config.base.WETH.comet)).extensionDelegate).to.equal(config.base.WETH.newExt);

    const baseSigner = await deploymentManager.getSigner();

    const newCometBaseUsdc = new Contract(
      config.base.USDC.comet, 
      newCometAbi,
      baseSigner
    );

    expect(await newCometBaseUsdc.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometBaseUsdc.symbol()).to.equal('cUSDCv3');
    expect(await newCometBaseUsdc.name()).to.equal('Compound USDC');
    expect(await newCometBaseUsdc.extensionDelegate()).to.equal(config.base.USDC.newExt);

    const newCometBaseUsdbc = new Contract(
      config.base.USDbC.comet, 
      newCometAbi,
      baseSigner
    );

    expect(await newCometBaseUsdbc.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometBaseUsdbc.symbol()).to.equal('cUSDbCv3');
    expect(await newCometBaseUsdbc.name()).to.equal('Compound USDbC');
    expect(await newCometBaseUsdbc.extensionDelegate()).to.equal(config.base.USDbC.newExt);

    const newCometBaseUsds = new Contract(
      config.base.USDS.comet, 
      newCometAbi,
      baseSigner
    );

    expect(await newCometBaseUsds.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometBaseUsds.symbol()).to.equal('cUSDSv3');
    expect(await newCometBaseUsds.name()).to.equal('Compound USDS');
    expect(await newCometBaseUsds.extensionDelegate()).to.equal(config.base.USDS.newExt);

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
