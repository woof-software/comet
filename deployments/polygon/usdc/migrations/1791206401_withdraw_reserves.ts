import { expect } from 'chai';
import { BigNumber, constants, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

const USDCE_AMOUNT = exp(470_000, 6);
const USDT_AMOUNT = exp(65_000, 6);

// Max loss per swap: 0.03% for USDC.e -> USDC, 0.15% for USDT -> USDC
const minOut = (amount: bigint, maxLossBps: number) => amount * BigInt(10000 - maxLossBps) / BigInt(10000);
const USDCE_MIN_OUT = minOut(USDCE_AMOUNT, 3);
const USDT_MIN_OUT = minOut(USDT_AMOUNT, 15);
const BURN_AMOUNT = USDCE_MIN_OUT + USDT_MIN_OUT;

const NATIVE_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

// https://developers.uniswap.org/docs/protocols/v4/deployments#polygon-137
const UNIVERSAL_ROUTER = '0x1095692A6237d83C6a72F3F5eFEdb9A670C49223';

const MAINNET_CCTP_DOMAIN = 0;

let polygonUsdcCometBalanceBefore: BigNumber;
let polygonUsdtCometBalanceBefore: BigNumber;
let polygonTimelockUsdceBefore: BigNumber;
let polygonTimelockUsdtBefore: BigNumber;
let mainnetTimelockUsdcBefore: BigNumber;

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
      USDC: mainnetUSDC
    } = await govDeploymentManager.getContracts();

    const {
      bridgeReceiver,
      comet,
      timelock,
      USDC: USDCe,
      CCTPTokenMessenger
    } = await deploymentManager.getContracts();

    const polygonUsdtDm = await deploymentManager.addBridgedDeploymentManager('polygon', 'usdt', deploymentManager.hre);
    const {
      comet: cometUsdt,
      USDT0: USDT,
    } = await polygonUsdtDm.getContracts();

    polygonUsdcCometBalanceBefore = await USDCe.balanceOf(comet.address);
    polygonUsdtCometBalanceBefore = await USDT.balanceOf(cometUsdt.address);
    polygonTimelockUsdceBefore = await USDCe.balanceOf(timelock.address);
    polygonTimelockUsdtBefore = await USDT.balanceOf(timelock.address);
    mainnetTimelockUsdcBefore = await mainnetUSDC.balanceOf(mainnetTimelock.address);

    const usdcReserves = await comet.getReserves();
    const usdtReserves = await cometUsdt.getReserves();

    // Both swaps on Uniswap V4, paid from the router's own balance (payerIsUser = false), funded by the transfers before it.
    // USDC.e -> USDC: pool 0xe3f907c3...052a4 (0.0013% fee, no hooks), USDC.e is currency0
    // USDT -> USDC: pool 0xa37d3e6d...a399 (0.0008% fee, no hooks), USDC is currency0
    const exactInputSingle = ['((address,address,uint24,int24,address),bool,uint128,uint128,bytes)'];
    const v4Swap = utils.defaultAbiCoder.encode(
      ['bytes', 'bytes[]'],
      [
        '0x060b060b0f', // V4 actions: SWAP_EXACT_IN_SINGLE + SETTLE (USDC.e), SWAP_EXACT_IN_SINGLE + SETTLE (USDT), TAKE_ALL (USDC to Timelock)
        [
          utils.defaultAbiCoder.encode(exactInputSingle, [[[USDCe.address, NATIVE_USDC, 13, 1, constants.AddressZero], true, USDCE_AMOUNT, USDCE_MIN_OUT, '0x']]),
          utils.defaultAbiCoder.encode(['address', 'uint256', 'bool'], [USDCe.address, USDCE_AMOUNT, false]),
          utils.defaultAbiCoder.encode(exactInputSingle, [[[NATIVE_USDC, USDT.address, 8, 1, constants.AddressZero], false, USDT_AMOUNT, USDT_MIN_OUT, '0x']]),
          utils.defaultAbiCoder.encode(['address', 'uint256', 'bool'], [USDT.address, USDT_AMOUNT, false]),
          utils.defaultAbiCoder.encode(['address', 'uint256'], [NATIVE_USDC, BURN_AMOUNT]),
        ],
      ]
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [comet.address, cometUsdt.address, USDCe.address, USDT.address, UNIVERSAL_ROUTER, NATIVE_USDC, CCTPTokenMessenger.address],
        [0, 0, 0, 0, 0, 0, 0],
        [
          'withdrawReserves(address,uint256)',
          'withdrawReserves(address,uint256)',
          'transfer(address,uint256)',
          'transfer(address,uint256)',
          'execute(bytes,bytes[])',
          'approve(address,uint256)',
          'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
        ],
        [
          utils.defaultAbiCoder.encode(['address', 'uint256'], [timelock.address, USDCE_AMOUNT]),
          utils.defaultAbiCoder.encode(['address', 'uint256'], [timelock.address, USDT_AMOUNT]),
          utils.defaultAbiCoder.encode(['address', 'uint256'], [UNIVERSAL_ROUTER, USDCE_AMOUNT]),
          utils.defaultAbiCoder.encode(['address', 'uint256'], [UNIVERSAL_ROUTER, USDT_AMOUNT]),
          utils.defaultAbiCoder.encode(['bytes', 'bytes[]'], ['0x10', [v4Swap]]), // Universal Router command: 0x10 V4_SWAP
          utils.defaultAbiCoder.encode(['address', 'uint256'], [CCTPTokenMessenger.address, BURN_AMOUNT]),
          utils.defaultAbiCoder.encode(
            ['uint256', 'uint32', 'bytes32', 'address', 'bytes32', 'uint256', 'uint32'],
            [BURN_AMOUNT, MAINNET_CCTP_DOMAIN, utils.hexZeroPad(mainnetTimelock.address, 32), NATIVE_USDC, constants.HashZero, 0, 2000]
          ),
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

This proposal withdraws 470,000 USDC.e and 65,000 USDT of reserves from the Compound III USDC and USDT markets on Polygon, swaps both into native USDC on Uniswap V4, and bridges it to the Compound Timelock on Ethereum Mainnet using Circle's CCTP.

Withdrawing the reserves is the final step of the deprecation process and secures the markets' protocol-owned funds by moving them to the Timelock on Mainnet.

## Reserves withdrawal

Reserves are the protocol-owned portion of a market's base asset: the Comet's base token balance plus outstanding borrows, minus what is owed to suppliers, as reported by \`getReserves()\`. They do not belong to any user, so withdrawing them does not change supplier or borrower balances. Only the governor of the market (the Polygon Timelock) can call \`withdrawReserves\`.

| Source | Amount |
| --- | --- |
| cUSDCv3 reserves at proposal creation (\`getReserves()\`) | ${formatAmount(usdcReserves)} USDC.e |
| Withdrawn from cUSDCv3 | ${formatAmount(USDCE_AMOUNT)} USDC.e |
| cUSDTv3 reserves at proposal creation (\`getReserves()\`) | ${formatAmount(usdtReserves)} USDT |
| Withdrawn from cUSDTv3 | ${formatAmount(USDT_AMOUNT)} USDT |

The proposal does not withdraw all reserves. Both markets still have open borrow positions, so the remaining ${formatAmount(usdcReserves.sub(USDCE_AMOUNT))} USDC.e and ${formatAmount(usdtReserves.sub(USDT_AMOUNT))} USDT are left as buffers that keep the markets solvent until those positions are repaid or liquidated. The rest can be withdrawn by a later proposal once they are closed. The withdrawal amounts are fixed in the proposal calldata.

## Swaps

Both swaps go through the Uniswap Universal Router in a single call, each through one Uniswap V4 pool with no hooks:

| Swap | Pool fee | Max loss | Minimum USDC out |
| --- | --- | --- | --- |
| ${formatAmount(USDCE_AMOUNT)} USDC.e -> USDC | 0.0013% | 0.03% | ${formatAmount(USDCE_MIN_OUT)} |
| ${formatAmount(USDT_AMOUNT)} USDT -> USDC | 0.0008% | 0.15% | ${formatAmount(USDT_MIN_OUT)} |

If either swap would return less than its minimum, the whole proposal execution reverts. The sum of both minimums (${formatAmount(BURN_AMOUNT)} USDC) is bridged; any swap output above that stays on the Polygon Timelock.

## Proposal actions

The proposal action sends a message through Polygon's FxRoot to the Polygon Bridge Receiver, which queues the following calls on the Polygon Timelock:

1. Withdraw ${formatAmount(USDCE_AMOUNT)} USDC.e from the Polygon cUSDCv3 reserves.
2. Withdraw ${formatAmount(USDT_AMOUNT)} USDT from the Polygon cUSDTv3 reserves.
3. Transfer the USDC.e and USDT to the Uniswap Universal Router.
4. Call \`execute\` on the Universal Router to swap both into native USDC, delivered to the Polygon Timelock.
5. Approve and call \`depositForBurn\` on the CCTP TokenMessenger to burn ${formatAmount(BURN_AMOUNT)} USDC on Polygon (CCTP standard transfer, no fee).

The USDC is minted to the Mainnet Timelock once Circle's attestation for the burn is relayed on Ethereum Mainnet.
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

    const {
      timelock: mainnetTimelock,
      USDC: mainnetUSDC
    } = await govDeploymentManager.getContracts();

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

    // Everything withdrawn was swapped; the Polygon Timelock's USDC.e and USDT balances remain the same as before
    const polygonTimelockUsdceAfter = await polygonUSDCe.balanceOf(polygonTimelock.address);
    expect(polygonTimelockUsdceBefore).to.equal(polygonTimelockUsdceAfter);

    const polygonTimelockUsdtAfter = await polygonUSDT.balanceOf(polygonTimelock.address);
    expect(polygonTimelockUsdtBefore).to.equal(polygonTimelockUsdtAfter);

    // The burned amount was minted to the Mainnet Timelock
    const mainnetTimelockUsdcAfter = await mainnetUSDC.balanceOf(mainnetTimelock.address);
    expect(mainnetTimelockUsdcAfter.sub(mainnetTimelockUsdcBefore)).to.equal(BURN_AMOUNT);
  },
});
