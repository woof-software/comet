import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { calldata, exp, proposal } from '../../../../src/deploy';
import { Contract } from 'ethers';
// import { expectApproximately } from '../../../../scenario/utils';

const STREAM_CONTROLLER = '0x3b109aa111BdF11B30350CdfAd7e9Cf091421Aa4';
const VAULT = '0x8624f61Cc6e5A86790e173712AfDd480fa8b73Ba';
const WOOF = '0xd36025E1e77069aA991DC24f0E6287b4A35c89Ad';

const upfrontAmount = exp(300_000, 6);
const streamAmount  = exp(300_000, 6);
const streamDuration = 60 * 60 * 24 * 30 * 6; // 6 months
const amountPerSec = streamAmount * exp(1,14) / BigInt(streamDuration);

let balanceBefore: bigint;

export default migration('1732804028_sandbox_proposal', {
  async prepare() {
    return {};
  },
  async enact(deploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();
    const {
      governor,
      USDC,
      comet
    } = await deploymentManager.getContracts();

    balanceBefore = (await USDC.balanceOf(WOOF)).toBigInt();

    const streamController = new Contract(
      STREAM_CONTROLLER,
      [
        'function createStream(address token, address to, uint216 amountPerSec, uint256 duration) external',
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

    const cometWithdrawCalldata = (
      await comet.populateTransaction.withdrawTo(WOOF, USDC.address, upfrontAmount)
    ).data;
    const executeCometWithdrawCalldata = await calldata(vault.populateTransaction.execute({
      target: comet.address,
      value: 0,
      data: cometWithdrawCalldata
    }));

    const createStreamCalldata = (
      await streamController.populateTransaction.createStream(USDC.address, WOOF, amountPerSec, streamDuration)
    ).data;
    console.log('createStreamCalldata', createStreamCalldata);
    /*
    gauntlet:
      122f79c0 // createStream selector
        000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 // USDC
        000000000000000000000000d20c9667bf0047f313228f9fe11f8b9f8dc29bba // to
        00000000000000000000000000000000000000000000000046d995efb61ac6fb // amountPerSec = 0.05105276509
        0000000000000000000000000000000000000000000000000000000001e13380 // duration = 31536000
    
    our: 
      122f79c0 // createStream selector
        000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 // USDC
        000000000000000000000000d36025e1e77069aa991dc24f0e6287b4a35c89ad // to
        0000000000000000000000000000000000000000000000001ac53a820f8a61f9 // amountPerSec = 0.01929012345
        0000000000000000000000000000000000000000000000000000000000ed4e00 // duration = 15552000
    */
    const executeCreateStreamCalldata = await calldata(vault.populateTransaction.execute({
      target: STREAM_CONTROLLER,
      value: 0,
      data: createStreamCalldata
    }));
    const mainnetActions = [
      // 1. Withdraw the upfront and stream amount from Comet
      {
        target: VAULT,
        signature: 'execute((address,uint256,bytes))',
        calldata: executeCometWithdrawCalldata,
      },
      // 2. Deposit and create the stream
      {
        target: VAULT,
        signature: 'execute((address,uint256,bytes))',
        calldata: executeCreateStreamCalldata,
      },
    ];
    const description = '';
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
    const { USDC } = await deploymentManager.getContracts();

    expect((await USDC.balanceOf(WOOF)).sub(balanceBefore)).to.equal(upfrontAmount);
    // const stream = new Contract(
    //   STREAM_CONTROLLER,
    //   [
    //     'function withdraw(address from, address to, uint216 amountPerSec) external',
    //   ],
    //   deploymentManager.hre.ethers.provider
    // );

    // // impersonate woof and try claiming
    // await deploymentManager.hre.network.provider.request({
    //   method: 'hardhat_impersonateAccount',
    //   params: [WOOF]
    // });
    // const signer2 = await deploymentManager.hre.ethers.provider.getSigner(WOOF);
    // await deploymentManager.hre.network.provider.send('hardhat_setBalance', [
    //   WOOF,
    //   deploymentManager.hre.ethers.utils.hexStripZeros(deploymentManager.hre.ethers.utils.parseEther('100').toHexString()),
    // ]);
    // await deploymentManager.hre.network.provider.send('evm_increaseTime', [streamDuration]);
    // await deploymentManager.hre.network.provider.send('evm_mine'); // ensure block is mined

    // const _balanceBefore = await USDC.balanceOf(WOOF);
    // await (await stream.connect(signer2).withdraw(VAULT, WOOF, amountPerSec)).wait();
    // const _balanceAfter = await USDC.balanceOf(WOOF);
    // expectApproximately(
    //   streamAmount,
    //   _balanceAfter.sub(_balanceBefore).toBigInt(),
    //   1n
    // );
  },
});