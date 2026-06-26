import { deployAndUpdateLiquidationModule, ethers, exp, expect, makeProtocol, SnapshotRestorer, takeSnapshot } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, LiquidationModule, LiquidationModule__factory } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import { setBalance, DEFAULT_DEX_ADAPTER } from '../helpers';

describe('liquidation module', function () {
  const BORDER_HF: bigint = exp(102, 16); // 1.02e18
  const HEALTH_POSITION_HF: bigint = exp(110, 16); // 1.10e18
  const PENALTY_BPS: bigint = BigInt(500);

  // Parameter setters are gated by OZ AccessControl's MULTISIG_ROLE.
  const MULTISIG_ROLE = ethers.utils.id('MULTISIG_ROLE');
  const missingRole = (account: string, role: string) =>
    `AccessControl: account ${account.toLowerCase()} is missing role ${role}`;

  let comet: CometHarnessInterfaceExtendedAssetList;
  let liquidationModule: LiquidationModule;
  let LiquidationModuleFactory: LiquidationModule__factory;

  let governor: SignerWithAddress;
  let alice: SignerWithAddress;

  let snapshot: SnapshotRestorer;

  before(async () => {
    governor = await ethers.getImpersonatedSigner("0x6d903f6003cca6255D85CcA4D3B5E5146dC33925");
    await setBalance(governor.address, ethers.utils.parseEther("10"));
    // This suite drives the onlyMultisig setters through `governor`, so the governor also acts as the Multisig.
    const protocol = await makeProtocol({ base: 'USDC', governor: governor, multisig: governor });
    comet = protocol.comet;
    [alice] = protocol.users;

    LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
    liquidationModule = protocol.defaultLiquidationModule;

    snapshot = await takeSnapshot();
  });

  context('constructor', function () {
    context('happy path', function () {
      it('sets COMET to the provided comet address', async () => {
        expect(await liquidationModule.comet()).to.equal(comet.address);
      });

      it('sets DEX_ADAPTER to the provided adapter address', async () => {
        expect(await liquidationModule.dexAdapter()).to.equal(DEFAULT_DEX_ADAPTER);
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

      it('borderHF is zero', async () => {
        await expect(LiquidationModuleFactory.deploy(governor.address, DEFAULT_DEX_ADAPTER, [governor.address], [governor.address], 0, HEALTH_POSITION_HF, PENALTY_BPS))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });

      it('healthPositionHF is zero', async () => {
        await expect(LiquidationModuleFactory.deploy(governor.address, DEFAULT_DEX_ADAPTER, [governor.address], [governor.address], BORDER_HF, 0, PENALTY_BPS))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });

      it('both borderHF and healthPositionHF are zero', async () => {
        await expect(LiquidationModuleFactory.deploy(governor.address, DEFAULT_DEX_ADAPTER, [governor.address], [governor.address], 0, 0, PENALTY_BPS))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });

      it('borderHF is greater than healthPositionHF', async () => {
        await expect(LiquidationModuleFactory.deploy(governor.address, DEFAULT_DEX_ADAPTER, [governor.address], [governor.address], HEALTH_POSITION_HF + 1n, HEALTH_POSITION_HF, PENALTY_BPS))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
      });

      it('borderHF equals healthPositionHF', async () => {
        await expect(LiquidationModuleFactory.deploy(governor.address, DEFAULT_DEX_ADAPTER, [governor.address], [governor.address], HEALTH_POSITION_HF, HEALTH_POSITION_HF, PENALTY_BPS))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidHFBoundaries');
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

      it('caller is not the multisig', async () => {
        await expect(liquidationModule.connect(alice).setBorderHF(NEW_BORDER_HF))
          .to.be.revertedWith(missingRole(alice.address, MULTISIG_ROLE));
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

      it('caller is not the multisig', async () => {
        await expect(liquidationModule.connect(alice).setHealthPositionHF(NEW_HEALTH_POSITION_HF))
          .to.be.revertedWith(missingRole(alice.address, MULTISIG_ROLE));
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
