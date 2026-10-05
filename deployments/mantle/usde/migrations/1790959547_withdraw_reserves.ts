import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

const WITHDRAW_AMOUNT = exp(205_000, 18);

const MAINNET_EID = 30101;

const MNT_FEE_BUFFER_MULTIPLIER = 3;

let mainnetTimelockUsdeBefore: BigNumber;

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

    mainnetTimelockUsdeBefore = await mainnetUSDe.balanceOf(mainnetTimelock.address);

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
    const quotedFee = await USDe.quoteSend(sendParam, false);
    const feeWithBuffer = quotedFee.nativeFee.mul(MNT_FEE_BUFFER_MULTIPLIER);

    const sendCalldata = utils.defaultAbiCoder.encode(
      ['(uint32,bytes32,uint256,uint256,bytes,bytes,bytes)', '(uint256,uint256)', 'address'],
      [sendParam, [feeWithBuffer, 0], timelock.address]
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          comet.address,
          USDe.address,
        ],
        [0, feeWithBuffer],
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

    const description = `# Withdraw 205,000 USDe from cUSDEv3 reserves on Mantle

## Proposal summary

This proposal withdraws 205,000 USDe from the reserves of the Compound III USDe market on Mantle and sends it to the Compound Timelock on Ethereum Mainnet using LayerZero's OFT standard.

## Proposal actions

The proposal action sends a message through the Mantle L1 Cross Domain Messenger to the Mantle Bridge Receiver, which queues the following calls on the Mantle Timelock:

1. Call \`withdrawReserves(address,uint256)\` on the Mantle cUSDEv3 to withdraw 205,000 USDe to the Mantle Timelock.
2. Call \`send\` on USDe (a LayerZero OFT) to send the withdrawn USDe to the Mainnet Timelock.
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
    const { comet, timelock, USDe } = await deploymentManager.getContracts();
    const { timelock: mainnetTimelock, USDe: mainnetUSDe } = await govDeploymentManager.getContracts();

    // Comet's USDe balance dropped by exactly the withdrawn amount
    const cometBalanceBefore = await USDe.balanceOf(comet.address, { blockTag: preMigrationBlockNumber });
    const cometBalanceAfter = await USDe.balanceOf(comet.address);
    expect(cometBalanceBefore.sub(cometBalanceAfter)).to.equal(WITHDRAW_AMOUNT);

    // The Mantle Timelock sent everything out; nothing was left behind
    expect(await USDe.balanceOf(timelock.address)).to.equal(0);

    // The same amount arrived at the Mainnet Timelock
    const mainnetTimelockUsdeAfter = await mainnetUSDe.balanceOf(mainnetTimelock.address);
    expect(mainnetTimelockUsdeAfter.sub(mainnetTimelockUsdeBefore)).to.equal(WITHDRAW_AMOUNT);
  },
});
