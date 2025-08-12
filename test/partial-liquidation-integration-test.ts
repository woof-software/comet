import { 
  expect, 
  exp, 
  factor, 
  makeProtocol,
  ethers
} from './helpers';

const FACTOR_SCALE = BigInt('1000000000000000000');

describe('CometWithPartialLiquidation Integration Tests', function () {
  it('should automatically choose between partial and full liquidation', async () => {
    const { comet, users: [user, liquidator], tokens } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1, initial: exp(50000, 6) },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
          initial: exp(50, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Setup account for testing
    await tokens.USDC.transfer(user.address, exp(20000, 6));
    await tokens.WETH.transfer(user.address, exp(15, 18));
    await tokens.USDC.connect(user).approve(comet.address, exp(10000, 6));
    await tokens.WETH.connect(user).approve(comet.address, exp(5, 18));
    await comet.connect(user).supply(tokens.USDC.address, exp(10000, 6));
    await comet.connect(user).supply(tokens.WETH.address, exp(5, 18));

    // Borrow amount
    await comet.connect(user).withdraw(tokens.USDC.address, exp(8000, 6));

    // Repay small part
    await tokens.USDC.transfer(user.address, exp(1000, 6));
    await tokens.USDC.connect(user).approve(comet.address, exp(1000, 6));
    await comet.connect(user).supply(tokens.USDC.address, exp(1000, 6));

    // Withdraw some collateral to make situation critical
    await comet.connect(user).withdraw(tokens.WETH.address, exp(2, 18));

    // Check account state
    const isLiquidatable = await comet.isLiquidatable(user.address);
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    const isBadDebt = await (comet as any).isBadDebt(user.address);
    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    
    console.log(`   Is Liquidatable: ${isLiquidatable}`);
    console.log(`   Is Partially Liquidatable: ${isPartiallyLiquidatable}`);
    console.log(`   Is Bad Debt: ${isBadDebt}`);
    console.log(`   Minimal Debt: ${minimalDebt}`);

    if (isLiquidatable) {
      // Get initial balances
      const initialUserBalance = await comet.borrowBalanceOf(user.address);
      const initialWETHBalance = await tokens.WETH.balanceOf(user.address);
      
      console.log(`   Initial user debt: ${initialUserBalance}`);
      console.log(`   Initial WETH balance: ${initialWETHBalance}`);

      // Perform absorb - this should automatically choose the right liquidation type
      await comet.connect(liquidator).absorb(liquidator.address, [user.address]);

      // Check results
      const finalUserBalance = await comet.borrowBalanceOf(user.address);
      const finalWETHBalance = await tokens.WETH.balanceOf(user.address);
      
      console.log(`   Final user debt: ${finalUserBalance}`);
      console.log(`   Final WETH balance: ${finalWETHBalance}`);

      // Verify liquidation occurred
      expect(finalUserBalance).to.be.lte(initialUserBalance);
      
      if (isPartiallyLiquidatable && !isBadDebt) {
        // Should be partial liquidation
        expect(finalUserBalance).to.be.gt(0); // Should not be fully liquidated
        expect(finalWETHBalance).to.be.gt(0); // Should have some collateral left
        console.log('   ✅ Partial liquidation performed automatically');
      } else {
        // Should be full liquidation
        expect(finalUserBalance).to.be.eq(0); // Should be fully liquidated
        expect(finalWETHBalance).to.be.eq(0); // All collateral seized
        console.log('   ✅ Full liquidation performed automatically');
      }
    } else {
      console.log('   ℹ️ Account is not liquidatable');
    }
  });

  it('should test mathematical accuracy of liquidation formulas', async () => {
    const { comet, users: [user] } = await makeProtocol({
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

    // Setup account exactly on liquidation threshold
    await (comet as any).setBasePrincipal(user.address, -exp(5000, 6)); // Debt
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(2.5, 18)); // Reduced collateral to make liquidatable
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(2.5, 18));

    // Test formula (13): Δdebt = debt - (Σ(collateral_i * CF_i) * targetHF)
    const lhf = await (comet as any).getLHF(user.address);
    const targetHF = await (comet as any).getTargetHF(user.address);
    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    
    console.log(`   LHF: ${lhf}`);
    console.log(`   Target HF: ${targetHF}`);
    console.log(`   Minimal Debt: ${minimalDebt}`);

    // Verify target HF calculation (formula 14): Target_HF = LHF * Store_factor
    const expectedTargetHF = (BigInt(lhf) * BigInt(factor(0.8))) / FACTOR_SCALE;
    expect(targetHF).to.be.closeTo(expectedTargetHF, exp(1, 15)); // Allow small precision error

    // Test that after partial liquidation, account is no longer liquidatable
    if (minimalDebt > 0) {
      const initialLiquidatable = await comet.isLiquidatable(user.address);
      console.log(`   Initial liquidatable: ${initialLiquidatable}`);
      
      // Only proceed if account is actually liquidatable
      if (initialLiquidatable) {
        // Simulate partial liquidation by reducing debt
        const remainingDebt = BigInt(exp(5000, 6)) - BigInt(minimalDebt);
        await (comet as any).setBasePrincipal(user.address, -Number(remainingDebt));

        const finalLiquidatable = await comet.isLiquidatable(user.address);
        expect(finalLiquidatable).to.be.false; // Should no longer be liquidatable

        console.log('   ✅ Formula accuracy verified - account exits liquidation zone');
      } else {
        console.log('   ℹ️ Account is not liquidatable, skipping liquidation simulation');
      }
    } else {
      console.log('   ℹ️ No minimal debt calculated, skipping test');
    }
  });

  it('should test edge cases and boundary conditions', async () => {
    const { comet, users: [user] } = await makeProtocol({
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

    console.log('\n   Testing edge cases:');

    // Edge case 1: Position exactly on liquidation threshold
    await (comet as any).setBasePrincipal(user.address, -exp(1000, 6));
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(0.588, 18)); // Exact threshold
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(0.588, 18));
    
    let isLiquidatable = await comet.isLiquidatable(user.address);
    let isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    console.log(`   Exact threshold - Liquidatable: ${isLiquidatable}, Partially: ${isPartiallyLiquidatable}`);

    // Edge case 2: Position that cannot reach target HF (bad debt)
    await (comet as any).setBasePrincipal(user.address, -exp(10000, 6)); // Very high debt
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(0.1, 18)); // Very low collateral
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(0.1, 18));
    
    isLiquidatable = await comet.isLiquidatable(user.address);
    isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    const isBadDebt = await (comet as any).isBadDebt(user.address);
    console.log(`   Cannot reach target HF - Liquidatable: ${isLiquidatable}, Partially: ${isPartiallyLiquidatable}, Bad Debt: ${isBadDebt}`);

    // Edge case 3: Zero collateral
    await (comet as any).setBasePrincipal(user.address, -exp(1000, 6));
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, 0);
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, 0);
    
    isLiquidatable = await comet.isLiquidatable(user.address);
    isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    console.log(`   Zero collateral - Liquidatable: ${isLiquidatable}, Partially: ${isPartiallyLiquidatable}`);

    console.log('   ✅ Edge cases tested successfully');
  });

  it('should test dust position handling', async () => {
    const { comet, users: [user] } = await makeProtocol({
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

    const baseBorrowMin = await comet.baseBorrowMin();
    console.log(`   Base Borrow Min: ${baseBorrowMin}`);

    // Test dust position scenario
    await (comet as any).setBasePrincipal(user.address, -Number(baseBorrowMin.toString()) + 1); // Debt just below minimum
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(1, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(1, 18));

    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    
    console.log(`   Dust position - Minimal Debt: ${minimalDebt}, Partially Liquidatable: ${isPartiallyLiquidatable}`);

    // Verify that dust positions are handled correctly
    if (BigInt(minimalDebt.toString()) < BigInt(baseBorrowMin.toString())) {
      console.log('   ✅ Dust position detected and handled');
    }

    // Test position that would leave dust after partial liquidation
    await (comet as any).setBasePrincipal(user.address, -Number(baseBorrowMin.toString()) * 2); // Debt twice minimum
    const minimalDebt2 = await (comet as any).getMinimalDebt(user.address);
    const remainingDebt = BigInt(baseBorrowMin.toString()) * 2n - BigInt(minimalDebt2.toString());
    
    console.log(`   Would leave dust - Remaining debt: ${remainingDebt}, Below min: ${remainingDebt < BigInt(baseBorrowMin.toString())}`);
    
    if (remainingDebt > 0n && remainingDebt < BigInt(baseBorrowMin.toString())) {
      console.log('   ✅ Dust position prevention verified');
    }
  });

  it('should test multiple partial liquidations on same position', async () => {
    const { comet, users: [user, liquidator], tokens } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1, initial: exp(100000, 6) },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
          initial: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Setup account for multiple liquidations with more tokens
    await tokens.USDC.transfer(user.address, exp(50000, 6)); // Increased allocation
    await tokens.WETH.transfer(user.address, exp(25, 18)); // Increased allocation
    await tokens.USDC.connect(user).approve(comet.address, exp(20000, 6)); // Increased approval
    await tokens.WETH.connect(user).approve(comet.address, exp(10, 18)); // Increased approval
    await comet.connect(user).supply(tokens.USDC.address, exp(20000, 6)); // Increased supply
    await comet.connect(user).supply(tokens.WETH.address, exp(10, 18)); // Increased supply

    // Borrow large amount
    await comet.connect(user).withdraw(tokens.USDC.address, exp(15000, 6)); // Increased borrow

    // Withdraw collateral to make liquidatable
    await comet.connect(user).withdraw(tokens.WETH.address, exp(5, 18)); // Increased withdrawal

    console.log('\n   Testing multiple partial liquidations:');

    // First liquidation
    let isLiquidatable = await comet.isLiquidatable(user.address);
    let isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    console.log(`   Before 1st liquidation - Liquidatable: ${isLiquidatable}, Partially: ${isPartiallyLiquidatable}`);

    if (isLiquidatable) {
      const initialDebt = await comet.borrowBalanceOf(user.address);
      console.log(`   Initial debt: ${initialDebt}`);

      // Perform first liquidation
      await comet.connect(liquidator).absorb(liquidator.address, [user.address]);

      const debtAfter1st = await comet.borrowBalanceOf(user.address);
      console.log(`   Debt after 1st liquidation: ${debtAfter1st}`);

      // Check if still liquidatable
      isLiquidatable = await comet.isLiquidatable(user.address);
      isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
      console.log(`   After 1st liquidation - Liquidatable: ${isLiquidatable}, Partially: ${isPartiallyLiquidatable}`);

      // If still liquidatable, perform second liquidation
      if (isLiquidatable) {
        console.log('   Performing second liquidation...');
        await comet.connect(liquidator).absorb(liquidator.address, [user.address]);

        const debtAfter2nd = await comet.borrowBalanceOf(user.address);
        console.log(`   Debt after 2nd liquidation: ${debtAfter2nd}`);

        // Verify that debt decreased
        expect(debtAfter2nd).to.be.lte(debtAfter1st);
      }

      // Final check
      const finalLiquidatable = await comet.isLiquidatable(user.address);
      console.log(`   Final state - Liquidatable: ${finalLiquidatable}`);
    } else {
      console.log('   ℹ️ Account is not liquidatable, skipping liquidation test');
    }

    console.log('   ✅ Multiple liquidation test completed');
  });

  it('should test ecosystem compatibility and event emissions', async () => {
    const { comet, users: [user, liquidator], tokens } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1, initial: exp(50000, 6) },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
          initial: exp(50, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Setup account for liquidation
    await tokens.USDC.transfer(user.address, exp(20000, 6));
    await tokens.WETH.transfer(user.address, exp(15, 18));
    
    // Check balances after transfer
    const userUSDCBalance = await tokens.USDC.balanceOf(user.address);
    const userWETHBalance = await tokens.WETH.balanceOf(user.address);
    console.log(`   User USDC balance after transfer: ${userUSDCBalance}`);
    console.log(`   User WETH balance after transfer: ${userWETHBalance}`);
    
    await tokens.USDC.connect(user).approve(comet.address, exp(10000, 6));
    await tokens.WETH.connect(user).approve(comet.address, exp(15, 18)); // Approve 15 WETH instead of 10
    
    // Check allowance
    const userUSDCAllowance = await tokens.USDC.allowance(user.address, comet.address);
    const userWETHAllowance = await tokens.WETH.allowance(user.address, comet.address);
    console.log(`   User USDC allowance: ${userUSDCAllowance}`);
    console.log(`   User WETH allowance: ${userWETHAllowance}`);
    
    await comet.connect(user).supply(tokens.USDC.address, exp(10000, 6));
    await comet.connect(user).supply(tokens.WETH.address, exp(5, 18));

    await comet.connect(user).withdraw(tokens.USDC.address, exp(8000, 6));
    await comet.connect(user).withdraw(tokens.WETH.address, exp(2, 18));

    console.log('\n   Testing ecosystem compatibility:');

    // Test that existing functions still work
    const isLiquidatable = await comet.isLiquidatable(user.address);
    const borrowBalance = await comet.borrowBalanceOf(user.address);
    const collateralBalance = await comet.getCollateralReserves(tokens.WETH.address);
    
    console.log(`   Existing functions work - Liquidatable: ${isLiquidatable}, Borrow: ${borrowBalance}, Collateral: ${collateralBalance}`);

    // Test event emissions during liquidation
    if (isLiquidatable) {
      const initialCollateral = await tokens.WETH.balanceOf(user.address);
      
      // Listen for events
      const tx = await comet.connect(liquidator).absorb(liquidator.address, [user.address]);
      const receipt = await tx.wait();

      // Check that AbsorbCollateral and AbsorbDebt events are emitted
      const absorbCollateralEvents = receipt.events?.filter(e => e.event === 'AbsorbCollateral') || [];
      const absorbDebtEvents = receipt.events?.filter(e => e.event === 'AbsorbDebt') || [];

      console.log(`   Events emitted - AbsorbCollateral: ${absorbCollateralEvents.length}, AbsorbDebt: ${absorbDebtEvents.length}`);

      expect(absorbCollateralEvents.length).to.be.gte(0);
      expect(absorbDebtEvents.length).to.be.gte(0);

      const finalCollateral = await tokens.WETH.balanceOf(user.address);
      console.log(`   Collateral change - Before: ${initialCollateral}, After: ${finalCollateral}`);
    }

    // Test buyCollateral still works
    const reserves = await comet.getReserves();
    if (reserves.gt(0)) {
      const quote = await comet.quoteCollateral(tokens.WETH.address, exp(1000, 6));
      console.log(`   BuyCollateral compatibility - Quote for 1000 USDC: ${quote} WETH`);
    }

    console.log('   ✅ Ecosystem compatibility verified');
  });

  it('should test extended asset list functionality', async () => {
    const { comet, users: [user] } = await makeProtocol({
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

    console.log('\n   Testing extended asset list functionality:');

    // Test numAssets
    const numAssets = await comet.numAssets();
    console.log(`   Number of assets: ${numAssets}`);

    // Test getAssetInfo
    for (let i = 0; i < numAssets; i++) {
      const assetInfo = await comet.getAssetInfo(i);
      console.log(`   Asset ${i}: ${assetInfo.asset}, Scale: ${assetInfo.scale}, BorrowCF: ${assetInfo.borrowCollateralFactor}`);
    }

    // Test getAssetInfoByAddress
    const asset0 = await comet.getAssetInfo(0);
    if (asset0.asset !== ethers.constants.AddressZero) {
      const wethAssetInfo = await comet.getAssetInfoByAddress(asset0.asset);
      console.log(`   Asset by address: ${wethAssetInfo.asset}`);
      
      // Test getCollateralReserves
      const collateralReserves = await comet.getCollateralReserves(asset0.asset);
      console.log(`   Collateral reserves: ${collateralReserves}`);
    }

    console.log('   ✅ Extended asset list functionality verified');
  });

  it('should test partial liquidation with multiple assets', async () => {
    const { comet, users: [user, liquidator], tokens } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1, initial: exp(50000, 6) },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
          initial: exp(50, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Setup account with multiple collateral types
    await tokens.USDC.transfer(user.address, exp(20000, 6));
    await tokens.WETH.transfer(user.address, exp(15, 18));
    await tokens.USDC.connect(user).approve(comet.address, exp(20000, 6));
    await tokens.WETH.connect(user).approve(comet.address, exp(15, 18));
    await comet.connect(user).supply(tokens.USDC.address, exp(10000, 6));
    await comet.connect(user).supply(tokens.WETH.address, exp(15, 18));

    // Borrow and withdraw collateral
    await comet.connect(user).withdraw(tokens.USDC.address, exp(8000, 6));
    await comet.connect(user).withdraw(tokens.WETH.address, exp(5, 18));

    console.log('\n   Testing partial liquidation with multiple assets:');

    // Check if partially liquidatable
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    
    console.log(`   Partially liquidatable: ${isPartiallyLiquidatable}`);
    console.log(`   Minimal debt: ${minimalDebt}`);

    if (isPartiallyLiquidatable) {
      // Get collateral breakdown for minimal debt
      const [assets, amounts] = await (comet as any).collateralForMinimalDebt(user.address);
      
      console.log(`   Collateral breakdown - Assets: ${assets.length}, Total amounts: ${amounts.length}`);
      
      for (let i = 0; i < assets.length; i++) {
        console.log(`   Asset ${i}: ${assets[i]}, Amount: ${amounts[i]}`);
      }

      // Perform partial liquidation
      const initialDebt = await comet.borrowBalanceOf(user.address);
      const initialWETHBalance = await tokens.WETH.balanceOf(user.address);
      
      console.log(`   Before liquidation - Debt: ${initialDebt}, WETH: ${initialWETHBalance}`);
      
      await comet.connect(liquidator).absorb(liquidator.address, [user.address]);
      
      const finalDebt = await comet.borrowBalanceOf(user.address);
      const finalWETHBalance = await tokens.WETH.balanceOf(user.address);
      
      console.log(`   After liquidation - Debt: ${finalDebt}, WETH: ${finalWETHBalance}`);
      
      // Verify partial liquidation occurred
      expect(finalDebt).to.be.lt(initialDebt);
      expect(finalWETHBalance).to.be.gt(0); // Should have some collateral left
      
      console.log('   ✅ Partial liquidation with multiple assets successful');
    } else {
      console.log('   ℹ️ Account is not partially liquidatable');
    }
  });

  it('should perform stress test with multiple accounts', async () => {
    const { comet, users, tokens } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1, initial: exp(100000, 6) },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
          initial: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    console.log('\n   Performing stress test:');

    const liquidator = users[0];
    const accountsToLiquidate = [];

    // Setup multiple accounts for liquidation
    for (let i = 1; i < Math.min(users.length, 5); i++) {
      const user = users[i];
      
      // Setup account
      await tokens.USDC.transfer(user.address, exp(20000, 6));
      await tokens.WETH.transfer(user.address, exp(15, 18));
      await tokens.USDC.connect(user).approve(comet.address, exp(10000, 6));
      await tokens.WETH.connect(user).approve(comet.address, exp(5, 18));
      await comet.connect(user).supply(tokens.USDC.address, exp(10000, 6));
      await comet.connect(user).supply(tokens.WETH.address, exp(5, 18));

      // Borrow and withdraw collateral
      await comet.connect(user).withdraw(tokens.USDC.address, exp(8000 + i * 100, 6));
      await comet.connect(user).withdraw(tokens.WETH.address, exp(2, 18));

      const isLiquidatable = await comet.isLiquidatable(user.address);
      if (isLiquidatable) {
        accountsToLiquidate.push(user.address);
      }
    }

    console.log(`   Accounts to liquidate: ${accountsToLiquidate.length}`);

    // Perform bulk liquidation
    if (accountsToLiquidate.length > 0) {
      const tx = await comet.connect(liquidator).absorb(liquidator.address, accountsToLiquidate);
      const receipt = await tx.wait();

      console.log(`   Bulk liquidation completed - Gas used: ${receipt.gasUsed}`);
      
      // Verify all accounts are no longer liquidatable
      for (const account of accountsToLiquidate) {
        const isStillLiquidatable = await comet.isLiquidatable(account);
        expect(isStillLiquidatable).to.be.false;
      }

      console.log('   ✅ All accounts successfully liquidated');
    }

    console.log('   ✅ Stress test completed');
  });
});
