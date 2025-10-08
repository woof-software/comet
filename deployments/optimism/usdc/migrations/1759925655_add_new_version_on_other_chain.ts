import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';
import { utils, Contract } from 'ethers';

const VERSION_CONTROLLER_ADDRESS = '0x0987654321098765432109876543210987654321';
const L1_DEPLOY_MANAGER_ADDRESS = '0x1234567890123456789012345678901234567890';
const L2_DEPLOY_MANAGER_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const targetChainId = 420; // Optimism

export default migration('1759925655_add_new_version_on_other_chain', {
  async prepare() {
    return {};
  },

  enact: async (
    deploymentManager: DeploymentManager,
    govDeploymentManager: DeploymentManager    
  ) => {
    const trace = deploymentManager.tracer();
    const { governor } = await govDeploymentManager.getContracts();

    const l1DeployManager = new Contract(
      L1_DEPLOY_MANAGER_ADDRESS,
      [
        'function sendBytecodeToOtherChain(tuple(bytes32 contractType, tuple(tuple(uint64 major, uint64 minor, uint64 patch) version, string alternative) version) _bytecodeVersion, uint256 _chainId) external',
      ],
      await deploymentManager.getSigner()
    );

    const mainnetActions = [
      {
        contract: l1DeployManager,
        signature: 'sendBytecodeToOtherChain((tuple(bytes32,tuple((uint64,uint64,uint64),string)),uint256))',
        args: [
          {
            contractType: utils.formatBytes32String('Comet'),
            version: {
              version: { major: 1, minor: 0, patch: 0 },
              alternative: 'comet'
            }
          },
          targetChainId
        ]
      },
    ];

    const description = 'DESCRIPTION';
    const txn = await govDeploymentManager.retry(async () =>
      trace(
        await governor.propose(...(await proposal(mainnetActions, description)))
      )
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

  async verify(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const versionController = new Contract(
      VERSION_CONTROLLER_ADDRESS,
      [
        'function computeBytecodeHash(bytes32 _contractType, tuple(tuple(uint64 major, uint64 minor, uint64 patch) version, string alternative) _version) public pure returns (bytes32)'
      ],
      await deploymentManager.getSigner()
    );
    const bytecodeHash = await versionController.computeBytecodeHash(
      utils.formatBytes32String('Comet'),
      {
        version: { major: 1, minor: 0, patch: 0 },
        alternative: 'comet'
      }
    );

    const l1DeployManager = new Contract(
      L1_DEPLOY_MANAGER_ADDRESS,
      [
        'function isVersionSentToChain(uint256 _chainId, bytes32 _bytecodeHash) external view returns (bool)'
      ],
      await govDeploymentManager.getSigner()
    );

    const l2DeployManager = new Contract(
      L2_DEPLOY_MANAGER_ADDRESS,
      [
        'function versionExists(tuple(bytes32 contractType, tuple(tuple(uint64 major, uint64 minor, uint64 patch) version, string alternative) version) _version) external view returns (bool)'
      ],
      await deploymentManager.getSigner()
    );

    expect(await l1DeployManager.isVersionSentToChain(targetChainId, bytecodeHash)).to.be.true;
    expect(await l2DeployManager.versionExists(
      {
        contractType: utils.formatBytes32String('Comet'),
        version: {
          version: { major: 1, minor: 0, patch: 0 },
          alternative: 'comet'
        }
      }
    )).to.be.true;
  },
});
