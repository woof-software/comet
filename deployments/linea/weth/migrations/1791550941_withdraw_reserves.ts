import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';

// L2 -> L1 message fee, paid from the Linea Timelock's ETH
const MESSAGE_FEE = utils.parseEther('0.01');

let reservesWithdrawn: BigNumber;
let lineaTimelockEthBefore: BigNumber;
let mainnetTimelockEthBefore: BigNumber;

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

This proposal withdraws all currently held reserves (${utils.formatEther(reservesWithdrawn)} WETH) from the Compound III WETH market on Linea, following the deprecation. It then unwraps them to ETH, and sends the ETH to the Compound Timelock on Ethereum Mainnet through the Linea message service.

Linea WETH is native to Linea, so it's bridged as ETH through the message service rather than the token bridge. Once Linea finalizes the message on Mainnet, anyone can claim it, and the ETH is delivered to the Mainnet Timelock.

## Proposal actions

The proposal action sends a message through the Linea Message Service to the Linea Bridge Receiver, which queues the following calls on the Linea Timelock:

1. Call \`withdrawReserves(address,uint256)\` on the Linea cWETHv3 to withdraw ${utils.formatEther(reservesWithdrawn)} WETH to the Linea Timelock.
2. Call \`withdraw(uint256)\` on Linea WETH to unwrap it to ETH.
3. Call \`sendMessage\` on the Linea L2 Message Service to send ${utils.formatEther(reservesWithdrawn)} ETH to the Mainnet Timelock, paying a ${utils.formatEther(MESSAGE_FEE)} ETH message fee from the Linea Timelock's own ETH.
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

  async verify(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager, preMigrationBlockNumber: number) {
    const { comet, timelock, WETH } = await deploymentManager.getContracts();
    const { timelock: mainnetTimelock } = await govDeploymentManager.getContracts();

    // Comet paid out exactly the withdrawn reserves
    const cometWethBefore = await WETH.balanceOf(comet.address, { blockTag: preMigrationBlockNumber });
    expect(cometWethBefore.sub(await WETH.balanceOf(comet.address))).to.equal(reservesWithdrawn);

    // Everything was sent out; the Linea Timelock only spent the message fee
    expect(await WETH.balanceOf(timelock.address)).to.equal(0);
    const lineaTimelockEthAfter = await deploymentManager.hre.ethers.provider.getBalance(timelock.address);
    expect(lineaTimelockEthBefore.sub(lineaTimelockEthAfter)).to.equal(MESSAGE_FEE);

    // The reserves arrived on the Mainnet Timelock as ETH
    const mainnetTimelockEthAfter = await govDeploymentManager.hre.ethers.provider.getBalance(mainnetTimelock.address);
    expect(mainnetTimelockEthAfter.sub(mainnetTimelockEthBefore)).to.equal(reservesWithdrawn);
  },
});
