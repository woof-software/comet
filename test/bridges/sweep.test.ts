import { ethers, exp, expect } from '../helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction, utils } from 'ethers';
import {
  FaucetToken,
  FaucetToken__factory,
  NonStandardFaucetToken,
  NonStandardFaucetToken__factory,
  SweepableBridgeReceiverHarness,
  Timelock,
} from '../../build/types';
import { impersonateAccount, setBalance } from '../helpers/network-helpers';
import { takeSnapshot, SnapshotRestorer } from '../helpers/snapshot';
import { deploySweepableBridgeReceiverFixture, encodeProposal } from './shared';

// sweepToken and sweepNativeToken send the receiver's whole balance of an ERC-20 token or of the native token to a
// recipient, to recover funds sent to it by accident. sweepToken handles standard tokens and non-standard ones whose
// transfer returns nothing. Only the local timelock calls them, through a proposal.
describe('sweepable bridge receiver: sweepToken and sweepNativeToken', function () {
  let receiver: SweepableBridgeReceiverHarness;
  let localTimelock: Timelock;
  let govTimelock: SignerWithAddress;
  let other: SignerWithAddress;
  let usdc: FaucetToken;
  let usdt: NonStandardFaucetToken;

  // Amounts sent to the receiver by accident
  const tokenAmount = exp(10, 6);
  const nativeAmount = exp(1, 18);

  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ receiver, localTimelock, govTimelock, other } = await deploySweepableBridgeReceiverFixture());
    const FaucetFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
    usdc = await FaucetFactory.deploy(1e6, 'USDC', 6, 'USDC');
    const NonStandardFaucetFactory = (await ethers.getContractFactory('NonStandardFaucetToken')) as NonStandardFaucetToken__factory;
    usdt = await NonStandardFaucetFactory.deploy(1000e6, 'Tether', 6, 'USDT');
    snapshot = await takeSnapshot();
  });

  describe('sweepToken', function () {
    [
      { kind: 'standard ERC-20', token: () => usdc },
      { kind: 'non-standard ERC-20', token: () => usdt },
    ].forEach(({ kind, token }) => {
      describe(`happy path (${kind})`, function () {
        let sweepTx: ContractTransaction;

        // The proposal sweeps the token to the local timelock
        before(async () => {
          await token().allocateTo(other.address, tokenAmount);
          await token().connect(other).transfer(receiver.address, tokenAmount);
          await receiver.processMessageExternal(govTimelock.address, encodeProposal([{
            target: receiver.address,
            signature: 'sweepToken(address,address)',
            calldata: utils.defaultAbiCoder.encode(['address', 'address'], [localTimelock.address, token().address]),
          }]));
          const { eta } = await receiver.proposals(1);
          await ethers.provider.send('evm_setNextBlockTimestamp', [eta.toNumber()]);
        });

        after(async () => await snapshot.restore());

        it('a proposal sweeps the token', async () => {
          sweepTx = await receiver.executeProposal(1);
          await expect(sweepTx).to.not.be.reverted;
        });

        it('takes the amount from the receiver', async () => {
          await expect(sweepTx).to.changeTokenBalance(token(), receiver, -tokenAmount);
        });

        it('sends the amount to the recipient', async () => {
          await expect(sweepTx).to.changeTokenBalance(token(), localTimelock, tokenAmount);
        });
      });
    });

    describe('revert when', function () {
      it('the caller is not the local timelock', async () => {
        await expect(receiver.connect(other).sweepToken(other.address, usdc.address))
          .to.be.revertedWithCustomError(receiver, 'Unauthorized');
      });
    });
  });

  describe('sweepNativeToken', function () {
    describe('happy path', function () {
      let sweepTx: ContractTransaction;

      // The proposal sweeps the native token to the local timelock
      before(async () => {
        await other.sendTransaction({ to: receiver.address, value: nativeAmount });
        await receiver.processMessageExternal(govTimelock.address, encodeProposal([{
          target: receiver.address,
          signature: 'sweepNativeToken(address)',
          calldata: utils.defaultAbiCoder.encode(['address'], [localTimelock.address]),
        }]));
        const { eta } = await receiver.proposals(1);
        await ethers.provider.send('evm_setNextBlockTimestamp', [eta.toNumber()]);
      });

      after(async () => await snapshot.restore());

      it('a proposal sweeps the native token', async () => {
        sweepTx = await receiver.executeProposal(1);
        await expect(sweepTx).to.not.be.reverted;
      });

      it('takes the amount from the receiver', async () => {
        await expect(sweepTx).to.changeEtherBalance(receiver, -nativeAmount);
      });

      it('sends the amount to the recipient', async () => {
        await expect(sweepTx).to.changeEtherBalance(localTimelock, nativeAmount);
      });
    });

    describe('revert when', function () {
      it('the caller is not the local timelock', async () => {
        await expect(receiver.connect(other).sweepNativeToken(other.address))
          .to.be.revertedWithCustomError(receiver, 'Unauthorized');
      });

      // Called by the local timelock directly: through a proposal, the Timelock replaces the error with its own message
      it('the recipient rejects the native token', async () => {
        const FaucetFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
        const recipientWithoutFallback = await FaucetFactory.deploy(0, 'USDC', 6, 'USDC');
        await impersonateAccount(localTimelock.address);
        await setBalance(localTimelock.address, exp(1, 18));
        const localTimelockSigner = await ethers.getSigner(localTimelock.address);
        await expect(receiver.connect(localTimelockSigner).sweepNativeToken(recipientWithoutFallback.address))
          .to.be.revertedWithCustomError(receiver, 'FailedToSendNativeToken');
      });
    });
  });
});
