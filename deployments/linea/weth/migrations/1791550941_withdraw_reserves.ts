import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';

// L2 -> L1 message fee, paid from the Linea Timelock's ETH
const MESSAGE_FEE = utils.parseEther('0.01');

let reservesWithdrawn: BigNumber;
let lineaCometBalanceBefore: BigNumber;
let lineaTimelockWethBefore: BigNumber;
let lineaTimelockEthBefore: BigNumber;
let mainnetTimelockEthBefore: BigNumber;

const formatAmount = (amount: BigNumber | bigint, decimals = 18) =>
  Number(utils.formatUnits(amount, decimals)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default migration('1791550941_withdraw_reserves', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      lineaMessageService,
      timelock: mainnetTimelock
    } = await govDeploymentManager.getContracts();

    const {
      bridgeReceiver,
      comet,
      timelock,
      WETH,
      l2MessageService
    } = await deploymentManager.getContracts();

    reservesWithdrawn = await comet.getReserves();
    lineaCometBalanceBefore = await WETH.balanceOf(comet.address);
    lineaTimelockWethBefore = await WETH.balanceOf(timelock.address);
    lineaTimelockEthBefore = await deploymentManager.hre.ethers.provider.getBalance(timelock.address);
    mainnetTimelockEthBefore = await govDeploymentManager.hre.ethers.provider.getBalance(mainnetTimelock.address);

    // Linea WETH is native to Linea, so it's unwrapped and sent as ETH through the message service
    // rather than the token bridge, which would deliver a bridged copy instead of real ETH on Mainnet.
    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          comet.address,
          WETH.address,
          l2MessageService.address
        ],
        [
          0,
          0,
          reservesWithdrawn.add(MESSAGE_FEE)
        ],
        [
          'withdrawReserves(address,uint256)',
          'withdraw(uint256)',
          'sendMessage(address,uint256,bytes)',
        ],
        [
          utils.defaultAbiCoder.encode(['address', 'uint256'], [timelock.address, reservesWithdrawn]),
          utils.defaultAbiCoder.encode(['uint256'], [reservesWithdrawn]),
          utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [mainnetTimelock.address, MESSAGE_FEE, '0x']),
        ],
      ]
    );

    const mainnetActions = [
      {
        contract: lineaMessageService,
        signature: 'sendMessage(address,uint256,bytes)',
        args: [bridgeReceiver.address, 0, l2ProposalData],
      },
    ];

    const description = `# Withdraw reserves from cWETHv3 on Linea

## Proposal summary

This proposal withdraws all reserves from the Compound III WETH market on Linea, unwraps them to ETH, and sends the ETH to the Compound Timelock on Ethereum Mainnet through the Linea message service.

Withdrawing the reserves is the final step of the deprecation process and secures the market's protocol-owned funds by moving them to the Timelock on Mainnet.

## Reserves withdrawal

Reserves are the protocol-owned portion of the market's base asset: the Comet's WETH balance plus outstanding borrows, minus what is owed to suppliers, as reported by \`getReserves()\`. They do not belong to any user, so withdrawing them does not change supplier or borrower balances. Only the governor of the market (the Linea Timelock) can call \`withdrawReserves\`.

| Source | Amount |
| --- | --- |
| cWETHv3 reserves at proposal creation (\`getReserves()\`) | ${formatAmount(reservesWithdrawn)} WETH |
| Withdrawn, unwrapped to ETH and sent to the Mainnet Timelock | ${formatAmount(reservesWithdrawn)} WETH |

The proposal withdraws all reserves, since the market has no open borrow positions left to cover.

## Proposal actions

The proposal action sends a message through the Linea Message Service to the Linea Bridge Receiver, which queues the following calls on the Linea Timelock:

1. Call \`withdrawReserves(address,uint256)\` on the Linea cWETHv3 to withdraw ${formatAmount(reservesWithdrawn)} WETH to the Linea Timelock.
2. Call \`withdraw(uint256)\` on Linea WETH to unwrap it to ETH.
3. Call \`sendMessage\` on the Linea L2 Message Service to send ${formatAmount(reservesWithdrawn)} ETH to the Mainnet Timelock, paying a ${utils.formatEther(MESSAGE_FEE)} ETH message fee from the Linea Timelock's own ETH. Linea WETH is native to Linea, so it is sent as ETH through the message service rather than the token bridge.

Once Linea finalizes the message on Mainnet, it is claimed on the Linea message service on Mainnet with \`claimMessageWithProof\`. Anyone can submit the claim, and the ETH can only be released to the Mainnet Timelock.
`;

    const txn = await govDeploymentManager.retry(async () =>
      trace(await governor.propose(...(await proposal(mainnetActions, description)))), 0, 600_000
    );

    const event = txn.events.find((event: { event: string }) => event.event === 'ProposalCreated');
    const [proposalId] = event.args;
    trace(`Created proposal ${proposalId}.`);
  },

  async enacted(): Promise<boolean> {
    return false;
  },

  async verify(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const {
      comet: lineaComet,
      timelock: lineaTimelock,
      WETH: lineaWETH
    } = await deploymentManager.getContracts();

    const {
      timelock: mainnetTimelock
    } = await govDeploymentManager.getContracts();

    // Comet's WETH balance dropped by exactly the withdrawn reserves
    const lineaCometBalanceAfter = await lineaWETH.balanceOf(lineaComet.address);
    expect(lineaCometBalanceBefore.sub(lineaCometBalanceAfter)).to.equal(reservesWithdrawn);

    // The Linea Timelock's WETH balance should remain the same as before the withdrawal (no WETH left)
    const lineaTimelockWethAfter = await lineaWETH.balanceOf(lineaTimelock.address);
    expect(lineaTimelockWethBefore).to.equal(lineaTimelockWethAfter);

    // The Linea Timelock only spent the message fee from its own ETH
    const lineaTimelockEthAfter = await deploymentManager.hre.ethers.provider.getBalance(lineaTimelock.address);
    expect(lineaTimelockEthBefore.sub(lineaTimelockEthAfter)).to.equal(MESSAGE_FEE);

    // The reserves arrived on the Mainnet Timelock as ETH
    const mainnetTimelockEthAfter = await govDeploymentManager.hre.ethers.provider.getBalance(mainnetTimelock.address);
    expect(mainnetTimelockEthAfter.sub(mainnetTimelockEthBefore)).to.equal(reservesWithdrawn);
  },
});
