import { expect } from 'chai';
import { mulPrice } from '../../test/helpers';
import { scenario } from '../context/CometContext';
import {
  captureAbsorbStateBefore,
  fundAccount,
  getAssetInfo,
  getUsableCollateralIndices,
  hasModule,
  makeCollateralStates,
} from '../utils';

/**
 * Reverting collateral-oracle scenarios for the liquidation module.
 *
 * These cases establish a healthy position while the oracle works, then replace the selected
 * collateral feed and upgrade Comet with a fresh liquidation module before exercising each branch.
 */

/**
 * With all default collateral factors still positive, every health and liquidation path must read
 * the collateral oracle. A reverting oracle therefore blocks borrow health, liquidatability and
 * absorb without changing any user or protocol state.
 */
scenario(
  'Comet#absorb > reverting collateral oracle with default factors reverts',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);

    const assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPrice = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    // Collateral value = 10 * baseBorrowMin; debt value = 2 * baseBorrowMin.
    const suppliedCollateralValue = 10n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPrice;
    const borrowAmount = 2n * baseBorrowMin;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance replaces the collateral feed, binds a fresh liquidation module to the new asset
    // list and upgrades Comet through the normal Configurator/proxy-admin path.
    const priceFeedWithRevert = await world.deploymentManager.deploy(
      'priceOracleReverts:defaultFactors:priceFeed',
      'test/PriceFeedWithRevert.sol',
      [],
      true
    );
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetPriceFeed(
      comet.address,
      assetInfo.asset,
      priceFeedWithRevert.address
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    await expect(comet.getPrice(priceFeedWithRevert.address))
      .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    
    await expect(comet.isLiquidatable(albert.address))
      .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    await expect(comet.connect(betty.signer).absorb(betty.address, [albert.address]))
      .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
  }
);

/**
 * Setting only BCF to zero skips the reverting collateral oracle during borrow health checks.
 * Liquidation still needs the oracle while LCF remains positive, so liquidatability and absorb
 * remain blocked.
 */
scenario(
  'Comet#absorb > reverting collateral oracle with BCF zero still reverts',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);

    const assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPrice = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    const suppliedCollateralValue = 10n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPrice;
    const borrowAmount = 2n * baseBorrowMin;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    const priceFeedWithRevert = await world.deploymentManager.deploy(
      'priceOracleReverts:bcfZero:priceFeed',
      'test/PriceFeedWithRevert.sol',
      [],
      true
    );
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetPriceFeed(
      comet.address,
      assetInfo.asset,
      priceFeedWithRevert.address
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    await expect(comet.getPrice(priceFeedWithRevert.address))
      .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    await expect(comet.isBorrowCollateralized(albert.address))
      .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    
    await expect(comet.isLiquidatable(albert.address))
      .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    
    await expect(comet.connect(betty.signer).absorb(betty.address, [albert.address]))
      .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    await expect(comet.getPrice(priceFeedWithRevert.address))
      .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;
    
    await expect(comet.isLiquidatable(albert.address))
      .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    
    await expect(comet.connect(betty.signer).absorb(betty.address, [albert.address]))
      .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
  }
);

/**
 * With BCF and LCF both zero, health checks skip the reverting oracle while positive LF keeps the
 * collateral seizable. Absorb takes the full balance at value zero and writes the uncovered debt
 * off through base reserves.
 */
scenario(
  'Comet#absorb > reverting collateral oracle with BCF and LCF zero succeeds',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    const assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPrice = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    const suppliedCollateralValue = 10n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPrice;
    const borrowAmount = 2n * baseBorrowMin;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    const priceFeedWithRevert = await world.deploymentManager.deploy(
      'priceOracleReverts:bcfAndLcfZero:priceFeed',
      'test/PriceFeedWithRevert.sol',
      [],
      true
    );
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetPriceFeed(
      comet.address,
      assetInfo.asset,
      priceFeedWithRevert.address
    );
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    await expect(comet.getPrice(priceFeedWithRevert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;

    await expect(comet.isLiquidatable(albert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    await expect(comet.connect(betty.signer).absorb(betty.address, [albert.address])).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    await expect(comet.getPrice(priceFeedWithRevert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;

    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    await expect(comet.getPrice(priceFeedWithRevert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;

    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);

    expect(collateralStateAfter.collateralBalance).to.equal(0n);
    expect(cometStateAfter.user.assetsIn).to.equal(0);
    expect(cometStateAfter.user._reserved).to.equal(0);

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    expect(collateralStateAfter.totalsCollateral).to.equal(
      collateralStateBefore.totalsCollateral - collateralStateBefore.collateralBalance
    );
    expect(collateralStateAfter.collateralReserves).to.equal(
      collateralStateBefore.collateralReserves + collateralStateBefore.collateralBalance
    );
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * With every collateral factor zero, health checks skip the reverting oracle and the seizure loop
 * skips the asset. Absorb writes off the uncovered debt while leaving the collateral and membership
 * state untouched.
 */
scenario(
  'Comet#absorb > reverting collateral oracle with all factors zero skips collateral seizure',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    const assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPrice = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    const suppliedCollateralValue = 10n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPrice;
    const borrowAmount = 2n * baseBorrowMin;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    const priceFeedWithRevert = await world.deploymentManager.deploy(
      'priceOracleReverts:allFactorsZero:priceFeed',
      'test/PriceFeedWithRevert.sol',
      [],
      true
    );
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetPriceFeed(
      comet.address,
      assetInfo.asset,
      priceFeedWithRevert.address
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    await expect(comet.getPrice(priceFeedWithRevert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    await expect(comet.isBorrowCollateralized(albert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    await expect(comet.isLiquidatable(albert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    await expect(comet.connect(betty.signer).absorb(betty.address, [albert.address])).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await configurator.connect(admin.signer).updateAssetLiquidationFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    await expect(comet.getPrice(priceFeedWithRevert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.false;

    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    await expect(comet.getPrice(priceFeedWithRevert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);

    expect(collateralStateAfter.collateralBalance).to.equal(collateralStateBefore.collateralBalance);
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * Deactivation-only path. The borrow path checks deactivation before the oracle, but the
 * liquidation path is deactivation-agnostic and still reads the oracle while LCF > 0.
 * Deactivating collateral therefore does not unblock absorption: borrow-health failure changes
 * from an oracle revert to TokenIsDeactivated, while liquidatability and absorb still fail on
 * the reverting oracle.
 */
scenario(
  'Comet#absorb > reverting collateral oracle with deactivated asset still reverts',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, cometExt, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, pauseGuardian, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);

    const assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPrice = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    // Collateral value = 10 * baseBorrowMin; debt value = 2 * baseBorrowMin.
    const suppliedCollateralValue = 10n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPrice;
    const borrowAmount = 2n * baseBorrowMin;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance wires a reverting collateral feed with default positive BCF/LCF/LF, then binds a
    // fresh liquidation module and upgrades Comet.
    const priceFeedWithRevert = await world.deploymentManager.deploy(
      'priceOracleReverts:deactivated:priceFeed',
      'test/PriceFeedWithRevert.sol',
      [],
      true
    );
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetPriceFeed(
      comet.address,
      assetInfo.asset,
      priceFeedWithRevert.address
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    await expect(comet.getPrice(priceFeedWithRevert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    // With default positive factors, every path still reads the oracle.
    await expect(comet.isBorrowCollateralized(albert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    await expect(comet.isLiquidatable(albert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    await expect(comet.connect(betty.signer).absorb(betty.address, [albert.address])).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    // Pause guardian deactivates the collateral after the oracle-revert baseline is confirmed.
    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    // still reverts on the oracle
    await expect(comet.getPrice(priceFeedWithRevert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    // Borrow health fails on deactivation before the oracle is read.
    await expect(comet.isBorrowCollateralized(albert.address)).to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(assetInfo.asset);

    // Liquidation remains deactivation-agnostic and still needs the oracle while LCF > 0.
    await expect(comet.isLiquidatable(albert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    await expect(comet.connect(betty.signer).absorb(betty.address, [albert.address])).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
  }
);

/**
 * Deactivation plus BCF-zero. Deactivation is still checked before the BCF = 0 oracle skip in the
 * borrow path, and LCF > 0 still leaves liquidation on the reverting oracle. BCF = 0 therefore does
 * not help once the asset is deactivated, and it still does not unblock absorb while LCF remains
 * positive.
 */
scenario(
  'Comet#absorb > reverting collateral oracle with deactivated asset and BCF zero still reverts',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, cometExt, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, pauseGuardian, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);

    const assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPrice = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    // Collateral value = 10 * baseBorrowMin; debt value = 2 * baseBorrowMin.
    const suppliedCollateralValue = 10n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPrice;
    const borrowAmount = 2n * baseBorrowMin;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance wires a reverting collateral feed with default positive factors, then binds a
    // fresh liquidation module and upgrades Comet.
    const priceFeedWithRevert = await world.deploymentManager.deploy(
      'priceOracleReverts:deactivatedBcfZero:priceFeed',
      'test/PriceFeedWithRevert.sol',
      [],
      true
    );
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetPriceFeed(
      comet.address,
      assetInfo.asset,
      priceFeedWithRevert.address
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    // Deactivate before the factor change.
    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    await expect(comet.getPrice(priceFeedWithRevert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    await expect(comet.isBorrowCollateralized(albert.address)).to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(assetInfo.asset);
    await expect(comet.isLiquidatable(albert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    await expect(comet.connect(betty.signer).absorb(betty.address, [albert.address])).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    // Governance zeros BCF and upgrades with a fresh liquidation module.
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    // Deactivation is checked before the BCF = 0 oracle skip, so borrow health still fails that way.
    await expect(comet.isBorrowCollateralized(albert.address)).to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(assetInfo.asset);

    // LCF > 0 keeps the liquidation path reading the reverting oracle.
    await expect(comet.isLiquidatable(albert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    await expect(comet.connect(betty.signer).absorb(betty.address, [albert.address])).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
  }
);

/**
 * Deactivated collateral with BCF/LCF-zero oracle skip and LF still positive. The liquidation path
 * ignores deactivation, skips the oracle because LCF = 0, and still seizes because LF > 0. A
 * deactivated asset can therefore still be absorbed and seized when BCF and LCF are zeroed but LF
 * remains positive, clearing the borrower even though the oracle reverts.
 */
scenario(
  'Comet#absorb > reverting collateral oracle with deactivated asset and BCF/LCF zero seizes collateral',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, cometExt, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, pauseGuardian, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    const assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPrice = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    // Collateral value = 10 * baseBorrowMin; debt value = 2 * baseBorrowMin.
    const suppliedCollateralValue = 10n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPrice;
    const borrowAmount = 2n * baseBorrowMin;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance wires a reverting collateral feed with default positive factors, then binds a
    // fresh liquidation module and upgrades Comet.
    const priceFeedWithRevert = await world.deploymentManager.deploy(
      'priceOracleReverts:deactivatedBcfLcfZero:priceFeed',
      'test/PriceFeedWithRevert.sol',
      [],
      true
    );
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetPriceFeed(
      comet.address,
      assetInfo.asset,
      priceFeedWithRevert.address
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    // Deactivate while factors are still positive.
    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    await expect(comet.isBorrowCollateralized(albert.address)).to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(assetInfo.asset);
    await expect(comet.isLiquidatable(albert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    await expect(comet.connect(betty.signer).absorb(betty.address, [albert.address])).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    // Zero BCF and LCF while leaving LF positive, then upgrade with a fresh liquidation module.
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    await expect(comet.getPrice(priceFeedWithRevert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    // Borrow path still checks deactivation before factor skips.
    await expect(comet.isBorrowCollateralized(albert.address)).to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(assetInfo.asset);

    // LCF = 0 skips the oracle on the liquidation path; uncovered debt makes the account liquidatable.
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    await expect(comet.getPrice(priceFeedWithRevert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);

    expect(collateralStateAfter.collateralBalance).to.equal(0n);

    expect(cometStateAfter.user.assetsIn).to.equal(0);
    expect(cometStateAfter.user._reserved).to.equal(0);

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral - collateralStateBefore.collateralBalance);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves + collateralStateBefore.collateralBalance);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);

/**
 * Deactivated collateral with all relevant factors zero. BCF and LCF skip oracle reads; LF = 0
 * skips the deactivated asset in the seizure loop. Even for deactivated collateral, LF = 0 makes
 * the asset non-seizable, so absorb clears the debt as bad debt while leaving the collateral with
 * the borrower.
 */
scenario(
  'Comet#absorb > reverting collateral oracle with deactivated asset and all factors zero skips seizure',
  {
    filter: async (context) =>
      (await hasModule(context)) &&
      (await getUsableCollateralIndices(context, 1)).length === 1,
  },
  async ({ comet, cometExt, configurator, proxyAdmin, actors }, context, world) => {
    const { admin, pauseGuardian, albert, betty } = actors;
    const [collateralIndex] = await getUsableCollateralIndices(context, 1);

    const baseToken = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseToken);
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseBorrowMin = (await comet.baseBorrowMin()).toBigInt();
    const minDebtValue = mulPrice(baseBorrowMin, basePrice, baseScale);
    await context.zeroBorrowRates();

    const assetInfo = await getAssetInfo(comet, collateralIndex);
    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const collateralPrice = (await comet.getPrice(assetInfo.priceFeed)).toBigInt();

    // Collateral value = 10 * baseBorrowMin; debt value = 2 * baseBorrowMin.
    const suppliedCollateralValue = 10n * minDebtValue;
    const collateralAmount = suppliedCollateralValue * assetInfo.scale / collateralPrice;
    const borrowAmount = 2n * baseBorrowMin;

    await context.sourceTokens(collateralAmount, collateralAsset, albert);
    await collateralAsset.approve(albert, comet.address);
    await albert.safeSupplyAsset({ asset: assetInfo.asset, amount: collateralAmount });

    await context.sourceTokens(2n * borrowAmount, baseAsset, comet.address);
    await albert.withdrawAsset({ asset: baseToken, amount: borrowAmount });

    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // Governance wires a reverting collateral feed with default positive factors, then binds a
    // fresh liquidation module and upgrades Comet.
    const priceFeedWithRevert = await world.deploymentManager.deploy(
      'priceOracleReverts:deactivatedAllFactorsZero:priceFeed',
      'test/PriceFeedWithRevert.sol',
      [],
      true
    );
    await fundAccount(world, admin);
    await configurator.connect(admin.signer).updateAssetPriceFeed(
      comet.address,
      assetInfo.asset,
      priceFeedWithRevert.address
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    // Deactivate while factors are still positive.
    await fundAccount(world, pauseGuardian);
    await cometExt.connect(pauseGuardian.signer).deactivateCollateral(collateralIndex);

    await expect(comet.isBorrowCollateralized(albert.address)).to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(assetInfo.asset);
    await expect(comet.isLiquidatable(albert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    await expect(comet.connect(betty.signer).absorb(betty.address, [albert.address])).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    // Zero BCF, LCF, and LF, then upgrade with a fresh liquidation module.
    await configurator.connect(admin.signer).updateAssetBorrowCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await configurator.connect(admin.signer).updateAssetLiquidateCollateralFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await configurator.connect(admin.signer).updateAssetLiquidationFactor(
      comet.address,
      assetInfo.asset,
      0
    );
    await context.prepareFreshLiquidationModule(comet, configurator.connect(admin.signer));
    await proxyAdmin.connect(admin.signer).deployAndUpgradeTo(configurator.address, comet.address);

    await expect(comet.getPrice(priceFeedWithRevert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    // Deactivation is checked before the BCF = 0 oracle skip.
    await expect(comet.isBorrowCollateralized(albert.address)).to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(assetInfo.asset);

    // LCF = 0 skips the oracle; uncovered debt makes the account liquidatable.
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    const cometStateBefore = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateBefore] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    await comet.connect(betty.signer).absorb(betty.address, [albert.address]);

    const cometStateAfter = await captureAbsorbStateBefore(comet, context, albert.address, baseToken);
    const [collateralStateAfter] = await makeCollateralStates(comet, context, albert.address, [assetInfo]);

    await expect(comet.getPrice(priceFeedWithRevert.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');

    // Debt is gone, so borrow health short-circuits and the account is no longer liquidatable.
    expect(await comet.isBorrowCollateralized(albert.address)).to.be.true;
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    expect(cometStateAfter.user.principal).to.equal(0);
    expect(cometStateAfter.userBalance).to.equal(0n);
    expect(await comet.borrowBalanceOf(albert.address)).to.equal(0);
    expect(await comet.balanceOf(albert.address)).to.equal(0);

    // LF = 0 skipped seizure: borrower keeps the full supplied amount and membership bits.
    expect(collateralStateAfter.collateralBalance).to.equal(collateralStateBefore.collateralBalance);
    expect(cometStateAfter.user.assetsIn).to.equal(cometStateBefore.user.assetsIn);
    expect(cometStateAfter.user._reserved).to.equal(cometStateBefore.user._reserved);

    expect(cometStateAfter.totals.totalBorrowBase).to.equal(cometStateBefore.totals.totalBorrowBase.add(cometStateBefore.user.principal));
    expect(cometStateAfter.totals.totalSupplyBase).to.equal(cometStateBefore.totals.totalSupplyBase);
    expect(cometStateAfter.cometBaseErc20Balance).to.equal(cometStateBefore.cometBaseErc20Balance);

    expect(collateralStateAfter.totalsCollateral).to.equal(collateralStateBefore.totalsCollateral);
    expect(collateralStateAfter.collateralReserves).to.equal(collateralStateBefore.collateralReserves);
    expect(collateralStateAfter.cometErc20Balance).to.equal(collateralStateBefore.cometErc20Balance);

    expect(cometStateAfter.baseReserves).to.equal(cometStateBefore.baseReserves + cometStateBefore.userBalance);
  }
);
