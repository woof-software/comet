import { expect } from 'chai';
import { BigNumber, constants, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

const USDCE_AMOUNT = exp(470_000, 6);
const USDT_AMOUNT = exp(65_000, 6);

// 1-of-2 Safe owned by the Timelock and the operator, same address on Polygon and Mainnet
const SAFE = '0xD28d21422f5fA74E3d4414626c774bDA274b7Ca9';
// Contract that pulls the USDC reserves from the Safe to the Mainnet Timelock once
const RESERVES_TRANSFER_CONTRACT = '0x6472d31e775B6a736fB3fB00208B470C5Db14fCF';

const USDT0_OFT = '0x6BA10300f0DC58B7a1e4c0e41f5daBb7D7829e13';
const MAINNET_EID = 30101;
const MAINNET_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const MAINNET_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

// Fixed LayerZero fee, paid from the Polygon Timelock's POL balance; the endpoint refunds the excess over the real fee
const POL_FEE = utils.parseEther('10');

let polygonUsdcCometBalanceBefore: BigNumber;
let polygonUsdtCometBalanceBefore: BigNumber;
let polygonSafeUsdceBefore: BigNumber;
let polygonTimelockUsdtBefore: BigNumber;
let mainnetTimelockUsdtBefore: BigNumber;

const SAFE_EXEC_TRANSACTION_SIGNATURE = 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)';

// execTransaction args for a call made by a Safe owner directly: a pre-validated signature (r = owner, s = 0, v = 1) suffices
const encodeSafeOwnerExec = (owner: string, to: string, data: string) =>
  utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'bytes', 'uint8', 'uint256', 'uint256', 'uint256', 'address', 'address', 'bytes'],
    [to, 0, data, 0, 0, 0, 0, constants.AddressZero, constants.AddressZero, utils.hexConcat([utils.hexZeroPad(owner, 32), constants.HashZero, '0x01'])]
  );

const formatAmount =(amount: BigNumber | bigint, decimals = 6) =>
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
    polygonSafeUsdceBefore = await USDCe.balanceOf(SAFE);
    polygonTimelockUsdtBefore = await USDT.balanceOf(timelock.address);
    mainnetTimelockUsdtBefore = await mainnetUSDT.balanceOf(mainnetTimelock.address);

    const usdcReserves = await comet.getReserves();
    const usdtReserves = await cometUsdt.getReserves();

    // USDT on Polygon is USDT0: its OFT burns from the sender directly, so no approval is needed
    const sendCalldata = utils.defaultAbiCoder.encode(
      [
        '(uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) sendParam',
        '(uint256 nativeFee,uint256 lzTokenFee) fee',
        'address refundAddress',
      ],
      [
        [MAINNET_EID, utils.hexZeroPad(mainnetTimelock.address, 32), USDT_AMOUNT, USDT_AMOUNT, '0x', '0x', '0x'],
        [POL_FEE, 0],
        timelock.address,
      ]
    );

    // The Polygon Safe burns the USDC.e through the PoS bridge, released to the Mainnet Safe after the checkpoint
    const usdcePoSWithdrawCalldata = new utils.Interface(['function withdraw(uint256)'])
      .encodeFunctionData('withdraw', [USDCE_AMOUNT]);

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [comet.address, SAFE, cometUsdt.address, USDT0_OFT],
        [0, 0, 0, POL_FEE],
        [
          'withdrawReserves(address,uint256)',
          SAFE_EXEC_TRANSACTION_SIGNATURE,
          'withdrawReserves(address,uint256)',
          'send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)',
        ],
        [
          utils.defaultAbiCoder.encode(['address to', 'uint256 amount'], [SAFE, USDCE_AMOUNT]),
          encodeSafeOwnerExec(timelock.address, USDCe.address, usdcePoSWithdrawCalldata),
          utils.defaultAbiCoder.encode(['address to', 'uint256 amount'], [timelock.address, USDT_AMOUNT]),
          sendCalldata,
        ],
      ]
    );

    const safeApproveCalldata = new utils.Interface(['function approve(address,uint256)'])
      .encodeFunctionData('approve', [RESERVES_TRANSFER_CONTRACT, USDCE_AMOUNT]);

    const mainnetActions = [
      {
        target: SAFE,
        signature: SAFE_EXEC_TRANSACTION_SIGNATURE,
        calldata: encodeSafeOwnerExec(mainnetTimelock.address, MAINNET_USDC, safeApproveCalldata),
      },
      {
        contract: fxRoot,
        signature: 'sendMessageToChild(address,bytes)',
        args: [bridgeReceiver.address, l2ProposalData],
      },
    ];

    const description = `# Withdraw reserves from cUSDCv3 and cUSDTv3 on Polygon

## Proposal summary

This proposal withdraws 470,000 USDC.e and 65,000 USDT of reserves from the Compound III USDC and USDT markets on Polygon and moves them to the Compound Timelock on Ethereum Mainnet.

- The USDT is sent directly to the Mainnet Timelock using LayerZero's OFT standard.
- The USDC.e is withdrawn to a Safe, which bridges it to Mainnet through the Polygon PoS bridge in the same execution. A single-use transfer contract, approved by the Mainnet Safe in this proposal, then pulls it from the Safe to the Mainnet Timelock.

## Reserves withdrawal

Reserves are the protocol-owned portion of a market's base asset: the Comet's base token balance plus outstanding borrows, minus what is owed to suppliers, as reported by \`getReserves()\`. They do not belong to any user, so withdrawing them does not change supplier or borrower balances. Only the governor of the market (the Polygon Timelock) can call \`withdrawReserves\`.

| Source | Amount |
| --- | --- |
| cUSDCv3 reserves at proposal creation (\`getReserves()\`) | ${formatAmount(usdcReserves)} USDC.e |
| Withdrawn from cUSDCv3 to the Safe | ${formatAmount(USDCE_AMOUNT)} USDC.e |
| cUSDTv3 reserves at proposal creation (\`getReserves()\`) | ${formatAmount(usdtReserves)} USDT |
| Withdrawn from cUSDTv3 and sent to the Mainnet Timelock | ${formatAmount(USDT_AMOUNT)} USDT |

The proposal does not withdraw all reserves. Both markets still have open borrow positions, so the rest is left in the markets and can be withdrawn by a later proposal.

## USDC.e path

USDC.e is not a LayerZero OFT, so it is withdrawn to the Safe [${SAFE}](https://polygonscan.com/address/${SAFE}). The Safe has the same address on Polygon and Mainnet, and on each chain its owners are the local Compound Timelock and the operator, with a threshold of 1.

This proposal has the Mainnet Safe approve the transfer contract [${RESERVES_TRANSFER_CONTRACT}](https://etherscan.io/address/${RESERVES_TRANSFER_CONTRACT}) to spend 470,000 USDC. The contract has no owner and holds only constants: the USDC address, the Safe address, the Mainnet Timelock address and the amount.

On Polygon, the proposal has the Safe burn the USDC.e through the Polygon PoS bridge. Once the burn is included in a checkpoint on Mainnet, anyone can complete the exit with \`RootChainManager.exit\`, which releases it 1:1 as USDC to the Mainnet Safe. Anyone can then call \`transfer()\` on the contract once to move exactly 470,000 USDC from the Safe to the Mainnet Timelock; after that a flag blocks any further call.

## Proposal actions

The first proposal action calls \`execTransaction\` on the Mainnet Safe, through which the Safe approves the transfer contract to spend 470,000 USDC. The Mainnet Timelock is a Safe owner and the threshold is 1, so it executes the Safe transaction directly with a pre-validated owner signature.

The second proposal action sends a message through Polygon's FxRoot to the Polygon Bridge Receiver, which queues the following calls on the Polygon Timelock:

1. Withdraw 470,000 USDC.e from the Polygon cUSDCv3 reserves to the Safe.
2. Call \`execTransaction\` on the Polygon Safe, through which the Safe calls \`withdraw\` on USDC.e to burn the 470,000 USDC.e through the Polygon PoS bridge. The Polygon Timelock is a Safe owner and the threshold is 1, so it executes the Safe transaction directly with a pre-validated owner signature.
3. Withdraw 65,000 USDT from the Polygon cUSDTv3 reserves to the Polygon Timelock.
4. Call \`send\` on the USDT0 OFT to send 65,000 USDT to the Mainnet Timelock. USDT on Polygon is USDT0: it is burned on Polygon and released on Mainnet by the USDT0 OFT adapter, so no approval is needed. The LayerZero messaging fee is paid in native POL from the Polygon Timelock's balance: a fixed ${formatAmount(POL_FEE, 18)} POL is sent with the call, well above the current fee, so the call still succeeds if the fee rises before execution. The LayerZero endpoint refunds any excess over the actual fee to the Polygon Timelock.

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
    const mainnetUSDC = await govDeploymentManager.hre.ethers.getContractAt('ERC20', MAINNET_USDC);
    const mainnetUSDT = await govDeploymentManager.hre.ethers.getContractAt('ERC20', MAINNET_USDT);
    const polygonReservesTransfer = await govDeploymentManager.hre.ethers.getContractAt(
      [
        'function USDC() view returns (address)',
        'function SAFE() view returns (address)',
        'function TIMELOCK() view returns (address)',
        'function AMOUNT() view returns (uint256)',
        'function transferred() view returns (bool)',
        'function transfer()',
      ],
      RESERVES_TRANSFER_CONTRACT
    );

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

    // The USDC.e went to the Safe, which burned it for the PoS bridge exit
    const polygonSafeUsdceAfter = await polygonUSDCe.balanceOf(SAFE);
    expect(polygonSafeUsdceAfter).to.equal(polygonSafeUsdceBefore);

    // All withdrawn USDT was bridged and released to the Mainnet Timelock
    const polygonTimelockUsdtAfter = await polygonUSDT.balanceOf(polygonTimelock.address);
    expect(polygonTimelockUsdtAfter).to.equal(polygonTimelockUsdtBefore);

    const mainnetTimelockUsdtAfter = await mainnetUSDT.balanceOf(mainnetTimelock.address);
    expect(mainnetTimelockUsdtAfter.sub(mainnetTimelockUsdtBefore)).to.equal(USDT_AMOUNT);

    // The transfer contract is unused, points at the Safe and the Mainnet Timelock, and the Safe approved it
    expect(await polygonReservesTransfer.USDC()).to.equal(MAINNET_USDC);
    expect(await polygonReservesTransfer.SAFE()).to.equal(SAFE);
    expect(await polygonReservesTransfer.TIMELOCK()).to.equal(mainnetTimelock.address);
    expect(await polygonReservesTransfer.AMOUNT()).to.equal(USDCE_AMOUNT);
    expect(await polygonReservesTransfer.transferred()).to.equal(false);
    expect(await mainnetUSDC.allowance(SAFE, RESERVES_TRANSFER_CONTRACT)).to.equal(USDCE_AMOUNT);

    // Anyone can pull the reserves from the Safe once
    const caller = await govDeploymentManager.getSigner();

    const mainnetSafeUsdcBefore = await mainnetUSDC.balanceOf(SAFE);
    const mainnetTimelockUsdcBefore = await mainnetUSDC.balanceOf(mainnetTimelock.address);

    await (await polygonReservesTransfer.connect(caller).transfer()).wait();

    const mainnetSafeUsdcAfter = await mainnetUSDC.balanceOf(SAFE);
    const mainnetTimelockUsdcAfter = await mainnetUSDC.balanceOf(mainnetTimelock.address);

    expect(mainnetSafeUsdcBefore.sub(mainnetSafeUsdcAfter)).to.equal(USDCE_AMOUNT);
    expect(mainnetTimelockUsdcAfter.sub(mainnetTimelockUsdcBefore)).to.equal(USDCE_AMOUNT);
    expect(await mainnetUSDC.allowance(SAFE, RESERVES_TRANSFER_CONTRACT)).to.equal(0);
    expect(await polygonReservesTransfer.transferred()).to.equal(true);
  },
});
