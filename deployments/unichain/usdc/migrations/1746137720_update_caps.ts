import { Contract } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { CometWithExtendedAssetList__factory, CometProxyAdmin__factory, Configurator__factory } from '../../../../build/types';
import { calldata, exp, getConfigurationStruct, proposal } from '../../../../src/deploy';
import { utils, Contract, constants } from 'ethers';

const MAINNET_CONFIGURATOR_ADDRESS = '0x316f9708bB98af7dA9c68C1C3b5e79039cD336E3';
const MAINNET_WEETH_ADDRESS = '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee';
const MAINNET_TETH_ADDRESS = '0xD11c452fc99cF405034ee446803b6F6c1F6d5ED8';
const MAINNET_COMET_PROXY_ADMIN_ADDRESS = '0x1EC63B5883C3481134FD50D5DAebc83Ecd2E8779';
const MAINNET_WETH_COMET_ADDRESS = '0xA17581A9E3356d9A858b789D68B4d866e593aE94';
const MAINNET_USDT_COMET_ADDRESS = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';

const MAINNET_WEETH_OLD_CAP = exp(15_000, 18)
const MAINNET_WEETH_NEW_CAP = exp(18_000, 18)
const MAINNET_TETH_OLD_CAP = exp(4_000, 18)
const MAINNET_TETH_NEW_CAP = exp(10_000, 18)

const UNICHIAN_UNI_ADDRESS = '0x8f187aa05619a017077f5308904739877ce9ea21';
const UNICHAIN_WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const UNICHAIN_USDC_COMET_ADDRESS = '0x2c7118c4C88B9841FCF839074c26Ae8f035f2921';
const UNICHAIN_COMET_PROXY_ADMIN_ADDRESS = '0xaeb318360f27748acb200ce616e389a6c9409a07';
const UNICHAIN_CONFIGURATOR_ADDRESS = '0x8df378453Ff9dEFFa513367CDF9b3B53726303e9';

const UNICHAIN_ETH_OLD_CAP = exp(50, 18);
const UNICHAIN_ETH_NEW_CAP = exp(5_000, 18);
const UNICHAIN_UNI_OLD_CAP = exp(7_000, 18);
const UNICHAIN_UNI_NEW_CAP = exp(100_000, 18);

export default migration('1746137720_update_caps', {
  prepare: async (deploymentManager: DeploymentManager) => {
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
      rewards,
      COMP: COMP_L2,
      USDC: USDC_L2,
    } = await deploymentManager.getContracts();

    const {
      unichainL1CrossDomainMessenger,
      governor,
      COMP: COMP_L1,
      USDC: USDC_L1,
    } = await govDeploymentManager.getContracts();


    const updateAssetSupplyCapUSDTCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint128'],
      [UNICHAIN_USDC_COMET_ADDRESS, UNICHAIN_WETH_ADDRESS, UNICHAIN_ETH_NEW_CAP]
    );

    const updateAssetSupplyCapWETHCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint128'],
      [UNICHAIN_USDC_COMET_ADDRESS, UNICHIAN_UNI_ADDRESS, UNICHAIN_UNI_NEW_CAP]
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
    )

    // const extensionDelegateUSDC = new Contract(
    //   await comet.extensionDelegate(),
    //   [
    //     'function name() external view returns (string)',
    //     'function symbol() external view returns (string)',
    //   ],
    //   await deploymentManager.getSigner()
    // );

    const mainnetWETHCometContract = new Contract(MAINNET_WETH_COMET_ADDRESS, CometWithExtendedAssetList__factory.createInterface(), await govDeploymentManager.getSigner());
    const mainnetUSDTCometContract = new Contract(MAINNET_USDT_COMET_ADDRESS, CometWithExtendedAssetList__factory.createInterface(), await govDeploymentManager.getSigner());
    const unichainUSDCCometContract = new Contract(UNICHAIN_USDC_COMET_ADDRESS, CometWithExtendedAssetList__factory.createInterface(), await deploymentManager.getSigner());
    const mainnetConfigurator = new Contract(MAINNET_CONFIGURATOR_ADDRESS, Configurator__factory.createInterface(), await govDeploymentManager.getSigner())
    const unichainConfigurator = new Contract(UNICHAIN_CONFIGURATOR_ADDRESS, Configurator__factory.createInterface(), await deploymentManager.getSigner())
    const mainnetCometAdmin = new Contract(MAINNET_COMET_PROXY_ADMIN_ADDRESS, CometProxyAdmin__factory.createInterface(), await govDeploymentManager.getSigner())
    const unichainCometAdmin = new Contract(UNICHAIN_COMET_PROXY_ADMIN_ADDRESS, CometProxyAdmin__factory.createInterface(), await deploymentManager.getSigner())
    //  {
    //         contract: configurator,
    //         signature: "updateAssetSupplyCap(address,address,uint128)",
    //         args: [comet.address, COMP.address, exp(200_000, 18)],
    //       }
    // {
    //   contract: cometAdmin,
    //   signature: "deployAndUpgradeTo(address,address)",
    //   args: [configurator.address, comet.address],
    // },
    const actions = [
      // 1. Increase Mainnet V3 USDT Comet’s weETH Supply Cap from 12,000 to 18,000
      {
        contract: mainnetConfigurator,
        signature: "updateAssetSupplyCap(address,address,uint128)",
        args: [MAINNET_USDT_COMET_ADDRESS, MAINNET_WEETH_ADDRESS, MAINNET_WEETH_NEW_CAP]
      },
      // 2. deployAndUpgrade Mainnet V3 USDT
      {
        contract: mainnetCometAdmin,
        signature: "deployAndUpgradeTo(address,address)",
        args: [MAINNET_CONFIGURATOR_ADDRESS, MAINNET_USDT_COMET_ADDRESS],
      },
      // 3. Increase Mainnet V3 WETH Comet’s tETH Supply cap from 4,000 to 10,000
      {
        contract: mainnetConfigurator,
        signature: "updateAssetSupplyCap(address,address,uint128)",
        args: [MAINNET_WETH_COMET_ADDRESS, MAINNET_TETH_ADDRESS, MAINNET_TETH_NEW_CAP]
      },
      // 4. deployAndUpgrade Mainnet V3 WETH
      {
        contract: mainnetCometAdmin,
        signature: "deployAndUpgradeTo(address,address)",
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
    const description = '# Initialize cUSDCv3 on Unichain\n\n## Proposal summary\n\nCompound Growth Program [AlphaGrowth] proposes the deployment of Compound III to the Unichain network. This proposal takes the governance steps recommended and necessary to initialize a Compound III USDC market on Unichain; upon execution, cUSDCv3 will be ready for use. Simulations have confirmed the market’s readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario). The new parameters include setting the risk parameters based off of the [recommendations from Gauntlet](https://www.comp.xyz/t/deploy-compound-iii-on-unichain/6320/9).\n\nFurther detailed information can be found on the corresponding [proposal pull request](https://github.com/compound-finance/comet/pull/961), [deploy market GitHub action run](https://github.com/woof-software/comet/actions/runs/13401421590/job/37432916447) and [forum discussion](https://www.comp.xyz/t/deploy-compound-iii-on-unichain/6320).\n\n\n## Price feeds\n\nThe market uses all price feeds by Redstone. All other price feeds in the USDC market should be used from Redstone as well.\n\n## Proposal Actions\n\nThe first action approves COMP tokens to be bridged.\n\nThe second action sends COMP tokens to the Unichain via a native standard bridge.\n\nThe third action approves USDC tokens to be bridged.\n\nThe fourth action sends USDC tokens to the Unichain via a CCTP bridge.\n\nThe fifth proposal action sets the Comet configuration and deploys a new Comet implementation on Unichain. This sends the encoded `setConfiguration`, `deployAndUpgradeTo`and `setRewardConfig` calls across the bridge to the governance receiver on Unichain.\n\nThe sixth action updates the ENS TXT record `v3-official-markets` on `v3-additional-grants.compound-community-licenses.eth`, updating the official markets JSON to include the new Unichain cUSDCv3 market.';
    const txn = await govDeploymentManager.retry(async () => {
      return trace(await governor.propose(...(await proposal(actions, description))));
    }
    );

    const event = txn.events.find((event) => event.event === 'ProposalCreated');
    const [proposalId] = event.args;

    trace(`Created proposal ${proposalId}.`);
  },
});
