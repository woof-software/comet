import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import {
  calldata,
  proposal,
} from '../../../../src/deploy';
import { ethers, utils } from 'ethers';

const destinationChainSelector = '6916147374840168594';
const RONIN_COMP = '0x2d86d6456682e0932e65869416c89ff8db76381f';
const RONIN_COMP_POOL = '0x6562d0b77b9ab0525ddc74636c2184f6c6f87506';
const RONIN_TOKEN_ADMIN_REGISTRY = '0x90e83d532A4aD13940139c8ACE0B93b0DdbD323a';

const MAINNET_COMP = '0xc00e94Cb662C3520282E6f5717214004A7f26888';
const MAINNET_COMP_POOL = '0x58c9dE388C86afed38A24CD454082FAa07aBa1e8';
const MAINNET_TOKEN_ADMIN_REGISTRY = '0xb22764f98dD05c789929716D677382Df22C05Cb6';

export default migration('1743769123_add_comp_to_ccip', {
  prepare: async () => {
    return {};
  },

  enact: async (
    deploymentManager: DeploymentManager,
    govDeploymentManager: DeploymentManager
  ) => {
    const trace = deploymentManager.tracer();

    const { bridgeReceiver } =
      await deploymentManager.getContracts();


    const {
      l1CCIPRouter,
      governor,
    } = await govDeploymentManager.getContracts();

    const COMP = new ethers.Contract(
      RONIN_COMP,
      ['function acceptOwnership() external'],
      await deploymentManager.getSigner()
    );

    const compPool = new ethers.Contract(
      RONIN_COMP_POOL,
      ['function acceptOwnership() external'],
      await deploymentManager.getSigner()
    );

    const roninTokenAdminRegistry = new ethers.Contract(
      RONIN_TOKEN_ADMIN_REGISTRY,
      ['function acceptAdminRole(address) external'],
      await deploymentManager.getSigner()
    );

    const mainnetCompPool = new ethers.Contract(
      MAINNET_COMP_POOL,
      ['function acceptOwnership() external'],
      await deploymentManager.getSigner()
    );

    const mainnetTokenAdminRegistry = new ethers.Contract(
      MAINNET_TOKEN_ADMIN_REGISTRY,
      [
        'function acceptAdminRole(address) external',
        'function setPool(address,address) external'
      ],
      await deploymentManager.getSigner()
    );


    const acceptOwnershipCalldata = await calldata(
      COMP.populateTransaction.acceptOwnership()
    );

    const acceptRoninAdminRoleCalldata = await calldata(
      roninTokenAdminRegistry.populateTransaction.acceptAdminRole(
        COMP.address
      )
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [COMP.address, compPool.address, roninTokenAdminRegistry.address],
        [0, 0, 0],
        [
          'acceptOwnership()',
          'acceptOwnership()',
          'acceptAdminRole(address)'
        ],
        [
          acceptOwnershipCalldata,
          acceptOwnershipCalldata,
          acceptRoninAdminRoleCalldata
        ],
      ]
    );

    const fee = await l1CCIPRouter.getFee(destinationChainSelector, [
      utils.defaultAbiCoder.encode(['address'], [bridgeReceiver.address]),
      l2ProposalData,
      [],
      ethers.constants.AddressZero,
      '0x'
    ]);

    const actions = [
      {
        contract: mainnetCompPool,
        signature: 'acceptOwnership()',
        args: [],
      },
      // {
      //   contract: mainnetTokenAdminRegistry,
      //   signature: 'acceptAdminRole(address)',
      //   args: [MAINNET_COMP],
      // },
      // {
      //   contract: mainnetTokenAdminRegistry,
      //   signature: 'setPool(address,address)',
      //   args: [MAINNET_COMP, MAINNET_COMP_POOL],
      // },
      {
        contract: l1CCIPRouter,
        signature: 'ccipSend(uint64,(bytes,bytes,(address,uint256)[],address,bytes))',
        args:
          [
            destinationChainSelector,
            [
              utils.defaultAbiCoder.encode(['address'], [bridgeReceiver.address]),
              l2ProposalData,
              [],
              ethers.constants.AddressZero,
              '0x'
            ]
          ],
        value: fee.mul(2)
      },
    ];


    const description = 'DESCRIPTION';

    const txn = await governor.propose(...(await proposal(actions, description)));
    const event = (await txn.wait()).events.find((event) => event.event === 'ProposalCreated');

    const [proposalId] = event.args;

    trace(`Created proposal ${proposalId}.`);
  },

  async enacted(): Promise<boolean> {
    return false;
  },

  async verify() {
    return;
  },
});
