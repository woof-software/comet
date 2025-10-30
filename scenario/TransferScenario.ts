import { CometContext, scenario } from './context/CometContext';
import { expect } from 'chai';
import { expectApproximately, expectBase, expectRevertCustom, getInterest, hasMinBorrowGreaterThanOne, isTriviallySourceable, isValidAssetIndex, MAX_ASSETS } from './utils';
import { ContractReceipt } from 'ethers';
import { getConfigForScenario } from './utils/scenarioHelper';
import { defactor } from '../test/helpers';

async function testTransferCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const config = getConfigForScenario(context);
  const comet = await context.getComet();
  const { albert, betty } = context.actors;
  const { asset: assetAddress, scale } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);

  // Albert transfers 50 units of collateral to Betty
  const toTransfer = scale.toBigInt() * BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer;
  const txn = await albert.transferAsset({ dst: betty.address, asset: collateralAsset.address, amount: toTransfer });

  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(scale.mul(BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer));
  expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(scale.mul(BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer));

  return txn; // return txn to measure gas
}

async function testTransferFromCollateral(context: CometContext, assetNum: number): Promise<void | ContractReceipt> {
  const config = getConfigForScenario(context);
  const comet = await context.getComet();
  const { albert, betty, charles } = context.actors;
  const { asset: assetAddress, scale } = await comet.getAssetInfo(assetNum);
  const collateralAsset = context.getAssetByAddress(assetAddress);

  await albert.allow(charles, true);

  // Charles transfers 50 units of collateral from Albert to Betty
  const toTransfer = scale.toBigInt() * BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer;
  const txn = await charles.transferAssetFrom({ src: albert.address, dst: betty.address, asset: collateralAsset.address, amount: toTransfer });

  expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(scale.mul(BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer));
  expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(scale.mul(BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer));

  return txn; // return txn to measure gas
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#transfer > collateral asset ${i}, enough balance`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, Number(getConfigForScenario(ctx).transfer.collateralAmount)),
      cometBalances: async (ctx) =>  (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).transfer.collateralAmount }
        }
      ),
    },
    async (_properties, context) => {
      return await testTransferCollateral(context, i);
    }
  );
}

for (let i = 0; i < MAX_ASSETS; i++) {
  scenario(
    `Comet#transferFrom > collateral asset ${i}, enough balance`,
    {
      filter: async (ctx) => await isValidAssetIndex(ctx, i) && await isTriviallySourceable(ctx, i, Number(getConfigForScenario(ctx).transfer.collateralAmount)),
      cometBalances: async (ctx) =>  (
        {
          albert: { [`$asset${i}`]: getConfigForScenario(ctx).transfer.collateralAmount }
        }
      ),
    },
    async (_properties, context) => {
      return await testTransferFromCollateral(context, i);
    }
  );
}

scenario(
  'Comet#transfer > base asset, enough balance',
  {
    cometBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).transfer.baseAmount },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    // Albert transfers half supplied base to Betty
    const toTransfer = baseSupplied / config.common.divisors.transfer;
    const txn = await albert.transferAsset({ dst: betty.address, asset: baseAsset.address, amount: toTransfer });

    expectBase(await albert.getCometBaseBalance(), baseSupplied - toTransfer, baseSupplied / config.common.divisors.percent);
    expectBase(await betty.getCometBaseBalance(), toTransfer, baseSupplied / config.common.divisors.percent);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#transfer > base asset, total and user balances are summed up properly',
  {
    cometBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).transfer.baseAmount },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    // Cache pre-transfer balances
    const { totalSupplyBase: oldTotalSupply, totalBorrowBase: oldTotalBorrow } = await comet.totalsBasic();
    const oldAlbertPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
    const oldBettyPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();

    // Albert transfers 50 units of collateral to Betty
    const toTransfer = BigInt(config.transfer.collateralAmount) / config.common.divisors.transfer * scale;
    const txn = await albert.transferAsset({ dst: betty.address, asset: baseAsset.address, amount: toTransfer });

    // Cache post-transfer balances
    const { totalSupplyBase: newTotalSupply, totalBorrowBase: newTotalBorrow } = await comet.totalsBasic();
    const newAlbertPrincipal = (await comet.userBasic(albert.address)).principal.toBigInt();
    const newBettyPrincipal = (await comet.userBasic(betty.address)).principal.toBigInt();

    // Check that global and user principals are updated by the same amount
    const changeInTotalPrincipal = newTotalSupply.toBigInt() - oldTotalSupply.toBigInt() - (newTotalBorrow.toBigInt() - oldTotalBorrow.toBigInt());
    const changeInUserPrincipal = newAlbertPrincipal - oldAlbertPrincipal + newBettyPrincipal - oldBettyPrincipal;
    expect(changeInTotalPrincipal).to.be.equal(changeInUserPrincipal).to;
    expect(config.transfer.principalToleranceValues).to.include(changeInTotalPrincipal);

    return txn;
  }
);

scenario(
  'Comet#transfer > partial withdraw / borrow base to partial repay / supply',
  {
    cometBalances: async (ctx) =>  (
      {
        albert: { $base: getConfigForScenario(ctx).transfer.baseAmount, $asset0: getConfigForScenario(ctx).withdraw.alternateAsset },
        betty: { $base: -getConfigForScenario(ctx).transfer.baseAmount },
        charles: { $base: getConfigForScenario(ctx).transfer.baseAmount },
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(
      await albert.getCometBaseBalance(),
      BigInt(config.transfer.baseAmount) * scale,
      getInterest(BigInt(config.transfer.baseAmount) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small
    );

    expectApproximately(
      await betty.getCometBaseBalance(),
      -BigInt(config.transfer.baseAmount) * scale,
      getInterest(BigInt(config.transfer.baseAmount) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small
    );

    // Albert with positive balance transfers to Betty with negative balance
    const toTransfer = BigInt(config.transfer.baseAmount) * config.transfer.multiplier.num / config.transfer.multiplier.denom * scale;
    const txn = await albert.transferAsset({ dst: betty.address, asset: baseAsset.address, amount: toTransfer });

    // Albert ends with negative balance and Betty with positive balance
    expectApproximately(await albert.getCometBaseBalance(), -BigInt(config.transfer.baseAmount) * config.transfer.result.num / config.transfer.result.denom * scale, getInterest(BigInt(config.transfer.baseAmount) * config.transfer.result.num / config.transfer.result.denom * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.large);
    expectApproximately(await betty.getCometBaseBalance(), BigInt(config.transfer.baseAmount) * config.transfer.result.num / config.transfer.result.denom * scale, getInterest(BigInt(config.transfer.baseAmount) * config.transfer.result.num / config.transfer.result.denom * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.large);

    return txn;
  }
);

scenario(
  'Comet#transferFrom > withdraw to repay',
  {
    cometBalances: async (ctx) => ({
      albert: { $base: getConfigForScenario(ctx).common.amounts.base.large, $asset0: getConfigForScenario(ctx).common.amounts.collateral.large },
      betty: { $base: -getConfigForScenario(ctx).common.amounts.base.large },
      charles: { $base: getConfigForScenario(ctx).common.amounts.base.large },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(await albert.getCometBaseBalance(), BigInt(config.common.amounts.base.large) * scale, getInterest(BigInt(config.common.amounts.base.large) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small);
    expectApproximately(await betty.getCometBaseBalance(), BigInt(-config.common.amounts.base.large) * scale, getInterest(BigInt(config.common.amounts.base.large) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small);

    await albert.allow(betty, true);

    // Betty withdraws from Albert to repay her own borrows
    const toTransfer = (config.common.amounts.base.large - 1n) * scale;
    const txn = await betty.transferAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: toTransfer });

    expectApproximately(await albert.getCometBaseBalance(), config.transfer.remainingBalance * scale, getInterest(BigInt(config.common.amounts.base.large) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small);
    expectApproximately(await betty.getCometBaseBalance(), -config.transfer.remainingBalance * scale, getInterest(BigInt(config.common.amounts.base.large) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small);

    return txn;
  }
);

scenario(
  'Comet#transfer base reverts if undercollateralized',
  {
    cometBalances: async (ctx) => ({
      albert: { 
        $base: getConfigForScenario(ctx).transfer.baseAmount,
        $asset0: defactor(getConfigForScenario(ctx).common.amounts.collateral.tiny) 
      },
      betty: { $base: -getConfigForScenario(ctx).transfer.baseAmount },
      charles: { $base: getConfigForScenario(ctx).transfer.baseAmount },
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(
      await albert.getCometBaseBalance(), 
      BigInt(config.transfer.baseAmount) * scale, 
      getInterest(BigInt(config.transfer.baseAmount) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small
    );
    expectApproximately(
      await betty.getCometBaseBalance(), 
      -BigInt(config.transfer.baseAmount) * scale, 
      getInterest(BigInt(config.transfer.baseAmount) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small
    );

    // Albert with positive balance transfers to Betty with negative balance
    const toTransfer = config.transfer.overLimit * scale;
    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: baseAsset.address,
        amount: toTransfer,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transferFrom base reverts if undercollateralized',
  {
    cometBalances: async (ctx) => ({
      albert: { 
        $base: getConfigForScenario(ctx).transfer.baseAmount,
        $asset0: defactor(getConfigForScenario(ctx).common.amounts.collateral.tiny) // in units of asset, not wei 
      },
      betty: { $base: -getConfigForScenario(ctx).transfer.baseAmount },
      charles: { $base: getConfigForScenario(ctx).transfer.baseAmount }, // to give the protocol enough base for others to borrow from
    }),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const utilization = await comet.getUtilization();
    const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();

    expectApproximately(
      await albert.getCometBaseBalance(), 
      BigInt(config.transfer.baseAmount) * scale, 
      getInterest(BigInt(config.transfer.baseAmount) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small
    );
    expectApproximately(
      await betty.getCometBaseBalance(), 
      -BigInt(config.transfer.baseAmount) * scale, 
      getInterest(BigInt(config.transfer.baseAmount) * scale, borrowRate, config.common.timing.interestSeconds) + config.common.tolerances.interest.small
    );
    
    await albert.allow(betty, true);

    const toTransfer = config.transfer.overLimit * scale;
    await expectRevertCustom(
      betty.transferAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: toTransfer,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transfer collateral reverts if undercollateralized',
  {
    cometBalances: async (ctx) =>  (
      {
        albert: {
          $base: -getConfigForScenario(ctx).transfer.baseAmount,
          $asset0: `== ${getConfigForScenario(ctx).transfer.assetAmount}`
        },
        betty: { $asset0: 0 },
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const scale = scaleBN.toBigInt();

    // Albert transfers all his collateral to Betty
    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: collateralAsset.address,
        amount: BigInt(config.transfer.assetAmount) * scale,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transferFrom collateral reverts if undercollateralized',
  {
    // XXX we should probably have a price constraint?
    cometBalances: async (ctx) =>  (
      {
        albert: {
          $base: -getConfigForScenario(ctx).transfer.baseAmount,
          $asset0: `== ${getConfigForScenario(ctx).transfer.assetAmount}`
        }, // in units of asset, not wei
        betty: { $asset0: 0 },
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const { asset: asset0Address, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(asset0Address);
    const scale = scaleBN.toBigInt();

    await albert.allow(betty, true);

    // Betty transfers all of Albert's collateral to herself
    await expectRevertCustom(
      betty.transferAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: collateralAsset.address,
        amount: BigInt(config.transfer.assetAmount) * scale,
      }),
      'NotCollateralized()'
    );
  }
);

scenario(
  'Comet#transfer disallows self-transfer of base',
  {},
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;

    const baseToken = await comet.baseToken();

    await expectRevertCustom(
      albert.transferAsset({
        dst: albert.address,
        asset: baseToken,
        amount: config.common.amounts.base.small,
      }),
      'NoSelfTransfer()'
    );
  }
);

scenario(
  'Comet#transfer disallows self-transfer of collateral',
  {},
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert } = actors;

    const collateralAsset = await comet.getAssetInfo(0);

    await expectRevertCustom(
      albert.transferAsset({
        dst: albert.address,
        asset: collateralAsset.asset,
        amount: config.common.amounts.collateral.small,
      }),
      'NoSelfTransfer()'
    );
  }
);

scenario(
  'Comet#transferFrom disallows self-transfer of base',
  {},
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, true);

    await expectRevertCustom(
      albert.transferAssetFrom({
        src: betty.address,
        dst: betty.address,
        asset: baseToken,
        amount: config.common.amounts.base.small,
      }),
      'NoSelfTransfer()'
    );
  }
);

scenario(
  'Comet#transferFrom disallows self-transfer of collateral',
  {},
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    const collateralAsset = await comet.getAssetInfo(0);

    await betty.allow(albert, true);

    await expectRevertCustom(
      albert.transferAssetFrom({
        src: betty.address,
        dst: betty.address,
        asset: collateralAsset.asset,
        amount: config.common.amounts.collateral.small,
      }),
      'NoSelfTransfer()'
    );
  }
);

scenario(
  'Comet#transferFrom reverts if operator not given permission',
  {},
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();

    await expectRevertCustom(
      betty.transferAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: config.common.amounts.base.tiny * scale,
      }),
      'Unauthorized()'
    );
  }
);

scenario(
  'Comet#transfer reverts when transfer is paused',
  {
    pause: {
      transferPaused: true,
    },
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, true);

    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: baseToken,
        amount: config.common.amounts.base.small,
      }),
      'Paused()'
    );
  }
);


scenario(
  'Comet#transferFrom reverts when transfer is paused',
  {
    pause: {
      transferPaused: true,
    },
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;

    const baseToken = await comet.baseToken();

    await betty.allow(albert, true);

    await expectRevertCustom(
      albert.transferAssetFrom({
        src: betty.address,
        dst: albert.address,
        asset: baseToken,
        amount: config.common.amounts.base.small,
      }),
      'Paused()'
    );
  }
);

scenario(
  'Comet#transfer reverts if borrow is less than minimum borrow',
  {
    filter: async (ctx) => await hasMinBorrowGreaterThanOne(ctx),
    cometBalances: async (ctx) => ({
      albert: { $base: 0, $asset0: getConfigForScenario(ctx).common.amounts.collateral.standard }
    })
  },
  async ({ comet, actors }, context) => {
    const config = getConfigForScenario(context);
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const minBorrow = (await comet.baseBorrowMin()).toBigInt();

    await expectRevertCustom(
      albert.transferAsset({
        dst: betty.address,
        asset: baseAsset.address,
        amount: minBorrow / config.common.divisors.transfer
      }),
      'BorrowTooSmall()'
    );
  }
);