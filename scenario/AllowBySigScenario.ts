// Integration scenarios for Comet#allowBySig:
// - EIP-712 signature-based manager authorization (allow / revoke)
// - Signature validation failures (tampered args, nonce, expiry, ECDSA, chain id)
// - Operator actions on behalf of the owner (supplyFrom, withdrawFrom, transferAssetFrom)

import { CometContext, scenario } from './context/CometContext';
import { expectApproximately, expectRevertCustom, isTriviallySourceable, isValidAssetIndex } from './utils';
import { expect } from 'chai';
import { constants } from 'ethers';
import CometActor from './context/CometActor';
import { getConfigForScenario } from './utils/scenarioHelper';


async function authorizeManagerBySig(
  context: CometContext,
  owner: CometActor,
  manager: CometActor,
  world
): Promise<void> {
  const comet = await context.getComet();

  expect(await comet.isAllowed(owner.address, manager.address)).to.be.false;

  const nonce = await comet.userNonce(owner.address);
  const expiry = (await world.timestamp()) + 1_000;

  const signature = await owner.signAuthorization({
    manager: manager.address,
    isAllowed: true,
    nonce,
    expiry,
    chainId: await world.chainId(),
  });

  await manager.allowBySig({
    owner: owner.address,
    manager: manager.address,
    isAllowed: true,
    nonce,
    expiry,
    signature,
  });
}

scenario(
  'Comet#allowBySig > allows a user to authorize a manager by signature',
  {},
  async ({ comet, actors }, _context, world) => {
    const { albert, betty } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const nonce = await comet.userNonce(albert.address);
    const expiry = (await world.timestamp()) + 1_000;

    const signature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      chainId: await world.chainId(),
    });

    const txn = await betty.allowBySig({
      owner: albert.address,
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      signature,
    });

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.true;
    expect(await comet.userNonce(albert.address)).to.equal(nonce.add(1));

    return txn; // return txn to measure gas
  }
);

// Note: These revert scenarios may need to add `upgrade` if Hardhat fails to
//  recognize custom errors received in fallback functions that originate from external artifacts.
// CometExt is an external artifact here unless we redeploy it.
// Related: https://github.com/NomicFoundation/hardhat/issues/1875
scenario(
  'Comet#allowBySig > fails if owner argument is altered',
  {},
  async ({ comet, actors }, context, world) => {
    const { albert, betty, charles } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const nonce = await comet.userNonce(albert.address);
    const expiry = (await world.timestamp()) + 10;

    const signature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      chainId: await world.chainId(),
    });

    await expectRevertCustom(
      betty.allowBySig({
        owner: charles.address, // altered owner
        manager: betty.address,
        isAllowed: true,
        nonce,
        expiry,
        signature,
      }),
      'BadSignatory()'
    );

    expect(await comet.userNonce(albert.address)).to.equal(nonce);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
    expect(await comet.isAllowed(charles.address, betty.address)).to.be.false;
  }
);

scenario(
  'Comet#allowBySig > fails if manager argument is altered',
  {},
  async ({ comet, actors }, context, world) => {
    const { albert, betty, charles } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const nonce = await comet.userNonce(albert.address);
    const expiry = (await world.timestamp()) + 10;

    const signature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      chainId: await world.chainId(),
    });

    await expectRevertCustom(
      betty.allowBySig({
        owner: albert.address,
        manager: charles.address, // altered manager
        isAllowed: true,
        nonce,
        expiry,
        signature,
      }),
      'BadSignatory()'
    );

    expect(await comet.userNonce(albert.address)).to.equal(nonce);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
    expect(await comet.isAllowed(charles.address, betty.address)).to.be.false;
  }
);

scenario(
  'Comet#allowBySig > fails if isAllowed argument is altered',
  {},
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const nonce = await comet.userNonce(albert.address);
    const expiry = (await world.timestamp()) + 10;

    const signature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      chainId: await world.chainId(),
    });

    await expectRevertCustom(
      betty.allowBySig({
        owner: albert.address,
        manager: betty.address,
        isAllowed: false, // altered isAllowed
        nonce,
        expiry,
        signature,
      }),
      'BadSignatory()'
    );

    expect(await comet.userNonce(albert.address)).to.equal(nonce);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
  }
);

scenario(
  'Comet#allowBySig > fails if nonce argument is altered',
  {},
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const nonce = await comet.userNonce(albert.address);
    const expiry = (await world.timestamp()) + 10;

    const signature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      chainId: await world.chainId(),
    });

    await expectRevertCustom(
      betty.allowBySig({
        owner: albert.address,
        manager: betty.address,
        isAllowed: true,
        nonce: nonce.add(1), // altered nonce
        expiry,
        signature,
      }),
      'BadSignatory()'
    );

    expect(await comet.userNonce(albert.address)).to.equal(nonce);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
  }
);

scenario(
  'Comet#allowBySig > fails if expiry argument is altered',
  {},
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const nonce = await comet.userNonce(albert.address);
    const expiry = (await world.timestamp()) + 10;

    const signature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      chainId: await world.chainId(),
    });

    await expectRevertCustom(
      betty.allowBySig({
        owner: albert.address,
        manager: betty.address,
        isAllowed: true,
        nonce,
        expiry: expiry + 100, // altered expiry
        signature,
      }),
      'BadSignatory()'
    );

    expect(await comet.userNonce(albert.address)).to.equal(nonce);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
  }
);

scenario(
  'Comet#allowBySig > fails if signature contains invalid nonce',
  {},
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const nonce = await comet.userNonce(albert.address);
    const invalidNonce = nonce.add(1);
    const expiry = (await world.timestamp()) + 10;

    const signature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce: invalidNonce,
      expiry,
      chainId: await world.chainId(),
    });

    await expectRevertCustom(
      betty.allowBySig({
        owner: albert.address,
        manager: betty.address,
        isAllowed: true,
        nonce: invalidNonce,
        expiry,
        signature,
      }),
      'BadNonce()'
    );

    expect(await comet.userNonce(albert.address)).to.equal(nonce);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
  }
);

scenario(
  'Comet#allowBySig > rejects a repeated message',
  {},
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const nonce = await comet.userNonce(albert.address);
    const expiry = (await world.timestamp()) + 10_000;

    const signature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      chainId: await world.chainId(),
    });

    // valid call
    await betty.allowBySig({
      owner: albert.address,
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      signature,
    });

    // repeated callRevertCustom
    await expectRevertCustom(
      betty.allowBySig({
        owner: albert.address,
        manager: betty.address,
        isAllowed: true,
        nonce,
        expiry,
        signature,
      }),
      'BadNonce()'
    );

    expect(await comet.userNonce(albert.address)).to.equal(nonce.add(1));
  }
);

scenario(
  'Comet#allowBySig > fails for invalid expiry',
  {},
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const nonce = await comet.userNonce(albert.address);
    const invalidExpiry = (await world.timestamp()) - 1;

    const signature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry: invalidExpiry,
      chainId: await world.chainId(),
    });

    await expectRevertCustom(
      betty.allowBySig({
        owner: albert.address,
        manager: betty.address,
        isAllowed: true,
        nonce,
        expiry: invalidExpiry,
        signature,
      }),
      'SignatureExpired()'
    );

    expect(await comet.userNonce(albert.address)).to.equal(nonce);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
  }
);

scenario(
  'Comet#allowBySig > fails if v not in {27,28}',
  {},
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const nonce = await comet.userNonce(albert.address);
    const expiry = (await world.timestamp()) + 10;

    const signature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      chainId: await world.chainId(),
    });

    signature.v = 26;

    await expectRevertCustom(
      betty.allowBySig({
        owner: albert.address,
        manager: betty.address,
        isAllowed: true,
        nonce,
        expiry,
        signature,
      }),
      'InvalidValueV()'
    );

    expect(await comet.userNonce(albert.address)).to.equal(nonce);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
  }
);

scenario(
  'Comet#allowBySig > fails if s is too high',
  {},
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const nonce = await comet.userNonce(albert.address);
    const expiry = (await world.timestamp()) + 10;

    const signature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      chainId: await world.chainId(),
    });

    // 1 greater than the max value of s
    signature.s = '0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A1';

    await expectRevertCustom(
      betty.allowBySig({
        owner: albert.address,
        manager: betty.address,
        isAllowed: true,
        nonce,
        expiry,
        signature,
      }),
      'InvalidValueS()'
    );

    expect(await comet.userNonce(albert.address)).to.equal(nonce);
    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
  }
);

scenario(
  'Comet#allowBySig > increments user nonce after a successful authorization',
  {},
  async ({ comet, actors }, _context, world) => {
    const { albert, betty, charles } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const nonce = await comet.userNonce(albert.address);
    const expiry = (await world.timestamp()) + 1_000;

    const signature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      chainId: await world.chainId(),
    });

    // Any relayer can submit a valid authorization; msg.sender is not part of the signed payload.
    const txn = await charles.allowBySig({
      owner: albert.address,
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      signature,
    });

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.true;
    expect(await comet.userNonce(albert.address)).to.equal(nonce.add(1));

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#allowBySig > allows a user to rescind authorization by signature',
  {},
  async ({ comet, actors }, _context, world) => {
    const { albert, betty } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const chainId = await world.chainId();
    const initialNonce = await comet.userNonce(albert.address);
    const allowExpiry = (await world.timestamp()) + 1_000;

    const allowSignature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce: initialNonce,
      expiry: allowExpiry,
      chainId,
    });

    await betty.allowBySig({
      owner: albert.address,
      manager: betty.address,
      isAllowed: true,
      nonce: initialNonce,
      expiry: allowExpiry,
      signature: allowSignature,
    });

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.true;

    const revokeNonce = await comet.userNonce(albert.address);
    const revokeExpiry = (await world.timestamp()) + 1_000;

    const revokeSignature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: false,
      nonce: revokeNonce,
      expiry: revokeExpiry,
      chainId,
    });

    const txn = await betty.allowBySig({
      owner: albert.address,
      manager: betty.address,
      isAllowed: false,
      nonce: revokeNonce,
      expiry: revokeExpiry,
      signature: revokeSignature,
    });

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
    expect(await comet.userNonce(albert.address)).to.equal(revokeNonce.add(1));

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#allowBySig > fails if owner is zero address',
  {},
  async ({ comet, actors }, _context, world) => {
    const { betty } = actors;

    expect(await comet.isAllowed(constants.AddressZero, betty.address)).to.be.false;

    const invalidSignature = {
      v: 27,
      r: '0x0000000000000000000000000000000000000000000000000000000000000000',
      s: '0x36b99b3646118e24ca7c0c698792ebaf25a4bfa08c1cd6778c335a537b0eb43c',
    } as any;

    await expectRevertCustom(
      betty.allowBySig({
        owner: constants.AddressZero,
        manager: betty.address,
        isAllowed: true,
        nonce: await comet.userNonce(constants.AddressZero),
        expiry: (await world.timestamp()) + 100,
        signature: invalidSignature,
      }),
      'BadSignatory()'
    );

    expect(await comet.isAllowed(constants.AddressZero, betty.address)).to.be.false;
  }
);

scenario(
  'Comet#allowBySig > fails if signature was signed for a different chain id',
  {},
  async ({ comet, actors }, _context, world) => {
    const { albert, betty } = actors;

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;

    const chainId = await world.chainId();
    const nonce = await comet.userNonce(albert.address);
    const expiry = (await world.timestamp()) + 1_000;

    const signature = await albert.signAuthorization({
      manager: betty.address,
      isAllowed: true,
      nonce,
      expiry,
      chainId: chainId + 1,
    });

    await expectRevertCustom(
      betty.allowBySig({
        owner: albert.address,
        manager: betty.address,
        isAllowed: true,
        nonce,
        expiry,
        signature,
      }),
      'BadSignatory()'
    );

    expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
    expect(await comet.userNonce(albert.address)).to.equal(nonce);
  }
);

scenario(
  'Comet#allowBySig > authorized manager can supplyFrom base on behalf of owner',
  {
    tokenBalances: {
      albert: { $base: 100 }, // in units of asset, not wei
    },
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const scale = (await comet.baseScale()).toBigInt();
    const toSupply = 100n * scale;

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(toSupply);
    expect(await comet.balanceOf(betty.address)).to.be.equal(0n);

    await baseAsset.approve(albert, comet.address);
    await authorizeManagerBySig(context, albert, betty, world);

    // Betty supplies Albert's base into Betty's own account
    const txn = await betty.supplyAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: toSupply });

    expect(await baseAsset.balanceOf(albert.address)).to.be.equal(0n);
    expectApproximately(await betty.getCometBaseBalance(), toSupply, scale / 1_000_000n);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#allowBySig > authorized manager can supplyFrom collateral on behalf of owner',
  {
    filter: async (ctx) => await isValidAssetIndex(ctx, 0) && await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx, 0).supplyCollateral),
    tokenBalances: async (ctx) => (
      {
        albert: { $asset0: getConfigForScenario(ctx, 0).supplyCollateral }
      }
    ),
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;
    const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(assetAddress);
    const scale = scaleBN.toBigInt();
    const toSupply = BigInt(getConfigForScenario(context, 0).supplyCollateral) * scale;

    expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(toSupply);
    expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(0n);

    await collateralAsset.approve(albert, comet.address);
    await authorizeManagerBySig(context, albert, betty, world);

    // Betty supplies Albert's collateral into Betty's own account
    const txn = await betty.supplyAssetFrom({ src: albert.address, dst: betty.address, asset: collateralAsset.address, amount: toSupply });

    expect(await collateralAsset.balanceOf(albert.address)).to.be.equal(0n);
    expect(await comet.collateralBalanceOf(betty.address, collateralAsset.address)).to.be.equal(toSupply);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#allowBySig > authorized manager can withdrawFrom base on behalf of owner',
  {
    cometBalances: {
      albert: { $base: 2 }, // in units of asset, not wei
    },
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;
    const baseAssetAddress = await comet.baseToken();
    const baseAsset = context.getAssetByAddress(baseAssetAddress);
    const baseSupplied = (await comet.balanceOf(albert.address)).toBigInt();

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(0n);
    expect(await comet.balanceOf(albert.address)).to.be.equal(baseSupplied);

    await authorizeManagerBySig(context, albert, betty, world);

    // Betty withdraws Albert's supplied base to Betty
    const txn = await betty.withdrawAssetFrom({ src: albert.address, dst: betty.address, asset: baseAsset.address, amount: baseSupplied });

    expect(await baseAsset.balanceOf(betty.address)).to.be.equal(baseSupplied);
    expect(await comet.balanceOf(albert.address)).to.be.lessThan(baseSupplied / 100n);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#allowBySig > authorized manager can withdrawFrom collateral on behalf of owner',
  {
    filter: async (ctx) => await isValidAssetIndex(ctx, 0) && await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx, 0).withdrawCollateral),
    cometBalances: async (ctx) => (
      {
        albert: { $asset0: getConfigForScenario(ctx, 0).withdrawCollateral }
      }
    ),
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;
    const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(assetAddress);
    const scale = scaleBN.toBigInt();
    const toWithdraw = BigInt(getConfigForScenario(context, 0).withdrawCollateral) * scale;

    expect(await collateralAsset.balanceOf(betty.address)).to.be.equal(0n);
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(toWithdraw);

    await authorizeManagerBySig(context, albert, betty, world);

    // Betty withdraws Albert's collateral to Betty
    const txn = await betty.withdrawAssetFrom({ src: albert.address, dst: betty.address, asset: collateralAsset.address, amount: toWithdraw });

    expect(await collateralAsset.balanceOf(betty.address)).to.be.equal(toWithdraw);
    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(0n);

    return txn; // return txn to measure gas
  }
);

scenario(
  'Comet#allowBySig > authorized manager can transferAssetFrom collateral on behalf of owner',
  {
    filter: async (ctx) => await isValidAssetIndex(ctx, 0) && await isTriviallySourceable(ctx, 0, getConfigForScenario(ctx, 0).transferCollateral),
    cometBalances: async (ctx) => (
      {
        albert: { $asset0: getConfigForScenario(ctx, 0).transferCollateral }
      }
    ),
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty, charles } = actors;
    const { asset: assetAddress, scale: scaleBN } = await comet.getAssetInfo(0);
    const collateralAsset = context.getAssetByAddress(assetAddress);
    const scale = scaleBN.toBigInt();
    const supplied = BigInt(getConfigForScenario(context, 0).transferCollateral) * scale;
    const toTransfer = supplied / 2n;

    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(supplied);
    expect(await comet.collateralBalanceOf(charles.address, collateralAsset.address)).to.be.equal(0n);

    // Albert authorizes Betty by signature; Betty moves Albert's collateral to Charles
    await authorizeManagerBySig(context, albert, betty, world);

    const txn = await betty.transferAssetFrom({ src: albert.address, dst: charles.address, asset: collateralAsset.address, amount: toTransfer });

    expect(await comet.collateralBalanceOf(albert.address, collateralAsset.address)).to.be.equal(supplied - toTransfer);
    expect(await comet.collateralBalanceOf(charles.address, collateralAsset.address)).to.be.equal(toTransfer);

    return txn; // return txn to measure gas
  }
);
