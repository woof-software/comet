import { expect } from 'chai';
import { Contract } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';

const cometAbi = [
  'function baseTrackingSupplySpeed() public view returns (uint)',
  'function baseTrackingBorrowSpeed() public view returns (uint)',
];

const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDT_COMET = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';
const WETH_COMET = '0xA17581A9E3356d9A858b789D68B4d866e593aE94';

export default migration('1787052391_stop_active_rewards_on_mainnet', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager) {

    const trace = deploymentManager.tracer();

    const {
      governor,
      cometAdmin,
      configurator,
    } = await deploymentManager.getContracts();

    const mainnetActions = [
      // 1. Set base tracking supply speed on USDC Comet to 0
      {
        contract: configurator,
        signature: 'setBaseTrackingSupplySpeed(address,uint64)',
        args: [USDC_COMET, 0],
      },
      // 2. Set base tracking borrow speed on USDC Comet to 0
      {
        contract: configurator,
        signature: 'setBaseTrackingBorrowSpeed(address,uint64)',
        args: [USDC_COMET, 0],
      },
      // 3. Deploy and upgrade the USDC Comet implementation to apply the updates
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, USDC_COMET],
      },
      // 4. Set base tracking supply speed on USDT Comet to 0
      {
        contract: configurator,
        signature: 'setBaseTrackingSupplySpeed(address,uint64)',
        args: [USDT_COMET, 0],
      },
      // 5. Set base tracking borrow speed on USDT Comet to 0
      {
        contract: configurator,
        signature: 'setBaseTrackingBorrowSpeed(address,uint64)',
        args: [USDT_COMET, 0],
      },
      // 6. Deploy and upgrade the USDT Comet implementation to apply the updates
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, USDT_COMET],
      },
      // 7. Set base tracking supply speed on WETH Comet to 0
      {
        contract: configurator,
        signature: 'setBaseTrackingSupplySpeed(address,uint64)',
        args: [WETH_COMET, 0],
      },
      // 8. Set base tracking borrow speed on WETH Comet to 0
      {
        contract: configurator,
        signature: 'setBaseTrackingBorrowSpeed(address,uint64)',
        args: [WETH_COMET, 0],
      },
      // 9. Deploy and upgrade the WETH Comet implementation to apply the updates
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, WETH_COMET],
      },
    ];

    const description = 'DESCRIPTION';

    const txn = await deploymentManager.retry(async () =>
      trace(
        await governor.propose(...(await proposal(mainnetActions, description)))
      ), 0, 600_000
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
    const { configurator } = await deploymentManager.getContracts();
    const signer = await deploymentManager.getSigner();

    // 1 - 3 Compare updated base tracking speeds on USDC Comet
    const usdcConfiguration = await configurator.getConfiguration(USDC_COMET);
    expect(usdcConfiguration.baseTrackingSupplySpeed).to.equal(0);
    expect(usdcConfiguration.baseTrackingBorrowSpeed).to.equal(0);

    const usdcComet = new Contract(USDC_COMET, cometAbi, signer);
    expect(await usdcComet.baseTrackingSupplySpeed()).to.equal(0);
    expect(await usdcComet.baseTrackingBorrowSpeed()).to.equal(0);

    // 4 - 6 Compare updated base tracking speeds on USDT Comet
    const usdtConfiguration = await configurator.getConfiguration(USDT_COMET);
    expect(usdtConfiguration.baseTrackingSupplySpeed).to.equal(0);
    expect(usdtConfiguration.baseTrackingBorrowSpeed).to.equal(0);

    const usdtComet = new Contract(USDT_COMET, cometAbi, signer);
    expect(await usdtComet.baseTrackingSupplySpeed()).to.equal(0);
    expect(await usdtComet.baseTrackingBorrowSpeed()).to.equal(0);

    // 7 - 9 Compare updated base tracking speeds on WETH Comet
    const wethConfiguration = await configurator.getConfiguration(WETH_COMET);
    expect(wethConfiguration.baseTrackingSupplySpeed).to.equal(0);
    expect(wethConfiguration.baseTrackingBorrowSpeed).to.equal(0);

    const wethComet = new Contract(WETH_COMET, cometAbi, signer);
    expect(await wethComet.baseTrackingSupplySpeed()).to.equal(0);
    expect(await wethComet.baseTrackingBorrowSpeed()).to.equal(0);
  },
});
