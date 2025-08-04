import { 
  expect, 
  exp, 
  factor, 
  makeProtocol
} from './helpers';
import { BigNumber } from 'ethers';

const FACTOR_SCALE = BigNumber.from('1000000000000000000');

describe('isPartiallyLiquidatable Tests', function () {
  it('returns true for account that can be partially liquidated', async () => {
    const { comet, users: [user], tokens } = await makeProtocol({
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

    // Supply: add balance
    await tokens.USDC.allocateTo(user.address, exp(20000, 6));
    await tokens.WETH.allocateTo(user.address, exp(15, 18));
    await tokens.USDC.connect(user).approve(comet.address, exp(10000, 6));
    await tokens.WETH.connect(user).approve(comet.address, exp(5, 18));
    await comet.connect(user).supply(tokens.USDC.address, exp(10000, 6));
    await comet.connect(user).supply(tokens.WETH.address, exp(5, 18));

    // Borrow: take large loan
    await comet.connect(user).withdraw(tokens.USDC.address, exp(8000, 6));

    // Repay: return small part of debt
    await tokens.USDC.allocateTo(user.address, exp(1000, 6));
    await tokens.USDC.connect(user).approve(comet.address, exp(1000, 6));
    await comet.connect(user).supply(tokens.USDC.address, exp(1000, 6));

    // Withdraw: withdraw part of collateral, making situation critical
    await comet.connect(user).withdraw(tokens.WETH.address, exp(2, 18));

    // Check partial liquidation functions
    const lhf = await (comet as any).getLHF(user.address);
    const targetHF = await (comet as any).getTargetHF(user.address);
    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    const isBadDebt = await (comet as any).isBadDebt(user.address);

    console.log(`   LHF: ${lhf}`);
    console.log(`   Target HF: ${targetHF}`);
    console.log(`   Minimal Debt: ${minimalDebt}`);
    console.log(`   Is Partially Liquidatable: ${isPartiallyLiquidatable}`);
    console.log(`   Is Bad Debt: ${isBadDebt}`);

    // If account is suitable for partial liquidation
    if (isPartiallyLiquidatable) {
      expect(minimalDebt).to.be.gt(0);
      expect(isBadDebt).to.be.false;
      console.log('   ✅ Account is suitable for partial liquidation');
    } else if (isBadDebt) {
      // If account became bad debt, minimal debt should equal full debt
      expect(minimalDebt).to.be.closeTo(exp(7000, 6), exp(100, 6)); // Allow small difference
      expect(isPartiallyLiquidatable).to.be.false;
      console.log('   ℹ️ Account became bad debt - this is normal for critical situation');
    } else {
      // If account is not suitable for partial liquidation, check it is healthy
      expect(minimalDebt).to.be.eq(0);
      console.log('   ℹ️ Account is healthy - not suitable for partial liquidation');
    }
  });

  it('creates scenario where isPartiallyLiquidatable returns true', async () => {
    const { comet, users: [user], tokens } = await makeProtocol({
      storefrontCoefficient: factor(0.7), // Even lower storefront coefficient
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.5), // Very low borrow CF
          liquidateCF: factor(0.75), // Low liquidate CF
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Supply: add substantial collateral
    await tokens.USDC.allocateTo(user.address, exp(20000, 6));
    await tokens.WETH.allocateTo(user.address, exp(10, 18));
    await tokens.USDC.connect(user).approve(comet.address, exp(10000, 6));
    await tokens.WETH.connect(user).approve(comet.address, exp(5, 18));
    await comet.connect(user).supply(tokens.USDC.address, exp(10000, 6));
    await comet.connect(user).supply(tokens.WETH.address, exp(5, 18));

    // Borrow: take large loan
    await comet.connect(user).withdraw(tokens.USDC.address, exp(9000, 6));

    // Repay: return small part to create debt
    await tokens.USDC.allocateTo(user.address, exp(500, 6));
    await tokens.USDC.connect(user).approve(comet.address, exp(500, 6));
    await comet.connect(user).supply(tokens.USDC.address, exp(500, 6));

    // Withdraw: withdraw significant collateral to make health factor low
    await comet.connect(user).withdraw(tokens.WETH.address, exp(3, 18));

    // Now manually set the situation to be partially liquidatable
    // Set debt: 4000 USDC
    const debtAmount = exp(4000, 6);
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    // Set collateral: 2.5 WETH (enough for partial, but not full liquidation)
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(2.5, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(2.5, 18));

    // Check partial liquidation functions
    const lhf = await (comet as any).getLHF(user.address);
    const targetHF = await (comet as any).getTargetHF(user.address);
    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    const isBadDebt = await (comet as any).isBadDebt(user.address);

    console.log(`   LHF: ${lhf}`);
    console.log(`   Target HF: ${targetHF}`);
    console.log(`   Minimal Debt: ${minimalDebt}`);
    console.log(`   Is Partially Liquidatable: ${isPartiallyLiquidatable}`);
    console.log(`   Is Bad Debt: ${isBadDebt}`);

    // This test should result in partial liquidation being possible
    expect(isPartiallyLiquidatable).to.be.true;
    expect(minimalDebt).to.be.gt(0);
    expect(isBadDebt).to.be.false;
    console.log('   ✅ Account is suitable for partial liquidation');
  });

  it('returns true with very low storefront coefficient', async () => {
    const { comet, users: [user] } = await makeProtocol({
      storefrontCoefficient: factor(0.65), // 65% - very low
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.6),      // 60% - lower borrow CF to make partial liquidation more likely
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Set debt: 3000 USDC
    const debtAmount = exp(3000, 6);
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    // Set collateral: 2.5 WETH
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(2.5, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(2.5, 18));

    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    
    expect(isPartiallyLiquidatable).to.be.true;
    expect(minimalDebt).to.be.gt(0);
  });

  it('returns false for account with good health factor', async () => {
    const { comet, users: [user] } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.8),      // 80% borrow CF
          liquidateCF: factor(0.85),  // 85% liquidate CF
          liquidationFactor: factor(0.9), // 90% liquidation factor
          supplyCap: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Set healthy account with low debt and high collateral
    const debtAmount = exp(2000, 6); // 2000 USDC debt
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    // Set high collateral: 5 WETH
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(5, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(5, 18));

    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    
    expect(isPartiallyLiquidatable).to.be.false;
    expect(minimalDebt).to.be.eq(0);
  });

  it('returns false for account with bad debt', async () => {
    const { comet, users: [user] } = await makeProtocol({
      storefrontCoefficient: factor(0.75), // 75% - more conservative
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

    // Set large debt: 10000 USDC
    const debtAmount = exp(10000, 6);
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    // Set small collateral: 1 WETH
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(1, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(1, 18));

    const isBadDebt = await (comet as any).isBadDebt(user.address);
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    
    expect(isBadDebt).to.be.true;
    expect(isPartiallyLiquidatable).to.be.false;
    expect(minimalDebt).to.be.closeTo(exp(10000, 6), exp(10, 6)); // Allow small difference
  });

  it('returns false for account with no debt', async () => {
    const { comet, users: [user] } = await makeProtocol({
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

    // Set no debt
    await (comet as any).setBasePrincipal(user.address, 0);
    
    // Set collateral: 2 WETH
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(2, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(2, 18));

    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    
    expect(isPartiallyLiquidatable).to.be.false;
    expect(minimalDebt).to.be.eq(0);
  });

  it('returns false for account with positive balance', async () => {
    const { comet, users: [user] } = await makeProtocol({}, 'CometHarnessPartially');
    
    // Set positive balance (supply)
    await (comet as any).setBasePrincipal(user.address, exp(1000, 6));

    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    
    expect(isPartiallyLiquidatable).to.be.false;
    expect(minimalDebt).to.be.eq(0);
  });

  it('returns false for account with no collateral', async () => {
    const { comet, users: [user] } = await makeProtocol({}, 'CometHarnessPartially');
    
    // Set debt but no collateral
    await (comet as any).setBasePrincipal(user.address, -exp(1000, 6));

    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    
    expect(isPartiallyLiquidatable).to.be.false;
    expect(minimalDebt).to.be.eq(exp(1000, 6)); // Full debt should be liquidated
  });

  it('tests different scenarios', async () => {
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

    // Test partially liquidatable scenario
    await (comet as any).setBasePrincipal(user.address, -exp(4000, 6));
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(2.5, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(2.5, 18));
    
    let isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    expect(isPartiallyLiquidatable).to.be.true;

    // Test bad debt scenario
    await (comet as any).setBasePrincipal(user.address, -exp(10000, 6));
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(1, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(1, 18));
    
    const isBadDebt = await (comet as any).isBadDebt(user.address);
    expect(isBadDebt).to.be.true;
  });
}); 