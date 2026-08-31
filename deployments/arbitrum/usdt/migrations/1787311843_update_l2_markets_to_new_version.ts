import { expect } from 'chai';
import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';
import { applyL1ToL2Alias, estimateL2Transaction } from '../../../../scenario/utils/arbitrumUtils';

const config = {
  arbitrum: {
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

const arbitrumUsdcComet = '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf';

async function getImplementationCode(dm: DeploymentManager, cometAddress: string): Promise<string> {
  const { cometAdmin } = await dm.getContracts();
  const implementationAddress = await cometAdmin.getProxyImplementation(cometAddress);
  return dm.hre.ethers.provider.getCode(implementationAddress);
}

async function getMaskedImplementationCode(dm: DeploymentManager, cometAddress: string): Promise<string> {
  const code = await getImplementationCode(dm, cometAddress);
  const buildInfo = await dm.hre.artifacts.getBuildInfo('contracts/CometWithExtendedAssetList.sol:CometWithExtendedAssetList');
  if (!buildInfo) throw new Error('Missing build info for CometWithExtendedAssetList');
  const { immutableReferences } = buildInfo.output.contracts['contracts/CometWithExtendedAssetList.sol']['CometWithExtendedAssetList'].evm.deployedBytecode;

  const bytes = utils.arrayify(code);
  for (const refs of Object.values(immutableReferences || {}) as { start: number, length: number }[][]) {
    for (const { start, length } of refs) {
      bytes.fill(0, start, start + length);
    }
  }

  const metadataLength = (bytes[bytes.length - 2] << 8) + bytes[bytes.length - 1];
  return utils.hexlify(bytes.slice(0, bytes.length - metadataLength - 2));
}

let preMigrationImplementationCodeHash: { USDT: string, WETH: string };

export default migration('1787311843_update_l2_markets_to_new_version', {
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

    // USDT and WETH
    const deployAndUpgradeToCalldataArbitrumUsdt = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [arbitrumConfigurator.address, config.arbitrum.USDT.comet]
    );

    const deployAndUpgradeToCalldataArbitrumWeth = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [arbitrumConfigurator.address, config.arbitrum.WETH.comet]
    );

    const arbitrumProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          arbitrumCometAdmin.address,
          arbitrumCometAdmin.address
        ],
        [
          0, 0
        ],
        [
          'deployAndUpgradeTo(address,address)',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          deployAndUpgradeToCalldataArbitrumUsdt,
          deployAndUpgradeToCalldataArbitrumWeth
        ]
      ]
    );

    const createRetryableTicketGasParams = await estimateL2Transaction(
      {
        from: applyL1ToL2Alias(timelock.address),
        to: arbitrumBridgeReceiver.address,
        data: arbitrumProposalData,
      },
      deploymentManager
    );

    preMigrationImplementationCodeHash = {
      USDT: utils.keccak256(await getImplementationCode(deploymentManager, config.arbitrum.USDT.comet)),
      WETH: utils.keccak256(await getImplementationCode(deploymentManager, config.arbitrum.WETH.comet)),
    };

    const mainnetActions = [
      // 1. Arbitrum proposal
      {
        contract: arbitrumInbox,
        signature: 'createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)',
        args: [
          arbitrumBridgeReceiver.address,                   // address to,
          0,                                                // uint256 l2CallValue,
          createRetryableTicketGasParams.maxSubmissionCost, // uint256 maxSubmissionCost,
          arbitrumTimelock.address,                         // address excessFeeRefundAddress,
          arbitrumTimelock.address,                         // address callValueRefundAddress,
          createRetryableTicketGasParams.gasLimit,          // uint256 gasLimit,
          createRetryableTicketGasParams.maxFeePerGas*2,    // uint256 maxFeePerGas,
          arbitrumProposalData                              // bytes calldata data
        ],
        value: createRetryableTicketGasParams.deposit.mul(2),
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

    expect(await arbitrumConfigurator.factory(config.arbitrum.USDT.comet)).to.equal(factoryConfig.arbitrum);
    expect(await arbitrumConfigurator.factory(config.arbitrum.WETH.comet)).to.equal(factoryConfig.arbitrum);

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

    const newCometArbitrumUsdt = new Contract(
      config.arbitrum.USDT.comet, 
      newCometAbi,
      arbitrumSigner
    );

    expect(await newCometArbitrumUsdt.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometArbitrumUsdt.symbol()).to.equal('cUSDTv3');
    expect(await newCometArbitrumUsdt.name()).to.equal('Compound USDT');
    expect(await newCometArbitrumUsdt.extensionDelegate()).to.equal(config.arbitrum.USDT.newExt);
    expect(utils.keccak256(await getImplementationCode(deploymentManager, config.arbitrum.USDT.comet))).to.not.equal(preMigrationImplementationCodeHash.USDT);
    expect(await getMaskedImplementationCode(deploymentManager, config.arbitrum.USDT.comet)).to.equal(await getMaskedImplementationCode(deploymentManager, arbitrumUsdcComet));

    const newCometArbitrumWeth = new Contract(
      config.arbitrum.WETH.comet, 
      newCometAbi,
      arbitrumSigner
    );

    expect(await newCometArbitrumWeth.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometArbitrumWeth.symbol()).to.equal('cWETHv3');
    expect(await newCometArbitrumWeth.name()).to.equal('Compound WETH');
    expect(await newCometArbitrumWeth.extensionDelegate()).to.equal(config.arbitrum.WETH.newExt);
    expect(utils.keccak256(await getImplementationCode(deploymentManager, config.arbitrum.WETH.comet))).to.not.equal(preMigrationImplementationCodeHash.WETH);
    expect(await getMaskedImplementationCode(deploymentManager, config.arbitrum.WETH.comet)).to.equal(await getMaskedImplementationCode(deploymentManager, arbitrumUsdcComet));
  },
});
