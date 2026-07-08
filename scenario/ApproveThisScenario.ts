import { scenario } from './context/CometContext';
import { expectRevertCustom } from './utils';
import { expect } from 'chai';
import { constants } from 'ethers';

scenario('Comet#approveThis > allows governor to authorize and rescind authorization for Comet ERC20', {}, async ({ comet, actors }, context) => {
  const { admin, albert, betty } = actors;
  const manager = betty.address;

  expect(await comet.isAllowed(comet.address, manager)).to.be.false;
  expect(await comet.hasPermission(comet.address, manager)).to.be.false;
  expect(await comet.allowance(comet.address, manager)).to.be.equal(0);

  await context.setNextBaseFeeToZero();
  await admin.approveThis(manager, comet.address, constants.MaxUint256, { gasPrice: 0 });

  expect(await comet.isAllowed(comet.address, manager)).to.be.true;
  expect(await comet.hasPermission(comet.address, manager)).to.be.true;
  expect(await comet.allowance(comet.address, manager)).to.be.equal(constants.MaxUint256);
  expect(await comet.isAllowed(admin.address, manager)).to.be.false;
  expect(await comet.hasPermission(admin.address, manager)).to.be.false;
  expect(await comet.isAllowed(albert.address, manager)).to.be.false;
  expect(await comet.hasPermission(albert.address, manager)).to.be.false;

  await context.setNextBaseFeeToZero();
  await admin.approveThis(manager, comet.address, 0, { gasPrice: 0 });

  expect(await comet.isAllowed(comet.address, manager)).to.be.false;
  expect(await comet.hasPermission(comet.address, manager)).to.be.false;
  expect(await comet.allowance(comet.address, manager)).to.be.equal(0);
});

scenario('Comet#approveThis > allows governor to authorize and rescind authorization for non-Comet ERC20', {}, async ({ comet, actors }, context) => {
  const { admin, betty } = actors;
  const manager = betty.address;
  const baseTokenAddress = await comet.baseToken();
  const baseToken = context.getAssetByAddress(baseTokenAddress);

  expect(await baseToken.allowance(comet.address, manager)).to.be.equal(0n);
  expect(await comet.isAllowed(comet.address, manager)).to.be.false;
  expect(await comet.hasPermission(comet.address, manager)).to.be.false;

  const newAllowance = 999_888n;
  await context.setNextBaseFeeToZero();
  await admin.approveThis(manager, baseTokenAddress, newAllowance, { gasPrice: 0 });

  expect(await baseToken.allowance(comet.address, manager)).to.be.equal(newAllowance);
  expect(await comet.isAllowed(comet.address, manager)).to.be.false;
  expect(await comet.hasPermission(comet.address, manager)).to.be.false;

  await context.setNextBaseFeeToZero();
  await admin.approveThis(manager, baseTokenAddress, 0, { gasPrice: 0 });

  expect(await baseToken.allowance(comet.address, manager)).to.be.equal(0n);
  expect(await comet.isAllowed(comet.address, manager)).to.be.false;
  expect(await comet.hasPermission(comet.address, manager)).to.be.false;
});

scenario(
  'Comet#approveThis > allows authorized manager to withdraw from Comet account and blocks them after revoke',
  {
    tokenBalances: {
      albert: {
        $base: 2,
      },
    },
  },
  async ({ comet, actors }, context) => {
    const { admin, albert, betty } = actors;
    const baseTokenAddress = await comet.baseToken();
    const baseToken = context.getAssetByAddress(baseTokenAddress);
    const baseScale = (await comet.baseScale()).toBigInt();
    const supplyAmount = 2n * baseScale;

    await baseToken.approve(albert, comet.address);
    await albert.supplyAssetFrom({ src: albert.address, dst: comet.address, asset: baseToken.address, amount: supplyAmount });

    const cometBaseBalance = (await comet.balanceOf(comet.address)).toBigInt();
    expect(cometBaseBalance).to.be.greaterThan(0n);
    expect(await comet.hasPermission(comet.address, betty.address)).to.be.false;

    await context.setNextBaseFeeToZero();
    await admin.approveThis(betty.address, comet.address, constants.MaxUint256, { gasPrice: 0 });

    expect(await comet.hasPermission(comet.address, betty.address)).to.be.true;

    const withdrawAmount = cometBaseBalance / 2n;
    await betty.withdrawAssetFrom({ src: comet.address, dst: betty.address, asset: baseToken.address, amount: withdrawAmount });

    expect(await baseToken.balanceOf(betty.address)).to.be.equal(withdrawAmount);
    expect((await comet.balanceOf(comet.address)).toBigInt()).to.be.lessThan(cometBaseBalance);

    await context.setNextBaseFeeToZero();
    await admin.approveThis(betty.address, comet.address, 0, { gasPrice: 0 });

    expect(await comet.hasPermission(comet.address, betty.address)).to.be.false;
    await expectRevertCustom(
      betty.withdrawAssetFrom({ src: comet.address, dst: betty.address, asset: baseToken.address, amount: 1n }),
      'Unauthorized()'
    );
  }
);

scenario('Comet#approveThis > leaves Comet ERC20 state unchanged when revoking an already-disallowed manager', {}, async ({ comet, actors }, context) => {
  const { admin, betty } = actors;
  const manager = betty.address;

  expect(await comet.isAllowed(comet.address, manager)).to.be.false;
  expect(await comet.hasPermission(comet.address, manager)).to.be.false;
  expect(await comet.allowance(comet.address, manager)).to.be.equal(0);

  await context.setNextBaseFeeToZero();
  await admin.approveThis(manager, comet.address, 0, { gasPrice: 0 });

  expect(await comet.isAllowed(comet.address, manager)).to.be.false;
  expect(await comet.hasPermission(comet.address, manager)).to.be.false;
  expect(await comet.allowance(comet.address, manager)).to.be.equal(0);
});

scenario('Comet#approveThis > reverts if Comet ERC20 amount is not 0 or uint256.max', {}, async ({ comet, actors }, context) => {
  const { admin, betty } = actors;
  const manager = betty.address;

  expect(await comet.isAllowed(comet.address, manager)).to.be.false;
  expect(await comet.hasPermission(comet.address, manager)).to.be.false;
  expect(await comet.allowance(comet.address, manager)).to.be.equal(0);

  await context.setNextBaseFeeToZero();
  await expectRevertCustom(
    admin.approveThis(manager, comet.address, 300, { gasPrice: 0 }),
    'BadAmount()'
  );
});

scenario('Comet#approveThis > reverts if non-governor tries to approve Comet ERC20', {}, async ({ comet, actors }) => {
  const { albert, betty } = actors;
  const manager = betty.address;

  expect(await comet.isAllowed(comet.address, manager)).to.be.false;
  expect(await comet.hasPermission(comet.address, manager)).to.be.false;
  expect(await comet.allowance(comet.address, manager)).to.be.equal(0);

  await expectRevertCustom(albert.approveThis(manager, comet.address, constants.MaxUint256), 'Unauthorized()');
});

scenario('Comet#approveThis > reverts if non-governor tries to approve non-Comet ERC20', {}, async ({ comet, actors }, context) => {
  const { albert, betty } = actors;
  const manager = betty.address;
  const baseTokenAddress = await comet.baseToken();
  const baseToken = context.getAssetByAddress(baseTokenAddress);

  expect(await baseToken.allowance(comet.address, manager)).to.be.equal(0n);
  expect(await comet.isAllowed(comet.address, manager)).to.be.false;
  expect(await comet.hasPermission(comet.address, manager)).to.be.false;

  await expectRevertCustom(albert.approveThis(manager, baseTokenAddress, 123n), 'Unauthorized()');
});
