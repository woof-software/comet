import { scenario } from './context/CometContext.js';
import { expectRevertCustom } from './utils/index.js';
import { expect } from 'chai';
import { MaxUint256 } from 'ethers';

scenario('Comet#approveThis > allows governor to authorize and rescind authorization for Comet ERC20', {}, async ({ comet, timelock, actors }, context) => {
  const { admin } = actors;
  const cometAddress = await comet.getAddress();
  const timelockAddress = await timelock.getAddress();

  await context.setNextBaseFeeToZero();
  await admin.approveThis(timelockAddress, cometAddress, MaxUint256, { gasPrice: 0 });

  expect(await comet.isAllowed(cometAddress, timelockAddress)).to.be.true;

  await context.setNextBaseFeeToZero();
  await admin.approveThis(timelockAddress, cometAddress, 0n, { gasPrice: 0 });

  expect(await comet.isAllowed(cometAddress, timelockAddress)).to.be.false;
});

scenario('Comet#approveThis > allows governor to authorize and rescind authorization for non-Comet ERC20', {}, async ({ comet, timelock, actors }, context) => {
  const { admin } = actors;
  const baseTokenAddress = await comet.baseToken();
  const baseToken = context.getAssetByAddress(baseTokenAddress);
  const cometAddress = await comet.getAddress();
  const timelockAddress = await timelock.getAddress();

  const newAllowance = 999_888n;
  await context.setNextBaseFeeToZero();
  await admin.approveThis(timelockAddress, baseTokenAddress, newAllowance, { gasPrice: 0 });

  expect(await baseToken.allowance(cometAddress, timelockAddress)).to.be.equal(newAllowance);

  await context.setNextBaseFeeToZero();
  await admin.approveThis(timelockAddress, baseTokenAddress, 0n, { gasPrice: 0 });

  expect(await baseToken.allowance(cometAddress, timelockAddress)).to.be.equal(0n);
});

scenario('Comet#approveThis > reverts if not called by governor', {}, async ({ comet, timelock }) => {
  await expectRevertCustom(comet.approveThis(await timelock.getAddress(), await comet.getAddress(), MaxUint256), 'Unauthorized()');
});
