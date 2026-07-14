import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';
import { Contract } from 'ethers';

const OLD_FRANCHISER_FACTORY = '0xE696d89f4F378772f437F01FaaD70240abdf1854';
const FRANCHISER_POOL_FACTORY = '0x8421c35b1235741e00d2475f365A434d4b476A19';

const poolConfig = {
  coordinator: '0xfd947c72f09703210eeCbcab9c9206fE5e1Bb6e2',
  guardian: '0xbbf3f1421D886E9b2c5D716B5192aC998af2012c',
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

const delegateesToSkip = [
  '0x13BDaE8c5F0fC40231F0E6A4ad70196F59138548', // Michigan Blockchain | 29,999.88 COMP
  '0x4f894Bfc9481110278C356adE1473eBe2127Fd3C', // Reservoir / AlphaGrowth | 50,000.00 COMP
  '0x72C58877ef744b86F6ef416a3bE26Ec19d587708', // Sharp | 1,178.70 COMP
];

const delegateesToReallocate = [
  { delegatee: '0x070341aA5Ed571f0FB2c4a5641409B1A46b4961b', amount: exp(8262.46, 18) }, // FranklinDAO
  { delegatee: '0xc5547B4907418C2EC0C2A95beC6fEE8354657759', amount: exp(40000, 18) }, // DAOplomats
  { delegatee: '0x1F3D3A7A9c548bE39539b39D7400302753E20591', amount: exp(32916.12, 18) }, // blockful
];

const delegatePowerBefore: { [delegatee: string]: bigint } = {};
const delegateesConfig: {delegatee: string, balance: bigint}[] = [];

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

    // Capture baseline voting power for reallocated delegatees that have no old franchiser (e.g. brand-new delegates).
    for (const { delegatee } of delegateesToReallocate) {
      if (!(delegatee in delegatePowerBefore)) {
        delegatePowerBefore[delegatee] = (await COMP.getCurrentVotes(delegatee)).toBigInt();
      }
    }

    const delegatees = delegateesConfig.map(({ delegatee }) => delegatee);

    for (const { delegatee, amount } of delegateesToReallocate) {
      const existing = delegateesConfig.find((c) => c.delegatee === delegatee);
      if (existing) {
        existing.balance += amount;
      } else {
        delegateesConfig.push({ delegatee, balance: amount });
      }
    }

    const delegateesForRenewal = delegateesConfig.filter(({ delegatee }) => !delegateesToSkip.includes(delegatee));
    trace(`Delegatees for renewal: ${delegateesForRenewal.map(({ delegatee }) => delegatee).join(', ')}`);

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
        signature: 'createPoolAndFund(address,address,uint256,uint256,uint256,address[],uint256[])',
        args: [
          poolConfig.coordinator,
          poolConfig.guardian,
          poolConfig.maxDelegatees,
          poolConfig.freezePeriod,
          poolConfig.amount,
          delegateesForRenewal.map(({ delegatee }) => delegatee),
          delegateesForRenewal.map(({ balance }) => balance.toString())
        ],
      },
    ];

    const description = `# Franchiser Operational Upgrade and Rebalance

## Summary

This proposal upgrades Compound's treasury-delegation (Franchiser) system to a new pool-based architecture and, in the same step, carries out the first scheduled biannual delegate rebalancing under **Proposal 504 — [Compound Delegate Race (Cycle 2)](https://www.comp.xyz/t/compound-delegate-race-cycle-2/7302)**.

The total COMP delegated through the program does not change. Existing delegations migrate to the new pool with no interruption to voting power, and the pool reclaimed from under-participating delegates is redistributed to qualified active delegates. COMP remains in Governance-owned contracts throughout.

## Background

Proposal 504 established a standing six-monthly review of treasury-delegated voting power, with a uniform on-chain participation standard and a defined reallocation procedure. The first review window (Proposals 505–586) has closed and participation has been verified on-chain. The full review, application window, and waterfall are documented on the forum: [comp.xyz/t/7862](https://www.comp.xyz/t/7862).

## What this proposal does

1. **Upgrade.** Migrate the treasury-delegation program to the upgraded Franchiser pool: existing delegations move into a new Governance-funded pool, with the CGWG multisig set as Coordinator and a Guardian set for emergency oversight. Governance retains sole authority to fund, halt, or reclaim the pool in full.

2. **Rebalance.** As part of the migration, three delegations that fell below the participation standard are not renewed — releasing **81,178.58 COMP** — which is redistributed to the qualified applicants per the waterfall.

**Not renewed — 81,178.58 COMP reclaimed:**

| Delegatee | Address | COMP |
|---|---|---:|
| Michigan Blockchain | \`0x13BD…8548\` | 29,999.88 |
| Reservoir / AlphaGrowth | \`0x4f89…fd3c\` | 50,000.00 |
| Sharp | \`0x72C5…7708\` | 1,178.70 |

**Reallocated — 81,178.58 COMP:**

| Delegate | Address | COMP |
|---|---|---:|
| FranklinDAO | \`0x0703…961b\` | 8,262.46 |
| DAOplomats | \`0xc554…7759\` | 40,000.00 |
| blockful | \`0x1F3D…0591\` | 32,916.12 |

## The upgraded architecture

The upgrade replaces per-delegation Franchiser deployments with a single pool, split across three role-gated contracts:

- **FranchiserPoolFactory** — the Governance-only entry point. Governance creates, funds, and can halt a pool; halting recalls all delegates and returns the full COMP balance to the Timelock (the only path for COMP to leave the program).
- **FranchiserPool** — holds the program's idle COMP. A **Coordinator** (the CGWG multisig) can \`delegate\`, \`recall\`, and \`reassign\` voting power among delegates within Governance-set limits. A separate **Guardian** can emergency-\`recall\` a delegate or \`freeze\` the pool (10-day minimum), but can never move or delegate COMP.
- **Franchiser** — unchanged from V1: holds delegated COMP and grants voting power to a delegatee (who may name up to one sub-delegate).

Governance (the Timelock) sets each pool's parameters — delegate cap, Coordinator, Guardian, freeze period — and can change them or halt the program at any time by on-chain vote.

## Guarantees

- **Delegation only, never custody.** COMP stays in Governance-owned contracts at every step (Timelock → pool → Franchiser); no working group, Coordinator, or Guardian ever takes custody of the tokens.
- **Total set by governance.** This proposal does not change the program's total delegated COMP — it migrates and reallocates the existing pool. Any change to the total returns to an on-chain vote, and Governance can recall or reassign any delegation at any time.
`;

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

    for (const franchiser of oldFranchisers) {
      expect(await COMP.balanceOf(franchiser)).to.equal(0);
    }

    // Check that all COMP is used for franchisers and none is left in the pool contract.
    expect(await COMP.balanceOf(pools[0])).to.equal(0);

    // Verify that delegatees have the expected voting power after migration.
    for (const delegatee of Object.keys(delegatePowerBefore)) {
      const delegatePowerAfter = await COMP.getCurrentVotes(delegatee);
      const reallocation = delegateesToReallocate.find(({ delegatee: d }) => d === delegatee);

      if (delegateesToSkip.includes(delegatee)) {
        // Delegatees that were skipped for reallocation should have 0 voting power after migration.
        expect(delegatePowerBefore[delegatee] - delegatePowerAfter.toBigInt())
          .to.equal(delegateesConfig.find(({ delegatee: d }) => d === delegatee)?.balance);
      }
      else if (reallocation) {
        // Delegatees that received a reallocation should gain exactly the reallocated amount.
        expect(delegatePowerAfter.toBigInt() - delegatePowerBefore[delegatee]).to.equal(reallocation.amount);
      }
      else {
        // Delegatees that were renewed should have the same voting power as before migration.
        expect(delegatePowerAfter.toBigInt()).to.equal(delegatePowerBefore[delegatee]);
      }
    }
  },
});
