import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';
import { ethers, utils } from 'ethers';

const VERSION_CONTROLLER_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const COMET_DEVELOPER_ADDRESS = '0x1234567890123456789012345678901234567890';
const PRICE_FEED_DEVELOPER_ADDRESS = '0x2345678901234567890123456789012345678901';


export default migration('1759391945_assign_new_developer_for_bytecode_repo', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager) {

    const trace = deploymentManager.tracer();

    const { governor } = await deploymentManager.getContracts();

    const versionController = new ethers.Contract(
      VERSION_CONTROLLER_ADDRESS,
      [
        'function assignDeveloperForContractType(bytes32[] _contractTypes, address _keyDeveloper) external',
      ],
      await deploymentManager.getSigner()
    );

    const mainnetActions = [
      // 1. Assign new developer for comet and cometExt
      {
        contract: versionController,
        signature: 'assignDeveloperForContractType(bytes32[],address)',
        args: [
          [
            utils.formatBytes32String('comet'),
            utils.formatBytes32String('cometExt')
          ],
          COMET_DEVELOPER_ADDRESS
        ],
      },
      // 2. Assign new developer for price feeds
      {
        contract: versionController,
        signature: 'assignDeveloperForContractType(bytes32[],address)',
        args: [
          [
            utils.formatBytes32String('scalingPriceFeed'),
            utils.formatBytes32String('multiplicativePriceFeed'),
            utils.formatBytes32String('reverseMultiplicativePriceFeed'),
          ],
          PRICE_FEED_DEVELOPER_ADDRESS
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
      VERSION_CONTROLLER_ADDRESS,
      [
        'function hasRole(bytes32 role, address account) external view returns (bool)',
        'function contractTypeKeyDeveloper(bytes32 contractType) external view returns(address)',
        'function KEY_DEVELOPER_ROLE() external view returns (bytes32)',
      ],
      await deploymentManager.getSigner()
    );

    const KEY_DEVELOPER_ROLE = await versionController.KEY_DEVELOPER_ROLE();

    expect(await versionController.hasRole(KEY_DEVELOPER_ROLE, COMET_DEVELOPER_ADDRESS)).to.be.true;
    expect(await versionController.hasRole(KEY_DEVELOPER_ROLE, PRICE_FEED_DEVELOPER_ADDRESS)).to.be.true;

    expect(await versionController.contractTypeKeyDeveloper(utils.formatBytes32String('comet'))).to.equal(COMET_DEVELOPER_ADDRESS);
    expect(await versionController.contractTypeKeyDeveloper(utils.formatBytes32String('cometExt'))).to.equal(COMET_DEVELOPER_ADDRESS);

    expect(await versionController.contractTypeKeyDeveloper(utils.formatBytes32String('scalingPriceFeed'))).to.equal(PRICE_FEED_DEVELOPER_ADDRESS);
    expect(await versionController.contractTypeKeyDeveloper(utils.formatBytes32String('multiplicativePriceFeed'))).to.equal(PRICE_FEED_DEVELOPER_ADDRESS);
    expect(await versionController.contractTypeKeyDeveloper(utils.formatBytes32String('reverseMultiplicativePriceFeed'))).to.equal(PRICE_FEED_DEVELOPER_ADDRESS);
  },
});