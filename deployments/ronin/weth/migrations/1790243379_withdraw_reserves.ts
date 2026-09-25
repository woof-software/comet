import { expect } from 'chai';
import { BigNumber, constants, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';

const destinationChainSelector = '6916147374840168594'; // Ronin
const mainnetChainSelector = '5009297550715157269'; // Ethereum Mainnet

const GHO_STABLE_TOKEN = '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f';

const GHO_FEE_BUFFER_MULTIPLIER = 2;
const RON_FEE_BUFFER_MULTIPLIER = 3;

let reservesWithdrawn: BigNumber;
let bridgeReceiverSwept: BigNumber;
let mainnetTimelockWethBefore: BigNumber;

export default migration('1790243379_withdraw_reserves', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      bridgeReceiver,
      comet,
      timelock,
      WETH,
      l2CCIPRouter,
    } = await deploymentManager.getContracts();

    const {
      governor,
      l1CCIPRouter,
      timelock: mainnetTimelock,
      WETH: mainnetWETH,
    } = await govDeploymentManager.getContracts();

    mainnetTimelockWethBefore = await mainnetWETH.balanceOf(mainnetTimelock.address);

    // Everything currently withdrawable from the Comet's reserves, and everything already sitting on the
    // bridge receiver (e.g. from historical fee overpayments). Both are read live so the proposal always
    // targets the full amount available at the moment it is created.
    reservesWithdrawn = await comet.getReserves();
    bridgeReceiverSwept = await WETH.balanceOf(bridgeReceiver.address);
    const totalToBridge = reservesWithdrawn.add(bridgeReceiverSwept);

    // 1. Withdraw all reserves from the Ronin cWETHv3 to the Ronin Timelock
    const withdrawReservesCalldata = utils.defaultAbiCoder.encode(
      ['address', 'uint256'],
      [timelock.address, reservesWithdrawn]
    );

    // 2. Sweep whatever WETH is sitting on the bridge receiver to the Ronin Timelock
    const sweepTokenCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [timelock.address, WETH.address]
    );

    // 3. Approve the L2 CCIP router to pull the full amount for bridging
    const approveCalldata = utils.defaultAbiCoder.encode(
      ['address', 'uint256'],
      [l2CCIPRouter.address, totalToBridge]
    );

    // 4. Bridge everything back to the Mainnet Timelock via CCIP, paying the fee in native RON
    const ccipMessage = [
      utils.defaultAbiCoder.encode(['address'], [mainnetTimelock.address]), // receiver
      '0x', // data
      [[WETH.address, totalToBridge]], // tokenAmounts
      constants.AddressZero, // feeToken (native RON)
      '0x', // extraArgs
    ];

    const ronFee = await l2CCIPRouter.getFee(mainnetChainSelector, ccipMessage);
    const ronFeeWithBuffer = ronFee.mul(RON_FEE_BUFFER_MULTIPLIER);

    const ccipSendCalldata = utils.defaultAbiCoder.encode(
      ['uint64', '(bytes,bytes,(address,uint256)[],address,bytes)'],
      [mainnetChainSelector, ccipMessage]
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          comet.address,
          bridgeReceiver.address,
          WETH.address,
          l2CCIPRouter.address,
        ],
        [
          0,
          0,
          0,
          ronFeeWithBuffer,
        ],
        [
          'withdrawReserves(address,uint256)',
          'sweepToken(address,address)',
          'approve(address,uint256)',
          'ccipSend(uint64,(bytes,bytes,(address,uint256)[],address,bytes))',
        ],
        [
          withdrawReservesCalldata,
          sweepTokenCalldata,
          approveCalldata,
          ccipSendCalldata,
        ],
      ]
    );

    const ghoFee = await l1CCIPRouter.getFee(destinationChainSelector, [
      utils.defaultAbiCoder.encode(['address'], [bridgeReceiver.address]),
      l2ProposalData,
      [],
      GHO_STABLE_TOKEN,
      '0x'
    ]);
    const ghoFeeWithBuffer = ghoFee.mul(GHO_FEE_BUFFER_MULTIPLIER);
    const mainnetActions = [
      // 1. Approve GHO stable token transfer to pay for the proposal execution fee on Ronin.
      {
        target: GHO_STABLE_TOKEN,
        signature: 'approve(address,uint256)',
        calldata: utils.defaultAbiCoder.encode(['address', 'uint256'], [l1CCIPRouter.address, ghoFeeWithBuffer])
      },
      // 2. Send the withdrawal/sweep/bridge instructions to the governance receiver on Ronin.
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
              GHO_STABLE_TOKEN,
              '0x'
            ]
          ],
      },
    ];

    const description = `# Withdraw reserves from cWETHv3 on Ronin

## Proposal summary

This proposal withdraws all reserves from the Compound III WETH market on Ronin following the deprecation. The proposal also sweeps any WETH already sitting on the Ronin governance bridge receiver, and bridges everything back to the Compound Timelock on Ethereum Mainnet using Chainlink's CCIP.

## Proposal actions

The first proposal action approves the L1CCIPRouter to transfer GHO stable token from the Timelock to pay for the proposal execution fee on Ronin.

The second proposal action sends a message through CCIP to the Ronin governance receiver, which queues the following calls on the Ronin Timelock:

1. Call \`withdrawReserves(address,uint256)\` on the Ronin cWETHv3 to withdraw all reserves to the Ronin Timelock.
2. Call \`sweepToken(address,address)\` on the bridge receiver to sweep any WETH held there to the Ronin Timelock.
3. Approve the L2 CCIP router to spend the combined WETH amount from the Ronin Timelock.
4. Call \`ccipSend\` on the L2 CCIP router to bridge the WETH back to the Mainnet Timelock, paying the CCIP fee in native RON from the Ronin Timelock's own balance.
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
    const { comet, bridgeReceiver, timelock, WETH } = await deploymentManager.getContracts();
    const { timelock: mainnetTimelock, WETH: mainnetWETH } = await govDeploymentManager.getContracts();

    // Comet's WETH balance dropped by exactly the withdrawn reserves
    const cometBalanceBefore = await WETH.balanceOf(comet.address, { blockTag: preMigrationBlockNumber });
    const cometBalanceAfter = await WETH.balanceOf(comet.address);
    expect(cometBalanceBefore.sub(cometBalanceAfter)).to.equal(reservesWithdrawn);

    expect(await WETH.balanceOf(bridgeReceiver.address)).to.equal(0);

    expect(await WETH.balanceOf(timelock.address)).to.equal(0);

    const totalBridged = reservesWithdrawn.add(bridgeReceiverSwept);
    const mainnetTimelockWethAfter = await mainnetWETH.balanceOf(mainnetTimelock.address);
    expect(mainnetTimelockWethAfter.sub(mainnetTimelockWethBefore)).to.equal(totalBridged);
  },
});
