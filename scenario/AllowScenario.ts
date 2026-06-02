import { scenario } from './context/CometContext';
import { event, expect } from '../test/helpers';
import { expectRevertCustom } from './utils';
import { constants } from 'ethers';

scenario('Comet#allow > has default permission state', {}, async ({ comet, actors }) => {
  const { albert, betty } = actors;

  expect(await comet.isAllowed(albert.address, betty.address)).to.be.false;
  expect(await comet.hasPermission(albert.address, albert.address)).to.be.true;
  expect(await comet.hasPermission(albert.address, betty.address)).to.be.false;
  expect(await comet.allowance(albert.address, betty.address)).to.be.equal(0);
});

scenario('Comet#allow > allows a user to authorize a manager', {}, async ({ comet, actors }, context) => {
  const { albert, betty } = actors;

  await context.world.deploymentManager.hre.network.provider.send('evm_mine', []);

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
