import { expect } from 'chai';
import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal, calldata } from '../../../../src/deploy';

const config = {
  polygon: {
    USDC: {
      comet: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
      newExt: '0x73FEA263A1b44896af1BdB0dD983849297D3f4a7',
    },
    USDT: {
      comet: '0xaeB318360f27748Acb200CE616E389A6C9409a07',
      newExt: '0x3a0f520513ad11DA868D1f4C6b7fe36944f8825d',
    },
  },
};

const factoryConfig = {
  polygon: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
};

export default migration('1779894796_update_l2_markets_to_v2_factory', {
  async prepare() {    
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      fxRoot,
    } = await govDeploymentManager.getContracts();

    // Polygon
    const {
      bridgeReceiver: polygonBridgeReceiver,
      configurator: polygonConfigurator,
      cometAdmin: polygonCometAdmin,
    } = await deploymentManager.getContracts();

    const setFactoryCalldataPolygonUsdc = await calldata(
      polygonConfigurator.populateTransaction.setFactory(config.polygon.USDC.comet, factoryConfig.polygon)
    );
    const setExtensionDelegateCalldataPolygonUsdc = await calldata(
      polygonConfigurator.populateTransaction.setExtensionDelegate(config.polygon.USDC.comet, config.polygon.USDC.newExt)
    );
    const deployAndUpgradeToCalldataPolygonUsdc = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [polygonConfigurator.address, config.polygon.USDC.comet]
    );

    const setFactoryCalldataPolygonUsdt = await calldata(
      polygonConfigurator.populateTransaction.setFactory(config.polygon.USDT.comet, factoryConfig.polygon)
    );
    const setExtensionDelegateCalldataPolygonUsdt = await calldata(
      polygonConfigurator.populateTransaction.setExtensionDelegate(config.polygon.USDT.comet, config.polygon.USDT.newExt)
    );
    const deployAndUpgradeToCalldataPolygonUsdt = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [polygonConfigurator.address, config.polygon.USDT.comet]
    );

    const polygonProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          polygonConfigurator.address, polygonConfigurator.address, polygonCometAdmin.address,
          polygonConfigurator.address, polygonConfigurator.address, polygonCometAdmin.address,
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
          setFactoryCalldataPolygonUsdc, setExtensionDelegateCalldataPolygonUsdc, deployAndUpgradeToCalldataPolygonUsdc,
          setFactoryCalldataPolygonUsdt, setExtensionDelegateCalldataPolygonUsdt, deployAndUpgradeToCalldataPolygonUsdt,
        ]
      ]
    );

    const mainnetActions = [
      // 1. Polygon proposal
      {
        contract: fxRoot,
        signature: 'sendMessageToChild(address,bytes)',
        args: [polygonBridgeReceiver.address, polygonProposalData],
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

    // Polygon
    const {
      configurator: polygonConfigurator,
    } = await deploymentManager.getContracts();

    expect(await polygonConfigurator.factory(config.polygon.USDC.comet)).to.equal(factoryConfig.polygon);
    expect(await polygonConfigurator.factory(config.polygon.USDT.comet)).to.equal(factoryConfig.polygon);

    expect((await polygonConfigurator.getConfiguration(config.polygon.USDC.comet)).extensionDelegate).to.equal(config.polygon.USDC.newExt);
    expect((await polygonConfigurator.getConfiguration(config.polygon.USDT.comet)).extensionDelegate).to.equal(config.polygon.USDT.newExt);

    const polygonSigner = await deploymentManager.getSigner();

    const newCometPolygonUsdc = new Contract(
      config.polygon.USDC.comet, 
      newCometAbi,
      polygonSigner
    );

    expect(await newCometPolygonUsdc.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometPolygonUsdc.symbol()).to.equal('cUSDCv3');
    expect(await newCometPolygonUsdc.name()).to.equal('Compound USDC');
    expect(await newCometPolygonUsdc.extensionDelegate()).to.equal(config.polygon.USDC.newExt);

    const newCometPolygonUsdt = new Contract(
      config.polygon.USDT.comet, 
      newCometAbi,
      polygonSigner
    );

    expect(await newCometPolygonUsdt.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometPolygonUsdt.symbol()).to.equal('cUSDTv3');
    expect(await newCometPolygonUsdt.name()).to.equal('Compound USDT');
    expect(await newCometPolygonUsdt.extensionDelegate()).to.equal(config.polygon.USDT.newExt);
  },
});
