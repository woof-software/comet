import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';
import { ethers } from 'ethers';

const L1_DEPLOY_MANAGER_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

const L2_DEPLOY_MANAGER_ADDRESS = '0x1234567890123456789012345678901234567890';
const newChainId = 2020; // ronin chain id
const newChainSelector = '6916147374840168594'; // ronin chain selector


export default migration('1759392318_add_new_chain_to_bytecode_repo', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager) {

    const trace = deploymentManager.tracer();

    const { governor } = await deploymentManager.getContracts();

    const l1DeployManager = new ethers.Contract(
      L1_DEPLOY_MANAGER_ADDRESS,
      [
        'function setChainConfig(uint256 _chainId, tuple(address l2DeployManager, uint64 destinationChainSelector, uint256 gasLimit) _config) external',
      ],
      await deploymentManager.getSigner()
    );

    const mainnetActions = [
      // 1. Assign new developer for comet and cometExt
      {
        contract: l1DeployManager,
        signature: 'setChainConfig(uint256,(address,uint64,uint256))',
        args: [
          2020,
          [
            L2_DEPLOY_MANAGER_ADDRESS,
            newChainSelector,
            7_500_000
          ],
        ],
      },
    ];

    const description = 'DESCRIPTION';
    const txn = await deploymentManager.retry(async () =>
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

  async verify(deploymentManager: DeploymentManager) {
    const versionController = new ethers.Contract(
      L1_DEPLOY_MANAGER_ADDRESS,
      [
        'function chainConfigs(uint256 chainId) external view returns (tuple(address l2DeployManager, uint64 destinationChainSelector, uint256 gasLimit))',
      ],
      await deploymentManager.getSigner()
    );

    const config = await versionController.chainConfigs(newChainId);
    expect(config.l2DeployManager).to.equal(L2_DEPLOY_MANAGER_ADDRESS);
    expect(config.destinationChainSelector).to.equal(newChainSelector);
    expect(config.gasLimit).to.equal(7_500_000);
  },
});