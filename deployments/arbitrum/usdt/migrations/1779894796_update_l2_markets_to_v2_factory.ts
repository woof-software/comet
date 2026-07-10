import { expect } from 'chai';
import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal, calldata } from '../../../../src/deploy';
import { applyL1ToL2Alias, estimateL2Transaction } from '../../../../scenario/utils/arbitrumUtils';

const config = {
  arbitrum: {
    USDC: {
      comet: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
      newExt: '0x0d4Bd55A755134950027cE1F43190A354e648e20',
    },
    USDCe: {
      comet: '0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA',
      newExt: '0xb971973b595C43cb59492dd0ec9b56c648daea33',
    },
    USDT: {
      comet: '0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07',
      newExt: '0x5F5406b32ca3Da65e40978190C88B9809A95c6Ba',
    },
    WETH: {
      comet: '0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486',
      newExt: '0xF3BBe5807feA997d540939Cbf138c134b11e3CF1',
    },
  },
};

const factoryConfig = {
  arbitrum: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
};

const desiredVersion = {
  version: [1, 2, 1],
  alternative: ''
};

export default migration('1779894796_update_l2_markets_to_v2_factory', {
  async prepare() {    
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager): Promise<void> {
    const trace = deploymentManager.tracer();

    const {
      timelock,
      governor,
      arbitrumInbox,
    } = await govDeploymentManager.getContracts();

    // Arbitrum
    const {
      bridgeReceiver: arbitrumBridgeReceiver,
      configurator: arbitrumConfigurator,
      cometAdmin: arbitrumCometAdmin,
      timelock: arbitrumTimelock,
    } = await deploymentManager.getContracts();

    const arbitrumFactoryV2 = new Contract(
      factoryConfig.arbitrum,
      [
        'function setVersion(((uint64,uint64,uint64) version, string alternative))',
      ],
      await deploymentManager.getSigner()
    );
    const setVersionCalldataArbitrum = await calldata(
      arbitrumFactoryV2.populateTransaction.setVersion(desiredVersion)
    );

    // USDC and USDCe
    const setFactoryCalldataArbitrumUsdc = await calldata(
      arbitrumConfigurator.populateTransaction.setFactory(config.arbitrum.USDC.comet, factoryConfig.arbitrum)
    );
    const setExtensionDelegateCalldataArbitrumUsdc = await calldata(
      arbitrumConfigurator.populateTransaction.setExtensionDelegate(config.arbitrum.USDC.comet, config.arbitrum.USDC.newExt)
    );
    const deployAndUpgradeToCalldataArbitrumUsdc = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [arbitrumConfigurator.address, config.arbitrum.USDC.comet]
    );

    const setFactoryCalldataArbitrumUsdcE = await calldata(
      arbitrumConfigurator.populateTransaction.setFactory(config.arbitrum.USDCe.comet, factoryConfig.arbitrum)
    );
    const setExtensionDelegateCalldataArbitrumUsdcE = await calldata(
      arbitrumConfigurator.populateTransaction.setExtensionDelegate(config.arbitrum.USDCe.comet, config.arbitrum.USDCe.newExt)
    );
    const deployAndUpgradeToCalldataArbitrumUsdcE = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [arbitrumConfigurator.address, config.arbitrum.USDCe.comet]
    );

    const arbitrumProposalDataPart1 = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          factoryConfig.arbitrum,
          arbitrumConfigurator.address, arbitrumConfigurator.address, arbitrumCometAdmin.address,
          arbitrumConfigurator.address, arbitrumConfigurator.address, arbitrumCometAdmin.address
        ],
        [
          0,
          0, 0, 0,
          0, 0, 0
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
          setVersionCalldataArbitrum,
          setFactoryCalldataArbitrumUsdc, setExtensionDelegateCalldataArbitrumUsdc, deployAndUpgradeToCalldataArbitrumUsdc,
          setFactoryCalldataArbitrumUsdcE, setExtensionDelegateCalldataArbitrumUsdcE, deployAndUpgradeToCalldataArbitrumUsdcE
        ]
      ]
    );

    // USDT and WETH
    const setFactoryCalldataArbitrumUsdt = await calldata(
      arbitrumConfigurator.populateTransaction.setFactory(config.arbitrum.USDT.comet, factoryConfig.arbitrum)
    );
    const setExtensionDelegateCalldataArbitrumUsdt = await calldata(
      arbitrumConfigurator.populateTransaction.setExtensionDelegate(config.arbitrum.USDT.comet, config.arbitrum.USDT.newExt)
    );
    const deployAndUpgradeToCalldataArbitrumUsdt = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [arbitrumConfigurator.address, config.arbitrum.USDT.comet]
    );

    const setFactoryCalldataArbitrumWeth = await calldata(
      arbitrumConfigurator.populateTransaction.setFactory(config.arbitrum.WETH.comet, factoryConfig.arbitrum)
    );
    const setExtensionDelegateCalldataArbitrumWeth = await calldata(
      arbitrumConfigurator.populateTransaction.setExtensionDelegate(config.arbitrum.WETH.comet, config.arbitrum.WETH.newExt)
    );
    const deployAndUpgradeToCalldataArbitrumWeth = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [arbitrumConfigurator.address, config.arbitrum.WETH.comet]
    );

    const arbitrumProposalDataPart2 = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          arbitrumConfigurator.address, arbitrumConfigurator.address, arbitrumCometAdmin.address,
          arbitrumConfigurator.address, arbitrumConfigurator.address, arbitrumCometAdmin.address
        ],
        [
          0, 0, 0,
          0, 0, 0
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
          setFactoryCalldataArbitrumUsdt, setExtensionDelegateCalldataArbitrumUsdt, deployAndUpgradeToCalldataArbitrumUsdt,
          setFactoryCalldataArbitrumWeth, setExtensionDelegateCalldataArbitrumWeth, deployAndUpgradeToCalldataArbitrumWeth
        ]
      ]
    );

    const createRetryableTicketGasParams1 = await estimateL2Transaction(
      {
        from: applyL1ToL2Alias(timelock.address),
        to: arbitrumBridgeReceiver.address,
        data: arbitrumProposalDataPart1,
      },
      deploymentManager
    );

    const createRetryableTicketGasParams2 = await estimateL2Transaction(
      {
        from: applyL1ToL2Alias(timelock.address),
        to: arbitrumBridgeReceiver.address,
        data: arbitrumProposalDataPart2,
      },
      deploymentManager
    );

    const mainnetActions = [
      // 1. Arbitrum proposal USDC + USDC.e
      {
        contract: arbitrumInbox,
        signature: 'createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)',
        args: [
          arbitrumBridgeReceiver.address,                   // address to,
          0,                                                // uint256 l2CallValue,
          createRetryableTicketGasParams1.maxSubmissionCost, // uint256 maxSubmissionCost,
          arbitrumTimelock.address,                         // address excessFeeRefundAddress,
          arbitrumTimelock.address,                         // address callValueRefundAddress,
          createRetryableTicketGasParams1.gasLimit,          // uint256 gasLimit,
          createRetryableTicketGasParams1.maxFeePerGas*2,    // uint256 maxFeePerGas,
          arbitrumProposalDataPart1                             // bytes calldata data
        ],
        value: createRetryableTicketGasParams1.deposit.mul(2),
      },
      // 2. Arbitrum proposal USDT + WETH
      {
        contract: arbitrumInbox,
        signature: 'createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)',
        args: [
          arbitrumBridgeReceiver.address,                   // address to,
          0,                                                // uint256 l2CallValue,
          createRetryableTicketGasParams2.maxSubmissionCost, // uint256 maxSubmissionCost,
          arbitrumTimelock.address,                         // address excessFeeRefundAddress,
          arbitrumTimelock.address,                         // address callValueRefundAddress,
          createRetryableTicketGasParams2.gasLimit,          // uint256 gasLimit,
          createRetryableTicketGasParams2.maxFeePerGas*2,    // uint256 maxFeePerGas,
          arbitrumProposalDataPart2,                             // bytes calldata data
        ],
        value: createRetryableTicketGasParams2.deposit.mul(2),
      },
    ];

    const description = `DESCRIPTION`;
    const txn = await govDeploymentManager.retry(async () =>
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
    // Arbitrum
    const {
      configurator: arbitrumConfigurator,
    } = await deploymentManager.getContracts();

    expect(await arbitrumConfigurator.factory(config.arbitrum.USDC.comet)).to.equal(factoryConfig.arbitrum);
    expect(await arbitrumConfigurator.factory(config.arbitrum.USDCe.comet)).to.equal(factoryConfig.arbitrum);
    expect(await arbitrumConfigurator.factory(config.arbitrum.USDT.comet)).to.equal(factoryConfig.arbitrum);
    expect(await arbitrumConfigurator.factory(config.arbitrum.WETH.comet)).to.equal(factoryConfig.arbitrum);

    expect((await arbitrumConfigurator.getConfiguration(config.arbitrum.USDC.comet)).extensionDelegate).to.equal(config.arbitrum.USDC.newExt);
    expect((await arbitrumConfigurator.getConfiguration(config.arbitrum.USDCe.comet)).extensionDelegate).to.equal(config.arbitrum.USDCe.newExt);
    expect((await arbitrumConfigurator.getConfiguration(config.arbitrum.USDT.comet)).extensionDelegate).to.equal(config.arbitrum.USDT.newExt);
    expect((await arbitrumConfigurator.getConfiguration(config.arbitrum.WETH.comet)).extensionDelegate).to.equal(config.arbitrum.WETH.newExt);

    const expectedMaxUtilization = exp(2, 18);
    const arbitrumSigner = await deploymentManager.getSigner();

    const arbitrumCometFactoryV2 = new Contract(
      factoryConfig.arbitrum,
      [
        'function version() view returns ((uint64,uint64,uint64),string)',
      ],
      arbitrumSigner
    );

    const [version, alternative] = await arbitrumCometFactoryV2.version();
    expect(version).to.deep.equal([1, 2, 1]);
    expect(alternative).to.equal('');

    const newCometArbitrumUsdc = new Contract(
      config.arbitrum.USDC.comet, 
      newCometAbi,
      arbitrumSigner
    );

    expect(await newCometArbitrumUsdc.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometArbitrumUsdc.symbol()).to.equal('cUSDCv3');
    expect(await newCometArbitrumUsdc.name()).to.equal('Compound USDC');
    expect(await newCometArbitrumUsdc.extensionDelegate()).to.equal(config.arbitrum.USDC.newExt);

    const newCometArbitrumUsdcE = new Contract(
      config.arbitrum.USDCe.comet, 
      newCometAbi,
      arbitrumSigner
    );

    expect(await newCometArbitrumUsdcE.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometArbitrumUsdcE.symbol()).to.equal('cUSDCev3');
    expect(await newCometArbitrumUsdcE.name()).to.equal('Compound USDCe');
    expect(await newCometArbitrumUsdcE.extensionDelegate()).to.equal(config.arbitrum.USDCe.newExt);

    const newCometArbitrumUsdt = new Contract(
      config.arbitrum.USDT.comet, 
      newCometAbi,
      arbitrumSigner
    );

    expect(await newCometArbitrumUsdt.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometArbitrumUsdt.symbol()).to.equal('cUSDTv3');
    expect(await newCometArbitrumUsdt.name()).to.equal('Compound USDT');
    expect(await newCometArbitrumUsdt.extensionDelegate()).to.equal(config.arbitrum.USDT.newExt);

    const newCometArbitrumWeth = new Contract(
      config.arbitrum.WETH.comet, 
      newCometAbi,
      arbitrumSigner
    );

    expect(await newCometArbitrumWeth.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometArbitrumWeth.symbol()).to.equal('cWETHv3');
    expect(await newCometArbitrumWeth.name()).to.equal('Compound WETH');
    expect(await newCometArbitrumWeth.extensionDelegate()).to.equal(config.arbitrum.WETH.newExt);
  },
});
