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
    const { comet, users: [user] } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.7),      // 70% borrow CF - lower value
          liquidateCF: factor(0.85),  // 85% liquidate CF
          liquidationFactor: factor(0.9), // 90% liquidation factor
          supplyCap: exp(100, 18),
        }
      }
    }, 'CometHarnessPartially');

    // Set debt: 4000 USDC
    const debtAmount = exp(4000, 6);
    await (comet as any).setBasePrincipal(user.address, -debtAmount);
    
    // Set collateral: 2.5 WETH
    const assetInfo = await (comet as any).getAssetInfo(0);
    await (comet as any).setCollateralBalance(user.address, assetInfo.asset, exp(2.5, 18));
    await (comet as any).updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(2.5, 18));

    // Get health factors
    const lhf = await (comet as any).getLHF(user.address);
    const targetHF = await (comet as any).getTargetHF(user.address);
    const minimalDebt = await (comet as any).getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await (comet as any).isPartiallyLiquidatable(user.address);
    const isBadDebt = await (comet as any).isBadDebt(user.address);

    // Debug info
    console.log('=== Partial Liquidation Debug ===');
    console.log('Debt:', debtAmount.toString());
    console.log('Collateral: 2.5 WETH');
    console.log('LHF:', lhf.toString());
    console.log('Target HF:', targetHF.toString());
    console.log('Minimal Debt:', minimalDebt.toString());
    console.log('Is Partially Liquidatable:', isPartiallyLiquidatable);
    console.log('Is Bad Debt:', isBadDebt);
    console.log('================================');

    // Verify the result
    expect(isPartiallyLiquidatable).to.be.true;
    expect(minimalDebt).to.be.gt(0);
    expect(isBadDebt).to.be.false;
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