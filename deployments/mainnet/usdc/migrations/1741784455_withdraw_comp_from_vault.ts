import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { calldata, exp, proposal } from '../../../../src/deploy';
import { Contract } from 'ethers';

const STREAM_CONTROLLER = '0x3b109aa111BdF11B30350CdfAd7e9Cf091421Aa4';
const VAULT = '0x8624f61Cc6e5A86790e173712AfDd480fa8b73Ba';

const RECEIVER = '0xc10785fB7b1adD4fD521A27d0d55c5561EEf0940';

const upfrontAmount = exp(50_000, 18);  // can be changed
const streamAmount  = exp(100_000, 18); // can be changed
const streamDuration = 60 * 60 * 24 * 30 * 9; // 9 months
const amountPerSec = streamAmount * exp(1, 2) / BigInt(streamDuration);

let balanceBefore: bigint;

export default migration('1741784455_withdraw_comp_from_vault', {
  async prepare() {
    return {};
  },
  async enact(deploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();
    const {
      timelock,
      governor,
      comptrollerV2,
      COMP
    } = await deploymentManager.getContracts();

    balanceBefore = (await COMP.balanceOf(RECEIVER)).toBigInt();

    const streamController = new Contract(
      STREAM_CONTROLLER,
      [
        'function depositAndCreate(address token, uint256 amountToDeposit, address to, uint216 amountPerSec, uint256 duration) external',
      ],
      deploymentManager.hre.ethers.provider
    );

    const vault = new Contract(
      VAULT,
      [
        'function execute(tuple(address target, uint256 value, bytes data)) external',
      ],
      deploymentManager.hre.ethers.provider
    );

    const approveCalldata = (
      await COMP.populateTransaction.approve(STREAM_CONTROLLER, streamAmount)
    ).data;

    const executeApproveCalldata = await calldata(vault.populateTransaction.execute({
      target: COMP.address,
      value: 0,
      data: approveCalldata
    }));

    const createStreamCalldata = (
      await streamController.populateTransaction.depositAndCreate(COMP.address, streamAmount, RECEIVER, amountPerSec, streamDuration)
    ).data;
    console.log('createStreamCalldata', createStreamCalldata);

    const executeCreateStreamCalldata = await calldata(vault.populateTransaction.execute({
      target: STREAM_CONTROLLER,
      value: 0,
      data: createStreamCalldata
    }));

    const mainnetActions = [
      // 1. Withdraw the upfront amount from Comptroller to receiver
      {
        contract: comptrollerV2,
        signature: '_grantComp(address,uint256)',
        args: [RECEIVER, upfrontAmount],
      },
      // 2. Withdraw the stream amount from Comptroller to vault
      {
        contract: comptrollerV2,
        signature: '_grantComp(address,uint256)',
        args: [timelock.address, streamAmount],
      },
      // 3. Withdraw the stream amount from Comptroller to vault
      {
        contract: COMP,
        signature: 'transfer(address,uint256)',
        args: [VAULT, streamAmount],
      },
      // 4. Approve the stream controller to spend the stream amount
      {
        target: VAULT,
        signature: 'execute((address,uint256,bytes))',
        calldata: executeApproveCalldata,
      },
      // 5. Deposit and create the stream
      {
        target: VAULT,
        signature: 'execute((address,uint256,bytes))',
        calldata: executeCreateStreamCalldata,
      },
    ];
    const description = 'DESCRIPTION';
    const txn = await deploymentManager.retry(async () =>
      trace(
        await governor.propose(...(await proposal(mainnetActions, description)))
      )
    );
    const event = txn.events.find(
      (event) => event.event === 'ProposalCreated'
    );
    const [proposalId] = event.args;
    trace(`Created proposal ${proposalId}.`);
  },

  async enacted(): Promise<boolean> {
    return false;
  },
  async verify(deploymentManager: DeploymentManager) {
    const { COMP } = await deploymentManager.getContracts();

    expect((await COMP.balanceOf(RECEIVER)).sub(balanceBefore)).to.equal(upfrontAmount);
    // const stream = new Contract(
    //   '0x4dDB1bb1Ed2749995e8e490AE2Ac4EDaa4738AB8',
    //   [
    //     'function withdraw(address from, address to, uint216 amountPerSec) external',
    //   ],
    //   deploymentManager.hre.ethers.provider
    // );
    // await deploymentManager.hre.network.provider.send('evm_increaseTime', [streamDuration]);
    // await deploymentManager.hre.network.provider.send('evm_mine'); // ensure block is mined

    // const _balanceBefore = await COMP.balanceOf(RECEIVER);
    // await (await stream.connect(signer).withdraw(STREAM_CONTROLLER, RECEIVER, amountPerSec)).wait();
    // const _balanceAfter = await COMP.balanceOf(RECEIVER);
    // expect(streamAmount).to.equal(_balanceAfter.sub(_balanceBefore).toBigInt());
  },
});
