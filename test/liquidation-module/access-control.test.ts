import { ethers, exp, expect, makeProtocol } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, LiquidationModule, LiquidationModule__factory } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import { takeSnapshot, SnapshotRestorer } from '../helpers/snapshot';

// Role-based access control for the liquidation module:
//   - Multisig (one):  controls parameter setters.
//   - DAO      (one):  controls roles and the pause switch; derived from comet.governor().
//   - Executor (many): the only accounts allowed to call the keeper liquidate() entry point.
//   - Pauser   (many): toggle the DEX pause switch.
// This file covers the constructor wiring and the DAO-only role-management surface
// (setExecutors / setPausers / setMultisig / transferDAO).
describe('liquidation module access control', function () {
  // Any non-zero address satisfies the DEX adapter check; the adapter itself is not exercised here.
  const DEX_ADAPTER = '0x1111111111111111111111111111111111111111';
  const BORDER_HF: bigint = exp(102, 16); // 1.02e18
  const HEALTH_POSITION_HF: bigint = exp(110, 16); // 1.10e18
  const ZERO = ethers.constants.AddressZero;

  let comet: CometHarnessInterfaceExtendedAssetList;
  let LiquidationModuleFactory: LiquidationModule__factory;
  let liquidationModule: LiquidationModule;

  let governor: SignerWithAddress;
  let dao: SignerWithAddress; // equals the governor; derived in the constructor
  let multisig: SignerWithAddress;
  let executor1: SignerWithAddress;
  let executor2: SignerWithAddress;
  let executor3: SignerWithAddress;
  let pauser1: SignerWithAddress;
  let pauser2: SignerWithAddress;
  let pauser3: SignerWithAddress;
  let other: SignerWithAddress; // holds no role
  let fresh1: SignerWithAddress; // unused accounts granted roles during the tests
  let fresh2: SignerWithAddress;
  let fresh3: SignerWithAddress;
  let newMultisig: SignerWithAddress;
  let newDAO: SignerWithAddress;

  let executors: string[];
  let pausers: string[];

  let snapshot: SnapshotRestorer;

  before(async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    comet = protocol.comet;
    governor = protocol.governor;
    // The DAO is derived from comet.governor() in the constructor.
    dao = governor;

    [
      multisig,
      executor1,
      executor2,
      executor3,
      pauser1,
      pauser2,
      pauser3,
      other,
      fresh1,
      fresh2,
      fresh3,
      newMultisig,
      newDAO,
    ] = protocol.users;

    executors = [executor1.address, executor2.address, executor3.address];
    pausers = [pauser1.address, pauser2.address, pauser3.address];

    // Clean deploy of the module under test with three distinct Executors and three distinct Pausers.
    LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
    liquidationModule = await LiquidationModuleFactory.deploy(
      comet.address,
      multisig.address,
      executors,
      pausers,
      DEX_ADAPTER,
      BORDER_HF,
      HEALTH_POSITION_HF
    );

    snapshot = await takeSnapshot();
  });

  /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
  //////////////////////////////////////////////////////////////*/

  describe('constructor', function () {
    // The constructor wires the Multisig, the initial Executors/Pausers and derives the DAO from Comet.
    describe('happy path', function () {
      it('sets the Multisig', async () => {
        expect(await liquidationModule.multisig()).to.equal(multisig.address);
      });

      it('derives the DAO from comet.governor()', async () => {
        expect(await liquidationModule.dao()).to.equal(dao.address);
      });

      it('starts with the DEX unpaused', async () => {
        expect(await liquidationModule.dexPaused()).to.be.false;
      });

      [0, 1, 2].forEach((i) => {
        it(`grants the initial Executor #${i + 1}`, async () => {
          expect(await liquidationModule.isExecutor(executors[i])).to.be.true;
        });
      });

      [0, 1, 2].forEach((i) => {
        it(`grants the initial Pauser #${i + 1}`, async () => {
          expect(await liquidationModule.isPauser(pausers[i])).to.be.true;
        });
      });

      it('emits MultisigUpdated from the zero address', async () => {
        await expect(liquidationModule.deployTransaction)
          .to.emit(liquidationModule, 'MultisigUpdated').withArgs(ZERO, multisig.address);
      });

      it('emits DAOTransferred from the zero address', async () => {
        await expect(liquidationModule.deployTransaction)
          .to.emit(liquidationModule, 'DAOTransferred').withArgs(ZERO, dao.address);
      });

      [0, 1, 2].forEach((i) => {
        it(`emits ExecutorSet for the initial Executor #${i + 1}`, async () => {
          await expect(liquidationModule.deployTransaction)
            .to.emit(liquidationModule, 'ExecutorSet').withArgs(executors[i], true);
        });
      });

      [0, 1, 2].forEach((i) => {
        it(`emits PauserSet for the initial Pauser #${i + 1}`, async () => {
          await expect(liquidationModule.deployTransaction)
            .to.emit(liquidationModule, 'PauserSet').withArgs(pausers[i], true);
        });
      });
    });

    describe('revert when', function () {
      it('the Multisig is the zero address', async () => {
        await expect(
          LiquidationModuleFactory.deploy(comet.address, ZERO, executors, pausers, DEX_ADAPTER, BORDER_HF, HEALTH_POSITION_HF)
        ).to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });

      it('the Executors list is empty', async () => {
        await expect(
          LiquidationModuleFactory.deploy(comet.address, multisig.address, [], pausers, DEX_ADAPTER, BORDER_HF, HEALTH_POSITION_HF)
        ).to.be.revertedWithCustomError(liquidationModule, 'EmptyArray');
      });

      it('the Pausers list is empty', async () => {
        await expect(
          LiquidationModuleFactory.deploy(comet.address, multisig.address, executors, [], DEX_ADAPTER, BORDER_HF, HEALTH_POSITION_HF)
        ).to.be.revertedWithCustomError(liquidationModule, 'EmptyArray');
      });

      it('the Executors list has duplicates', async () => {
        await expect(
          LiquidationModuleFactory.deploy(
            comet.address,
            multisig.address,
            [executor1.address, executor2.address, executor1.address],
            pausers,
            DEX_ADAPTER,
            BORDER_HF,
            HEALTH_POSITION_HF
          )
        ).to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
      });

      it('the Pausers list has duplicates', async () => {
        await expect(
          LiquidationModuleFactory.deploy(
            comet.address,
            multisig.address,
            executors,
            [pauser1.address, pauser2.address, pauser1.address],
            DEX_ADAPTER,
            BORDER_HF,
            HEALTH_POSITION_HF
          )
        ).to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
      });

      it('an Executor address is the zero address', async () => {
        await expect(
          LiquidationModuleFactory.deploy(
            comet.address,
            multisig.address,
            [executor1.address, executor2.address, ZERO],
            pausers,
            DEX_ADAPTER,
            BORDER_HF,
            HEALTH_POSITION_HF
          )
        ).to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });

      it('a Pauser address is the zero address', async () => {
        await expect(
          LiquidationModuleFactory.deploy(
            comet.address,
            multisig.address,
            executors,
            [pauser1.address, pauser2.address, ZERO],
            DEX_ADAPTER,
            BORDER_HF,
            HEALTH_POSITION_HF
          )
        ).to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                            SET EXECUTORS
  //////////////////////////////////////////////////////////////*/

  describe('setExecutors', function () {
    // Granting a single, previously unset account.
    describe('grants a single Executor', function () {
      let setTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('the DAO sets the account', async () => {
        setTx = await liquidationModule.connect(dao).setExecutors([fresh1.address], [true]);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits ExecutorSet', async () => {
        await expect(setTx).to.emit(liquidationModule, 'ExecutorSet').withArgs(fresh1.address, true);
      });

      it('marks the account as an Executor', async () => {
        expect(await liquidationModule.isExecutor(fresh1.address)).to.be.true;
      });
    });

    // Granting three accounts in a single call emits one event per account.
    describe('grants three Executors in one call', function () {
      let setTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('the DAO sets the accounts', async () => {
        setTx = await liquidationModule
          .connect(dao)
          .setExecutors([fresh1.address, fresh2.address, fresh3.address], [true, true, true]);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits ExecutorSet for the first account', async () => {
        await expect(setTx).to.emit(liquidationModule, 'ExecutorSet').withArgs(fresh1.address, true);
      });

      it('emits ExecutorSet for the second account', async () => {
        await expect(setTx).to.emit(liquidationModule, 'ExecutorSet').withArgs(fresh2.address, true);
      });

      it('emits ExecutorSet for the third account', async () => {
        await expect(setTx).to.emit(liquidationModule, 'ExecutorSet').withArgs(fresh3.address, true);
      });

      it('marks the first account as an Executor', async () => {
        expect(await liquidationModule.isExecutor(fresh1.address)).to.be.true;
      });

      it('marks the second account as an Executor', async () => {
        expect(await liquidationModule.isExecutor(fresh2.address)).to.be.true;
      });

      it('marks the third account as an Executor', async () => {
        expect(await liquidationModule.isExecutor(fresh3.address)).to.be.true;
      });
    });

    describe('revert when', function () {
      it('the caller is not the DAO', async () => {
        await expect(liquidationModule.connect(other).setExecutors([fresh1.address], [true]))
          .to.be.revertedWithCustomError(liquidationModule, 'OnlyDAO');
      });

      it('the accounts list is empty', async () => {
        await expect(liquidationModule.connect(dao).setExecutors([], []))
          .to.be.revertedWithCustomError(liquidationModule, 'EmptyArray');
      });

      it('the accounts and statuses lengths differ', async () => {
        await expect(liquidationModule.connect(dao).setExecutors([fresh1.address], [true, false]))
          .to.be.revertedWithCustomError(liquidationModule, 'ArrayLengthMismatch');
      });

      it('an account is the zero address', async () => {
        await expect(liquidationModule.connect(dao).setExecutors([fresh1.address, ZERO], [true, true]))
          .to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });

      it('the accounts list has duplicates', async () => {
        await expect(liquidationModule.connect(dao).setExecutors([fresh1.address, fresh1.address], [true, true]))
          .to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
      });

      it('an account is already an Executor (true -> true)', async () => {
        await expect(liquidationModule.connect(dao).setExecutors([executor1.address], [true]))
          .to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
      });

      it('an account is already not an Executor (false -> false)', async () => {
        await expect(liquidationModule.connect(dao).setExecutors([other.address], [false]))
          .to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                            SET PAUSERS
  //////////////////////////////////////////////////////////////*/

  describe('setPausers', function () {
    // Granting a single, previously unset account.
    describe('grants a single Pauser', function () {
      let setTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('the DAO sets the account', async () => {
        setTx = await liquidationModule.connect(dao).setPausers([fresh1.address], [true]);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits PauserSet', async () => {
        await expect(setTx).to.emit(liquidationModule, 'PauserSet').withArgs(fresh1.address, true);
      });

      it('marks the account as a Pauser', async () => {
        expect(await liquidationModule.isPauser(fresh1.address)).to.be.true;
      });
    });

    // Granting three accounts in a single call emits one event per account.
    describe('grants three Pausers in one call', function () {
      let setTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('the DAO sets the accounts', async () => {
        setTx = await liquidationModule
          .connect(dao)
          .setPausers([fresh1.address, fresh2.address, fresh3.address], [true, true, true]);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits PauserSet for the first account', async () => {
        await expect(setTx).to.emit(liquidationModule, 'PauserSet').withArgs(fresh1.address, true);
      });

      it('emits PauserSet for the second account', async () => {
        await expect(setTx).to.emit(liquidationModule, 'PauserSet').withArgs(fresh2.address, true);
      });

      it('emits PauserSet for the third account', async () => {
        await expect(setTx).to.emit(liquidationModule, 'PauserSet').withArgs(fresh3.address, true);
      });

      it('marks the first account as a Pauser', async () => {
        expect(await liquidationModule.isPauser(fresh1.address)).to.be.true;
      });

      it('marks the second account as a Pauser', async () => {
        expect(await liquidationModule.isPauser(fresh2.address)).to.be.true;
      });

      it('marks the third account as a Pauser', async () => {
        expect(await liquidationModule.isPauser(fresh3.address)).to.be.true;
      });
    });

    describe('revert when', function () {
      it('the caller is not the DAO', async () => {
        await expect(liquidationModule.connect(other).setPausers([fresh1.address], [true]))
          .to.be.revertedWithCustomError(liquidationModule, 'OnlyDAO');
      });

      it('the accounts list is empty', async () => {
        await expect(liquidationModule.connect(dao).setPausers([], []))
          .to.be.revertedWithCustomError(liquidationModule, 'EmptyArray');
      });

      it('the accounts and statuses lengths differ', async () => {
        await expect(liquidationModule.connect(dao).setPausers([fresh1.address], [true, false]))
          .to.be.revertedWithCustomError(liquidationModule, 'ArrayLengthMismatch');
      });

      it('an account is the zero address', async () => {
        await expect(liquidationModule.connect(dao).setPausers([fresh1.address, ZERO], [true, true]))
          .to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });

      it('the accounts list has duplicates', async () => {
        await expect(liquidationModule.connect(dao).setPausers([fresh1.address, fresh1.address], [true, true]))
          .to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
      });

      it('an account is already a Pauser (true -> true)', async () => {
        await expect(liquidationModule.connect(dao).setPausers([pauser1.address], [true]))
          .to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
      });

      it('an account is already not a Pauser (false -> false)', async () => {
        await expect(liquidationModule.connect(dao).setPausers([other.address], [false]))
          .to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                            SET MULTISIG
  //////////////////////////////////////////////////////////////*/

  describe('setMultisig', function () {
    describe('happy path', function () {
      let setTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('the DAO sets a new Multisig', async () => {
        setTx = await liquidationModule.connect(dao).setMultisig(newMultisig.address);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits MultisigUpdated with the old and new addresses', async () => {
        await expect(setTx)
          .to.emit(liquidationModule, 'MultisigUpdated').withArgs(multisig.address, newMultisig.address);
      });

      it('updates the stored Multisig', async () => {
        expect(await liquidationModule.multisig()).to.equal(newMultisig.address);
      });
    });

    describe('revert when', function () {
      it('the caller is not the DAO', async () => {
        await expect(liquidationModule.connect(other).setMultisig(newMultisig.address))
          .to.be.revertedWithCustomError(liquidationModule, 'OnlyDAO');
      });

      it('the new Multisig equals the current Multisig', async () => {
        await expect(liquidationModule.connect(dao).setMultisig(multisig.address))
          .to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
      });

      it('the new Multisig is the zero address', async () => {
        await expect(liquidationModule.connect(dao).setMultisig(ZERO))
          .to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                            TRANSFER DAO
  //////////////////////////////////////////////////////////////*/

  describe('transferDAO', function () {
    describe('happy path', function () {
      let transferTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('the DAO transfers the role', async () => {
        transferTx = await liquidationModule.connect(dao).transferDAO(newDAO.address);
        await expect(transferTx).to.not.be.reverted;
      });

      it('emits DAOTransferred with the old and new addresses', async () => {
        await expect(transferTx)
          .to.emit(liquidationModule, 'DAOTransferred').withArgs(dao.address, newDAO.address);
      });

      it('updates the stored DAO', async () => {
        expect(await liquidationModule.dao()).to.equal(newDAO.address);
      });
    });

    describe('revert when', function () {
      it('the caller is not the DAO', async () => {
        await expect(liquidationModule.connect(other).transferDAO(newDAO.address))
          .to.be.revertedWithCustomError(liquidationModule, 'OnlyDAO');
      });

      it('the new DAO is the zero address', async () => {
        await expect(liquidationModule.connect(dao).transferDAO(ZERO))
          .to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });

      it('the new DAO equals the current DAO', async () => {
        await expect(liquidationModule.connect(dao).transferDAO(dao.address))
          .to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
      });
    });
  });
});
