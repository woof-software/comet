import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import {
  expectApproximately,
  expectBase,
  expectRevertCustom,
  expectRevertMatches,
  getExpectedBaseBalance,
  getInterest,
  isTriviallySourceable,
  isValidAssetIndex,
  MAX_ASSETS,
  UINT256_MAX,
  fundAccount,
  usesAssetList,
  isAssetDelisted,
  supportsExtendedPause
} from './utils';
import { matchesDeployment } from './utils';
import { exp } from '../test/helpers';
import { ethers } from 'hardhat';
import { getConfigForScenario } from './utils/scenarioHelper';
import { log } from 'console';
import { MockERC20 } from '../build/types';

async function getSupplyCapExceedingAmount(ctx: CometContext, assetIndex: number): Promise<number> {
  const comet = await ctx.getComet();
  const assetInfo = await comet.getAssetInfo(assetIndex);

  const supplyCap = assetInfo.supplyCap.toBigInt();
  const scale = assetInfo.scale.toBigInt();
  const { totalSupplyAsset } = await comet.totalsCollateral(assetInfo.asset);

  const remainingWei = supplyCap - totalSupplyAsset.toBigInt();

  return Number(remainingWei / scale) + 1;
}

async function deployMockERC20(context: CometContext, alias: string, force?: boolean): Promise<MockERC20> {
  const dm = context.world.deploymentManager;

  const mockERC20 = (await dm.deploy(
    `mockERC20:${alias}`,
    'capo/contracts/test/MockERC20.sol',
    ['Mock Token', 'MOCK', 18],
    force
  )) as MockERC20;

  return mockERC20;
}

for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#supply > collateral asset ${offset}`,
    {
      // XXX Unfortunately, the filtering step happens before solutions are run, so this will filter out
      // hypothetical assets added during the migration/proposal constraint because those assets don't exist
      // yet
      filter: async (ctx: CometContext) =>
        (await isValidAssetIndex(ctx, offset)) &&
        (await isTriviallySourceable(ctx, offset, getConfigForScenario(ctx, offset).supplyCollateral)),
      tokenBalances: (ctx: CometContext) => ({
        albert: { [`$asset${offset}`]: getConfigForScenario(ctx, offset).supplyCollateral }
      })
    },
    async ({ comet, actors }, context) => {
      const { albert } = actors;
      const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(offset);
      const collateralAsset = context.getAssetByAddress(assetAddress);
      const amountToSupply = BigInt(getConfigForScenario(context, offset).supplyCollateral) * scaleBN.toBigInt();

      await collateralAsset.approve(albert, comet.address);
      // save balances before the supply for later comparison
      const userAssetBalanceBefore = await collateralAsset.balanceOf(albert.address);
      const userCollateralBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);

      const txn = await comet
        .connect(albert.signer)
        .supply(collateralAsset.address, amountToSupply)
        .then((tx) => tx.wait());

      // should change asset balance of user
      expect(await collateralAsset.balanceOf(albert.address)).to.not.equal(userAssetBalanceBefore);
      const collateralBalanceAfter = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      // should change collateral balance of user
      expect(collateralBalanceAfter).to.not.equal(userCollateralBalanceBefore);
      expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.equal(amountToSupply);

      return txn; // return txn to measure gas
    }
  );
}

for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#supplyTo > collateral asset ${offset}`,
    {
      filter: async (ctx: CometContext) =>
        (await isValidAssetIndex(ctx, offset)) &&
        (await isTriviallySourceable(ctx, offset, getConfigForScenario(ctx, offset).supplyCollateral)),
      tokenBalances: (ctx: CometContext) => ({
        albert: { [`$asset${offset}`]: getConfigForScenario(ctx, offset).supplyCollateral }
      })
    },
    async ({ comet, actors }, context) => {
      const { albert, betty } = actors;
      const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(offset);
      const collateralAsset = context.getAssetByAddress(assetAddress);
      const amountToSupply = BigInt(getConfigForScenario(context, offset).supplyCollateral) * scaleBN.toBigInt();

      await collateralAsset.approve(albert, comet.address);
      // save balances before the supply for later comparison
      const fromUserAssetBalanceBefore = await collateralAsset.balanceOf(albert.address);
      const fromUserCollateralBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const dstUserAssetBalanceBefore = await collateralAsset.balanceOf(betty.address);
      const dstUserCollateralBalanceBefore = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      const txn = await comet
        .connect(albert.signer)
        .supplyTo(betty.address, collateralAsset.address, amountToSupply)
        .then((tx) => tx.wait());

      // should change asset balance of from user
      expect(await collateralAsset.balanceOf(albert.address)).to.not.equal(fromUserAssetBalanceBefore);
      // shouldn't change collateral balance of from user
      expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.equal(
        fromUserCollateralBalanceBefore
      );
      // shouldn't change asset balance of dst user
      expect(await collateralAsset.balanceOf(betty.address)).to.equal(dstUserAssetBalanceBefore);
      const dstCollateralBalanceAfter = await comet.collateralBalanceOf(betty.address, collateralAsset.address);
      // should change collateral balance of dst user
      expect(dstCollateralBalanceAfter).to.not.equal(dstUserCollateralBalanceBefore);
      expect(dstCollateralBalanceAfter).to.equal(amountToSupply);

      return txn; // return txn to measure gas
    }
  );
}

for (let offset = 0; offset < MAX_ASSETS; offset++) {
  scenario(
    `Comet#supplyFrom > collateral asset ${offset}`,
    {
      filter: async (ctx: CometContext) =>
        (await isValidAssetIndex(ctx, offset)) &&
        (await isTriviallySourceable(ctx, offset, getConfigForScenario(ctx, offset).supplyCollateral)),
      tokenBalances: (ctx: CometContext) => ({
        albert: { [`$asset${offset}`]: getConfigForScenario(ctx, offset).supplyCollateral }
      })
    },
    async ({ comet, actors }, context) => {
      const { albert, betty } = actors;
      const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(offset);
      const collateralAsset = context.getAssetByAddress(assetAddress);
      const amountToSupply = BigInt(getConfigForScenario(context, offset).supplyCollateral) * scaleBN.toBigInt();

      await collateralAsset.approve(albert, comet.address);
      await comet.connect(albert.signer).allow(betty.address, true);
      // save balances before the supply for later comparison
      const fromUserAssetBalanceBefore = await collateralAsset.balanceOf(albert.address);
      const fromUserCollateralBalanceBefore = await comet.collateralBalanceOf(albert.address, collateralAsset.address);
      const dstUserAssetBalanceBefore = await collateralAsset.balanceOf(betty.address);
      const dstUserCollateralBalanceBefore = await comet.collateralBalanceOf(betty.address, collateralAsset.address);

      const txn = await comet
        .connect(betty.signer)
        .supplyFrom(albert.address, betty.address, collateralAsset.address, amountToSupply)
        .then((tx) => tx.wait());

      // should change asset balance of from user
      expect(await collateralAsset.balanceOf(albert.address)).to.not.equal(fromUserAssetBalanceBefore);
      // shouldn't change collateral balance of from user
      expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.equal(
        fromUserCollateralBalanceBefore
      );
      // shouldn't change asset balance of dst user
      expect(await collateralAsset.balanceOf(betty.address)).to.equal(dstUserAssetBalanceBefore);
      const dstCollateralBalanceAfter = await comet.collateralBalanceOf(betty.address, collateralAsset.address);
      // should change collateral balance of dst user
      expect(dstCollateralBalanceAfter).to.not.equal(dstUserCollateralBalanceBefore);
      expect(dstCollateralBalanceAfter).to.equal(amountToSupply);

      return txn; // return txn to measure gas
    }
  );
}

scenario(
  'Comet#supply > base asset',
  {
    tokenBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).supplyBase } // in units of asset, not wei
    })
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const amountToSupply = BigInt(getConfigForScenario(context).supplyBase) * (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    // save balances before the supply for later comparison
    const userAssetBalanceBefore = await baseAsset.balanceOf(albert.address);
    const userBaseBalanceBefore = await comet.balanceOf(albert.address);

    const txn = await comet
      .connect(albert.signer)
      .supply(baseAsset.address, amountToSupply)
      .then((tx) => tx.wait());

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const expectedBaseBalance = getExpectedBaseBalance(amountToSupply, baseIndexScale, baseSupplyIndex);
    // should change asset balance of user
    expect(await baseAsset.balanceOf(albert.address)).to.not.equal(userAssetBalanceBefore);
    const baseBalanceAfter = await comet.balanceOf(albert.address);
    // should change base balance of user
    expect(baseBalanceAfter).to.not.equal(userBaseBalanceBefore);
    expect(baseBalanceAfter).to.equal(expectedBaseBalance);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#supplyTo > base asset',
  {
    tokenBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).supplyBase } // in units of asset, not wei
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const amountToSupply = BigInt(getConfigForScenario(context).supplyBase) * (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    // save balances before the supply for later comparison
    const fromUserAssetBalanceBefore = await baseAsset.balanceOf(albert.address);
    const fromUserBaseBalanceBefore = await comet.balanceOf(albert.address);
    const dstUserAssetBalanceBefore = await baseAsset.balanceOf(betty.address);
    const dstUserBaseBalanceBefore = await comet.balanceOf(betty.address);

    const txn = await comet
      .connect(albert.signer)
      .supplyTo(betty.address, baseAsset.address, amountToSupply)
      .then((tx) => tx.wait());

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const expectedBaseBalance = getExpectedBaseBalance(amountToSupply, baseIndexScale, baseSupplyIndex);
    // should change asset balance of user
    expect(await baseAsset.balanceOf(albert.address)).to.not.equal(fromUserAssetBalanceBefore);
    // shouldn't change base balance of from user
    expect(await comet.balanceOf(albert.address)).to.equal(fromUserBaseBalanceBefore);
    // shouldn't change asset balance of dst user
    expect(await baseAsset.balanceOf(betty.address)).to.equal(dstUserAssetBalanceBefore);
    const dstBaseBalanceAfter = await comet.balanceOf(betty.address);
    // should change base balance of dst user
    expect(dstBaseBalanceAfter).to.not.equal(dstUserBaseBalanceBefore);
    expect(dstBaseBalanceAfter).to.equal(expectedBaseBalance);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#supplyFrom > base asset',
  {
    tokenBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).supplyBase } // in units of asset, not wei
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const amountToSupply = BigInt(getConfigForScenario(context).supplyBase) * (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);

    // save balances before the supply for later comparison
    const fromUserAssetBalanceBefore = await baseAsset.balanceOf(albert.address);
    const fromUserBaseBalanceBefore = await comet.balanceOf(albert.address);
    const dstUserAssetBalanceBefore = await baseAsset.balanceOf(betty.address);
    const dstUserBaseBalanceBefore = await comet.balanceOf(betty.address);

    // Betty supplies 100 units of base from Albert
    const txn = await comet
      .connect(betty.signer)
      .supplyFrom(albert.address, betty.address, baseAsset.address, amountToSupply)
      .then((tx) => tx.wait());

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const expectedBaseBalance = getExpectedBaseBalance(amountToSupply, baseIndexScale, baseSupplyIndex);

    // should change asset balance of from user
    expect(await baseAsset.balanceOf(albert.address)).to.not.equal(fromUserAssetBalanceBefore);
    // shouldn't change base balance of from user
    expect(await comet.balanceOf(albert.address)).to.equal(fromUserBaseBalanceBefore);
    // shouldn't change asset balance of dst user
    expect(await baseAsset.balanceOf(betty.address)).to.equal(dstUserAssetBalanceBefore);
    const dstBaseBalanceAfter = await comet.balanceOf(betty.address);
    // should change base balance of dst user
    expect(dstBaseBalanceAfter).to.not.equal(dstUserBaseBalanceBefore);
    expect(dstBaseBalanceAfter).to.equal(expectedBaseBalance);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#supply > base asset with token fees',
  {
    tokenBalances: {
      albert: { $base: 1000 } // in units of asset, not wei
    },
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }])
  },
  async ({ comet, actors }, context, world) => {
    // Set fees for USDT for testing
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      ethers.utils.hexStripZeros(ethers.utils.parseEther('100').toHexString())
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress]
    });
    // mine a block to ensure the impersonation is effective
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    // 10 basis points, and max 10 USDT
    await USDT.connect(USDTAdminSigner).setParams(10, 10);

    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(1000n * scale);

    // Albert supplies 1000 units of base to Comet
    await baseAsset.approve(albert, comet.address);
    const txn = await comet
      .connect(albert.signer)
      .supply(baseAsset.address, 1000n * scale)
      .then((tx) => tx.wait());

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance(999n * scale, baseIndexScale, baseSupplyIndex);

    expect(await comet.balanceOf(albert.address)).to.be.equal(baseSupplied);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#supplyFrom > base asset with token fees',
  {
    tokenBalances: {
      albert: { $base: 1000 } // in units of asset, not wei
    },
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }])
  },
  async ({ comet, actors }, context, world) => {
    // Set fees for USDT for testing
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      ethers.utils.hexStripZeros(ethers.utils.parseEther('100').toHexString())
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress]
    });
    // mine a block to ensure the impersonation is effective
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    // 10 basis points, and max 10 USDT
    await USDT.connect(USDTAdminSigner).setParams(10, 10);

    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(1000n * scale);
    expect(await comet.balanceOf(betty.address)).to.be.equal(0n);

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);

    // Betty supplies 1000 units of base from Albert
    const txn = await comet
      .connect(betty.signer)
      .supplyFrom(albert.address, betty.address, baseAsset.address, 1000n * scale)
      .then((tx) => tx.wait());

    const baseIndexScale = (await comet.baseIndexScale()).toBigInt();
    const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex.toBigInt();
    const baseSupplied = getExpectedBaseBalance(999n * scale, baseIndexScale, baseSupplyIndex);

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.balanceOf(betty.address)).to.be.equal(baseSupplied);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#supply > repay borrow',
  {
    tokenBalances: (ctx: CometContext) => ({
      albert: {
        $base: ` ==${getConfigForScenario(ctx).liquidationBase}`
      }
    }),
    cometBalances: async (ctx: CometContext) => ({
      albert: { $base: -getConfigForScenario(ctx).liquidationBase }
    })
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(
      await albert.getCometBaseBalance(),
      -BigInt(getConfigForScenario(context).liquidationBase) * scale,
      getInterest(BigInt(getConfigForScenario(context).liquidationBase) * scale, borrowRate, 1n) + 1n
    );

    // Albert repays 100 units of base borrow
    await baseAsset.approve(albert, comet.address);
    const txn = await comet
      .connect(albert.signer)
      .supply(baseAsset.address, BigInt(getConfigForScenario(context).liquidationBase) * scale)
      .then((tx) => tx.wait());

    // XXX all these timings are crazy
    expectApproximately(
      await albert.getCometBaseBalance(),
      0n,
      getInterest(BigInt(getConfigForScenario(context).liquidationBase) * scale, borrowRate, 4n) + 2n
    );

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#supplyFrom > repay borrow',
  {
    tokenBalances: (ctx: CometContext) => ({
      albert: {
        $base: getConfigForScenario(ctx).supplyBase + 0.01 * getConfigForScenario(ctx).supplyBase
      }
    }),
    cometBalances: async (ctx: CometContext) => ({
      betty: {
        $base: `<= -${getConfigForScenario(ctx).supplyBase}`
      }
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);

    // Betty supplies max base from Albert to repay all borrows
    const txn = await comet
      .connect(betty.signer)
      .supplyFrom(albert.address, betty.address, baseAsset.address, UINT256_MAX)
      .then((tx) => tx.wait());

    expect(await baseAsset.balanceOf(albert.address)).to.be.lessThan(10n * scale);
    expectBase(await betty.getCometBaseBalance(), 0n);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#supply > repay borrow with token fees',
  {
    tokenBalances: {
      albert: { $base: '==1000' }
    },
    cometBalances: {
      albert: { $base: -1000 } // in units of asset, not wei
    },
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }])
  },
  async ({ comet, actors }, context, world) => {
    // Set fees for USDT for testing
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      ethers.utils.hexStripZeros(ethers.utils.parseEther('100').toHexString())
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress]
    });
    // mine a block to ensure the impersonation is effective
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    // 10 basis points, and max 10 USDT
    await USDT.connect(USDTAdminSigner).setParams(10, 10);

    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(
      await albert.getCometBaseBalance(),
      -1000n * scale,
      getInterest(1000n * scale, borrowRate, 1n) + 2n
    );

    // Albert repays 1000 units of base borrow
    await baseAsset.approve(albert, comet.address);
    const txn = await comet
      .connect(albert.signer)
      .supply(baseAsset.address, 1000n * scale)
      .then((tx) => tx.wait());

    // XXX all these timings are crazy
    // Expect to have -1000000, due to token fee, alber only repay 999 USDT instead of 1000 USDT, thus alber still owe 1 USDT which is 1000000
    expectApproximately(
      await albert.getCometBaseBalance(),
      -1n * exp(1, 6),
      getInterest(1000n * scale, borrowRate, 4n) + 2n
    );

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#supply > repay all borrow with token fees',
  {
    tokenBalances: {
      albert: { $base: '==1000' }
    },
    cometBalances: {
      albert: { $base: -999 } // in units of asset, not wei
    },
    filter: async (ctx: CometContext) => matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'usdt' }])
  },
  async ({ comet, actors }, context, world) => {
    // Set fees for USDT for testing
    const USDT = await world.deploymentManager.existing('USDT', await comet.baseToken(), world.base.network);
    const USDTAdminAddress = await USDT.owner();
    await world.deploymentManager.hre.network.provider.send('hardhat_setBalance', [
      USDTAdminAddress,
      ethers.utils.hexStripZeros(ethers.utils.parseEther('100').toHexString())
    ]);
    await world.deploymentManager.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDTAdminAddress]
    });
    // mine a block to ensure the impersonation is effective
    const USDTAdminSigner = await world.deploymentManager.hre.ethers.getSigner(USDTAdminAddress);
    // 10 basis points, and max 10 USDT
    await USDT.connect(USDTAdminSigner).setParams(10, 10);

    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(
      await albert.getCometBaseBalance(),
      -999n * scale,
      getInterest(999n * scale, borrowRate, 4n) + 2n
    );

    // Albert repays 1000 units of base borrow
    await baseAsset.approve(albert, comet.address);
    const txn = await comet
      .connect(albert.signer)
      .supply(baseAsset.address, 1000n * scale)
      .then((tx) => tx.wait());

    // XXX all these timings are crazy
    // albert supply 1000 USDT to repay, 1000USDT * (99.9%) = 999 USDT, thus albert should have just enough to repay his debt of 999 USDT.
    expectApproximately(await albert.getCometBaseBalance(), 0n, getInterest(1000n * scale, borrowRate, 4n) + 2n);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#supply > reverts if not enough ERC20 approval',
  {
    tokenBalances: {
      albert: { $base: 100 } // in units of asset, not wei
    }
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await expect(comet.connect(albert.signer).supply(baseAsset.address, 100n * scale)).to.be.reverted;
  }
);

scenario(
  'Comet#supplyTo > reverts if not enough ERC20 approval',
  {
    tokenBalances: {
      albert: { $base: 100 } // in units of asset, not wei
    }
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await expect(comet.connect(albert.signer).supplyTo(betty.address, baseAsset.address, 100n * scale)).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom > reverts if not enough ERC20 base approval',
  {
    tokenBalances: {
      albert: { $base: 100 } // in units of asset, not wei
    }
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await albert.allow(betty, true);
    await baseAsset.approve(albert, betty, 10n * scale);

    await expect(comet.connect(betty.signer).supplyFrom(albert.address, betty.address, baseAsset.address, 100n * scale))
      .to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom > reverts if not enough ERC20 collateral approval',
  {
    tokenBalances: {
      albert: { $asset0: 100 } // in units of asset, not wei
    }
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const symbol = await collateralAsset.token.symbol();
    const scale = scaleBN.toBigInt();

    await albert.allow(betty, true);
    await collateralAsset.approve(albert, betty, 10n * scale);

    await expectRevertMatches(
      comet.connect(betty.signer).supplyFrom(albert.address, betty.address, collateralAsset.address, 100n * scale),
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
        symbol === 'GOLD' ? /Transaction reverted and Hardhat couldn't infer the reason./ : /.^/
      ]
    );
  }
);

scenario(
  'Comet#supply > reverts if not enough ERC20 balance',
  {
    tokenBalances: {
      albert: { $base: 10 } // in units of asset, not wei
    }
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await expect(comet.connect(albert.signer).supply(baseAsset.address, 100n * scale)).to.be.reverted;
  }
);

scenario(
  'Comet#supplyTo > reverts if not enough ERC20 balance',
  {
    tokenBalances: {
      albert: { $base: 10 } // in units of asset, not wei
    }
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await expect(comet.connect(albert.signer).supplyTo(betty.address, baseAsset.address, 100n * scale)).to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom > reverts if not enough ERC20 base balance',
  {
    tokenBalances: {
      albert: { $base: 10 } // in units of asset, not wei
    }
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await albert.allow(betty, true);
    await expect(comet.connect(betty.signer).supplyFrom(albert.address, betty.address, baseAsset.address, 100n * scale))
      .to.be.reverted;
  }
);

scenario(
  'Comet#supplyFrom > reverts if not enough ERC20 collateral balance',
  {
    tokenBalances: {
      albert: { $asset0: 10 } // in units of asset, not wei
    }
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
      comet.connect(betty.signer).supplyFrom(albert.address, betty.address, collateralAsset.address, 100n * scale),
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
        symbol === 'USDC' ? /Transaction reverted without a reason string/ : /.^/
      ]
    );
  }
);

scenario(
  'Comet#supplyFrom > reverts if operator not given permission',
  {
    tokenBalances: {
      albert: { $asset0: 100 } // in units of asset, not wei
    }
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await expectRevertCustom(
      comet.connect(betty.signer).supplyFrom(albert.address, betty.address, baseAsset.address, 100n * scale),
      'Unauthorized()'
    );
  }
);

scenario(
  'Comet#supply > reverts if exceeding supply cap',
  {
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $asset0: await getSupplyCapExceedingAmount(ctx, 0) }
    })
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const assetIndex = 0;
    const assetInfo = await comet.getAssetInfo(assetIndex);

    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const amountToSupply = await collateralAsset.balanceOf(albert.address);

    await collateralAsset.approve(albert, comet.address, amountToSupply);

    await expectRevertCustom(
      comet.connect(albert.signer).supply(collateralAsset.address, amountToSupply),
      'SupplyCapExceeded()'
    );
  }
);

scenario(
  'Comet#supplyTo > reverts if exceeding supply cap',
  {
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $asset0: await getSupplyCapExceedingAmount(ctx, 0) }
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const assetIndex = 0;
    const assetInfo = await comet.getAssetInfo(assetIndex);

    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const amountToSupply = await collateralAsset.balanceOf(albert.address);

    await collateralAsset.approve(albert, comet.address, amountToSupply);

    await expectRevertCustom(
      comet.connect(albert.signer).supplyTo(betty.address, collateralAsset.address, amountToSupply),
      'SupplyCapExceeded()'
    );
  }
);

scenario(
  'Comet#supplyFrom > reverts if exceeding supply cap',
  {
    tokenBalances: async (ctx: CometContext) => ({
      albert: { $asset0: await getSupplyCapExceedingAmount(ctx, 0) }
    })
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const assetIndex = 0;
    const assetInfo = await comet.getAssetInfo(assetIndex);

    const collateralAsset = context.getAssetByAddress(assetInfo.asset);
    const amountToSupply = await collateralAsset.balanceOf(albert.address);

    await collateralAsset.approve(albert, comet.address, amountToSupply);
    await albert.allow(betty, true);

    await expectRevertCustom(
      comet.connect(betty.signer).supplyFrom(albert.address, betty.address, collateralAsset.address, amountToSupply),
      'SupplyCapExceeded()'
    );
  }
);

scenario(
  'Comet#supply > reverts when supply is paused',
  {
    pause: {
      supplyPaused: true
    }
  },
  async ({ comet, actors }) => {
    const { albert } = actors;

    const baseToken = await comet.baseToken();
    const scale = (await comet.baseScale()).toBigInt();

    await expectRevertCustom(comet.connect(albert.signer).supply(baseToken, 100n * scale), 'Paused()');
  }
);

scenario(
  'Comet#supplyTo > reverts when supply is paused',
  {
    pause: {
      supplyPaused: true
    }
  },
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();
    const scale = (await comet.baseScale()).toBigInt();

    await expectRevertCustom(comet.connect(albert.signer).supplyTo(betty.address, baseToken, 100n * scale), 'Paused()');
  }
);

scenario(
  'Comet#supplyFrom > reverts when supply is paused',
  {
    pause: {
      supplyPaused: true
    }
  },
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();
    const scale = (await comet.baseScale()).toBigInt();

    await betty.allow(albert, true);

    await expectRevertCustom(
      comet.connect(albert.signer).supplyFrom(betty.address, albert.address, baseToken, 100n * scale),
      'Paused()'
    );
  }
);

scenario('Comet#supply > reverts on unregistered asset', {}, async ({ comet, actors }, context) => {
  const { albert } = actors;

  const unregisteredAsset = await deployMockERC20(context, 'asset');

  const collateralAmount = exp(getConfigForScenario(context).supplyCollateral, await unregisteredAsset.decimals());

  await context.setNextBaseFeeToZero();
  await unregisteredAsset.mint(albert.address, collateralAmount, { gasPrice: 0 });

  await unregisteredAsset.connect(albert.signer).approve(comet.address, collateralAmount);

  await expectRevertCustom(
    comet.connect(albert.signer).supply(unregisteredAsset.address, collateralAmount),
    'BadAsset()'
  );
});

scenario('Comet#supplyTo > reverts on unregistered asset', {}, async ({ comet, actors }, context) => {
  const { albert, betty } = actors;

  const unregisteredAsset = await deployMockERC20(context, 'asset');

  const collateralAmount = exp(getConfigForScenario(context).supplyCollateral, await unregisteredAsset.decimals());

  await context.setNextBaseFeeToZero();
  await unregisteredAsset.mint(albert.address, collateralAmount, { gasPrice: 0 });

  await unregisteredAsset.connect(albert.signer).approve(comet.address, collateralAmount);

  await expectRevertCustom(
    comet.connect(albert.signer).supplyTo(betty.address, unregisteredAsset.address, collateralAmount),
    'BadAsset()'
  );
});

scenario('Comet#supplyFrom > reverts on unregistered asset', {}, async ({ comet, actors, cometExt }, context) => {
  const { albert, betty } = actors;

  const unregisteredAsset = await deployMockERC20(context, 'asset');

  const collateralAmount = exp(getConfigForScenario(context).supplyCollateral, await unregisteredAsset.decimals());

  await context.setNextBaseFeeToZero();
  await unregisteredAsset.mint(albert.address, collateralAmount, { gasPrice: 0 });

  await context.setNextBaseFeeToZero();
  await unregisteredAsset.connect(albert.signer).approve(comet.address, collateralAmount, { gasPrice: 0 });

  await expectRevertCustom(
    comet.connect(albert.signer).supplyFrom(albert.address, betty.address, unregisteredAsset.address, collateralAmount),
    'BadAsset()'
  );
});

scenario(
  'Comet#supply > reverts when base supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase }
    })
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause base supply
    await cometExt.connect(pauseGuardian.signer).pauseBaseSupply(true);

    await baseAsset.approve(albert, comet.address);
    await expectRevertCustom(
      comet
        .connect(albert.signer)
        .supply(baseAsset.address, BigInt(getConfigForScenario(context).transferBase) * scale),
      'BaseSupplyPaused()'
    );
  }
);

scenario(
  'Comet#supplyTo > reverts when base supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase }
    })
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause base supply
    await cometExt.connect(pauseGuardian.signer).pauseBaseSupply(true);

    await baseAsset.approve(albert, comet.address);
    await expectRevertCustom(
      comet
        .connect(albert.signer)
        .supplyTo(betty.address, baseAsset.address, BigInt(getConfigForScenario(context).transferBase) * scale),
      'BaseSupplyPaused()'
    );
  }
);

scenario(
  'Comet#supplyFrom > reverts when base supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).transferBase)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $base: getConfigForScenario(ctx).transferBase }
    })
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, charles, pauseGuardian } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await baseAsset.approve(albert, comet.address);
    await albert.allow(charles, true);

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause base supply
    await cometExt.connect(pauseGuardian.signer).pauseBaseSupply(true);

    await expectRevertCustom(
      comet
        .connect(charles.signer)
        .supplyFrom(
          albert.address,
          betty.address,
          baseAsset.address,
          BigInt(getConfigForScenario(context).transferBase) * scale
        ),
      'BaseSupplyPaused()'
    );
  }
);

scenario(
  'Comet#supply > reverts when collateral supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).supplyCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).supplyCollateral }
    })
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const amountToSupply = BigInt(getConfigForScenario(context).supplyCollateral) * scaleBN.toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause collateral supply
    await cometExt.connect(pauseGuardian.signer).pauseCollateralSupply(true);

    await collateralAsset.approve(albert, comet.address);
    await expectRevertCustom(
      comet.connect(albert.signer).supply(collateralAsset.address, amountToSupply),
      'CollateralSupplyPaused()'
    );
  }
);

scenario(
  'Comet#supplyTo > reverts when collateral supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).supplyCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).supplyCollateral }
    })
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const amountToSupply = BigInt(getConfigForScenario(context).supplyCollateral) * scaleBN.toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause collateral supply
    await cometExt.connect(pauseGuardian.signer).pauseCollateralSupply(true);

    await collateralAsset.approve(albert, comet.address);
    await expectRevertCustom(
      comet.connect(albert.signer).supplyTo(betty.address, collateralAsset.address, amountToSupply),
      'CollateralSupplyPaused()'
    );
  }
);

scenario(
  'Comet#supplyFrom > reverts when collateral supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).supplyCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).supplyCollateral }
    })
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, charles, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const amountToSupply = BigInt(getConfigForScenario(context).supplyCollateral) * scaleBN.toBigInt();

    await collateralAsset.approve(albert, comet.address);
    await albert.allow(charles, true);

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause collateral supply
    await cometExt.connect(pauseGuardian.signer).pauseCollateralSupply(true);

    await expectRevertCustom(
      comet.connect(charles.signer).supplyFrom(albert.address, betty.address, collateralAsset.address, amountToSupply),
      'CollateralSupplyPaused()'
    );
  }
);

scenario(
  'Comet#supply > reverts when specific collateral asset supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).supplyCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).supplyCollateral }
    })
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const amountToSupply = BigInt(getConfigForScenario(context).supplyCollateral) * scaleBN.toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause specific collateral asset supply
    await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(0, true);

    await collateralAsset.approve(albert, comet.address);
    await expectRevertCustom(
      comet.connect(albert.signer).supply(collateralAsset.address, amountToSupply),
      'CollateralAssetSupplyPaused(0)'
    );
  }
);

scenario(
  'Comet#supplyTo > reverts when specific collateral asset supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).supplyCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).supplyCollateral }
    })
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const amountToSupply = BigInt(getConfigForScenario(context).supplyCollateral) * scaleBN.toBigInt();

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause specific collateral asset supply
    await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(0, true);

    await collateralAsset.approve(albert, comet.address);
    await expectRevertCustom(
      comet.connect(albert.signer).supplyTo(betty.address, collateralAsset.address, amountToSupply),
      'CollateralAssetSupplyPaused(0)'
    );
  }
);

scenario(
  'Comet#supplyFrom > reverts when specific collateral asset supply is paused',
  {
    filter: async (ctx: CometContext) => {
      return (
        (await isValidAssetIndex(ctx, 0)) &&
        (await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx).supplyCollateral)) &&
        (await usesAssetList(ctx)) &&
        !(await isAssetDelisted(ctx, 0)) &&
        (await supportsExtendedPause(ctx))
      );
    },
    tokenBalances: (ctx: CometContext) => ({
      albert: { $asset0: getConfigForScenario(ctx).supplyCollateral }
    })
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, charles, pauseGuardian } = actors;
    const { asset, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset);
    const amountToSupply = BigInt(getConfigForScenario(context).supplyCollateral) * scaleBN.toBigInt();

    await collateralAsset.approve(albert, comet.address);
    await albert.allow(charles, true);

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Pause specific collateral asset supply
    await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(0, true);

    await expectRevertCustom(
      comet.connect(charles.signer).supplyFrom(albert.address, betty.address, collateralAsset.address, amountToSupply),
      'CollateralAssetSupplyPaused(0)'
    );
  }
);

scenario(
  'Comet#supply > reverts when collateral asset supply is paused and allows to supply when unpaused',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!(await isValidAssetIndex(context, i))) continue;
      if (!(await isTriviallySourceable(context, i, getConfigForScenario(context).supplyCollateral))) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const amountToSupply = BigInt(getConfigForScenario(context).supplyCollateral) * scaleBN.toBigInt();

      log(`Supplying reverts when collateral asset ${i} supply is paused`);

      // Source collateral asset
      await context.sourceTokens(amountToSupply, collateralAsset.address, albert.address);

      // Pause specific collateral asset supply at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(i, true);

      await collateralAsset.approve(albert, comet.address);
      await expectRevertCustom(
        comet.connect(albert.signer).supply(collateralAsset.address, amountToSupply),
        `CollateralAssetSupplyPaused(${i})`
      );

      log(`Supplying is allowed when collateral asset ${i} supply is unpaused`);

      // Unpause specific collateral asset supply at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(i, false);

      await comet.connect(albert.signer).supply(collateralAsset.address, amountToSupply);

      expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(amountToSupply);
    }
  }
);

scenario(
  'Comet#supplyTo > reverts when collateral asset supply is paused and allows to supply when unpaused',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!(await isValidAssetIndex(context, i))) continue;
      if (!(await isTriviallySourceable(context, i, getConfigForScenario(context).supplyCollateral))) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const amountToSupply = BigInt(getConfigForScenario(context).supplyCollateral) * scaleBN.toBigInt();

      log(`Supplying reverts when collateral asset ${i} supply is paused`);

      // Source collateral asset
      await context.sourceTokens(amountToSupply, collateralAsset.address, albert.address);

      // Pause specific collateral asset supply at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(i, true);

      await collateralAsset.approve(albert, comet.address);
      await expectRevertCustom(
        comet.connect(albert.signer).supplyTo(betty.address, collateralAsset.address, amountToSupply),
        `CollateralAssetSupplyPaused(${i})`
      );

      log(`Supplying is allowed when collateral asset ${i} supply is unpaused`);

      // Unpause specific collateral asset supply at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(i, false);

      await comet.connect(albert.signer).supplyTo(betty.address, collateralAsset.address, amountToSupply);

      expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(amountToSupply);
    }
  }
);

scenario(
  'Comet#supplyFrom > reverts when collateral asset supply is paused and allows to supply when unpaused',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { albert, betty, pauseGuardian } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!(await isValidAssetIndex(context, i))) continue;
      if (!(await isTriviallySourceable(context, i, getConfigForScenario(context).supplyCollateral))) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBN } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const amountToSupply = BigInt(getConfigForScenario(context).supplyCollateral) * scaleBN.toBigInt();

      log(`Supplying reverts when collateral asset ${i} supply is paused`);

      // Source collateral asset
      await context.sourceTokens(amountToSupply, collateralAsset.address, albert.address);

      // Pause specific collateral asset supply at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(i, true);

      await collateralAsset.approve(albert, comet.address);
      await albert.allow(betty, true);

      await expectRevertCustom(
        comet.connect(betty.signer).supplyFrom(albert.address, betty.address, collateralAsset.address, amountToSupply),
        `CollateralAssetSupplyPaused(${i})`
      );

      log(`Supplying is allowed when collateral asset ${i} supply is unpaused`);

      // Unpause specific collateral asset supply at index i
      await cometExt.connect(pauseGuardian.signer).pauseCollateralAssetSupply(i, false);

      await comet
        .connect(betty.signer)
        .supplyFrom(albert.address, betty.address, collateralAsset.address, amountToSupply);

      expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(amountToSupply);
    }
  }
);

/*//////////////////////////////////////////////////////////////
                    DEACTIVATE/ACTIVATE COLLATERALS
//////////////////////////////////////////////////////////////*/

scenario(
  'Comet#supply > reverts when collateral asset is deactivated and allows to supply when activated',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { pauseGuardian, albert } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!(await isValidAssetIndex(context, i))) continue;
      if (!(await isTriviallySourceable(context, i, getConfigForScenario(context).supplyCollateral))) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBigNumber } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBigNumber.toBigInt();
      const supplyAmount = BigInt(getConfigForScenario(context).supplyCollateral) * scale;

      log(`Supply reverts when collateral asset ${i} is deactivated`);

      // Source collateral asset
      await context.sourceTokens(supplyAmount, collateralAsset.address, albert.address);

      // Approve the asset for supply
      await collateralAsset.approve(albert, comet.address);

      // Deactivate collateral asset
      await cometExt.connect(pauseGuardian.signer).deactivateCollateral(i);

      await expectRevertCustom(
        comet.connect(albert.signer).supply(collateralAsset.address, supplyAmount),
        `CollateralAssetSupplyPaused(${i})`
      );

      log(`Supply is allowed when collateral asset ${i} is activated`);

      // Activate collateral asset
      await cometExt.connect(pauseGuardian.signer).activateCollateral(i);

      await comet.connect(albert.signer).supply(collateralAsset.address, supplyAmount);

      expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(supplyAmount);
    }
  }
);

scenario(
  'Comet#supplyTo > reverts when collateral asset is deactivated and allows to supply when activated',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { pauseGuardian, albert, betty } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!(await isValidAssetIndex(context, i))) continue;
      if (!(await isTriviallySourceable(context, i, getConfigForScenario(context).supplyCollateral))) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBigNumber } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBigNumber.toBigInt();
      const supplyAmount = BigInt(getConfigForScenario(context).supplyCollateral) * scale;

      log(`SupplyTo reverts when collateral asset ${i} is deactivated`);

      // Source collateral asset
      await context.sourceTokens(supplyAmount, collateralAsset.address, albert.address);

      // Approve the asset for supply
      await collateralAsset.approve(albert, comet.address);

      // Deactivate collateral asset
      await cometExt.connect(pauseGuardian.signer).deactivateCollateral(i);

      await expectRevertCustom(
        comet.connect(albert.signer).supplyTo(betty.address, collateralAsset.address, supplyAmount),
        `CollateralAssetSupplyPaused(${i})`
      );

      log(`SupplyTo is allowed when collateral asset ${i} is activated`);

      // Activate collateral asset
      await cometExt.connect(pauseGuardian.signer).activateCollateral(i);

      await comet.connect(albert.signer).supplyTo(betty.address, collateralAsset.address, supplyAmount);

      expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(supplyAmount);
    }
  }
);

scenario(
  'Comet#supplyFrom > reverts when collateral asset is deactivated and allows to supply when activated',
  {
    filter: async (ctx: CometContext) => {
      return (await usesAssetList(ctx)) && (await supportsExtendedPause(ctx));
    }
  },
  async ({ comet, actors, cometExt }, context, world) => {
    const { pauseGuardian, albert, betty } = actors;

    // Fund pause guardian account for gas fees
    await fundAccount(world, pauseGuardian);

    // Allow betty to act on behalf of albert
    await albert.allow(betty, true);

    for (let i = 0; i < MAX_ASSETS; i++) {
      if (!(await isValidAssetIndex(context, i))) continue;
      if (!(await isTriviallySourceable(context, i, getConfigForScenario(context).supplyCollateral))) continue;
      if (await isAssetDelisted(context, i)) continue;

      const { asset, scale: scaleBigNumber } = await comet.getAssetInfo(i);
      const collateralAsset = context.getAssetByAddress(asset);
      const scale = scaleBigNumber.toBigInt();
      const supplyAmount = BigInt(getConfigForScenario(context).supplyCollateral) * scale;

      log(`SupplyFrom reverts when collateral asset ${i} is deactivated`);

      // Source collateral asset
      await context.sourceTokens(supplyAmount, collateralAsset.address, albert.address);

      // Approve the asset for supply
      await collateralAsset.approve(albert, comet.address);

      // Deactivate collateral asset
      await cometExt.connect(pauseGuardian.signer).deactivateCollateral(i);

      await expectRevertCustom(
        comet.connect(betty.signer).supplyFrom(albert.address, betty.address, collateralAsset.address, supplyAmount),
        `CollateralAssetSupplyPaused(${i})`
      );

      log(`SupplyFrom is allowed when collateral asset ${i} is activated`);

      // Activate collateral asset
      await cometExt.connect(pauseGuardian.signer).activateCollateral(i);

      await comet
        .connect(betty.signer)
        .supplyFrom(albert.address, betty.address, collateralAsset.address, supplyAmount);

      expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(supplyAmount);
    }
  }
);
