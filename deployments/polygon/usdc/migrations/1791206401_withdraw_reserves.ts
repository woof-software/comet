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

let mainnetTimelockUsdcBefore: BigNumber;

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

    mainnetTimelockUsdcBefore = await mainnetUSDC.balanceOf(mainnetTimelock.address);

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

This proposal withdraws 470,000 USDC.e and 65,000 USDT from the reserves of the Compound III USDC and USDT markets on Polygon, swaps both into native USDC on Uniswap V4, and bridges it to the Compound Timelock on Ethereum Mainnet using Circle's CCTP. The USDC.e swap tolerates at most 0.03% loss and the USDT swap at most 0.15%.

## Proposal actions

The proposal action sends a message through Polygon's FxRoot to the Polygon Bridge Receiver, which queues the following calls on the Polygon Timelock:

1. Withdraw 470,000 USDC.e from the Polygon cUSDCv3 reserves.
2. Withdraw 65,000 USDT from the Polygon cUSDTv3 reserves.
3. Transfer the USDC.e and USDT to the Uniswap Universal Router.
4. Swap 470,000 USDC.e into at least 469,859 USDC and 65,000 USDT into at least 64,902.5 USDC on Uniswap V4.
5. Approve and call \`depositForBurn\` on the CCTP TokenMessenger to bridge 534,761.5 USDC to the Mainnet Timelock.
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
    const { comet, USDC: USDCe } = await deploymentManager.getContracts();
    const { timelock: mainnetTimelock, USDC: mainnetUSDC } = await govDeploymentManager.getContracts();

    const polygonUsdtDm = deploymentManager.bridgedDeploymentManagers.get('polygon:usdt') as DeploymentManager;
    const cometUsdt = await polygonUsdtDm.getContractOrThrow('comet');
    const USDT = await polygonUsdtDm.getContractOrThrow('USDT0');

    const usdceBefore = await USDCe.balanceOf(comet.address, { blockTag: preMigrationBlockNumber });
    expect(usdceBefore.sub(await USDCe.balanceOf(comet.address))).to.equal(USDCE_AMOUNT);

    const usdtBefore = await USDT.balanceOf(cometUsdt.address, { blockTag: preMigrationBlockNumber });
    expect(usdtBefore.sub(await USDT.balanceOf(cometUsdt.address))).to.equal(USDT_AMOUNT);

    const mainnetTimelockUsdcAfter = await mainnetUSDC.balanceOf(mainnetTimelock.address);
    expect(mainnetTimelockUsdcAfter.sub(mainnetTimelockUsdcBefore)).to.equal(BURN_AMOUNT);
  },
});
