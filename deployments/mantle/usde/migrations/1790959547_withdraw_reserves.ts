import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

const WITHDRAW_AMOUNT = exp(205_000, 18);

const MAINNET_EID = 30101;

// Fixed LayerZero fee: the Mantle Timelock's full MNT balance; the endpoint refunds the excess over the real fee
const MNT_FEE = utils.parseEther('50');

let mantleCometBalanceBefore: BigNumber;
let mainnetTimelockUsdeBefore: BigNumber;
let mantleTimelockUsdeBefore: BigNumber;

const formatAmount = (amount: BigNumber | bigint, decimals = 18) =>
  Number(utils.formatUnits(amount, decimals)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default migration('1790959547_withdraw_reserves', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      mantleL1CrossDomainMessenger,
      timelock: mainnetTimelock,
      USDe: mainnetUSDe,
    } = await govDeploymentManager.getContracts();

    const {
      bridgeReceiver,
      comet,
      timelock,
      USDe,
    } = await deploymentManager.getContracts();

    mantleCometBalanceBefore = await USDe.balanceOf(comet.address);
    mantleTimelockUsdeBefore = await USDe.balanceOf(timelock.address);
    mainnetTimelockUsdeBefore = await mainnetUSDe.balanceOf(mainnetTimelock.address);
    const reservesAtCreation = await comet.getReserves();

    // 1. Withdraw 205,000 USDe from the Mantle cUSDEv3 to the Mantle Timelock
    const withdrawReservesCalldata = utils.defaultAbiCoder.encode(
      ['address', 'uint256'],
      [timelock.address, WITHDRAW_AMOUNT]
    );

    // 2. Send the USDe to the Mainnet Timelock via LayerZero's OFT send(). USDe is a native OFT
    // on Mantle (mint/burn), so no approval step is needed before calling send() directly on it.
    // The messaging fee is paid in native MNT from the Mantle Timelock's own balance.
    const sendParam = [
      MAINNET_EID,
      utils.hexZeroPad(mainnetTimelock.address, 32),
      WITHDRAW_AMOUNT,
      WITHDRAW_AMOUNT,
      '0x',
      '0x',
      '0x',
    ];

    const sendCalldata = utils.defaultAbiCoder.encode(
      ['(uint32,bytes32,uint256,uint256,bytes,bytes,bytes)', '(uint256,uint256)', 'address'],
      [sendParam, [MNT_FEE, 0], timelock.address]
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          comet.address,
          USDe.address,
        ],
        [0, MNT_FEE],
        [
          'withdrawReserves(address,uint256)',
          'send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)',
        ],
        [
          withdrawReservesCalldata,
          sendCalldata,
        ],
      ]
    );

    const mainnetActions = [
      // 1. Send the withdraw/bridge instructions to the governance receiver on Mantle.
      {
        contract: mantleL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [bridgeReceiver.address, l2ProposalData, 2_500_000],
      },
    ];

    const description = `# Withdraw reserves from cUSDEv3 on Mantle

## Proposal summary

This proposal withdraws 205,000 USDe of reserves from the Compound III USDe market on Mantle and sends it to the Compound Timelock on Ethereum Mainnet using LayerZero's OFT standard.

Withdrawing the reserves is the final step of the deprecation process and secures the market's protocol-owned funds by moving them to the Timelock on Mainnet.

## Reserves withdrawal

Reserves are the protocol-owned portion of the market's base asset: the Comet's USDe balance plus outstanding borrows, minus what is owed to suppliers, as reported by \`getReserves()\`. They do not belong to any user, so withdrawing them does not change supplier or borrower balances. Only the governor of the market (the Mantle Timelock) can call \`withdrawReserves\`.

| Source | Amount |
| --- | --- |
| cUSDEv3 reserves at proposal creation (\`getReserves()\`) | ${formatAmount(reservesAtCreation)} USDe |
| Withdrawn and sent to the Mainnet Timelock | ${formatAmount(WITHDRAW_AMOUNT)} USDe |

The proposal does not withdraw all reserves. The market still has open borrow positions, so the remaining USDe is left as a buffer that keeps the market solvent until those positions are repaid or liquidated. The rest can be withdrawn by a later proposal once they are closed.

## Proposal actions

The proposal action sends a message through the Mantle L1 Cross Domain Messenger to the Mantle Bridge Receiver, which queues the following calls on the Mantle Timelock:

1. Call \`withdrawReserves(address,uint256)\` on the Mantle cUSDEv3 to withdraw 205,000 USDe to the Mantle Timelock.
2. Call \`send\` on USDe to send 205,000 USDe to the Mainnet Timelock. USDe on Mantle is a LayerZero OFT: it is burned on Mantle and released on Mainnet by the USDe OFT adapter, so no approval is needed. The LayerZero messaging fee is paid in native MNT from the Mantle Timelock's own balance: a fixed ${formatAmount(MNT_FEE)} MNT is sent with the call, well above the current fee, so the call still succeeds if the fee rises before execution. The LayerZero endpoint refunds any excess over the actual fee to the Mantle Timelock.

Once LayerZero verifies the message, its executor delivers it on Mainnet and the USDe is released to the Mainnet Timelock.
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

  async enacted(deploymentManager: DeploymentManager): Promise<boolean> {
    return true;
  },

  async verify(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const {
      comet: mantleComet,
      timelock: mantleTimelock,
      USDe: mantleUSDe
    } = await deploymentManager.getContracts();

    const {
      timelock: mainnetTimelock,
      USDe: mainnetUSDe
    } = await govDeploymentManager.getContracts();

    // Comet's USDe balance dropped by exactly the withdrawn amount
    const mantleCometBalanceAfter = await mantleUSDe.balanceOf(mantleComet.address);
    expect(mantleCometBalanceBefore.sub(mantleCometBalanceAfter)).to.equal(WITHDRAW_AMOUNT);

    // The Mantle Timelock's USDe balance should remain the same as before the withdrawal (no USDe left)
    const mantleTimelockUsdeAfter = await mantleUSDe.balanceOf(mantleTimelock.address);
    expect(mantleTimelockUsdeBefore).to.equal(mantleTimelockUsdeAfter);

    // The same amount arrived at the Mainnet Timelock
    const mainnetTimelockUsdeAfter = await mainnetUSDe.balanceOf(mainnetTimelock.address);
    expect(mainnetTimelockUsdeAfter.sub(mainnetTimelockUsdeBefore)).to.equal(WITHDRAW_AMOUNT);
  },
});
