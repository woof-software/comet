import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { expect, makeProtocol, MAX_ASSETS, takeSnapshot, SnapshotRestorer } from './helpers';
import { CometExt, CometHarnessInterfaceExtendedAssetList, FaucetToken } from 'build/types';
import { ContractTransaction } from 'ethers';

/**
 * Context: Written after the USDM incident (a Chainlink price feed removal). The protocol added
 * an "extended pause" layer to selectively disable sensitive flows without halting the entire market.
 *
 * What extended pause is:
 * - A set of fine‑grained, role‑gated pause flags exposed by the extension (`CometExt`) and enforced by
 *   the core (`CometWithExtendedAssetList`).
 * - Governor or Pause Guardian can toggle offsets that affect:
 *   - Base/collateral Supply: global base (`pauseBaseSupply`) and global collateral (`pauseCollateralSupply`),
 *     plus per‑collateral asset supply (`pauseCollateralAssetSupply(assetIndex, ...)`).
 *   - Withdraw: lenders vs borrowers paths for base (`pauseLendersWithdraw`, `pauseBorrowersWithdraw`),
 *     global collateral withdraw (`pauseCollateralWithdraw`), plus per‑asset collateral withdraw
 *     (`pauseCollateralAssetWithdraw(assetIndex, ...)`).
 *   - Transfer: lenders vs borrowers paths for base (`pauseLendersTransfer`, `pauseBorrowersTransfer`),
 *     global collateral transfer (`pauseCollateralTransfer`), plus per‑asset collateral transfer
 *     (`pauseCollateralAssetTransfer(assetIndex, ...)`).
 * - These are separate from the legacy coarse flags (`pause(...)` on the core) and are checked in addition to them.
 *
 * Where it is enforced (core checks in `CometWithExtendedAssetList`):
 * - Supply: `supplyInternal` → base path checks `isBaseSupplyPaused()`, collateral path checks
 *   `isCollateralSupplyPaused()` and per‑asset `isCollateralAssetSupplyPaused(offset)`.
 * - Withdraw (base): `withdrawBase` branches to lenders/borrowers and reverts with
 *   `LendersWithdrawPaused` or `BorrowersWithdrawPaused`.
 * - Withdraw (collateral): `withdrawCollateral` checks global `isCollateralWithdrawPaused()` and per‑asset
 *   `isCollateralAssetWithdrawPaused(offset)`.
 * - Transfer (base): `transferBase` branches to lenders/borrowers and reverts with
 *   `LendersTransferPaused` or `BorrowersTransferPaused`.
 * - Transfer (collateral): `transferCollateral` checks global `isCollateralTransferPaused()` and per‑asset
 *   `isCollateralAssetTransferPaused(offset)`.
 *
 * What this suite verifies:
 * - Only Governor or Pause Guardian can toggle (access control via `onlyGovernorOrPauseGuardian`),
 *   in both directions: an unauthorized user can neither pause nor unpause.
 * - Both roles can pause and unpause every flag.
 * - Idempotency protection: setting an already‑set status reverts with `OffsetStatusAlreadySet` or
 *   `CollateralAssetOffsetStatusAlreadySet`, for both values (pause twice, unpause twice).
 * - Events are emitted for each toggle action from `CometExt` methods.
 * - Isolation: a global flag changes only itself (other extended flags, legacy flags and per‑asset
 *   flags stay unchanged); a per‑asset flag changes only its own asset index and its own action.
 * - Unpausing per-asset collateral supply/transfer requires the collateral to be active;
 *   unpause attempts on deactivated collateral revert with `CollateralIsDeactivated`.
 * - Boundary conditions: `isValidAssetIndex` enforced; invalid indices revert with `InvalidAssetIndex`.
 * - Coexistence with legacy pause flags (base supply, lenders withdraw, lenders transfer): the legacy
 *   flag is checked first and reverts with `Paused`; with only the extended flag on, the extended error
 *   is returned; the action succeeds only when both are off.
 *
 * Not covered here: that each extended flag blocks exactly its intended user flow (base vs collateral
 * supply, lenders vs borrowers withdraw/transfer, global vs per‑asset). That is in `supply-test.ts`,
 * `withdraw-test.ts` and `transfer-test.ts`.
 */
describe('extended pause functionality', function () {
  // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  let cometExt: CometExt;
  let cometWithMaxAssets: CometHarnessInterfaceExtendedAssetList;
  let cometExtWithMaxAssets: CometExt;
  let baseToken: FaucetToken;

  // Signers
  let governor: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;
  let users: SignerWithAddress[] = [];

  // Snapshot of the original state, taken after setup
  let fixture: SnapshotRestorer;

  // Constants
  const assetIndex = 0;

  before(async function () {
    const protocol = await makeProtocol({ assets: { USDC: {}, ASSET1: {} } });
    comet = protocol.cometWithExtendedAssetList;
    cometExt = comet.attach(comet.address) as CometExt;
    baseToken = protocol.tokens[protocol.base] as FaucetToken;
    governor = protocol.governor;
    pauseGuardian = protocol.pauseGuardian;
    users = protocol.users;

    // Setup protocol with MAX_ASSETS collaterals
    const collaterals = Object.fromEntries(
      Array.from({ length: MAX_ASSETS }, (_, j) => [`ASSET${j}`, {}])
    );
    const protocolWithMaxAssets = await makeProtocol({
      assets: { USDC: {}, ...collaterals },
    });
    cometWithMaxAssets = protocolWithMaxAssets.cometWithExtendedAssetList;
    cometExtWithMaxAssets = cometWithMaxAssets.attach(cometWithMaxAssets.address) as CometExt;

    // Original state: both protocols deployed, nothing paused. Flows that need it call `fixture.restore()`.
    fixture = await takeSnapshot();
  });

  after(async function () {
    await fixture.restore();
  });

  describe('withdraw pause functions', function () {
    describe('pauseLendersWithdraw', function () {
      describe('happy cases', function () {
        let pauseLendersWithdrawTx: ContractTransaction;

        it('allows governor to call pauseLendersWithdraw', async function () {
          pauseLendersWithdrawTx = await cometExt
            .connect(governor)
            .pauseLendersWithdraw(true);
          await expect(pauseLendersWithdrawTx).to.not.be.reverted;
        });

        it('emits LendersWithdrawPauseAction event when pausing by governor', async function () {
          await expect(pauseLendersWithdrawTx)
            .to.emit(cometExt, 'LendersWithdrawPauseAction')
            .withArgs(true);
        });

        it('changes state when called by governor', async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.true;
        });

        it('allows governor to unpause', async function () {
          await expect(cometExt.connect(governor).pauseLendersWithdraw(false))
            .to.emit(cometExt, 'LendersWithdrawPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by governor', async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.false;
        });

        it('allows pause guardian to call pauseLendersWithdraw', async function () {
          pauseLendersWithdrawTx = await cometExt
            .connect(pauseGuardian)
            .pauseLendersWithdraw(true);

          await expect(pauseLendersWithdrawTx).to.not.be.reverted;
        });

        it('emits LendersWithdrawPauseAction event when pausing by pause guardian', async function () {
          await expect(pauseLendersWithdrawTx)
            .to.emit(cometExt, 'LendersWithdrawPauseAction')
            .withArgs(true);
        });

        it('changes state when called by pause guardian', async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseLendersWithdraw(false)
          )
            .to.emit(cometExt, 'LendersWithdrawPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.false;
        });
      });

      describe('revert cases', function () {
        it('reverts when called by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseLendersWithdraw(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            'OnlyPauseGuardianOrGovernor'
          );
        });

        it('reverts duplicate status setting (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseLendersWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate status setting (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseLendersWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('allows governor to pause', async function () {
          await cometExt.connect(governor).pauseLendersWithdraw(true);
          expect(await comet.isLendersWithdrawPaused()).to.be.true;
        });

        it('reverts duplicate pause (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseLendersWithdraw(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate pause (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseLendersWithdraw(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts unpause by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseLendersWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, 'OnlyPauseGuardianOrGovernor');
        });

        it('stays paused', async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(cometExt.connect(pauseGuardian).pauseLendersWithdraw(false))
            .to.emit(cometExt, 'LendersWithdrawPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.false;
        });
      });
    });

    describe('pauseBorrowersWithdraw', function () {
      describe('happy cases', function () {
        let pauseBorrowersWithdrawTx: ContractTransaction;

        it('allows governor to call pauseBorrowersWithdraw', async function () {
          pauseBorrowersWithdrawTx = await cometExt
            .connect(governor)
            .pauseBorrowersWithdraw(true);
          await expect(pauseBorrowersWithdrawTx).to.not.be.reverted;
        });

        it('emits BorrowersWithdrawPauseAction event when pausing by governor', async function () {
          await expect(pauseBorrowersWithdrawTx)
            .to.emit(cometExt, 'BorrowersWithdrawPauseAction')
            .withArgs(true);
        });

        it('changes state when called by governor', async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
        });

        it('allows governor to unpause', async function () {
          await expect(cometExt.connect(governor).pauseBorrowersWithdraw(false))
            .to.emit(cometExt, 'BorrowersWithdrawPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by governor', async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.false;
        });

        it('allows pause guardian to call pauseBorrowersWithdraw', async function () {
          pauseBorrowersWithdrawTx = await cometExt
            .connect(pauseGuardian)
            .pauseBorrowersWithdraw(true);
          await expect(pauseBorrowersWithdrawTx).to.not.be.reverted;
        });

        it('emits BorrowersWithdrawPauseAction event when pausing by pause guardian', async function () {
          await expect(pauseBorrowersWithdrawTx)
            .to.emit(cometExt, 'BorrowersWithdrawPauseAction')
            .withArgs(true);
        });

        it('changes state when called by pause guardian', async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersWithdraw(false)
          )
            .to.emit(cometExt, 'BorrowersWithdrawPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.false;
        });
      });

      describe('revert cases', function () {
        it('reverts when called by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseBorrowersWithdraw(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            'OnlyPauseGuardianOrGovernor'
          );
        });

        it('reverts duplicate status setting (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseBorrowersWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate status setting (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('allows governor to pause', async function () {
          await cometExt.connect(governor).pauseBorrowersWithdraw(true);
          expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
        });

        it('reverts duplicate pause (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseBorrowersWithdraw(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate pause (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersWithdraw(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts unpause by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseBorrowersWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, 'OnlyPauseGuardianOrGovernor');
        });

        it('stays paused', async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(cometExt.connect(pauseGuardian).pauseBorrowersWithdraw(false))
            .to.emit(cometExt, 'BorrowersWithdrawPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.false;
        });
      });
    });

    describe('pauseCollateralWithdraw', function () {
      describe('happy cases', function () {
        let pauseCollateralWithdrawTx: ContractTransaction;

        it('allows governor to call pauseCollateralWithdraw', async function () {
          pauseCollateralWithdrawTx = await cometExt
            .connect(governor)
            .pauseCollateralWithdraw(true);
          await expect(pauseCollateralWithdrawTx).to.not.be.reverted;
        });

        it('emits CollateralWithdrawPauseAction event when pausing by governor', async function () {
          await expect(pauseCollateralWithdrawTx)
            .to.emit(cometExt, 'CollateralWithdrawPauseAction')
            .withArgs(true);
        });

        it('changes state when called by governor', async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.true;
        });

        it('allows governor to unpause', async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralWithdraw(false)
          )
            .to.emit(cometExt, 'CollateralWithdrawPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by governor', async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.false;
        });

        it('allows pause guardian to call pauseCollateralWithdraw', async function () {
          pauseCollateralWithdrawTx = await cometExt
            .connect(pauseGuardian)
            .pauseCollateralWithdraw(true);
          await expect(pauseCollateralWithdrawTx).to.not.be.reverted;
        });

        it('emits CollateralWithdrawPauseAction event when pausing by pause guardian', async function () {
          await expect(pauseCollateralWithdrawTx)
            .to.emit(cometExt, 'CollateralWithdrawPauseAction')
            .withArgs(true);
        });

        it('changes state when called by pause guardian', async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.true;
        });

        it('allows governor to unpause after pause guardian', async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralWithdraw(false)
          )
            .to.emit(cometExt, 'CollateralWithdrawPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by governor', async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.false;
        });
      });

      describe('revert cases', function () {
        it('reverts when called by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseCollateralWithdraw(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            'OnlyPauseGuardianOrGovernor'
          );
        });

        it('reverts duplicate status setting (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate status setting (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('allows governor to pause', async function () {
          await cometExt.connect(governor).pauseCollateralWithdraw(true);
          expect(await comet.isCollateralWithdrawPaused()).to.be.true;
        });

        it('reverts duplicate pause (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralWithdraw(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate pause (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralWithdraw(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts unpause by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseCollateralWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, 'OnlyPauseGuardianOrGovernor');
        });

        it('stays paused', async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(cometExt.connect(pauseGuardian).pauseCollateralWithdraw(false))
            .to.emit(cometExt, 'CollateralWithdrawPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.false;
        });
      });
    });

    describe('pauseCollateralAssetWithdraw', function () {
      describe('happy cases', function () {
        let pauseCollateralAssetWithdrawTx: ContractTransaction;

        it('allows governor to call pauseCollateralAssetWithdraw', async function () {
          pauseCollateralAssetWithdrawTx = await cometExt
            .connect(governor)
            .pauseCollateralAssetWithdraw(assetIndex, true);
          await expect(pauseCollateralAssetWithdrawTx).to.not.be.reverted;
        });

        it('emits CollateralAssetWithdrawPauseAction event when pausing by governor', async function () {
          await expect(pauseCollateralAssetWithdrawTx)
            .to.emit(cometExt, 'CollateralAssetWithdrawPauseAction')
            .withArgs(assetIndex, true);
        });

        it('changes state when called by governor', async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be
            .true;
        });

        it('allows governor to unpause', async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetWithdraw(assetIndex, false)
          )
            .to.emit(cometExt, 'CollateralAssetWithdrawPauseAction')
            .withArgs(assetIndex, false);
        });

        it('sets to false when unpausing by governor', async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be
            .false;
        });

        it('allows pause guardian to call pauseCollateralAssetWithdraw', async function () {
          pauseCollateralAssetWithdrawTx = await cometExt
            .connect(pauseGuardian)
            .pauseCollateralAssetWithdraw(assetIndex, true);
          await expect(pauseCollateralAssetWithdrawTx).to.not.be.reverted;
        });

        it('emits CollateralAssetWithdrawPauseAction event when pausing by pause guardian', async function () {
          await expect(pauseCollateralAssetWithdrawTx)
            .to.emit(cometExt, 'CollateralAssetWithdrawPauseAction')
            .withArgs(assetIndex, true);
        });

        it('changes state when called by pause guardian', async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be
            .true;
        });

        it('allows governor to unpause after pause guardian', async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetWithdraw(assetIndex, false)
          )
            .to.emit(cometExt, 'CollateralAssetWithdrawPauseAction')
            .withArgs(assetIndex, false);
        });

        it('sets to false when unpausing by governor', async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be
            .false;
        });

        for (let i = 1; i <= MAX_ASSETS; i++) {
          it(`allows to pause collateral asset withdraw for asset ${i} with ${MAX_ASSETS} collaterals`, async function () {
            const assetIndex = i - 1;

            // Pause the collateral at assetIndex
            await cometExtWithMaxAssets
              .connect(governor)
              .pauseCollateralAssetWithdraw(assetIndex, true);

            // Verify that the asset at assetIndex is paused
            expect(await cometWithMaxAssets.isCollateralAssetWithdrawPaused(assetIndex)).to
              .be.true;
          });
        }

        for (let i = 1; i <= MAX_ASSETS; i++) {
          it(`allows to unpause collateral asset withdraw for asset ${i} with ${MAX_ASSETS} collaterals`, async function () {
            const assetIndex = i - 1;

            // Unpause the collateral at assetIndex
            await cometExtWithMaxAssets
              .connect(governor)
              .pauseCollateralAssetWithdraw(assetIndex, false);

            // Verify that the asset at assetIndex is unpaused
            expect(await cometWithMaxAssets.isCollateralAssetWithdrawPaused(assetIndex)).to
              .be.false;
          });
        }
      });

      describe('revert cases', function () {
        it('reverts when called by unauthorized user', async function () {
          await expect(
            cometExt
              .connect(users[0])
              .pauseCollateralAssetWithdraw(assetIndex, true)
          ).to.be.revertedWithCustomError(
            cometExt,
            'OnlyPauseGuardianOrGovernor'
          );
        });

        it('reverts duplicate status setting (governor)', async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetWithdraw(assetIndex, false)
          ).to.be.revertedWithCustomError(
            cometExt,
            'CollateralAssetOffsetStatusAlreadySet'
          );
        });

        it('reverts duplicate status setting (pause guardian)', async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
              .pauseCollateralAssetWithdraw(assetIndex, false)
          ).to.be.revertedWithCustomError(
            cometExt,
            'CollateralAssetOffsetStatusAlreadySet'
          );
        });

        it('allows governor to pause', async function () {
          await cometExt.connect(governor).pauseCollateralAssetWithdraw(assetIndex, true);
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be.true;
        });

        it('reverts duplicate pause (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralAssetWithdraw(assetIndex, true)
          ).to.be.revertedWithCustomError(cometExt, 'CollateralAssetOffsetStatusAlreadySet');
        });

        it('reverts duplicate pause (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralAssetWithdraw(assetIndex, true)
          ).to.be.revertedWithCustomError(cometExt, 'CollateralAssetOffsetStatusAlreadySet');
        });

        it('reverts unpause by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseCollateralAssetWithdraw(assetIndex, false)
          ).to.be.revertedWithCustomError(cometExt, 'OnlyPauseGuardianOrGovernor');
        });

        it('stays paused', async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(cometExt.connect(pauseGuardian).pauseCollateralAssetWithdraw(assetIndex, false))
            .to.emit(cometExt, 'CollateralAssetWithdrawPauseAction')
            .withArgs(assetIndex, false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be.false;
        });

        it('reverts with InvalidAssetIndex when assetIndex >= numAssets', async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetWithdraw(await comet.numAssets(), true)
          ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
        });
      });
    });
  });

  describe('supply pause functions', function () {
    describe('pauseCollateralSupply', function () {
      describe('happy cases', function () {
        let pauseCollateralSupplyTx: ContractTransaction;

        it('allows governor to call pauseCollateralSupply', async function () {
          pauseCollateralSupplyTx = await cometExt
            .connect(governor)
            .pauseCollateralSupply(true);
          await expect(pauseCollateralSupplyTx).to.not.be.reverted;
        });

        it('emits CollateralSupplyPauseAction event when pausing by governor', async function () {
          await expect(pauseCollateralSupplyTx)
            .to.emit(cometExt, 'CollateralSupplyPauseAction')
            .withArgs(true);
        });

        it('changes state when called by governor', async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.true;
        });

        it('allows governor to unpause', async function () {
          await expect(cometExt.connect(governor).pauseCollateralSupply(false))
            .to.emit(cometExt, 'CollateralSupplyPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by governor', async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.false;
        });

        it('allows pause guardian to call pauseCollateralSupply', async function () {
          pauseCollateralSupplyTx = await cometExt
            .connect(pauseGuardian)
            .pauseCollateralSupply(true);
          await expect(pauseCollateralSupplyTx).to.not.be.reverted;
        });

        it('emits CollateralSupplyPauseAction event when pausing by pause guardian', async function () {
          await expect(pauseCollateralSupplyTx)
            .to.emit(cometExt, 'CollateralSupplyPauseAction')
            .withArgs(true);
        });

        it('changes state when called by pause guardian', async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralSupply(false)
          )
            .to.emit(cometExt, 'CollateralSupplyPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.false;
        });
      });

      describe('revert cases', function () {
        it('reverts when called by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseCollateralSupply(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            'OnlyPauseGuardianOrGovernor'
          );
        });

        it('reverts duplicate status setting (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralSupply(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate status setting (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralSupply(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('allows governor to pause', async function () {
          await cometExt.connect(governor).pauseCollateralSupply(true);
          expect(await comet.isCollateralSupplyPaused()).to.be.true;
        });

        it('reverts duplicate pause (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralSupply(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate pause (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralSupply(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts unpause by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseCollateralSupply(false)
          ).to.be.revertedWithCustomError(cometExt, 'OnlyPauseGuardianOrGovernor');
        });

        it('stays paused', async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(cometExt.connect(pauseGuardian).pauseCollateralSupply(false))
            .to.emit(cometExt, 'CollateralSupplyPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.false;
        });
      });
    });

    describe('pauseBaseSupply', function () {
      describe('happy cases', function () {
        let pauseBaseSupplyTx: ContractTransaction;

        it('allows governor to call pauseBaseSupply', async function () {
          pauseBaseSupplyTx = await cometExt
            .connect(governor)
            .pauseBaseSupply(true);
          await expect(pauseBaseSupplyTx).to.not.be.reverted;
        });

        it('emits BaseSupplyPauseAction event when pausing by governor', async function () {
          await expect(pauseBaseSupplyTx)
            .to.emit(cometExt, 'BaseSupplyPauseAction')
            .withArgs(true);
        });

        it('changes state when called by governor', async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.true;
        });

        it('allows governor to unpause', async function () {
          await expect(cometExt.connect(governor).pauseBaseSupply(false))
            .to.emit(cometExt, 'BaseSupplyPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by governor', async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.false;
        });

        it('allows pause guardian to call pauseBaseSupply', async function () {
          pauseBaseSupplyTx = await cometExt
            .connect(pauseGuardian)
            .pauseBaseSupply(true);
          await expect(pauseBaseSupplyTx).to.not.be.reverted;
        });

        it('emits BaseSupplyPauseAction event when pausing by pause guardian', async function () {
          await expect(pauseBaseSupplyTx)
            .to.emit(cometExt, 'BaseSupplyPauseAction')
            .withArgs(true);
        });

        it('changes state when called by pause guardian', async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(cometExt.connect(pauseGuardian).pauseBaseSupply(false))
            .to.emit(cometExt, 'BaseSupplyPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.false;
        });
      });

      describe('revert cases', function () {
        it('reverts when called by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseBaseSupply(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            'OnlyPauseGuardianOrGovernor'
          );
        });

        it('reverts duplicate status setting (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseBaseSupply(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate status setting (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBaseSupply(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('allows governor to pause', async function () {
          await cometExt.connect(governor).pauseBaseSupply(true);
          expect(await comet.isBaseSupplyPaused()).to.be.true;
        });

        it('reverts duplicate pause (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseBaseSupply(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate pause (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBaseSupply(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts unpause by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseBaseSupply(false)
          ).to.be.revertedWithCustomError(cometExt, 'OnlyPauseGuardianOrGovernor');
        });

        it('stays paused', async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(cometExt.connect(pauseGuardian).pauseBaseSupply(false))
            .to.emit(cometExt, 'BaseSupplyPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.false;
        });
      });
    });

    describe('pauseCollateralAssetSupply', function () {
      describe('happy cases', function () {
        let pauseCollateralAssetSupplyTx: ContractTransaction;

        it('allows governor to call pauseCollateralAssetSupply', async function () {
          pauseCollateralAssetSupplyTx = await cometExt
            .connect(governor)
            .pauseCollateralAssetSupply(assetIndex, true);
          await expect(pauseCollateralAssetSupplyTx).to.not.be.reverted;
        });

        it('emits CollateralAssetSupplyPauseAction event when pausing by governor', async function () {
          await expect(pauseCollateralAssetSupplyTx)
            .to.emit(cometExt, 'CollateralAssetSupplyPauseAction')
            .withArgs(assetIndex, true);
        });

        it('changes state when called by governor', async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
            .true;
        });

        it('allows governor to unpause', async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetSupply(assetIndex, false)
          )
            .to.emit(cometExt, 'CollateralAssetSupplyPauseAction')
            .withArgs(assetIndex, false);
        });

        it('sets to false when unpausing by governor', async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
            .false;
        });

        it('allows pause guardian to call pauseCollateralAssetSupply', async function () {
          pauseCollateralAssetSupplyTx = await cometExt
            .connect(pauseGuardian)
            .pauseCollateralAssetSupply(assetIndex, true);
          await expect(pauseCollateralAssetSupplyTx).to.not.be.reverted;
        });

        it('emits CollateralAssetSupplyPauseAction event when pausing by pause guardian', async function () {
          await expect(pauseCollateralAssetSupplyTx)
            .to.emit(cometExt, 'CollateralAssetSupplyPauseAction')
            .withArgs(assetIndex, true);
        });

        it('changes state when called by pause guardian', async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
            .true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
              .pauseCollateralAssetSupply(assetIndex, false)
          )
            .to.emit(cometExt, 'CollateralAssetSupplyPauseAction')
            .withArgs(assetIndex, false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
            .false;
        });

        for (let i = 1; i <= MAX_ASSETS; i++) {
          it(`allows to pause collateral asset supply for asset ${i} with ${MAX_ASSETS} collaterals`, async function () {
            const assetIndex = i - 1;

            // Pause the collateral at assetIndex
            await cometExtWithMaxAssets
              .connect(governor)
              .pauseCollateralAssetSupply(assetIndex, true);

            // Verify that the asset at assetIndex is paused
            expect(await cometWithMaxAssets.isCollateralAssetSupplyPaused(assetIndex)).to.be
              .true;
          });
        }

        for (let i = 1; i <= MAX_ASSETS; i++) {
          it(`allows to unpause collateral asset supply for asset ${i} with ${MAX_ASSETS} collaterals`, async function () {
            const assetIndex = i - 1;

            // Unpause the collateral at assetIndex
            await cometExtWithMaxAssets
              .connect(governor)
              .pauseCollateralAssetSupply(assetIndex, false);

            // Verify that the asset at assetIndex is unpaused
            expect(await cometWithMaxAssets.isCollateralAssetSupplyPaused(assetIndex)).to.be
              .false;
          });
        }
      });

      describe('revert cases', function () {
        it('reverts when called by unauthorized user', async function () {
          await expect(
            cometExt
              .connect(users[0])
              .pauseCollateralAssetSupply(assetIndex, true)
          ).to.be.revertedWithCustomError(
            cometExt,
            'OnlyPauseGuardianOrGovernor'
          );
        });

        it('reverts duplicate status setting (governor)', async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetSupply(assetIndex, false)
          ).to.be.revertedWithCustomError(
            cometExt,
            'CollateralAssetOffsetStatusAlreadySet'
          );
        });

        it('reverts duplicate status setting (pause guardian)', async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
              .pauseCollateralAssetSupply(assetIndex, false)
          ).to.be.revertedWithCustomError(
            cometExt,
            'CollateralAssetOffsetStatusAlreadySet'
          );
        });

        it('allows governor to pause', async function () {
          await cometExt.connect(governor).pauseCollateralAssetSupply(assetIndex, true);
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be.true;
        });

        it('reverts duplicate pause (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralAssetSupply(assetIndex, true)
          ).to.be.revertedWithCustomError(cometExt, 'CollateralAssetOffsetStatusAlreadySet');
        });

        it('reverts duplicate pause (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralAssetSupply(assetIndex, true)
          ).to.be.revertedWithCustomError(cometExt, 'CollateralAssetOffsetStatusAlreadySet');
        });

        it('reverts unpause by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseCollateralAssetSupply(assetIndex, false)
          ).to.be.revertedWithCustomError(cometExt, 'OnlyPauseGuardianOrGovernor');
        });

        it('stays paused', async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(cometExt.connect(pauseGuardian).pauseCollateralAssetSupply(assetIndex, false))
            .to.emit(cometExt, 'CollateralAssetSupplyPauseAction')
            .withArgs(assetIndex, false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be.false;
        });

        it('reverts with InvalidAssetIndex when assetIndex >= numAssets', async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetSupply(await comet.numAssets(), true)
          ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
        });

        it('reverts when unpausing a deactivated collateral asset', async function () {
          // Deactivate the collateral asset
          await cometExt.connect(pauseGuardian).deactivateCollateral(assetIndex);

          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralAssetSupply(assetIndex, false)
          ).to.be.revertedWithCustomError(cometExt, 'CollateralIsDeactivated');
        });
      });
    });
  });

  describe('transfer pause functions', function () {
    describe('pauseLendersTransfer', function () {
      describe('happy cases', function () {
        let pauseLendersTransferTx: ContractTransaction;

        it('allows governor to call pauseLendersTransfer', async function () {
          pauseLendersTransferTx = await cometExt
            .connect(governor)
            .pauseLendersTransfer(true);
          await expect(pauseLendersTransferTx).to.not.be.reverted;
        });

        it('emits LendersTransferPauseAction event when pausing by governor', async function () {
          await expect(pauseLendersTransferTx)
            .to.emit(cometExt, 'LendersTransferPauseAction')
            .withArgs(true);
        });

        it('changes state when called by governor', async function () {
          expect(await comet.isLendersTransferPaused()).to.be.true;
        });

        it('allows governor to unpause', async function () {
          await expect(cometExt.connect(governor).pauseLendersTransfer(false))
            .to.emit(cometExt, 'LendersTransferPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by governor', async function () {
          expect(await comet.isLendersTransferPaused()).to.be.false;
        });

        it('allows pause guardian to call pauseLendersTransfer', async function () {
          pauseLendersTransferTx = await cometExt
            .connect(pauseGuardian)
            .pauseLendersTransfer(true);
          await expect(pauseLendersTransferTx).to.not.be.reverted;
        });

        it('emits LendersTransferPauseAction event when pausing by pause guardian', async function () {
          await expect(pauseLendersTransferTx)
            .to.emit(cometExt, 'LendersTransferPauseAction')
            .withArgs(true);
        });

        it('changes state when called by pause guardian', async function () {
          expect(await comet.isLendersTransferPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseLendersTransfer(false)
          )
            .to.emit(cometExt, 'LendersTransferPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isLendersTransferPaused()).to.be.false;
        });
      });

      describe('revert cases', function () {
        it('reverts when called by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseLendersTransfer(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            'OnlyPauseGuardianOrGovernor'
          );
        });

        it('reverts duplicate status setting (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseLendersTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate status setting (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseLendersTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('allows governor to pause', async function () {
          await cometExt.connect(governor).pauseLendersTransfer(true);
          expect(await comet.isLendersTransferPaused()).to.be.true;
        });

        it('reverts duplicate pause (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseLendersTransfer(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate pause (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseLendersTransfer(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts unpause by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseLendersTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, 'OnlyPauseGuardianOrGovernor');
        });

        it('stays paused', async function () {
          expect(await comet.isLendersTransferPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(cometExt.connect(pauseGuardian).pauseLendersTransfer(false))
            .to.emit(cometExt, 'LendersTransferPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isLendersTransferPaused()).to.be.false;
        });
      });
    });

    describe('pauseBorrowersTransfer', function () {
      describe('happy cases', function () {
        let pauseBorrowersTransferTx: ContractTransaction;

        it('allows governor to call pauseBorrowersTransfer', async function () {
          pauseBorrowersTransferTx = await cometExt
            .connect(governor)
            .pauseBorrowersTransfer(true);
          await expect(pauseBorrowersTransferTx).to.not.be.reverted;
        });

        it('emits BorrowersTransferPauseAction event when pausing by governor', async function () {
          await expect(pauseBorrowersTransferTx)
            .to.emit(cometExt, 'BorrowersTransferPauseAction')
            .withArgs(true);
        });

        it('changes state when called by governor', async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.true;
        });

        it('allows governor to unpause', async function () {
          await expect(cometExt.connect(governor).pauseBorrowersTransfer(false))
            .to.emit(cometExt, 'BorrowersTransferPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by governor', async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.false;
        });

        it('allows pause guardian to call pauseBorrowersTransfer', async function () {
          pauseBorrowersTransferTx = await cometExt
            .connect(pauseGuardian)
            .pauseBorrowersTransfer(true);
          await expect(pauseBorrowersTransferTx).to.not.be.reverted;
        });

        it('emits BorrowersTransferPauseAction event when pausing by pause guardian', async function () {
          await expect(pauseBorrowersTransferTx)
            .to.emit(cometExt, 'BorrowersTransferPauseAction')
            .withArgs(true);
        });

        it('changes state when called by pause guardian', async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersTransfer(false)
          )
            .to.emit(cometExt, 'BorrowersTransferPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.false;
        });
      });

      describe('revert cases', function () {
        it('reverts when called by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseBorrowersTransfer(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            'OnlyPauseGuardianOrGovernor'
          );
        });

        it('reverts duplicate status setting (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseBorrowersTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate status setting (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('allows governor to pause', async function () {
          await cometExt.connect(governor).pauseBorrowersTransfer(true);
          expect(await comet.isBorrowersTransferPaused()).to.be.true;
        });

        it('reverts duplicate pause (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseBorrowersTransfer(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate pause (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersTransfer(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts unpause by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseBorrowersTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, 'OnlyPauseGuardianOrGovernor');
        });

        it('stays paused', async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(cometExt.connect(pauseGuardian).pauseBorrowersTransfer(false))
            .to.emit(cometExt, 'BorrowersTransferPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.false;
        });
      });
    });

    describe('pauseCollateralTransfer', function () {
      describe('happy cases', function () {
        let pauseCollateralTransferTx: ContractTransaction;

        it('allows governor to call pauseCollateralTransfer', async function () {
          pauseCollateralTransferTx = await cometExt
            .connect(governor)
            .pauseCollateralTransfer(true);
          await expect(pauseCollateralTransferTx).to.not.be.reverted;
        });

        it('emits CollateralTransferPauseAction event when pausing by governor', async function () {
          await expect(pauseCollateralTransferTx)
            .to.emit(cometExt, 'CollateralTransferPauseAction')
            .withArgs(true);
        });

        it('changes state when called by governor', async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.true;
        });

        it('allows governor to unpause', async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralTransfer(false)
          )
            .to.emit(cometExt, 'CollateralTransferPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by governor', async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.false;
        });

        it('allows pause guardian to call pauseCollateralTransfer', async function () {
          pauseCollateralTransferTx = await cometExt
            .connect(pauseGuardian)
            .pauseCollateralTransfer(true);
          await expect(pauseCollateralTransferTx).to.not.be.reverted;
        });

        it('emits CollateralTransferPauseAction event when pausing by pause guardian', async function () {
          await expect(pauseCollateralTransferTx)
            .to.emit(cometExt, 'CollateralTransferPauseAction')
            .withArgs(true);
        });

        it('changes state when called by pause guardian', async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralTransfer(false)
          )
            .to.emit(cometExt, 'CollateralTransferPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.false;
        });
      });

      describe('revert cases', function () {
        it('reverts when called by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseCollateralTransfer(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            'OnlyPauseGuardianOrGovernor'
          );
        });

        it('reverts duplicate status setting (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate status setting (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('allows governor to pause', async function () {
          await cometExt.connect(governor).pauseCollateralTransfer(true);
          expect(await comet.isCollateralTransferPaused()).to.be.true;
        });

        it('reverts duplicate pause (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralTransfer(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts duplicate pause (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralTransfer(true)
          ).to.be.revertedWithCustomError(cometExt, 'OffsetStatusAlreadySet');
        });

        it('reverts unpause by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseCollateralTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, 'OnlyPauseGuardianOrGovernor');
        });

        it('stays paused', async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(cometExt.connect(pauseGuardian).pauseCollateralTransfer(false))
            .to.emit(cometExt, 'CollateralTransferPauseAction')
            .withArgs(false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.false;
        });
      });
    });

    describe('pauseCollateralAssetTransfer', function () {
      describe('happy cases', function () {
        let pauseCollateralAssetTransferTx: ContractTransaction;

        // The pauseCollateralAssetSupply revert cases leave the asset deactivated; unpausing transfer needs it active
        before(async function () {
          await fixture.restore();
        });

        it('allows governor to call pauseCollateralAssetTransfer', async function () {
          pauseCollateralAssetTransferTx = await cometExt
            .connect(governor)
            .pauseCollateralAssetTransfer(assetIndex, true);
          await expect(pauseCollateralAssetTransferTx).to.not.be.reverted;
        });

        it('emits CollateralAssetTransferPauseAction event when pausing by governor', async function () {
          await expect(pauseCollateralAssetTransferTx)
            .to.emit(cometExt, 'CollateralAssetTransferPauseAction')
            .withArgs(assetIndex, true);
        });

        it('changes state when called by governor', async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be
            .true;
        });

        it('allows governor to unpause', async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetTransfer(assetIndex, false)
          )
            .to.emit(cometExt, 'CollateralAssetTransferPauseAction')
            .withArgs(assetIndex, false);
        });

        it('sets to false when unpausing by governor', async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be
            .false;
        });

        it('allows pause guardian to call pauseCollateralAssetTransfer', async function () {
          pauseCollateralAssetTransferTx = await cometExt
            .connect(pauseGuardian)
            .pauseCollateralAssetTransfer(assetIndex, true);
          await expect(pauseCollateralAssetTransferTx).to.not.be.reverted;
        });

        it('emits CollateralAssetTransferPauseAction event when pausing by pause guardian', async function () {
          await expect(pauseCollateralAssetTransferTx)
            .to.emit(cometExt, 'CollateralAssetTransferPauseAction')
            .withArgs(assetIndex, true);
        });

        it('changes state when called by pause guardian', async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be
            .true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
              .pauseCollateralAssetTransfer(assetIndex, false)
          )
            .to.emit(cometExt, 'CollateralAssetTransferPauseAction')
            .withArgs(assetIndex, false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be
            .false;
        });

        for (let i = 1; i <= MAX_ASSETS; i++) {
          it(`allows to pause collateral asset transfer for asset ${i} with ${MAX_ASSETS} collaterals`, async function () {
            const assetIndex = i - 1;

            // Pause the collateral at assetIndex
            await cometExtWithMaxAssets
              .connect(governor)
              .pauseCollateralAssetTransfer(assetIndex, true);

            // Verify that the asset at assetIndex is paused
            expect(await cometWithMaxAssets.isCollateralAssetTransferPaused(assetIndex)).to
              .be.true;
          });
        }

        for (let i = 1; i <= MAX_ASSETS; i++) {
          it(`allows to unpause collateral asset transfer for asset ${i} with ${MAX_ASSETS} collaterals`, async function () {
            const assetIndex = i - 1;

            // Unpause the collateral at assetIndex
            await cometExtWithMaxAssets
              .connect(governor)
              .pauseCollateralAssetTransfer(assetIndex, false);

            // Verify that the asset at assetIndex is unpaused
            expect(await cometWithMaxAssets.isCollateralAssetTransferPaused(assetIndex)).to
              .be.false;
          });
        }
      });

      describe('revert cases', function () {
        it('reverts when called by unauthorized user', async function () {
          await expect(
            cometExt
              .connect(users[0])
              .pauseCollateralAssetTransfer(assetIndex, true)
          ).to.be.revertedWithCustomError(
            cometExt,
            'OnlyPauseGuardianOrGovernor'
          );
        });

        it('reverts duplicate status setting (governor)', async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetTransfer(assetIndex, false)
          ).to.be.revertedWithCustomError(
            cometExt,
            'CollateralAssetOffsetStatusAlreadySet'
          );
        });

        it('reverts duplicate status setting (pause guardian)', async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
              .pauseCollateralAssetTransfer(assetIndex, false)
          ).to.be.revertedWithCustomError(
            cometExt,
            'CollateralAssetOffsetStatusAlreadySet'
          );
        });

        it('allows governor to pause', async function () {
          await cometExt.connect(governor).pauseCollateralAssetTransfer(assetIndex, true);
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be.true;
        });

        it('reverts duplicate pause (governor)', async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralAssetTransfer(assetIndex, true)
          ).to.be.revertedWithCustomError(cometExt, 'CollateralAssetOffsetStatusAlreadySet');
        });

        it('reverts duplicate pause (pause guardian)', async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralAssetTransfer(assetIndex, true)
          ).to.be.revertedWithCustomError(cometExt, 'CollateralAssetOffsetStatusAlreadySet');
        });

        it('reverts unpause by unauthorized user', async function () {
          await expect(
            cometExt.connect(users[0]).pauseCollateralAssetTransfer(assetIndex, false)
          ).to.be.revertedWithCustomError(cometExt, 'OnlyPauseGuardianOrGovernor');
        });

        it('stays paused', async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be.true;
        });

        it('allows pause guardian to unpause', async function () {
          await expect(cometExt.connect(pauseGuardian).pauseCollateralAssetTransfer(assetIndex, false))
            .to.emit(cometExt, 'CollateralAssetTransferPauseAction')
            .withArgs(assetIndex, false);
        });

        it('sets to false when unpausing by pause guardian', async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be.false;
        });

        it('reverts with InvalidAssetIndex when assetIndex >= numAssets', async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetTransfer(await comet.numAssets(), true)
          ).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
        });

        it('reverts when unpausing a deactivated collateral asset', async function () {
          // Deactivate the collateral asset
          await cometExt.connect(pauseGuardian).deactivateCollateral(assetIndex);

          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralAssetTransfer(assetIndex, false)
          ).to.be.revertedWithCustomError(cometExt, 'CollateralIsDeactivated');
        });
      });
    });
  });

  /**
   * Pausing one flag must not touch any other flag: other extended flags, legacy flags, other asset
   * indexes and other per-asset actions.
   */
  describe('flag isolation', function () {
    type GlobalFlag = {
      name: string;
      pause: (signer: SignerWithAddress, paused: boolean) => Promise<ContractTransaction>;
      isPaused: () => Promise<boolean>;
    };

    type AssetFlag = {
      name: string;
      pause: (ext: CometExt, signer: SignerWithAddress, index: number, paused: boolean) => Promise<ContractTransaction>;
      isPaused: (c: CometHarnessInterfaceExtendedAssetList, index: number) => Promise<boolean>;
    };

    const globalFlags: GlobalFlag[] = [
      {
        name: 'pauseLendersWithdraw',
        pause: (signer, paused) => cometExt.connect(signer).pauseLendersWithdraw(paused),
        isPaused: () => comet.isLendersWithdrawPaused(),
      },
      {
        name: 'pauseBorrowersWithdraw',
        pause: (signer, paused) => cometExt.connect(signer).pauseBorrowersWithdraw(paused),
        isPaused: () => comet.isBorrowersWithdrawPaused(),
      },
      {
        name: 'pauseCollateralWithdraw',
        pause: (signer, paused) => cometExt.connect(signer).pauseCollateralWithdraw(paused),
        isPaused: () => comet.isCollateralWithdrawPaused(),
      },
      {
        name: 'pauseCollateralSupply',
        pause: (signer, paused) => cometExt.connect(signer).pauseCollateralSupply(paused),
        isPaused: () => comet.isCollateralSupplyPaused(),
      },
      {
        name: 'pauseBaseSupply',
        pause: (signer, paused) => cometExt.connect(signer).pauseBaseSupply(paused),
        isPaused: () => comet.isBaseSupplyPaused(),
      },
      {
        name: 'pauseLendersTransfer',
        pause: (signer, paused) => cometExt.connect(signer).pauseLendersTransfer(paused),
        isPaused: () => comet.isLendersTransferPaused(),
      },
      {
        name: 'pauseBorrowersTransfer',
        pause: (signer, paused) => cometExt.connect(signer).pauseBorrowersTransfer(paused),
        isPaused: () => comet.isBorrowersTransferPaused(),
      },
      {
        name: 'pauseCollateralTransfer',
        pause: (signer, paused) => cometExt.connect(signer).pauseCollateralTransfer(paused),
        isPaused: () => comet.isCollateralTransferPaused(),
      },
    ];

    const assetFlags: AssetFlag[] = [
      {
        name: 'pauseCollateralAssetWithdraw',
        pause: (ext, signer, index, paused) => ext.connect(signer).pauseCollateralAssetWithdraw(index, paused),
        isPaused: (c, index) => c.isCollateralAssetWithdrawPaused(index),
      },
      {
        name: 'pauseCollateralAssetSupply',
        pause: (ext, signer, index, paused) => ext.connect(signer).pauseCollateralAssetSupply(index, paused),
        isPaused: (c, index) => c.isCollateralAssetSupplyPaused(index),
      },
      {
        name: 'pauseCollateralAssetTransfer',
        pause: (ext, signer, index, paused) => ext.connect(signer).pauseCollateralAssetTransfer(index, paused),
        isPaused: (c, index) => c.isCollateralAssetTransferPaused(index),
      },
    ];

    describe('isolation of global flags', function () {
      for (const flag of globalFlags) {
        describe(`${flag.name}(true)`, function () {
          before(async function () {
            await fixture.restore();
          });

          it('allows governor to pause', async function () {
            await flag.pause(governor, true);
            expect(await flag.isPaused()).to.be.true;
          });

          it('leaves every other extended flag unpaused', async function () {
            for (const other of globalFlags.filter((f) => f !== flag)) {
              expect(await other.isPaused(), other.name).to.be.false;
            }
          });

          it('leaves legacy flags unpaused', async function () {
            expect(await comet.isSupplyPaused()).to.be.false;
            expect(await comet.isTransferPaused()).to.be.false;
            expect(await comet.isWithdrawPaused()).to.be.false;
            expect(await comet.isAbsorbPaused()).to.be.false;
            expect(await comet.isBuyPaused()).to.be.false;
          });

          it('leaves per-asset flags unpaused', async function () {
            for (const assetFlag of assetFlags) {
              expect(await assetFlag.isPaused(comet, assetIndex), assetFlag.name).to.be.false;
            }
          });
        });
      }
    });

    describe('isolation of per-asset flags', function () {
      for (const flag of assetFlags) {
        for (const pausedIndex of [0, MAX_ASSETS - 1]) {
          describe(`${flag.name}(${pausedIndex}, true) with ${MAX_ASSETS} collaterals`, function () {
            before(async function () {
              await fixture.restore();
            });

            it('allows governor to pause the asset', async function () {
              await flag.pause(cometExtWithMaxAssets, governor, pausedIndex, true);
              expect(await flag.isPaused(cometWithMaxAssets, pausedIndex)).to.be.true;
            });

            it('leaves every other asset index unpaused for the same action', async function () {
              for (let index = 0; index < MAX_ASSETS; index++) {
                if (index === pausedIndex) continue;
                expect(await flag.isPaused(cometWithMaxAssets, index), `asset index ${index}`).to.be.false;
              }
            });

            it('leaves the other per-asset actions unpaused for every asset index', async function () {
              for (const other of assetFlags.filter((f) => f !== flag)) {
                for (let index = 0; index < MAX_ASSETS; index++) {
                  expect(await other.isPaused(cometWithMaxAssets, index), `${other.name} asset index ${index}`).to.be
                    .false;
                }
              }
            });

            it('leaves global collateral flags unpaused', async function () {
              expect(await cometWithMaxAssets.isCollateralWithdrawPaused()).to.be.false;
              expect(await cometWithMaxAssets.isCollateralSupplyPaused()).to.be.false;
              expect(await cometWithMaxAssets.isCollateralTransferPaused()).to.be.false;
            });
          });
        }
      }
    });
  });

  /**
   * The legacy coarse flags (`pause(supply, transfer, withdraw, absorb, buy)`) are checked first and revert
   * with `Paused`. The extended flags are an additional gate behind them. Each flow walks a lender through:
   * both on -> only extended on -> only legacy on -> both off.
   */
  describe('coexistence with legacy pause flags', function () {
    describe('base supply: legacy supply pause and pauseBaseSupply', function () {
      let alice: SignerWithAddress;
      let amount: bigint;

      before(async function () {
        await fixture.restore();
        alice = users[0];
        amount = 100n * 10n ** BigInt(await baseToken.decimals());
        await baseToken.allocateTo(alice.address, amount);
        await baseToken.connect(alice).approve(comet.address, amount);
      });

      it('allows pause guardian to pause legacy supply and base supply', async function () {
        await comet.connect(pauseGuardian).pause(true, false, false, false, false);
        await cometExt.connect(pauseGuardian).pauseBaseSupply(true);
        expect(await comet.isSupplyPaused()).to.be.true;
        expect(await comet.isBaseSupplyPaused()).to.be.true;
      });

      it('reverts base supply with Paused while both are on', async function () {
        await expect(
          comet.connect(alice).supply(baseToken.address, amount)
        ).to.be.revertedWithCustomError(comet, 'Paused');
      });

      it('allows pause guardian to lift the legacy supply pause', async function () {
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
        expect(await comet.isSupplyPaused()).to.be.false;
      });

      it('reverts base supply with BaseSupplyPaused while only the extended flag is on', async function () {
        await expect(
          comet.connect(alice).supply(baseToken.address, amount)
        ).to.be.revertedWithCustomError(comet, 'BaseSupplyPaused');
      });

      it('allows pause guardian to pause legacy supply again and lift base supply pause', async function () {
        await comet.connect(pauseGuardian).pause(true, false, false, false, false);
        await cometExt.connect(pauseGuardian).pauseBaseSupply(false);
        expect(await comet.isSupplyPaused()).to.be.true;
        expect(await comet.isBaseSupplyPaused()).to.be.false;
      });

      it('reverts base supply with Paused while only the legacy flag is on', async function () {
        await expect(
          comet.connect(alice).supply(baseToken.address, amount)
        ).to.be.revertedWithCustomError(comet, 'Paused');
      });

      it('allows pause guardian to lift the legacy supply pause again', async function () {
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
        expect(await comet.isSupplyPaused()).to.be.false;
      });

      it('allows base supply when both are off', async function () {
        await expect(
          comet.connect(alice).supply(baseToken.address, amount)
        ).to.changeTokenBalances(baseToken, [alice, comet], [-amount, amount]);
      });
    });

    describe('lenders withdraw: legacy withdraw pause and pauseLendersWithdraw', function () {
      let alice: SignerWithAddress;
      let amount: bigint;

      before(async function () {
        await fixture.restore();
        alice = users[0];
        amount = 100n * 10n ** BigInt(await baseToken.decimals());
        await baseToken.allocateTo(alice.address, amount);
        await baseToken.connect(alice).approve(comet.address, amount);
        await comet.connect(alice).supply(baseToken.address, amount);
      });

      it('allows pause guardian to pause legacy withdraw and lenders withdraw', async function () {
        await comet.connect(pauseGuardian).pause(false, false, true, false, false);
        await cometExt.connect(pauseGuardian).pauseLendersWithdraw(true);
        expect(await comet.isWithdrawPaused()).to.be.true;
        expect(await comet.isLendersWithdrawPaused()).to.be.true;
      });

      it('reverts lender withdraw with Paused while both are on', async function () {
        await expect(
          comet.connect(alice).withdraw(baseToken.address, amount)
        ).to.be.revertedWithCustomError(comet, 'Paused');
      });

      it('allows pause guardian to lift the legacy withdraw pause', async function () {
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
        expect(await comet.isWithdrawPaused()).to.be.false;
      });

      it('reverts lender withdraw with LendersWithdrawPaused while only the extended flag is on', async function () {
        await expect(
          comet.connect(alice).withdraw(baseToken.address, amount)
        ).to.be.revertedWithCustomError(comet, 'LendersWithdrawPaused');
      });

      it('allows pause guardian to pause legacy withdraw again and lift lenders withdraw pause', async function () {
        await comet.connect(pauseGuardian).pause(false, false, true, false, false);
        await cometExt.connect(pauseGuardian).pauseLendersWithdraw(false);
        expect(await comet.isWithdrawPaused()).to.be.true;
        expect(await comet.isLendersWithdrawPaused()).to.be.false;
      });

      it('reverts lender withdraw with Paused while only the legacy flag is on', async function () {
        await expect(
          comet.connect(alice).withdraw(baseToken.address, amount)
        ).to.be.revertedWithCustomError(comet, 'Paused');
      });

      it('allows pause guardian to lift the legacy withdraw pause again', async function () {
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
        expect(await comet.isWithdrawPaused()).to.be.false;
      });

      it('allows lender withdraw when both are off', async function () {
        await expect(
          comet.connect(alice).withdraw(baseToken.address, amount)
        ).to.changeTokenBalances(baseToken, [alice, comet], [amount, -amount]);
      });
    });

    describe('lenders transfer: legacy transfer pause and pauseLendersTransfer', function () {
      let alice: SignerWithAddress;
      let bob: SignerWithAddress;
      let amount: bigint;

      before(async function () {
        await fixture.restore();
        [alice, bob] = users;
        amount = 100n * 10n ** BigInt(await baseToken.decimals());
        await baseToken.allocateTo(alice.address, amount);
        await baseToken.connect(alice).approve(comet.address, amount);
        await comet.connect(alice).supply(baseToken.address, amount);
      });

      it('allows pause guardian to pause legacy transfer and lenders transfer', async function () {
        await comet.connect(pauseGuardian).pause(false, true, false, false, false);
        await cometExt.connect(pauseGuardian).pauseLendersTransfer(true);
        expect(await comet.isTransferPaused()).to.be.true;
        expect(await comet.isLendersTransferPaused()).to.be.true;
      });

      it('reverts lender transfer with Paused while both are on', async function () {
        await expect(
          comet.connect(alice).transfer(bob.address, amount)
        ).to.be.revertedWithCustomError(comet, 'Paused');
      });

      it('allows pause guardian to lift the legacy transfer pause', async function () {
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
        expect(await comet.isTransferPaused()).to.be.false;
      });

      it('reverts lender transfer with LendersTransferPaused while only the extended flag is on', async function () {
        await expect(
          comet.connect(alice).transfer(bob.address, amount)
        ).to.be.revertedWithCustomError(comet, 'LendersTransferPaused');
      });

      it('allows pause guardian to pause legacy transfer again and lift lenders transfer pause', async function () {
        await comet.connect(pauseGuardian).pause(false, true, false, false, false);
        await cometExt.connect(pauseGuardian).pauseLendersTransfer(false);
        expect(await comet.isTransferPaused()).to.be.true;
        expect(await comet.isLendersTransferPaused()).to.be.false;
      });

      it('reverts lender transfer with Paused while only the legacy flag is on', async function () {
        await expect(
          comet.connect(alice).transfer(bob.address, amount)
        ).to.be.revertedWithCustomError(comet, 'Paused');
      });

      it('allows pause guardian to lift the legacy transfer pause again', async function () {
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
        expect(await comet.isTransferPaused()).to.be.false;
      });

      it('allows lender transfer when both are off', async function () {
        await comet.connect(alice).transfer(bob.address, amount);
        expect(await comet.balanceOf(alice.address)).to.equal(0);
        expect(await comet.balanceOf(bob.address)).to.equal(amount);
      });
    });
  });
});
