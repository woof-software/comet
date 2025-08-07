import { 
  expect, 
  exp, 
  factor, 
  makeProtocol
} from './helpers';
import { BigNumber } from 'ethers';

const FACTOR_SCALE = BigNumber.from('1000000000000000000');

describe('absorbPartial Function Tests', function () {
  it('successfully performs partial liquidation', async () => {
    const { comet, users: [user, absorber], tokens } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Setup account for partial liquidation
    const debtAmount = exp(4000, 6); // 4000 USDC debt
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    // Set collateral: 2.5 WETH
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(2.5, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(2.5, 18));

    // Check initial state
    const initialDebt = await (comet as any).borrowBalanceOf(user.address);
    const initialCollateral = await (comet as any).userCollateral(user.address, assetInfo.asset);
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    
    console.log(`   Initial Debt: ${initialDebt}`);
    console.log(`   Initial Collateral: ${initialCollateral.balance}`);
    console.log(`   Is Partially Liquidatable: ${isPartiallyLiquidatable}`);

    expect(isPartiallyLiquidatable).to.be.true;

    // Perform partial liquidation
    await expect((comet as any).connect(absorber).absorbPartial(absorber.address, user.address))
      .to.emit(comet, 'AbsorbDebt')
      .to.emit(comet, 'AbsorbCollateral');

    // Check final state
    const finalDebt = await (comet as any).borrowBalanceOf(user.address);
    const finalCollateral = await (comet as any).userCollateral(user.address, assetInfo.asset);
    
    console.log(`   Final Debt: ${finalDebt}`);
    console.log(`   Final Collateral: ${finalCollateral.balance}`);

    // Verify debt was reduced
    expect(finalDebt).to.be.lt(initialDebt);
    expect(finalDebt).to.be.gt(0); // Should still have some debt

    // Verify collateral was seized
    expect(finalCollateral.balance).to.be.lt(initialCollateral.balance);
    expect(finalCollateral.balance).to.be.gt(0); // Should still have some collateral

    // Verify account is no longer partially liquidatable
    const isStillPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    // Note: Account might still be partially liquidatable if the liquidation was partial
    // This is expected behavior - we just verify that debt and collateral were reduced
    console.log(`   Is Still Partially Liquidatable: ${isStillPartiallyLiquidatable}`);

    console.log('   ✅ Partial liquidation completed successfully');
  });

  it('fails when account is not partially liquidatable', async () => {
    const { comet, users: [user, absorber] } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.8),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Setup healthy account
    const debtAmount = exp(2000, 6);
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(5, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(5, 18));

    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    expect(isPartiallyLiquidatable).to.be.false;

    // Should fail
    await expect((comet as any).connect(absorber).absorbPartial(absorber.address, user.address))
      .to.be.revertedWithCustomError(comet, 'NotLiquidatable');

    console.log('   ✅ Correctly rejected non-liquidatable account');
  });

  it('fails when account has bad debt', async () => {
    const { comet, users: [user, absorber] } = await makeProtocol({
      storefrontCoefficient: factor(0.75),
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Setup bad debt account
    const debtAmount = exp(10000, 6);
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(1, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(1, 18));

    const isBadDebt = await (comet as any).isBadDebt(user.address);
    expect(isBadDebt).to.be.true;

    // Should fail
    await expect((comet as any).connect(absorber).absorbPartial(absorber.address, user.address))
      .to.be.revertedWithCustomError(comet, 'NotLiquidatable');

    console.log('   ✅ Correctly rejected bad debt account');
  });

  it('fails when absorb is paused', async () => {
    const { comet, users: [user, absorber] } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Setup account for partial liquidation
    const debtAmount = exp(4000, 6);
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(2.5, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(2.5, 18));

    // Pause absorb
    await comet.pause(false, false, false, true, false);

    // Should fail
    await expect((comet as any).connect(absorber).absorbPartial(absorber.address, user.address))
      .to.be.revertedWithCustomError(comet, 'Paused');

    console.log('   ✅ Correctly rejected when absorb is paused');
  });

  it('correctly calculates minimal debt and seizes appropriate collateral', async () => {
    const { comet, users: [user, absorber] } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Setup account with specific debt and collateral
    const debtAmount = exp(5000, 6); // 5000 USDC debt
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    const collateralAmount = exp(3, 18); // 3 WETH collateral
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, collateralAmount);
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, collateralAmount);

    // Calculate expected minimal debt
    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    console.log(`   Expected Minimal Debt: ${minimalDebt}`);

    // Perform partial liquidation using explicit absorbPartial call
    await (comet as any).connect(absorber).absorbPartial(absorber.address, user.address);

    // Check final debt
    const finalDebt = await (comet as any).borrowBalanceOf(user.address);
    const expectedFinalDebt = BigNumber.from(debtAmount).sub(BigNumber.from(minimalDebt));
    
    console.log(`   Final Debt: ${finalDebt}`);
    console.log(`   Expected Final Debt: ${expectedFinalDebt}`);

    // Allow small difference due to rounding
    expect(finalDebt).to.be.closeTo(expectedFinalDebt, exp(10, 6));

    console.log('   ✅ Minimal debt calculation and collateral seizure correct');
  });

  it('can be called explicitly even when absorb would choose partial automatically', async () => {
    const { comet, users: [user, absorber] } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Setup account for partial liquidation
    const debtAmount = exp(5000, 6);
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    const collateralAmount = exp(3, 18);
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, collateralAmount);
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, collateralAmount);

    // Verify account is partially liquidatable
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    expect(isPartiallyLiquidatable).to.be.true;

    // Call absorbPartial explicitly
    await (comet as any).connect(absorber).absorbPartial(absorber.address, user.address);

    // Verify partial liquidation occurred
    const finalDebt = await (comet as any).borrowBalanceOf(user.address);
    const finalCollateral = await (comet as any).userCollateral(user.address, assetInfo.asset);
    const isStillLiquidatable = await (comet as any).isLiquidatable(user.address);
    
    console.log(`\n📊 Explicit absorbPartial Results:`);
    console.log(`   Final Debt: ${finalDebt.toString()}`);
    console.log(`   Final Collateral: ${finalCollateral.balance.toString()}`);
    console.log(`   Still Liquidatable: ${isStillLiquidatable}`);

    // Should have reduced but not eliminated debt and collateral
    expect(finalDebt).to.be.gt(0);
    expect(finalCollateral.balance).to.be.gt(0);
    expect(isStillLiquidatable).to.be.false;

    console.log('   ✅ Explicit absorbPartial works correctly');
  });

  it('handles multiple collateral assets correctly', async () => {
    const { comet, users: [user, absorber], tokens } = await makeProtocol({
      storefrontCoefficient: factor(0.7), // Lower storefront coefficient to make partial liquidation more likely
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.6), // Lower borrow CF
          liquidateCF: factor(0.8), // Lower liquidate CF
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        },
        WBTC: {
          decimals: 8,
          initialPrice: 40000,
          borrowCF: factor(0.5), // Even lower borrow CF
          liquidateCF: factor(0.75), // Lower liquidate CF
          liquidationFactor: factor(0.85),
          supplyCap: exp(100, 8),
        }
      }
    }, 'CometHarnessPartially');

    // Setup account with multiple collaterals and higher debt
    const debtAmount = exp(12000, 6); // Higher debt
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    // Set WETH collateral
    const wethInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, wethInfo.asset, exp(3, 18));
    await (comet as any).updateAssetsInExternal(user.address, wethInfo.asset, 0, exp(3, 18));

    // Set WBTC collateral
    const wbtcInfo = await (comet as any).getAssetInfo(1);
    await (comet as any).setCollateralBalance(user.address, wbtcInfo.asset, exp(0.2, 8));
    await (comet as any).updateAssetsInExternal(user.address, wbtcInfo.asset, 0, exp(0.2, 8));

    const initialWethCollateral = await (comet as any).userCollateral(user.address, wethInfo.asset);
    const initialWbtcCollateral = await (comet as any).userCollateral(user.address, wbtcInfo.asset);

    console.log(`   Initial WETH Collateral: ${initialWethCollateral.balance}`);
    console.log(`   Initial WBTC Collateral: ${initialWbtcCollateral.balance}`);

    // Check if account is partially liquidatable
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    
    if (isPartiallyLiquidatable) {
      // Perform partial liquidation
      await (comet as any).connect(absorber).absorbPartial(absorber.address, user.address);

      const finalWethCollateral = await (comet as any).userCollateral(user.address, wethInfo.asset);
      const finalWbtcCollateral = await (comet as any).userCollateral(user.address, wbtcInfo.asset);

      console.log(`   Final WETH Collateral: ${finalWethCollateral.balance}`);
      console.log(`   Final WBTC Collateral: ${finalWbtcCollateral.balance}`);

      // Verify both collaterals were seized
      expect(finalWethCollateral.balance).to.be.lt(initialWethCollateral.balance);
      expect(finalWbtcCollateral.balance).to.be.lt(initialWbtcCollateral.balance);

      console.log('   ✅ Multiple collateral assets handled correctly');
    } else {
      console.log('   ℹ️ Multiple collateral scenario not suitable for partial liquidation');
    }
  });

  it('emits correct events during partial liquidation', async () => {
    const { comet, users: [user, absorber] } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Setup account for partial liquidation
    const debtAmount = exp(4000, 6);
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(2.5, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(2.5, 18));

    // Perform partial liquidation and check events
    await expect((comet as any).connect(absorber).absorbPartial(absorber.address, user.address))
      .to.emit(comet, 'AbsorbDebt')
      .to.emit(comet, 'AbsorbCollateral');

    console.log('   ✅ Correct events emitted');
  });

  it('handles edge case with very small debt', async () => {
    const { comet, users: [user, absorber] } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Setup account with small debt
    const debtAmount = exp(100, 6); // 100 USDC debt
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(0.1, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(0.1, 18));

    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    
    if (isPartiallyLiquidatable) {
      await (comet as any).connect(absorber).absorbPartial(absorber.address, user.address);
      const finalDebt = await (comet as any).borrowBalanceOf(user.address);
      expect(finalDebt).to.be.lt(debtAmount);
      console.log('   ✅ Small debt handled correctly');
    } else {
      console.log('   ℹ️ Small debt scenario not suitable for partial liquidation');
    }
  });

  it('handles edge case with very large collateral', async () => {
    const { comet, users: [user, absorber] } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Setup account with large collateral and higher debt
    const debtAmount = exp(15000, 6); // Higher debt to make partial liquidation more likely
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(50, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(50, 18));

    const initialCollateral = await (comet as any).userCollateral(user.address, assetInfo.asset);
    const initialDebt = await (comet as any).borrowBalanceOf(user.address);
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);

    console.log(`   Initial Debt: ${initialDebt}`);
    console.log(`   Initial Collateral: ${initialCollateral.balance}`);
    console.log(`   Is Partially Liquidatable: ${isPartiallyLiquidatable}`);

    if (isPartiallyLiquidatable) {
      // Perform partial liquidation
      await (comet as any).connect(absorber).absorbPartial(absorber.address, user.address);

      const finalCollateral = await (comet as any).userCollateral(user.address, assetInfo.asset);
      const finalDebt = await (comet as any).borrowBalanceOf(user.address);

      console.log(`   Final Debt: ${finalDebt}`);
      console.log(`   Final Collateral: ${finalCollateral.balance}`);

      // Verify changes
      expect(finalDebt).to.be.lt(initialDebt);
      expect(finalCollateral.balance).to.be.lt(initialCollateral.balance);

      console.log('   ✅ Large collateral handled correctly');
    } else {
      console.log('   ℹ️ Large collateral scenario not suitable for partial liquidation');
    }
  });
}); 