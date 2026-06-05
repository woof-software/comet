import { expect } from 'chai';
import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal, calldata } from '../../../../src/deploy';

const config = {
  optimism: {
    USDC: {
      comet: '0x2e44e174f7D53F0212823acC11C01A11d58c5bCB',
      newExt: '0xA5344c37a75CfF9F79e3dDe1eE9f9784A427dba2',
    },
    USDT: {
      comet: '0x995E394b8B2437aC8Ce61Ee0bC610D617962B214',
      newExt: '0xddB3B341c4036bF0cFFE3C7fAacF4873D9132998',
    },
    WETH: {
      comet: '0xE36A30D249f7761327fd973001A32010b521b6Fd',
      newExt: '0xD79B56AD7f8586C3fe2546A31c877044e595aeE5',
    },
  },
};

const factoryConfig = {
  optimism: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
};

export default migration('1779894796_update_l2_markets_to_v2_factory', {
  async prepare() {    
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      opL1CrossDomainMessenger,
    } = await govDeploymentManager.getContracts();

    // Optimism
    const {
      configurator: optimismConfigurator,
      cometAdmin: optimismCometAdmin,
      bridgeReceiver: optimismBridgeReceiver,
    } = await deploymentManager.getContracts();

    const setFactoryCalldataOptimismUsdc = await calldata(
      optimismConfigurator.populateTransaction.setFactory(config.optimism.USDC.comet, factoryConfig.optimism)
    );
    const setExtensionDelegateCalldataOptimismUsdc = await calldata(
      optimismConfigurator.populateTransaction.setExtensionDelegate(config.optimism.USDC.comet, config.optimism.USDC.newExt)
    );
    const deployAndUpgradeToCalldataOptimismUsdc = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [optimismConfigurator.address, config.optimism.USDC.comet]
    );

    const setFactoryCalldataOptimismUsdt = await calldata(
      optimismConfigurator.populateTransaction.setFactory(config.optimism.USDT.comet, factoryConfig.optimism)
    );
    const setExtensionDelegateCalldataOptimismUsdt = await calldata(
      optimismConfigurator.populateTransaction.setExtensionDelegate(config.optimism.USDT.comet, config.optimism.USDT.newExt)
    );
    const deployAndUpgradeToCalldataOptimismUsdt = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [optimismConfigurator.address, config.optimism.USDT.comet]
    );

    const setFactoryCalldataOptimismWeth = await calldata(
      optimismConfigurator.populateTransaction.setFactory(config.optimism.WETH.comet, factoryConfig.optimism)
    );
    const setExtensionDelegateCalldataOptimismWeth = await calldata(
      optimismConfigurator.populateTransaction.setExtensionDelegate(config.optimism.WETH.comet, config.optimism.WETH.newExt)
    );
    const deployAndUpgradeToCalldataOptimismWeth = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [optimismConfigurator.address, config.optimism.WETH.comet]
    );

    const optimismProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          optimismConfigurator.address, optimismConfigurator.address, optimismCometAdmin.address,
          optimismConfigurator.address, optimismConfigurator.address, optimismCometAdmin.address,
          optimismConfigurator.address, optimismConfigurator.address, optimismCometAdmin.address,
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
          setFactoryCalldataOptimismUsdc, setExtensionDelegateCalldataOptimismUsdc, deployAndUpgradeToCalldataOptimismUsdc,
          setFactoryCalldataOptimismUsdt, setExtensionDelegateCalldataOptimismUsdt, deployAndUpgradeToCalldataOptimismUsdt,
          setFactoryCalldataOptimismWeth, setExtensionDelegateCalldataOptimismWeth, deployAndUpgradeToCalldataOptimismWeth,
        ]
      ]
    );

    const mainnetActions = [
      // 1. Optimism proposal      
      {
        contract: opL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [optimismBridgeReceiver.address, optimismProposalData, 2_500_000]
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

    // Optimism
    const {
      configurator: optimismConfigurator,
    } = await deploymentManager.getContracts();

    expect(await optimismConfigurator.factory(config.optimism.USDC.comet)).to.equal(factoryConfig.optimism);
    expect(await optimismConfigurator.factory(config.optimism.USDT.comet)).to.equal(factoryConfig.optimism);
    expect(await optimismConfigurator.factory(config.optimism.WETH.comet)).to.equal(factoryConfig.optimism);

    expect((await optimismConfigurator.getConfiguration(config.optimism.USDC.comet)).extensionDelegate).to.equal(config.optimism.USDC.newExt);
    expect((await optimismConfigurator.getConfiguration(config.optimism.USDT.comet)).extensionDelegate).to.equal(config.optimism.USDT.newExt);
    expect((await optimismConfigurator.getConfiguration(config.optimism.WETH.comet)).extensionDelegate).to.equal(config.optimism.WETH.newExt);

    const optimismSigner = await deploymentManager.getSigner();

    const newCometOptimismUsdc = new Contract(
      config.optimism.USDC.comet, 
      newCometAbi,
      optimismSigner
    );

    expect(await newCometOptimismUsdc.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometOptimismUsdc.symbol()).to.equal('cUSDCv3');
    expect(await newCometOptimismUsdc.name()).to.equal('Compound USDC');
    expect(await newCometOptimismUsdc.extensionDelegate()).to.equal(config.optimism.USDC.newExt);

    const newCometOptimismUsdt = new Contract(
      config.optimism.USDT.comet, 
      newCometAbi,
      optimismSigner
    );

    expect(await newCometOptimismUsdt.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometOptimismUsdt.symbol()).to.equal('cUSDTv3');
    expect(await newCometOptimismUsdt.name()).to.equal('Compound USDT');
    expect(await newCometOptimismUsdt.extensionDelegate()).to.equal(config.optimism.USDT.newExt);

    const newCometOptimismWeth = new Contract(
      config.optimism.WETH.comet, 
      newCometAbi,
      optimismSigner
    );

    expect(await newCometOptimismWeth.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometOptimismWeth.symbol()).to.equal('cWETHv3');
    expect(await newCometOptimismWeth.name()).to.equal('Compound WETH');
    expect(await newCometOptimismWeth.extensionDelegate()).to.equal(config.optimism.WETH.newExt);
  },
});
