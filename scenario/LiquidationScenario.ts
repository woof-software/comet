import { scenario } from './context/CometContext';
import { event, expect } from '../test/helpers';
import { expectRevertCustom, timeUntilUnderwater } from './utils';
import { matchesDeployment } from './utils';
import { getConfigForScenario } from './utils/scenarioHelper';

const LIQUIDATION_FUDGE_FACTOR_LONG = 6000n * 6000n;
const LIQUIDATION_FUDGE_FACTOR_SHORT = 60n * 10n;
const BORROW_CAPACITY_UTILIZATION_HIGH = 90n;
const HUNDRED_PERCENT = 100n;
const ONE_PERCENT_DIVISOR = 100n;
const COLLATERAL_DIVISOR = 1000n;
const TIME_ADJUSTMENT_MULTIPLIER = 1.001;

scenario(
  'Comet#liquidation > isLiquidatable=true for underwater position',
  {
    tokenBalances: async (ctx) => (
      {
        $comet: {
          $base: getConfigForScenario(ctx).liquidationBase
        }
      }),
    cometBalances: async (ctx) => ({
      albert: { $base: -getConfigForScenario(ctx).liquidationBase },
      betty: { $base: getConfigForScenario(ctx).liquidationBase }
    }),
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;
    const baseToken = await comet.baseToken();
    const baseScale = await comet.baseScale();

    const timeBeforeLiquidation = await timeUntilUnderwater({
      comet,
      actor: albert,
      fudgeFactor: LIQUIDATION_FUDGE_FACTOR_LONG
    });

    while(!(await comet.isLiquidatable(albert.address))) {
      await comet.accrueAccount(albert.address);
      await world.increaseTime(timeBeforeLiquidation);
    }

    await betty.withdrawAsset({ asset: baseToken, amount: BigInt(getConfigForScenario(context).liquidationBase) / ONE_PERCENT_DIVISOR * baseScale.toBigInt() }); // force accrue

    expect(await comet.isLiquidatable(albert.address)).to.be.true;
  }
);

scenario(
  'Comet#liquidation > allows liquidation of underwater positions with token fees',
  {
    tokenBalances: {
      $comet: { $base: 1000 },
    },
    cometBalances: {
      albert: {
        $base: -1000,
        $asset0: .001
      },
      betty: { $base: 10 }
    },
    filter: async (ctx) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }]),
  },
  async ({ comet, actors }, _, world) => {
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
        fudgeFactor: LIQUIDATION_FUDGE_FACTOR_SHORT
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
          $base: getConfigForScenario(ctx).liquidationBase
        }
      }),
    cometBalances: async (ctx) => ({
      albert: { $base: -getConfigForScenario(ctx).liquidationBase },
      betty: { $base: getConfigForScenario(ctx).liquidationBase }
    }),
    pause: {
      absorbPaused: true,
    },
  },
  async ({ comet, actors }, _, world) => {
    const { albert, betty } = actors;
    const baseToken = await comet.baseToken();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: LIQUIDATION_FUDGE_FACTOR_SHORT
      })
    );

    await betty.withdrawAsset({ asset: baseToken, amount: baseBorrowMin }); // force accrue

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
          $base: getConfigForScenario(ctx).liquidationBase
        }
      }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidationBase,
        $asset0: getConfigForScenario(ctx).liquidationAsset
      },
      betty: { $base: getConfigForScenario(ctx).liquidationBase }
    }),
  },
  async ({ comet, actors }, _, world) => {
    const { albert, betty } = actors;

    
    const timeBeforeLiquidation = await timeUntilUnderwater({
      comet,
      actor: albert,
      fudgeFactor: LIQUIDATION_FUDGE_FACTOR_LONG
    });

    while(!(await comet.isLiquidatable(albert.address))) {
      await comet.accrueAccount(albert.address);
      await world.increaseTime(timeBeforeLiquidation);
    }

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
    filter: async (ctx) => !matchesDeployment(ctx, [{ network: 'base', deployment: 'usds' }]),
    tokenBalances: async (ctx) => (
      {
        $comet: {
          $base: getConfigForScenario(ctx).liquidationBase
        }
      }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidationBase,
        $asset0: getConfigForScenario(ctx).liquidationAsset
      }
    }),
  },
  async ({ comet, actors }, _, world) => {
    const { albert, betty } = actors;

    await world.increaseTime(
      Math.round(await timeUntilUnderwater({
        comet,
        actor: albert,
      }) * TIME_ADJUSTMENT_MULTIPLIER) // XXX why is this off? better to use a price constraint?
    );

    const ab0 = await betty.absorb({ absorber: betty.address, accounts: [albert.address] });
    expect(ab0.events?.[2]?.event).to.be.equal('Transfer');

    const baseBalance = await albert.getCometBaseBalance();
    expect(Number(baseBalance)).to.be.greaterThan(0);
  }
);

// XXX Skipping temporarily because testnet is in a weird state where an EOA ('admin') still
// has permission to withdraw Comet's collateral, while Timelock does not. This is because the
// permission was set up in the initialize() function. There is currently no way to update this
// permission in Comet, so a new function (e.g. `approveCometPermission`) needs to be created
// to allow governance to modify which addresses can withdraw assets from Comet's Comet balance.
scenario(
  'Comet#liquidation > governor can withdraw collateral after successful liquidation',
  {
    cometBalances: {
      albert: {
        $base: -10,
        $asset0: .001
      },
    },
  },
  async ({ comet, actors }, _, world) => {
    const { albert, betty, charles } = actors;
    const { asset: asset0Address, scale } = await comet.getAssetInfo(0);

    const collateralBalance = scale.toBigInt() / COLLATERAL_DIVISOR;

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: LIQUIDATION_FUDGE_FACTOR_SHORT
      })
    );

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const txReceipt = await charles.withdrawAssetFrom({
      src: comet.address,
      dst: charles.address,
      asset: asset0Address,
      amount: collateralBalance
    });

    expect(event({ receipt: txReceipt }, 0)).to.deep.equal({
      Transfer: {
        from: comet.address,
        to: charles.address,
        amount: collateralBalance
      }
    });

    expect(event({ receipt: txReceipt }, 1)).to.deep.equal({
      WithdrawCollateral: {
        src: comet.address,
        to: charles.address,
        asset: asset0Address,
        amount: collateralBalance
      }
    });
  }
);

scenario(
  'Comet#liquidation > liquidates position with all collateral types',
  {
    tokenBalances: async (ctx) => ({
      $comet: {
        $base: getConfigForScenario(ctx).liquidationBase
      }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidationBase,
        $asset0: getConfigForScenario(ctx).liquidationAsset,
        $asset1: .5,
        $asset2: 100
      },
      betty: { $base: getConfigForScenario(ctx).liquidationBase }
    }),
  },
  async ({ comet, actors }, _, world) => {
    const { albert, betty } = actors;
    const numAssets = await comet.numAssets();

    const timeBeforeLiquidation = await timeUntilUnderwater({
      comet,
      actor: albert,
      fudgeFactor: LIQUIDATION_FUDGE_FACTOR_LONG
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
        $base: getConfigForScenario(ctx).liquidationBase
      }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $asset0: getConfigForScenario(ctx).liquidationAsset
      },
      betty: { $base: getConfigForScenario(ctx).liquidationBase }
    }),
  },
  async ({ comet, actors }, _, world) => {
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
    const borrowAmount = borrowCapacity.mul(BORROW_CAPACITY_UTILIZATION_HIGH).div(HUNDRED_PERCENT);

    await albert.withdrawAsset({
      asset: baseToken,
      amount: borrowAmount
    });

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: LIQUIDATION_FUDGE_FACTOR_SHORT
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
    tokenBalances: {
      $comet: { $base: 10000 },
    },
    cometBalances: {
      albert: {
        $base: -10000,
        $asset0: .001
      },
      betty: { $base: 10 }
    },
  },
  async ({ comet, actors }, _, world) => {
    const { albert, betty } = actors;

    const timeBeforeLiquidation = await timeUntilUnderwater({
      comet,
      actor: albert,
      fudgeFactor: LIQUIDATION_FUDGE_FACTOR_LONG
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
  'Comet#liquidation > large position liquidation',
  {
    tokenBalances: async (ctx) => ({
      $comet: {
        $base: getConfigForScenario(ctx).liquidationBase * 10
      }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidationBase * 5,
        $asset0: 5000,
        $asset1: 100
      },
      betty: { $base: getConfigForScenario(ctx).liquidationBase * 5 }
    }),
  },
  async ({ comet, actors }, _, world) => {
    const { albert, betty } = actors;

    const timeBeforeLiquidation = await timeUntilUnderwater({
      comet,
      actor: albert,
      fudgeFactor: LIQUIDATION_FUDGE_FACTOR_LONG
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
        $base: getConfigForScenario(ctx).liquidationBase * 2
      }
    }),
    cometBalances: async (ctx) => ({
      albert: {
        $base: -getConfigForScenario(ctx).liquidationBase,
        $asset0: getConfigForScenario(ctx).liquidationAsset
      },
      betty: { $base: getConfigForScenario(ctx).liquidationBase },
      charles: { $base: getConfigForScenario(ctx).liquidationBase }
    }),
  },
  async ({ comet, actors }, _, world) => {
    const { albert, betty, charles } = actors;
    const numAssets = await comet.numAssets();

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: LIQUIDATION_FUDGE_FACTOR_SHORT
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