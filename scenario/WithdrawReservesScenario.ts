import { scenario } from './context/CometContext.js';
import { expectRevertCustom } from './utils/index.js';
import { expect } from 'chai';

scenario(
  'Comet#withdrawReserves > governor withdraws reserves',
  {
    reserves: '>= 10000',
    tokenBalances: {
      albert: { $base: '== 0' },
    },
  },
  async ({ comet, timelock, actors }, context) => {
    const { admin, albert } = actors;

    const baseToken = context.getAssetByAddress(await comet.baseToken());
    const scale = await comet.baseScale();
    const cometAddress = await comet.getAddress();

    const cometBaseBalance = await baseToken.balanceOf(cometAddress);

    expect(await comet.governor()).to.equal(await timelock.getAddress());

    const toWithdrawAmount = 10n * scale;
    await context.setNextBaseFeeToZero();
    const txn = await admin.withdrawReserves(albert.address, toWithdrawAmount, { gasPrice: 0 });

    expect(await baseToken.balanceOf(cometAddress)).to.equal(cometBaseBalance - toWithdrawAmount);
    expect(await baseToken.balanceOf(albert.address)).to.equal(toWithdrawAmount);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#withdrawReserves > reverts if not called by governor',
  {
    tokenBalances: {
      $comet: { $base: 100 },
    },
  },
  async ({ actors }) => {
    const { albert } = actors;
    await expectRevertCustom(albert.withdrawReserves(albert.address, 10), 'Unauthorized()');
  }
);


scenario(
  'Comet#withdrawReserves > reverts if not enough reserves are owned by protocol',
  {
    tokenBalances: {
      $comet: { $base: '== 100' },
    },
  },
  async ({ comet, actors }, context) => {
    const { admin, albert } = actors;

    const scale = await comet.baseScale();

    await context.setNextBaseFeeToZero();
    await expectRevertCustom(
      admin.withdrawReserves(albert.address, 1001n * scale, { gasPrice: 0 }),
      'InsufficientReserves()'
    );
  }
);

// XXX add scenario that tests for a revert when reserves are reduced by
// totalSupplyBase
