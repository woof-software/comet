import { scenario } from './context/CometContext';
import { ethers, expect, defactor } from '../test/helpers';
import { expectRevertCustom, isBridgedDeployment, timeUntilUnderwater } from './utils';
import { matchesDeployment } from './utils';
import { getConfigForScenario } from './utils/scenarioHelper';

scenario(
  'Comet#liquidation > isLiquidatable=true for underwater position',
  {
    tokenBalances: async (ctx) => (
      {
        $comet: {
          $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal
        }
      }),
    cometBalances: async (ctx) => ({
      albert: { $base: -getConfigForScenario(ctx).liquidation.base.borrowPrincipal },
      betty: { $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal }
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

    await betty.withdrawAsset({ asset: baseToken, amount: config.liquidation.base.borrowPrincipal / 100n * baseScale.toBigInt() }); // force accrue

    expect(await comet.isLiquidatable(albert.address)).to.be.true;
  }
);

scenario(
  'Comet#liquidation > allows liquidation of underwater positions with token fees',
  {
    tokenBalances: async (ctx) => ({
      $comet: { $base: getConfigForScenario(ctx).liquidation.base.undercollateralized }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.base.undercollateralized,
        $asset0: getConfigForScenario(ctx).liquidation.asset.smallPosition
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.asset.smallPosition }
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
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    // 10 basis points, and max 10 USDT
    await USDT.connect(USDTAdminSigner).setParams(10, 10);

    const { albert, betty } = actors;

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: config.liquidationBot.scenario.fudgeFactorShort
      })
    );

    const lp0 = await comet.liquidatorPoints(betty.address);

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const lp1 = await comet.liquidatorPoints(betty.address);

    expect(lp1.numAbsorbs).to.eq(lp0.numAbsorbs + 1);
    expect(lp1.numAbsorbed.toNumber()).to.eq(lp0.numAbsorbed.toNumber() + 1);

    const baseBalance = await albert.getCometBaseBalance();
    expect(Number(baseBalance)).to.be.greaterThanOrEqual(0);

    const numAssets = await comet.numAssets();
    for (let i = 0; i < numAssets; i++) {
      const { asset } = await comet.getAssetInfo(i);
      expect(await comet.collateralBalanceOf(albert.address, asset)).to.eq(0);
    }

    expect((await comet.userBasic(albert.address)).assetsIn).to.eq(0);
  }
);

scenario(
  'Comet#liquidation > prevents liquidation when absorb is paused',
  {
    tokenBalances: async (ctx) => (
      {
        $comet: {
          $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal
        }
      }),
    cometBalances: async (ctx) => ({
      albert: { $base: -getConfigForScenario(ctx).liquidation.base.borrowPrincipal },
      betty: { $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal }
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

scenario(
  'Comet#liquidation > allows liquidation of underwater positions',
  {
    tokenBalances: async (ctx) => (
      {
        $comet: {
          $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal
        }
      }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.base.borrowPrincipal,
        $asset0: getConfigForScenario(ctx).liquidation.asset.supplyAmount
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal }
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

    while(!(await comet.isLiquidatable(albert.address))) {
      await comet.accrueAccount(albert.address);
      await world.increaseTime(timeBeforeLiquidation);
    }

    const lp0 = await comet.liquidatorPoints(betty.address);

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const lp1 = await comet.liquidatorPoints(betty.address);

    expect(lp1.numAbsorbs).to.eq(lp0.numAbsorbs + 1);
    expect(lp1.numAbsorbed.toNumber()).to.eq(lp0.numAbsorbed.toNumber() + 1);

    const baseBalance = await albert.getCometBaseBalance();
    expect(Number(baseBalance)).to.be.greaterThanOrEqual(0);

    const numAssets = await comet.numAssets();
    for (let i = 0; i < numAssets; i++) {
      const { asset } = await comet.getAssetInfo(i);
      expect(await comet.collateralBalanceOf(albert.address, asset)).to.eq(0);
    }

    expect((await comet.userBasic(albert.address)).assetsIn).to.eq(0);
  }
);

scenario(
  'Comet#liquidation > user can end up with a minted supply',
  {
    filter: async (ctx) => !matchesDeployment(ctx, [{ network: 'base', deployment: 'usds' }]),
    tokenBalances: async (ctx) => (
      {
        $comet: {
          $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal
        }
      }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.base.borrowPrincipal,
        $asset0: getConfigForScenario(ctx).liquidation.asset.supplyAmount
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

    const userPrincipal = (await comet.userBasic(albert.address)).principal;
    const baseBalance = await albert.getCometBaseBalance();

    if (userPrincipal.toBigInt() > 0n) {
      expect(ab0.events?.[2]?.event).to.be.equal('Transfer');
      expect(Number(baseBalance)).to.be.greaterThan(0);
    } else {
      expect(Number(baseBalance)).to.be.equal(0);
    }
  }
);

/**
 * @note We work here with token with index 1, as wbtc market has USDT as zero collateral and has not function `transferFrom`
 */
scenario(
  'Comet#liquidation > governor can withdraw collateral after successful liquidation',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.base.borrowPrincipal,
        $asset1: getConfigForScenario(ctx).liquidation.asset.smallPosition
      },
    }),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { admin, albert, betty } = actors;
    const { asset, scale } = await comet.getAssetInfo(1);

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: config.liquidationBot.scenario.fudgeFactorShort
      })
    );

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const reserves = await comet.getCollateralReserves(asset);
    console.log('Collateral reserves available:', reserves.toString());

    const approveThisCalldata = ethers.utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint256'],
      [admin.address, asset, ethers.constants.MaxUint256]
    );
    
    await context.fastGovernanceExecute(
      [comet.address],
      [0],
      ['approveThis(address,address,uint256)'],
      [approveThisCalldata]
    );

    const asset1Contract = await world.deploymentManager.existing(
      'asset1',
      asset,
      world.base.network
    );
    
    const withdrawAmount = reserves.gt(scale.div(config.liquidationBot.scenario.collateralDivisor)) 
      ? scale.toBigInt() / config.liquidationBot.scenario.collateralDivisor 
      : reserves;

    await context.setNextBaseFeeToZero();
    await asset1Contract
      .connect(admin.signer)
      .transferFrom(comet.address, admin.address, withdrawAmount, { gasPrice: 0 });

    const finalReserves = await comet.getCollateralReserves(asset);
    expect(finalReserves).to.equal(reserves.sub(withdrawAmount));
  }
);

scenario(
  'Comet#liquidation > liquidates position with all collateral types',
  {
    tokenBalances: async (ctx) => ({
      $comet: {
        $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal
      }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.base.borrowPrincipal,
        $asset0: defactor(getConfigForScenario(ctx).liquidation.asset.supplyAmount),
        $asset1: getConfigForScenario(ctx).liquidation.asset.smallPosition
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal }
    }),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const numAssets = await comet.numAssets();

    const timeBeforeLiquidation = await timeUntilUnderwater({
      comet,
      actor: albert,
      fudgeFactor: config.liquidationBot.scenario.fudgeFactorLong
    });

    while(!(await comet.isLiquidatable(albert.address))) {
      await comet.accrueAccount(albert.address);
      await world.increaseTime(timeBeforeLiquidation);
    }

    const lp0 = await comet.liquidatorPoints(betty.address);

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const lp1 = await comet.liquidatorPoints(betty.address);

    expect(lp1.numAbsorbs).to.eq(lp0.numAbsorbs + 1);
    expect(lp1.numAbsorbed.toNumber()).to.eq(lp0.numAbsorbed.toNumber() + 1);

    for (let i = 0; i < numAssets; i++) {
      const { asset } = await comet.getAssetInfo(i);
      expect(await comet.collateralBalanceOf(albert.address, asset)).to.eq(0);
    }

    const baseBalance = await albert.getCometBaseBalance();
    expect(Number(baseBalance)).to.be.greaterThanOrEqual(0);

    expect((await comet.userBasic(albert.address)).assetsIn).to.eq(0);
  }
);

scenario(
  'Comet#liquidation > debt covered with each collateral type separately',
  {
    tokenBalances: async (ctx) => ({
      $comet: {
        $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal
      }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $asset0: getConfigForScenario(ctx).liquidation.asset.supplyAmount
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal }
    }),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseToken = await comet.baseToken();
    const { asset: collateralAsset0 } = await comet.getAssetInfo(0);

    const { borrowCollateralFactor, priceFeed, scale } = await comet.getAssetInfo(0);
    const userCollateral = await comet.collateralBalanceOf(albert.address, collateralAsset0);
    const price = await comet.getPrice(priceFeed);
    const factorScale = await comet.factorScale();
    const priceScale = await comet.priceScale();
    const baseScale = await comet.baseScale();

    const collateralValue = userCollateral.mul(price).div(scale);
    const borrowCapacity = collateralValue.mul(borrowCollateralFactor).mul(baseScale).div(factorScale).div(priceScale);
    const borrowAmount = borrowCapacity.mul(config.liquidationBot.scenario.borrowCapacityUtilizationHigh).div(100n);

    await albert.withdrawAsset({
      asset: baseToken,
      amount: borrowAmount
    });

    while(!(await comet.isLiquidatable(albert.address))) {
      await comet.accrueAccount(albert.address);
      await world.increaseTime(
        await timeUntilUnderwater({
          comet,
          actor: albert,
          fudgeFactor: config.liquidationBot.scenario.fudgeFactorShort
        })
      );
    }

    const lp0 = await comet.liquidatorPoints(betty.address);

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const lp1 = await comet.liquidatorPoints(betty.address);

    expect(lp1.numAbsorbs).to.eq(lp0.numAbsorbs + 1);
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset0)).to.eq(0);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;
  }
);

scenario(
  'Comet#liquidation > small position liquidation',
  {
    tokenBalances: async (ctx) => ({
      $comet: { $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal * 10n }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.base.borrowPrincipal,
        $asset0: getConfigForScenario(ctx).liquidation.asset.smallPosition
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal }
    }),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    // Check if already liquidatable, if not, wait until underwater
    if (!(await comet.isLiquidatable(albert.address))) {
      const timeBeforeLiquidation = await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: config.liquidationBot.scenario.fudgeFactorLong
      });
      
      // Ensure time is reasonable to avoid overflow
      const timeToIncrease = Math.min(Math.max(timeBeforeLiquidation, 1), 365 * 24 * 60 * 60); // Max 1 year
      
      while(!(await comet.isLiquidatable(albert.address))) {
        await comet.accrueAccount(albert.address);
        await world.increaseTime(timeToIncrease);
      }
    }

    const { asset: collateralAsset } = await comet.getAssetInfo(0);
    const initialCollateral = await comet.collateralBalanceOf(albert.address, collateralAsset);

    expect(await comet.isLiquidatable(albert.address)).to.be.true;
    expect(initialCollateral).to.be.greaterThan(0);

    const lp0 = await comet.liquidatorPoints(betty.address);

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const lp1 = await comet.liquidatorPoints(betty.address);

    expect(lp1.numAbsorbs).to.eq(lp0.numAbsorbs + 1);
    expect(lp1.numAbsorbed.toNumber()).to.eq(lp0.numAbsorbed.toNumber() + 1);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset)).to.eq(0);

    const baseBalance = await albert.getCometBaseBalance();
    expect(Number(baseBalance)).to.be.greaterThanOrEqual(0);

    const numAssets = await comet.numAssets();
    for (let i = 0; i < numAssets; i++) {
      const { asset } = await comet.getAssetInfo(i);
      expect(await comet.collateralBalanceOf(albert.address, asset)).to.eq(0);
    }

    expect((await comet.userBasic(albert.address)).assetsIn).to.eq(0);
  }
);


scenario(
  'Comet#liquidation > multiple liquidators absorb different positions',
  {
    tokenBalances: async (ctx) => ({
      $comet: {
        $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal * 2n
      }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.base.borrowPrincipal,
        $asset0: defactor(getConfigForScenario(ctx).liquidation.asset.supplyAmount)
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal },
      charles: { $base: getConfigForScenario(ctx).liquidation.base.borrowPrincipal }
    }),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty, charles } = actors;
    const numAssets = await comet.numAssets();

    while(!(await comet.isLiquidatable(albert.address))) {
      await comet.accrueAccount(albert.address);
      await world.increaseTime(
        await timeUntilUnderwater({
          comet,
          actor: albert,
          fudgeFactor: config.liquidationBot.scenario.fudgeFactorShort
        })
      );
    }

    const lpBetty0 = await comet.liquidatorPoints(betty.address);
    const lpCharles0 = await comet.liquidatorPoints(charles.address);
    
    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });
    
    const lpBetty1 = await comet.liquidatorPoints(betty.address);
    const lpCharles1 = await comet.liquidatorPoints(charles.address);

    expect(lpBetty1.numAbsorbs).to.eq(lpBetty0.numAbsorbs + 1);
    expect(lpCharles1.numAbsorbs).to.eq(lpCharles0.numAbsorbs);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    for (let i = 0; i < numAssets; i++) {
      const { asset } = await comet.getAssetInfo(i);
      const protocolCollateral = await comet.getCollateralReserves(asset);
      if (i === 0) {
        expect(protocolCollateral).to.be.greaterThan(0);
      }
    }
  }
);