import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { CometWithExtendedAssetList__factory, CometProxyAdmin__factory, Configurator__factory } from '../../../../build/types';
import { exp, proposal } from '../../../../src/deploy';
import { utils, Contract } from 'ethers';
import { expect } from 'chai';

const MAINNET_CONFIGURATOR_ADDRESS = '0x316f9708bB98af7dA9c68C1C3b5e79039cD336E3';
const MAINNET_WEETH_ADDRESS = '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee';
const MAINNET_TETH_ADDRESS = '0xD11c452fc99cF405034ee446803b6F6c1F6d5ED8';
const MAINNET_COMET_PROXY_ADMIN_ADDRESS = '0x1EC63B5883C3481134FD50D5DAebc83Ecd2E8779';
const MAINNET_WETH_COMET_ADDRESS = '0xA17581A9E3356d9A858b789D68B4d866e593aE94';
const MAINNET_USDT_COMET_ADDRESS = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';

const MAINNET_WEETH_NEW_CAP = exp(18_000, 18);
const MAINNET_TETH_NEW_CAP = exp(10_000, 18);

const UNICHAIN_ETH_NEW_CAP = exp(5_000, 18);
const UNICHAIN_UNI_NEW_CAP = exp(100_000, 18);

export default migration('1746137720_update_caps', {
  prepare: async () => {
    return {};
  },

  enact: async (
    deploymentManager: DeploymentManager,
    govDeploymentManager: DeploymentManager
  ) => {
    const trace = deploymentManager.tracer();
    const {
      bridgeReceiver,
      comet,
      cometAdmin,
      configurator,
      UNI,
      WETH
    } = await deploymentManager.getContracts();

    const {
      unichainL1CrossDomainMessenger,
      governor,
    } = await govDeploymentManager.getContracts();


    const updateAssetSupplyCapUSDTCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint128'],
      [comet.address, WETH.address, UNICHAIN_ETH_NEW_CAP]
    );

    const updateAssetSupplyCapWETHCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint128'],
      [comet.address, UNI.address, UNICHAIN_UNI_NEW_CAP]
    );

    const deployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [configurator.address, comet.address]
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          configurator.address,
          configurator.address,
          cometAdmin.address
        ],
        [0, 0, 0],
        [
          'updateAssetSupplyCap(address,address,uint128)',
          'updateAssetSupplyCap(address,address,uint128)',
          'deployAndUpgradeTo(address,address)'
        ],
        [
          updateAssetSupplyCapUSDTCalldata,
          updateAssetSupplyCapWETHCalldata,
          deployAndUpgradeToCalldata,
        ]
      ]
    );

    const mainnetConfigurator = new Contract(
      MAINNET_CONFIGURATOR_ADDRESS,
      Configurator__factory.createInterface(),
      await govDeploymentManager.getSigner()
    );
    const mainnetCometAdmin = new Contract(
      MAINNET_COMET_PROXY_ADMIN_ADDRESS, CometProxyAdmin__factory.createInterface(),
      await govDeploymentManager.getSigner()
    );

    const actions = [
      // 1. Increase Mainnet V3 USDT Comet’s weETH Supply Cap from 12,000 to 18,000
      {
        contract: mainnetConfigurator,
        signature: 'updateAssetSupplyCap(address,address,uint128)',
        args: [MAINNET_USDT_COMET_ADDRESS, MAINNET_WEETH_ADDRESS, MAINNET_WEETH_NEW_CAP]
      },
      // 2. deployAndUpgrade Mainnet V3 USDT
      {
        contract: mainnetCometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [MAINNET_CONFIGURATOR_ADDRESS, MAINNET_USDT_COMET_ADDRESS],
      },
      // 3. Increase Mainnet V3 WETH Comet’s tETH Supply cap from 4,000 to 10,000
      {
        contract: mainnetConfigurator,
        signature: 'updateAssetSupplyCap(address,address,uint128)',
        args: [MAINNET_WETH_COMET_ADDRESS, MAINNET_TETH_ADDRESS, MAINNET_TETH_NEW_CAP]
      },
      // 4. deployAndUpgrade Mainnet V3 WETH
      {
        contract: mainnetCometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [MAINNET_CONFIGURATOR_ADDRESS, MAINNET_WETH_COMET_ADDRESS],
      },
      // 5 -|
      // 5. Increase Unichain V3 USDC Comet’s WETH Supply cap from 50 to 5,000
      // 6. Increase Unichain V3 USDC Comet’s UNI Supply cap from 7,000 to 100k
      // 7. deployAndUpgrade Unicahin V3 USDC
      {
        contract: unichainL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [bridgeReceiver.address, l2ProposalData, 3_000_000],
      },
    ];

    // the description has speeds. speeds will be set up on on-chain proposal
    const description = '# [Gauntlet] Supply Cap Recommendations (04/28/25) pushed by WOOF!\n\nSimple Summary\n\n## Note\n\nThis proposal is proposed by WOOF! due to Gauntlet reaching the maximum number of active proposals using their delegated wallets. Live proposals by Gauntlet:\n\n- [Proposal 433](https://www.tally.xyz/gov/compound/proposal/433?govId=eip155:1:0x309a862bbC1A00e45506cB8A802D1ff10004c8C0)\n\n- [Proposal 434](https://www.tally.xyz/gov/compound/proposal/434?govId=eip155:1:0x309a862bbC1A00e45506cB8A802D1ff10004c8C0)\n\n## Simple Summary\n\nGauntlet recommends the following risk recommendations to the protocol:\n\n- Increase Mainnet V3 USDT Comet’s weETH Supply Cap from 12,000 to 18,000\n\n- Increase Mainnet V3 WETH Comet’s tETH Supply cap from 4,000 to 10,000\n\n- Increase Unichain V3 USDC Comet’s WETH Supply cap from 50 to 5,000\n\n- Increase Unichain V3 USDC Comet’s UNI Supply cap from 7,000 to 100k\n\n## Motivation\n\nSee full analysis below:\n\n[[Gauntlet] - Supply Cap Recommendations](https://www.comp.xyz/t/gauntlet-supply-cap-recommendation-proposals/5886/29)\n\n## Specification\n\nThe proposal updates the parameters by using the respective methods on the Configurator.';
    const txn = await govDeploymentManager.retry(async () => {
      return trace(await governor.propose(...(await proposal(actions, description))));
    }
    );

    const event = txn.events.find((event) => event.event === 'ProposalCreated');
    const [proposalId] = event.args;

    trace(`Created proposal ${proposalId}.`);
  },

  async enacted(): Promise<boolean> {
    return false;
  },

  async verify(
    deploymentManager: DeploymentManager,
    govDeploymentManager: DeploymentManager,
    _
  ) {
    const {
      configurator: configuratorL2,
      UNI,
      WETH,
      comet
    } = await deploymentManager.getContracts();

    const {
      configurator: configuratorL1
    } = await govDeploymentManager.getContracts();

    const cometUSDTMainnet = new Contract(
      MAINNET_USDT_COMET_ADDRESS,
      CometWithExtendedAssetList__factory.createInterface(),
      await govDeploymentManager.getSigner()
    );

    const cometWETHMainnet = new Contract(
      MAINNET_WETH_COMET_ADDRESS,
      CometWithExtendedAssetList__factory.createInterface(),
      await govDeploymentManager.getSigner()
    );

    const tETHAssetInfoMainnetWETH = await cometWETHMainnet.getAssetInfoByAddress(
      MAINNET_TETH_ADDRESS
    );

    const tETHAssetInfoMainnetWETHConfig = (await configuratorL1.getConfiguration(MAINNET_WETH_COMET_ADDRESS)).assetConfigs[tETHAssetInfoMainnetWETH.offset];

    const weETHAssetInfoMainnetUSDT = await cometUSDTMainnet.getAssetInfoByAddress(
      MAINNET_WEETH_ADDRESS
    );
    const weETHAssetInfoMainnetUSDTConfig = (await configuratorL1.getConfiguration(MAINNET_USDT_COMET_ADDRESS)).assetConfigs[weETHAssetInfoMainnetUSDT.offset];

    expect(tETHAssetInfoMainnetWETH.supplyCap).to.equal(MAINNET_TETH_NEW_CAP);
    expect(weETHAssetInfoMainnetUSDT.supplyCap).to.equal(MAINNET_WEETH_NEW_CAP);
    expect(tETHAssetInfoMainnetWETHConfig.supplyCap).to.equal(MAINNET_TETH_NEW_CAP);
    expect(weETHAssetInfoMainnetUSDTConfig.supplyCap).to.equal(MAINNET_WEETH_NEW_CAP);

    const cometUSDCUnichain = new Contract(
      comet.address,
      CometWithExtendedAssetList__factory.createInterface(),
      await deploymentManager.getSigner()
    );

    const weETHAssetInfoUnichainUSDC = await cometUSDCUnichain.getAssetInfoByAddress(
      WETH.address
    );

    const weETHAssetInfoUnichainUSDCConfig = (await configuratorL2.getConfiguration(comet.address)).assetConfigs[weETHAssetInfoUnichainUSDC.offset];

    const uniAssetInfoUnichainUSDC = await cometUSDCUnichain.getAssetInfoByAddress(
      UNI.address
    );

    const uniAssetInfoUnichainUSDCConfig = (await configuratorL2.getConfiguration(comet.address)).assetConfigs[uniAssetInfoUnichainUSDC.offset];

    expect(uniAssetInfoUnichainUSDC.supplyCap).to.equal(UNICHAIN_UNI_NEW_CAP);
    expect(weETHAssetInfoUnichainUSDC.supplyCap).to.equal(UNICHAIN_ETH_NEW_CAP);
    expect(uniAssetInfoUnichainUSDCConfig.supplyCap).to.equal(UNICHAIN_UNI_NEW_CAP);
    expect(weETHAssetInfoUnichainUSDCConfig.supplyCap).to.equal(UNICHAIN_ETH_NEW_CAP);
  }
});
