import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

const WITHDRAW_AMOUNT = exp(8_500, 6);

// Dedicated USDC gateway pair, not the generic L2StandardERC20Gateway; the L2 side isn't in any deployment's roots.
const L2_USDC_GATEWAY = '0x33B60d5Dd260d453cAC3782b0bDC01ce84672142';

let mainnetTimelockUsdcBefore: BigNumber;

export default migration('1790772750_withdraw_reserves', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      scrollMessenger,
      timelock: mainnetTimelock,
      USDC: mainnetUSDC,
    } = await govDeploymentManager.getContracts();

    const {
      bridgeReceiver,
      comet,
      timelock,
      USDC,
    } = await deploymentManager.getContracts();

    mainnetTimelockUsdcBefore = await mainnetUSDC.balanceOf(mainnetTimelock.address);

    // 1. Withdraw 8,500 USDC from the Scroll cUSDCv3 to the Scroll Timelock
    const withdrawReservesCalldata = utils.defaultAbiCoder.encode(
      ['address', 'uint256'],
      [timelock.address, WITHDRAW_AMOUNT]
    );

    // 2. Approve the L2 USDC gateway to spend the withdrawn USDC
    const approveCalldata = utils.defaultAbiCoder.encode(
      ['address', 'uint256'],
      [L2_USDC_GATEWAY, WITHDRAW_AMOUNT]
    );

    // 3. Bridge the USDC back to the Mainnet Timelock via the L2 USDC gateway
    const withdrawERC20Calldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint256', 'uint256'],
      [USDC.address, mainnetTimelock.address, WITHDRAW_AMOUNT, 300_000]
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          comet.address,
          USDC.address,
          L2_USDC_GATEWAY,
        ],
        [0, 0, 0],
        [
          'withdrawReserves(address,uint256)',
          'approve(address,uint256)',
          'withdrawERC20(address,address,uint256,uint256)',
        ],
        [
          withdrawReservesCalldata,
          approveCalldata,
          withdrawERC20Calldata,
        ],
      ]
    );

    const mainnetActions = [
      // 1. Send the withdraw/bridge instructions to the governance receiver on Scroll.
      {
        contract: scrollMessenger,
        signature: 'sendMessage(address,uint256,bytes,uint256)',
        // withdrawERC20 sends its own nested L2->L1 message, needs more gas than simpler proposals (~797k used)
        args: [bridgeReceiver.address, 0, l2ProposalData, 1_200_000],
        value: exp(0.05, 18)
      },
    ];

    const description = `# Withdraw 8,500 USDC from cUSDCv3 reserves on Scroll

## Proposal summary

This proposal withdraws 8,500 USDC from the reserves of the Compound III USDC market on Scroll and bridges it back to the Compound Timelock on Ethereum Mainnet using Scroll's native USDC bridge.

## Proposal actions

The proposal action sends a message through the Scroll Messenger to the Scroll Bridge Receiver, which queues the following calls on the Scroll Timelock:

1. Call \`withdrawReserves(address,uint256)\` on the Scroll cUSDCv3 to withdraw 8,500 USDC to the Scroll Timelock.
2. Approve the L2 USDC gateway to spend 8,500 USDC from the Scroll Timelock.
3. Call \`withdrawERC20\` on the L2 USDC gateway to bridge the USDC back to the Mainnet Timelock.
`;
    const txn = await govDeploymentManager.retry(async () =>
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

  async verify(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager, preMigrationBlockNumber: number) {
    const { comet, timelock, USDC } = await deploymentManager.getContracts();
    const { timelock: mainnetTimelock, USDC: mainnetUSDC } = await govDeploymentManager.getContracts();

    // Comet's USDC balance dropped by exactly the withdrawn amount
    const cometBalanceBefore = await USDC.balanceOf(comet.address, { blockTag: preMigrationBlockNumber });
    const cometBalanceAfter = await USDC.balanceOf(comet.address);
    expect(cometBalanceBefore.sub(cometBalanceAfter)).to.equal(WITHDRAW_AMOUNT);

    // The Scroll Timelock bridged everything out; nothing was left behind and no allowance remains
    expect(await USDC.balanceOf(timelock.address)).to.equal(0);
    expect(await USDC.allowance(timelock.address, L2_USDC_GATEWAY)).to.equal(0);

    // The same amount was bridged to the Mainnet Timelock
    const mainnetTimelockUsdcAfter = await mainnetUSDC.balanceOf(mainnetTimelock.address);
    expect(mainnetTimelockUsdcAfter.sub(mainnetTimelockUsdcBefore)).to.equal(WITHDRAW_AMOUNT);
  },
});
