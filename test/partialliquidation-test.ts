import { expect, exp, factor, makeProtocol } from './helpers';

describe('Partial Liquidation: getLHF and getTargetHF', function () {
  it('no collateral, no debt', async () => {
    const { comet, users: [user] } = await makeProtocol();
    const lhf = await comet.getLHF(user.address);
    console.log('LHF:', lhf.toString());
    const targetHF = await comet.getTargetHF(user.address);
    console.log('No collateral, no debt LHF:', lhf.toString(), 'Target HF:', targetHF.toString());
    expect(lhf).to.equal(0);
    expect(targetHF).to.equal(0);
  });

  it('only collateral, no debt', async () => {
    const { comet, users: [user] } = await makeProtocol();
    await comet.setCollateralBalance(user.address, (await comet.getAssetInfo(0)).asset, exp(1, 18));
    const lhf = await comet.getLHF(user.address);
    console.log('LHF:', lhf.toString());
    const targetHF = await comet.getTargetHF(user.address);
    console.log('Only collateral LHF:', lhf.toString(), 'Target HF:', targetHF.toString());
    expect(lhf).to.equal(0);
    expect(targetHF).to.equal(0);
  });

  it('only debt, no collateral', async () => {
    const { comet, users: [user] } = await makeProtocol();
    await comet.setBasePrincipal(user.address, -exp(1000, 6));
    const lhf = await comet.getLHF(user.address);
    console.log('LHF:', lhf.toString());
    const targetHF = await comet.getTargetHF(user.address);
    console.log('Only debt LHF:', lhf.toString(), 'Target HF:', targetHF.toString());
    expect(lhf).to.equal(0);
    expect(targetHF).to.equal(0);
  });

  it('collateral and debt', async () => {
    const { comet, users: [user] } = await makeProtocol();
    await comet.setBasePrincipal(user.address, -exp(1000, 6));
    const assetInfo = await comet.getAssetInfo(0);
    await comet.setCollateralBalance(user.address, assetInfo.asset, exp(1, 18));
    const lhf = await comet.getLHF(user.address);
    const targetHF = await comet.getTargetHF(user.address);
    const principal = await comet.borrowBalanceOf(user.address);
    const price = await comet.getPrice(assetInfo.priceFeed);
    const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
    const scale = assetInfo.scale;
    const liquidationFactor = assetInfo.liquidateCollateralFactor;
    const balance = await comet.collateralBalanceOf(user.address, assetInfo.asset);
    const value = balance.mul(price).div(scale);
    const sumLCF = value.mul(liquidationFactor).div(factor(1));
    const debt = principal.mul(basePrice).div(await comet.baseScale());
    console.log('Principal (debt):', principal.toString());
    console.log('Base price:', basePrice.toString());
    console.log('Asset price:', price.toString());
    console.log('Asset scale:', scale.toString());
    console.log('Collateral balance:', balance.toString());
    console.log('Collateral value:', value.toString());
    console.log('Liquidation factor:', liquidationFactor.toString());
    console.log('sumLCF:', sumLCF.toString());
    console.log('Debt (normalized):', debt.toString());
    console.log('LHF:', lhf.toString());
    console.log('Target HF:', targetHF.toString());
    expect(lhf).to.be.gt(0);
    expect(targetHF).to.be.gt(0);
    expect(targetHF).to.be.lte(lhf);
  });

  it('multiple collaterals', async () => {
    const { comet, users: [user] } = await makeProtocol({
      assets: {
        USDC: {
          decimals: 6,
          initial: 1e6,
          initialPrice: 1,
          borrowCF: factor(0.8),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 6),
        },
        WETH: {
          decimals: 18,
          initial: 1e6,
          initialPrice: 2000,
          borrowCF: factor(0.8),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 18),
        },
        WBTC: {
          decimals: 8,
          initial: 1e6,
          initialPrice: 30000,
          borrowCF: factor(0.8),
          liquidateCF: factor(0.85),
          liquidationFactor: factor(0.9),
          supplyCap: exp(100, 8),
        }
      }
    });
    await comet.setBasePrincipal(user.address, -exp(1000, 6));
    await comet.setCollateralBalance(user.address, (await comet.getAssetInfo(0)).asset, exp(1, 18));
    await comet.setCollateralBalance(user.address, (await comet.getAssetInfo(1)).asset, exp(2, 8));
    const lhf = await comet.getLHF(user.address);
    const targetHF = await comet.getTargetHF(user.address);
    console.log('Multiple collaterals LHF:', lhf.toString(), 'Target HF:', targetHF.toString());
    expect(lhf).to.be.gt(0);
    expect(targetHF).to.be.gt(0);
    expect(targetHF).to.be.lte(lhf);
  });

  it('LHF and targetHF decrease as collateral decreases', async () => {
    const { comet, users: [user] } = await makeProtocol();
    await comet.setBasePrincipal(user.address, -exp(1000, 6));
    await comet.setCollateralBalance(user.address, (await comet.getAssetInfo(0)).asset, exp(1, 18));
    const lhfHigh = await comet.getLHF(user.address);
    console.log('LHF (high collateral):', lhfHigh.toString());
    const targetHFHigh = await comet.getTargetHF(user.address);
    await comet.setCollateralBalance(user.address, (await comet.getAssetInfo(0)).asset, exp(0.1, 18));
    const lhfLow = await comet.getLHF(user.address);
    console.log('LHF (low collateral):', lhfLow.toString());
    const targetHFLow = await comet.getTargetHF(user.address);
    console.log('High collateral LHF:', lhfHigh.toString(), 'Target HF:', targetHFHigh.toString());
    console.log('Low collateral LHF:', lhfLow.toString(), 'Target HF:', targetHFLow.toString());
    // Collateral decreases: LHF/targetHF should increase
    expect(lhfLow).to.be.lt(lhfHigh);
    expect(targetHFLow).to.be.lt(targetHFHigh);
  });

  it('LHF and targetHF decrease as debt increases', async () => {
    const { comet, users: [user] } = await makeProtocol();
    await comet.setCollateralBalance(user.address, (await comet.getAssetInfo(0)).asset, exp(1, 18));
    await comet.setBasePrincipal(user.address, -exp(100, 6));
    const lhfLowDebt = await comet.getLHF(user.address);
    console.log('LHF (low debt):', lhfLowDebt.toString());
    const targetHFLowDebt = await comet.getTargetHF(user.address);
    await comet.setBasePrincipal(user.address, -exp(1000, 6));
    const lhfHighDebt = await comet.getLHF(user.address);
    console.log('LHF (high debt):', lhfHighDebt.toString());
    const targetHFHighDebt = await comet.getTargetHF(user.address);
    console.log('Low debt LHF:', lhfLowDebt.toString(), 'Target HF:', targetHFLowDebt.toString());
    console.log('High debt LHF:', lhfHighDebt.toString(), 'Target HF:', targetHFHighDebt.toString());
    // Debt increases: LHF/targetHF should increase
    expect(lhfHighDebt).to.be.lt(lhfLowDebt);
    expect(targetHFHighDebt).to.be.lt(targetHFLowDebt);
  });
});