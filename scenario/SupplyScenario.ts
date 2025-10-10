import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { expectApproximately, expectBase, expectRevertCustom, expectRevertMatches, getExpectedBaseBalance, getInterest, isTriviallySourceable, isValidAssetIndex, MAX_ASSETS, UINT256_MAX } from './utils';
import { ContractReceipt } from 'ethers';
import { matchesDeployment } from './utils';
import { exp } from '../test/helpers';
import { ethers } from 'hardhat';
import { getConfigForScenario } from './utils/scenarioHelper';

const BASE_SUPPLY_AMOUNT = 100n;
const BASE_SUPPLY_WITH_FEES = 1000n;
const BASE_BORROW_WITH_FEES = -1000n;
const BASE_BORROW_REPAY_AMOUNT = -999n;
const BASE_BALANCE = 1010n;
const BASE_BALANCE_MAX  = 10n;
const BASE_SUPPLY_SMALL = 10n;
const BASE_SUPPLY_AFTER_FEES = 999n;

const USDT_FEE_BASIS_POINTS = 10;
const USDT_MAX_FEE = 10;
const USDT_REMAINING_DEBT = -1n;

const ETH_BALANCE_FOR_GAS = '100';
const INTEREST_TOLERANCE_SMALL = 1n;
const INTEREST_TOLERANCE_MEDIUM = 2n;
const INTEREST_TIME_FACTOR_SHORT = 1n;
const INTEREST_TIME_FACTOR_LONG = 4n;



const MIN_BORROW = '<= -1000';


async function testSupplyCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const comet = await context.getComet();
  const { albert } = await context.actors;
  const { asset: assetAddress, scale: scaleBN, supplyCap } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);
  const scale = scaleBN.toBigInt();
  const toSupply = BigInt(getConfigForScenario(context).supplyCollateral) * scale;

  expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(toSupply);

  await collateralAsset.approve(albert, comet.address);

  const totalCollateralSupply = (await comet.totalsCollateral(collateralAsset.address)).totalSupplyAsset.toBigInt();
  if (totalCollateralSupply + toSupply > supplyCap.toBigInt()) {
    await expectRevertCustom(
      albert.supplyAsset({
        asset: collateralAsset.address,
        amount: BigInt(getConfigForScenario(context).supplyCollateral) * scale,
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
  const comet = await context.getComet();
  const { albert, betty } = await context.actors;
  const { asset: assetAddress, scale: scaleBN, supplyCap } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);
  const scale = scaleBN.toBigInt();
  const toSupply = BigInt(getConfigForScenario(context).supplyCollateral) * scale;

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
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx).supplyCollateral),
      tokenBalances: async (ctx) =>  (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).supplyCollateral }
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
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, getConfigForScenario(ctx).supplyCollateral),
      tokenBalances: async (ctx) =>  (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).supplyCollateral }
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
    tokenBalances: {
      albert: { $base: 100 },
    },
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(BASE_SUPPLY_AMOUNT * scale);

    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: BASE_SUPPLY_AMOUNT * scale });

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance(BASE_SUPPLY_AMOUNT * scale, baseIndexScale, baseSupplyIndex);

    expect(await comet.balanceOf(albert.address)).to.be.equal(baseSupplied);

    return txn;
  }
);

scenario(
  'Comet#supply > base asset with token fees',
  {
    tokenBalances: {
      albert: { $base: 1000 },
    },
    filter: async (ctx) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }])
  },
  async ({ comet, actors }, context, world) => {
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      ethers.utils.hexStripZeros(ethers.utils.parseEther(ETH_BALANCE_FOR_GAS).toHexString()),
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress],
    });
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    await USDT.connect(USDTAdminSigner).setParams(USDT_FEE_BASIS_POINTS, USDT_MAX_FEE);

    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(BASE_SUPPLY_WITH_FEES * scale);

    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: BASE_SUPPLY_WITH_FEES * scale });

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance(BASE_SUPPLY_AFTER_FEES * scale, baseIndexScale, baseSupplyIndex);

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
          $base: ` ==${getConfigForScenario(ctx).liquidationBase}`
        }
      }),
    cometBalances: async (ctx) => ({
      albert: { $base: -getConfigForScenario(ctx).liquidationBase },
    }),
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(await albert.getCometBaseBalance(), -BigInt(getConfigForScenario(context).liquidationBase) * scale, getInterest(BigInt(getConfigForScenario(context).liquidationBase) * scale, borrowRate, INTEREST_TIME_FACTOR_SHORT) + INTEREST_TOLERANCE_SMALL);

    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: BigInt(getConfigForScenario(context).liquidationBase) * scale });

    expectApproximately(await albert.getCometBaseBalance(), 0n, getInterest(BigInt(getConfigForScenario(context).liquidationBase) * scale, borrowRate, INTEREST_TIME_FACTOR_LONG) + INTEREST_TOLERANCE_MEDIUM);

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
      ethers.utils.hexStripZeros(ethers.utils.parseEther(ETH_BALANCE_FOR_GAS).toHexString()),
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress],
    });
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    await USDT.connect(USDTAdminSigner).setParams(USDT_FEE_BASIS_POINTS, USDT_MAX_FEE);

    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(await albert.getCometBaseBalance(), BASE_BORROW_WITH_FEES * scale, getInterest(BASE_SUPPLY_WITH_FEES * scale, borrowRate, INTEREST_TIME_FACTOR_SHORT) + INTEREST_TOLERANCE_MEDIUM);

    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: BASE_SUPPLY_WITH_FEES * scale });

    expectApproximately(await albert.getCometBaseBalance(), USDT_REMAINING_DEBT * exp(1, 6), getInterest(BASE_SUPPLY_WITH_FEES * scale, borrowRate, INTEREST_TIME_FACTOR_LONG) + INTEREST_TOLERANCE_MEDIUM);

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
      ethers.utils.hexStripZeros(ethers.utils.parseEther(ETH_BALANCE_FOR_GAS).toHexString()),
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress],
    });
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    await USDT.connect(USDTAdminSigner).setParams(USDT_FEE_BASIS_POINTS, USDT_MAX_FEE);

    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(await albert.getCometBaseBalance(), BASE_BORROW_REPAY_AMOUNT * scale, getInterest(BASE_SUPPLY_AFTER_FEES * scale, borrowRate, INTEREST_TIME_FACTOR_LONG) + INTEREST_TOLERANCE_MEDIUM);

    await baseAsset.approve(albert, comet.address);
    const txn = await albert.supplyAsset({ asset: baseAsset.address, amount: BASE_SUPPLY_WITH_FEES * scale });

    expectApproximately(await albert.getCometBaseBalance(), 0n, getInterest(BASE_SUPPLY_WITH_FEES * scale, borrowRate, INTEREST_TIME_FACTOR_LONG) + INTEREST_TOLERANCE_MEDIUM);

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

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(BASE_SUPPLY_AMOUNT * scale);
    expect(await comet.balanceOf(betty.address)).to.be.equal(0n);

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);

    const txn = await betty.supplyAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: BASE_SUPPLY_AMOUNT * scale });

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance(BASE_SUPPLY_AMOUNT * scale, baseIndexScale, baseSupplyIndex);

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
      ethers.utils.hexStripZeros(ethers.utils.parseEther(ETH_BALANCE_FOR_GAS).toHexString()),
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress],
    });
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    await USDT.connect(USDTAdminSigner).setParams(USDT_FEE_BASIS_POINTS, USDT_MAX_FEE);

    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(BASE_SUPPLY_WITH_FEES * scale);
    expect(await comet.balanceOf(betty.address)).to.be.equal(0n);

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);

    const txn = await betty.supplyAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: BASE_SUPPLY_WITH_FEES * scale });

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance(BASE_SUPPLY_AFTER_FEES * scale, baseIndexScale, baseSupplyIndex);

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(betty.address)).to.be.equal(baseSupplied);

    return txn;
  }
);

scenario(
  'Comet#supplyFrom > repay borrow',
  {
    tokenBalances: {
      albert: { $base: BASE_BALANCE }
    },
    cometBalances: {
      betty: { $base: MIN_BORROW }
    },
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);

    const txn = await betty.supplyAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: UINT256_MAX });

    expect(await baseAsset.balanceOf(albert.address)).to.be.lessThan(BASE_BALANCE_MAX * scale);
    expectBase(await betty.getCometBaseBalance(), 0n);

    return txn;
  }
);

scenario(
  'Comet#supply reverts if not enough ERC20 approval',
  {
    tokenBalances: {
      albert: { $base: BASE_SUPPLY_AMOUNT },
    },
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await expect(
      albert.supplyAsset({
        asset: baseAsset.address,
        amount: BASE_SUPPLY_AMOUNT * scale,
      })
    ).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom reverts if not enough ERC20 base approval',
  {
    tokenBalances: {
      albert: { $base: BASE_SUPPLY_AMOUNT },
    },
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await albert.allow(betty, true);
    await baseAsset.approve(albert, betty, BASE_SUPPLY_SMALL * scale);

    await expect(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: BASE_SUPPLY_AMOUNT * scale,
      })
    ).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom reverts if not enough ERC20 collateral approval',
  {
    tokenBalances: {
      albert: { $asset0: BASE_SUPPLY_AMOUNT },
    },
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const symbol = await collateralAsset.token.symbol();
    const scale = scaleBN.toBigInt();

    await albert.allow(betty, true);
    await collateralAsset.approve(albert, betty, BASE_SUPPLY_SMALL * scale);

    await expectRevertMatches(
      betty.supplyAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: BASE_SUPPLY_AMOUNT * scale,
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
    tokenBalances: {
      albert: { $base: BASE_SUPPLY_SMALL },
    },
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
        amount: BASE_SUPPLY_AMOUNT * scale,
      })
    ).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom reverts if not enough ERC20 base balance',
  {
    tokenBalances: {
      albert: { $base: BASE_SUPPLY_SMALL },
    },
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
        amount: BASE_SUPPLY_AMOUNT * scale,
      })
    ).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom reverts if not enough ERC20 collateral balance',
  {
    tokenBalances: {
      albert: { $asset0: BASE_SUPPLY_SMALL },
    },
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
        amount: BASE_SUPPLY_AMOUNT * scale,
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
    tokenBalances: {
      albert: { $asset0: BASE_SUPPLY_AMOUNT },
    },
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
        amount: BASE_SUPPLY_AMOUNT * scale,
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
  async ({ comet, actors }) => {
    const { albert } = actors;

    const baseToken = await comet.baseToken();

    await expectRevertCustom(
      albert.supplyAsset({
        asset: baseToken,
        amount: BASE_SUPPLY_AMOUNT,
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
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, true);

    await expectRevertCustom(
      albert.supplyAssetFrom({
        src: betty.address,
        dst: albert.address,
        asset: baseToken,
        amount: BASE_SUPPLY_AMOUNT,
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