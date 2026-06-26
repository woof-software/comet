import { ethers, exp, expect, makeProtocol } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, LiquidationModule, LiquidationModule__factory } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';
import { setBalance } from '../helpers';

describe('core liquidation module', function () {
  const DEX_ADAPTER = '0x1111111111111111111111111111111111111111';
  const BORDER_HF: bigint = exp(102, 16); // 1.02e18
  const HEALTH_POSITION_HF: bigint = exp(110, 16); // 1.10e18
  const PENALTY_BPS: bigint = BigInt(500);

  // liquidationModeToggle is gated by OZ AccessControl's PAUSER_ROLE.
  const PAUSER_ROLE = ethers.utils.id('PAUSER_ROLE');
  const missingRole = (account: string, role: string) =>
    `AccessControl: account ${account.toLowerCase()} is missing role ${role}`;

  let comet: CometHarnessInterfaceExtendedAssetList;
  let liquidationModule: LiquidationModule;

  let governor: SignerWithAddress;
  let pauser: SignerWithAddress;
  let alice: SignerWithAddress;

  let snapshot: SnapshotRestorer;

  before(async () => {
    governor = await ethers.getImpersonatedSigner("0x6d903f6003cca6255D85CcA4D3B5E5146dC33925");
    await setBalance(governor.address, ethers.utils.parseEther("10"));
    const protocol = await makeProtocol({ base: 'USDC', governor });
    comet = protocol.comet;
    liquidationModule = protocol.defaultLiquidationModule;
    pauser = protocol.pausers[0];
    [alice] = protocol.users;

    snapshot = await takeSnapshot();
  });

  context('constructor', function () {
    context('happy path', function () {
      it('sets COMET to the provided comet address', async () => {
        expect(await liquidationModule.comet()).to.equal(comet.address);
      });

      it('sets ASSET_LIST to the comet asset list', async () => {
        const cometInterface = await ethers.getContractAt('ICometInterface', comet.address);
        expect(await liquidationModule.assetList()).to.equal(await cometInterface.assetList());
      });

      it('sets NUM_ASSETS to the comet asset count', async () => {
        expect(await liquidationModule.numAssets()).to.equal(await comet.numAssets());
      });

      it('sets BASE_SCALE to the comet base scale', async () => {
        expect(await liquidationModule.baseScale()).to.equal(await comet.baseScale());
      });

      it('enables partial liquidation by default', async () => {
        expect(await liquidationModule.partialLiquidationEnabled()).to.be.true;
      });

      // TARGET_HEALTH_FACTOR is a constant 105e16 = 1.05e18 (105%).
      it('exposes a target health factor of 105%', async () => {
        expect(await liquidationModule.TARGET_HEALTH_FACTOR()).to.equal(exp(1.05, 18));
      });
    });
  });

  context('liquidationModeToggle', function () {
    context('when partial liquidation is enabled (default state)', function () {
      let toggleTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('multisig toggles partialLiquidationEnabled from true to false', async () => {
        toggleTx = await liquidationModule.connect(pauser).liquidationModeToggle(false);
        await expect(toggleTx).to.not.be.reverted;
      });

      it('emits LiquidationModeToggled with the new value', async () => {
        await expect(toggleTx).to.emit(liquidationModule, 'LiquidationModeToggled').withArgs(false);
      });

      it('partialLiquidationEnabled is now false', async () => {
        expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
      });
    });

    context('when partial liquidation is disabled', function () {
      let toggleTx: ContractTransaction;

      before(async () => {
        // Establish the disabled precondition so the toggle under test flips it back on.
        await liquidationModule.connect(pauser).liquidationModeToggle(false);
      });

      after(async () => await snapshot.restore());

      it('multisig toggles partialLiquidationEnabled from false to true', async () => {
        toggleTx = await liquidationModule.connect(pauser).liquidationModeToggle(true);
        await expect(toggleTx).to.not.be.reverted;
      });

      it('emits LiquidationModeToggled with the new value', async () => {
        await expect(toggleTx).to.emit(liquidationModule, 'LiquidationModeToggled').withArgs(true);
      });

      it('partialLiquidationEnabled is now true', async () => {
        expect(await liquidationModule.partialLiquidationEnabled()).to.be.true;
      });
    });

    context('revert when', function () {
      after(async () => await snapshot.restore());

      it('caller is not a pauser', async () => {
        await expect(liquidationModule.connect(alice).liquidationModeToggle(false))
          .to.be.revertedWith(missingRole(alice.address, PAUSER_ROLE));
      });

      it('the wanted value is already set (true -> true)', async () => {
        await expect(liquidationModule.connect(pauser).liquidationModeToggle(true))
          .to.be.revertedWithCustomError(liquidationModule, 'LiquidationModeAlreadySet');
      });

      it('the wanted value is already set (false -> false)', async () => {
        await liquidationModule.connect(pauser).liquidationModeToggle(false);

        await expect(liquidationModule.connect(pauser).liquidationModeToggle(false))
          .to.be.revertedWithCustomError(liquidationModule, 'LiquidationModeAlreadySet');
      });
    });
  });

  context('liquidate', function () {
    context('revert when', function () {
      it('caller is not the comet', async () => {
        // sanity check 
        expect(await liquidationModule.comet()).to.not.equal(alice.address);

        await expect(liquidationModule.connect(alice)['liquidate(address,address)'](alice.address, alice.address))
          .to.be.revertedWithCustomError(liquidationModule, 'OnlyComet');
      });
    });
  });
});
