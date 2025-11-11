import { scenario } from './context/CometContext';
import { event, exp, expect } from '../test/helpers';
import { MAX_ASSETS, expectRevertCustom, isValidAssetIndex, timeUntilUnderwater, isTriviallySourceable } from './utils';
import { matchesDeployment } from './utils';
import { getConfigForScenario } from './utils/scenarioHelper';
import { SimplePriceFeed } from 'build/types';

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

    await betty.withdrawAsset({ asset: baseToken, amount: BigInt(getConfigForScenario(context).liquidationBase) / 100n * baseScale.toBigInt() }); // force accrue

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
        fudgeFactor: 60n * 10n // 10 minutes past when position is underwater
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
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;
    const baseToken = await comet.baseToken();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();

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
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    await world.increaseTime(
      Math.round(await timeUntilUnderwater({
        comet,
        actor: albert,
      }) * 1.001) // XXX why is this off? better to use a price constraint?
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

    const collateralBalance = scale.toBigInt() / 1000n; // .001

    await world.increaseTime(
      await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: 60n * 10n // 10 minutes past when position is underwater
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

/**
 * This test suite was written after the USDM incident, when a token price feed was removed from Chainlink.
 * The incident revealed that when a price feed becomes unavailable, the protocol cannot calculate the USD value
 * of collateral (e.g., during absorption when trying to getPrice() for a delisted asset).
 *
 * Flow tested:
 * The `isLiquidatable` function iterates through a user's collateral assets to calculate their total liquidity.
 * When an asset's `liquidateCollateralFactor` is set to 0, the contract skips that asset in the liquidity calculation
 * effectively excluding it from contributing to the user's
 * collateralization. This prevents the protocol from calling `getPrice()` on unavailable price feeds.
 *
 * Test scenarios:
 * 1. Positions with positive liquidateCF are properly collateralized and not liquidatable
 * 2. When liquidateCF is set to 0 (simulating a price feed becoming unavailable), the collateral is excluded
 *    from liquidity calculations, causing positions to become liquidatable
 * 3. Mixed scenarios where some assets have liquidateCF=0 and others have positive values - only assets with
 *    positive liquidateCF contribute to liquidity
 * 4. All assets individually tested to ensure each can be excluded when liquidateCF=0
 *
 * This mitigation allows governance to set liquidateCF to 0 for assets with unavailable price feeds, preventing
 * protocol paralysis while ensuring undercollateralized positions can still be liquidated.
 */
for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#liquidation > skips liquidation value of asset ${i} with liquidateCF=0`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx, i).supplyCollateral),
      tokenBalances: async (ctx) => ( {
        albert: { [`$asset${i}`]: getConfigForScenario(ctx, i).supplyCollateral },
        $comet: { $base: exp(150, 6) },
      }),
    },
    async ({ comet, configurator, proxyAdmin, actors }, context) => {
      const { albert, admin } = actors;
      const { asset } = await comet.getAssetInfo(i);
      const targetAsset = context.getAssetByAddress(asset);
      const baseToken = await comet.baseToken();

      const supplyAmount = exp(1, 18);
      const borrowAmount = exp(150, 6);

      // Approve and supply collateral
      await targetAsset.approve(albert, comet.address);
      await albert.supplyAsset({ asset: asset, amount: supplyAmount });

      // Withdraw base (borrow) - base tokens are already in Comet from tokenBalances
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      // Initially not liquidatable with positive liquidateCF
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // Zero liquidateCF for target asset via governance
      await context.setNextBaseFeeToZero();
      await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, asset, 0n, { gasPrice: 0 });
      await context.setNextBaseFeeToZero();
      await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

      // Verify liquidateCF is 0
      expect((await comet.getAssetInfoByAddress(asset)).liquidateCollateralFactor).to.equal(0);

      // After zeroing the only supplied asset's liquidateCF, position should be liquidatable
      expect(await comet.isLiquidatable(albert.address)).to.equal(true);
    }
  );
}

/**
 * This test suite was written after the USDM incident, when a token price feed was removed from Chainlink.
 * As a result, during absorption, the protocol would not be able to calculate the USD value of the collateral seized.
 *
 * This test suite verifies that the protocol behaves correctly in two scenarios:
 * 1. Normal absorption (liquidation factor > 0): When collateral has a non-zero liquidation factor,
 *    the protocol can successfully liquidate/seize the collateral during absorption, calculate its USD value,
 *    and update all state correctly.
 * 2. Delisted collateral (liquidation factor = 0): When collateral is delisted (liquidation factor set to 0),
 *    the protocol skips seizing that collateral during absorption, but still proceeds with debt absorption.
 *    This allows the protocol to continue functioning even when a price feed becomes unavailable, by
 *    setting the asset's liquidation factor to 0 to prevent attempts to calculate its USD value.
 */
for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#liquidation > skips absorption of asset ${i} with liquidation factor = 0`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx, i).supplyCollateral),
      tokenBalances: async (ctx) => ( {
        albert: { [`$asset${i}`]: getConfigForScenario(ctx, i).supplyCollateral },
        $comet: { $base: exp(150, 6) },
      }),
    },
    async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
      /**
       * This parameterized test verifies that absorb skips assets with liquidation factor = 0.
       * For each iteration (i = 0 to 23), it tests asset i in a protocol.
       * The test: (1) supplies collateral and borrows to make the account liquidatable,
       * (2) sets the target asset's liquidation factor to 0, (3) calls absorb, and
       * (4) verifies that the target asset is skipped (user collateral balance and totalsCollateral totalSupplyAsset remain unchanged).
       */
      const { albert, betty, admin } = actors;
      const { asset, priceFeed } = await comet.getAssetInfo(i);
      const targetAsset = context.getAssetByAddress(asset);
      const baseToken = await comet.baseToken();

      const supplyAmount = exp(1, 18);
      const borrowAmount = exp(150, 6);

      // Step 1: Supply, borrow, and make liquidatable
      await targetAsset.approve(albert, comet.address);
      await albert.supplyAsset({ asset: asset, amount: supplyAmount });

      // Withdraw base (borrow) - base tokens are already in Comet from tokenBalances
      await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

      // Drop price of token to make liquidatable
      // Get the price feed contract and set a lower price
      const priceFeedContract = await world.deploymentManager.hre.ethers.getContractAt('SimplePriceFeed', priceFeed) as SimplePriceFeed;
      const newPrice = exp(100, 8); // 100 USD with 8 decimals
      const signer = await world.deploymentManager.getSigner();
      await priceFeedContract.connect(signer).setRoundData(0, newPrice, 0, 0, 0);

      // Verify account is liquidatable
      expect(await comet.isLiquidatable(albert.address)).to.be.true;

      // Step 2: Update liquidationFactor to 0 for target asset
      await context.setNextBaseFeeToZero();
      await configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, asset, exp(0, 18));

      // Upgrade proxy again after updating liquidationFactor
      await context.setNextBaseFeeToZero();
      await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

      // Verify liquidationFactor is 0
      expect((await comet.getAssetInfoByAddress(asset)).liquidationFactor).to.equal(0);

      // Step 3: Save balances before absorb
      const userCollateralBefore = (await comet.userCollateral(albert.address, asset)).balance;
      const totalsBefore = (await comet.totalsCollateral(asset)).totalSupplyAsset;

      expect(userCollateralBefore).to.equal(supplyAmount);
      expect(totalsBefore).to.equal(supplyAmount);

      // Step 4: Absorb should skip this asset (no seizure) and balances remain unchanged
      await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

      // Step 5: Verify balances remain unchanged
      expect((await comet.userCollateral(albert.address, asset)).balance).to.equal(userCollateralBefore);
      expect((await comet.totalsCollateral(asset)).totalSupplyAsset).to.equal(totalsBefore);
    }
  );
}

