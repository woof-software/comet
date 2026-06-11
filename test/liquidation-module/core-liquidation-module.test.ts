import { ethers, exp, expect, makeProtocol } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, LiquidationModule, LiquidationModule__factory } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';

describe('core liquidation module', function () {
  const DEX_ADAPTER = '0x1111111111111111111111111111111111111111';
  const BORDER_HF: bigint = exp(102, 16); // 1.02e18
  const HEALTH_POSITION_HF: bigint = exp(110, 16); // 1.10e18

  let comet: CometHarnessInterfaceExtendedAssetList;
  let liquidationModule: LiquidationModule;

  let governor: SignerWithAddress;
  let alice: SignerWithAddress;

  let snapshot: SnapshotRestorer;

  before(async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    comet = protocol.comet;
    liquidationModule = protocol.defaultLiquidationModule;
    governor = protocol.governor;
    [alice] = protocol.users;

    snapshot = await takeSnapshot();
  });

  context('constructor', function () {
    context('happy path', function () {
      it('sets COMET to the provided comet address', async () => {
        expect(await liquidationModule.comet()).to.equal(comet.address);
      });

      it('sets ASSET_LIST to the comet asset list', async () => {
        expect(await liquidationModule.assetList()).to.equal(await comet.assetList());
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

    context('revert when', function () {
      it('comet address is zero', async () => {
        const LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;

        await expect(
          LiquidationModuleFactory.deploy(ethers.constants.AddressZero, DEX_ADAPTER, BORDER_HF, HEALTH_POSITION_HF)
        ).to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });
    });
  });

  context('liquidationModeToggle', function () {
    context('when partial liquidation is enabled (default state)', function () {
      let toggleTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('governor toggles partialLiquidationEnabled from true to false', async () => {
        toggleTx = await liquidationModule.connect(governor).liquidationModeToggle(false);
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
        await liquidationModule.connect(governor).liquidationModeToggle(false);
      });

      after(async () => await snapshot.restore());

      it('governor toggles partialLiquidationEnabled from false to true', async () => {
        toggleTx = await liquidationModule.connect(governor).liquidationModeToggle(true);
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

      it('caller is not the governor', async () => {
        await expect(liquidationModule.connect(alice).liquidationModeToggle(false))
          .to.be.revertedWithCustomError(liquidationModule, 'OnlyGovernor');
      });

      it('the wanted value is already set (true -> true)', async () => {
        await expect(liquidationModule.connect(governor).liquidationModeToggle(true))
          .to.be.revertedWithCustomError(liquidationModule, 'LiquidationModeAlreadySet');
      });

      it('the wanted value is already set (false -> false)', async () => {
        await liquidationModule.connect(governor).liquidationModeToggle(false);

        await expect(liquidationModule.connect(governor).liquidationModeToggle(false))
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
