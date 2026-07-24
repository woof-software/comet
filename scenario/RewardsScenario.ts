import { CometContext, scenario } from './context/CometContext';
import CometActor from './context/CometActor';
import { expect } from 'chai';
import { exp } from '../test/helpers';
import { setEtherBalance, supportsSetRewardConfigWithMultiplier, supportsSetRewardsClaimed, duration } from './utils';
import { constants, Contract } from 'ethers';
import { CometInterface, CometRewards, ERC20, ERC20__factory } from '../build/types';
import { World } from '../plugins/scenario';
import { getRoots } from '../plugins/deployment_manager/Roots';
import { getConfigForScenario } from './utils/scenarioHelper';

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
//
// Every expectation is derived from what the base under test actually has
// deployed: the reward config, the reward token and the rewards governor are all
// read on the fork, never assumed.
// ─────────────────────────────────────────────────────────────────────────────

type ForkRewardConfig = {
  token: string;
  rescaleFactor: bigint;
  shouldUpscale: boolean;
  multiplier?: bigint;
};

async function readRewardConfig(rewards: CometRewards, cometAddress: string): Promise<ForkRewardConfig> {
  const config = await rewards.rewardConfig(cometAddress);
  return {
    token: config.token,
    rescaleFactor: config.rescaleFactor.toBigInt(),
    shouldUpscale: config.shouldUpscale,
    // absent on rewards deployments that predate the multiplier field
    multiplier: config.multiplier === undefined ? undefined : config.multiplier.toBigInt()
  };
}

// mirrors CometRewards.getRewardAccrued, reproducing its truncating division
function scaleAccrued(accrued: bigint, config: ForkRewardConfig): bigint {
  const rescaled = config.shouldUpscale ? accrued * config.rescaleFactor : accrued / config.rescaleFactor;
  return config.multiplier === undefined ? rescaled : (rescaled * config.multiplier) / exp(1, 18);
}

function tokenAt(address: string, world: World): ERC20 {
  return new Contract(address, ERC20__factory.createInterface(), world.deploymentManager.hre.ethers.provider) as ERC20;
}

async function impersonateGovernor(rewards: CometRewards, world: World) {
  const governor = await rewards.governor();
  const signer = await world.impersonateAddress(governor);
  await setEtherBalance(world.deploymentManager, governor, exp(1, 18));
  return signer;
}

async function ensureFunded(context: CometContext, rewards: CometRewards, token: string, needed: bigint) {
  const rewardsToken = tokenAt(token, context.world);
  const balance = (await rewardsToken.balanceOf(rewards.address)).toBigInt();
  if (balance < needed) {
    await context.sourceTokens(needed - balance, token, rewards.address);
  }
}

// The payout-funding pre-requirement: a live rewards contract may hold too little
// of the reward token to cover a claim, so top it up from a real holder first.
async function fundRewardsForPayout(context: CometContext, world: World) {
  const comet = await context.getComet();
  const rewards = await context.getRewards();
  const { token } = await readRewardConfig(rewards, comet.address);
  const decimals = await tokenAt(token, world).decimals();
  await ensureFunded(context, rewards, token, exp(100, decimals));
}

// Shared position setup: supply base as `actor` and let a day of rewards accrue.
// Holds back a slice of the balance for the rows that need a second, checkpointing
// supply afterwards.
async function setupSupplyPosition(context: CometContext, world: World, actor: CometActor) {
  const comet = await context.getComet();
  await fundRewardsForPayout(context, world);
  const baseAssetAddress = await comet.baseToken();
  const baseAsset = context.getAssetByAddress(baseAssetAddress);
  const balance = await baseAsset.balanceOf(actor.address);
  const toSupply = (balance * 9n) / 10n;

  await baseAsset.approve(actor, comet.address);
  await actor.safeSupplyAsset({ asset: baseAssetAddress, amount: toSupply });
  await world.increaseTime(duration.days(1));

  return { baseAssetAddress, checkpointAmount: balance - toSupply };
}

type RewardsState = {
  governor: string;
  config: ForkRewardConfig;
  claimed: bigint[];
  balances: bigint[];
};

// Everything a reverting call must leave untouched: captured before the call and
// compared after, so a revert is proven free of partial side effects.
async function readRewardsState(
  rewards: CometRewards,
  cometAddress: string,
  accounts: string[],
  world: World
): Promise<RewardsState> {
  const config = await readRewardConfig(rewards, cometAddress);
  const token = tokenAt(config.token, world);
  return {
    governor: await rewards.governor(),
    config,
    claimed: await Promise.all(
      accounts.map(async (account) => (await rewards.rewardsClaimed(cometAddress, account)).toBigInt())
    ),
    balances: await Promise.all(
      [...accounts, rewards.address].map(async (account) => (await token.balanceOf(account)).toBigInt())
    )
  };
}

// An address the rewards contract has no config for, so `claim`/`getRewardOwed`
// take their NotSupported branch. The base token is a real contract on every fork.
async function unconfiguredMarket(rewards: CometRewards, comet: CometInterface): Promise<string> {
  const address = await comet.baseToken();
  const { token } = await rewards.rewardConfig(address);
  expect(token).to.be.equal(constants.AddressZero);
  return address;
}

// Finds another market on this network wired to the same rewards contract. Reads
// each deployment's roots.json rather than aliases.json: every deployment checks in
// roots (only some check in aliases), and the scenario bases are the same list the
// runner itself forks from.
async function findSiblingMarket(ctx: CometContext): Promise<string | undefined> {
  const dm = ctx.world.deploymentManager;
  const rewards = await ctx.getRewards();
  const comet = await ctx.getComet();
  const { network, deployment } = ctx.world.base;

  for (const base of dm.hre.config.scenario.bases) {
    if (base.network !== network || base.deployment === deployment) continue;

    const roots = await getRoots(dm.cache.asDeployment(base.network, base.deployment));
    const sibling = roots.get('comet');
    const siblingRewards = roots.get('rewards');
    if (!sibling || !siblingRewards) continue;
    if (siblingRewards.toLowerCase() !== rewards.address.toLowerCase()) continue;
    if (sibling.toLowerCase() === comet.address.toLowerCase()) continue;

    const { token } = await rewards.rewardConfig(sibling);
    if (token !== constants.AddressZero) return sibling;
  }
  return undefined;
}

// Whether the market under test can actually pay a reward at all: it must be
// configured, its tracking speed for that side must be non-zero, and the side's
// total must reach baseMinForRewards — below it Comet accrues nothing even at a
// non-zero speed. All read on the fork; a deployed market's speed may be zero
// even where configuration.json declares one.
async function canAccrueRewards(ctx: CometContext, side: 'supply' | 'borrow'): Promise<boolean> {
  const comet = await ctx.getComet();
  const totals = await comet.totalsBasic();
  const minForRewards = (await comet.baseMinForRewards()).toBigInt();

  return side === 'supply'
    ? (await comet.baseTrackingSupplySpeed()).gt(0) && totals.totalSupplyBase.toBigInt() >= minForRewards
    : (await comet.baseTrackingBorrowSpeed()).gt(0) && totals.totalBorrowBase.toBigInt() >= minForRewards;
}

// Minimum reward-token balance the rewards contract should hold to cover the claims
// a side can generate over REWARD_COVERAGE_DAYS. A side's accrual is fixed by its
// tracking speed and split among however many accounts share it, so the whole-side
// figure bounds what any set of claimants can withdraw in the window — a floor that
// stays meaningful regardless of market size and never falls to zero while the side
// still accrues.
const REWARD_COVERAGE_DAYS = 5;

async function minRewardsBalance(
  comet: CometInterface,
  config: ForkRewardConfig,
  side: 'supply' | 'borrow'
): Promise<bigint> {
  const speed = (
    side === 'supply' ? await comet.baseTrackingSupplySpeed() : await comet.baseTrackingBorrowSpeed()
  ).toBigInt();
  const accrualScale = (await comet.baseAccrualScale()).toBigInt();
  const trackingIndexScale = (await comet.trackingIndexScale()).toBigInt();
  const seconds = BigInt(duration.days(REWARD_COVERAGE_DAYS));
  const accrued = (speed * accrualScale * seconds) / trackingIndexScale;
  return scaleAccrued(accrued, config);
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy Path
// ─────────────────────────────────────────────────────────────────────────────

// HP-00
scenario(
  'CometRewards#claim > pays supply rewards to the owner and zeroes owed',
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'supply'),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    expect((await comet.baseTrackingAccrued(albert.address)).toBigInt()).to.be.equal(0n);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(0n);

    await setupSupplyPosition(context, world, albert);

    const rewardBalBefore = (await rewardToken.balanceOf(albert.address)).toBigInt();
    const rewardsBalBefore = (await rewardToken.balanceOf(rewards.address)).toBigInt();
    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();

    const txn = await (await rewards.connect(albert.signer).claim(comet.address, albert.address, true)).wait();

    // the claim accrues in its own block, so the post-call read is the claim-block value
    const accrued = scaleAccrued((await comet.baseTrackingAccrued(albert.address)).toBigInt(), config);
    const owed = accrued - claimedBefore;
    expect(owed > 0n).to.be.true;

    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(rewardBalBefore + owed);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(accrued);
    expect(claimedBefore).to.not.be.equal(accrued);
    expect((await rewardToken.balanceOf(rewards.address)).toBigInt()).to.be.equal(rewardsBalBefore - owed);
    expect((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt()).to.be.equal(0n);

    return txn;
  }
);

// HP-01
scenario(
  'CometRewards#claim > pays borrow rewards to the owner and zeroes owed',
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'borrow'),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $asset0: ` == ${getConfigForScenario(ctx).rewardsAsset}` },
      $comet: { $base: ` >= ${getConfigForScenario(ctx).rewardsBase} ` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    expect((await comet.baseTrackingAccrued(albert.address)).toBigInt()).to.be.equal(0n);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(0n);

    await fundRewardsForPayout(context, world);

    const { asset: collateralAddress, scale } = await comet.getAssetInfo(0);
    const collateral = context.getAssetByAddress(collateralAddress);
    const baseAssetAddress = await comet.baseToken();
    const baseScale = (await comet.baseScale()).toBigInt();

    await collateral.approve(albert, comet.address);
    await albert.safeSupplyAsset({
      asset: collateralAddress,
      amount: BigInt(getConfigForScenario(context).rewardsAsset) * scale.toBigInt()
    });
    await albert.withdrawAsset({
      asset: baseAssetAddress,
      amount: BigInt(getConfigForScenario(context).rewardsBase) * baseScale
    });
    await world.increaseTime(duration.days(1));

    const rewardBalBefore = (await rewardToken.balanceOf(albert.address)).toBigInt();
    const rewardsBalBefore = (await rewardToken.balanceOf(rewards.address)).toBigInt();
    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();

    const txn = await (await rewards.connect(albert.signer).claim(comet.address, albert.address, true)).wait();

    const accrued = scaleAccrued((await comet.baseTrackingAccrued(albert.address)).toBigInt(), config);
    const owed = accrued - claimedBefore;
    expect(owed > 0n).to.be.true;

    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(rewardBalBefore + owed);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(accrued);
    expect(claimedBefore).to.not.be.equal(accrued);
    expect((await rewardToken.balanceOf(rewards.address)).toBigInt()).to.be.equal(rewardsBalBefore - owed);
    expect((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt()).to.be.equal(0n);

    return txn;
  }
);

// HP-02
scenario(
  'CometRewards#claimTo > pays the owner rewards to a third-party recipient',
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'supply'),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert, betty } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    await setupSupplyPosition(context, world, albert);

    expect(await comet.hasPermission(albert.address, albert.address)).to.be.true;
    expect(await comet.hasPermission(albert.address, betty.address)).to.be.false;

    const toBalBefore = (await rewardToken.balanceOf(betty.address)).toBigInt();
    const srcBalBefore = (await rewardToken.balanceOf(albert.address)).toBigInt();
    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    const recipientClaimedBefore = (await rewards.rewardsClaimed(comet.address, betty.address)).toBigInt();

    const txn = await (
      await rewards.connect(albert.signer).claimTo(comet.address, albert.address, betty.address, true)
    ).wait();

    const accrued = scaleAccrued((await comet.baseTrackingAccrued(albert.address)).toBigInt(), config);
    const owed = accrued - claimedBefore;
    expect(owed > 0n).to.be.true;

    expect((await rewardToken.balanceOf(betty.address)).toBigInt()).to.be.equal(toBalBefore + owed);
    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(srcBalBefore);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(accrued);
    expect(claimedBefore).to.not.be.equal(accrued);
    expect((await rewards.rewardsClaimed(comet.address, betty.address)).toBigInt()).to.be.equal(recipientClaimedBefore);
    expect((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt()).to.be.equal(0n);

    return txn;
  }
);

// HP-03
scenario(
  'CometRewards#claimTo > lets an authorised manager claim for the owner',
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'supply'),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert, betty } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    await setupSupplyPosition(context, world, albert);
    await albert.allow(betty, true);
    expect(await comet.hasPermission(albert.address, betty.address)).to.be.true;

    const managerBalBefore = (await rewardToken.balanceOf(betty.address)).toBigInt();
    const srcBalBefore = (await rewardToken.balanceOf(albert.address)).toBigInt();
    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();

    const txn = await (
      await rewards.connect(betty.signer).claimTo(comet.address, albert.address, betty.address, true)
    ).wait();

    const accrued = scaleAccrued((await comet.baseTrackingAccrued(albert.address)).toBigInt(), config);
    const owed = accrued - claimedBefore;
    expect(owed > 0n).to.be.true;

    expect((await rewardToken.balanceOf(betty.address)).toBigInt()).to.be.equal(managerBalBefore + owed);
    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(srcBalBefore);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(accrued);
    expect(claimedBefore).to.not.be.equal(accrued);
    expect((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt()).to.be.equal(0n);

    return txn;
  }
);

// HP-04
scenario(
  'CometRewards#claim > pays the owner even when called by an unrelated party',
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'supply'),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert, charles } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    await setupSupplyPosition(context, world, albert);
    expect(await comet.hasPermission(albert.address, charles.address)).to.be.false;

    const srcBalBefore = (await rewardToken.balanceOf(albert.address)).toBigInt();
    const callerBalBefore = (await rewardToken.balanceOf(charles.address)).toBigInt();
    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();

    const txn = await (await rewards.connect(charles.signer).claim(comet.address, albert.address, true)).wait();

    const accrued = scaleAccrued((await comet.baseTrackingAccrued(albert.address)).toBigInt(), config);
    const owed = accrued - claimedBefore;
    expect(owed > 0n).to.be.true;

    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(srcBalBefore + owed);
    expect((await rewardToken.balanceOf(charles.address)).toBigInt()).to.be.equal(callerBalBefore);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(accrued);
    expect(claimedBefore).to.not.be.equal(accrued);
    expect((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt()).to.be.equal(0n);

    return txn;
  }
);

// HP-05
scenario(
  'CometRewards#claim > pays the checkpointed value with shouldAccrue false, then the new delta with true',
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'supply'),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    const { baseAssetAddress, checkpointAmount } = await setupSupplyPosition(context, world, albert);
    await albert.safeSupplyAsset({ asset: baseAssetAddress, amount: checkpointAmount });

    const checkpointed = (await comet.baseTrackingAccrued(albert.address)).toBigInt();
    expect(checkpointed > 0n).to.be.true;
    const rewardBalBefore = (await rewardToken.balanceOf(albert.address)).toBigInt();
    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    expect(claimedBefore).to.be.equal(0n);

    await rewards.connect(albert.signer).claim(comet.address, albert.address, false);

    const balAfterStep1 = (await rewardToken.balanceOf(albert.address)).toBigInt();
    const claimedAfterStep1 = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    expect(balAfterStep1).to.be.equal(rewardBalBefore + scaleAccrued(checkpointed, config) - claimedBefore);
    expect(balAfterStep1 > rewardBalBefore).to.be.true;
    expect((await comet.baseTrackingAccrued(albert.address)).toBigInt()).to.be.equal(checkpointed);
    expect(claimedAfterStep1).to.be.equal(scaleAccrued(checkpointed, config));
    expect(claimedBefore).to.not.be.equal(claimedAfterStep1);

    await world.increaseTime(duration.days(1));
    const txn = await (await rewards.connect(albert.signer).claim(comet.address, albert.address, true)).wait();

    const accruedAfterStep3 = (await comet.baseTrackingAccrued(albert.address)).toBigInt();
    expect(accruedAfterStep3 > checkpointed).to.be.true;

    const scaledAfterStep3 = scaleAccrued(accruedAfterStep3, config);
    const delta = scaledAfterStep3 - scaleAccrued(checkpointed, config);
    expect(delta > 0n).to.be.true;
    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(balAfterStep1 + delta);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(scaledAfterStep3);
    expect(claimedAfterStep1).to.not.be.equal(scaledAfterStep3);
    expect((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt()).to.be.equal(0n);

    return txn;
  }
);

// HP-06
scenario(
  'CometRewards#getRewardOwed > returns an owed amount that matches the payout',
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'supply'),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    await setupSupplyPosition(context, world, albert);

    const targetTimestamp = (await world.timestamp()) + 1;
    await context.setNextBlockTimestamp(targetTimestamp);

    const owedBefore = (
      await rewards.callStatic.getRewardOwed(comet.address, albert.address, {
        blockTag: 'pending'
      })
    ).owed.toBigInt();
    expect(owedBefore > 0n).to.be.true;
    expect(
      (
        await rewards.callStatic.getRewardOwed(comet.address, albert.address, {
          blockTag: 'pending'
        })
      ).token
    ).to.be.equal(config.token);

    const rewardBalBefore = (await rewardToken.balanceOf(albert.address)).toBigInt();
    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();

    // mined in the block pinned to T
    const txn = await (await rewards.connect(albert.signer).claim(comet.address, albert.address, true)).wait();

    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(rewardBalBefore + owedBefore);
    const accrued = scaleAccrued((await comet.baseTrackingAccrued(albert.address)).toBigInt(), config);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(accrued);
    expect(claimedBefore).to.not.be.equal(accrued);

    const owedAfter = (await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt();
    expect(owedAfter).to.be.equal(0n);
    expect(owedBefore).to.not.be.equal(owedAfter);

    return txn;
  }
);

// HP-07
scenario(
  'CometRewards#setRewardsClaimed > governor overwrites the claim bookkeeping absolutely',
  {
    filter: async (ctx: CometContext) => await supportsSetRewardsClaimed(ctx)
  },
  async ({ comet, rewards, actors }, _, world) => {
    const { albert } = actors;
    const governor = await impersonateGovernor(rewards, world);
    const configBefore = await readRewardConfig(rewards, comet.address);

    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    const amount = claimedBefore + exp(1, 18);

    const txn = await (
      await rewards.connect(governor).setRewardsClaimed(comet.address, [albert.address], [amount])
    ).wait();

    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(amount);
    expect(claimedBefore).to.not.be.equal(amount);
    expect(await rewards.governor()).to.be.equal(await governor.getAddress());
    expect(await readRewardConfig(rewards, comet.address)).to.deep.equal(configBefore);

    return txn;
  }
);

// HP-08
scenario(
  'CometRewards#transferGovernor > hands the role to a new governor immediately',
  {
    filter: async (ctx: CometContext) => await supportsSetRewardsClaimed(ctx)
  },
  async ({ comet, rewards, actors }, _, world) => {
    const { albert, betty } = actors;
    const oldGovernor = await impersonateGovernor(rewards, world);
    const oldGovernorAddress = await oldGovernor.getAddress();
    const newGovernor = betty.address;
    expect(newGovernor).to.not.be.equal(oldGovernorAddress);

    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    const amount = claimedBefore + exp(1, 18);

    await rewards.connect(oldGovernor).transferGovernor(newGovernor);
    expect(await rewards.governor()).to.be.equal(newGovernor);
    expect(oldGovernorAddress).to.not.be.equal(newGovernor);

    const txn = await (
      await rewards.connect(betty.signer).setRewardsClaimed(comet.address, [albert.address], [amount])
    ).wait();

    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(amount);
    expect(claimedBefore).to.not.be.equal(amount);

    return txn;
  }
);

// HP-09
scenario(
  'CometRewards#withdrawToken > governor sweeps reward tokens to a recipient',
  {},
  async ({ comet, rewards, actors }, context, world) => {
    const { charles } = actors;
    const governor = await impersonateGovernor(rewards, world);
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    await fundRewardsForPayout(context, world);

    const rewardsBalBefore = (await rewardToken.balanceOf(rewards.address)).toBigInt();
    expect(rewardsBalBefore > 0n).to.be.true;
    const toBalBefore = (await rewardToken.balanceOf(charles.address)).toBigInt();
    const amount = rewardsBalBefore / 100n;
    expect(amount > 0n).to.be.true;

    const txn = await (await rewards.connect(governor).withdrawToken(config.token, charles.address, amount)).wait();

    expect((await rewardToken.balanceOf(charles.address)).toBigInt()).to.be.equal(toBalBefore + amount);
    expect((await rewardToken.balanceOf(rewards.address)).toBigInt()).to.be.equal(rewardsBalBefore - amount);
    expect(await rewards.governor()).to.be.equal(await governor.getAddress());
    expect(await readRewardConfig(rewards, comet.address)).to.deep.equal(config);

    return txn;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Unhappy Path
// ─────────────────────────────────────────────────────────────────────────────

// UH-00
scenario(
  'CometRewards#setRewardConfig > reverts NotPermitted for a non-governor caller',
  {},
  async ({ comet, rewards, actors }, _, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    expect(albert.address).to.not.be.equal(await rewards.governor());

    const before = await readRewardsState(rewards, comet.address, [albert.address], world);
    await expect(rewards.connect(albert.signer).setRewardConfig(comet.address, config.token))
      .to.be.revertedWithCustomError(rewards, 'NotPermitted')
      .withArgs(albert.address);
    expect(await readRewardsState(rewards, comet.address, [albert.address], world)).to.deep.equal(before);
  }
);

// UH-01
scenario(
  'CometRewards#setRewardConfig > reverts AlreadyConfigured for a configured market',
  {},
  async ({ comet, rewards, actors }, _, world) => {
    const { albert } = actors;
    const governor = await impersonateGovernor(rewards, world);
    const config = await readRewardConfig(rewards, comet.address);
    expect(config.token).to.not.be.equal(constants.AddressZero);

    const before = await readRewardsState(rewards, comet.address, [albert.address], world);
    await expect(rewards.connect(governor).setRewardConfig(comet.address, config.token))
      .to.be.revertedWithCustomError(rewards, 'AlreadyConfigured')
      .withArgs(comet.address);
    expect(await readRewardsState(rewards, comet.address, [albert.address], world)).to.deep.equal(before);
  }
);

// UH-02
scenario(
  'CometRewards#setRewardConfigWithMultiplier > reverts NotPermitted for a non-governor caller',
  {
    filter: async (ctx: CometContext) => await supportsSetRewardConfigWithMultiplier(ctx)
  },
  async ({ comet, rewards, actors }, _, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    expect(albert.address).to.not.be.equal(await rewards.governor());

    const before = await readRewardsState(rewards, comet.address, [albert.address], world);
    await expect(rewards.connect(albert.signer).setRewardConfigWithMultiplier(comet.address, config.token, exp(1, 18)))
      .to.be.revertedWithCustomError(rewards, 'NotPermitted')
      .withArgs(albert.address);
    expect(await readRewardsState(rewards, comet.address, [albert.address], world)).to.deep.equal(before);
  }
);

// UH-03
scenario(
  'CometRewards#setRewardConfigWithMultiplier > reverts AlreadyConfigured for a configured market',
  {
    filter: async (ctx: CometContext) => await supportsSetRewardConfigWithMultiplier(ctx)
  },
  async ({ comet, rewards, actors }, _, world) => {
    const { albert } = actors;
    const governor = await impersonateGovernor(rewards, world);
    const config = await readRewardConfig(rewards, comet.address);
    expect(config.token).to.not.be.equal(constants.AddressZero);

    const before = await readRewardsState(rewards, comet.address, [albert.address], world);
    await expect(rewards.connect(governor).setRewardConfigWithMultiplier(comet.address, config.token, exp(1, 18)))
      .to.be.revertedWithCustomError(rewards, 'AlreadyConfigured')
      .withArgs(comet.address);
    expect(await readRewardsState(rewards, comet.address, [albert.address], world)).to.deep.equal(before);
  }
);

// UH-04
scenario(
  'CometRewards#setRewardsClaimed > reverts NotPermitted for a non-governor caller',
  {
    filter: async (ctx: CometContext) => await supportsSetRewardsClaimed(ctx)
  },
  async ({ comet, rewards, actors }, _, world) => {
    const { albert } = actors;
    expect(albert.address).to.not.be.equal(await rewards.governor());

    const before = await readRewardsState(rewards, comet.address, [albert.address], world);
    await expect(rewards.connect(albert.signer).setRewardsClaimed(comet.address, [albert.address], [exp(1, 18)]))
      .to.be.revertedWithCustomError(rewards, 'NotPermitted')
      .withArgs(albert.address);
    expect(await readRewardsState(rewards, comet.address, [albert.address], world)).to.deep.equal(before);
  }
);

// UH-05
scenario(
  'CometRewards#setRewardsClaimed > reverts BadData on mismatched array lengths',
  {
    filter: async (ctx: CometContext) => await supportsSetRewardsClaimed(ctx)
  },
  async ({ comet, rewards, actors }, _, world) => {
    const { albert, betty } = actors;
    const governor = await impersonateGovernor(rewards, world);

    const accounts = [albert.address, betty.address];
    const before = await readRewardsState(rewards, comet.address, accounts, world);
    await expect(
      rewards.connect(governor).setRewardsClaimed(comet.address, accounts, [exp(1, 18)])
    ).to.be.revertedWithCustomError(rewards, 'BadData');
    expect(await readRewardsState(rewards, comet.address, accounts, world)).to.deep.equal(before);
  }
);

// UH-06
scenario(
  'CometRewards#withdrawToken > reverts NotPermitted for a non-governor caller',
  {},
  async ({ comet, rewards, actors }, context, world) => {
    const { albert, charles } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    expect(albert.address).to.not.be.equal(await rewards.governor());

    await fundRewardsForPayout(context, world);
    const rewardsBalBefore = (await tokenAt(config.token, world).balanceOf(rewards.address)).toBigInt();
    // only the access-control branch can trip
    const amount = rewardsBalBefore / 100n;
    expect(amount > 0n).to.be.true;

    const accounts = [albert.address, charles.address];
    const before = await readRewardsState(rewards, comet.address, accounts, world);
    await expect(rewards.connect(albert.signer).withdrawToken(config.token, charles.address, amount))
      .to.be.revertedWithCustomError(rewards, 'NotPermitted')
      .withArgs(albert.address);
    expect(await readRewardsState(rewards, comet.address, accounts, world)).to.deep.equal(before);
  }
);

// UH-07
scenario(
  'CometRewards#transferGovernor > reverts NotPermitted for a non-governor caller',
  {},
  async ({ comet, rewards, actors }, _, world) => {
    const { albert } = actors;
    expect(albert.address).to.not.be.equal(await rewards.governor());

    const before = await readRewardsState(rewards, comet.address, [albert.address], world);
    await expect(rewards.connect(albert.signer).transferGovernor(albert.address))
      .to.be.revertedWithCustomError(rewards, 'NotPermitted')
      .withArgs(albert.address);
    expect(await readRewardsState(rewards, comet.address, [albert.address], world)).to.deep.equal(before);
  }
);

// UH-08
scenario(
  'CometRewards#transferGovernor > revokes the old governor after the handover',
  {
    filter: async (ctx: CometContext) => await supportsSetRewardsClaimed(ctx)
  },
  async ({ comet, rewards, actors }, _, world) => {
    const { albert, betty } = actors;
    const oldGovernor = await impersonateGovernor(rewards, world);
    const oldGovernorAddress = await oldGovernor.getAddress();

    await rewards.connect(oldGovernor).transferGovernor(betty.address);
    expect(await rewards.governor()).to.be.equal(betty.address);

    const before = await readRewardsState(rewards, comet.address, [albert.address], world);

    await expect(rewards.connect(oldGovernor).transferGovernor(oldGovernorAddress))
      .to.be.revertedWithCustomError(rewards, 'NotPermitted')
      .withArgs(oldGovernorAddress);
    await expect(rewards.connect(oldGovernor).setRewardsClaimed(comet.address, [albert.address], [exp(1, 18)]))
      .to.be.revertedWithCustomError(rewards, 'NotPermitted')
      .withArgs(oldGovernorAddress);

    expect(await readRewardsState(rewards, comet.address, [albert.address], world)).to.deep.equal(before);
  }
);

// UH-09
scenario(
  'CometRewards#claimTo > reverts NotPermitted with the caller for an unauthorised caller',
  {
    // the permission check reverts before any accrual, so this row needs a
    // configured market but not a paying one
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert, betty } = actors;
    await setupSupplyPosition(context, world, albert);
    expect(await comet.hasPermission(albert.address, betty.address)).to.be.false;

    const accruedBefore = (await comet.baseTrackingAccrued(albert.address)).toBigInt();
    const accounts = [albert.address, betty.address];
    const before = await readRewardsState(rewards, comet.address, accounts, world);

    // the arg is the CALLER, not src
    await expect(rewards.connect(betty.signer).claimTo(comet.address, albert.address, betty.address, true))
      .to.be.revertedWithCustomError(rewards, 'NotPermitted')
      .withArgs(betty.address);

    expect(await readRewardsState(rewards, comet.address, accounts, world)).to.deep.equal(before);
    expect((await comet.baseTrackingAccrued(albert.address)).toBigInt()).to.be.equal(accruedBefore);
  }
);

// UH-10
scenario(
  'CometRewards#claimTo > reverts NotPermitted for a revoked manager',
  {
    // the revoked manager is rejected before any accrual matters, so a configured
    // but non-paying market suffices
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert, betty } = actors;
    await setupSupplyPosition(context, world, albert);

    await albert.allow(betty, true);
    await rewards.connect(betty.signer).claimTo(comet.address, albert.address, betty.address, true);

    await albert.allow(betty, false);
    expect(await comet.hasPermission(albert.address, betty.address)).to.be.false;
    await world.increaseTime(duration.days(1));

    const accounts = [albert.address, betty.address];
    const before = await readRewardsState(rewards, comet.address, accounts, world);

    await expect(rewards.connect(betty.signer).claimTo(comet.address, albert.address, betty.address, true))
      .to.be.revertedWithCustomError(rewards, 'NotPermitted')
      .withArgs(betty.address);

    expect(await readRewardsState(rewards, comet.address, accounts, world)).to.deep.equal(before);
  }
);

// UH-11
scenario(
  'CometRewards#claim > reverts NotSupported for an unconfigured market',
  {},
  async ({ comet, rewards, actors }, _, world) => {
    const { albert } = actors;
    const unconfigured = await unconfiguredMarket(rewards, comet);

    const before = await readRewardsState(rewards, comet.address, [albert.address], world);
    const claimedBefore = (await rewards.rewardsClaimed(unconfigured, albert.address)).toBigInt();

    await expect(rewards.connect(albert.signer).claim(unconfigured, albert.address, true))
      .to.be.revertedWithCustomError(rewards, 'NotSupported')
      .withArgs(unconfigured);

    expect(await readRewardsState(rewards, comet.address, [albert.address], world)).to.deep.equal(before);
    expect((await rewards.rewardsClaimed(unconfigured, albert.address)).toBigInt()).to.be.equal(claimedBefore);
  }
);

// UH-12
scenario(
  'CometRewards#getRewardOwed > reverts NotSupported for an unconfigured market',
  {},
  async ({ comet, rewards, actors }, _, world) => {
    const { albert } = actors;
    const unconfigured = await unconfiguredMarket(rewards, comet);

    const before = await readRewardsState(rewards, comet.address, [albert.address], world);

    await expect(rewards.callStatic.getRewardOwed(unconfigured, albert.address))
      .to.be.revertedWithCustomError(rewards, 'NotSupported')
      .withArgs(unconfigured);
    await expect(rewards.connect(albert.signer).getRewardOwed(unconfigured, albert.address))
      .to.be.revertedWithCustomError(rewards, 'NotSupported')
      .withArgs(unconfigured);

    expect(await readRewardsState(rewards, comet.address, [albert.address], world)).to.deep.equal(before);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

// EC-00
scenario(
  'CometRewards#claim > is a silent no-op on a repeated claim',
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'supply'),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    await setupSupplyPosition(context, world, albert);
    await rewards.connect(albert.signer).claim(comet.address, albert.address, true);

    const rewardBalAfterFirst = (await rewardToken.balanceOf(albert.address)).toBigInt();
    const claimedAfterFirst = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    const accruedAfterFirst = (await comet.baseTrackingAccrued(albert.address)).toBigInt();

    expect((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt()).to.be.equal(0n);

    // shouldAccrue = false, so the converted accrual equals the booked amount exactly
    const txn = await (await rewards.connect(albert.signer).claim(comet.address, albert.address, false)).wait();

    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(rewardBalAfterFirst);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(claimedAfterFirst);
    expect((await comet.baseTrackingAccrued(albert.address)).toBigInt()).to.be.equal(accruedAfterFirst);

    return txn;
  }
);

// EC-01
scenario(
  'CometRewards#claim > is a no-op for a zero-accrual account',
  {},
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);
    const fresh = await context.allocateActor('fresh');

    expect((await comet.baseTrackingAccrued(fresh.address)).toBigInt()).to.be.equal(0n);
    expect((await rewards.rewardsClaimed(comet.address, fresh.address)).toBigInt()).to.be.equal(0n);
    expect((await rewardToken.balanceOf(fresh.address)).toBigInt()).to.be.equal(0n);

    await world.increaseTime(duration.days(1));

    expect((await rewards.callStatic.getRewardOwed(comet.address, fresh.address)).owed.toBigInt()).to.be.equal(0n);

    const txn = await (await rewards.connect(albert.signer).claim(comet.address, fresh.address, true)).wait();

    expect((await rewardToken.balanceOf(fresh.address)).toBigInt()).to.be.equal(0n);
    expect((await rewards.rewardsClaimed(comet.address, fresh.address)).toBigInt()).to.be.equal(0n);
    expect((await comet.baseTrackingAccrued(fresh.address)).toBigInt()).to.be.equal(0n);

    return txn;
  }
);

// EC-02
scenario(
  'CometRewards#claim > pays nothing when bookkeeping is set above the accrual',
  {
    filter: async (ctx: CometContext) =>
      (await canAccrueRewards(ctx, 'supply')) && (await supportsSetRewardsClaimed(ctx)),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);
    const governor = await impersonateGovernor(rewards, world);

    const { baseAssetAddress, checkpointAmount } = await setupSupplyPosition(context, world, albert);
    await albert.safeSupplyAsset({ asset: baseAssetAddress, amount: checkpointAmount });

    const A = scaleAccrued((await comet.baseTrackingAccrued(albert.address)).toBigInt(), config);
    expect(A > 0n).to.be.true;

    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    await rewards.connect(governor).setRewardsClaimed(comet.address, [albert.address], [A * 2n]);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(A * 2n);
    expect(claimedBefore).to.not.be.equal(A * 2n);

    const rewardBalBefore = (await rewardToken.balanceOf(albert.address)).toBigInt();
    expect((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt()).to.be.equal(0n);

    const txn = await (await rewards.connect(albert.signer).claim(comet.address, albert.address, false)).wait();

    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(rewardBalBefore);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(A * 2n);

    return txn;
  }
);

// EC-03
scenario(
  'CometRewards#claim > pays only the excess above governor-set bookkeeping',
  {
    filter: async (ctx: CometContext) =>
      (await canAccrueRewards(ctx, 'supply')) && (await supportsSetRewardsClaimed(ctx)),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);
    const governor = await impersonateGovernor(rewards, world);

    const { baseAssetAddress, checkpointAmount } = await setupSupplyPosition(context, world, albert);
    await albert.safeSupplyAsset({ asset: baseAssetAddress, amount: checkpointAmount });

    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(0n);
    const A = scaleAccrued((await comet.baseTrackingAccrued(albert.address)).toBigInt(), config);
    expect(A > 0n).to.be.true;
    const C = A / 2n;

    await rewards.connect(governor).setRewardsClaimed(comet.address, [albert.address], [C]);
    const rewardBalBefore = (await rewardToken.balanceOf(albert.address)).toBigInt();

    // shouldAccrue = false, so the converted accrual stays exactly A
    const txn = await (await rewards.connect(albert.signer).claim(comet.address, albert.address, false)).wait();

    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(rewardBalBefore + (A - C));
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(A);
    expect(C).to.not.be.equal(A);
    expect((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt()).to.be.equal(0n);

    return txn;
  }
);

// EC-04
scenario(
  'CometRewards#claim > re-pays the delta after the bookkeeping is lowered',
  {
    filter: async (ctx: CometContext) =>
      (await canAccrueRewards(ctx, 'supply')) && (await supportsSetRewardsClaimed(ctx)),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);
    const governor = await impersonateGovernor(rewards, world);

    await setupSupplyPosition(context, world, albert);
    await rewards.connect(albert.signer).claim(comet.address, albert.address, true);

    const A = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    expect(A > 0n).to.be.true;
    const rewardBalAfterFirst = (await rewardToken.balanceOf(albert.address)).toBigInt();
    const L = A / 2n;

    await rewards.connect(governor).setRewardsClaimed(comet.address, [albert.address], [L]);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(L);
    expect(A).to.not.be.equal(L);

    await ensureFunded(context, rewards, config.token, A - L);
    const rewardsBalBefore = (await rewardToken.balanceOf(rewards.address)).toBigInt();

    // shouldAccrue = false, so the converted accrual stays exactly A
    const txn = await (await rewards.connect(albert.signer).claim(comet.address, albert.address, false)).wait();

    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(rewardBalAfterFirst + (A - L));
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(A);
    expect((await rewardToken.balanceOf(rewards.address)).toBigInt()).to.be.equal(rewardsBalBefore - (A - L));

    return txn;
  }
);

// EC-05
scenario(
  'CometRewards#setRewardsClaimed > succeeds with empty arrays and writes nothing',
  {
    filter: async (ctx: CometContext) => await supportsSetRewardsClaimed(ctx)
  },
  async ({ comet, rewards, actors }, _, world) => {
    const { albert } = actors;
    const governor = await impersonateGovernor(rewards, world);

    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    const governorBefore = await rewards.governor();

    // equal lengths (0 == 0) pass the length check and the loop body never runs
    const txn = await (await rewards.connect(governor).setRewardsClaimed(comet.address, [], [])).wait();

    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(claimedBefore);
    expect(await rewards.governor()).to.be.equal(governorBefore);

    return txn;
  }
);

// EC-06
scenario(
  'CometRewards#setRewardsClaimed > writes each amount to its own user',
  {
    filter: async (ctx: CometContext) => await supportsSetRewardsClaimed(ctx)
  },
  async ({ comet, rewards, actors }, _, world) => {
    const { albert, betty, charles } = actors;
    const governor = await impersonateGovernor(rewards, world);

    const users = [albert.address, betty.address, charles.address];
    const claimedBefore = await Promise.all(
      users.map(async (u) => (await rewards.rewardsClaimed(comet.address, u)).toBigInt())
    );
    // pairwise different, so a mis-indexed write is detectable
    const amounts = [exp(1, 18), exp(2, 18), exp(3, 18)];

    const txn = await (await rewards.connect(governor).setRewardsClaimed(comet.address, users, amounts)).wait();

    for (let i = 0; i < users.length; i++) {
      expect((await rewards.rewardsClaimed(comet.address, users[i])).toBigInt()).to.be.equal(amounts[i]);
      expect(claimedBefore[i]).to.not.be.equal(amounts[i]);
    }

    return txn;
  }
);

// EC-07
scenario(
  'CometRewards#claim > pays less with shouldAccrue false than with true after idle time',
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'supply'),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    expect((await comet.baseTrackingAccrued(albert.address)).toBigInt()).to.be.equal(0n);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(0n);

    // the supply checkpoints the accrual at 0; nothing re-checkpoints it afterwards
    await setupSupplyPosition(context, world, albert);

    const rewardBalBefore = (await rewardToken.balanceOf(albert.address)).toBigInt();
    expect((await comet.baseTrackingAccrued(albert.address)).toBigInt()).to.be.equal(0n);

    await rewards.connect(albert.signer).claim(comet.address, albert.address, false);

    const balAfterStep1 = (await rewardToken.balanceOf(albert.address)).toBigInt();
    expect(balAfterStep1).to.be.equal(rewardBalBefore);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(0n);
    expect((await comet.baseTrackingAccrued(albert.address)).toBigInt()).to.be.equal(0n);

    const txn = await (await rewards.connect(albert.signer).claim(comet.address, albert.address, true)).wait();

    const accruedAfterStep2 = (await comet.baseTrackingAccrued(albert.address)).toBigInt();
    expect(accruedAfterStep2 > 0n).to.be.true;

    const scaledAfterStep2 = scaleAccrued(accruedAfterStep2, config);
    const balAfterStep2 = (await rewardToken.balanceOf(albert.address)).toBigInt();
    expect(balAfterStep2).to.be.equal(rewardBalBefore + scaledAfterStep2);
    expect(balAfterStep2 > balAfterStep1).to.be.true;
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(scaledAfterStep2);

    return txn;
  }
);

// EC-08
scenario(
  'CometRewards#claim > pays the amount defined by the deployed reward config conversion',
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'supply'),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    const { baseAssetAddress, checkpointAmount } = await setupSupplyPosition(context, world, albert);
    const checkpoint = await albert.safeSupplyAsset({
      asset: baseAssetAddress,
      amount: checkpointAmount
    });

    const targetTimestamp = checkpoint.blockNumber;

    const raw = (await comet.baseTrackingAccrued(albert.address, { blockTag: targetTimestamp })).toBigInt();
    expect(raw > 0n).to.be.true;
    const claimedBefore = (
      await rewards.rewardsClaimed(comet.address, albert.address, { blockTag: targetTimestamp })
    ).toBigInt();

    const owedBefore = (
      await rewards.callStatic.getRewardOwed(comet.address, albert.address, { blockTag: targetTimestamp })
    ).owed.toBigInt();
    expect(owedBefore).to.be.equal(scaleAccrued(raw, config) - claimedBefore);
    expect(
      (await rewards.callStatic.getRewardOwed(comet.address, albert.address, { blockTag: targetTimestamp })).token
    ).to.be.equal(config.token);

    const rewardBalBefore = (await rewardToken.balanceOf(albert.address)).toBigInt();

    // shouldAccrue = false pins the converted accrual to `raw`, leaving the
    // conversion as the only variable under test
    const txn = await (await rewards.connect(albert.signer).claim(comet.address, albert.address, false)).wait();

    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(rewardBalBefore + owedBefore);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(
      scaleAccrued(raw, config)
    );
    expect(claimedBefore).to.not.be.equal(scaleAccrued(raw, config));

    return txn;
  }
);

// EC-09
scenario(
  'CometRewards#withdrawToken > succeeds and moves nothing when amount is zero',
  {},
  async ({ comet, rewards, actors }, _, world) => {
    const { charles } = actors;
    const governor = await impersonateGovernor(rewards, world);
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    const rewardsBalBefore = (await rewardToken.balanceOf(rewards.address)).toBigInt();
    const toBalBefore = (await rewardToken.balanceOf(charles.address)).toBigInt();

    // there is no zero-amount guard
    const txn = await (await rewards.connect(governor).withdrawToken(config.token, charles.address, 0)).wait();

    expect((await rewardToken.balanceOf(rewards.address)).toBigInt()).to.be.equal(rewardsBalBefore);
    expect((await rewardToken.balanceOf(charles.address)).toBigInt()).to.be.equal(toBalBefore);

    return txn;
  }
);

// EC-10
scenario(
  'CometRewards#setRewardsClaimed > writes bookkeeping for an unconfigured market',
  {
    filter: async (ctx: CometContext) => await supportsSetRewardsClaimed(ctx)
  },
  async ({ comet, rewards, actors }, _, world) => {
    const { albert } = actors;
    const governor = await impersonateGovernor(rewards, world);
    const unconfigured = await unconfiguredMarket(rewards, comet);

    const claimedBefore = (await rewards.rewardsClaimed(unconfigured, albert.address)).toBigInt();
    const configBefore = await readRewardConfig(rewards, unconfigured);
    const amount = exp(1, 18);

    // there is NO config check on this path
    const txn = await (
      await rewards.connect(governor).setRewardsClaimed(unconfigured, [albert.address], [amount])
    ).wait();

    expect((await rewards.rewardsClaimed(unconfigured, albert.address)).toBigInt()).to.be.equal(amount);
    expect(claimedBefore).to.not.be.equal(amount);
    expect(await readRewardConfig(rewards, unconfigured)).to.deep.equal(configBefore);
    expect((await rewards.rewardConfig(unconfigured)).token).to.be.equal(constants.AddressZero);

    // bookkeeping alone does not make an address claimable
    await expect(rewards.connect(albert.signer).claim(unconfigured, albert.address, true))
      .to.be.revertedWithCustomError(rewards, 'NotSupported')
      .withArgs(unconfigured);

    return txn;
  }
);

// EC-11
scenario(
  'CometRewards#getRewardOwed > accrues the account when sent as a transaction',
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'supply'),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    await setupSupplyPosition(context, world, albert);

    const accruedBefore = (await comet.baseTrackingAccrued(albert.address)).toBigInt();
    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    const rewardBalBefore = (await rewardToken.balanceOf(albert.address)).toBigInt();

    // sent as a REAL transaction: this accrues `albert` on the market
    const txn = await (await rewards.connect(albert.signer).getRewardOwed(comet.address, albert.address)).wait();

    const accruedAfter = (await comet.baseTrackingAccrued(albert.address)).toBigInt();
    expect(accruedAfter > accruedBefore).to.be.true;
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(claimedBefore);
    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(rewardBalBefore);

    return txn;
  }
);

// EC-12
scenario(
  'CometRewards#claimTo > pays the owner when to equals src',
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'supply'),
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const config = await readRewardConfig(rewards, comet.address);
    const rewardToken = tokenAt(config.token, world);

    await setupSupplyPosition(context, world, albert);
    expect(await comet.hasPermission(albert.address, albert.address)).to.be.true;

    const rewardBalBefore = (await rewardToken.balanceOf(albert.address)).toBigInt();
    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();

    // `to == src` is accepted; the recipient is never validated
    const txn = await (
      await rewards.connect(albert.signer).claimTo(comet.address, albert.address, albert.address, true)
    ).wait();

    const accrued = scaleAccrued((await comet.baseTrackingAccrued(albert.address)).toBigInt(), config);
    const owed = accrued - claimedBefore;
    expect(owed > 0n).to.be.true;

    expect((await rewardToken.balanceOf(albert.address)).toBigInt()).to.be.equal(rewardBalBefore + owed);
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(accrued);
    expect(claimedBefore).to.not.be.equal(accrued);
    expect((await rewards.callStatic.getRewardOwed(comet.address, albert.address)).owed.toBigInt()).to.be.equal(0n);

    return txn;
  }
);

// EC-13
scenario(
  'CometRewards#setRewardsClaimed > keeps bookkeeping isolated per market',
  {
    filter: async (ctx: CometContext) =>
      (await supportsSetRewardsClaimed(ctx)) && (await findSiblingMarket(ctx)) !== undefined,
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $base: ` == ${getConfigForScenario(ctx).rewardsBase}` }
    })
  },
  async ({ comet, rewards, actors }, context, world) => {
    const { albert } = actors;
    const comet2Address = await findSiblingMarket(context);
    const governor = await impersonateGovernor(rewards, world);
    const comet2 = comet.attach(comet2Address) as CometInterface;

    const claimed2Before = (await rewards.rewardsClaimed(comet2Address, albert.address)).toBigInt();
    const accrued2Before = (await comet2.baseTrackingAccrued(albert.address)).toBigInt();

    const amount = claimed2Before + exp(1, 18);
    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    await rewards.connect(governor).setRewardsClaimed(comet.address, [albert.address], [amount]);

    // the mapping key is (comet, account), so writing `comet` cannot alias `comet2`
    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(amount);
    expect(claimedBefore).to.not.be.equal(amount);
    expect((await rewards.rewardsClaimed(comet2Address, albert.address)).toBigInt()).to.be.equal(claimed2Before);

    await setupSupplyPosition(context, world, albert);
    const txn = await (await rewards.connect(albert.signer).claim(comet.address, albert.address, true)).wait();

    expect((await rewards.rewardsClaimed(comet2Address, albert.address)).toBigInt()).to.be.equal(claimed2Before);
    expect((await comet2.baseTrackingAccrued(albert.address)).toBigInt()).to.be.equal(accrued2Before);

    return txn;
  }
);

// EC-14
scenario(
  'CometRewards#setRewardsClaimed > applies the last write for a duplicated user',
  {
    filter: async (ctx: CometContext) => await supportsSetRewardsClaimed(ctx)
  },
  async ({ comet, rewards, actors }, _, world) => {
    const { albert } = actors;
    const governor = await impersonateGovernor(rewards, world);

    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    const a1 = claimedBefore + exp(1, 18);
    const a2 = claimedBefore + exp(2, 18);

    // the same account twice in one length-matched call
    const txn = await (
      await rewards.connect(governor).setRewardsClaimed(comet.address, [albert.address, albert.address], [a1, a2])
    ).wait();

    // the LAST write wins: not a1, and not a1 + a2
    const after = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    expect(after).to.be.equal(a2);
    expect(after).to.not.be.equal(a1);
    expect(after).to.not.be.equal(a1 + a2);
    expect(claimedBefore).to.not.be.equal(after);

    return txn;
  }
);

// EC-15
scenario(
  'CometRewards#withdrawToken > sweeps an arbitrary token and leaves the reward token untouched',
  {},
  async ({ comet, rewards, actors }, context, world) => {
    const { charles } = actors;
    const governor = await impersonateGovernor(rewards, world);
    const config = await readRewardConfig(rewards, comet.address);

    const otherTokenAddress = await comet.getAssetInfo(1).then((info) => info.asset);
    expect(otherTokenAddress).to.not.be.equal(config.token);

    const otherToken = tokenAt(otherTokenAddress, world);
    const baseScale = (await comet.baseScale()).toBigInt();
    await context.sourceTokens(2n * baseScale, otherTokenAddress, rewards.address);

    const rewardsOtherBefore = (await otherToken.balanceOf(rewards.address)).toBigInt();
    expect(rewardsOtherBefore > 0n).to.be.true;
    const toOtherBefore = (await otherToken.balanceOf(charles.address)).toBigInt();
    const rewardsRewardBalBefore = (await tokenAt(config.token, world).balanceOf(rewards.address)).toBigInt();
    const amount = rewardsOtherBefore / 2n;
    expect(amount > 0n).to.be.true;

    // `token` is arbitrary; there is no check that it equals the configured reward token
    const txn = await (
      await rewards.connect(governor).withdrawToken(otherTokenAddress, charles.address, amount)
    ).wait();

    expect((await otherToken.balanceOf(charles.address)).toBigInt()).to.be.equal(toOtherBefore + amount);
    expect((await otherToken.balanceOf(rewards.address)).toBigInt()).to.be.equal(rewardsOtherBefore - amount);
    expect((await tokenAt(config.token, world).balanceOf(rewards.address)).toBigInt()).to.be.equal(
      rewardsRewardBalBefore
    );
    expect(await readRewardConfig(rewards, comet.address)).to.deep.equal(config);

    return txn;
  }
);

// EC-16
scenario(
  'CometRewards#transferGovernor > is a no-op that keeps the rights when handing to self',
  {
    filter: async (ctx: CometContext) => await supportsSetRewardsClaimed(ctx)
  },
  async ({ comet, rewards, actors }, _, world) => {
    const { albert } = actors;
    const governor = await impersonateGovernor(rewards, world);
    const governorAddress = await governor.getAddress();

    const claimedBefore = (await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt();
    const amount = claimedBefore + exp(1, 18);

    // hand the role to the address that already holds it
    await rewards.connect(governor).transferGovernor(governorAddress);
    expect(await rewards.governor()).to.be.equal(governorAddress);

    // the caller still passes the msg.sender == governor gate
    const txn = await (
      await rewards.connect(governor).setRewardsClaimed(comet.address, [albert.address], [amount])
    ).wait();

    expect((await rewards.rewardsClaimed(comet.address, albert.address)).toBigInt()).to.be.equal(amount);
    expect(claimedBefore).to.not.be.equal(amount);

    return txn;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Alerts
//
// These do not exercise contract behaviour. They surface an operational condition:
// a deployed rewards contract holding too little of its reward token to cover the
// claims its market is actively accruing. A failure is a signal to top the contract
// up on that network, not a defect in the code under review.
// ─────────────────────────────────────────────────────────────────────────────

scenario(
  `CometRewards#claim > supply side is funded for ${REWARD_COVERAGE_DAYS} days of rewards`,
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'supply')
  },
  async ({ comet, rewards }, _context, world) => {
    const config = await readRewardConfig(rewards, comet.address);
    // canAccrueRewards implies an accruing market; only assert where rewards are wired up
    if (config.token === constants.AddressZero) return;

    const rewardToken = tokenAt(config.token, world);
    const balance = (await rewardToken.balanceOf(rewards.address)).toBigInt();
    const min = await minRewardsBalance(comet, config, 'supply');

    expect(
      balance >= min,
      `CometRewards ${rewards.address} on ${world.base.network}/${world.base.deployment} ` +
        `holds ${balance} reward tokens, below the ${min} the whole supply side emits in ` +
        `~${REWARD_COVERAGE_DAYS} days — top up the rewards contract`
    ).to.be.true;
  }
);

scenario(
  `CometRewards#claim > borrow side is funded for ${REWARD_COVERAGE_DAYS} days of rewards`,
  {
    filter: async (ctx: CometContext) => await canAccrueRewards(ctx, 'borrow')
  },
  async ({ comet, rewards }, _context, world) => {
    const config = await readRewardConfig(rewards, comet.address);
    // canAccrueRewards implies an accruing market; only assert where rewards are wired up
    if (config.token === constants.AddressZero) return;

    const rewardToken = tokenAt(config.token, world);
    const balance = (await rewardToken.balanceOf(rewards.address)).toBigInt();
    const min = await minRewardsBalance(comet, config, 'borrow');

    expect(
      balance >= min,
      `CometRewards ${rewards.address} on ${world.base.network}/${world.base.deployment} ` +
        `holds ${balance} reward tokens, below the ${min} the whole borrow side emits in ` +
        `~${REWARD_COVERAGE_DAYS} days — top up the rewards contract`
    ).to.be.true;
  }
);
