import { expect } from 'chai';
import { BigNumber, constants, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

const USDC_AMOUNT = exp(42_000, 6);
const WETH_AMOUNT = exp(90, 18);

const MAINNET_CCTP_DOMAIN = 0;

let unichainUsdcCometBalanceBefore: BigNumber;
let unichainWethCometBalanceBefore: BigNumber;

let unichainTimelockUsdcBefore: BigNumber;
let unichainTimelockWethBefore: BigNumber;

let unichainTimelockEthBefore: BigNumber;
let mainnetTimelockUsdcBefore: BigNumber;

let mainnetBlockBefore: number;

const formatAmount = (amount: BigNumber | bigint, decimals: number) =>
  Number(utils.formatUnits(amount, decimals)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default migration('1792073921_withdraw_reserves', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      unichainL1CrossDomainMessenger,
      timelock: mainnetTimelock,
      USDC: mainnetUSDC
    } = await govDeploymentManager.getContracts();

    const {
      bridgeReceiver,
      comet,
      timelock,
      USDC,
      l2StandardBridge,
      CCTPTokenMessenger
    } = await deploymentManager.getContracts();

    const unichainWethDm = await deploymentManager.addBridgedDeploymentManager('unichain', 'weth', deploymentManager.hre);
    const {
      comet: cometWeth,
      WETH
    } = await unichainWethDm.getContracts();

    unichainUsdcCometBalanceBefore = await USDC.balanceOf(comet.address);
    unichainWethCometBalanceBefore = await WETH.balanceOf(cometWeth.address);
    unichainTimelockUsdcBefore = await USDC.balanceOf(timelock.address);
    unichainTimelockWethBefore = await WETH.balanceOf(timelock.address);
    unichainTimelockEthBefore = await deploymentManager.hre.ethers.provider.getBalance(timelock.address);
    mainnetTimelockUsdcBefore = await mainnetUSDC.balanceOf(mainnetTimelock.address);
    mainnetBlockBefore = await govDeploymentManager.hre.ethers.provider.getBlockNumber();

    const usdcReserves = await comet.getReserves();
    const wethReserves = await cometWeth.getReserves();

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [comet.address, USDC.address, CCTPTokenMessenger.address, cometWeth.address, WETH.address, l2StandardBridge.address],
        [0, 0, 0, 0, 0, WETH_AMOUNT],
        [
          'withdrawReserves(address,uint256)',
          'approve(address,uint256)',
          'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
          'withdrawReserves(address,uint256)',
          'withdraw(uint256)',
          'bridgeETHTo(address,uint32,bytes)',
        ],
        [
          utils.defaultAbiCoder.encode(['address', 'uint256'], [timelock.address, USDC_AMOUNT]),
          utils.defaultAbiCoder.encode(['address', 'uint256'], [CCTPTokenMessenger.address, USDC_AMOUNT]),
          utils.defaultAbiCoder.encode(
            ['uint256', 'uint32', 'bytes32', 'address', 'bytes32', 'uint256', 'uint32'],
            [USDC_AMOUNT, MAINNET_CCTP_DOMAIN, utils.hexZeroPad(mainnetTimelock.address, 32), USDC.address, constants.HashZero, 0, 2000]
          ),
          utils.defaultAbiCoder.encode(['address', 'uint256'], [timelock.address, WETH_AMOUNT]),
          utils.defaultAbiCoder.encode(['uint256'], [WETH_AMOUNT]),
          utils.defaultAbiCoder.encode(['address', 'uint32', 'bytes'], [mainnetTimelock.address, 200_000, '0x']),
        ],
      ]
    );

    const mainnetActions = [
      {
        contract: unichainL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [bridgeReceiver.address, l2ProposalData, 3_000_000],
      },
    ];

    const description = `# Withdraw reserves from cUSDCv3 and cWETHv3 on Unichain

## Proposal summary

This proposal withdraws 42,000 USDC and 90 WETH of reserves from the Compound III USDC and WETH markets on Unichain and sends them to the Compound Timelock on Ethereum Mainnet. The USDC is bridged using Circle's CCTP, and the WETH is unwrapped to ETH and bridged using the Unichain native bridge.

Withdrawing the reserves is the final step of the deprecation process and secures the markets' protocol-owned funds by moving them to the Timelock on Mainnet.

## Reserves withdrawal

Reserves are the protocol-owned portion of a market's base asset: the Comet's base token balance plus outstanding borrows, minus what is owed to suppliers, as reported by \`getReserves()\`. They do not belong to any user, so withdrawing them does not change supplier or borrower balances. Only the governor of the market (the Unichain Timelock) can call \`withdrawReserves\`.

| Source | Amount |
| --- | --- |
| cUSDCv3 reserves at proposal creation (\`getReserves()\`) | ${formatAmount(usdcReserves, 6)} USDC |
| Withdrawn from cUSDCv3 and sent to the Mainnet Timelock | ${formatAmount(USDC_AMOUNT, 6)} USDC |
| cWETHv3 reserves at proposal creation (\`getReserves()\`) | ${formatAmount(wethReserves, 18)} WETH |
| Withdrawn from cWETHv3, unwrapped to ETH and sent to the Mainnet Timelock | ${formatAmount(WETH_AMOUNT, 18)} WETH |

The proposal does not withdraw all reserves. Both markets still have open borrow positions, so the remaining reserves are left as a buffer that keeps the markets solvent until those positions are repaid or liquidated. The rest can be withdrawn by a later proposal once they are closed.

## Proposal actions

The proposal action sends a message through the Unichain L1 Cross Domain Messenger to the Unichain Bridge Receiver, which queues the following calls on the Unichain Timelock:

1. Call \`withdrawReserves(address,uint256)\` on the Unichain cUSDCv3 to withdraw 42,000 USDC to the Unichain Timelock.
2. Approve the CCTP Token Messenger to spend 42,000 USDC from the Unichain Timelock.
3. Call \`depositForBurn\` on the CCTP Token Messenger to burn 42,000 USDC on Unichain and mint it to the Mainnet Timelock.
4. Call \`withdrawReserves(address,uint256)\` on the Unichain cWETHv3 to withdraw 90 WETH to the Unichain Timelock.
5. Call \`withdraw(uint256)\` on Unichain WETH to unwrap it to ETH.
6. Call \`bridgeETHTo\` on the L2 Standard Bridge to bridge 90 ETH to the Mainnet Timelock.

Once Circle attests the burn, the USDC is minted on Mainnet with \`receiveMessage\` on the CCTP Message Transmitter. The ETH withdrawal is proven and, after the challenge period, finalized on the Unichain Optimism Portal on Mainnet. Anyone can submit these transactions, and the funds can only be released to the Mainnet Timelock.
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
      comet: unichainUsdcComet,
      timelock: unichainTimelock,
      USDC: unichainUSDC,
      CCTPTokenMessenger: unichainCCTPTokenMessenger
    } = await deploymentManager.getContracts();

    const unichainWethDm = await deploymentManager.addBridgedDeploymentManager('unichain', 'weth', deploymentManager.hre);
    const {
      comet: unichainWethComet,
      WETH: unichainWETH
    } = await unichainWethDm.getContracts();

    const {
      timelock: mainnetTimelock,
      USDC: mainnetUSDC,
      unichainL1StandardBridge
    } = await govDeploymentManager.getContracts();

    // Comets' balances dropped by exactly the withdrawn amounts
    expect(unichainUsdcCometBalanceBefore.sub(await unichainUSDC.balanceOf(unichainUsdcComet.address))).to.equal(USDC_AMOUNT);
    expect(unichainWethCometBalanceBefore.sub(await unichainWETH.balanceOf(unichainWethComet.address))).to.equal(WETH_AMOUNT);

    // The Unichain Timelock's balances should remain the same as before the withdrawal (nothing left)
    expect(await unichainUSDC.balanceOf(unichainTimelock.address)).to.equal(unichainTimelockUsdcBefore);
    expect(await unichainWETH.balanceOf(unichainTimelock.address)).to.equal(unichainTimelockWethBefore);
    expect(await deploymentManager.hre.ethers.provider.getBalance(unichainTimelock.address)).to.equal(unichainTimelockEthBefore);

    // The Unichain Timelock bridged everything out; no allowance remains
    expect(await unichainUSDC.allowance(unichainTimelock.address, unichainCCTPTokenMessenger.address)).to.equal(0);

    // The same amounts arrived on the Mainnet Timelock
    const mainnetTimelockUsdcAfter = await mainnetUSDC.balanceOf(mainnetTimelock.address);
    expect(mainnetTimelockUsdcAfter.sub(mainnetTimelockUsdcBefore)).to.equal(USDC_AMOUNT);
    // Checked via the bridge event, since other open proposals can spend the Timelock's ETH in between
    const ethFinalized = await unichainL1StandardBridge.queryFilter(
      unichainL1StandardBridge.filters.ETHBridgeFinalized(unichainTimelock.address, mainnetTimelock.address),
      mainnetBlockBefore
    );
    expect(ethFinalized.length).to.equal(1);
    expect(ethFinalized[0]?.args?.amount).to.equal(WETH_AMOUNT);
  },
});
