import { scenario } from './context/CometContext';
import { ethers, expect, defactor } from '../test/helpers';
import { createCrossChainProposal, expectRevertCustom, timeUntilUnderwater, isBridgedDeployment } from './utils';
import { matchesDeployment } from './utils';
import { getConfigForScenario } from './utils/scenarioHelper';

scenario(
  'Comet#liquidation > isLiquidatable=true for underwater position',
  {
    tokenBalances: async (ctx) => (
      {
        $comet: {
          $base: getConfigForScenario(ctx).liquidation.base.standard
        }
      }),
    cometBalances: async (ctx) => ({
      albert: { $base: -getConfigForScenario(ctx).liquidation.base.standard },
      betty: { $base: getConfigForScenario(ctx).liquidation.base.standard }
    }),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseToken = await comet.baseToken();
    const baseScale = await comet.baseScale();

    const timeBeforeLiquidation = await timeUntilUnderwater({
      comet,
      actor: albert,
      fudgeFactor: config.liquidationBot.scenario.fudgeFactorLong
    });

    while(!(await comet.isLiquidatable(albert.address))) {
      await comet.accrueAccount(albert.address);
      await world.increaseTime(timeBeforeLiquidation);
    }

    await betty.withdrawAsset({ asset: baseToken, amount: BigInt(config.liquidation.base.standard) / 100n * baseScale.toBigInt() }); // force accrue

    expect(await comet.isLiquidatable(albert.address)).to.be.true;
  }
);

scenario(
  'Comet#liquidation > allows liquidation of underwater positions with token fees',
  {
    tokenBalances: async (ctx) => ({
      $comet: { $base: getConfigForScenario(ctx).liquidation.base.medium }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.base.medium,
        $asset0: getConfigForScenario(ctx).liquidation.asset.tiny
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.asset.small }
    }),
    filter: async (ctx) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }]),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    // Set fees for USDT for testing
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      world.deploymentManager.hre.ethers.utils.hexStripZeros(world.deploymentManager.hre.ethers.utils.parseEther('100').toHexString()),
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress],
    });
    // mine a block to ensure the impersonation is effective
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    // 10 basis points, and max 10 USDT
    await USDT.connect(USDTAdminSigner).setParams(10, 10);

    const { albert, betty } = actors;

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: config.liquidationBot.scenario.fudgeFactorShort // 10 minutes past when position is underwater
      })
    );

    const lp0 = await comet.liquidatorPoints(betty.address);

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const lp1 = await comet.liquidatorPoints(betty.address);

    // increments absorber's numAbsorbs
    expect(lp1.numAbsorbs).to.eq(lp0.numAbsorbs + 1);
    // increases absorber's numAbsorbed
    expect(lp1.numAbsorbed.toNumber()).to.eq(lp0.numAbsorbed.toNumber() + 1);
    // XXX test approxSpend?

    const baseBalance = await albert.getCometBaseBalance();
    expect(Number(baseBalance)).to.be.greaterThanOrEqual(0);

    // clears out all of liquidated user's collateral
    const numAssets = await comet.numAssets();
    for (let i = 0; i < numAssets; i++) {
      const { asset } = await comet.getAssetInfo(i);
      expect(await comet.collateralBalanceOf(albert.address, asset)).to.eq(0);
    }

    // clears assetsIn
    expect((await comet.userBasic(albert.address)).assetsIn).to.eq(0);
  }
);

scenario(
  'Comet#liquidation > prevents liquidation when absorb is paused',
  {
    tokenBalances: async (ctx) => (
      {
        $comet: {
          $base: getConfigForScenario(ctx).liquidation.base.standard
        }
      }),
    cometBalances: async (ctx) => ({
      albert: { $base: -getConfigForScenario(ctx).liquidation.base.standard },
      betty: { $base: getConfigForScenario(ctx).liquidation.base.standard }
    }),
    pause: {
      absorbPaused: true,
    },
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseToken = await comet.baseToken();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: config.liquidationBot.scenario.fudgeFactorShort
      })
    );

    await betty.withdrawAsset({ asset: baseToken, amount: baseBorrowMin });

    await expectRevertCustom(
      betty.absorb({ absorber: betty.address, accounts: [albert.address] }),
      'Paused()'
    );
  }
);

scenario.only(
  'Comet#liquidation > allows liquidation of underwater positions',
  {
    tokenBalances: async (ctx) => (
      {
        $comet: {
          $base: getConfigForScenario(ctx).liquidation.base.standard
        }
      }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.base.standard,
        $asset0: getConfigForScenario(ctx).liquidation.asset.standard
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.base.standard }
    }),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    

    const timeBeforeLiquidation = await timeUntilUnderwater({
      comet,
      actor: albert,
      fudgeFactor: config.liquidationBot.scenario.fudgeFactorLong
    });

    
    await world.increaseTime(timeBeforeLiquidation);
    await comet.accrueAccount(albert.address);

    const lp0 = await comet.liquidatorPoints(betty.address);

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const lp1 = await comet.liquidatorPoints(betty.address);

    // increments absorber's numAbsorbs
    expect(lp1.numAbsorbs).to.eq(lp0.numAbsorbs + 1);
    // increases absorber's numAbsorbed
    expect(lp1.numAbsorbed.toNumber()).to.eq(lp0.numAbsorbed.toNumber() + 1);
    // XXX test approxSpend?

    const baseBalance = await albert.getCometBaseBalance();
    expect(Number(baseBalance)).to.be.greaterThanOrEqual(0);

    // clears out all of liquidated user's collateral
    const numAssets = await comet.numAssets();
    for (let i = 0; i < numAssets; i++) {
      const { asset } = await comet.getAssetInfo(i);
      expect(await comet.collateralBalanceOf(albert.address, asset)).to.eq(0);
    }

    // clears assetsIn
    expect((await comet.userBasic(albert.address)).assetsIn).to.eq(0);
  }
);

scenario(
  'Comet#liquidation > user can end up with a minted supply',
  {
    filter: async (ctx) => !matchesDeployment(ctx, [{ network: 'base', deployment: 'usds' }, { network: 'scroll', deployment: 'usdc' }]),
    tokenBalances: async (ctx) => (
      {
        $comet: {
          $base: getConfigForScenario(ctx).liquidation.base.standard
        }
      }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.base.standard,
        $asset0: getConfigForScenario(ctx).liquidation.asset.standard
      }
    }),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    await world.increaseTime(
      Math.round(await timeUntilUnderwater({
        comet,
        actor: albert,
      }) * config.liquidation.timeMultiplier)
    );

    const ab0 = await betty.absorb({ absorber: betty.address, accounts: [albert.address] });
    
    const baseBalance = await albert.getCometBaseBalance();
    expect(Number(baseBalance)).to.be.greaterThan(0);
    
    const transferEvent = ab0.events?.find((e: any) => e.event === 'Transfer');
    expect(transferEvent).to.not.be.undefined;
    expect(transferEvent?.event).to.be.equal('Transfer');
  }
);

scenario(
  'Comet#liquidation > governor can withdraw collateral after successful liquidation',
  {
    filter: async (ctx) => {
      const isBaseUsds = ctx.world.base.network === 'base' && ctx.world.base.deployment === 'usds';
      return !isBaseUsds && (isBridgedDeployment(ctx) || ['mainnet', 'sepolia'].includes(ctx.world.base.network));
    },
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.base.standard,
        $asset0: defactor(getConfigForScenario(ctx).liquidation.asset.tiny)
      },
    }),
  },
  async ({ comet, actors, bridgeReceiver }, context, world) => {
    const config = getConfigForScenario(context);
    const { admin, albert, betty } = actors;
    const { asset: asset0Address, scale } = await comet.getAssetInfo(0);

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: config.liquidationBot.scenario.fudgeFactorShort
      })
    );

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const reserves = await comet.getCollateralReserves(asset0Address);

    const approveThisCalldata = ethers.utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint256'],
      [admin.address, asset0Address, ethers.constants.MaxUint256]
    );

    const l1Networks = ['mainnet', 'sepolia'];

    if (l1Networks.includes(world.base.network)) {
      await context.fastGovernanceExecute(
        [comet.address],
        [0],
        ['approveThis(address,address,uint256)'],
        [approveThisCalldata]
      );
    } else {
      if (!isBridgedDeployment(context)) {
        throw new Error('Cannot create cross-chain proposal without auxiliary deployment manager');
      }
      const l2ProposalData = ethers.utils.defaultAbiCoder.encode(
        ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
        [
          [comet.address],
          [0],
          ['approveThis(address,address,uint256)'],
          [approveThisCalldata]
        ]
      );
      await createCrossChainProposal(context, l2ProposalData, bridgeReceiver);
    }

    const asset0Contract = await world.deploymentManager.existing(
      'asset0',
      asset0Address,
      world.base.network,
      'contracts/IERC20.sol:IERC20'
    );

    const withdrawAmount = reserves.gt(scale.div(config.liquidationBot.scenario.collateralDivisor)) 
      ? scale.toBigInt() / config.liquidationBot.scenario.collateralDivisor 
      : reserves;

    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      admin.address,
      world.deploymentManager.hre.ethers.utils.hexStripZeros(world.deploymentManager.hre.ethers.utils.parseEther('1').toHexString()),
    ]);

    await asset0Contract
      .connect(admin.signer)
      .transferFrom(comet.address, admin.address, withdrawAmount);

    const finalReserves = await comet.getCollateralReserves(asset0Address);
    expect(finalReserves).to.equal(reserves.sub(withdrawAmount));
  }
);