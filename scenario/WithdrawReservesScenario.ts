import { scenario } from './context/CometContext';
import { expectRevertCustom } from './utils';
import { expect } from 'chai';

// Constants
const MIN_RESERVES_REQUIRED = 10000n;
const WITHDRAW_AMOUNT = 10n;
const BASE_BALANCE_SMALL = 100n;
const WITHDRAW_AMOUNT_SMALL = 10n;
const BASE_BALANCE_EXACT = 100n;
const WITHDRAW_AMOUNT_EXCESSIVE = 1001n;

scenario(
  'Comet#withdrawReserves > governor withdraws reserves',
  {
    reserves: `>= ${MIN_RESERVES_REQUIRED}`,
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

    const toWithdrawAmount = WITHDRAW_AMOUNT * scale;
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
    tokenBalances: {
      $comet: { $base: BASE_BALANCE_SMALL },
    },
  },
  async ({ actors }) => {
    const { albert } = actors;
    await expectRevertCustom(albert.withdrawReserves(albert.address, WITHDRAW_AMOUNT_SMALL), 'Unauthorized()');
  }
);

scenario(
  'Comet#withdrawReserves > reverts if not enough reserves are owned by protocol',
  {
    tokenBalances: {
      $comet: { $base: `== ${BASE_BALANCE_EXACT}` },
    },
  },
  async ({ comet, actors }, context) => {
    const { admin, albert } = actors;
    const scale = (await comet.baseScale()).toBigInt();

    await context.setNextBaseFeeToZero();
    await expectRevertCustom(
      admin.withdrawReserves(albert.address, WITHDRAW_AMOUNT_EXCESSIVE * scale, { gasPrice: 0 }),
      'InsufficientReserves()'
    );
  }
);

// XXX add scenario that tests for a revert when reserves are reduced by
// totalSupplyBase