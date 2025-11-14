import { CometContext, scenario } from './context/CometContext';
import { event, expect } from '../test/helpers';
import { MAX_ASSETS, expectRevertCustom, isValidAssetIndex, timeUntilUnderwater, isTriviallySourceable, usesAssetList } from './utils';
import { matchesDeployment } from './utils';
import { getConfigForScenario } from './utils/scenarioHelper';

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
  scenario.skip(
    `Comet#liquidation > skips liquidation value of asset ${i} with liquidateCF=0`,
    {
      filter: async (ctx: CometContext) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx, i).supplyCollateral) && await usesAssetList(ctx),
      tokenBalances: async (ctx: CometContext) => (
        {
          albert: { $base: '== 0' },
          $comet: { $base: getConfigForScenario(ctx, i).withdrawBase },
        }
      ),
    },
    async ({ comet, configurator, proxyAdmin, actors }, context) => {
      const { albert, admin } = actors;
      const { asset, borrowCollateralFactor, priceFeed, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const collateralScale = scaleBN.toBigInt();
      
      // Get price feeds and scales
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const collateralPrice = (await comet.getPrice(priceFeed)).toBigInt();
      const baseScale = (await comet.baseScale()).toBigInt();
      const factorScale = (await comet.factorScale()).toBigInt();
      
      // Target borrow amount (in base units, not wei)
      const targetBorrowBase = BigInt(getConfigForScenario(context, i).withdrawBase);
      const targetBorrowBaseWei = targetBorrowBase * baseScale;
      
      // Calculate required collateral amount
      // Formula from CometBalanceConstraint.ts:
      // collateralWeiPerUnitBase = (collateralScale * basePrice) / collateralPrice
      // collateralNeeded = (collateralWeiPerUnitBase * toBorrowBase) / baseScale
      // collateralNeeded = (collateralNeeded * factorScale) / borrowCollateralFactor
      // collateralNeeded = (collateralNeeded * 11n) / 10n (fudge factor)
      const collateralWeiPerUnitBase = (collateralScale * basePrice) / collateralPrice;
      let collateralNeeded = (collateralWeiPerUnitBase * targetBorrowBaseWei) / baseScale;
      collateralNeeded = (collateralNeeded * factorScale) / borrowCollateralFactor.toBigInt();
      collateralNeeded = (collateralNeeded * 11n) / 10n; // add fudge factor to ensure collateralization
      
      // Set up balances dynamically
      // 1. Source collateral tokens for albert
      await context.sourceTokens(collateralNeeded, collateralAsset, albert);
      
      // 2. Approve and supply collateral
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAsset.address, amount: collateralNeeded });
      
      // 3. Borrow base (this will make albert have negative base balance)
      const baseTokenAddress = await comet.baseToken();
      await albert.withdrawAsset({ asset: baseTokenAddress, amount: targetBorrowBaseWei });
      
      // Verify initial state: position should be collateralized and not liquidatable
      expect(await comet.isLiquidatable(albert.address)).to.be.false;

      // Zero liquidateCF for target asset via governance
      // For deployments using asset list, the factory should already be CometFactoryWithExtendedAssetList
      // If not set, deploy and set it
      let cometFactoryAddress = await configurator.factory(comet.address);
      if (cometFactoryAddress === '0x0000000000000000000000000000000000000000') {
        const CometFactoryWithExtendedAssetList = await (await context.world.deploymentManager.hre.ethers.getContractFactory('CometFactoryWithExtendedAssetList')).deploy();
        await CometFactoryWithExtendedAssetList.deployed();
        cometFactoryAddress = CometFactoryWithExtendedAssetList.address;
        await context.setNextBaseFeeToZero();
        await configurator.connect(admin.signer).setFactory(comet.address, cometFactoryAddress, { gasPrice: 0 });
      }
      
      // Set liquidateCF to 0 (CometWithExtendedAssetList allows this even if borrowCF > 0)
      await context.setNextBaseFeeToZero();
      await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(comet.address, asset, 0n, { gasPrice: 0 });
      await context.setNextBaseFeeToZero();
      await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

      // Verify liquidateCF is 0
      const assetInfo = await comet.getAssetInfoByAddress(asset);
      expect(assetInfo.liquidateCollateralFactor).to.equal(0);

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
  scenario.skip(
    `Comet#liquidation > skips absorption of asset ${i} with liquidation factor = 0`,
    {
      filter: async (ctx) => 
        await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx, i).supplyCollateral),
      tokenBalances: async (ctx) => ({
        albert: { $base: '== 0' },
        $comet: {
          $base: getConfigForScenario(ctx).withdrawBase
        }
      }),
    },
    async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
      const { albert, betty, admin } = actors;
      const { asset, borrowCollateralFactor, priceFeed, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const collateralScale = scaleBN.toBigInt();
      const baseToken = await comet.baseToken();
      const baseScale = (await comet.baseScale()).toBigInt();
      
      // Get price feeds and scales
      const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
      const collateralPrice = (await comet.getPrice(priceFeed)).toBigInt();
      const factorScale = (await comet.factorScale()).toBigInt();
      
      // Target borrow amount (in base units, not wei)
      const targetBorrowBase = BigInt(getConfigForScenario(context, i).withdrawBase);
      const targetBorrowBaseWei = targetBorrowBase * baseScale;
      
      // Calculate required collateral amount
      // Formula from CometBalanceConstraint.ts:
      // collateralWeiPerUnitBase = (collateralScale * basePrice) / collateralPrice
      // collateralNeeded = (collateralWeiPerUnitBase * toBorrowBase) / baseScale
      // collateralNeeded = (collateralNeeded * factorScale) / borrowCollateralFactor
      // collateralNeeded = (collateralNeeded * 11n) / 10n (fudge factor)
      const collateralWeiPerUnitBase = (collateralScale * basePrice) / collateralPrice;
      let collateralNeeded = (collateralWeiPerUnitBase * targetBorrowBaseWei) / baseScale;
      collateralNeeded = (collateralNeeded * factorScale) / borrowCollateralFactor.toBigInt();
      collateralNeeded = (collateralNeeded * 11n) / 10n; // add fudge factor to ensure collateralization
      
      // Set up balances dynamically
      // 1. Source collateral tokens for albert
      await context.sourceTokens(collateralNeeded, collateralAsset, albert);
      
      // 2. Approve and supply collateral
      await collateralAsset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: collateralAsset.address, amount: collateralNeeded });
      
      // 3. Borrow base (this will make albert have negative base balance)
      await albert.withdrawAsset({ asset: baseToken, amount: targetBorrowBaseWei });

      // Set up betty's base token supply for forcing accrue
      // Betty needs base tokens supplied to Comet to be able to withdraw them
      const bettyBaseAmount = BigInt(getConfigForScenario(context).withdrawBase) * baseScale;
      const baseAsset = context.getAssetByAddress(baseToken);
      await context.sourceTokens(bettyBaseAmount, baseAsset, betty);
      await baseAsset.approve(betty, comet.address);
      await betty.supplyAsset({ asset: baseToken, amount: bettyBaseAmount });

      // Ensure account is liquidatable by waiting for time to pass and accruing interest
      const timeBeforeLiquidation = await timeUntilUnderwater({
        comet,
        actor: albert,
        fudgeFactor: 6000n * 6000n // 1 hour past when position is underwater
      });

      while(!(await comet.isLiquidatable(albert.address))) {
        await comet.accrueAccount(albert.address);
        await world.increaseTime(timeBeforeLiquidation);
      }

      // Force accrue to ensure state is up to date
      await betty.withdrawAsset({ asset: baseToken, amount: BigInt(getConfigForScenario(context).withdrawBase) / 100n * baseScale });

      // Verify account is liquidatable
      expect(await comet.isLiquidatable(albert.address)).to.be.true;

      // Step 2: Update liquidationFactor to 0 for target asset
      // For deployments using asset list, the factory should already be CometFactoryWithExtendedAssetList
      // If not set, deploy and set it
      let cometFactoryAddress = await configurator.factory(comet.address);
      if (cometFactoryAddress === '0x0000000000000000000000000000000000000000') {
        const CometFactoryWithExtendedAssetList = await (await context.world.deploymentManager.hre.ethers.getContractFactory('CometFactoryWithExtendedAssetList')).deploy();
        await CometFactoryWithExtendedAssetList.deployed();
        cometFactoryAddress = CometFactoryWithExtendedAssetList.address;
        await context.setNextBaseFeeToZero();
        await configurator.connect(admin.signer).setFactory(comet.address, cometFactoryAddress, { gasPrice: 0 });
      }
      
      await context.setNextBaseFeeToZero();
      await configurator.connect(admin.signer).updateAssetLiquidationFactor(comet.address, asset, 0n, { gasPrice: 0 });

      // Upgrade proxy again after updating liquidationFactor
      await context.setNextBaseFeeToZero();
      await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

      // Verify liquidationFactor is 0
      expect((await comet.getAssetInfoByAddress(asset)).liquidationFactor).to.equal(0);

      expect(await comet.isLiquidatable(albert.address)).to.be.true;

      // Step 3: Save balances before absorb
      const userCollateralBefore = (await comet.userCollateral(albert.address, asset)).balance;
      const totalsBefore = (await comet.totalsCollateral(asset)).totalSupplyAsset;

      await betty.absorb({ absorber: betty.address, accounts: [albert.address] });

      expect((await comet.userCollateral(albert.address, asset)).balance).to.equal(userCollateralBefore);
      expect((await comet.totalsCollateral(asset)).totalSupplyAsset).to.equal(totalsBefore);
    }
  );
}

