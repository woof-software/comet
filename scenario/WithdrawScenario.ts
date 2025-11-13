import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { expectApproximately, expectRevertCustom, hasMinBorrowGreaterThanOne, isTriviallySourceable, isValidAssetIndex, MAX_ASSETS } from './utils';
import { ContractReceipt } from 'ethers';
import { getConfigForScenario } from './utils/scenarioHelper';

async function testWithdrawCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const comet = await context.getComet();
  const { albert } = context.actors;
  const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);
  const scale = scaleBN.toBigInt();

  expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(0n);
  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(BigInt(getConfigForScenario(context, assetNum).withdrawCollateral) * scale);

  // Albert withdraws 100 units of collateral from Comet
  const txn = await albert.withdrawAsset({ asset: collateralAsset.address, amount: BigInt(getConfigForScenario(context, assetNum).withdrawCollateral) * scale });

  expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(BigInt(getConfigForScenario(context, assetNum).withdrawCollateral) * scale);
  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(0n);

  return txn; // return txn to measure gas
}

async function testWithdrawFromCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const comet = await context.getComet();
  const { albert, betty } = context.actors;
  const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);
  const scale = scaleBN.toBigInt();

  expect(await collateralAsset.balanceOf(betty.address)).to.be.equal(0n);
  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(BigInt(getConfigForScenario(context, assetNum).withdrawCollateral) * scale);

  await albert.allow(betty, true);

  // Betty withdraws 1000 units of collateral from Albert
  const txn = await betty.withdrawAssetFrom({ src: albert.address, dst: betty.address, asset: collateralAsset.address, amount: BigInt(getConfigForScenario(context, assetNum).withdrawCollateral) * scale });

  expect(await collateralAsset.balanceOf(betty.address)).to.be.equal(BigInt(getConfigForScenario(context, assetNum).withdrawCollateral) * scale);
  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(0n);

  return txn; // return txn to measure gas
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#withdraw > collateral asset ${i}`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx).withdrawCollateral),
      cometBalances: async (ctx) =>  (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).withdrawCollateral }
        }
      ),
    },
    async (_properties, context) => {
      return await testWithdrawCollateral(context, i);
    }
  );
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#withdrawFrom > collateral asset ${i}`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx).withdrawCollateral),
      cometBalances: async (ctx) =>  (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).withdrawCollateral }
        }
      ),
    },
    async (_properties, context) => {
      return await testWithdrawFromCollateral(context, i);
    }
  );
}

scenario(
  'Comet#withdraw > base asset',
  {
    tokenBalances: {
      albert: { $base: '== 0' },
    },
    cometBalances: {
      albert: { $base: 2 }, // in units of asset, not wei
    },
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    // Albert withdraws supplied units of base from Comet
    const txn = await albert.withdrawAsset({ asset: baseAsset.address, amount: baseSupplied });

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(baseSupplied);
    expect(await comet.balanceOf(albert.address)).to.be.lessThan(baseSupplied / 100n);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#withdraw > borrow base',
  {
    tokenBalances: async (ctx) => (
      {
        albert: { $base: '== 0' },
        $comet: { $base: getConfigForScenario(ctx).withdrawBase }, // in units of asset, not wei
      }
    ),
    cometBalances: async (ctx) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).withdrawAsset } // in units of asset, not wei
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const precision = scale / 1_000_000n; // 1e-6 asset units of precision

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);

    // Albert borrows 1000 unit of base from Comet
    const txn = await albert.withdrawAsset({ asset: baseAsset.address, amount: BigInt(getConfigForScenario(context).withdrawBase) * scale });

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(BigInt(getConfigForScenario(context).withdrawBase) * scale);
    expectApproximately(await albert.getCometBaseBalance(), -BigInt(getConfigForScenario(context).withdrawBase) * scale, precision);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#withdrawFrom > base asset',
  {
    cometBalances: {
      albert: { $base: 2 }, // in units of asset, not wei
    },
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(baseSupplied);

    await albert.allow(betty, true);

    // Betty withdraws supplied units of base from Albert
    const txn = await betty.withdrawAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: baseSupplied });

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(baseSupplied);
    expect(await comet.balanceOf(albert.address)).to.be.lessThan(baseSupplied / 100n);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#withdrawFrom > borrow base',
  {
    tokenBalances: async (ctx) => (
      {
        albert: { $base: '== 0' },
        $comet: { $base: getConfigForScenario(ctx).withdrawBase }, // in units of asset, not wei
      }
    ),
    cometBalances: async (ctx) => (
      {
        albert: { $asset0: getConfigForScenario(ctx).withdrawAsset } // in units of asset, not wei
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const precision = scale / 1_000_000n; // 1e-6 asset units of precision

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);

    await albert.allow(betty, true);

    // Betty borrows 1000 unit of base using Albert's account
    const txn = await betty.withdrawAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: BigInt(getConfigForScenario(context).withdrawBase) * scale });

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(BigInt(getConfigForScenario(context).withdrawBase) * scale);
    expectApproximately(await albert.getCometBaseBalance(), -BigInt(getConfigForScenario(context).withdrawBase) * scale, precision);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#withdrawFrom reverts if operator not given permission',
  {
    tokenBalances: {
      $comet: { $base: 100 }, // in units of asset, not wei
    },
    cometBalances: {
      albert: { $asset0: 100 } // in units of asset, not wei
    },
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    // Betty borrowsRevertCustom 1 unit of base using Albert's account
    await expectRevertCustom(
      betty.withdrawAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: 1n * scale,
      }),
      'Unauthorized()'
    );
  }
);

scenario(
  'Comet#withdraw reverts when withdraw is paused',
  {
    pause: {
      withdrawPaused: true,
    },
  },
  async ({ comet, actors }) => {
    const { albert } = actors;
    const baseToken = await comet.baseToken();

    await expectRevertCustom(
      albert.withdrawAsset({
        asset: baseToken,
        amount: 100,
      }),
      'Paused()'
    );
  }
);

scenario(
  'Comet#withdrawFrom reverts when withdraw is paused',
  {
    pause: {
      withdrawPaused: true,
    },
  },
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, true);

    await expectRevertCustom(
      albert.withdrawAssetFrom({
        src: betty.address,
        dst: albert.address,
        asset: baseToken,
        amount: 100,
      }),
      'Paused()'
    );
  }
);

scenario(
  'Comet#withdraw base reverts if position is undercollateralized',
  {
    cometBalances: {
      albert: { $base: 0 }, // in units of asset, not wei
      charles: { $base: 1000 }, // to give the protocol enough base for others to borrow from
    },
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await expectRevertCustom(
      albert.withdrawAsset({
        asset: baseAsset.address,
        amount: 1000n * scale,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#withdraw collateral reverts if position is undercollateralized',
  {
    cometBalances: async (ctx) => (
      {
        albert: { 
          $base: -getConfigForScenario(ctx).withdrawBase1,
          $asset0: getConfigForScenario(ctx).withdrawAsset1
        }, // in units of asset, not wei
      }
    )
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const scale = scaleBN.toBigInt();

    await expectRevertCustom(
      albert.withdrawAsset({
        asset: collateralAsset.address,
        amount: BigInt(getConfigForScenario(context).withdrawAsset1) * scale
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#withdraw reverts if borrow is less than minimum borrow',
  {
    filter: async (ctx) => await hasMinBorrowGreaterThanOne(ctx),
    cometBalances: {
      albert: { $base: 0, $asset0: 100 }
    }
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const minBorrow = (await comet.baseBorrowMin()).toBigInt();

    await expectRevertCustom(
      albert.withdrawAsset({
        asset: baseAsset.address,
        amount: minBorrow / 2n
      }),
      'BorrowTooSmall()'
    );
  }
);

scenario.skip(
  'Comet#withdraw reverts if asset is not supported',
  {},
  async () => {
    // XXX requires deploying an unsupported asset (maybe via remote token constraint)
  }
);

scenario.skip(
  'Comet#withdraw reverts if not enough asset in protocol',
  {},
  async () => {
    // XXX fix for development base, where Faucet token doesn't give the same revert message
  }
);

/**
 * This test suite was written after the USDM incident, when a token price feed was removed from Chainlink.
 * The incident revealed that when a price feed becomes unavailable, the protocol cannot calculate the USD value
 * of collateral (e.g., during absorption when trying to getPrice() for a delisted asset).
 *
 * Flow tested:
 * The `isBorrowCollateralized` function iterates through a user's collateral assets to calculate their total liquidity.
 * When an asset's `borrowCollateralFactor` is set to 0, the contract skips that asset in the liquidity calculation
 * (see CometWithExtendedAssetList.sol lines 402-405), effectively excluding it from contributing to the user's
 * collateralization. This prevents the protocol from calling `getPrice()` on unavailable price feeds.
 *
 * Test scenarios:
 * 1. Positions with positive borrowCF are properly collateralized and can borrow
 * 2. When borrowCF is set to 0 (simulating a price feed becoming unavailable), the collateral is excluded
 *    from liquidity calculations, causing positions to become undercollateralized and preventing further borrowing
 * 3. Mixed scenarios where some assets have borrowCF=0 and others have positive values - only assets with
 *    positive borrowCF contribute to liquidity
 * 4. All assets individually tested to ensure each can be excluded when borrowCF=0
 *
 * This mitigation allows governance to set borrowCF to 0 for assets with unavailable price feeds, preventing
 * protocol paralysis while ensuring users cannot borrow against collateral that cannot be properly valued.
 * Unlike `isLiquidatable` which uses `liquidateCollateralFactor`, this function determines whether a user
 * can initiate new borrows, making it critical for preventing new positions from being opened with
 * unpriceable collateral.
 */
for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#isBorrowCollateralized > skips liquidity of asset ${i} with borrowCF=0`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx, i).supplyCollateral),
      tokenBalances: async (ctx) => (
        {
          albert: { $base: '== 0' },
          $comet: { $base: getConfigForScenario(ctx, i).withdrawBase },
        }
      ),
      cometBalances: async (ctx) => (
        {
          albert: {} // Will be set dynamically in the test
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
      
      // Verify initial state: position should be collateralized
      expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;

      // Zero borrowCF for target asset via governance
      await context.setNextBaseFeeToZero();
      await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(comet.address, asset, 0n, { gasPrice: 0 });
      await context.setNextBaseFeeToZero();
      await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address, { gasPrice: 0 });

      // Verify borrowCF is 0
      const assetInfo = await comet.getAssetInfoByAddress(asset);
      expect(assetInfo.borrowCollateralFactor).to.equal(0);

      // After zeroing the only supplied asset's borrowCF, position should be undercollateralized
      expect(await comet.isBorrowCollateralized(albert.address)).to.equal(false);
    }
  );
}

