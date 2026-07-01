import { ethers, exp, expect, setBalance } from '../helpers';
import {
  CometWithExtendedAssetList__factory,
  CometExtAssetList__factory,
  AssetListFactory__factory,
  SimplePriceFeed__factory,
  FaucetToken__factory,
  OneInchV6CoreAdapter__factory,
  LiquidationModule,
  LiquidationModule__factory,
} from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import { takeSnapshot, SnapshotRestorer } from '../helpers/snapshot';

// Role-based access control for the liquidation module:
//   - DEFAULT_ADMIN_ROLE (DAO): the hardcoded governance timelock; admin of every role and the only
//                               account that can grant/revoke roles.
//   - MULTISIG_ROLE: controls parameter setters.
//   - EXECUTOR_ROLE: the only accounts allowed to call the keeper liquidate() entry point.
//   - PAUSER_ROLE:   toggle the DEX pause switch.
// This file covers the constructor wiring and the DAO-only role-management surface (grantRole / revokeRole).
describe('liquidation module access control', function () {
  // Any non-zero address satisfies the DEX adapter check; the adapter itself is not exercised here.
  const INCENTIVE_BPS: bigint = BigInt(500);
  const ZERO = ethers.constants.AddressZero;

  // OZ AccessControl role identifiers.
  const ADMIN_ROLE = ethers.constants.HashZero; // DEFAULT_ADMIN_ROLE, held by the DAO
  const EXECUTOR_ROLE = ethers.utils.id('EXECUTOR_ROLE');
  const PAUSER_ROLE = ethers.utils.id('PAUSER_ROLE');
  const MULTISIG_ROLE = ethers.utils.id('MULTISIG_ROLE');

  // OZ v4 AccessControl revert message for a caller missing `role`.
  const missingRole = (account: string, role: string) =>
    `AccessControl: account ${account.toLowerCase()} is missing role ${role}`;

  let LiquidationModuleFactory: LiquidationModule__factory;
  let liquidationModule: LiquidationModule;
  let dexAdapter: string;

  let governor: SignerWithAddress;
  let dao: SignerWithAddress; // holds DEFAULT_ADMIN_ROLE; equals the hardcoded DAO timelock
  let multisig: SignerWithAddress;
  let other: SignerWithAddress; // holds no role
  let fresh1: SignerWithAddress; // unused account granted roles during the tests

  let executors: string[];
  let pausers: string[];

  let snapshot: SnapshotRestorer;

  before(async () => {
    const signers = await ethers.getSigners();
    const [deployer, pauseGuardian] = signers;
    multisig = signers[2];
    executors = [signers[3].address, signers[4].address, signers[5].address];
    pausers = [signers[6].address, signers[7].address, signers[8].address];
    fresh1 = signers[9];
    other = signers[10];

    // The DAO (DEFAULT_ADMIN_ROLE) is the hardcoded governance timelock.
    governor = await ethers.getImpersonatedSigner('0x6d903f6003cca6255D85CcA4D3B5E5146dC33925');
    await setBalance(governor.address, ethers.utils.parseEther('10'));
    dao = governor;

    // Mock market tokens: USDC base + a single WETH collateral
    const FaucetTokenFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
    const usdc = await FaucetTokenFactory.deploy(exp(1, 6), 'USD Coin', 6, 'USDC');
    await usdc.deployed();
    const weth = await FaucetTokenFactory.deploy(exp(1, 18), 'Wrapped Ether', 18, 'WETH');
    await weth.deployed();

    const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
    const usdcFeed = await PriceFeedFactory.deploy(exp(1, 8), 8);
    await usdcFeed.deployed();
    const wethFeed = await PriceFeedFactory.deploy(exp(2000, 8), 8);
    await wethFeed.deployed();

    // Asset list factory + extension delegate
    const AssetListFactoryFactory = (await ethers.getContractFactory('AssetListFactory')) as AssetListFactory__factory;
    const assetListFactory = await AssetListFactoryFactory.deploy();
    await assetListFactory.deployed();
    const CometExtFactory = (await ethers.getContractFactory('CometExtAssetList')) as CometExtAssetList__factory;
    const extensionDelegate = await CometExtFactory.deploy(
      {
        name32: ethers.utils.formatBytes32String('Compound Comet'),
        symbol32: ethers.utils.formatBytes32String('Comet'),
      },
      assetListFactory.address
    );
    await extensionDelegate.deployed();

    // DEX adapter with unset route per collateral
    const AdapterFactory = (await ethers.getContractFactory('OneInchV6CoreAdapter')) as OneInchV6CoreAdapter__factory;
    const adapter = await AdapterFactory.deploy(deployer.address, deployer.address, weth.address, 500, [
      {
        collateral: weth.address,
        kind: 0, // Unset
        poolKey: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO },
        zeroForOne: false,
        path: [],
      },
    ]);
    await adapter.deployed();
    dexAdapter = adapter.address;

    // Liquidation module
    LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
    liquidationModule = await LiquidationModuleFactory.deploy(dexAdapter, multisig.address, executors, pausers, INCENTIVE_BPS);
    await liquidationModule.deployed();

    // Comet (the real implementation, not the test harness)
    const CometFactory = (await ethers.getContractFactory('CometWithExtendedAssetList')) as CometWithExtendedAssetList__factory;
    const cometContract = await CometFactory.deploy({
      governor: governor.address,
      pauseGuardian: pauseGuardian.address,
      extensionDelegate: extensionDelegate.address,
      liquidationModule: liquidationModule.address,
      baseToken: usdc.address,
      baseTokenPriceFeed: usdcFeed.address,
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.05, 18),
      supplyPerYearInterestRateSlopeHigh: exp(2, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(0.005, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.1, 18),
      borrowPerYearInterestRateSlopeHigh: exp(3, 18),
      storeFrontPriceFactor: exp(1, 18),
      trackingIndexScale: exp(1, 15),
      baseTrackingSupplySpeed: exp(1, 15),
      baseTrackingBorrowSpeed: exp(1, 15),
      baseMinForRewards: exp(1, 6),
      baseBorrowMin: exp(1, 6),
      targetReserves: 0,
      assetConfigs: [
        {
          asset: weth.address,
          priceFeed: wethFeed.address,
          decimals: 18,
          borrowCollateralFactor: exp(0.8, 18),
          liquidateCollateralFactor: exp(0.85, 18),
          liquidationFactor: exp(0.9, 18),
          supplyCap: exp(150000, 18),
        },
      ],
    });
    await cometContract.deployed();
    await cometContract.initializeStorage();

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
          LiquidationModuleFactory.deploy(dexAdapter, ZERO, executors, pausers, INCENTIVE_BPS)
        ).to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });

      it('the Executors list is empty', async () => {
        await expect(
          LiquidationModuleFactory.deploy(dexAdapter, multisig.address, [], pausers, INCENTIVE_BPS)
        ).to.be.revertedWithCustomError(liquidationModule, 'EmptyArray');
      });

      it('the Pausers list is empty', async () => {
        await expect(
          LiquidationModuleFactory.deploy(dexAdapter, multisig.address, executors, [], INCENTIVE_BPS)
        ).to.be.revertedWithCustomError(liquidationModule, 'EmptyArray');
      });

      it('the Executors list has duplicates', async () => {
        await expect(
          LiquidationModuleFactory.deploy(
            dexAdapter,
            multisig.address,
            [executors[0], executors[1], executors[0]],
            pausers,
            INCENTIVE_BPS
          )
        ).to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
      });

      it('the Pausers list has duplicates', async () => {
        await expect(
          LiquidationModuleFactory.deploy(
            dexAdapter,
            multisig.address,
            executors,
            [pausers[0], pausers[1], pausers[0]],
            INCENTIVE_BPS
          )
        ).to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
      });

      it('an Executor address is the zero address', async () => {
        await expect(
          LiquidationModuleFactory.deploy(
            dexAdapter,
            multisig.address,
            [executors[0], executors[1], ZERO],
            pausers,
            INCENTIVE_BPS
          )
        ).to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });

      it('a Pauser address is the zero address', async () => {
        await expect(
          LiquidationModuleFactory.deploy(
            dexAdapter,
            multisig.address,
            executors,
            [pausers[0], pausers[1], ZERO],
            INCENTIVE_BPS
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
        revokeTx = await liquidationModule.connect(dao).revokeRole(EXECUTOR_ROLE, executors[0]);
        await expect(revokeTx).to.not.be.reverted;
      });

      it('emits RoleRevoked', async () => {
        await expect(revokeTx)
          .to.emit(liquidationModule, 'RoleRevoked').withArgs(EXECUTOR_ROLE, executors[0], dao.address);
      });

      it('clears the Executor role', async () => {
        expect(await liquidationModule.hasRole(EXECUTOR_ROLE, executors[0])).to.be.false;
      });
    });

    describe('revert when', function () {
      it('a non-DAO grants the role', async () => {
        await expect(liquidationModule.connect(other).grantRole(EXECUTOR_ROLE, fresh1.address))
          .to.be.revertedWith(missingRole(other.address, ADMIN_ROLE));
      });

      it('a non-DAO revokes the role', async () => {
        await expect(liquidationModule.connect(other).revokeRole(EXECUTOR_ROLE, executors[0]))
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
        revokeTx = await liquidationModule.connect(dao).revokeRole(PAUSER_ROLE, pausers[0]);
        await expect(revokeTx).to.not.be.reverted;
      });

      it('emits RoleRevoked', async () => {
        await expect(revokeTx)
          .to.emit(liquidationModule, 'RoleRevoked').withArgs(PAUSER_ROLE, pausers[0], dao.address);
      });

      it('clears the Pauser role', async () => {
        expect(await liquidationModule.hasRole(PAUSER_ROLE, pausers[0])).to.be.false;
      });
    });

    describe('revert when', function () {
      it('a non-DAO grants the role', async () => {
        await expect(liquidationModule.connect(other).grantRole(PAUSER_ROLE, fresh1.address))
          .to.be.revertedWith(missingRole(other.address, ADMIN_ROLE));
      });

      it('a non-DAO revokes the role', async () => {
        await expect(liquidationModule.connect(other).revokeRole(PAUSER_ROLE, pausers[0]))
          .to.be.revertedWith(missingRole(other.address, ADMIN_ROLE));
      });
    });
  });
});
