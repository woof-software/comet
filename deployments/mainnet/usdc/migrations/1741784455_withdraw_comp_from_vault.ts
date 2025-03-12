import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { calldata, exp, proposal } from '../../../../src/deploy';
import { Contract } from 'ethers';

const STREAM_CONTROLLER = '0x3b109aa111BdF11B30350CdfAd7e9Cf091421Aa4';
const VAULT = '0x8624f61Cc6e5A86790e173712AfDd480fa8b73Ba';
/*
[
[0x3E67cc2C7fFf86d9870dB9D02c43e789B52FB296,0x986b5E1e1755e3C2440e960477f25201B0a8bbD4,false]
[0x4dDB1bb1Ed2749995e8e490AE2Ac4EDaa4738AB8,0x1B39Ee86Ec5979ba5C322b826B3ECb8C79991699,false]
]
*/

const RECEIVER_UPFRONT = '0xd36025E1e77069aA991DC24f0E6287b4A35c89Ad';
const RECEIVER_STREAM = '0x3f6a5e8C632c9EBC97a39d62F9AEf0A426aafa58';

const upfrontAmount = exp(50_000, 18);
const streamAmount  = exp(100_000, 18);
const streamDuration = 60 * 60 * 24 * 30 * 9; // 9 months
const amountPerSec = streamAmount * exp(1,14) / BigInt(streamDuration);

let balanceBefore: bigint;

export default migration('1741784455_withdraw_comp_from_vault', {
  async prepare() {
    return {};
  },
  async enact(deploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();
    const {
      governor,
      comptrollerV2,
      COMP
    } = await deploymentManager.getContracts();

    balanceBefore = (await COMP.balanceOf(RECEIVER_UPFRONT)).toBigInt();

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

    const createStreamCalldata = (
      await streamController.populateTransaction.createStream(COMP.address, RECEIVER_STREAM, amountPerSec, streamDuration)
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
        args: [RECEIVER_UPFRONT, upfrontAmount],
      },
      // 2. Withdraw the stream amount from Comptroller to vault
      {
        contract: comptrollerV2,
        signature: '_grantComp(address,uint256)',
        args: [VAULT, streamAmount],
      },
      // 3. Deposit and create the stream
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

    expect((await COMP.balanceOf(RECEIVER_UPFRONT)).sub(balanceBefore)).to.equal(upfrontAmount);
    // const stream = new Contract(
    //   STREAM_CONTROLLER,
    //   [
    //     'function withdraw(address from, address to, uint216 amountPerSec) external',
    //   ],
    //   deploymentManager.hre.ethers.provider
    // );

    // await deploymentManager.hre.network.provider.request({
    //   method: 'hardhat_impersonateAccount',
    //   params: [RECEIVER_STREAM]
    // });
    // const signer2 = await deploymentManager.hre.ethers.provider.getSigner(RECEIVER_STREAM);
    // await deploymentManager.hre.network.provider.send('hardhat_setBalance', [
    //   RECEIVER_STREAM,
    //   deploymentManager.hre.ethers.utils.hexStripZeros(deploymentManager.hre.ethers.utils.parseEther('100').toHexString()),
    // ]);
    // await deploymentManager.hre.network.provider.send('evm_increaseTime', [streamDuration]);
    // await deploymentManager.hre.network.provider.send('evm_mine'); // ensure block is mined

    // const _balanceBefore = await COMP.balanceOf(RECEIVER_STREAM);
    // await (await stream.connect(signer2).withdraw(COMP.address, RECEIVER_STREAM, amountPerSec)).wait();
    // const _balanceAfter = await COMP.balanceOf(RECEIVER_STREAM);
    // expect(streamAmount).to.equal(_balanceAfter.sub(_balanceBefore).toBigInt());
  },
});
