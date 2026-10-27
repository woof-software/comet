import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

const USDCE_AMOUNT = exp(470_000, 6);
const USDT_AMOUNT = exp(65_000, 6);

// Max loss for USDC.e -> USDT: 470 USDT (0.1%)
const USDCE_MIN_OUT = USDCE_AMOUNT - exp(470, 6);
const BRIDGE_AMOUNT = USDT_AMOUNT + USDCE_MIN_OUT;

// https://docs.uniswap.org/contracts/v3/reference/deployments/polygon-deployments
const SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
// Uniswap V3 USDC.e/USDT pool 0xDaC8A8E6DBf8c690ec6815e0fF03491B2770255D
const POOL_FEE = 100;

const USDT0_OFT = '0x6BA10300f0DC58B7a1e4c0e41f5daBb7D7829e13';
const MAINNET_EID = 30101;
const MAINNET_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

// Fixed LayerZero fee; the endpoint refunds the excess over the real fee
const POL_FEE = utils.parseEther('10');

let polygonUsdcCometBalanceBefore: BigNumber;
let polygonUsdtCometBalanceBefore: BigNumber;
let polygonTimelockUsdceBefore: BigNumber;
let polygonTimelockUsdtBefore: BigNumber;
let mainnetTimelockUsdtBefore: BigNumber;

const formatAmount = (amount: BigNumber | bigint, decimals = 6) =>
  Number(utils.formatUnits(amount, decimals)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default migration('1791206401_withdraw_reserves', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      fxRoot,
      timelock: mainnetTimelock,
    } = await govDeploymentManager.getContracts();

    const {
      bridgeReceiver,
      comet,
      timelock,
      USDC: USDCe,
    } = await deploymentManager.getContracts();

    const polygonUsdtDm = await deploymentManager.addBridgedDeploymentManager('polygon', 'usdt', deploymentManager.hre);
    const {
      comet: cometUsdt,
      USDT0: USDT,
    } = await polygonUsdtDm.getContracts();

    const mainnetUSDT = await govDeploymentManager.hre.ethers.getContractAt('ERC20', MAINNET_USDT);

    polygonUsdcCometBalanceBefore = await USDCe.balanceOf(comet.address);
    polygonUsdtCometBalanceBefore = await USDT.balanceOf(cometUsdt.address);
    polygonTimelockUsdceBefore = await USDCe.balanceOf(timelock.address);
    polygonTimelockUsdtBefore = await USDT.balanceOf(timelock.address);
    mainnetTimelockUsdtBefore = await mainnetUSDT.balanceOf(mainnetTimelock.address);

    const usdcReserves = await comet.getReserves();
    const usdtReserves = await cometUsdt.getReserves();

    // SwapRouter02 exactInputSingle has no deadline
    const swapCalldata = utils.defaultAbiCoder.encode(
      ['(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)'],
      [[USDCe.address, USDT.address, POOL_FEE, timelock.address, USDCE_AMOUNT, USDCE_MIN_OUT, 0]]
    );

    // USDT on Polygon is USDT0: its OFT burns from the sender directly, so no approval is needed
    const sendCalldata = utils.defaultAbiCoder.encode(
      [
        '(uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) sendParam',
        '(uint256 nativeFee,uint256 lzTokenFee) fee',
        'address refundAddress',
      ],
      [
        [MAINNET_EID, utils.hexZeroPad(mainnetTimelock.address, 32), BRIDGE_AMOUNT, BRIDGE_AMOUNT, '0x', '0x', '0x'],
        [POL_FEE, 0],
        timelock.address,
      ]
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [comet.address, cometUsdt.address, USDCe.address, SWAP_ROUTER_02, USDT0_OFT],
        [0, 0, 0, 0, POL_FEE],
        [
          'withdrawReserves(address,uint256)',
          'withdrawReserves(address,uint256)',
          'approve(address,uint256)',
          'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
          'send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)',
        ],
        [
          utils.defaultAbiCoder.encode(['address to', 'uint256 amount'], [timelock.address, USDCE_AMOUNT]),
          utils.defaultAbiCoder.encode(['address to', 'uint256 amount'], [timelock.address, USDT_AMOUNT]),
          utils.defaultAbiCoder.encode(['address spender', 'uint256 amount'], [SWAP_ROUTER_02, USDCE_AMOUNT]),
          swapCalldata,
          sendCalldata,
        ],
      ]
    );

    const mainnetActions = [
      {
        contract: fxRoot,
        signature: 'sendMessageToChild(address,bytes)',
        args: [bridgeReceiver.address, l2ProposalData],
      },
    ];

    const description = `# Withdraw reserves from cUSDCv3 and cUSDTv3 on Polygon

## Proposal summary

This proposal withdraws 470,000 USDC.e and 65,000 USDT of reserves from the Compound III USDC and USDT markets on Polygon, swaps the USDC.e into USDT on Uniswap V3, and sends the USDT to the Compound Timelock on Ethereum Mainnet using LayerZero's OFT standard.

Withdrawing the reserves is the final step of the deprecation process and secures the markets' protocol-owned funds by moving them to the Timelock on Mainnet.

## Reserves withdrawal

Reserves are the protocol-owned portion of a market's base asset: the Comet's base token balance plus outstanding borrows, minus what is owed to suppliers, as reported by \`getReserves()\`. They do not belong to any user, so withdrawing them does not change supplier or borrower balances. Only the governor of the market (the Polygon Timelock) can call \`withdrawReserves\`.

| Source | Amount |
| --- | --- |
| cUSDCv3 reserves at proposal creation (\`getReserves()\`) | ${formatAmount(usdcReserves)} USDC.e |
| Withdrawn from cUSDCv3 and swapped to USDT | ${formatAmount(USDCE_AMOUNT)} USDC.e |
| cUSDTv3 reserves at proposal creation (\`getReserves()\`) | ${formatAmount(usdtReserves)} USDT |
| Withdrawn from cUSDTv3 | ${formatAmount(USDT_AMOUNT)} USDT |

The proposal does not withdraw all reserves. Both markets still have open borrow positions, so the remaining USDC.e and USDT are left as buffers that keep the markets solvent until those positions are repaid or liquidated. The rest can be withdrawn by a later proposal once they are closed.

## Swap

The USDC.e is swapped into USDT through the Uniswap V3 USDC.e/USDT pool (0.01% fee) using SwapRouter02. USDT trades at a small discount to USDC.e on Polygon, so the swap is expected to return slightly more USDT than the USDC.e it spends.

| Swap | Max loss % |
| --- | --- |
| ${formatAmount(USDCE_AMOUNT)} USDC.e -> USDT | 0.1% |

If the swap would return less than the minimum, the whole proposal execution reverts. The withdrawn USDT plus the swap minimum is bridged; any swap output above the minimum stays on the Polygon Timelock and can be withdrawn later.

## Proposal actions

The proposal action sends a message through Polygon's FxRoot to the Polygon Bridge Receiver, which queues the following calls on the Polygon Timelock:

1. Withdraw 470,000 USDC.e from the Polygon cUSDCv3 reserves.
2. Withdraw 65,000 USDT from the Polygon cUSDTv3 reserves.
3. Approve SwapRouter02 to spend 470,000 USDC.e.
4. Call \`exactInputSingle\` on SwapRouter02 to swap 470,000 USDC.e into USDT, delivered to the Polygon Timelock.
5. Call \`send\` on the USDT0 OFT to send ${formatAmount(BRIDGE_AMOUNT)} USDT to the Mainnet Timelock. USDT on Polygon is USDT0: it is burned on Polygon and released on Mainnet by the USDT0 OFT adapter, so no approval is needed. The LayerZero messaging fee is paid in native POL from the Polygon Timelock's balance: a fixed ${formatAmount(POL_FEE, 18)} POL, well above the current fee, so the call still succeeds if the fee rises before execution. The LayerZero endpoint refunds any excess over the actual fee to the Polygon Timelock.

Once LayerZero verifies the message, its executor delivers it on Mainnet and the USDT is released to the Mainnet Timelock.
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
      comet: polygonUsdcComet,
      timelock: polygonTimelock,
      USDC: polygonUSDCe
    } = await deploymentManager.getContracts();

    const { timelock: mainnetTimelock } = await govDeploymentManager.getContracts();
    const mainnetUSDT = await govDeploymentManager.hre.ethers.getContractAt('ERC20', MAINNET_USDT);

    const polygonUsdtDm = deploymentManager.bridgedDeploymentManagers.get('polygon:usdt') as DeploymentManager;
    const {
      comet: polygonUsdtComet,
      USDT0: polygonUSDT
    } = await polygonUsdtDm.getContracts();

    // Both Comets' balances dropped by exactly the withdrawn amounts
    const polygonUsdcCometBalanceAfter = await polygonUSDCe.balanceOf(polygonUsdcComet.address);
    expect(polygonUsdcCometBalanceBefore.sub(polygonUsdcCometBalanceAfter)).to.equal(USDCE_AMOUNT);

    const polygonUsdtCometBalanceAfter = await polygonUSDT.balanceOf(polygonUsdtComet.address);
    expect(polygonUsdtCometBalanceBefore.sub(polygonUsdtCometBalanceAfter)).to.equal(USDT_AMOUNT);

    // All USDC.e was swapped; only the swap output above the minimum is left as USDT on the Polygon Timelock
    const polygonTimelockUsdceAfter = await polygonUSDCe.balanceOf(polygonTimelock.address);
    expect(polygonTimelockUsdceBefore).to.equal(polygonTimelockUsdceAfter);

    const polygonTimelockUsdtAfter = await polygonUSDT.balanceOf(polygonTimelock.address);
    expect(polygonTimelockUsdtAfter).to.be.gte(polygonTimelockUsdtBefore);

    // The bridged amount was released to the Mainnet Timelock
    const mainnetTimelockUsdtAfter = await mainnetUSDT.balanceOf(mainnetTimelock.address);
    expect(mainnetTimelockUsdtAfter.sub(mainnetTimelockUsdtBefore)).to.equal(BRIDGE_AMOUNT);
  },
});
