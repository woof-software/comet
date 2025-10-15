import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { expectApproximately, expectBase, expectRevertCustom, expectRevertMatches, getExpectedBaseBalance, getInterest, isTriviallySourceable, isValidAssetIndex, MAX_ASSETS, UINT256_MAX } from './utils';
import { ContractReceipt } from 'ethers';
import { matchesDeployment } from './utils';
import { ethers } from 'hardhat';
import { getConfigForScenario } from './utils/scenarioHelper';
import { exp } from 'test/helpers';

async function testSupplyCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const config = getConfigForScenario(context);
  const comet = await context.getComet();
  const { albert } = await context.actors;
  const { asset: assetAddress, scale: scaleBN, supplyCap } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);
  const scale = scaleBN.toBigInt();
  const toSupply = BigInt(config.supply.collateralAmount) * scale;
  expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(toSupply);
  await collateralAsset.approve(albert, comet.address);
  const totalCollateralSupply = (await comet.totalsCollateral(collateralAsset.address)).totalSupplyAsset.toBigInt();
  if (totalCollateralSupply + toSupply > supplyCap.toBigInt()) {
    await expectRevertCustom(
      albert.supplyAsset({
        asset: collateralAsset.address,
        amount: BigInt(config.supply.collateralAmount) * scale,
      }),
      'SupplyCapExceeded()'
    );
  } else {
    const txn = await albert.supplyAsset({ asset: collateralAsset.address, amount: toSupply });
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(toSupply);
    return txn;
  }
}

async function testSupplyFromCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const config = getConfigForScenario(context);
  const comet = await context.getComet();
  const { albert, betty } = await context.actors;
  const { asset: assetAddress, scale: scaleBN, supplyCap } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);
  const scale = scaleBN.toBigInt();
  const toSupply = BigInt(config.supply.collateralAmount) * scale;
  expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(toSupply);
  expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(0n);
  await collateralAsset.approve(albert, comet.address);
  await albert.allow(betty, true);
  const totalCollateralSupply = (await comet.totalsCollateral(collateralAsset.address)).totalSupplyAsset.toBigInt();
  if (totalCollateralSupply + toSupply > supplyCap.toBigInt()) {
    await expectRevertCustom(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: toSupply,
      }),
      'SupplyCapExceeded()'
    );
  } else {
    const txn = await betty.supplyAssetFrom({ src: albert.address, dst: betty.address, asset: collateralAsset.address, amount: toSupply });
    expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(toSupply);
    return txn;
  }
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#supply > collateral asset ${i}`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx).supply.collateralAmount),
      tokenBalances: async (ctx) => (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).supply.collateralAmount }
        }
      ),
    },
    async (_properties, context) => {
      return await testSupplyCollateral(context, i);
    }
  );
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#supplyFrom > collateral asset ${i}`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx).supply.collateralAmount),
      tokenBalances: async (ctx) => (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).supply.collateralAmount }
        }
      ),
    },
    async (_properties, context) => {
      return await testSupplyFromCollateral(context, i);
    }
  );
}

scenario(
  'Comet#supply > base asset',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supplyScenario.baseSupplyAmount }
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(config.supplyScenario.baseSupplyAmount * scale);

    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: config.supplyScenario.baseSupplyAmount * scale });

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance(config.supplyScenario.baseSupplyAmount * scale, baseIndexScale, baseSupplyIndex);

    expect(await comet.balanceOf(albert.address)).to.be.equal(baseSupplied);

    return txn;
  }
);

scenario(
  'Comet#supply > base asset with token fees',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supplyScenario.baseSupplyWithFees },
    }),
    filter: async (ctx) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }])
  },
  async ({ comet, actors }, context, world) => {
    const config = getConfigForScenario(context);
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      ethers.utils.hexStripZeros(ethers.utils.parseEther(config.supplyScenario.ethBalanceForGas).toHexString()),
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress],
    });
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    await USDT.connect(USDTAdminSigner).setParams(config.supplyScenario.usdtFeeBasisPoints, config.supplyScenario.usdtMaxFee);

    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(config.supplyScenario.baseSupplyWithFees * scale);

    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: config.supplyScenario.baseSupplyWithFees * scale });

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance(config.supplyScenario.baseSupplyAfterFees * scale, baseIndexScale, baseSupplyIndex);

    expect(await comet.balanceOf(albert.address)).to.be.equal(baseSupplied);

    return txn;
  }
);

scenario(
  'Comet#supply > repay borrow',
  {
    tokenBalances: async (ctx) => (
      {
        albert: {
          $base: `== ${getConfigForScenario(ctx).liquidation.standardBase}`
        }
      }),
    cometBalances: async (ctx) => ({
      albert: { $base: -getConfigForScenario(ctx).liquidation.standardBase },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();
    expectApproximately(await albert.getCometBaseBalance(), -BigInt(config.liquidation.standardBase) * scale, getInterest(BigInt(config.liquidation.standardBase) * scale, borrowRate, config.supplyScenario.interestTimeFactorShort) + config.supplyScenario.interestToleranceSmall);
    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: BigInt(config.liquidation.standardBase) * scale });
    expectApproximately(await albert.getCometBaseBalance(), 0n, getInterest(BigInt(config.liquidation.standardBase) * scale, borrowRate, config.supplyScenario.interestTimeFactorLong) + config.supplyScenario.interestToleranceMedium);
    return txn;
  }
);

scenario(
  'Comet#supply > repay borrow with token fees',
  {
    tokenBalances: {
      albert: { $base: '==1000' }
    },
    cometBalances: {
      albert: { $base: -1000 }
    },
    filter: async (ctx) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }]),
  },
  async ({ comet, actors }, context, world) => {
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      ethers.utils.hexStripZeros(ethers.utils.parseEther(getConfigForScenario(context).supplyScenario.ethBalanceForGas).toHexString()),
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress],
    });
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    await USDT.connect(USDTAdminSigner).setParams(getConfigForScenario(context).supplyScenario.usdtFeeBasisPoints, getConfigForScenario(context).supplyScenario.usdtMaxFee);

    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(await albert.getCometBaseBalance(), getConfigForScenario(context).supplyScenario.baseBorrowWithFees * scale, getInterest(getConfigForScenario(context).supplyScenario.baseSupplyWithFees * scale, borrowRate, getConfigForScenario(context).supplyScenario.interestTimeFactorShort) + getConfigForScenario(context).supplyScenario.interestToleranceMedium);

    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: getConfigForScenario(context).supplyScenario.baseSupplyWithFees * scale });

    expectApproximately(await albert.getCometBaseBalance(), getConfigForScenario(context).supplyScenario.usdtRemainingDebt * exp(1, 6), getInterest(getConfigForScenario(context).supplyScenario.baseSupplyWithFees * scale, borrowRate, getConfigForScenario(context).supplyScenario.interestTimeFactorLong) + getConfigForScenario(context).supplyScenario.interestToleranceMedium);

    return txn;
  }
);

scenario(
  'Comet#supply > repay all borrow with token fees',
  {
    tokenBalances: {
      albert: { $base: '==1000' }
    },
    cometBalances: {
      albert: { $base: -999 }
    },
    filter: async (ctx) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }]),
  },
  async ({ comet, actors }, context, world) => {
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      ethers.utils.hexStripZeros(ethers.utils.parseEther(getConfigForScenario(context).supplyScenario.ethBalanceForGas).toHexString()),
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress],
    });
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    await USDT.connect(USDTAdminSigner).setParams(getConfigForScenario(context).supplyScenario.usdtFeeBasisPoints, getConfigForScenario(context).supplyScenario.usdtMaxFee);

    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(await albert.getCometBaseBalance(), getConfigForScenario(context).supplyScenario.baseBorrowRepayAmount
     * scale, getInterest(getConfigForScenario(context).supplyScenario.baseSupplyAfterFees * scale, borrowRate, getConfigForScenario(context).supplyScenario.interestTimeFactorLong) + getConfigForScenario(context).supplyScenario.interestToleranceMedium);

    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: getConfigForScenario(context).supplyScenario.baseSupplyWithFees * scale });

    expectApproximately(await albert.getCometBaseBalance(), 0n, getInterest(getConfigForScenario(context).supplyScenario.baseSupplyWithFees * scale, borrowRate, getConfigForScenario(context).supplyScenario.interestTimeFactorLong) + getConfigForScenario(context).supplyScenario.interestToleranceMedium);

    return txn;
  }
);

scenario(
  'Comet#supplyFrom > base asset',
  {
    tokenBalances: {
      albert: { $base: 100 },
    },
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(getConfigForScenario(context).supplyScenario.baseSupplyAmount * scale);
    expect(await comet.balanceOf(betty.address)).to.be.equal(0n);

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);

    const txn = await betty.supplyAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: getConfigForScenario(context).supplyScenario.baseSupplySmall * scale });

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance(getConfigForScenario(context).supplyScenario.baseSupplyAmount * scale, baseIndexScale, baseSupplyIndex);

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(betty.address)).to.be.equal(baseSupplied);

    return txn;
  }
);

scenario(
  'Comet#supplyFrom > base asset with token fees',
  {
    tokenBalances: {
      albert: { $base: 1000 },
    },
    filter: async (ctx) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }]),
  },
  async ({ comet, actors }, context, world) => {
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      ethers.utils.hexStripZeros(ethers.utils.parseEther(getConfigForScenario(context).supplyScenario.ethBalanceForGas).toHexString()),
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress],
    });
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    await USDT.connect(USDTAdminSigner).setParams(getConfigForScenario(context).supplyScenario.usdtFeeBasisPoints, getConfigForScenario(context).supplyScenario.usdtMaxFee);

    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(getConfigForScenario(context).supplyScenario.baseSupplyWithFees * scale);
    expect(await comet.balanceOf(betty.address)).to.be.equal(0n);

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);

    const txn = await betty.supplyAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: getConfigForScenario(context).supplyScenario.baseSupplyWithFees * scale });

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance(getConfigForScenario(context).supplyScenario.baseSupplyWithFees  * scale, baseIndexScale, baseSupplyIndex);

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(betty.address)).to.be.equal(baseSupplied);

    return txn;
  }
);

scenario(
  'Comet#supplyFrom > repay borrow',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supplyScenario.baseBalance }
    }), 
    cometBalances: async (ctx) => ({
      albert: { $base: -getConfigForScenario(ctx).supplyScenario.minBorrow }
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);

    const txn = await betty.supplyAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: UINT256_MAX });

    expect(await baseAsset.balanceOf(albert.address)).to.be.lessThan(getConfigForScenario(context).supplyScenario.baseBalance * scale);
    expectBase(await betty.getCometBaseBalance(), 0n);

    return txn;
  }
);

scenario(
  'Comet#supply reverts if not enough ERC20 approval',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supplyScenario.baseSupplyAmount }
    })
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await expect(
      albert.supplyAsset({
        asset: baseAsset.address,
        amount: getConfigForScenario(context).supplyScenario.baseSupplyAmount * scale,
      })
    ).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom reverts if not enough ERC20 base approval',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supplyScenario.baseSupplyAmount}
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await albert.allow(betty, true);
    await baseAsset.approve(albert, betty, getConfigForScenario(context).supplyScenario.baseSupplySmall * scale);

    await expect(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: getConfigForScenario(context).supplyScenario.baseSupplyAmount * scale,
      })
    ).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom reverts if not enough ERC20 collateral approval',
  {
    tokenBalances: async (ctx) => ({
      albert: { $asset0: getConfigForScenario(ctx).supplyScenario.baseSupplyAmount }
    }),
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const symbol = await collateralAsset.token.symbol();
    const scale = scaleBN.toBigInt();

    await albert.allow(betty, true);
    await collateralAsset.approve(albert, betty, getConfigForScenario(context).supplyScenario.baseSupplySmall * scale);

    await expectRevertMatches(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: getConfigForScenario(context).supplyScenario.baseSupplyAmount * scale,
      }),
      [
        /ERC20: transfer amount exceeds allowance/,
        /ERC20: insufficient allowance/,
        /transfer amount exceeds spender allowance/,
        /Dai\/insufficient-allowance/,
        symbol === 'WETH' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'WRON' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'wstETH' ? /0xc2139725/ : /.^/,
        symbol === 'LBTC' ? /0xfb8f41b2/ : /.^/,
        symbol === 'WMATIC' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'WPOL' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'sUSDS' ? /SUsds\/insufficient-allowance/ : /.^/,
        symbol === 'USDC' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'GOLD' ? /Transaction reverted and Hardhat couldn't infer the reason./ : /.^/,
      ]
    );
  }
);

scenario(
  'Comet#supply reverts if not enough ERC20 balance',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supplyScenario.baseSupplySmall }
    }),
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await expect(
      albert.supplyAsset({
        asset: baseAsset.address,
        amount: getConfigForScenario(context).supplyScenario.baseSupplyAmount * scale,
      })
    ).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom reverts if not enough ERC20 base balance',
  {
    tokenBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).supplyScenario.baseSupplySmall }
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);
    await expect(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: getConfigForScenario(context).supplyScenario.baseSupplyAmount * scale,
      })
    ).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom reverts if not enough ERC20 collateral balance',
  {
    tokenBalances: async (ctx) => ({
      albert: { $asset0: getConfigForScenario(ctx).supplyScenario.baseSupplySmall }
    }),
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const symbol = await collateralAsset.token.symbol();
    const scale = scaleBN.toBigInt();

    await collateralAsset.approve(albert, comet.address);
    await albert.allow(betty, true);

    await expectRevertMatches(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: getConfigForScenario(context).supplyScenario.baseSupplyAmount * scale,
      }),
      [
        /transfer amount exceeds balance/,
        /Dai\/insufficient-balance/,
        symbol === 'WRON' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'WETH' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'wstETH' ? /0x00b284f2/ : /.^/,
        symbol === 'LBTC' ? /0xe450d38c/ : /.^/,
        symbol === 'WMATIC' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'WPOL' ? /Transaction reverted without a reason string/ : /.^/,
        symbol === 'sUSDS' ? /SUsds\/insufficient-balance/ : /.^/,
        symbol === 'USDC' ? /Transaction reverted without a reason string/ : /.^/,
      ]
    );
  }
);

scenario(
  'Comet#supplyFrom reverts if operator not given permission',
  {
    tokenBalances: async(ctx) => ({
      albert: { $asset0: getConfigForScenario(ctx).supplyScenario.baseSupplyAmount }
    }),
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await expectRevertCustom(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: getConfigForScenario(context).supplyScenario.baseSupplyAmount * scale,
      }),
      'Unauthorized()'
    );
  }
);

scenario(
  'Comet#supply reverts when supply is paused',
  {
    pause: {
      supplyPaused: true,
    },
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;

    const baseToken = await comet.baseToken();

    await expectRevertCustom(
      albert.supplyAsset({
        asset: baseToken,
        amount: getConfigForScenario(context).supplyScenario.baseSupplyAmount,
      }),
      'Paused()'
    );
  }
);

scenario(
  'Comet#supplyFrom reverts when supply is paused',
  {
    pause: {
      supplyPaused: true,
    },
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, true);

    await expectRevertCustom(
      albert.supplyAssetFrom({
        src: betty.address,
        dst: albert.address,
        asset: baseToken,
        amount: getConfigForScenario(context).supplyScenario.baseSupplyAmount,
      }),
      'Paused()'
    );
  }
);

scenario(
  'Comet#supply reverts if asset is not supported',
  {},
  async () => {
    // XXX requires deploying an unsupported asset (maybe via remote token constraint)
  }
);