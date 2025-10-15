import { scenario } from './context/CometContext';
import { ethers, expect } from '../test/helpers';
import { expectRevertCustom, timeUntilUnderwater } from './utils';
import { matchesDeployment } from './utils';
import { getConfigForScenario } from './utils/scenarioHelper';

scenario(
  'Comet#liquidation > isLiquidatable=true for underwater position',
  {
    tokenBalances: async (ctx) => (
      {
        $comet: {
          $base: getConfigForScenario(ctx).liquidation.standardBase
        }
      }),
    cometBalances: async (ctx) => ({
      albert: { $base: -getConfigForScenario(ctx).liquidation.standardBase },
      betty: { $base: getConfigForScenario(ctx).liquidation.standardBase }
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
      fudgeFactor: config.liquidationScenario.fudgeFactorLong
    });

    while(!(await comet.isLiquidatable(albert.address))) {
      await comet.accrueAccount(albert.address);
      await world.increaseTime(timeBeforeLiquidation);
    }

    await betty.withdrawAsset({ asset: baseToken, amount: BigInt(config.liquidation.standardBase) / 100n * baseScale.toBigInt() }); // force accrue

    expect(await comet.isLiquidatable(albert.address)).to.be.true;
  }
);

scenario(
  'Comet#liquidation > allows liquidation of underwater positions with token fees',
  {
    tokenBalances: async (ctx) => ({
      $comet: { $base: getConfigForScenario(ctx).liquidation.mediumBase }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.mediumBase,
        $asset0: getConfigForScenario(ctx).liquidation.tinyAsset
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.smallAsset }
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
        fudgeFactor: config.liquidationScenario.fudgeFactorShort
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
          $base: getConfigForScenario(ctx).liquidation.standardBase
        }
      }),
    cometBalances: async (ctx) => ({
      albert: { $base: -getConfigForScenario(ctx).liquidation.standardBase },
      betty: { $base: getConfigForScenario(ctx).liquidation.standardBase }
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
        fudgeFactor: config.liquidationScenario.fudgeFactorShort
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
          $base: getConfigForScenario(ctx).liquidation.standardBase
        }
      }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.standardBase,
        $asset0: getConfigForScenario(ctx).liquidation.standardAsset
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.standardBase }
    }),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    const timeBeforeLiquidation = await timeUntilUnderwater({
      comet,
      actor: albert,
      fudgeFactor: config.liquidationScenario.fudgeFactorLong
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
          $base: getConfigForScenario(ctx).liquidation.standardBase
        }
      }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.standardBase,
        $asset0: getConfigForScenario(ctx).liquidation.standardAsset
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
      }) * config.liquidationScenario.timeAdjustmentMultiplier)
    );

    const ab0 = await betty.absorb({ absorber: betty.address, accounts: [albert.address] });
    expect(ab0.events?.[2]?.event).to.be.equal('Transfer');

    const baseBalance = await albert.getCometBaseBalance();
    expect(Number(baseBalance)).to.be.greaterThan(0);
  }
);

scenario(
  'Comet#liquidation > governor can withdraw collateral after successful liquidation',
  {
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.standardBase,
        $asset0: getConfigForScenario(ctx).liquidation.tinyAsset
      },
    }),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { admin, albert, betty } = actors;
    const { asset: asset0Address, scale } = await comet.getAssetInfo(0);

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: config.liquidationScenario.fudgeFactorShort
      })
    );

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const reserves = await comet.getCollateralReserves(asset0Address);
    console.log('Collateral reserves available:', reserves.toString());

    const approveThisCalldata = ethers.utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint256'],
      [admin.address, asset0Address, ethers.constants.MaxUint256]
    );
    
    await context.fastGovernanceExecute(
      [comet.address],
      [0],
      ['approveThis(address,address,uint256)'],
      [approveThisCalldata]
    );

    const asset0Contract = await world.deploymentManager.existing(
      'asset0',
      asset0Address,
      world.base.network
    );
    
    const withdrawAmount = reserves.gt(scale.div(config.liquidationScenario.collateralDivisor)) 
      ? scale.toBigInt() / config.liquidationScenario.collateralDivisor 
      : reserves;

    await asset0Contract
      .connect(admin.signer)
      .transferFrom(comet.address, admin.address, withdrawAmount);

    const finalReserves = await comet.getCollateralReserves(asset0Address);
    expect(finalReserves).to.equal(reserves.sub(withdrawAmount));
  }
);

scenario(
  'Comet#liquidation > liquidates position with all collateral types',
  {
    tokenBalances: async (ctx) => ({
      $comet: {
        $base: getConfigForScenario(ctx).liquidation.standardBase
      }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.standardBase,
        $asset0: getConfigForScenario(ctx).liquidation.standardAsset,
        $asset1: getConfigForScenario(ctx).liquidation.smallAsset,
        $asset2: getConfigForScenario(ctx).liquidation.tinyAsset
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.standardBase }
    }),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const numAssets = await comet.numAssets();

    const timeBeforeLiquidation = await timeUntilUnderwater({
      comet,
      actor: albert,
      fudgeFactor: config.liquidationScenario.fudgeFactorLong
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
        $base: getConfigForScenario(ctx).liquidation.standardBase
      }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $asset0: getConfigForScenario(ctx).liquidation.standardAsset
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.standardBase }
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
    const borrowAmount = borrowCapacity.mul(config.liquidationScenario.borrowCapacityUtilizationHigh).div(100n);

    await albert.withdrawAsset({
      asset: baseToken,
      amount: borrowAmount
    });

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: config.liquidationScenario.fudgeFactorShort
      })
    );

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
      $comet: { $base: getConfigForScenario(ctx).liquidation.standardBase * 10 }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.standardBase * 10,
        $asset0: getConfigForScenario(ctx).liquidation.tinyAsset
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.tinyBase }
    }),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    const timeBeforeLiquidation = await timeUntilUnderwater({
      comet,
      actor: albert,
      fudgeFactor: config.liquidationScenario.fudgeFactorLong
    });
    
    while(!(await comet.isLiquidatable(albert.address))) {
      await comet.accrueAccount(albert.address);
      await world.increaseTime(timeBeforeLiquidation);
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
  `LiquidationBot > absorbs, but does not attempt to purchase collateral when maxAmountToPurchase=0`,
  {
    filter: async (ctx) => matchesDeployment(ctx, [{ network: 'mainnet' }, { network: 'polygon' }, { network: 'arbitrum' }]),
    tokenBalances: async (ctx) => (
      {
        $comet: { $base: getConfigForScenario(ctx).liquidation.standardBase },
      }
    ),
    cometBalances: async (ctx) => (
      {
        albert: {
          $asset0: `== ${getConfigForScenario(ctx).liquidation.standardAsset}`,
        },
        betty: { $base: getConfigForScenario(ctx).liquidation.mediumBase },
      }
    )
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    const timeBeforeLiquidation = await timeUntilUnderwater({
      comet,
      actor: albert,
      fudgeFactor: config.liquidationScenario.fudgeFactorLong
    });

    while(!(await comet.isLiquidatable(albert.address))) {
      await comet.accrueAccount(albert.address);
      await world.increaseTime(timeBeforeLiquidation);
    }

    const lp0 = await comet.liquidatorPoints(betty.address);
    const numAssets = await comet.numAssets();

    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const lp1 = await comet.liquidatorPoints(betty.address);

    expect(lp1.numAbsorbs).to.eq(lp0.numAbsorbs + 1);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    for (let i = 0; i < numAssets; i++) {
      const { asset } = await comet.getAssetInfo(i);
      expect(await comet.collateralBalanceOf(albert.address, asset)).to.eq(0);
    }
  }
);

scenario(
  'Comet#liquidation > multiple liquidators absorb different positions',
  {
    tokenBalances: async (ctx) => ({
      $comet: {
        $base: getConfigForScenario(ctx).liquidation.standardBase * 2
      }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidation.standardBase,
        $asset0: getConfigForScenario(ctx).liquidation.standardAsset
      },
      betty: { $base: getConfigForScenario(ctx).liquidation.standardBase },
      charles: { $base: getConfigForScenario(ctx).liquidation.standardBase }
    }),
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const { albert, betty, charles } = actors;
    const numAssets = await comet.numAssets();

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: config.liquidationScenario.fudgeFactorShort
      })
    );

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