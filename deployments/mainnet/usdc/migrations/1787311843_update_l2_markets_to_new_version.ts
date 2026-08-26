import { expect } from 'chai';
import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';
import { forkedHreForBase } from '../../../../plugins/scenario/utils/hreForBase';
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
  arbitrum: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
  base: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
};

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

let preMigrationImplementationCodeHash: {
  arbitrum: { USDT: string, WETH: string };
  base: { AERO: string, WETH: string };
};

export default migration('1787311843_update_l2_markets_to_new_version', {
  async prepare() {    
    return {};
  },

  async enact(deploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      timelock,
      governor,
      arbitrumInbox,
      baseL1CrossDomainMessenger,
    } = await deploymentManager.getContracts();

    // Arbitrum
    const arbitrumHre = await forkedHreForBase({ name: 'arbitrum-usdc', network: 'arbitrum', deployment: 'usdc' });
    const arbitrumDm = await deploymentManager.addBridgedDeploymentManager('arbitrum', 'usdc', arbitrumHre);
    const {
      bridgeReceiver: arbitrumBridgeReceiver,
      configurator: arbitrumConfigurator,
      cometAdmin: arbitrumCometAdmin,
      timelock: arbitrumTimelock,
    } = await arbitrumDm.getContracts();

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
      arbitrumDm
    );

    // Base
    const baseHre = await forkedHreForBase({ name: 'base-usdc', network: 'base', deployment: 'usdc' });
    const baseDmUsdc = await deploymentManager.addBridgedDeploymentManager('base', 'usdc', baseHre);
    const {
      bridgeReceiver : baseBridgeReceiver,
      configurator: baseConfigurator,
      cometAdmin: baseCometAdmin,
    } = await baseDmUsdc.getContracts();

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

    preMigrationImplementationCodeHash = {
      arbitrum: {
        USDT: utils.keccak256(await getImplementationCode(arbitrumDm, config.arbitrum.USDT.comet)),
        WETH: utils.keccak256(await getImplementationCode(arbitrumDm, config.arbitrum.WETH.comet)),
      },
      base: {
        AERO: utils.keccak256(await getImplementationCode(baseDmUsdc, config.base.AERO.comet)),
        WETH: utils.keccak256(await getImplementationCode(baseDmUsdc, config.base.WETH.comet)),
      },
    };

    const mainnetActions = [
      // 1. Arbitrum proposal USDT + WETH
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
          arbitrumProposalData,                             // bytes calldata data
        ],
        value: createRetryableTicketGasParams.deposit.mul(2),
      },
      // 2. Base proposal AERO + WETH
      {
        contract: baseL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [baseBridgeReceiver.address, baseProposalData, 3_000_000]
      },
    ];

    const description = `# Complete Arbitrum and Base Comet Upgrade

## Summary

This is a follow-up to [Proposal 596](https://www.tally.xyz/gov/compound/proposal/596), which upgraded Comets on Arbitrum and Base to v1.2.1. That upgrade was split per network into a sub-proposal that bumped the Comet Factory's version to 1.2.1 and a sub-proposal that redeploys each Comet from that same factory.

The execution automation ran these out of order, so the redeploy step for four Comets ran before the factory's version was bumped, deploying the prior version instead:

- Arbitrum cUSDTv3 ('0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07')
- Arbitrum cWETHv3 ('0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486')
- Base cAEROv3 ('0x784efeB622244d2348d4F2522f8860B96fbEcE89')
- Base cWETHv3 ('0x46e6b214b524310239732D51387075E0e70970bf')

These four are now on an earlier Service Patch release rather than v1.2.1. That patch predates v1.2.1 and does not include the auditor-identified fix for under-paying suppliers when a market has no borrowers, but since all those markets are live there is no impact on current functionality or funds. All other Comets from Proposal 596 upgraded correctly and are unaffected.

The Comet Factory is already at v1.2.1, so this proposal just re-runs 'deployAndUpgradeTo' for the four Comets to finish the upgrade.

## Proposal Actions

The first action sends a cross-chain message to Arbitrum calling 'deployAndUpgradeTo' for cUSDTv3 and cWETHv3.

The second action sends a cross-chain message to Base calling 'deployAndUpgradeTo' for cAEROv3 and cWETHv3.
`;
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

    // Arbitrum
    const arbitrumDm = deploymentManager.bridgedDeploymentManagers.get('arbitrum:usdc') as DeploymentManager;
    const {
      comet: arbitrumUsdcComet,
      configurator: arbitrumConfigurator,
    } = await arbitrumDm.getContracts();

    expect(await arbitrumConfigurator.factory(config.arbitrum.USDT.comet)).to.equal(factoryConfig.arbitrum);
    expect(await arbitrumConfigurator.factory(config.arbitrum.WETH.comet)).to.equal(factoryConfig.arbitrum);

    expect((await arbitrumConfigurator.getConfiguration(config.arbitrum.USDT.comet)).extensionDelegate).to.equal(config.arbitrum.USDT.newExt);
    expect((await arbitrumConfigurator.getConfiguration(config.arbitrum.WETH.comet)).extensionDelegate).to.equal(config.arbitrum.WETH.newExt);

    const arbitrumSigner = await arbitrumDm.getSigner();

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
    expect(utils.keccak256(await getImplementationCode(arbitrumDm, config.arbitrum.USDT.comet))).to.not.equal(preMigrationImplementationCodeHash.arbitrum.USDT);
    expect(await getMaskedImplementationCode(arbitrumDm, config.arbitrum.USDT.comet)).to.equal(await getMaskedImplementationCode(arbitrumDm, arbitrumUsdcComet.address));

    const newCometArbitrumWeth = new Contract(
      config.arbitrum.WETH.comet, 
      newCometAbi,
      arbitrumSigner
    );

    expect(await newCometArbitrumWeth.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometArbitrumWeth.symbol()).to.equal('cWETHv3');
    expect(await newCometArbitrumWeth.name()).to.equal('Compound WETH');
    expect(await newCometArbitrumWeth.extensionDelegate()).to.equal(config.arbitrum.WETH.newExt);
    expect(utils.keccak256(await getImplementationCode(arbitrumDm, config.arbitrum.WETH.comet))).to.not.equal(preMigrationImplementationCodeHash.arbitrum.WETH);
    expect(await getMaskedImplementationCode(arbitrumDm, config.arbitrum.WETH.comet)).to.equal(await getMaskedImplementationCode(arbitrumDm, arbitrumUsdcComet.address));

    // Base
    const baseDm = deploymentManager.bridgedDeploymentManagers.get('base:usdc') as DeploymentManager;
    const {
      comet: baseUsdcComet,
      configurator: baseConfigurator,
    } = await baseDm.getContracts();

    expect(await baseConfigurator.factory(config.base.AERO.comet)).to.equal(factoryConfig.base);
    expect(await baseConfigurator.factory(config.base.WETH.comet)).to.equal(factoryConfig.base);

    expect((await baseConfigurator.getConfiguration(config.base.AERO.comet)).extensionDelegate).to.equal(config.base.AERO.newExt);
    expect((await baseConfigurator.getConfiguration(config.base.WETH.comet)).extensionDelegate).to.equal(config.base.WETH.newExt);

    const baseSigner = await baseDm.getSigner();

    const baseCometFactoryV2 = new Contract(
      factoryConfig.base,
      [
        'function version() view returns ((uint64,uint64,uint64),string)',
      ],
      baseSigner
    );

    const [baseVersion, baseAlternative] = await baseCometFactoryV2.version();
    expect(baseVersion).to.deep.equal([1, 2, 1]);
    expect(baseAlternative).to.equal('');

    const newCometBaseAero = new Contract(
      config.base.AERO.comet, 
      newCometAbi,
      baseSigner
    );

    expect(await newCometBaseAero.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometBaseAero.symbol()).to.equal('cAEROv3');
    expect(await newCometBaseAero.name()).to.equal('Compound AERO');
    expect(await newCometBaseAero.extensionDelegate()).to.equal(config.base.AERO.newExt);
    expect(utils.keccak256(await getImplementationCode(baseDm, config.base.AERO.comet))).to.not.equal(preMigrationImplementationCodeHash.base.AERO);
    expect(await getMaskedImplementationCode(baseDm, config.base.AERO.comet)).to.equal(await getMaskedImplementationCode(baseDm, baseUsdcComet.address));

    const newCometBaseWeth = new Contract(
      config.base.WETH.comet, 
      newCometAbi,
      baseSigner
    );

    expect(await newCometBaseWeth.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometBaseWeth.symbol()).to.equal('cWETHv3');
    expect(await newCometBaseWeth.name()).to.equal('Compound WETH');
    expect(await newCometBaseWeth.extensionDelegate()).to.equal(config.base.WETH.newExt);
    expect(utils.keccak256(await getImplementationCode(baseDm, config.base.WETH.comet))).to.not.equal(preMigrationImplementationCodeHash.base.WETH);
    expect(await getMaskedImplementationCode(baseDm, config.base.WETH.comet)).to.equal(await getMaskedImplementationCode(baseDm, baseUsdcComet.address));
  },
});
