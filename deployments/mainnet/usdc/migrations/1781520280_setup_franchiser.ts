import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';
import { Contract } from 'ethers';

const OLD_FRANCHISER_FACTORY = '0xE696d89f4F378772f437F01FaaD70240abdf1854';
const FRANCHISER_POOL_FACTORY = '0x4f858af44fD7f2B4BFe61ceee1560E4Dd5531896';

const poolConfig = {
  coordinator: '0xbbf3f1421d886e9b2c5d716b5192ac998af2012c',
  guardian: '0xbbf3f1421d886e9b2c5d716b5192ac998af2012c',
  maxDelegatees: 30,
  freezePeriod: 10 * 24 * 60 * 60, // 10 days in seconds
  amount: exp(610000, 18), // 610,000 COMP
};

const oldFranchisers = [
  '0xDff7Ea1B9c6c23d63B9038428767231439321D12',
  '0x99e0705d0C93f1cb982bCE4c14ce7feD7e23Cf83',
  '0x1e76b5bcf86967d5555ECDEDDd67248F949dc5BC',
  '0x2F845447F1040176091Ed16C72E9c4ddC292F14B',
  '0xC623e9bc66cF498ABdC3c7297e9Df95f20C2F0a8',
  '0xca038273e110c8e39543E7FAB9279FB42fE32c63',
  '0x59dC38b5CEe74ca7189394eddAf5A13611DF0B63',
  '0xe8B2B94612240d57D830944a668E4e48eDF9F9D8',
  '0xEC8604670F07dB6E40f84147F4297b7f58775350',
  '0x603657fDEc47a9dF15A5661cE011E13C0D449982',
  '0x1543D57471A5F168cBabb5922246a77013c9d2E4',
  '0xBbc353508e782d44fFbD28d2869bd527070b24F2',
  '0x78BE1f3dd735bB4F20decb62A1beCE31DA452126',
];

const delegatePowerBefore: { [delegatee: string]: bigint } = {};

export default migration('1781520280_setup_franchiser', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      timelock,
      COMP,
    } = await deploymentManager.getContracts();

    const oldFranchiserFactory = await deploymentManager.existing('oldFranchiserFactory', OLD_FRANCHISER_FACTORY);
    const franchiserPoolFactory = await deploymentManager.existing('franchiserPoolFactory', FRANCHISER_POOL_FACTORY);

    let totalBalance = BigInt(0);
    const delegateesConfig: {delegatee: string, balance: bigint}[] = [];

    for (const franchiser of oldFranchisers) {
      const balance = await COMP.balanceOf(franchiser);
      
      const franchiserContract = new Contract(
        franchiser,
        ['function delegatee() view returns (address)'],
        await deploymentManager.getSigner()
      );      
      const delegatee = await franchiserContract.delegatee();
      trace(`Franchiser ${franchiser}, (delegatee ${delegatee}) has balance ${balance.toString()}`);
      delegateesConfig.push({ delegatee, balance: balance.toBigInt() });
      totalBalance += balance.toBigInt();

      const delegatePower = await COMP.getCurrentVotes(delegatee);
      delegatePowerBefore[delegatee] = delegatePower.toBigInt();
    }

    trace(`Total balance of old franchisers: ${totalBalance}`);

    const delegatees = delegateesConfig.map(({ delegatee }) => delegatee);

    const mainnetActions = [
      // 1. Recall COMP tokens from old franchisers back to the timelock
      {
        contract: oldFranchiserFactory,
        signature: 'recallMany(address[],address[])',
        args: [
          delegatees,
          Array(delegatees.length).fill(timelock.address),
        ],
      },
      // 2. Approve factory to transfer COMP tokens on behalf of the timelock
      {
        contract: COMP,
        signature: 'approve(address,uint256)',
        args: [franchiserPoolFactory.address, poolConfig.amount],
      },
      // 3. Create a new pool for the franchisers
      {
        contract: franchiserPoolFactory,
        signature: 'createPoolAndFund(address,address,uint256,uint256,address[],uint256[])',
        args: [
          poolConfig.coordinator,
          poolConfig.guardian,
          poolConfig.maxDelegatees,
          poolConfig.freezePeriod,
          delegateesConfig.map(({ delegatee }) => delegatee),
          delegateesConfig.map(({ balance }) => balance.toString())
        ],
      },
    ];

    const description = `DESCRIPTION`;

    const txn = await deploymentManager.retry(async () =>
      trace(
        await governor.propose(...(await proposal(mainnetActions, description)))
      ), 0, 300_000
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

  async verify(deploymentManager: DeploymentManager) {

    const { COMP } = await deploymentManager.getContracts();

    const franchiserPoolFactory = await deploymentManager.existing('franchiserPoolFactory', FRANCHISER_POOL_FACTORY);

    const pools = await franchiserPoolFactory.getAllPools();
    expect(pools.length).to.equal(1);

    const pool = new Contract(
      pools[0],
      [
        'function coordinator() view returns (address)',
        'function guardian() view returns (address)',
        'function maxDelegatees() view returns (uint256)',
        'function freezePeriod() view returns (uint256)',
      ], 
      await deploymentManager.getSigner()
    );

    expect(await pool.coordinator()).to.equal(poolConfig.coordinator);
    expect(await pool.guardian()).to.equal(poolConfig.guardian);
    expect(await pool.maxDelegatees()).to.equal(poolConfig.maxDelegatees);
    expect(await pool.freezePeriod()).to.equal(poolConfig.freezePeriod);

    expect(await COMP.balanceOf(pools[0])).to.equal(poolConfig.amount);

    for (const franchiser of oldFranchisers) {
      expect(await COMP.balanceOf(franchiser)).to.equal(0);
    }

    // Verify that delegatees have the same voting power captured before migration.
    for (const delegatee of Object.keys(delegatePowerBefore)) {
      const delegatePowerAfter = await COMP.getCurrentVotes(delegatee);
      expect(delegatePowerAfter.toBigInt()).to.equal(delegatePowerBefore[delegatee]);
    }
  },
});
