import { expect, exp, factor, makeProtocol } from './helpers';
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
    });

    // Set moderate debt: 4000 USDC
    const debtAmount = exp(4000, 6);
    await comet.setBasePrincipal(user.address, -debtAmount);
    
    // Set moderate collateral: 2.5 WETH (worth 5000 USDC)
    const assetInfo = await comet.getAssetInfo(0);
    await comet.setCollateralBalance(user.address, assetInfo.asset, exp(2.5, 18));
    await comet.updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(2.5, 18));

  
    const minimalDebt = await comet.getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await comet.isPartiallyLiquidatable(user.address);
    const isBadDebt = await comet.isBadDebt(user.address);

    const price = await comet.getPrice(assetInfo.priceFeed);
    const scale = await comet.callStatic.getAssetInfo(0).then(a => a.scale);
    const collateralValue = BigNumber.from(exp(2.5, 18)).mul(price).div(scale);
    const borrowCF = await comet.callStatic.getAssetInfo(0).then(a => a.borrowCollateralFactor);
    const liquidationFactor = await comet.callStatic.getAssetInfo(0).then(a => a.liquidationFactor);
    const borrowCFValue = collateralValue.mul(borrowCF).div(FACTOR_SCALE);
    const liquidationFactorValue = collateralValue.mul(liquidationFactor).div(FACTOR_SCALE);
    const lhf = liquidationFactorValue.mul(FACTOR_SCALE).div(debtAmount);
    const storefrontCoefficient = BigNumber.from(factor(0.8)); // Используем значение из makeProtocol
    const targetHF = lhf.mul(storefrontCoefficient).div(FACTOR_SCALE);
    const targetDebt = borrowCFValue.mul(targetHF).div(FACTOR_SCALE);

    console.log('--- Partial Liquidation Debug ---');
    console.log('Debt:', debtAmount.toString());
    console.log('Collateral (WETH):', exp(2.5, 18).toString());
    console.log('Collateral value (USD):', collateralValue.toString());
    console.log('BorrowCF:', borrowCF.toString());
    console.log('LiquidationFactor:', liquidationFactor.toString());
    console.log('BorrowCF value:', borrowCFValue.toString());
    console.log('LiquidationFactor value:', liquidationFactorValue.toString());
    console.log('LHF:', lhf.toString());
    console.log('Storefront coefficient:', storefrontCoefficient.toString());
    console.log('Target HF:', targetHF.toString());
    console.log('Target debt:', targetDebt.toString());
    console.log('Minimal debt:', minimalDebt.toString());
    console.log('Is partially liquidatable:', isPartiallyLiquidatable);
    console.log('Is bad debt:', isBadDebt);
    console.log('-------------------------------');

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
    });

    // Set debt: 3000 USDC
    const debtAmount = exp(3000, 6);
    await comet.setBasePrincipal(user.address, -debtAmount);
    
    // Set collateral: 2.5 WETH (worth 5000 USDC) - more collateral to ensure partial liquidation
    const assetInfo = await comet.getAssetInfo(0);
    await comet.setCollateralBalance(user.address, assetInfo.asset, exp(2.5, 18));
    await comet.updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(2.5, 18));

    const minimalDebt = await comet.getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await comet.isPartiallyLiquidatable(user.address);
    
    console.log('Low storefront coefficient test:');
    console.log('Storefront coefficient: 65%');
    console.log('Debt: 3000 USDC');
    console.log('Collateral: 2.5 WETH (5000 USDC)');
    console.log('Minimal debt:', minimalDebt.toString());
    console.log('Is partially liquidatable:', isPartiallyLiquidatable);

    expect(isPartiallyLiquidatable).to.be.true;
    expect(minimalDebt).to.be.gt(0);
  });

  it('returns true with low borrowCF and high liquidationFactor', async () => {
    const { comet, users: [user] } = await makeProtocol({
      storefrontCoefficient: factor(0.8),
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.5),      // 50% - очень низкий borrow CF
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.95), // 95% - высокий liquidation factor
          supplyCap: exp(100, 18),
        }
      }
    });

    // Set debt: 3500 USDC
    const debtAmount = exp(3500, 6);
    await comet.setBasePrincipal(user.address, -debtAmount);
    
    // Set collateral: 2.2 WETH (worth 4400 USDC)
    const assetInfo = await comet.getAssetInfo(0);
    await comet.setCollateralBalance(user.address, assetInfo.asset, exp(2.2, 18));
    await comet.updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(2.2, 18));

    const minimalDebt = await comet.getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await comet.isPartiallyLiquidatable(user.address);
    
    console.log('Low borrowCF test:');
    console.log('BorrowCF: 50%, LiquidationFactor: 95%');
    console.log('Debt: 3500 USDC');
    console.log('Collateral: 2.2 WETH (4400 USDC)');
    console.log('Minimal debt:', minimalDebt.toString());
    console.log('Is partially liquidatable:', isPartiallyLiquidatable);

    expect(isPartiallyLiquidatable).to.be.true;
    expect(minimalDebt).to.be.gt(0);
  });

  it('returns true with multiple collateral assets', async () => {
    const { comet, users: [user] } = await makeProtocol({
      storefrontCoefficient: factor(0.75), // 75% - more conservative
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.65),     // 65% - lower borrow CF
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        },
        WBTC: {
          decimals: 8,
          initialPrice: 40000,
          borrowCF: factor(0.6),      // 60% - even lower borrow CF
          liquidateCF: factor(0.8),
          liquidationFactor: factor(0.85),
          supplyCap: exp(100, 8),
        }
      }
    });

    // Set debt: 4000 USDC
    const debtAmount = exp(4000, 6);
    await comet.setBasePrincipal(user.address, -debtAmount);
    
    // Set multiple collateral: 1.5 WETH + 0.05 WBTC (more collateral)
    const wethInfo = await comet.getAssetInfo(0);
    const wbtcInfo = await comet.getAssetInfo(1);
    
    await comet.setCollateralBalance(user.address, wethInfo.asset, exp(1.5, 18));
    await comet.updateAssetsInExternal(user.address, wethInfo.asset, 0, exp(1.5, 18));
    
    await comet.setCollateralBalance(user.address, wbtcInfo.asset, exp(0.05, 8));
    await comet.updateAssetsInExternal(user.address, wbtcInfo.asset, 1, exp(0.05, 8));

    const minimalDebt = await comet.getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await comet.isPartiallyLiquidatable(user.address);
    
    console.log('Multiple collateral test:');
    console.log('Debt: 4000 USDC');
    console.log('Collateral: 1.5 WETH (3000 USDC) + 0.05 WBTC (2000 USDC)');
    console.log('Minimal debt:', minimalDebt.toString());
    console.log('Is partially liquidatable:', isPartiallyLiquidatable);

    expect(isPartiallyLiquidatable).to.be.true;
    expect(minimalDebt).to.be.gt(0);
  });

  it('returns true with very small debt that needs partial liquidation', async () => {
    const { comet, users: [user] } = await makeProtocol({
      storefrontCoefficient: factor(0.75), // 75% - более консервативный
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.6),      // 60% - ниже
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        }
      }
    });

    // Set small debt: 1200 USDC
    const debtAmount = exp(1200, 6);
    await comet.setBasePrincipal(user.address, -debtAmount);
    
    // Set small collateral: 0.7 WETH (worth 1400 USDC) - больше залога
    const assetInfo = await comet.getAssetInfo(0);
    await comet.setCollateralBalance(user.address, assetInfo.asset, exp(0.7, 18));
    await comet.updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(0.7, 18));

    const minimalDebt = await comet.getMinimalDebt(user.address);
    const isPartiallyLiquidatable = await comet.isPartiallyLiquidatable(user.address);
    
    console.log('Small debt test:');
    console.log('Debt: 1200 USDC');
    console.log('Collateral: 0.7 WETH (1400 USDC)');
    console.log('Minimal debt:', minimalDebt.toString());
    console.log('Is partially liquidatable:', isPartiallyLiquidatable);

    expect(isPartiallyLiquidatable).to.be.true;
    expect(minimalDebt).to.be.gt(0);
  });

  it('returns false when account has no debt', async () => {
    const { comet, users: [user] } = await makeProtocol();
    
    const isPartiallyLiquidatable = await comet.isPartiallyLiquidatable(user.address);
    
    expect(isPartiallyLiquidatable).to.be.false;
  });

  it('returns false when account has positive balance', async () => {
    const { comet, users: [user] } = await makeProtocol();
    
    // Set positive balance
    await comet.setBasePrincipal(user.address, exp(1000, 6));
    
    const isPartiallyLiquidatable = await comet.isPartiallyLiquidatable(user.address);
    
    expect(isPartiallyLiquidatable).to.be.false;
  });

  it('returns false when account is bad debt', async () => {
    const { comet, users: [user] } = await makeProtocol({
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        WETH: {
          decimals: 18,
          initialPrice: 2000,
          borrowCF: factor(0.8),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.5), // Very low liquidation factor
          supplyCap: exp(100, 18),
        }
      }
    });

    // Set large debt: 10000 USDC
    const debtAmount = exp(10000, 6);
    await comet.setBasePrincipal(user.address, -debtAmount);
    
    // Set small collateral: 1 WETH (worth 2000 USDC, LF value = 1000 USDC)
    const assetInfo = await comet.getAssetInfo(0);
    await comet.setCollateralBalance(user.address, assetInfo.asset, exp(1, 18));
    await comet.updateAssetsInExternal(user.address, assetInfo.asset, 0, exp(1, 18));

    const isBadDebt = await comet.isBadDebt(user.address);
    const isPartiallyLiquidatable = await comet.isPartiallyLiquidatable(user.address);
    
    console.log('Bad debt test:');
    console.log('Is bad debt:', isBadDebt);
    console.log('Is partially liquidatable:', isPartiallyLiquidatable);

    expect(isBadDebt).to.be.true;
    expect(isPartiallyLiquidatable).to.be.false;
  });
}); 