
import { ethers } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { calldata, exp, getConfigurationStruct, proposal } from '../../../../src/deploy';
import { expect } from 'chai';
import { applyL1ToL2Alias, estimateL2Transaction, estimateTokenBridge } from '../../../../scenario/utils/arbitrumUtils';
import { diffState, getCometConfig, } from '../../../../plugins/deployment_manager/DiffState';

const ENSName = 'compound-community-licenses.eth';
const ENSResolverAddress = '0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41';
const ENSRegistryAddress = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const ENSSubdomainLabel = 'v3-additional-grants';
const ENSSubdomain = `${ENSSubdomainLabel}.${ENSName}`;
const ENSTextRecordKey = 'v3-official-markets';

const USDSAmountToBridge = exp(50_000, 18);
const arbitrumCOMPAddress = '0x354A6dA3fcde098F8389cad84b0182725c6C91dE';
// const mainnetUSDTAddress = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const mainnetUSDSAddress = '0xdC035D45d973E3EC169d2276DDab16f1e407384F';
const cDAIAddress = '0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643';
const DaiToUsdsConverterAddress = '0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A';
const DAIAddress = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

export default migration('1740739024_configurate_and_end', {
  async prepare() {
    return {};
  },

  enact: async (deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) => {
    const trace = deploymentManager.tracer();
    const { utils } = ethers;

    const {
      bridgeReceiver,
      timelock: l2Timelock,
      comet,
      cometAdmin,
      configurator,
      rewards,
    } = await deploymentManager.getContracts();

    const {
      arbitrumInbox,
      arbitrumUSDSGateway,
      timelock,
      governor,
    } = await govDeploymentManager.getContracts();
    const _cometFactory = await deploymentManager.fromDep('cometFactory', 'arbitrum', 'usdc.e');

    const newFactoryAddress = _cometFactory.address;

    const refundAddress = l2Timelock.address;

    // const usdsGasParams = await estimateTokenBridge(
    //   {
    //     token: mainnetUSDTAddress,
    //     from: timelock.address,
    //     to: comet.address,
    //     amount: exp(50_000, 6)
    //   },
    //   govDeploymentManager,
    //   deploymentManager
    // );

    const configuration = await getConfigurationStruct(deploymentManager);
    const setFactoryCalldata = await calldata(
      configurator.populateTransaction.setFactory(comet.address, newFactoryAddress)
    );
    const setConfigurationCalldata = await calldata(
      configurator.populateTransaction.setConfiguration(comet.address, configuration)
    );
    const deployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [configurator.address, comet.address]
    );

    const setRewardConfigCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [comet.address, arbitrumCOMPAddress]
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [configurator.address, configurator.address, cometAdmin.address, rewards.address],
        [0, 0, 0, 0],
        [
          'setFactory(address,address)',
          'setConfiguration(address,(address,address,address,address,address,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint104,uint104,uint104,(address,address,uint8,uint64,uint64,uint64,uint128)[]))',
          'deployAndUpgradeTo(address,address)',
          'setRewardConfig(address,address)'
        ],
        [
          setFactoryCalldata,
          setConfigurationCalldata,
          deployAndUpgradeToCalldata,
          setRewardConfigCalldata
        ]
      ]
    );

    const ENSResolver = await govDeploymentManager.existing('ENSResolver', ENSResolverAddress);
    const subdomainHash = ethers.utils.namehash(ENSSubdomain);
    const ArbitrumChainId = 42161 ;
    const newMarketObject = { baseSymbol: 'USDS', cometAddress: comet.address };
    const officialMarketsJSON = JSON.parse(await ENSResolver.text(subdomainHash, ENSTextRecordKey));

    if (officialMarketsJSON[ArbitrumChainId]) {
      officialMarketsJSON[ArbitrumChainId].push(newMarketObject);
    } else {
      officialMarketsJSON[ArbitrumChainId] = [newMarketObject];
    }

    const createRetryableTicketGasParams = await estimateL2Transaction(
      {
        from: applyL1ToL2Alias(timelock.address),
        to: bridgeReceiver.address,
        data: l2ProposalData
      },
      deploymentManager
    );

    const _reduceReservesCalldata = utils.defaultAbiCoder.encode(
      ['uint256'],
      [USDSAmountToBridge]
    );

    const approveDaiCalldata = utils.defaultAbiCoder.encode(
      ['address', 'uint256'],
      [DaiToUsdsConverterAddress, USDSAmountToBridge]
    );

    const convertCalldata = utils.defaultAbiCoder.encode(
      ['address', 'uint256'],
      [timelock.address, USDSAmountToBridge]
    );

    const approveUSDSCalldata = utils.defaultAbiCoder.encode(
      ['address', 'uint256'],
      [arbitrumUSDSGateway.address, USDSAmountToBridge]
    );

    const outboundTransferCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint256', 'uint256', 'uint256', 'bytes'],
      [
        mainnetUSDSAddress,
        comet.address,
        USDSAmountToBridge,
        459510,
        500000000,
        utils.defaultAbiCoder.encode(
          ['uint256', 'bytes'],
          [668810000000000, '0x']
        )
      ]
    );

    const mainnetActions = [
      // 1. Set Comet configuration and deployAndUpgradeTo new Comet on Arbitrum.
      {
        contract: arbitrumInbox,
        signature: 'createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)',
        args: [
          bridgeReceiver.address,                           // address to,
          0,                                                // uint256 l2CallValue,
          createRetryableTicketGasParams.maxSubmissionCost, // uint256 maxSubmissionCost,
          refundAddress,                                    // address excessFeeRefundAddress,
          refundAddress,                                    // address callValueRefundAddress,
          createRetryableTicketGasParams.gasLimit,          // uint256 gasLimit,
          createRetryableTicketGasParams.maxFeePerGas,      // uint256 maxFeePerGas,
          l2ProposalData,                                   // bytes calldata data
        ],
        value: createRetryableTicketGasParams.deposit
      },      
      // 2. Get DAI reserves from cDAI contract
      {
        target: cDAIAddress,
        signature: '_reduceReserves(uint256)',
        calldata: _reduceReservesCalldata
      },
      // 3. Approve DAI to the converter
      {
        target: DAIAddress,
        signature: 'approve(address,uint256)',
        calldata: approveDaiCalldata,
      },
      // 4. Convert DAI to USDS
      {
        target: DaiToUsdsConverterAddress,
        signature: 'daiToUsds(address,uint256)',
        calldata: convertCalldata
      },
      // 5. Approve the USDS gateway to take Timelock's USDS for bridging
      {
        target: mainnetUSDSAddress,
        signature: 'approve(address,uint256)',
        calldata: approveUSDSCalldata
      },
      // 6. Bridge USDS from mainnet to Arbitrum Comet
      {
        target: arbitrumUSDSGateway.address,
        signature: 'outboundTransfer(address,address,uint256,uint256,uint256,bytes)',
        calldata: outboundTransferCalldata,
        value: 898565000000000
      },
      // 7. Update the list of official markets
      {
        target: ENSResolverAddress,
        signature: 'setText(bytes32,string,string)',
        calldata: ethers.utils.defaultAbiCoder.encode(
          ['bytes32', 'string', 'string'],
          [subdomainHash, ENSTextRecordKey, JSON.stringify(officialMarketsJSON)]
        )
      }
    ];

    const description = 'DESCRIPTION';
    const txn = await govDeploymentManager.retry(async () =>
      trace(await governor.propose(...(await proposal(mainnetActions, description))))
    );

    const event = txn.events.find(event => event.event === 'ProposalCreated');
    const [proposalId] = event.args;

    trace(`Created proposal ${proposalId}.`);
  },

  async enacted(): Promise<boolean> {
    return false;
  },

  async verify(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager, preMigrationBlockNumber: number) {

    const {
      comet,
    } = await deploymentManager.getContracts();

    const {
      timelock
    } = await govDeploymentManager.getContracts();

    
    // 1.
    // const stateChanges = await diffState(
    //   comet,
    //   getCometConfig,
    //   preMigrationBlockNumber
    // );
    // expect(stateChanges).to.deep.equal({
    //   ARB: {
    //     supplyCap: exp(3000, 18)
    //   },
    //   WETH: {
    //     supplyCap: exp(2800, 18)
    //   },
    //   FBTC: {
    //     supplyCap: exp(120, 8)
    //   },
    //   baseTrackingSupplySpeed: exp(4 / 86400, 15, 18), // 46296296296
    //   baseTrackingBorrowSpeed: exp(4 / 86400, 15, 18), // 46296296296
    // });

    expect(await comet.pauseGuardian()).to.be.eq('0x78E6317DD6D43DdbDa00Dce32C2CbaFc99361a9d');

    // 2. & 3. & 4. & 5.
    expect(await comet.getReserves()).to.be.equal(USDSAmountToBridge);

    // 6.
    const ENSResolver = await govDeploymentManager.existing('ENSResolver', ENSResolverAddress);
    const ENSRegistry = await govDeploymentManager.existing('ENSRegistry', ENSRegistryAddress);
    const subdomainHash = ethers.utils.namehash(ENSSubdomain);
    const officialMarketsJSON = await ENSResolver.text(subdomainHash, ENSTextRecordKey);
    const officialMarkets = JSON.parse(officialMarketsJSON);
    expect(await ENSRegistry.recordExists(subdomainHash)).to.be.equal(true);
    expect(await ENSRegistry.owner(subdomainHash)).to.be.equal(timelock.address);
    expect(await ENSRegistry.resolver(subdomainHash)).to.be.equal(ENSResolverAddress);
    expect(await ENSRegistry.ttl(subdomainHash)).to.be.equal(0);
    expect(officialMarkets).to.deep.equal({
      1: [
        {
          baseSymbol: 'USDC',
          cometAddress: '0xc3d688B66703497DAA19211EEdff47f25384cdc3'
        },
        {
          baseSymbol: 'WETH',
          cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94'
        },
        {
          baseSymbol: 'USDT',
          cometAddress: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840'
        },
        {
          baseSymbol: 'wstETH',
          cometAddress: '0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3'
        },
        {
          baseSymbol: 'USDS',
          cometAddress: '0x5D409e56D886231aDAf00c8775665AD0f9897b56'
        }
      ],
      10: [
        {
          baseSymbol: 'USDC',
          cometAddress: '0x2e44e174f7D53F0212823acC11C01A11d58c5bCB'
        },
        {
          baseSymbol: 'USDT',
          cometAddress: '0x995E394b8B2437aC8Ce61Ee0bC610D617962B214'
        },
        {
          baseSymbol: 'WETH',
          cometAddress: '0xE36A30D249f7761327fd973001A32010b521b6Fd'
        }
      ],
      137: [
        {
          baseSymbol: 'USDC',
          cometAddress: '0xF25212E676D1F7F89Cd72fFEe66158f541246445'
        },
        {
          baseSymbol: 'USDT',
          cometAddress: '0xaeB318360f27748Acb200CE616E389A6C9409a07'
        }
      ],
      5000: [
        {
          baseSymbol: 'USDe',
          cometAddress: '0x606174f62cd968d8e684c645080fa694c1D7786E'
        }
      ],
      8453: [
        {
          baseSymbol: 'USDbC',
          cometAddress: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf'
        },
        {
          baseSymbol: 'WETH',
          cometAddress: '0x46e6b214b524310239732D51387075E0e70970bf'
        },
        {
          baseSymbol: 'USDC',
          cometAddress: '0xb125E6687d4313864e53df431d5425969c15Eb2F'
        },
        {
          baseSymbol: 'AERO',
          cometAddress: '0x784efeB622244d2348d4F2522f8860B96fbEcE89'
        },
        {
          baseSymbol: 'USDS',
          cometAddress: '0x2c776041CCFe903071AF44aa147368a9c8EEA518'
        }
      ],
      42161: [
        {
          baseSymbol: 'USDC.e',
          cometAddress: '0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA'
        },
        {
          baseSymbol: 'USDC',
          cometAddress: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf'
        },
        {
          baseSymbol: 'WETH',
          cometAddress: '0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486'
        },
        {
          baseSymbol: 'USDT',
          cometAddress: '0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07'
        },
        {
          baseSymbol: 'USDS',
          cometAddress: comet.address
        }
      ],
      59144: [
        {
          baseSymbol: 'USDC',
          cometAddress: '0x8D38A3d6B3c3B7d96D6536DA7Eef94A9d7dbC991'
        }
      ],
      534352: [
        {
          baseSymbol: 'USDC',
          cometAddress: '0xB2f97c1Bd3bf02f5e74d13f02E3e26F93D77CE44'
        }
      ]
    });
  }
});