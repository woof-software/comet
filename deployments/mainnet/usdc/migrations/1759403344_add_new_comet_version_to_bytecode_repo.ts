import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';
import { ethers } from 'ethers';

const COMET_FACTORY_ADDRESS = '0x1234567890123456789012345678901234567890';

export default migration('1759392318_add_new_chain_to_bytecode_repo', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager) {

    const trace = deploymentManager.tracer();

    const { governor } = await deploymentManager.getContracts();

    const cometFactory = new ethers.Contract(
      COMET_FACTORY_ADDRESS,
      [
        'function setVersion(tuple(tuple(uint64 major, uint64 minor, uint64 patch) version, string alternative) _newVersion) external',
      ],
      await deploymentManager.getSigner()
    );

    const mainnetActions = [
      // 1. Assign new developer for comet and cometExt
      {
        contract: cometFactory,
        signature: 'setVersion((tuple((uint64,uint64,uint64),string))',
        args: [
          [
            [
              2, 0, 0
            ],
            'partial liquidation'
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
      COMET_FACTORY_ADDRESS,
      [
        'function version() external view returns (tuple(tuple(uint64 major, uint64 minor, uint64 patch) version, string alternative))',
      ],
      await deploymentManager.getSigner()
    );

    const version = await versionController.version();
    expect(version.version.major).to.equal(2);
    expect(version.version.minor).to.equal(0);
    expect(version.version.patch).to.equal(0);
    expect(version.alternative).to.equal('partial liquidation');
  },
});