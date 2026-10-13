import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

const WITHDRAW_AMOUNT = exp(8_500, 6);

// Dedicated USDC gateway pair, not the generic L2StandardERC20Gateway; the L2 side isn't in any deployment's roots.
const L2_USDC_GATEWAY = '0x33B60d5Dd260d453cAC3782b0bDC01ce84672142';

let scrollCometBalanceBefore: BigNumber;
let mainnetTimelockUsdcBefore: BigNumber;
let scrollTimelockUsdcBefore: BigNumber;

const formatUsdc = (amount: BigNumber | bigint) =>
  Number(utils.formatUnits(amount, 6)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

    scrollCometBalanceBefore = await USDC.balanceOf(comet.address);
    scrollTimelockUsdcBefore = await USDC.balanceOf(timelock.address);
    mainnetTimelockUsdcBefore = await mainnetUSDC.balanceOf(mainnetTimelock.address);

    const reservesAtCreation = await comet.getReserves();

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

    const description = `# Withdraw reserves from cUSDCv3 on Scroll

## Proposal summary

This proposal withdraws 8,500 USDC of reserves from the Compound III USDC market on Scroll and bridges it back to the Compound Timelock on Ethereum Mainnet using Scroll's native USDC bridge.

Withdrawing the reserves is the final step of the deprecation process and secures the market's protocol-owned funds by moving them to the Timelock on Mainnet. 

## Reserves withdrawal

Reserves are the protocol-owned portion of the market's base asset: the Comet's USDC balance plus outstanding borrows, minus what is owed to suppliers, as reported by \`getReserves()\`. They do not belong to any user, so withdrawing them does not change supplier or borrower balances. Only the governor of the market (the Scroll Timelock) can call \`withdrawReserves\`.

| Source | Amount |
| --- | --- |
| cUSDCv3 reserves at proposal creation (\`getReserves()\`) | ${formatUsdc(reservesAtCreation)} USDC |
| Withdrawn and bridged to the Mainnet Timelock | ${formatUsdc(WITHDRAW_AMOUNT)} USDC |

The proposal does not withdraw all reserves. The market still has open borrow positions, so the remaining USDC is left as a buffer that keeps the market solvent until those positions are repaid or liquidated. The rest can be withdrawn by a later proposal once they are closed.

## Proposal actions

The proposal action sends a message through the Scroll Messenger to the Scroll Bridge Receiver, which queues the following calls on the Scroll Timelock:

1. Call \`withdrawReserves(address,uint256)\` on the Scroll cUSDCv3 to withdraw 8,500 USDC to the Scroll Timelock.
2. Approve the L2 USDC gateway to spend 8,500 USDC from the Scroll Timelock.
3. Call \`withdrawERC20\` on the L2 USDC gateway to bridge the USDC back to the Mainnet Timelock.

Once the Scroll batch containing the withdrawal is finalized on Mainnet, the withdrawal is claimed on the Scroll L1 messenger with \`relayMessageWithProof\`. Anyone can submit the claim, and the USDC can only be released to the Mainnet Timelock.
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

  async verify(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const {
      comet: scrollComet,
      timelock: scrollTimelock,
      USDC: scrollUSDC
    } = await deploymentManager.getContracts();

    const {
      timelock: mainnetTimelock,
      USDC: mainnetUSDC
    } = await govDeploymentManager.getContracts();

    // Comet's USDC balance dropped by exactly the withdrawn amount
    const scrollCometBalanceAfter = await scrollUSDC.balanceOf(scrollComet.address);
    expect(scrollCometBalanceBefore.sub(scrollCometBalanceAfter)).to.equal(WITHDRAW_AMOUNT);

    // The Scroll Timelock's USDC balance should remain the same as before the withdrawal (no USDC left)
    const scrollTimelockUsdcAfter = await scrollUSDC.balanceOf(scrollTimelock.address);
    expect(scrollTimelockUsdcBefore).to.equal(scrollTimelockUsdcAfter);

    // The Scroll Timelock bridged everything out; no allowance remains
    expect(await scrollUSDC.allowance(scrollTimelock.address, L2_USDC_GATEWAY)).to.equal(0);

    // The same amount was bridged to the Mainnet Timelock
    const mainnetTimelockUsdcAfter = await mainnetUSDC.balanceOf(mainnetTimelock.address);
    expect(mainnetTimelockUsdcAfter.sub(mainnetTimelockUsdcBefore)).to.equal(WITHDRAW_AMOUNT);
  },
});
