import { ethers, exp, expect, makeProtocol } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, LiquidationModule, LiquidationModule__factory } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import { takeSnapshot, SnapshotRestorer } from '../helpers/snapshot';
import { setBalance } from '../helpers';

// Role-based access control for the liquidation module:
//   - DEFAULT_ADMIN_ROLE (DAO): the hardcoded governance timelock; admin of every role and the only
//                               account that can grant/revoke roles.
//   - MULTISIG_ROLE: controls parameter setters.
//   - EXECUTOR_ROLE: the only accounts allowed to call the keeper liquidate() entry point.
//   - PAUSER_ROLE:   toggle the DEX pause switch.
// This file covers the constructor wiring and the DAO-only role-management surface (grantRole / revokeRole).
describe('liquidation module access control', function () {
  // Any non-zero address satisfies the DEX adapter check; the adapter itself is not exercised here.
  const DEX_ADAPTER = '0x1111111111111111111111111111111111111111';
  const BORDER_HF: bigint = exp(102, 16); // 1.02e18
  const HEALTH_POSITION_HF: bigint = exp(110, 16); // 1.10e18
  const PENALTY_BPS: bigint = BigInt(500);
  const ZERO = ethers.constants.AddressZero;

  // OZ AccessControl role identifiers.
  const ADMIN_ROLE = ethers.constants.HashZero; // DEFAULT_ADMIN_ROLE, held by the DAO
  const EXECUTOR_ROLE = ethers.utils.id('EXECUTOR_ROLE');
  const PAUSER_ROLE = ethers.utils.id('PAUSER_ROLE');
  const MULTISIG_ROLE = ethers.utils.id('MULTISIG_ROLE');

  // OZ v4 AccessControl revert message for a caller missing `role`.
  const missingRole = (account: string, role: string) =>
    `AccessControl: account ${account.toLowerCase()} is missing role ${role}`;

  let comet: CometHarnessInterfaceExtendedAssetList;
  let LiquidationModuleFactory: LiquidationModule__factory;
  let liquidationModule: LiquidationModule;

  let governor: SignerWithAddress;
  let dao: SignerWithAddress; // holds DEFAULT_ADMIN_ROLE; equals the hardcoded DAO timelock
  let multisig: SignerWithAddress;
  let executor1: SignerWithAddress;
  let executor2: SignerWithAddress;
  let executor3: SignerWithAddress;
  let pauser1: SignerWithAddress;
  let pauser2: SignerWithAddress;
  let pauser3: SignerWithAddress;
  let other: SignerWithAddress; // holds no role
  let fresh1: SignerWithAddress; // unused account granted roles during the tests

  let executors: string[];
  let pausers: string[];

  let snapshot: SnapshotRestorer;

  before(async () => {
    governor = await ethers.getImpersonatedSigner("0x6d903f6003cca6255D85CcA4D3B5E5146dC33925");
    await setBalance(governor.address, ethers.utils.parseEther("10"));
    const protocol = await makeProtocol({ base: 'USDC', governor });
    comet = protocol.comet;
    // The DAO is the hardcoded governance timelock that holds DEFAULT_ADMIN_ROLE.
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
      HEALTH_POSITION_HF,
      PENALTY_BPS
    );

    snapshot = await takeSnapshot();
  });

  /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
  //////////////////////////////////////////////////////////////*/

  describe('constructor', function () {
    // The constructor wires the Multisig, the initial Executors/Pausers and the DAO (DEFAULT_ADMIN_ROLE).
    describe('happy path', function () {
      it('sets the Multisig', async () => {
        expect(await liquidationModule.multisig()).to.equal(multisig.address);
      });

      it('exposes the hardcoded DAO timelock', async () => {
        expect(await liquidationModule.DAO()).to.equal(dao.address);
      });

      it('grants the DAO the admin role', async () => {
        expect(await liquidationModule.hasRole(ADMIN_ROLE, dao.address)).to.be.true;
      });

      it('grants the Multisig the multisig role', async () => {
        expect(await liquidationModule.hasRole(MULTISIG_ROLE, multisig.address)).to.be.true;
      });

      it('starts with the DEX unpaused', async () => {
        expect(await liquidationModule.dexRoutePaused()).to.be.false;
      });

      [0, 1, 2].forEach((i) => {
        it(`grants the initial Executor #${i + 1}`, async () => {
          expect(await liquidationModule.hasRole(EXECUTOR_ROLE, executors[i])).to.be.true;
        });
      });

      [0, 1, 2].forEach((i) => {
        it(`grants the initial Pauser #${i + 1}`, async () => {
          expect(await liquidationModule.hasRole(PAUSER_ROLE, pausers[i])).to.be.true;
        });
      });
    });

    describe('revert when', function () {
      it('the Multisig is the zero address', async () => {
        await expect(
          LiquidationModuleFactory.deploy(comet.address, ZERO, executors, pausers, DEX_ADAPTER, BORDER_HF, HEALTH_POSITION_HF, PENALTY_BPS)
        ).to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });

      it('the Executors list is empty', async () => {
        await expect(
          LiquidationModuleFactory.deploy(comet.address, multisig.address, [], pausers, DEX_ADAPTER, BORDER_HF, HEALTH_POSITION_HF, PENALTY_BPS)
        ).to.be.revertedWithCustomError(liquidationModule, 'EmptyArray');
      });

      it('the Pausers list is empty', async () => {
        await expect(
          LiquidationModuleFactory.deploy(comet.address, multisig.address, executors, [], DEX_ADAPTER, BORDER_HF, HEALTH_POSITION_HF, PENALTY_BPS)
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
            HEALTH_POSITION_HF,
            PENALTY_BPS
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
            HEALTH_POSITION_HF,
            PENALTY_BPS
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
            HEALTH_POSITION_HF,
            PENALTY_BPS
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
            HEALTH_POSITION_HF,
            PENALTY_BPS
          )
        ).to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                      EXECUTOR ROLE (grant / revoke)
  //////////////////////////////////////////////////////////////*/

  describe('EXECUTOR_ROLE', function () {
    describe('the DAO grants the role', function () {
      let setTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('the DAO grants a fresh account', async () => {
        setTx = await liquidationModule.connect(dao).grantRole(EXECUTOR_ROLE, fresh1.address);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits RoleGranted', async () => {
        await expect(setTx)
          .to.emit(liquidationModule, 'RoleGranted').withArgs(EXECUTOR_ROLE, fresh1.address, dao.address);
      });

      it('marks the account as an Executor', async () => {
        expect(await liquidationModule.hasRole(EXECUTOR_ROLE, fresh1.address)).to.be.true;
      });
    });

    describe('the DAO revokes the role', function () {
      let revokeTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('the DAO revokes an existing Executor', async () => {
        revokeTx = await liquidationModule.connect(dao).revokeRole(EXECUTOR_ROLE, executor1.address);
        await expect(revokeTx).to.not.be.reverted;
      });

      it('emits RoleRevoked', async () => {
        await expect(revokeTx)
          .to.emit(liquidationModule, 'RoleRevoked').withArgs(EXECUTOR_ROLE, executor1.address, dao.address);
      });

      it('clears the Executor role', async () => {
        expect(await liquidationModule.hasRole(EXECUTOR_ROLE, executor1.address)).to.be.false;
      });
    });

    describe('revert when', function () {
      it('a non-DAO grants the role', async () => {
        await expect(liquidationModule.connect(other).grantRole(EXECUTOR_ROLE, fresh1.address))
          .to.be.revertedWith(missingRole(other.address, ADMIN_ROLE));
      });

      it('a non-DAO revokes the role', async () => {
        await expect(liquidationModule.connect(other).revokeRole(EXECUTOR_ROLE, executor1.address))
          .to.be.revertedWith(missingRole(other.address, ADMIN_ROLE));
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                      PAUSER ROLE (grant / revoke)
  //////////////////////////////////////////////////////////////*/

  describe('PAUSER_ROLE', function () {
    describe('the DAO grants the role', function () {
      let setTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('the DAO grants a fresh account', async () => {
        setTx = await liquidationModule.connect(dao).grantRole(PAUSER_ROLE, fresh1.address);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits RoleGranted', async () => {
        await expect(setTx)
          .to.emit(liquidationModule, 'RoleGranted').withArgs(PAUSER_ROLE, fresh1.address, dao.address);
      });

      it('marks the account as a Pauser', async () => {
        expect(await liquidationModule.hasRole(PAUSER_ROLE, fresh1.address)).to.be.true;
      });
    });

    describe('the DAO revokes the role', function () {
      let revokeTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('the DAO revokes an existing Pauser', async () => {
        revokeTx = await liquidationModule.connect(dao).revokeRole(PAUSER_ROLE, pauser1.address);
        await expect(revokeTx).to.not.be.reverted;
      });

      it('emits RoleRevoked', async () => {
        await expect(revokeTx)
          .to.emit(liquidationModule, 'RoleRevoked').withArgs(PAUSER_ROLE, pauser1.address, dao.address);
      });

      it('clears the Pauser role', async () => {
        expect(await liquidationModule.hasRole(PAUSER_ROLE, pauser1.address)).to.be.false;
      });
    });

    describe('revert when', function () {
      it('a non-DAO grants the role', async () => {
        await expect(liquidationModule.connect(other).grantRole(PAUSER_ROLE, fresh1.address))
          .to.be.revertedWith(missingRole(other.address, ADMIN_ROLE));
      });

      it('a non-DAO revokes the role', async () => {
        await expect(liquidationModule.connect(other).revokeRole(PAUSER_ROLE, pauser1.address))
          .to.be.revertedWith(missingRole(other.address, ADMIN_ROLE));
      });
    });
  });
});
