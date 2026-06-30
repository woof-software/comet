import { deployDefaultLiquidationModule, ethers, exp, expect, makeProtocol, SnapshotRestorer, takeSnapshot } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, LiquidationModule, LiquidationModule__factory } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import { setBalance } from '../helpers';

describe('liquidation module', function () {
  const INCENTIVE_BPS: bigint = BigInt(500);

  // Parameter setters are gated by OZ AccessControl's MULTISIG_ROLE.
  const MULTISIG_ROLE = ethers.utils.id('MULTISIG_ROLE');
  const missingRole = (account: string, role: string) =>
    `AccessControl: account ${account.toLowerCase()} is missing role ${role}`;

  let comet: CometHarnessInterfaceExtendedAssetList;
  let liquidationModule: LiquidationModule;
  let LiquidationModuleFactory: LiquidationModule__factory;
  let dexAdapter: string;

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
    dexAdapter = await liquidationModule.dexAdapter();

    snapshot = await takeSnapshot();
  });

  context('constructor', function () {
    context('happy path', function () {
      it('sets COMET to the provided comet address', async () => {
        expect(await liquidationModule.comet()).to.equal(comet.address);
      });

      it('sets DEX_ADAPTER to the provided adapter address', async () => {
        expect(await liquidationModule.dexAdapter()).to.equal(dexAdapter);
      });

      // The constructor reports the initial thresholds as transitions from 0.
      it('emits BorderHFUpdated with the initial border value', async () => {
        await expect(liquidationModule.deployTransaction)
          .to.emit(liquidationModule, 'IncentiveBpsUpdated').withArgs(0, INCENTIVE_BPS);
      });
    });

      it('IncentiveBps exceeds maximum bps', async () => {
        await expect(LiquidationModuleFactory.deploy(dexAdapter, governor.address, [governor.address], [governor.address], 1_001))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidIncentiveBps');
      });
    });

  context('setIncentiveBps', function () {
    const NEW_INCENTIVE_BPS = 700;

    context('happy path: governor updates the incentive bps', function () {
      let setTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('governor updates incentiveBps to a value below MAX_INCENTIVE', async () => {
        setTx = await liquidationModule.connect(governor).setIncentiveBps(NEW_INCENTIVE_BPS);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits IncentiveBpsUpdated with old and new values', async () => {
        await expect(setTx).to.emit(liquidationModule, 'IncentiveBpsUpdated').withArgs(INCENTIVE_BPS, NEW_INCENTIVE_BPS);
      });

      it('incentiveBps is now the new value', async () => {
        expect(await liquidationModule.incentiveBps()).to.equal(NEW_INCENTIVE_BPS);
      });
    });

    context('revert when', function () {
      after(async () => await snapshot.restore());

      it('caller is not the multisig', async () => {
        await expect(liquidationModule.connect(alice).setIncentiveBps(NEW_INCENTIVE_BPS))
          .to.be.revertedWith(missingRole(alice.address, MULTISIG_ROLE));
      });

      it('incentiveBps exceeds MAX_INCENTIVE', async () => {
        await expect(liquidationModule.connect(governor).setIncentiveBps(1_001))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidIncentiveBps');
      });
    });
  });
});
