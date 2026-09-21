import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

const USDC_DECIMALS = 6;
const WITHDRAW_AMOUNT = exp(100_000, USDC_DECIMALS);

// CCTP domain id of Ethereum Mainnet
const MAINNET_CCTP_DOMAIN = 0;

// Standard (finalized) transfer: no fee is charged, so maxFee can be 0
const CCTP_STANDARD_FINALITY_THRESHOLD = 2000;
const CCTP_MAX_FEE = 0;

let mainnetTimelockUsdcBefore: BigNumber;

export default migration('1789982387_withdraw_reserves', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      lineaMessageService,
      timelock: mainnetTimelock,
      USDC: mainnetUSDC,
    } = await govDeploymentManager.getContracts();

    mainnetTimelockUsdcBefore = await mainnetUSDC.balanceOf(mainnetTimelock.address);

    const {
      bridgeReceiver,
      comet,
      timelock: lineaTimelock,
      USDC,
      CCTPTokenMessenger,
    } = await deploymentManager.getContracts();

    // 1. Withdraw reserves from the Linea cUSDCv3 to the Linea Timelock
    const withdrawReservesCalldata = utils.defaultAbiCoder.encode(
      ['address', 'uint256'],
      [lineaTimelock.address, WITHDRAW_AMOUNT]
    );

    // 2. Approve the CCTP TokenMessenger to burn the withdrawn USDC
    const approveCalldata = utils.defaultAbiCoder.encode(
      ['address', 'uint256'],
      [CCTPTokenMessenger.address, WITHDRAW_AMOUNT]
    );

    // 3. Burn USDC on Linea; the same amount is minted to the Mainnet Timelock
    const depositForBurnCalldata = utils.defaultAbiCoder.encode(
      ['uint256', 'uint32', 'bytes32', 'address', 'bytes32', 'uint256', 'uint32'],
      [
        WITHDRAW_AMOUNT,                                   // amount
        MAINNET_CCTP_DOMAIN,                               // destinationDomain (Ethereum Mainnet)
        utils.hexZeroPad(mainnetTimelock.address, 32),     // mintRecipient
        USDC.address,                                      // burnToken
        utils.hexZeroPad('0x', 32),                        // destinationCaller (anyone can relay)
        CCTP_MAX_FEE,                                      // maxFee
        CCTP_STANDARD_FINALITY_THRESHOLD,                  // minFinalityThreshold
      ]
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          comet.address,
          USDC.address,
          CCTPTokenMessenger.address,
        ],
        [0, 0, 0],
        [
          'withdrawReserves(address,uint256)',
          'approve(address,uint256)',
          'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
        ],
        [
          withdrawReservesCalldata,
          approveCalldata,
          depositForBurnCalldata,
        ],
      ]
    );

    const mainnetActions = [
      // 1. Send message to Linea to withdraw 100K USDC from reserves and bridge it to the Mainnet Timelock via CCTP
      {
        contract: lineaMessageService,
        signature: 'sendMessage(address,uint256,bytes)',
        args: [bridgeReceiver.address, 0, l2ProposalData],
      },
    ];

    const description = `# Withdraw 100K USDC from the Linea cUSDCv3 reserves

## Proposal summary

This proposal withdraws 100,000 USDC from the reserves of the Compound III USDC market on Linea and bridges it back to the Compound Timelock on Ethereum Mainnet using Circle's native Cross-Chain Transfer Protocol (CCTP).

## Proposal actions

The first action sends a message through the Linea Message Service to the Linea Bridge Receiver, which queues the following calls on the Linea network:

1. Call \`withdrawReserves(address,uint256)\` on the Linea cUSDCv3 to withdraw 100,000 USDC to the Linea Timelock.
2. Approve the CCTP TokenMessenger to spend 100,000 USDC from the Linea Timelock.
3. Call \`depositForBurn\` on the CCTP TokenMessenger to burn the USDC on Linea and mint it to the Mainnet Timelock (CCTP standard transfer, no fee).

Once the Linea Timelock delay has passed and the queued transactions are executed, the USDC is minted to the Mainnet Timelock after the CCTP attestation is relayed on Ethereum Mainnet.`;

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
    const {
      comet, timelock: lineaTimelock,
      USDC,
      CCTPTokenMessenger
    } = await deploymentManager.getContracts();

    const {
      timelock: mainnetTimelock,
      USDC: mainnetUSDC
    } = await govDeploymentManager.getContracts();

    // Comet lost exactly the withdrawn amount of USDC
    const cometBalanceBefore = await USDC.balanceOf(comet.address, { blockTag: preMigrationBlockNumber });
    const cometBalanceAfter = await USDC.balanceOf(comet.address);
    expect(cometBalanceBefore.sub(cometBalanceAfter)).to.equal(WITHDRAW_AMOUNT);

    // The USDC did not stay on the Linea Timelock, it was burned through CCTP
    const timelockBalanceBefore = await USDC.balanceOf(lineaTimelock.address, { blockTag: preMigrationBlockNumber });
    expect(await USDC.balanceOf(lineaTimelock.address)).to.equal(timelockBalanceBefore);

    // The CCTP TokenMessenger has no allowance left
    expect(await USDC.allowance(lineaTimelock.address, CCTPTokenMessenger.address)).to.equal(0);

    // The withdrawn USDC was burned on Linea
    const totalSupplyBefore = await USDC.totalSupply({ blockTag: preMigrationBlockNumber });
    const totalSupplyAfter = await USDC.totalSupply();
    expect(totalSupplyBefore.sub(totalSupplyAfter)).to.equal(WITHDRAW_AMOUNT);

    // The same amount was minted to the Mainnet Timelock (simulated by the scenario relay, see relayLineaMessage.ts)
    const mainnetTimelockUsdcAfter = await mainnetUSDC.balanceOf(mainnetTimelock.address);
    expect(mainnetTimelockUsdcAfter.sub(mainnetTimelockUsdcBefore)).to.equal(WITHDRAW_AMOUNT);
  },
});
