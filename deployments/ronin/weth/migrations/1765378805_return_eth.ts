import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal, calldata } from '../../../../src/deploy';
import { utils, constants, BigNumber } from 'ethers';

const destinationChainSelectorMainnet = '5009297550715157269';
const destinationChainSelectorRonin = '6916147374840168594';
const ETHAmount = utils.parseEther('31');

let balanceBefore: bigint;

export default migration('1765378805_return_eth', {
  async prepare() {
    return {};
  },

  async enact(
    deploymentManager: DeploymentManager,
    govDeploymentManager: DeploymentManager
  ) {
    const trace = deploymentManager.tracer();

    const {
      bridgeReceiver,
      WETH,
      timelock,
      l2CCIPRouter
    } = await deploymentManager.getContracts();

    const {
      l1CCIPRouter,
      governor,
      WETH: WETHMainnet,
      timelock: mainnetTimelock
    } = await govDeploymentManager.getContracts();

    balanceBefore = await WETHMainnet.balanceOf(mainnetTimelock.address);

    const sweepTokenCalldata = await calldata(
      bridgeReceiver.populateTransaction.sweepToken(
        timelock.address,
        WETH.address
      )
    );

    const approveCalldata = await calldata(
      WETH.populateTransaction.approve(
        l2CCIPRouter.address,
        ETHAmount
      )
    );

    const sendCalldata = await calldata(
      l2CCIPRouter.populateTransaction.ccipSend(
        destinationChainSelectorMainnet,
        [
          utils.defaultAbiCoder.encode(['address'], [mainnetTimelock.address]),
          '0x',
          [
            [
              WETH.address,
              ETHAmount
            ],
          ],
          constants.AddressZero,
          '0x'
        ]
      )
    );

    const fee0 = await l2CCIPRouter.getFee(destinationChainSelectorMainnet, [
      utils.defaultAbiCoder.encode(['address'], [mainnetTimelock.address]),
      '0x',      
      [
        [
          WETH.address,
          ETHAmount
        ],
      ],
      constants.AddressZero,
      '0x'
    ]);
    expect(await deploymentManager.hre.ethers.provider.getBalance(timelock.address)).to.be.gte(fee0.mul(2n));

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          
          bridgeReceiver.address,
          WETH.address,
          l2CCIPRouter.address,
        ],
        [
          0,
          0,
          fee0.mul(3n).div(2n),
        ],
        [
          'sweepToken(address,address)',
          'approve(address,uint256)',
          'ccipSend(uint64,(bytes,bytes,(address,uint256)[],address,bytes))'
        ],
        [
          sweepTokenCalldata,
          approveCalldata,
          sendCalldata,
        ],
      ]
    );

    const fee1 = await l1CCIPRouter.getFee(destinationChainSelectorRonin, [
      utils.defaultAbiCoder.encode(['address'], [bridgeReceiver.address]),
      l2ProposalData,      
      [],
      constants.AddressZero,
      '0x'
    ]);

    const mainnetActions = [
      {
        contract: l1CCIPRouter,
        signature: 'ccipSend(uint64,(bytes,bytes,(address,uint256)[],address,bytes))',
        args:
          [
            destinationChainSelectorRonin,
            [
              utils.defaultAbiCoder.encode(['address'], [bridgeReceiver.address]),
              l2ProposalData,
              [],
              constants.AddressZero,
              '0x'
            ]
          ],
        value: fee1.mul(2n)
      },
    ];

    const description = 'DESCRIPTION';

    const txn = await deploymentManager.retry(async () =>
      trace(
        await governor.propose(...(await proposal(mainnetActions, description)))
      )
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

  async verify(
    _,
    govDeploymentManager: DeploymentManager,
  ) {
    const {
      timelock,
      WETH: WETHMainnet
    } = await govDeploymentManager.getContracts();

    const balanceAfter = await WETHMainnet.balanceOf(timelock.address);

    expect(BigNumber.from(balanceAfter).sub(balanceBefore)).to.equal(ETHAmount);
  },
});
