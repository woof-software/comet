import { deployAndUpdateLiquidationModule, ethers, exp, expect, makeProtocol, SnapshotRestorer, takeSnapshot } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, LiquidationModule, LiquidationModule__factory } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';

describe('liquidation module', function () {
  // Any non-zero address satisfies the DEX adapter check; the adapter itself is not exercised here.
  const DEX_ADAPTER = '0x1111111111111111111111111111111111111111';
  const BORDER_HF: bigint = exp(102, 16); // 1.02e18
  const HEALTH_POSITION_HF: bigint = exp(110, 16); // 1.10e18

  let comet: CometHarnessInterfaceExtendedAssetList;
  let liquidationModule: LiquidationModule;
  let LiquidationModuleFactory: LiquidationModule__factory;

  let governor: SignerWithAddress;
  let alice: SignerWithAddress;

  let snapshot: SnapshotRestorer;

  before(async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    comet = protocol.comet;
    governor = protocol.governor;
    [alice] = protocol.users;

    LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;

    liquidationModule = await deployAndUpdateLiquidationModule({
      comet,
      governor,
      dexAdapter: DEX_ADAPTER,
      borderHF: BORDER_HF,
      healthPositionHF: HEALTH_POSITION_HF,
    });

    snapshot = await takeSnapshot();
  });

  context('constructor', function () {
    context('happy path', function () {
      it('sets COMET to the provided comet address', async () => {
        expect(await liquidationModule.comet()).to.equal(comet.address);
      });

      it('sets DEX_ADAPTER to the provided adapter address', async () => {
        expect(await liquidationModule.dexAdapter()).to.equal(DEX_ADAPTER);
      });

      it('sets borderHF to the provided value', async () => {
        expect(await liquidationModule.borderHF()).to.equal(BORDER_HF);
      });

      it('sets healthPositionHF to the provided value', async () => {
        expect(await liquidationModule.healthPositionHF()).to.equal(HEALTH_POSITION_HF);
      });

      // The constructor reports the initial thresholds as transitions from 0.
      it('emits BorderHFUpdated with the initial border value', async () => {
        await expect(liquidationModule.deployTransaction)
          .to.emit(liquidationModule, 'BorderHFUpdated').withArgs(0, BORDER_HF);
      });

      it('emits HealthPositionHFUpdated with the initial health value', async () => {
        await expect(liquidationModule.deployTransaction)
          .to.emit(liquidationModule, 'HealthPositionHFUpdated').withArgs(0, HEALTH_POSITION_HF);
      });
    });

    context('revert when', function () {
      it('dex adapter is the zero address', async () => {
        await expect(LiquidationModuleFactory.deploy(comet.address, ethers.constants.AddressZero, BORDER_HF, HEALTH_POSITION_HF))
          .to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });

      it('borderHF is zero', async () => {
        await expect(LiquidationModuleFactory.deploy(comet.address, DEX_ADAPTER, 0, HEALTH_POSITION_HF))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });

      it('healthPositionHF is zero', async () => {
        await expect(LiquidationModuleFactory.deploy(comet.address, DEX_ADAPTER, BORDER_HF, 0))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });

      it('both borderHF and healthPositionHF are zero', async () => {
        await expect(LiquidationModuleFactory.deploy(comet.address, DEX_ADAPTER, 0, 0))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });

      it('borderHF is greater than healthPositionHF', async () => {
        await expect(LiquidationModuleFactory.deploy(comet.address, DEX_ADAPTER, HEALTH_POSITION_HF + 1n, HEALTH_POSITION_HF))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });

      it('borderHF equals healthPositionHF', async () => {
        await expect(LiquidationModuleFactory.deploy(comet.address, DEX_ADAPTER, HEALTH_POSITION_HF, HEALTH_POSITION_HF))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });
    });
  });

  context('setBorderHF', function () {
    // New border must stay strictly below the current healthPositionHF (1.10e18).
    const NEW_BORDER_HF: bigint = exp(105, 16); // 1.05e18

    context('happy path: governor updates the border', function () {
      let setTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('governor updates borderHF to a value below healthPositionHF', async () => {
        setTx = await liquidationModule.connect(governor).setBorderHF(NEW_BORDER_HF);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits BorderHFUpdated with old and new values', async () => {
        await expect(setTx).to.emit(liquidationModule, 'BorderHFUpdated').withArgs(BORDER_HF, NEW_BORDER_HF);
      });

      it('borderHF is now the new value', async () => {
        expect(await liquidationModule.borderHF()).to.equal(NEW_BORDER_HF);
      });
    });

    context('revert when', function () {
      after(async () => await snapshot.restore());

      it('caller is not the governor', async () => {
        await expect(liquidationModule.connect(alice).setBorderHF(NEW_BORDER_HF))
          .to.be.revertedWithCustomError(liquidationModule, 'OnlyGovernor');
      });

      it('borderHF is zero', async () => {
        await expect(liquidationModule.connect(governor).setBorderHF(0))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });

      it('borderHF equals healthPositionHF', async () => {
        await expect(liquidationModule.connect(governor).setBorderHF(HEALTH_POSITION_HF))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });

      it('borderHF is greater than healthPositionHF', async () => {
        await expect(liquidationModule.connect(governor).setBorderHF(HEALTH_POSITION_HF + 1n))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });
    });
  });

  context('setHealthPositionHF', function () {
    // New health threshold must stay strictly above the current borderHF (1.02e18).
    const NEW_HEALTH_POSITION_HF: bigint = exp(120, 16); // 1.20e18

    context('happy path: governor updates the health threshold', function () {
      let setTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('governor updates healthPositionHF to a value above borderHF', async () => {
        setTx = await liquidationModule.connect(governor).setHealthPositionHF(NEW_HEALTH_POSITION_HF);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits HealthPositionHFUpdated with old and new values', async () => {
        await expect(setTx).to.emit(liquidationModule, 'HealthPositionHFUpdated').withArgs(HEALTH_POSITION_HF, NEW_HEALTH_POSITION_HF);
      });

      it('healthPositionHF is now the new value', async () => {
        expect(await liquidationModule.healthPositionHF()).to.equal(NEW_HEALTH_POSITION_HF);
      });
    });

    context('revert when', function () {
      after(async () => await snapshot.restore());

      it('caller is not the governor', async () => {
        await expect(liquidationModule.connect(alice).setHealthPositionHF(NEW_HEALTH_POSITION_HF))
          .to.be.revertedWithCustomError(liquidationModule, 'OnlyGovernor');
      });

      it('healthPositionHF is zero', async () => {
        await expect(liquidationModule.connect(governor).setHealthPositionHF(0))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });

      it('healthPositionHF equals borderHF', async () => {
        await expect(liquidationModule.connect(governor).setHealthPositionHF(BORDER_HF))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });

      it('healthPositionHF is less than borderHF', async () => {
        await expect(liquidationModule.connect(governor).setHealthPositionHF(BORDER_HF - 1n))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });
    });
  });
});
