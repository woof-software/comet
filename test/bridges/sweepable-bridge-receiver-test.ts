import { AbiCoder } from 'ethers';

import { ethers, exp, expect, wait } from './../helpers.js';
import {
  SweepableBridgeReceiverHarness__factory,
  FaucetToken__factory,
  NonStandardFaucetToken__factory,
} from '../../build/types/index.js';
import type { SweepableBridgeReceiverHarness, Timelock } from '../../build/types/index.js';
import { encodeBridgeReceiverCalldata, makeTimelock } from './base-bridge-receiver-test.js';

const abiCoder = AbiCoder.defaultAbiCoder();

async function makeSweepableBridgeReceiver({ initialize } = { initialize: true }) {
  const [_defaultSigner, govTimelockAdmin, ...signers] = await ethers.getSigners();

  const SweepableBridgeReceiverFactory = new SweepableBridgeReceiverHarness__factory(_defaultSigner);
  const sweepableBridgeReceiver = await SweepableBridgeReceiverFactory.deploy();
  await sweepableBridgeReceiver.waitForDeployment();

  const govTimelock = await makeTimelock({ admin: govTimelockAdmin.address });
  const sweepableBridgeReceiverAddress = await sweepableBridgeReceiver.getAddress();
  const govTimelockAddress = await govTimelock.getAddress();
  const localTimelock = await makeTimelock({ admin: sweepableBridgeReceiverAddress });
  const localTimelockAddress = await localTimelock.getAddress();

  if (initialize) {
    await sweepableBridgeReceiver.initialize(
      govTimelockAddress,   // govTimelock
      localTimelockAddress  // localTimelock
    );
  }

  return {
    sweepableBridgeReceiver,
    govTimelock,
    localTimelock,
    signers
  };
}

async function makeFaucetToken(initialAmount: number, name: string, decimals: number, symbol: string) {
  const [deployer] = await ethers.getSigners();
  const FaucetFactory = new FaucetToken__factory(deployer);
  const token = await FaucetFactory.deploy(initialAmount, name, decimals, symbol);
  await token.waitForDeployment();

  return token;
}

async function proposeAndExecute(
  sweepableBridgeReceiver: SweepableBridgeReceiverHarness,
  govTimelock: Timelock,
  { targets, values, signatures, calldatas }: { targets: string[]; values: number[]; signatures: string[]; calldatas: string[] }
) {
  // enqueue proposal to sweep tokens
  const calldata = encodeBridgeReceiverCalldata({
    targets,
    values,
    signatures,
    calldatas
  });
  await sweepableBridgeReceiver.processMessageExternal(await govTimelock.getAddress(), calldata);

  // execute proposal to sweep tokens
  const { eta } = await sweepableBridgeReceiver.proposals(1);
  await ethers.provider.send('evm_setNextBlockTimestamp', [Number(eta)]);
  await wait(sweepableBridgeReceiver.executeProposal(1));
}

describe('SweepableBridgeReceiver', async() => {
  it('sweeps standard ERC20 token', async () => {
    const { sweepableBridgeReceiver, localTimelock, govTimelock, signers } = await makeSweepableBridgeReceiver();
    const [alice] = signers;
    const sweepableBridgeReceiverAddress = await sweepableBridgeReceiver.getAddress();
    const localTimelockAddress = await localTimelock.getAddress();

    const USDC = await makeFaucetToken(1e6, 'USDC', 6, 'USDC');
    const usdcAddress = await USDC.getAddress();

    // Alice "accidentally" sends 10 USDC to the SweepableBridgeReceiver
    const transferAmount = exp(10, 6);
    await USDC.allocateTo(alice.address, transferAmount);
    await USDC.connect(alice).transfer(sweepableBridgeReceiverAddress, transferAmount);

    const oldBridgeReceiverBalance = await USDC.balanceOf(sweepableBridgeReceiverAddress);
    const oldTimelockBalance = await USDC.balanceOf(localTimelockAddress);

    await proposeAndExecute(
      sweepableBridgeReceiver,
      govTimelock,
      {
        targets: [sweepableBridgeReceiverAddress],
        values: [0],
        signatures: ['sweepToken(address,address)'],
        calldatas: [
          abiCoder.encode(['address', 'address'], [localTimelockAddress, usdcAddress]),
        ]
      }
    );

    const newBridgeReceiverBalance = await USDC.balanceOf(sweepableBridgeReceiverAddress);
    const newTimelockBalance = await USDC.balanceOf(localTimelockAddress);

    expect(newBridgeReceiverBalance - oldBridgeReceiverBalance).to.be.equal(-transferAmount);
    expect(newTimelockBalance - oldTimelockBalance).to.be.equal(transferAmount);
  });

  it('sweeps non-standard ERC20 token', async () => {
    const { sweepableBridgeReceiver, localTimelock, govTimelock, signers } = await makeSweepableBridgeReceiver();
    const [alice] = signers;
    const [deployer] = await ethers.getSigners();
    const sweepableBridgeReceiverAddress = await sweepableBridgeReceiver.getAddress();
    const localTimelockAddress = await localTimelock.getAddress();

    // Deploy non-standard token
    const NonStandardFaucetFactory = new NonStandardFaucetToken__factory(deployer);
    const nonStandardToken = await NonStandardFaucetFactory.deploy(1000e6, 'Tether', 6, 'USDT');
    await nonStandardToken.waitForDeployment();
    const nonStandardTokenAddress = await nonStandardToken.getAddress();

    // Alice "accidentally" sends 10 non-standard tokens to the Bulker
    const transferAmount = exp(10, 6);
    await nonStandardToken.allocateTo(alice.address, transferAmount);
    await nonStandardToken.connect(alice).transfer(sweepableBridgeReceiverAddress, transferAmount);

    const oldBridgeReceiverBalance = await nonStandardToken.balanceOf(sweepableBridgeReceiverAddress);
    const oldTimelockBalance = await nonStandardToken.balanceOf(localTimelockAddress);

    await proposeAndExecute(
      sweepableBridgeReceiver,
      govTimelock,
      {
        targets: [sweepableBridgeReceiverAddress],
        values: [0],
        signatures: ['sweepToken(address,address)'],
        calldatas: [
          abiCoder.encode(['address', 'address'], [localTimelockAddress, nonStandardTokenAddress]),
        ]
      }
    );

    const newBridgeReceiverBalance = await nonStandardToken.balanceOf(sweepableBridgeReceiverAddress);
    const newTimelockBalance = await nonStandardToken.balanceOf(localTimelockAddress);

    expect(newBridgeReceiverBalance - oldBridgeReceiverBalance).to.be.equal(-transferAmount);
    expect(newTimelockBalance - oldTimelockBalance).to.be.equal(transferAmount);
  });

  it('sweeps native token', async () => {
    const { sweepableBridgeReceiver, localTimelock, govTimelock, signers } = await makeSweepableBridgeReceiver();
    const [alice] = signers;
    const sweepableBridgeReceiverAddress = await sweepableBridgeReceiver.getAddress();
    const localTimelockAddress = await localTimelock.getAddress();

    // Alice "accidentally" sends 1 ETH to the sweepableBridgeReceiver
    const transferAmount = exp(1, 18);
    await alice.sendTransaction({ to: sweepableBridgeReceiverAddress, value: transferAmount });

    const oldBridgeReceiverBalance = await ethers.provider.getBalance(sweepableBridgeReceiverAddress);
    const oldTimelockBalance = await ethers.provider.getBalance(localTimelockAddress);

    await proposeAndExecute(
      sweepableBridgeReceiver,
      govTimelock,
      {
        targets: [sweepableBridgeReceiverAddress],
        values: [0],
        signatures: ['sweepNativeToken(address)'],
        calldatas: [
          abiCoder.encode(['address'], [localTimelockAddress]),
        ]
      }
    );

    const newBridgeReceiverBalance = await ethers.provider.getBalance(sweepableBridgeReceiverAddress);
    const newTimelockBalance = await ethers.provider.getBalance(localTimelockAddress);

    expect(newBridgeReceiverBalance - oldBridgeReceiverBalance).to.be.equal(-transferAmount);
    expect(newTimelockBalance - oldTimelockBalance).to.be.equal(transferAmount);
  });

  it('reverts if sweepToken is called by address other than local timelock', async () => {
    const { sweepableBridgeReceiver, signers } = await makeSweepableBridgeReceiver();
    const [alice] = signers;

    const USDC = await makeFaucetToken(1e6, 'USDC', 6, 'USDC');
    const usdcAddress = await USDC.getAddress();

    // Alice sweeps tokens
    await expect(sweepableBridgeReceiver.connect(alice).sweepToken(alice.address, usdcAddress))
      .to.be.revertedWithCustomError(sweepableBridgeReceiver, 'Unauthorized');
  });

  it('reverts if sweepNativeToken is called by non-admin', async () => {
    const { sweepableBridgeReceiver, signers } = await makeSweepableBridgeReceiver();
    const [alice] = signers;

    // Alice sweeps ETH
    await expect(sweepableBridgeReceiver.connect(alice).sweepNativeToken(alice.address))
      .to.be.revertedWithCustomError(sweepableBridgeReceiver, 'Unauthorized');
  });
});
