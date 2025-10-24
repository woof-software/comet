import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { expect, event, makeProtocol, wait } from './helpers';
import { takeSnapshot } from '@nomicfoundation/hardhat-network-helpers';
import type { SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers';
import { CometExt, CometHarnessInterfaceExtendedAssetList } from 'build/types';

describe.only('Extended Pause Functionality', function () {
  let snapshot: SnapshotRestorer;

  let comet: CometHarnessInterfaceExtendedAssetList;
  let cometExt: CometExt;

  let governor: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;
  let users: SignerWithAddress[];
  let assetIndex: number;

  before(async function () {
    const assets = {
      USDC: {},
      ASSET1: {},
      ASSET2: {},
      ASSET3: {},
    };

    const protocol = await makeProtocol({ assets });
    comet = protocol.cometWithExtendedAssetList;
    cometExt = comet.attach(comet.address) as CometExt;
    governor = protocol.governor;
    pauseGuardian = protocol.pauseGuardian;
    users = protocol.users;
    assetIndex = 0; // First asset is at index 0

    snapshot = await takeSnapshot();
  });

  afterEach(async () => await snapshot.restore());

  describe('Withdraw Pause Functions', function () {
    describe('pauseLendersWithdraw', function () {
      it('should allow governor to call pauseLendersWithdraw', async function () {
        await expect(cometExt.connect(governor).pauseLendersWithdraw(true)).to
          .not.be.reverted;
      });

      it('should allow pause guardian to call pauseLendersWithdraw', async function () {
        await expect(cometExt.connect(pauseGuardian).pauseLendersWithdraw(true))
          .to.not.be.reverted;
      });

      it('should revert when called by unauthorized user', async function () {
        await expect(
          cometExt.connect(users[0]).pauseLendersWithdraw(true)
        ).to.be.revertedWithCustomError(
          cometExt,
          'OnlyPauseGuardianOrGovernor'
        );
      });

      it('should change state when called by governor', async function () {
        // Initial state should be false
        expect(await comet.isLendersWithdrawPaused()).to.be.false;

        // Pause via governor
        await cometExt.connect(governor).pauseLendersWithdraw(true);

        // State should be changed to true
        expect(await comet.isLendersWithdrawPaused()).to.be.true;
      });

      it('should change state when called by pause guardian', async function () {
        // Initial state should be false
        expect(await comet.isLendersWithdrawPaused()).to.be.false;

        // Pause via pause guardian
        await cometExt.connect(pauseGuardian).pauseLendersWithdraw(true);

        // State should be changed to true
        expect(await comet.isLendersWithdrawPaused()).to.be.true;
      });

      it('should emit LendersWithdrawPauseAction event when pausing', async function () {
        await expect(cometExt.connect(governor).pauseLendersWithdraw(true))
          .to.emit(cometExt, 'LendersWithdrawPauseAction')
          .withArgs(true);
      });

      it('should verify internal check function prevents duplicate status setting', async function () {
        // Test that the internal currentPauseOffsetStatus check prevents setting same status
        // Initially false, try to set to false again - should revert
        await expect(
          cometExt.connect(governor).pauseLendersWithdraw(false)
        ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
      });

      it('should emit LendersWithdrawPauseAction event when unpausing', async function () {
        // First pause
        await cometExt.connect(governor).pauseLendersWithdraw(true);
        expect(await comet.isLendersWithdrawPaused()).to.be.true;

        // Then unpause and check event
        await expect(cometExt.connect(governor).pauseLendersWithdraw(false))
          .to.emit(cometExt, 'LendersWithdrawPauseAction')
          .withArgs(false);
      });

      it('should unpause lenders withdraw when called by governor', async function () {
        // First pause
        await cometExt.connect(governor).pauseLendersWithdraw(true);
        expect(await comet.isLendersWithdrawPaused()).to.be.true;

        // Then unpause
        await cometExt.connect(governor).pauseLendersWithdraw(false);
        expect(await comet.isLendersWithdrawPaused()).to.be.false;
      });

      it('should unpause lenders withdraw when called by pause guardian', async function () {
        // First pause
        await cometExt.connect(pauseGuardian).pauseLendersWithdraw(true);
        expect(await comet.isLendersWithdrawPaused()).to.be.true;

        // Then unpause
        await cometExt.connect(pauseGuardian).pauseLendersWithdraw(false);
        expect(await comet.isLendersWithdrawPaused()).to.be.false;
      });
    });

    describe('pauseBorrowersWithdraw', function () {
      it('should allow governor to call pauseBorrowersWithdraw', async function () {
        // Should not revert when called by governor
        await expect(cometExt.connect(governor).pauseBorrowersWithdraw(true)).to
          .not.be.reverted;
      });

      it('should allow pause guardian to call pauseBorrowersWithdraw', async function () {
        // Should not revert when called by pause guardian
        await expect(
          cometExt.connect(pauseGuardian).pauseBorrowersWithdraw(true)
        ).to.not.be.reverted;
      });

      it('should revert when called by unauthorized user', async function () {
        await expect(
          cometExt.connect(users[0]).pauseBorrowersWithdraw(true)
        ).to.be.revertedWith("custom error 'OnlyPauseGuardianOrGovernor()'");
      });

      it('should change state when called by governor', async function () {
        // Initial state should be false
        expect(await comet.isBorrowersWithdrawPaused()).to.be.false;

        // Pause via governor
        await cometExt.connect(governor).pauseBorrowersWithdraw(true);

        // State should be changed to true
        expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
      });

      it('should change state when called by pause guardian', async function () {
        // Initial state should be false
        expect(await comet.isBorrowersWithdrawPaused()).to.be.false;

        // Pause via pause guardian
        await cometExt.connect(pauseGuardian).pauseBorrowersWithdraw(true);

        // State should be changed to true
        expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
      });

      it('should emit BorrowersWithdrawPauseAction event when pausing', async function () {
        await expect(cometExt.connect(governor).pauseBorrowersWithdraw(true))
          .to.emit(cometExt, 'BorrowersWithdrawPauseAction')
          .withArgs(true);
      });

      it('should verify internal check function prevents duplicate status setting', async function () {
        // Test that the internal currentPauseOffsetStatus check prevents setting same status
        // Initially false, try to set to false again - should revert
        await expect(
          cometExt.connect(governor).pauseBorrowersWithdraw(false)
        ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
      });

      it('should emit BorrowersWithdrawPauseAction event when unpausing', async function () {
        // First pause
        await cometExt.connect(governor).pauseBorrowersWithdraw(true);
        expect(await comet.isBorrowersWithdrawPaused()).to.be.true;

        // Then unpause and check event
        const txn = await wait(
          cometExt.connect(governor).pauseBorrowersWithdraw(false)
        );

        expect(event(txn, 0)).to.be.deep.equal({
          BorrowersWithdrawPauseAction: {
            borrowersWithdrawPaused: false,
          },
        });
      });

      it('should unpause borrowers withdraw when called by governor', async function () {
        // First pause
        await cometExt.connect(governor).pauseBorrowersWithdraw(true);
        expect(await comet.isBorrowersWithdrawPaused()).to.be.true;

        // Then unpause
        await cometExt.connect(governor).pauseBorrowersWithdraw(false);
        expect(await comet.isBorrowersWithdrawPaused()).to.be.false;
      });

      it('should unpause borrowers withdraw when called by pause guardian', async function () {
        // First pause
        await cometExt.connect(pauseGuardian).pauseBorrowersWithdraw(true);
        expect(await comet.isBorrowersWithdrawPaused()).to.be.true;

        // Then unpause
        await cometExt.connect(pauseGuardian).pauseBorrowersWithdraw(false);
        expect(await comet.isBorrowersWithdrawPaused()).to.be.false;
      });
    });

    describe('pauseCollateralWithdraw', function () {
      it('should allow governor to call pauseCollateralWithdraw', async function () {
        // Should not revert when called by governor
        await expect(
          cometExt.connect(governor).pauseCollateralWithdraw(true)
        ).to.not.be.reverted;
      });

      it('should allow pause guardian to call pauseCollateralWithdraw', async function () {
        // Should not revert when called by pause guardian
        await expect(
          cometExt
            .connect(pauseGuardian)
            .pauseCollateralWithdraw(true)
        ).to.not.be.reverted;
      });

      it('should revert when called by unauthorized user', async function () {
        await expect(
          cometExt.connect(users[0]).pauseCollateralWithdraw(true)
        ).to.be.revertedWith("custom error 'OnlyPauseGuardianOrGovernor()'");
      });

      it('should change state when called by governor', async function () {
        // Initial state should be false
        expect(await comet.isCollateralWithdrawPaused()).to.be
          .false;

        // Pause via governor
        await cometExt
          .connect(governor)
          .pauseCollateralWithdraw(true);

        // State should be changed to true
        expect(await comet.isCollateralWithdrawPaused()).to.be
          .true;
      });

      it('should change state when called by pause guardian', async function () {
        // Initial state should be false
        expect(await comet.isCollateralWithdrawPaused()).to.be
          .false;

        // Pause via pause guardian
        await cometExt
          .connect(pauseGuardian)
          .pauseCollateralWithdraw(true);

        // State should be changed to true
        expect(await comet.isCollateralWithdrawPaused()).to.be
          .true;
      });

      it('should emit CollateralWithdrawPauseAction event when pausing', async function () {
        const txn = await wait(
          cometExt.connect(governor).pauseCollateralWithdraw(true)
        );

        expect(event(txn, 0)).to.be.deep.equal({
          CollateralWithdrawPauseAction: {
            collateralWithdrawPaused: true,
          },
        });
      });

      it('should verify internal check function prevents duplicate status setting', async function () {
        // Test that the internal currentPauseOffsetStatus check prevents setting same status
        // Initially false, try to set to false again - should revert
        await expect(
          cometExt.connect(governor).pauseCollateralWithdraw(false)
        ).to.be.revertedWithCustomError(
          cometExt,
          'OffsetStatusAlreadySet'
        );
      });

      it('should emit CollateralWithdrawPauseAction event when unpausing', async function () {
        // First pause
        await cometExt
          .connect(governor)
          .pauseCollateralWithdraw(true);
        expect(await comet.isCollateralWithdrawPaused()).to.be
          .true;

        // Then unpause and check event
        const txn = await wait(
          cometExt.connect(governor).pauseCollateralWithdraw(false)
        );

        expect(event(txn, 0)).to.be.deep.equal({
          CollateralWithdrawPauseAction: {
            collateralWithdrawPaused: false,
          },
        });
      });

      it('should unpause collateral withdraw when called by governor', async function () {
        // First pause
        await cometExt
          .connect(governor)
          .pauseCollateralWithdraw(true);
        expect(await comet.isCollateralWithdrawPaused()).to.be
          .true;

        // Then unpause
        await cometExt
          .connect(governor)
          .pauseCollateralWithdraw(false);
        expect(await comet.isCollateralWithdrawPaused()).to.be
          .false;
      });

      it('should unpause collateral withdraw when called by pause guardian', async function () {
        // First pause
        await cometExt
          .connect(pauseGuardian)
          .pauseCollateralWithdraw(true);
        expect(await comet.isCollateralWithdrawPaused()).to.be
          .true;

        // Then unpause
        await cometExt
          .connect(pauseGuardian)
          .pauseCollateralWithdraw(false);
        expect(await comet.isCollateralWithdrawPaused()).to.be
          .false;
      });

      it('should handle multiple asset indices independently', async function () {
        // Pause asset 0
        await cometExt.connect(governor).pauseCollateralAssetWithdraw(0, true);
        expect(await comet.isCollateralAssetWithdrawPaused(0)).to.be.true;
        expect(await comet.isCollateralAssetWithdrawPaused(1)).to.be.false;

        // Pause asset 1
        await cometExt.connect(governor).pauseCollateralAssetWithdraw(1, true);
        expect(await comet.isCollateralAssetWithdrawPaused(0)).to.be.true;
        expect(await comet.isCollateralAssetWithdrawPaused(1)).to.be.true;

        // Unpause asset 0 only
        await cometExt.connect(governor).pauseCollateralAssetWithdraw(0, false);
        expect(await comet.isCollateralAssetWithdrawPaused(0)).to.be.false;
        expect(await comet.isCollateralAssetWithdrawPaused(1)).to.be.true;
      });
    });

    describe('pauseCollateralAssetWithdraw', function () {
      it('should allow governor to call pauseCollateralAssetWithdraw', async function () {
        await expect(cometExt.connect(governor).pauseCollateralAssetWithdraw(assetIndex, true)).to
          .not.be.reverted;
      });

      it('should allow pause guardian to call pauseCollateralAssetWithdraw', async function () {
        await expect(cometExt.connect(pauseGuardian).pauseCollateralAssetWithdraw(assetIndex, true))
          .to.not.be.reverted;
      });

      it('should revert when called by unauthorized user', async function () {
        await expect(
          cometExt.connect(users[0]).pauseCollateralAssetWithdraw(assetIndex, true)
        ).to.be.revertedWithCustomError(
          cometExt,
          'OnlyPauseGuardianOrGovernor'
        );
      });

      it('should change state when called by governor', async function () {
        // Initial state should be false
        expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be.false;

        // Pause via governor
        await cometExt.connect(governor).pauseCollateralAssetWithdraw(assetIndex, true);

        // State should be changed to true
        expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be.true;
      });

      it('should change state when called by pause guardian', async function () {
        // Initial state should be false
        expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be.false;

        // Pause via pause guardian
        await cometExt.connect(pauseGuardian).pauseCollateralAssetWithdraw(assetIndex, true);

        // State should be changed to true
        expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be.true;
      });

      it('should emit CollateralAssetWithdrawPauseAction event when pausing', async function () {
        await expect(cometExt.connect(governor).pauseCollateralAssetWithdraw(assetIndex, true))
          .to.emit(cometExt, 'CollateralAssetWithdrawPauseAction')
          .withArgs(assetIndex, true);
      });

      it('should verify internal check function prevents duplicate status setting', async function () {
        // Test that the internal check prevents setting same status
        // Initially false, try to set to false again - should revert
        await expect(
          cometExt.connect(governor).pauseCollateralAssetWithdraw(assetIndex, false)
        ).to.be.revertedWithCustomError(cometExt, 'CollateralAssetOffsetStatusAlreadySet');
      });

      it('should emit CollateralAssetWithdrawPauseAction event when unpausing', async function () {
        // First pause
        await cometExt.connect(governor).pauseCollateralAssetWithdraw(assetIndex, true);
        expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be.true;

        // Then unpause and check event
        await expect(cometExt.connect(governor).pauseCollateralAssetWithdraw(assetIndex, false))
          .to.emit(cometExt, 'CollateralAssetWithdrawPauseAction')
          .withArgs(assetIndex, false);
      });

      it('should unpause collateral asset withdraw when called by governor', async function () {
        // First pause
        await cometExt.connect(governor).pauseCollateralAssetWithdraw(assetIndex, true);
        expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be.true;

        // Then unpause
        await cometExt.connect(governor).pauseCollateralAssetWithdraw(assetIndex, false);
        expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be.false;
      });

      it('should unpause collateral asset withdraw when called by pause guardian', async function () {
        // First pause
        await cometExt.connect(pauseGuardian).pauseCollateralAssetWithdraw(assetIndex, true);
        expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be.true;

        // Then unpause
        await cometExt.connect(pauseGuardian).pauseCollateralAssetWithdraw(assetIndex, false);
        expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be.false;
      });

      it('should revert with InvalidAssetIndex for invalid asset index', async function () {
        const numAssets = await comet.numAssets();
        const invalidAssetIndex = numAssets; // This should be invalid (0-based indexing)

        await expect(
          cometExt.connect(governor).pauseCollateralAssetWithdraw(invalidAssetIndex, true)
        ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
      });
    });
  });

  describe('Supply Pause Functions', function () {
    describe('pauseCollateralSupply', function () {
      it('should allow governor to call pauseCollateralSupply', async function () {
        await expect(cometExt.connect(governor).pauseCollateralSupply(true)).to
          .not.be.reverted;
      });

      it('should allow pause guardian to call pauseCollateralSupply', async function () {
        await expect(
          cometExt.connect(pauseGuardian).pauseCollateralSupply(true)
        ).to.not.be.reverted;
      });

      it('should revert when called by unauthorized user', async function () {
        await expect(
          cometExt.connect(users[0]).pauseCollateralSupply(true)
        ).to.be.revertedWithCustomError(
          cometExt,
          'OnlyPauseGuardianOrGovernor'
        );
      });

      it('should change state when called by governor', async function () {
        // Initial state should be false
        expect(await comet.isCollateralSupplyPaused()).to.be.false;

        // Pause via governor
        await cometExt.connect(governor).pauseCollateralSupply(true);

        // State should be changed to true
        expect(await comet.isCollateralSupplyPaused()).to.be.true;
      });

      it('should change state when called by pause guardian', async function () {
        // Initial state should be false
        expect(await comet.isCollateralSupplyPaused()).to.be.false;

        // Pause via pause guardian
        await cometExt.connect(pauseGuardian).pauseCollateralSupply(true);

        // State should be changed to true
        expect(await comet.isCollateralSupplyPaused()).to.be.true;
      });

      it('should emit LendersSupplyPauseAction event when pausing', async function () {
        await expect(cometExt.connect(governor).pauseCollateralSupply(true))
          .to.emit(cometExt, 'LendersSupplyPauseAction')
          .withArgs(true);
      });

      it('should verify internal check function prevents duplicate status setting', async function () {
        // Test that the internal currentPauseOffsetStatus check prevents setting same status
        // Initially false, try to set to false again - should revert
        await expect(
          cometExt.connect(governor).pauseCollateralSupply(false)
        ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
      });

      it('should emit LendersSupplyPauseAction event when unpausing', async function () {
        // First pause
        await cometExt.connect(governor).pauseCollateralSupply(true);
        expect(await comet.isCollateralSupplyPaused()).to.be.true;

        // Then unpause and check event
        await expect(cometExt.connect(governor).pauseCollateralSupply(false))
          .to.emit(cometExt, 'LendersSupplyPauseAction')
          .withArgs(false);
      });

      it('should unpause collateral supply when called by governor', async function () {
        // First pause
        await cometExt.connect(governor).pauseCollateralSupply(true);
        expect(await comet.isCollateralSupplyPaused()).to.be.true;

        // Then unpause
        await cometExt.connect(governor).pauseCollateralSupply(false);
        expect(await comet.isCollateralSupplyPaused()).to.be.false;
      });

      it('should unpause collateral supply when called by pause guardian', async function () {
        // First pause
        await cometExt.connect(pauseGuardian).pauseCollateralSupply(true);
        expect(await comet.isCollateralSupplyPaused()).to.be.true;

        // Then unpause
        await cometExt.connect(pauseGuardian).pauseCollateralSupply(false);
        expect(await comet.isCollateralSupplyPaused()).to.be.false;
      });
    });

    describe('pauseBaseSupply', function () {
      it('should allow governor to call pauseBaseSupply', async function () {
        await expect(cometExt.connect(governor).pauseBaseSupply(true)).to.not.be
          .reverted;
      });

      it('should allow pause guardian to call pauseBaseSupply', async function () {
        await expect(cometExt.connect(pauseGuardian).pauseBaseSupply(true)).to
          .not.be.reverted;
      });

      it('should revert when called by unauthorized user', async function () {
        await expect(
          cometExt.connect(users[0]).pauseBaseSupply(true)
        ).to.be.revertedWithCustomError(
          cometExt,
          'OnlyPauseGuardianOrGovernor'
        );
      });

      it('should change state when called by governor', async function () {
        // Initial state should be false
        expect(await comet.isBaseSupplyPaused()).to.be.false;

        // Pause via governor
        await cometExt.connect(governor).pauseBaseSupply(true);

        // State should be changed to true
        expect(await comet.isBaseSupplyPaused()).to.be.true;
      });

      it('should change state when called by pause guardian', async function () {
        // Initial state should be false
        expect(await comet.isBaseSupplyPaused()).to.be.false;

        // Pause via pause guardian
        await cometExt.connect(pauseGuardian).pauseBaseSupply(true);

        // State should be changed to true
        expect(await comet.isBaseSupplyPaused()).to.be.true;
      });

      it('should emit BorrowersSupplyPauseAction event when pausing', async function () {
        await expect(cometExt.connect(governor).pauseBaseSupply(true))
          .to.emit(cometExt, 'BorrowersSupplyPauseAction')
          .withArgs(true);
      });

      it('should verify internal check function prevents duplicate status setting', async function () {
        // Test that the internal currentPauseOffsetStatus check prevents setting same status
        // Initially false, try to set to false again - should revert
        await expect(
          cometExt.connect(governor).pauseBaseSupply(false)
        ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
      });

      it('should emit BorrowersSupplyPauseAction event when unpausing', async function () {
        // First pause
        await cometExt.connect(governor).pauseBaseSupply(true);
        expect(await comet.isBaseSupplyPaused()).to.be.true;

        // Then unpause and check event
        await expect(cometExt.connect(governor).pauseBaseSupply(false))
          .to.emit(cometExt, 'BorrowersSupplyPauseAction')
          .withArgs(false);
      });

      it('should unpause base supply when called by governor', async function () {
        // First pause
        await cometExt.connect(governor).pauseBaseSupply(true);
        expect(await comet.isBaseSupplyPaused()).to.be.true;

        // Then unpause
        await cometExt.connect(governor).pauseBaseSupply(false);
        expect(await comet.isBaseSupplyPaused()).to.be.false;
      });

      it('should unpause base supply when called by pause guardian', async function () {
        // First pause
        await cometExt.connect(pauseGuardian).pauseBaseSupply(true);
        expect(await comet.isBaseSupplyPaused()).to.be.true;

        // Then unpause
        await cometExt.connect(pauseGuardian).pauseBaseSupply(false);
        expect(await comet.isBaseSupplyPaused()).to.be.false;
      });
    });

    describe('pauseCollateralAssetSupply', function () {
      it('should allow governor to call pauseCollateralAssetSupply', async function () {
        await expect(
          cometExt
            .connect(governor)
            .pauseCollateralAssetSupply(assetIndex, true)
        ).to.not.be.reverted;
      });

      it('should allow pause guardian to call pauseCollateralAssetSupply', async function () {
        await expect(
          cometExt
            .connect(pauseGuardian)
            .pauseCollateralAssetSupply(assetIndex, true)
        ).to.not.be.reverted;
      });

      it('should revert when called by unauthorized user', async function () {
        await expect(
          cometExt
            .connect(users[0])
            .pauseCollateralAssetSupply(assetIndex, true)
        ).to.be.revertedWithCustomError(
          cometExt,
          'OnlyPauseGuardianOrGovernor'
        );
      });

      it('should change state when called by governor', async function () {
        // Initial state should be false
        expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
          .false;

        // Pause via governor
        await cometExt
          .connect(governor)
          .pauseCollateralAssetSupply(assetIndex, true);

        // State should be changed to true
        expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
          .true;
      });

      it('should change state when called by pause guardian', async function () {
        // Initial state should be false
        expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
          .false;

        // Pause via pause guardian
        await cometExt
          .connect(pauseGuardian)
          .pauseCollateralAssetSupply(assetIndex, true);

        // State should be changed to true
        expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
          .true;
      });

      it('should emit CollateralAssetSupplyPauseAction event when pausing', async function () {
        await expect(
          cometExt
            .connect(governor)
            .pauseCollateralAssetSupply(assetIndex, true)
        )
          .to.emit(cometExt, 'CollateralAssetSupplyPauseAction')
          .withArgs(assetIndex, true);
      });

      it('should verify internal check function prevents duplicate status setting', async function () {
        // Test that the internal check prevents setting same status
        // Initially false, try to set to false again - should revert
        await expect(
          cometExt.connect(governor).pauseCollateralAssetSupply(assetIndex, false)
        ).to.be.revertedWithCustomError(cometExt, 'CollateralAssetOffsetStatusAlreadySet');
      });

      it('should emit CollateralAssetSupplyPauseAction event when unpausing', async function () {
        // First pause
        await cometExt
          .connect(governor)
          .pauseCollateralAssetSupply(assetIndex, true);
        expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
          .true;

        // Then unpause and check event
        await expect(
          cometExt
            .connect(governor)
            .pauseCollateralAssetSupply(assetIndex, false)
        )
          .to.emit(cometExt, 'CollateralAssetSupplyPauseAction')
          .withArgs(assetIndex, false);
      });

      it('should unpause collateral asset supply when called by governor', async function () {
        // First pause
        await cometExt
          .connect(governor)
          .pauseCollateralAssetSupply(assetIndex, true);
        expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
          .true;

        // Then unpause
        await cometExt
          .connect(governor)
          .pauseCollateralAssetSupply(assetIndex, false);
        expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
          .false;
      });

      it('should unpause collateral asset supply when called by pause guardian', async function () {
        // First pause
        await cometExt
          .connect(pauseGuardian)
          .pauseCollateralAssetSupply(assetIndex, true);
        expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
          .true;

        // Then unpause
        await cometExt
          .connect(pauseGuardian)
          .pauseCollateralAssetSupply(assetIndex, false);
        expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
          .false;
      });

      it('should revert with InvalidAssetIndex for invalid asset index', async function () {
        const numAssets = await comet.numAssets();
        const invalidAssetIndex = numAssets; // This should be invalid (0-based indexing)

        await expect(
          cometExt.connect(governor).pauseCollateralAssetSupply(invalidAssetIndex, true)
        ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
      });

      it('should handle multiple asset indices independently', async function () {
        // Pause asset 0
        await cometExt.connect(governor).pauseCollateralAssetSupply(0, true);
        expect(await comet.isCollateralAssetSupplyPaused(0)).to.be.true;
        expect(await comet.isCollateralAssetSupplyPaused(1)).to.be.false;

        // Pause asset 1
        await cometExt.connect(governor).pauseCollateralAssetSupply(1, true);
        expect(await comet.isCollateralAssetSupplyPaused(0)).to.be.true;
        expect(await comet.isCollateralAssetSupplyPaused(1)).to.be.true;

        // Unpause asset 0 only
        await cometExt.connect(governor).pauseCollateralAssetSupply(0, false);
        expect(await comet.isCollateralAssetSupplyPaused(0)).to.be.false;
        expect(await comet.isCollateralAssetSupplyPaused(1)).to.be.true;
      });
    });
  });

  describe('Transfer Pause Functions', function () {
    describe('pauseLendersTransfer', function () {
      it('should allow governor to call pauseLendersTransfer', async function () {
        await expect(cometExt.connect(governor).pauseLendersTransfer(true)).to
          .not.be.reverted;
      });

      it('should allow pause guardian to call pauseLendersTransfer', async function () {
        await expect(cometExt.connect(pauseGuardian).pauseLendersTransfer(true))
          .to.not.be.reverted;
      });

      it('should revert when called by unauthorized user', async function () {
        await expect(
          cometExt.connect(users[0]).pauseLendersTransfer(true)
        ).to.be.revertedWithCustomError(
          cometExt,
          'OnlyPauseGuardianOrGovernor'
        );
      });

      it('should change state when called by governor', async function () {
        // Initial state should be false
        expect(await comet.isLendersTransferPaused()).to.be.false;

        // Pause via governor
        await cometExt.connect(governor).pauseLendersTransfer(true);

        // State should be changed to true
        expect(await comet.isLendersTransferPaused()).to.be.true;
      });

      it('should change state when called by pause guardian', async function () {
        // Initial state should be false
        expect(await comet.isLendersTransferPaused()).to.be.false;

        // Pause via pause guardian
        await cometExt.connect(pauseGuardian).pauseLendersTransfer(true);

        // State should be changed to true
        expect(await comet.isLendersTransferPaused()).to.be.true;
      });

      it('should emit LendersTransferPauseAction event when pausing', async function () {
        await expect(cometExt.connect(governor).pauseLendersTransfer(true))
          .to.emit(cometExt, 'LendersTransferPauseAction')
          .withArgs(true);
      });

      it('should emit LendersTransferPauseAction event when unpausing', async function () {
        // First pause
        await cometExt.connect(governor).pauseLendersTransfer(true);
        expect(await comet.isLendersTransferPaused()).to.be.true;

        // Then unpause and check event
        await expect(cometExt.connect(governor).pauseLendersTransfer(false))
          .to.emit(cometExt, 'LendersTransferPauseAction')
          .withArgs(false);
      });

      it('should unpause lenders transfer when called by governor', async function () {
        // First pause
        await cometExt.connect(governor).pauseLendersTransfer(true);
        expect(await comet.isLendersTransferPaused()).to.be.true;

        // Then unpause
        await cometExt.connect(governor).pauseLendersTransfer(false);
        expect(await comet.isLendersTransferPaused()).to.be.false;
      });

      it('should unpause lenders transfer when called by pause guardian', async function () {
        // First pause
        await cometExt.connect(pauseGuardian).pauseLendersTransfer(true);
        expect(await comet.isLendersTransferPaused()).to.be.true;

        // Then unpause
        await cometExt.connect(pauseGuardian).pauseLendersTransfer(false);
        expect(await comet.isLendersTransferPaused()).to.be.false;
      });
    });

    describe('pauseBorrowersTransfer', function () {
      it('should allow governor to call pauseBorrowersTransfer', async function () {
        await expect(cometExt.connect(governor).pauseBorrowersTransfer(true)).to
          .not.be.reverted;
      });

      it('should allow pause guardian to call pauseBorrowersTransfer', async function () {
        await expect(
          cometExt.connect(pauseGuardian).pauseBorrowersTransfer(true)
        ).to.not.be.reverted;
      });

      it('should revert when called by unauthorized user', async function () {
        await expect(
          cometExt.connect(users[0]).pauseBorrowersTransfer(true)
        ).to.be.revertedWithCustomError(
          cometExt,
          'OnlyPauseGuardianOrGovernor'
        );
      });

      it('should change state when called by governor', async function () {
        // Initial state should be false
        expect(await comet.isBorrowersTransferPaused()).to.be.false;

        // Pause via governor
        await cometExt.connect(governor).pauseBorrowersTransfer(true);

        // State should be changed to true
        expect(await comet.isBorrowersTransferPaused()).to.be.true;
      });

      it('should change state when called by pause guardian', async function () {
        // Initial state should be false
        expect(await comet.isBorrowersTransferPaused()).to.be.false;

        // Pause via pause guardian
        await cometExt.connect(pauseGuardian).pauseBorrowersTransfer(true);

        // State should be changed to true
        expect(await comet.isBorrowersTransferPaused()).to.be.true;
      });

      it('should emit BorrowersTransferPauseAction event when pausing', async function () {
        await expect(cometExt.connect(governor).pauseBorrowersTransfer(true))
          .to.emit(cometExt, 'BorrowersTransferPauseAction')
          .withArgs(true);
      });

      it('should emit BorrowersTransferPauseAction event when unpausing', async function () {
        // First pause
        await cometExt.connect(governor).pauseBorrowersTransfer(true);
        expect(await comet.isBorrowersTransferPaused()).to.be.true;

        // Then unpause and check event
        await expect(cometExt.connect(governor).pauseBorrowersTransfer(false))
          .to.emit(cometExt, 'BorrowersTransferPauseAction')
          .withArgs(false);
      });

      it('should unpause borrowers transfer when called by governor', async function () {
        // First pause
        await cometExt.connect(governor).pauseBorrowersTransfer(true);
        expect(await comet.isBorrowersTransferPaused()).to.be.true;

        // Then unpause
        await cometExt.connect(governor).pauseBorrowersTransfer(false);
        expect(await comet.isBorrowersTransferPaused()).to.be.false;
      });

      it('should unpause borrowers transfer when called by pause guardian', async function () {
        // First pause
        await cometExt.connect(pauseGuardian).pauseBorrowersTransfer(true);
        expect(await comet.isBorrowersTransferPaused()).to.be.true;

        // Then unpause
        await cometExt.connect(pauseGuardian).pauseBorrowersTransfer(false);
        expect(await comet.isBorrowersTransferPaused()).to.be.false;
      });
    });

    describe('pauseCollateralTransfer', function () {
      it('should allow governor to call pauseCollateralTransfer', async function () {
        await expect(
          cometExt.connect(governor).pauseCollateralTransfer(true)
        ).to.not.be.reverted;
      });

      it('should allow pause guardian to call pauseCollateralTransfer', async function () {
        await expect(
          cometExt
            .connect(pauseGuardian)
            .pauseCollateralTransfer(true)
        ).to.not.be.reverted;
      });

      it('should revert when called by unauthorized user', async function () {
        await expect(
          cometExt.connect(users[0]).pauseCollateralTransfer(true)
        ).to.be.revertedWithCustomError(
          cometExt,
          'OnlyPauseGuardianOrGovernor'
        );
      });

      it('should change state when called by governor', async function () {
        // Initial state should be false
        expect(await comet.isCollateralTransferPaused()).to.be
          .false;

        // Pause via governor
        await cometExt
          .connect(governor)
          .pauseCollateralTransfer(true);

        // State should be changed to true
        expect(await comet.isCollateralTransferPaused()).to.be
          .true;
      });

      it('should change state when called by pause guardian', async function () {
        // Initial state should be false
        expect(await comet.isCollateralTransferPaused()).to.be
          .false;

        // Pause via pause guardian
        await cometExt
          .connect(pauseGuardian)
          .pauseCollateralTransfer(true);

        // State should be changed to true
        expect(await comet.isCollateralTransferPaused()).to.be
          .true;
      });

      it('should emit CollateralTransferPauseAction event when pausing', async function () {
        await expect(
          cometExt.connect(governor).pauseCollateralTransfer(true)
        )
          .to.emit(cometExt, 'CollateralTransferPauseAction')
          .withArgs(true);
      });

      it('should emit CollateralTransferPauseAction event when unpausing', async function () {
        // First pause
        await cometExt
          .connect(governor)
          .pauseCollateralTransfer(true);
        expect(await comet.isCollateralTransferPaused()).to.be
          .true;

        // Then unpause and check event
        await expect(
          cometExt.connect(governor).pauseCollateralTransfer(false)
        )
          .to.emit(cometExt, 'CollateralTransferPauseAction')
          .withArgs(false);
      });

      it('should unpause collateral transfer when called by governor', async function () {
        // First pause
        await cometExt
          .connect(governor)
          .pauseCollateralTransfer(true);
        expect(await comet.isCollateralTransferPaused()).to.be
          .true;

        // Then unpause
        await cometExt
          .connect(governor)
          .pauseCollateralTransfer(false);
        expect(await comet.isCollateralTransferPaused()).to.be
          .false;
      });

      it('should unpause collateral transfer when called by pause guardian', async function () {
        // First pause
        await cometExt
          .connect(pauseGuardian)
          .pauseCollateralTransfer(true);
        expect(await comet.isCollateralTransferPaused()).to.be
          .true;

        // Then unpause
        await cometExt
          .connect(pauseGuardian)
          .pauseCollateralTransfer(false);
        expect(await comet.isCollateralTransferPaused()).to.be
          .false;
      });

      it('should handle multiple asset indices independently', async function () {
        // Pause asset 0
        await cometExt.connect(governor).pauseCollateralAssetTransfer(0, true);
        expect(await comet.isCollateralAssetTransferPaused(0)).to.be.true;
        expect(await comet.isCollateralAssetTransferPaused(1)).to.be.false;

        // Pause asset 1
        await cometExt.connect(governor).pauseCollateralAssetTransfer(1, true);
        expect(await comet.isCollateralAssetTransferPaused(0)).to.be.true;
        expect(await comet.isCollateralAssetTransferPaused(1)).to.be.true;

        // Unpause asset 0 only
        await cometExt.connect(governor).pauseCollateralAssetTransfer(0, false);
        expect(await comet.isCollateralAssetTransferPaused(0)).to.be.false;
        expect(await comet.isCollateralAssetTransferPaused(1)).to.be.true;
      });
    });

    describe('pauseCollateralAssetTransfer', function () {
      it('should allow governor to call pauseCollateralAssetTransfer', async function () {
        await expect(cometExt.connect(governor).pauseCollateralAssetTransfer(assetIndex, true)).to
          .not.be.reverted;
      });

      it('should allow pause guardian to call pauseCollateralAssetTransfer', async function () {
        await expect(cometExt.connect(pauseGuardian).pauseCollateralAssetTransfer(assetIndex, true))
          .to.not.be.reverted;
      });

      it('should revert when called by unauthorized user', async function () {
        await expect(
          cometExt.connect(users[0]).pauseCollateralAssetTransfer(assetIndex, true)
        ).to.be.revertedWithCustomError(
          cometExt,
          'OnlyPauseGuardianOrGovernor'
        );
      });

      it('should change state when called by governor', async function () {
        // Initial state should be false
        expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be.false;

        // Pause via governor
        await cometExt.connect(governor).pauseCollateralAssetTransfer(assetIndex, true);

        // State should be changed to true
        expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be.true;
      });

      it('should change state when called by pause guardian', async function () {
        // Initial state should be false
        expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be.false;

        // Pause via pause guardian
        await cometExt.connect(pauseGuardian).pauseCollateralAssetTransfer(assetIndex, true);

        // State should be changed to true
        expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be.true;
      });

      it('should emit CollateralAssetTransferPauseAction event when pausing', async function () {
        await expect(cometExt.connect(governor).pauseCollateralAssetTransfer(assetIndex, true))
          .to.emit(cometExt, 'CollateralAssetTransferPauseAction')
          .withArgs(assetIndex, true);
      });

      it('should verify internal check function prevents duplicate status setting', async function () {
        // Test that the internal check prevents setting same status
        // Initially false, try to set to false again - should revert

        expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be.false;

        await expect(
          cometExt.connect(governor).pauseCollateralAssetTransfer(assetIndex, false)
        ).to.be.revertedWithCustomError(cometExt, 'CollateralAssetOffsetStatusAlreadySet');
      });

      it('should emit CollateralAssetTransferPauseAction event when unpausing', async function () {
        // First pause
        await cometExt.connect(governor).pauseCollateralAssetTransfer(assetIndex, true);
        expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be.true;

        // Then unpause and check event
        await expect(cometExt.connect(governor).pauseCollateralAssetTransfer(assetIndex, false))
          .to.emit(cometExt, 'CollateralAssetTransferPauseAction')
          .withArgs(assetIndex, false);
      });

      it('should unpause collateral asset transfer when called by governor', async function () {
        // First pause
        await cometExt.connect(governor).pauseCollateralAssetTransfer(assetIndex, true);
        expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be.true;

        // Then unpause
        await cometExt.connect(governor).pauseCollateralAssetTransfer(assetIndex, false);
        expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be.false;
      });

      it('should unpause collateral asset transfer when called by pause guardian', async function () {
        // First pause
        await cometExt.connect(pauseGuardian).pauseCollateralAssetTransfer(assetIndex, true);
        expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be.true;

        // Then unpause
        await cometExt.connect(pauseGuardian).pauseCollateralAssetTransfer(assetIndex, false);
        expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be.false;
      });

      it('should revert with InvalidAssetIndex for invalid asset index', async function () {
        const numAssets = await comet.numAssets();
        const invalidAssetIndex = numAssets; // This should be invalid (0-based indexing)

        await expect(
          cometExt.connect(governor).pauseCollateralAssetTransfer(invalidAssetIndex, true)
        ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
      });
    });
  });

  describe('View Functions for Pause States', function () {
    it('should return correct initial pause states', async function () {
      // All pause states should be false initially
      expect(await comet.isLendersWithdrawPaused()).to.be.false;
      expect(await comet.isBorrowersWithdrawPaused()).to.be.false;
      expect(await comet.isCollateralAssetWithdrawPaused(0)).to.be.false;
      expect(await comet.isCollateralSupplyPaused()).to.be.false;
      expect(await comet.isBaseSupplyPaused()).to.be.false;
      expect(await comet.isCollateralAssetSupplyPaused(0)).to.be.false;
      expect(await comet.isLendersTransferPaused()).to.be.false;
      expect(await comet.isBorrowersTransferPaused()).to.be.false;
      expect(await comet.isCollateralAssetTransferPaused(0)).to.be.false;
    });

    it('should return correct pause states after setting them', async function () {
      // Set all pause flags to true
      await cometExt.connect(governor).pauseLendersWithdraw(true);
      await cometExt.connect(governor).pauseBorrowersWithdraw(true);
      await cometExt.connect(governor).pauseCollateralWithdraw(true);
      await cometExt.connect(governor).pauseCollateralAssetWithdraw(0, true);
      await cometExt.connect(governor).pauseCollateralSupply(true);
      await cometExt.connect(governor).pauseBaseSupply(true);
      await cometExt.connect(governor).pauseCollateralAssetSupply(0, true);
      await cometExt.connect(governor).pauseLendersTransfer(true);
      await cometExt.connect(governor).pauseBorrowersTransfer(true);
      await cometExt.connect(governor).pauseCollateralTransfer(true);
      await cometExt.connect(governor).pauseCollateralAssetTransfer(0, true);

      // All pause states should be true
      expect(await comet.isLendersWithdrawPaused()).to.be.true;
      expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
      expect(await comet.isCollateralWithdrawPaused()).to.be.true;
      expect(await comet.isCollateralAssetWithdrawPaused(0)).to.be.true;
      expect(await comet.isCollateralSupplyPaused()).to.be.true;
      expect(await comet.isBaseSupplyPaused()).to.be.true;
      expect(await comet.isCollateralAssetSupplyPaused(0)).to.be.true;
      expect(await comet.isLendersTransferPaused()).to.be.true;
      expect(await comet.isBorrowersTransferPaused()).to.be.true;
      expect(await comet.isCollateralTransferPaused()).to.be.true;
      expect(await comet.isCollateralAssetTransferPaused(0)).to.be.true;
    });

    it('should handle multiple asset indices correctly', async function () {
      // Test with multiple asset indices (WETH=0, WBTC=1)
      await cometExt.connect(governor).pauseCollateralAssetWithdraw(0, true);
      await cometExt.connect(governor).pauseCollateralAssetWithdraw(1, true);

      expect(await comet.isCollateralAssetWithdrawPaused(0)).to.be.true;
      expect(await comet.isCollateralAssetWithdrawPaused(1)).to.be.true;
    });

    it('should handle edge case asset indices', async function () {
      // Test with the highest available asset index (WBTC=1)
      const maxAssetIndex = 1;

      await cometExt
        .connect(governor)
        .pauseCollateralAssetWithdraw(maxAssetIndex, true);
      expect(await comet.isCollateralAssetWithdrawPaused(maxAssetIndex)).to.be
        .true;

      await cometExt
        .connect(governor)
        .pauseCollateralAssetWithdraw(maxAssetIndex, false);
      expect(await comet.isCollateralAssetWithdrawPaused(maxAssetIndex)).to.be
        .false;
    });
  });

  describe('isValidAssetIndex', function () {
    it('should work with 3 collaterals - set pauses for all assets', async function () {
      // Create a new comet with 3 collaterals
      const assets = {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
      };

      const protocol = await makeProtocol({ assets });
      const comet = protocol.cometWithExtendedAssetList;
      const cometExt = comet.attach(comet.address) as CometExt;
      const governor = protocol.governor;

      const numAssets = await comet.numAssets();

      for (let i = 0; i < numAssets; i++) {
        await cometExt.connect(governor).pauseCollateralAssetWithdraw(i, true);
        await cometExt.connect(governor).pauseCollateralAssetSupply(i, true);
        await cometExt.connect(governor).pauseCollateralAssetTransfer(i, true);
      }

      // Verify the pause states are set correctly
      for (let i = 0; i < numAssets; i++) {
        expect(await comet.isCollateralAssetWithdrawPaused(i)).to.be.true;
        expect(await comet.isCollateralAssetSupplyPaused(i)).to.be.true;
        expect(await comet.isCollateralAssetTransferPaused(i)).to.be.true;
      }
    });

    it('should work with 5 collaterals - set pauses for all assets', async function () {
      // Create a new comet with 5 collaterals
      const assets = {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
        ASSET4: {},
        ASSET5: {},
      };

      const protocol = await makeProtocol({ assets });
      const comet = protocol.cometWithExtendedAssetList;
      const cometExt = comet.attach(comet.address) as CometExt;
      const governor = protocol.governor;

      const numAssets = await comet.numAssets();

      for (let i = 0; i < numAssets; i++) {
        await cometExt.connect(governor).pauseCollateralAssetWithdraw(i, true);
        await cometExt.connect(governor).pauseCollateralAssetSupply(i, true);
        await cometExt.connect(governor).pauseCollateralAssetTransfer(i, true);
      }

      // Verify the pause states are set correctly
      for (let i = 0; i < numAssets; i++) {
        expect(await comet.isCollateralAssetWithdrawPaused(i)).to.be.true;
        expect(await comet.isCollateralAssetSupplyPaused(i)).to.be.true;
        expect(await comet.isCollateralAssetTransferPaused(i)).to.be.true;
      }
    });

    it('should work with 10 collaterals - set pauses for all assets', async function () {
      // Create a new comet with 10 collaterals
      const assets = {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
        ASSET4: {},
        ASSET5: {},
        ASSET6: {},
        ASSET7: {},
        ASSET8: {},
        ASSET9: {},
      };

      const protocol = await makeProtocol({ assets });
      const comet = protocol.cometWithExtendedAssetList;
      const cometExt = comet.attach(comet.address) as CometExt;
      const governor = protocol.governor;

      const numAssets = await comet.numAssets();

      for (let i = 0; i < numAssets; i++) {
        await cometExt.connect(governor).pauseCollateralAssetWithdraw(i, true);
        await cometExt.connect(governor).pauseCollateralAssetSupply(i, true);
        await cometExt.connect(governor).pauseCollateralAssetTransfer(i, true);
      }

      for (let i = 0; i < numAssets; i++) {
        expect(await comet.isCollateralAssetWithdrawPaused(i)).to.be.true;
        expect(await comet.isCollateralAssetSupplyPaused(i)).to.be.true;
        expect(await comet.isCollateralAssetTransferPaused(i)).to.be.true;
      }
    });

    it('should revert with InvalidAssetIndex for asset index numAssets+1 with 3 collaterals', async function () {
      // Create a new comet with 3 collaterals
      const assets = {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
      };

      const protocol = await makeProtocol({ assets });
      const comet = protocol.cometWithExtendedAssetList;
      const cometExt = comet.attach(comet.address) as CometExt;
      const governor = protocol.governor;

      const numAssets = await comet.numAssets();

      await expect(
        cometExt
          .connect(governor)
          .pauseCollateralAssetSupply(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
      await expect(
        cometExt.connect(governor).pauseCollateralAssetTransfer(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
      await expect(
        cometExt.connect(governor).pauseCollateralAssetWithdraw(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
    });

    it('should revert with InvalidAssetIndex for asset index numAssets+1 with 5 collaterals', async function () {
      // Create a new comet with 5 collaterals
      const assets = {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
        ASSET4: {},
        ASSET5: {},
      };
      const protocol = await makeProtocol({ assets });
      const comet = protocol.cometWithExtendedAssetList;
      const cometExt = comet.attach(comet.address) as CometExt;
      const governor = protocol.governor;

      const numAssets = await comet.numAssets();

      await expect(
        cometExt
          .connect(governor)
          .pauseCollateralAssetSupply(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
      await expect(
        cometExt.connect(governor).pauseCollateralAssetTransfer(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
      await expect(
        cometExt.connect(governor).pauseCollateralAssetWithdraw(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
    });

    it('should revert with InvalidAssetIndex for asset index numAssets+1 with 10 collaterals', async function () {
      // Create a new comet with 10 collaterals
      const assets = {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
        ASSET4: {},
        ASSET5: {},
        ASSET6: {},
        ASSET7: {},
        ASSET8: {},
        ASSET9: {},
        ASSET10: {},
      };
      const protocol = await makeProtocol({ assets });
      const comet = protocol.cometWithExtendedAssetList;
      const cometExt = comet.attach(comet.address) as CometExt;
      const governor = protocol.governor;

      const numAssets = await comet.numAssets();

      await expect(
        cometExt
          .connect(governor)
          .pauseCollateralAssetSupply(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
      await expect(
        cometExt.connect(governor).pauseCollateralAssetTransfer(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
      await expect(
        cometExt.connect(governor).pauseCollateralAssetWithdraw(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
    });
  });

  describe('Edge cases', function () {
    it('should allow setting multiple pause flags simultaneously', async function () {
      // Set multiple pause flags
      await cometExt.connect(governor).pauseLendersWithdraw(true);
      await cometExt.connect(governor).pauseBorrowersWithdraw(true);
      await cometExt.connect(governor).pauseCollateralSupply(true);
      await cometExt.connect(governor).pauseBaseSupply(true);
      await cometExt.connect(governor).pauseLendersTransfer(true);
      await cometExt.connect(governor).pauseBorrowersTransfer(true);

      // Verify all are set
      expect(await comet.isLendersWithdrawPaused()).to.be.true;
      expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
      expect(await comet.isCollateralSupplyPaused()).to.be.true;
      expect(await comet.isBaseSupplyPaused()).to.be.true;
      expect(await comet.isLendersTransferPaused()).to.be.true;
      expect(await comet.isBorrowersTransferPaused()).to.be.true;
    });

    it('should allow toggling pause flags multiple times', async function () {
      // Toggle multiple times
      await cometExt.connect(governor).pauseLendersWithdraw(true);
      expect(await comet.isLendersWithdrawPaused()).to.be.true;

      await cometExt.connect(governor).pauseLendersWithdraw(false);
      expect(await comet.isLendersWithdrawPaused()).to.be.false;

      await cometExt.connect(governor).pauseLendersWithdraw(true);
      expect(await comet.isLendersWithdrawPaused()).to.be.true;

      await cometExt.connect(governor).pauseLendersWithdraw(false);
      expect(await comet.isLendersWithdrawPaused()).to.be.false;
    });

    it('should maintain pause state across different function calls', async function () {
      // Set pause state
      await cometExt.connect(governor).pauseLendersWithdraw(true);
      expect(await comet.isLendersWithdrawPaused()).to.be.true;

      // Call other functions that don't affect this pause state
      await cometExt.connect(governor).pauseBorrowersWithdraw(true);
      await cometExt.connect(governor).pauseCollateralSupply(true);

      // Verify original pause state is still maintained
      expect(await comet.isLendersWithdrawPaused()).to.be.true;
      expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
      expect(await comet.isCollateralSupplyPaused()).to.be.true;
    });
  });
});
