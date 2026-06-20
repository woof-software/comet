import { scenario } from './context/CometContext';
import { event, expect } from '../test/helpers';
import { expectRevertCustom, isTriviallySourceable, isValidAssetIndex } from './utils';
import { getConfigForScenario } from './utils/scenarioHelper';
import { constants } from 'ethers';

scenario('Comet#allow > has default permission state', {}, async ({ comet, actors }) => {
  const { albert, betty } = actors;

  expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
  expect(await comet.hasPermission(albert.address, albert.address)).to.be.true;
  expect(await comet.hasPermission(albert.address, betty.address)).to.be.false;
  expect(await comet.allowance(albert.address, betty.address)).to.be.equal(0);
});

scenario('Comet#allow > allows a user to authorize a manager', {}, async ({ comet, actors }) => {
  const { albert, betty } = actors;

  const txn = await albert.allow(betty, true);

  expect(await comet.isAllowed(albert.address, betty.address)).to.be.true;
  expect(await comet.hasPermission(albert.address, betty.address)).to.be.true;
  expect(await comet.allowance(albert.address, betty.address)).to.be.equal(constants.MaxUint256);
  expect(event({ receipt: txn }, 0)).to.deep.equal({
    Approval: {
      owner: albert.address,
      spender: betty.address,
      amount: constants.MaxUint256.toBigInt(),
    }
  });

  return txn; // return txn to measure gas
});

scenario('Comet#allow > allows a user to rescind authorization', {}, async ({ comet, actors }) => {
  const { albert, betty } = actors;

  await albert.allow(betty, true);

  expect(await comet.isAllowed(albert.address, betty.address)).to.be.true;

  const txn = await albert.allow(betty, false);

  expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
  expect(await comet.hasPermission(albert.address, betty.address)).to.be.false;
  expect(await comet.allowance(albert.address, betty.address)).to.be.equal(0);
  expect(event({ receipt: txn }, 0)).to.deep.equal({
    Approval: {
      owner: albert.address,
      spender: betty.address,
      amount: 0n,
    }
  });

  return txn; // return txn to measure gas
});

scenario('Comet#approve > updates permission state through ERC20-style approvals', {}, async ({ comet, actors }) => {
  const { albert, betty } = actors;

  const approveTxn = await (await comet.connect(albert.signer).approve(betty.address, constants.MaxUint256)).wait();

  expect(await comet.isAllowed(albert.address, betty.address)).to.be.true;
  expect(await comet.hasPermission(albert.address, betty.address)).to.be.true;
  expect(await comet.allowance(albert.address, betty.address)).to.be.equal(constants.MaxUint256);
  expect(event({ receipt: approveTxn }, 0)).to.deep.equal({
    Approval: {
      owner: albert.address,
      spender: betty.address,
      amount: constants.MaxUint256.toBigInt(),
    }
  });

  const revokeTxn = await (await comet.connect(albert.signer).approve(betty.address, 0)).wait();

  expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
  expect(await comet.hasPermission(albert.address, betty.address)).to.be.false;
  expect(await comet.allowance(albert.address, betty.address)).to.be.equal(0);
  expect(event({ receipt: revokeTxn }, 0)).to.deep.equal({
    Approval: {
      owner: albert.address,
      spender: betty.address,
      amount: 0n,
    }
  });
});

scenario('Comet#approve > reverts if amount is not 0 or uint256.max', {}, async ({ comet, actors }) => {
  const { albert, betty } = actors;

  await expectRevertCustom(
    comet.connect(albert.signer).approve(betty.address, 300),
    'BadAmount()'
  );

  expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
  expect(await comet.hasPermission(albert.address, betty.address)).to.be.false;
  expect(await comet.allowance(albert.address, betty.address)).to.be.equal(0);
});

scenario(
  'Comet#allow > authorized manager can withdrawFrom base on behalf of owner',
  {
    cometBalances: {
      albert: { $base: 2 }, // in units of asset, not wei
    },
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(0n);

    await albert.allow(betty, true);

    // Betty withdraws Albert's supplied base to Betty on his behalf.
    const txn = await betty.withdrawAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: baseSupplied });

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(baseSupplied);
    expect(await comet.balanceOf(albert.address)).to.be.lessThan(baseSupplied / 100n);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#allow > authorized manager can transferAssetFrom collateral on behalf of owner',
  {
    filter: async (ctx) => await isValidAssetIndex(ctx, 1) && await isTriviallySourceable(ctx, 1, getConfigForScenario(ctx, 1).transferCollateral),
    cometBalances: async (ctx) => (
      {
        albert: { $asset1: getConfigForScenario(ctx, 1).transferCollateral }
      }
    ),
  },
  async ({ comet, actors }, context) => {
    const { albert, betty, charles } = actors;
    const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(1);
    const collateralAsset = context.getAssetByAddress(assetAddress);
    const scale = scaleBN.toBigInt();
    const supplied = BigInt(getConfigForScenario(context, 1).transferCollateral) * scale;
    const toTransfer = supplied / 2n;

    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(supplied);
    expect(await comet.collateralBalanceOf(charles.address, collateralAsset.address)).to.be.equal(0n);

    // Albert authorizes Betty; Betty moves Albert's collateral to Charles.
    await albert.allow(betty, true);

    const txn = await betty.transferAssetFrom({ src: albert.address, dst: charles.address, asset: collateralAsset.address, amount: toTransfer });

    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(supplied - toTransfer);
    expect(await comet.collateralBalanceOf(charles.address, collateralAsset.address)).to.be.equal(toTransfer);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#allow > revoked manager can no longer withdrawFrom owner',
  {
    cometBalances: {
      albert: { $base: 2 }, // in units of asset, not wei
    },
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    // 1. Authorize Betty, then prove the grant works with a partial withdraw.
    await albert.allow(betty, true);

    const firstWithdraw = baseSupplied / 2n;
    await betty.withdrawAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: firstWithdraw });
    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(firstWithdraw);

    // 2. Revoke the authorization.
    await albert.allow(betty, false);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    // 3. The same operator action now reverts: permission is checked before
    //    balances, so this fails with Unauthorized() even though Albert still
    //    has base supplied.
    await expectRevertCustom(
      betty.withdrawAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: 1n,
      }),
      'Unauthorized()'
    );
  }
);

scenario(
  'Comet#allow > non-authorized manager cannot withdrawFrom owner',
  {
    cometBalances: {
      albert: { $base: 2 }, // in units of asset, not wei
    },
  },
  async ({ comet, actors }, context) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);

    // No grant at all: Betty was never authorized over Albert.
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    await expectRevertCustom(
      betty.withdrawAssetFrom({
        src: albert.address,
        dst: betty.address,
        asset: baseAsset.address,
        amount: 1n,
      }),
      'Unauthorized()'
    );
  }
);

scenario(
  'Comet#allow > allow(self, false) does not revoke self-permission',
  {},
  async ({ comet, actors }) => {
    const { albert } = actors;

    expect(await comet.hasPermission(albert.address, albert.address)).to.be.true;

    const txn = await albert.allow(albert, false);

    // The isAllowed slot is written to false ...
    expect(await comet.isAllowed(albert.address, albert.address)).to.be.false;
    // ... but hasPermission is hardcoded true for owner == manager, and the
    // allowance view follows hasPermission, so self-permission still holds.
    expect(await comet.hasPermission(albert.address, albert.address)).to.be.true;
    expect(await comet.allowance(albert.address, albert.address)).to.be.equal(constants.MaxUint256);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#allow > owner can still self-withdraw after allow(self, false)',
  {
    cometBalances: {
      albert: { $base: 2 }, // in units of asset, not wei
    },
  },
  async ({ comet, actors }, context) => {
    const { albert } = actors;
    const baseAsset = context.getAssetByAddress(await comet.baseToken());
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);

    await albert.allow(albert, false);

    // Self-permission is intact, so the owner can still operate on its own account.
    await albert.withdrawAssetFrom({ src: albert.address, dst: albert.address, asset: baseAsset.address, amount: baseSupplied });

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(baseSupplied);
  }
);

scenario(
  'Comet#allow > allow(true) twice leaves state allowed',
  {},
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    await albert.allow(betty, true);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.true;

    await albert.allow(betty, true);

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.true;
    expect(await comet.hasPermission(albert.address, betty.address)).to.be.true;
    expect(await comet.allowance(albert.address, betty.address)).to.be.equal(constants.MaxUint256);
  }
);

scenario(
  'Comet#allow > allow(false) when already disallowed is a no-op',
  {},
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    await albert.allow(betty, false);

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
    expect(await comet.hasPermission(albert.address, betty.address)).to.be.false;
    expect(await comet.allowance(albert.address, betty.address)).to.be.equal(0);
  }
);

scenario(
  'Comet#allow > re-authorization cycle true → false → true ends allowed',
  {},
  async ({ comet, actors }) => {
    const { albert, betty } = actors;

    await albert.allow(betty, true);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.true;

    await albert.allow(betty, false);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    await albert.allow(betty, true);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.true;
    expect(await comet.hasPermission(albert.address, betty.address)).to.be.true;
    expect(await comet.allowance(albert.address, betty.address)).to.be.equal(constants.MaxUint256);
  }
);

scenario(
  'Comet#allow > revoking one manager leaves another manager intact',
  {},
  async ({ comet, actors }) => {
    const { albert, betty, charles } = actors;

    await albert.allow(betty, true);
    await albert.allow(charles, true);

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.true;
    expect(await comet.isAllowed(albert.address, charles.address)).to.be.true;

    await albert.allow(betty, false);

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
    expect(await comet.hasPermission(albert.address, betty.address)).to.be.false;
    // Charles' authorization is independent and untouched.
    expect(await comet.isAllowed(albert.address, charles.address)).to.be.true;
    expect(await comet.hasPermission(albert.address, charles.address)).to.be.true;
  }
);

scenario(
  'Comet#allow > a grant is scoped to the granting owner only',
  {},
  async ({ comet, actors }) => {
    // Albert and Charles are two distinct owners; Betty is the manager.
    const { albert, betty, charles } = actors;

    await albert.allow(betty, true);

    // Betty is authorized over Albert ...
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.true;
    expect(await comet.hasPermission(albert.address, betty.address)).to.be.true;
    // ... but has no permission over Charles, who never authorized her.
    expect(await comet.isAllowed(charles.address, betty.address)).to.be.false;
    expect(await comet.hasPermission(charles.address, betty.address)).to.be.false;
  }
);
