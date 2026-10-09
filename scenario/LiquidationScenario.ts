import { scenario } from './context/CometContext.js';
import { event, expect } from '../test/helpers.js';
import { expectRevertCustom, timeUntilUnderwater } from './utils/index.js';
import { matchesDeployment } from './utils/index.js';
import { getConfigForScenario } from './utils/scenarioHelper.js';
import { parseEther, toQuantity } from 'ethers';
import { getHardhatEthers } from '../plugins/deployment_manager/hardhat3/runtime.js';

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
      fudgeFactor: 6000n * 6000n // 1 hour past when position is underwater
    });

    while(!(await comet.isLiquidatable(albert.address))) {
      await comet.accrueAccount(albert.address);
      await world.increaseTime(timeBeforeLiquidation);
    }

    await betty.withdrawAsset({ asset: baseToken, amount: BigInt(getConfigForScenario(context).liquidationBase) / 100n * baseScale }); // force accrue

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
  async ({ comet, actors }, context, world) => {
    // Set fees for USDT for testing
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.getFunction('owner')();
    const ethers = await getHardhatEthers(world.deploymentManager.hre);
    await ethers.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      toQuantity(parseEther('100')),
    ]);
    await ethers.provider.send('hardhat_impersonateAccount', [USDTAdminAddress]);
    // mine a block to ensure the impersonation is effective
    const USDTAdminSigner = await ethers.getSigner(USDTAdminAddress);
    // 10 basis points, and max 10 USDT
    await USDT.connect(USDTAdminSigner).getFunction('setParams')(10, 10);

    const { albert, betty } = actors;

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: 60n * 10n // 10 minutes past when position is underwater
      })
    );

    const lp0 = await comet.liquidatorPoints(betty.address);

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const lp1 = await comet.liquidatorPoints(betty.address);

    // increments absorber's numAbsorbs
    expect(lp1.numAbsorbs).to.eq(lp0.numAbsorbs + 1n);
    // increases absorber's numAbsorbed
    expect(lp1.numAbsorbed).to.eq(lp0.numAbsorbed + 1n);
    // XXX test approxSpend?

    const baseBalance = await albert.getCometBaseBalance();
    expect(baseBalance >= 0n).to.be.true;

    // clears out all of liquidated user's collateral
    const numAssets = await comet.numAssets();
    for (let i = 0; i < numAssets; i++) {
      const { asset } = await comet.getAssetInfo(i);
      expect(await comet.collateralBalanceOf(albert.address, asset)).to.eq(0n);
    }

    // clears assetsIn
    expect((await comet.userBasic(albert.address)).assetsIn).to.eq(0n);
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
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;
    const baseToken = await comet.baseToken();
    const baseBorrowMin = await comet.baseBorrowMin();

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: 60n * 10n // 10 minutes past when position is underwater
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
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    
    const timeBeforeLiquidation = await timeUntilUnderwater({
      comet,
      actor: albert,
      fudgeFactor: 6000n * 6000n // 1 hour past when position is underwater
    });

    while(!(await comet.isLiquidatable(albert.address))) {
      await comet.accrueAccount(albert.address);
      await world.increaseTime(timeBeforeLiquidation);
    }

    const lp0 = await comet.liquidatorPoints(betty.address);

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const lp1 = await comet.liquidatorPoints(betty.address);

    // increments absorber's numAbsorbs
    expect(lp1.numAbsorbs).to.eq(lp0.numAbsorbs + 1n);
    // increases absorber's numAbsorbed
    expect(lp1.numAbsorbed).to.eq(lp0.numAbsorbed + 1n);
    // XXX test approxSpend?

    const baseBalance = await albert.getCometBaseBalance();
    expect(baseBalance >= 0n).to.be.true;

    // clears out all of liquidated user's collateral
    const numAssets = await comet.numAssets();
    for (let i = 0; i < numAssets; i++) {
      const { asset } = await comet.getAssetInfo(i);
      expect(await comet.collateralBalanceOf(albert.address, asset)).to.eq(0n);
    }

    // clears assetsIn
    expect((await comet.userBasic(albert.address)).assetsIn).to.eq(0n);
  }
);

scenario(
  'Comet#liquidation > user can end up with a minted supply',
  {
    filter: async (ctx) => !matchesDeployment(ctx, [
      { network: 'base', deployment: 'usds' },
      { network: 'ronin' },
      { network: 'scroll' },
    ]),
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
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    await world.increaseTime(
      Math.round(await timeUntilUnderwater({
        comet,
        actor: albert,
      }) * 1.001) // XXX why is this off? better to use a price constraint?
    );

    const ab0 = await betty.absorb({ absorber: betty.address, accounts: [albert.address] });
    expect(event({ receipt: ab0 }, 2)).to.have.property('Transfer');

    const baseBalance = await albert.getCometBaseBalance();
    expect(baseBalance > 0n).to.be.true;
  }
);

// XXX Skipping temporarily because testnet is in a weird state where an EOA ('admin') still
// has permission to withdraw Comet's collateral, while Timelock does not. This is because the
// permission was set up in the initialize() function. There is currently no way to update this
// permission in Comet, so a new function (e.g. `approveCometPermission`) needs to be created
// to allow governance to modify which addresses can withdraw assets from Comet's Comet balance.
scenario.skip(
  'Comet#liquidation > governor can withdraw collateral after successful liquidation',
  {
    cometBalances: {
      albert: {
        $base: -10,
        $asset0: .001
      },
    },
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty, charles } = actors;
    const { asset: asset0Address, scale } = await comet.getAssetInfo(0);

    const collateralBalance = scale / 1000n; // .001
    const cometAddress = await comet.getAddress();

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: 60n * 10n // 10 minutes past when position is underwater
      })
    );

    await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

    const txReceipt = await charles.withdrawAssetFrom({
      src: cometAddress,
      dst: charles.address,
      asset: asset0Address,
      amount: collateralBalance
    });

    expect(event({ receipt: txReceipt }, 0)).to.deep.equal({
      Transfer: {
        from: cometAddress,
        to: charles.address,
        amount: collateralBalance
      }
    });

    expect(event({ receipt: txReceipt }, 1)).to.deep.equal({
      WithdrawCollateral: {
        src: cometAddress,
        to: charles.address,
        asset: asset0Address,
        amount: collateralBalance
      }
    });
  }
);
