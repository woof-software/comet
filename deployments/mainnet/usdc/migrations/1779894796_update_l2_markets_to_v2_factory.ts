import { expect } from 'chai';
import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal, calldata } from '../../../../src/deploy';
import { forkedHreForBase } from '../../../../plugins/scenario/utils/hreForBase';
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
  base: {
    AERO: {
      comet: '0x784efeB622244d2348d4F2522f8860B96fbEcE89',
      newExt: '0x7E5873DD6a92802b280D8d59DEc2aa6Ce0EEB13A',
    },
    USDbC: {
      comet: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
      newExt: '0xD149132Db93C44e0B306493dC3021966167B1b02',
    },
    USDC: {
      comet: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
      newExt: '0x0d4Bd55A755134950027cE1F43190A354e648e20',
    },
    USDS: {
      comet: '0x2c776041CCFe903071AF44aa147368a9c8EEA518',
      newExt: '0xeCB8e46FcEa6339D68fdA37cC3FfBBC6838759Ff',
    },
    WETH: {
      comet: '0x46e6b214b524310239732D51387075E0e70970bf',
      newExt: '0xF3BBe5807feA997d540939Cbf138c134b11e3CF1',
    },
  },
  optimism: {
    USDC: {
      comet: '0x2e44e174f7D53F0212823acC11C01A11d58c5bCB',
      newExt: '0x0d4Bd55A755134950027cE1F43190A354e648e20',
    },
    USDT: {
      comet: '0x995E394b8B2437aC8Ce61Ee0bC610D617962B214',
      newExt: '0x5F5406b32ca3Da65e40978190C88B9809A95c6Ba',
    },
    WETH: {
      comet: '0xE36A30D249f7761327fd973001A32010b521b6Fd',
      newExt: '0xF3BBe5807feA997d540939Cbf138c134b11e3CF1',
    },
  },
  polygon: {
    USDC: {
      comet: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
      newExt: '0x0d4Bd55A755134950027cE1F43190A354e648e20',
    },
    USDT: {
      comet: '0xaeB318360f27748Acb200CE616E389A6C9409a07',
      newExt: '0x5F5406b32ca3Da65e40978190C88B9809A95c6Ba',
    },
  },
  mantle: {
    USDe: {
      comet: '0x606174f62cd968d8e684c645080fa694c1D7786E',
      newExt: '0x63fb5e296b9e7423b9281df31bcdb0282bbeee25',
    },
  },
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
  arbitrum: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
  base: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
  optimism: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
  polygon: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
  mantle: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
  unichain: '0x30beAd17D2641bCc900dc1ABC5d55c88059D176F',
};

export default migration('1779894796_update_l2_markets_to_v2_factory', {
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
      opL1CrossDomainMessenger,
      fxRoot,
      unichainL1CrossDomainMessenger,
      mantleL1CrossDomainMessenger,
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
      arbitrumDm
    );

    const createRetryableTicketGasParams2 = await estimateL2Transaction(
      {
        from: applyL1ToL2Alias(timelock.address),
        to: arbitrumBridgeReceiver.address,
        data: arbitrumProposalDataPart2,
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

    // Optimism
    const optimismHre = await forkedHreForBase({ name: 'optimism-usdc', network: 'optimism', deployment: 'usdc' });
    const optimismDm = await deploymentManager.addBridgedDeploymentManager('optimism', 'usdc', optimismHre);
    const {
      configurator: optimismConfigurator,
      cometAdmin: optimismCometAdmin,
      bridgeReceiver: optimismBridgeReceiver,
    } = await optimismDm.getContracts();

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

    // Polygon
    const polygonHre = await forkedHreForBase({ name: 'polygon-usdc', network: 'polygon', deployment: 'usdc' });
    const polygonDm = await deploymentManager.addBridgedDeploymentManager('polygon', 'usdc', polygonHre);
    const {
      bridgeReceiver: polygonBridgeReceiver,
      configurator: polygonConfigurator,
      cometAdmin: polygonCometAdmin,
    } = await polygonDm.getContracts();

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

    // Mantle
    const mantleHre = await forkedHreForBase({ name: 'mantle-usde', network: 'mantle', deployment: 'usde' });
    const mantleDm = await deploymentManager.addBridgedDeploymentManager('mantle', 'usde', mantleHre);
    const {
      bridgeReceiver: mantleBridgeReceiver,
      configurator: mantleConfigurator,
      cometAdmin: mantleCometAdmin,
    } = await mantleDm.getContracts();

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

    // Unichain
    const unichainHre = await forkedHreForBase({ name: 'unichain-usdc', network: 'unichain', deployment: 'usdc' });
    const unichainDm = await deploymentManager.addBridgedDeploymentManager('unichain', 'usdc', unichainHre);
    const {
      bridgeReceiver: unichainBridgeReceiver,
      configurator: unichainConfigurator,
      cometAdmin: unichainCometAdmin,
    } = await unichainDm.getContracts();

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
          unichainConfigurator.address, unichainConfigurator.address, unichainCometAdmin.address,
          unichainConfigurator.address, unichainConfigurator.address, unichainCometAdmin.address,
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
          setFactoryCalldataUnichainUsdc, setExtensionDelegateCalldataUnichainUsdc, deployAndUpgradeToCalldataUnichainUsdc,
          setFactoryCalldataUnichainWeth, setExtensionDelegateCalldataUnichainWeth, deployAndUpgradeToCalldataUnichainWeth,
        ]
      ]
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
      // 3. Base proposal USDC + USDbC + USDS
      {
        contract: baseL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [baseBridgeReceiver.address, baseProposalDataPart1, 3_000_000]
      },
      // 4. Base proposal AERO + WETH
      {
        contract: baseL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [baseBridgeReceiver.address, baseProposalDataPart2, 3_000_000]
      },
      // 5. Optimism proposal      
      {
        contract: opL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [optimismBridgeReceiver.address, optimismProposalData, 2_500_000]
      },
      // 6. Polygon proposal
      {
        contract: fxRoot,
        signature: 'sendMessageToChild(address,bytes)',
        args: [polygonBridgeReceiver.address, polygonProposalData],
      },
      // 7. Mantle proposal
      {
        contract: mantleL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [mantleBridgeReceiver.address, mantleProposalData, 1_500_000],
      },
      // 8. Unichain proposal
      {
        contract: unichainL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [unichainBridgeReceiver.address, unichainProposalData, 2_000_000],
      },
    ];

    const description = `# Update All L2 Comets to the service patch version

## Proposal summary

WOOF! proposes upgrading next Comet markets:

- Arbitrum: USDC, USDC.e, USDT and WETH
- Base: USDC, USDbC, USDS, AERO and WETH
- Optimism: USDC, USDT and WETH
- Polygon: USDC and USDT
- Mantle: USDe
- Unichain: USDC and WETH

To a new service patch version introducing several improvements and security enhancements:

- Extended Pause Controls: collateral interactions can now be paused independently per collateral asset.
- Price Feed Patch (Post-USDM incident response): skips price feed calls for assets with zero collateral factor, preventing unnecessary reverts.
- Collateral Deactivation Mechanism: introduces a Guardian-controlled emergency mechanism to deactivate unsafe collateral assets, with reactivation requiring a governance proposal.
- Utilization Peaking Protection: caps utilization at 200%, preventing additional borrowing when post-borrow utilization exceeds this threshold, while preserving lender withdrawals.
- Borrow Index Fix (Empty Market): prevents borrow interest accrual in markets without active borrowers.
- Supply Index Fix (Empty Market): ensures supply index only accrues when lenders are present.
- Lender Illiquidity Fix in Zero-Borrow Markets: prevents reserve depletion in markets with no borrowers by capping supply rate to zero when utilization is zero and reserves are exhausted.
- Accrue Interest on Collateral Actions (Post-USDM incident response): collateral actions (supply, withdraw, transfer) now trigger interest accrual for affected accounts.
- Technical Improvements: includes removal of redundant arguments in supplyInternal() and optimized price caching in absorbInternal(), improving gas efficiency without affecting protocol behavior.

This proposal takes the governance steps recommended and necessary to update Compound III markets. Simulations have confirmed the market’s readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario).

Detailed information can be found on the corresponding [proposal pull request](https://github.com/compound-finance/comet/pull/1132).

### Bytecode Repository

This update is done with the use of the bytecode repository, which provides trustless and deterministic deployments.

Further details on the deployment can be found in the [Bytecode Repository git](https://github.com/woof-software/bytecode-repository) and [forum discussion](https://www.comp.xyz/t/rfc-bytecode-repository-and-deployment-pipeline-modernization/6965).

### Audit

Both service patch Comet update and Bytecode Repository have been audited by Certora and full reports can be found here:

- [Certora Comet Service Patch Audit](https://www.certora.com/reports/comet-service-patch)
- [Certora Bytecode Repository Audit](https://www.certora.com/reports/compound-bytecoderepository)

## Proposal Actions

The first action sets the factory to the newly deployed factory, extension delegate to the newly deployed contract and deploys and upgrades Arbitrum USDC and USDC.e Comets to a new version.

The second action sets the factory to the newly deployed factory, extension delegate to the newly deployed contract and deploys and upgrades Arbitrum USDT and WETH Comets to a new version.

The third action sets the factory to the newly deployed factory, extension delegate to the newly deployed contract and deploys and upgrades Base USDC, USDbC and USDS Comets to a new version.

The fourth action sets the factory to the newly deployed factory, extension delegate to the newly deployed contract and deploys and upgrades Base AERO and WETH Comets to a new version.

The fifth action sets the factory to the newly deployed factory, extension delegate to the newly deployed contract and deploys and upgrades Optimism USDC, USDT and WETH Comets to a new version.

The sixth action sets the factory to the newly deployed factory, extension delegate to the newly deployed contract and deploys and upgrades Polygon USDC and USDT Comets to a new version.

The seventh action sets the factory to the newly deployed factory, extension delegate to the newly deployed contract and deploys and upgrades Mantle USDe Comet to a new version.

The eighth action sets the factory to the newly deployed factory, extension delegate to the newly deployed contract and deploys and upgrades Unichain USDC and WETH Comets to a new version.
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
      configurator: arbitrumConfigurator,
    } = await arbitrumDm.getContracts();

    expect(await arbitrumConfigurator.factory(config.arbitrum.USDC.comet)).to.equal(factoryConfig.arbitrum);
    expect(await arbitrumConfigurator.factory(config.arbitrum.USDCe.comet)).to.equal(factoryConfig.arbitrum);
    expect(await arbitrumConfigurator.factory(config.arbitrum.USDT.comet)).to.equal(factoryConfig.arbitrum);
    expect(await arbitrumConfigurator.factory(config.arbitrum.WETH.comet)).to.equal(factoryConfig.arbitrum);

    expect((await arbitrumConfigurator.getConfiguration(config.arbitrum.USDC.comet)).extensionDelegate).to.equal(config.arbitrum.USDC.newExt);
    expect((await arbitrumConfigurator.getConfiguration(config.arbitrum.USDCe.comet)).extensionDelegate).to.equal(config.arbitrum.USDCe.newExt);
    expect((await arbitrumConfigurator.getConfiguration(config.arbitrum.USDT.comet)).extensionDelegate).to.equal(config.arbitrum.USDT.newExt);
    expect((await arbitrumConfigurator.getConfiguration(config.arbitrum.WETH.comet)).extensionDelegate).to.equal(config.arbitrum.WETH.newExt);

    const arbitrumSigner = await arbitrumDm.getSigner();

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

    // Base
    const baseDm = deploymentManager.bridgedDeploymentManagers.get('base:usdc') as DeploymentManager;
    const {
      configurator: baseConfigurator,
    } = await baseDm.getContracts();

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

    const baseSigner = await baseDm.getSigner();

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

    // Optimism
    const optimismDm = deploymentManager.bridgedDeploymentManagers.get('optimism:usdc') as DeploymentManager;
    const {
      configurator: optimismConfigurator,
    } = await optimismDm.getContracts();

    expect(await optimismConfigurator.factory(config.optimism.USDC.comet)).to.equal(factoryConfig.optimism);
    expect(await optimismConfigurator.factory(config.optimism.USDT.comet)).to.equal(factoryConfig.optimism);
    expect(await optimismConfigurator.factory(config.optimism.WETH.comet)).to.equal(factoryConfig.optimism);

    expect((await optimismConfigurator.getConfiguration(config.optimism.USDC.comet)).extensionDelegate).to.equal(config.optimism.USDC.newExt);
    expect((await optimismConfigurator.getConfiguration(config.optimism.USDT.comet)).extensionDelegate).to.equal(config.optimism.USDT.newExt);
    expect((await optimismConfigurator.getConfiguration(config.optimism.WETH.comet)).extensionDelegate).to.equal(config.optimism.WETH.newExt);

    const optimismSigner = await optimismDm.getSigner();

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

    // Polygon
    const polygonDm = deploymentManager.bridgedDeploymentManagers.get('polygon:usdc') as DeploymentManager;
    const {
      configurator: polygonConfigurator,
    } = await polygonDm.getContracts();

    expect(await polygonConfigurator.factory(config.polygon.USDC.comet)).to.equal(factoryConfig.polygon);
    expect(await polygonConfigurator.factory(config.polygon.USDT.comet)).to.equal(factoryConfig.polygon);

    expect((await polygonConfigurator.getConfiguration(config.polygon.USDC.comet)).extensionDelegate).to.equal(config.polygon.USDC.newExt);
    expect((await polygonConfigurator.getConfiguration(config.polygon.USDT.comet)).extensionDelegate).to.equal(config.polygon.USDT.newExt);

    const polygonSigner = await polygonDm.getSigner();

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

    // Mantle
    const mantleDm = deploymentManager.bridgedDeploymentManagers.get('mantle:usde') as DeploymentManager;
    const {
      configurator: mantleConfigurator,
    } = await mantleDm.getContracts();
 
    expect(await mantleConfigurator.factory(config.mantle.USDe.comet)).to.equal(factoryConfig.mantle);
 
    expect((await mantleConfigurator.getConfiguration(config.mantle.USDe.comet)).extensionDelegate).to.equal(config.mantle.USDe.newExt);
 
    const mantleSigner = await mantleDm.getSigner();
 
    const newCometMantleUsde = new Contract(
      config.mantle.USDe.comet, 
      newCometAbi,
      mantleSigner
    );
 
    expect(await newCometMantleUsde.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometMantleUsde.symbol()).to.equal('cUSDev3');
    expect(await newCometMantleUsde.name()).to.equal('Compound USDe');
    expect(await newCometMantleUsde.extensionDelegate()).to.equal(config.mantle.USDe.newExt);

    // Unichain
    const unichainDm = deploymentManager.bridgedDeploymentManagers.get('unichain:usdc') as DeploymentManager;
    const {
      configurator: unichainConfigurator,
    } = await unichainDm.getContracts();
 
    expect(await unichainConfigurator.factory(config.unichain.USDC.comet)).to.equal(factoryConfig.unichain);
    expect(await unichainConfigurator.factory(config.unichain.WETH.comet)).to.equal(factoryConfig.unichain);
 
    expect((await unichainConfigurator.getConfiguration(config.unichain.USDC.comet)).extensionDelegate).to.equal(config.unichain.USDC.newExt);
    expect((await unichainConfigurator.getConfiguration(config.unichain.WETH.comet)).extensionDelegate).to.equal(config.unichain.WETH.newExt);
 
    const unichainSigner = await unichainDm.getSigner();
 
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
