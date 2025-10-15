import { scenario } from './context/CometContext';
import { expectRevertCustom } from './utils';
import { expect } from 'chai';
import { getConfigForScenario } from './utils/scenarioHelper';

scenario(
  'Comet#withdrawReserves > governor withdraws reserves',
  {
    reserves: await (async (ctx) => { return `>= ${getConfigForScenario(ctx).withdraw.baseAmount * 10}`; })(),
    tokenBalances: {
      albert: { $base: `== 0` },
    },
  },
  async ({ comet, timelock, actors }, context) => {
    const { admin, albert } = actors;
    const baseToken = context.getAssetByAddress(await comet.baseToken());
    const scale = (await comet.baseScale()).toBigInt();
    const cometBaseBalance = await baseToken.balanceOf(comet.address);
    expect(await comet.governor()).to.equal(timelock.address);
    const toWithdrawAmount = BigInt(getConfigForScenario(context).withdraw.baseAmount) / 100n * scale;
    await context.setNextBaseFeeToZero();
    const txn = await admin.withdrawReserves(albert.address, toWithdrawAmount, { gasPrice: 0 });
    expect(await baseToken.balanceOf(comet.address)).to.equal(cometBaseBalance - toWithdrawAmount);
    expect(await baseToken.balanceOf(albert.address)).to.equal(toWithdrawAmount);
    return txn;
  }
);

scenario(
  'Comet#withdrawReserves > reverts if not called by governor',
  {
    tokenBalances: async (ctx) => ({
      $comet: { $base: getConfigForScenario(ctx).supply.collateralAmount },
    }),
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    await expectRevertCustom(
      albert.withdrawReserves(albert.address, BigInt(getConfigForScenario(context).supply.collateralAmount) / 10n), 
      'Unauthorized()'
    );
  }
);

scenario(
  'Comet#withdrawReserves > reverts if not enough reserves are owned by protocol',
  {
    tokenBalances: async (ctx) => ({
      $comet: { $base: `== ${getConfigForScenario(ctx).supply.collateralAmount}` },
    }),
  },
  async ({ comet, actors }, context) => {
    const { admin, albert } = actors;
    const scale = (await comet.baseScale()).toBigInt();
    await context.setNextBaseFeeToZero();
    await expectRevertCustom(
      admin.withdrawReserves(
        albert.address, 
        BigInt(getConfigForScenario(context).supply.collateralAmount) * 10n * scale, 
        { gasPrice: 0 }
      ),
      'InsufficientReserves()'
    );
  }
);
// XXX add scenario that tests for a revert when reserves are reduced by
// totalSupplyBase