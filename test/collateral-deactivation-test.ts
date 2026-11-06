import { CometExt, CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from 'build/types';
import { MAX_ASSETS, ethers, exp, expect, makeProtocol, takeSnapshot, SnapshotRestorer } from './helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';

/**
 * @title Collateral deactivation and reactivation tests
 * @notice
 *  This test suite documents and verifies the collateral deactivation feature that was
 *  introduced after the wUSDM and deUSD incident. In that incident, the protocol needed
 *  to react quickly to compromised / risky collateral, but the only available control
 *  surface was the governance proposal system, which introduces latency and coordination
 *  overhead.
 *
 *  To address this, Comet was extended with a dedicated collateral deactivation mechanism:
 *  - The `pauseGuardian` can immediately deactivate a collateral asset by index via
 *    `CometExt.deactivateCollateral(assetIndex)`.
 *  - Deactivation sets a bit in `deactivatedCollaterals` storage and, for the given asset:
 *      - marks the asset as deactivated in core `Comet` (`isCollateralDeactivated`),
 *      - pauses supply of that collateral (via `collateralsSupplyPauseFlags`),
 *      - pauses transfer of that collateral (via `collateralsTransferPauseFlags`).
 *  - Once the risk is understood and resolved, the `governor` can later reactivate the
 *    asset via `CometExt.activateCollateral(assetIndex)`, which:
 *      - clears the deactivation bit in `deactivatedCollaterals`,
 *      - unpauses supply and transfer for that asset.
 *
 *  This design allows:
 *  - **Fast, operational safety response** (pauseGuardian can respond without waiting for a
 *    full governance proposal lifecycle).
 *  - **Granularity per asset** (deactivate / activate by asset index, without impacting
 *    other collaterals).
 *  - **Clear separation of roles**:
 *      - `pauseGuardian`: emergency, short-term safety actions (deactivation).
 *      - `governor`: long-term policy decisions and re-enabling assets (activation).
 *
 * @dev
 *  What is tested in this file:
 *
 *  1. **Collateral deactivation happy path**
 *     - The `pauseGuardian` can successfully call `deactivateCollateral(assetIndex)`.
 *     - The transaction emits:
 *         - `CollateralDeactivated(assetIndex)` to signal that the asset has been marked
 *           as deactivated in protocol storage.
 *         - `CollateralAssetSupplyPauseAction(assetIndex, true)` to signal that new supply
 *           of the asset is paused.
 *         - `CollateralAssetTransferPauseAction(assetIndex, true)` to signal that transfers
 *           of that collateral are paused.
 *     - The core `Comet` contract reflects the updated state:
 *         - `isCollateralDeactivated(assetIndex)` returns `true`.
 *         - `deactivatedCollaterals()` has the corresponding bit set.
 *         - `isCollateralAssetSupplyPaused(assetIndex)` and
 *           `isCollateralAssetTransferPaused(assetIndex)` both return `true`.
 *
 *  2. **Collateral deactivation failure modes**
 *     - Only the `pauseGuardian` may deactivate collateral:
 *         - Calls from `governor` (or any non-pauseGuardian address) revert with the
 *           `OnlyPauseGuardian` custom error.
 *     - Asset index bounds are enforced:
 *         - Using an out-of-range index (`MAX_ASSETS`) reverts with `InvalidAssetIndex`.
 *
 *  3. **Collateral activation happy path**
 *     - The `governor` can successfully call `activateCollateral(assetIndex)` to re-enable
 *       a previously deactivated asset.
 *     - The transaction emits:
 *         - `CollateralActivated(assetIndex)` to signal that the deactivation flag for the
 *           asset has been cleared.
 *         - `CollateralAssetSupplyPauseAction(assetIndex, false)` to signal that new
 *           supply is allowed again.
 *         - `CollateralAssetTransferPauseAction(assetIndex, false)` to signal that
 *           transfers are allowed again.
 *     - Core `Comet` state is updated:
 *         - `isCollateralDeactivated(assetIndex)` returns `false`.
 *         - `deactivatedCollaterals()` is updated to clear the corresponding bit.
 *         - `isCollateralAssetSupplyPaused(assetIndex)` and
 *           `isCollateralAssetTransferPaused(assetIndex)` both return `false`.
 *
 *  4. **Collateral activation failure modes**
 *     - Only the `governor` may activate collateral:
 *         - Calls from the `pauseGuardian` (or any non-governor address) revert with
 *           the `OnlyGovernor` custom error.
 *     - Asset index bounds are enforced:
 *         - Using an out-of-range index (`MAX_ASSETS`) reverts with `InvalidAssetIndex`.
 *
 *  5. **MAX_ASSETS scalability and coverage**
 *     - The suite constructs a protocol with `MAX_ASSETS` collaterals and iterates over
 *       all valid indices.
 *     - For each `assetIndex` in `[0, MAX_ASSETS - 1]`:
 *         - `deactivateCollateral(assetIndex)` is callable by the `pauseGuardian` and
 *           marks the asset as deactivated in `Comet` (`isCollateralDeactivated` is `true`).
 *         - `activateCollateral(assetIndex)` is callable by the `governor` and clears the
 *           deactivated flag (`isCollateralDeactivated` is `false`).
 *     - Each index is also checked to revert on a repeated call (`CollateralIsDeactivated`
 *       on double deactivation, `CollateralIsActivated` on double activation).
 *     - These steps only check `isCollateralDeactivated`, i.e. that every bit of the
 *       separate `uint24 deactivatedCollaterals` bitmap can be set and cleared; pause
 *       flags are not checked per index here.
 *
 *  Together, these tests ensure that after the wUSDM and deUSD incident:
 *  - the protocol has a robust, low-latency mechanism to quarantine risky collateral
 *    without waiting on governance,
 *  - the mechanism is correctly wired to both storage-level flags and high-level events,
 *  - and it behaves safely and predictably across all supported asset indices and roles.
 */
describe('collateral deactivation functionality', function () {
  // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  let cometExt: CometExt;

  // Signers
  let governor: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;

  // Constants
  const ASSET_INDEX = 0;

  before(async function () {
    const collaterals = Object.fromEntries(
      Array.from({ length: MAX_ASSETS }, (_, j) => [`ASSET${j}`, {}])
    );
    const protocol = await makeProtocol({
      assets: { USDC: {}, ...collaterals },
    });
    comet = protocol.cometWithExtendedAssetList;
    cometExt = comet.attach(comet.address) as CometExt;
    governor = protocol.governor;
    pauseGuardian = protocol.pauseGuardian;
  });

  describe('collateral deactivation', function () {
    describe('happy path', function () {
      let deactivateCollateralTx: ContractTransaction;

      it('allows to deactivate by pause guardian', async function () {
        deactivateCollateralTx = await cometExt.connect(pauseGuardian).deactivateCollateral(ASSET_INDEX);
        await expect(deactivateCollateralTx).to.not.be.reverted;
      });

      it('emits CollateralDeactivated event', async function () {
        await expect(deactivateCollateralTx).to.emit(cometExt, 'CollateralDeactivated').withArgs(ASSET_INDEX);
      });

      it('emits CollateralAssetSupplyPauseAction event', async function () {
        await expect(deactivateCollateralTx).to.emit(cometExt, 'CollateralAssetSupplyPauseAction').withArgs(ASSET_INDEX, true);
      });

      it('emits CollateralAssetTransferPauseAction event', async function () {
        await expect(deactivateCollateralTx).to.emit(cometExt, 'CollateralAssetTransferPauseAction').withArgs(ASSET_INDEX, true);
      });

      it('sets collateral as deactivated in comet', async function () {
        expect(await comet.isCollateralDeactivated(ASSET_INDEX)).to.be.true;
      });

      it('updates deactivated collaterals flag in comet storage', async function () {
        expect(await comet.deactivatedCollaterals()).to.equal(1);
      });

      it('updates pause flags for deactivated collateral', async function () {
        expect(await comet.isCollateralAssetSupplyPaused(ASSET_INDEX)).to.be.true;
        expect(await comet.isCollateralAssetTransferPaused(ASSET_INDEX)).to.be.true;
      });
    });

    describe('reverts when', function () {
      it('caller is not pause guardian', async function () {
        await expect(cometExt.connect(governor).deactivateCollateral(ASSET_INDEX)).to.be.revertedWithCustomError(cometExt, 'OnlyPauseGuardian');
      });

      it('asset index is invalid', async function () {
        await expect(cometExt.connect(pauseGuardian).deactivateCollateral(MAX_ASSETS)).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
      });

      it('collateral is already deactivated', async function () {
        await expect(
          cometExt.connect(pauseGuardian).deactivateCollateral(ASSET_INDEX)
        ).to.be.revertedWithCustomError(cometExt, 'CollateralIsDeactivated')
          .withArgs(ASSET_INDEX);
      });
    });
  });

  describe('collateral activation', function () {
    describe('happy path', function () {
      let activateCollateralTx: ContractTransaction;

      it('allows to activate by governor', async function () {
        activateCollateralTx = await cometExt.connect(governor).activateCollateral(ASSET_INDEX);
        await expect(activateCollateralTx).to.not.be.reverted;
      });

      it('emits CollateralActivated event', async function () {
        await expect(activateCollateralTx).to.emit(cometExt, 'CollateralActivated').withArgs(ASSET_INDEX);
      });

      it('emits CollateralAssetSupplyPauseAction event', async function () {
        await expect(activateCollateralTx).to.emit(cometExt, 'CollateralAssetSupplyPauseAction').withArgs(ASSET_INDEX, false);
      });

      it('emits CollateralAssetTransferPauseAction event', async function () {
        await expect(activateCollateralTx).to.emit(cometExt, 'CollateralAssetTransferPauseAction').withArgs(ASSET_INDEX, false);
      });

      it('sets collateral as activated in comet', async function () {
        expect(await comet.isCollateralDeactivated(ASSET_INDEX)).to.be.false;
      });
      
      it('updates deactivated collaterals flag in comet storage', async function () {
        expect(await comet.deactivatedCollaterals()).to.equal(0);
      });

      it('updates pause flags for activated collateral', async function () {
        expect(await comet.isCollateralAssetSupplyPaused(ASSET_INDEX)).to.be.false;
        expect(await comet.isCollateralAssetTransferPaused(ASSET_INDEX)).to.be.false;
      });
    });

    describe('reverts when', function () {
      it('caller is not governor', async function () {
        await expect(cometExt.connect(pauseGuardian).activateCollateral(ASSET_INDEX)).to.be.revertedWithCustomError(cometExt, 'OnlyGovernor');
      });

      it('asset index is invalid', async function () {
        await expect(cometExt.connect(governor).activateCollateral(MAX_ASSETS)).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
      });

      it('collateral is already activated', async function () {
        await expect(cometExt.connect(governor).activateCollateral(ASSET_INDEX))
          .to.be.revertedWithCustomError(cometExt, 'CollateralIsActivated')
          .withArgs(ASSET_INDEX);
      });
    });
  });

  describe(`${MAX_ASSETS} assets support`, function () {
    describe('deactivation', function () {
      for (let i = 1; i <= MAX_ASSETS; i++) {
        let assetIndex = i - 1;

        it(`allows to deactivate asset at index ${assetIndex}`, async function () {
          await cometExt.connect(pauseGuardian).deactivateCollateral(assetIndex);
              
          // Verify that the collateral at assetIndex is deactivated
          expect(await comet.isCollateralDeactivated(assetIndex)).to.be.true;
        });

        it(`reverts on double deactivation of asset at index ${assetIndex}`, async function () {
          await expect(cometExt.connect(pauseGuardian).deactivateCollateral(assetIndex))
            .to.be.revertedWithCustomError(cometExt, 'CollateralIsDeactivated')
            .withArgs(assetIndex);
        });
      }
    });

    describe('activation', function () {
      for (let i = 1; i <= MAX_ASSETS; i++) {
        let assetIndex = i - 1;
        
        it(`allows to activate asset at index ${assetIndex}`, async function () {                
          await cometExt.connect(governor).activateCollateral(assetIndex);
                
          // Verify that the collateral at assetIndex is activated
          expect(await comet.isCollateralDeactivated(assetIndex)).to.be.false;
        });

        it(`reverts on double activation of asset at index ${assetIndex}`, async function () {
          await expect(cometExt.connect(governor).activateCollateral(assetIndex))
            .to.be.revertedWithCustomError(cometExt, 'CollateralIsActivated')
            .withArgs(assetIndex);
        });
      }
    });
  });

  /**
   * @title Ways out for a borrower holding deactivated collateral
   * @notice While a borrower holds a deactivated collateral, isBorrowCollateralized reverts with
   *  TokenIsDeactivated, which blocks every borrow-side action. The contract documents the exits
   *  (CometWithExtendedAssetList isCollateralDeactivated / withdrawCollateral): repay the debt, or
   *  withdraw all of the deactivated asset if the rest still covers the borrow; otherwise the borrower is
   *  stuck and can only be liquidated, which must keep working. These flows walk each path, and check
   *  what activateCollateral does to a pause that was set before the deactivation.
   *
   *  Setup: alice lends 10,000 USDC; WETH $3,000 (BCF 0.8, LCF 0.85, LF 0.9), WBTC $41,000 (BCF 0.7, LCF 0.75, LF 0.9).
   */
  describe('deactivated collateral: exit, stuck and liquidation paths', function () {
    const USDC_SCALE = exp(1, 6);
    const BORROW_AMOUNT = 1_000n * USDC_SCALE;

    let comet: CometHarnessInterfaceExtendedAssetList;
    let cometExt: CometExt;
    let usdc: FaucetToken;
    let weth: FaucetToken;
    let wbtc: FaucetToken;
    let wethPriceFeed: SimplePriceFeed;
    let wethIndex: number;
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let charles: SignerWithAddress;
    let governor: SignerWithAddress;
    let pauseGuardian: SignerWithAddress;
    let fixture: SnapshotRestorer;

    before(async function () {
      const protocol = await makeProtocol({
        base: 'USDC',
        assets: {
          USDC: { decimals: 6 },
          WETH: { decimals: 18, initialPrice: 3000, borrowCF: exp(0.8, 18), liquidateCF: exp(0.85, 18), liquidationFactor: exp(0.9, 18) },
          WBTC: { decimals: 8, initialPrice: 41000, borrowCF: exp(0.7, 18), liquidateCF: exp(0.75, 18), liquidationFactor: exp(0.9, 18) },
        },
      });
      comet = protocol.cometWithExtendedAssetList;
      cometExt = comet.attach(comet.address) as CometExt;
      usdc = protocol.tokens.USDC as FaucetToken;
      weth = protocol.tokens.WETH as FaucetToken;
      wbtc = protocol.tokens.WBTC as FaucetToken;
      wethPriceFeed = protocol.priceFeeds.WETH;
      wethIndex = (await comet.getAssetInfoByAddress(weth.address)).offset;
      [alice, bob, charles] = protocol.users;
      governor = protocol.governor;
      pauseGuardian = protocol.pauseGuardian;

      await usdc.allocateTo(alice.address, 10_000n * USDC_SCALE);
      await usdc.connect(alice).approve(comet.address, ethers.constants.MaxUint256);
      await comet.connect(alice).supply(usdc.address, 10_000n * USDC_SCALE);

      for (const user of [bob, charles]) {
        await weth.allocateTo(user.address, exp(2, 18));
        await wbtc.allocateTo(user.address, exp(1, 8));
        await usdc.allocateTo(user.address, 2n * BORROW_AMOUNT);
        await weth.connect(user).approve(comet.address, ethers.constants.MaxUint256);
        await wbtc.connect(user).approve(comet.address, ethers.constants.MaxUint256);
        await usdc.connect(user).approve(comet.address, ethers.constants.MaxUint256);
      }

      fixture = await takeSnapshot();
    });

    after(async function () {
      await fixture.restore();
    });

    describe('exit by repaying the debt', function () {
      before(async function () {
        await fixture.restore();
        // bob borrows 1,000 against 1 WETH ($2,400 borrowing power), then WETH is deactivated
        await comet.connect(bob).supply(weth.address, exp(1, 18));
        await comet.connect(bob).withdraw(usdc.address, BORROW_AMOUNT);
        await cometExt.connect(pauseGuardian).deactivateCollateral(wethIndex);
      });

      it('borrowing more reverts with TokenIsDeactivated', async function () {
        await expect(comet.connect(bob).withdraw(usdc.address, USDC_SCALE))
          .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(weth.address);
      });

      it('withdrawing the deactivated WETH while borrowing reverts with TokenIsDeactivated', async function () {
        await expect(comet.connect(bob).withdraw(weth.address, exp(0.1, 18)))
          .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(weth.address);
      });

      it('repaying is allowed and clears the borrow', async function () {
        await comet.connect(bob).supply(usdc.address, ethers.constants.MaxUint256);
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(0);
      });

      it('with no borrow, all of the deactivated WETH can be withdrawn', async function () {
        const walletBefore = (await weth.balanceOf(bob.address)).toBigInt();
        await comet.connect(bob).withdraw(weth.address, exp(1, 18));
        expect(await weth.balanceOf(bob.address)).to.equal(walletBefore + exp(1, 18));
        expect(await comet.collateralBalanceOf(bob.address, weth.address)).to.equal(0);
        expect((await comet.userBasic(bob.address)).assetsIn).to.equal(0);
      });
    });

    describe('stuck while the rest of the collateral is too small, unstuck by a partial repay', function () {
      before(async function () {
        await fixture.restore();
        // bob borrows 1,000 against 1 WETH and 0.01 WBTC ($287 of borrowing power on its own)
        await comet.connect(bob).supply(weth.address, exp(1, 18));
        await comet.connect(bob).supply(wbtc.address, exp(0.01, 8));
        await comet.connect(bob).withdraw(usdc.address, BORROW_AMOUNT);
        await cometExt.connect(pauseGuardian).deactivateCollateral(wethIndex);
      });

      it('withdrawing all of the WETH reverts with NotCollateralized: WBTC alone does not cover the borrow', async function () {
        await expect(comet.connect(bob).withdraw(weth.address, exp(1, 18)))
          .to.be.revertedWithCustomError(comet, 'NotCollateralized');
      });

      it('withdrawing part of the WETH reverts with TokenIsDeactivated', async function () {
        await expect(comet.connect(bob).withdraw(weth.address, exp(0.5, 18)))
          .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(weth.address);
      });

      it('withdrawing the active WBTC reverts with TokenIsDeactivated', async function () {
        await expect(comet.connect(bob).withdraw(wbtc.address, exp(0.001, 8)))
          .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(weth.address);
      });

      it('a partial repay is allowed', async function () {
        await comet.connect(bob).supply(usdc.address, 800n * USDC_SCALE);
        // about 200 left, below the $287 that WBTC backs
        expect(await comet.borrowBalanceOf(bob.address)).to.be.closeTo(200n * USDC_SCALE, USDC_SCALE);
      });

      it('then all of the WETH can be withdrawn, and the borrow stays backed by WBTC', async function () {
        await comet.connect(bob).withdraw(weth.address, exp(1, 18));
        expect(await comet.collateralBalanceOf(bob.address, weth.address)).to.equal(0);
        expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
      });

      it('with the deactivated WETH gone, bob can borrow again', async function () {
        await comet.connect(bob).withdraw(usdc.address, 50n * USDC_SCALE);
        expect(await comet.borrowBalanceOf(bob.address)).to.be.closeTo(250n * USDC_SCALE, USDC_SCALE);
      });
    });

    describe('stuck borrower can still be liquidated', function () {
      before(async function () {
        await fixture.restore();
        await comet.connect(bob).supply(weth.address, exp(1, 18));
        await comet.connect(bob).supply(wbtc.address, exp(0.01, 8));
        await comet.connect(bob).withdraw(usdc.address, BORROW_AMOUNT);
        await cometExt.connect(pauseGuardian).deactivateCollateral(wethIndex);
        // WETH to $500: liquidation value 1 × 500 × 0.85 + 0.01 × 41,000 × 0.75 = 732.5 < 1,000
        await wethPriceFeed.setRoundData(0, exp(500, 8), 0, 0, 0);
      });

      it('isLiquidatable answers (does not revert on the deactivated asset) and is true', async function () {
        expect(await comet.isLiquidatable(bob.address)).to.be.true;
      });

      it('absorb seizes the deactivated WETH and the WBTC and clears the debt', async function () {
        await comet.connect(charles).absorb(charles.address, [bob.address]);
        expect(await comet.collateralBalanceOf(bob.address, weth.address)).to.equal(0);
        expect(await comet.collateralBalanceOf(bob.address, wbtc.address)).to.equal(0);
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(0);
        expect((await comet.userBasic(bob.address)).assetsIn).to.equal(0);
      });
    });

    describe('activateCollateral clears a pause that was set before the deactivation', function () {
      before(async function () {
        await fixture.restore();
        // the guardian pauses WETH supply and transfer on their own first, then deactivates WETH
        await cometExt.connect(pauseGuardian).pauseCollateralAssetSupply(wethIndex, true);
        await cometExt.connect(pauseGuardian).pauseCollateralAssetTransfer(wethIndex, true);
        await cometExt.connect(pauseGuardian).deactivateCollateral(wethIndex);
      });

      it('while deactivated, WETH supply and transfer are paused', async function () {
        expect(await comet.isCollateralAssetSupplyPaused(wethIndex)).to.be.true;
        expect(await comet.isCollateralAssetTransferPaused(wethIndex)).to.be.true;
      });

      it('after activation, the earlier supply and transfer pauses are gone too', async function () {
        await cometExt.connect(governor).activateCollateral(wethIndex);
        expect(await comet.isCollateralDeactivated(wethIndex)).to.be.false;
        expect(await comet.isCollateralAssetSupplyPaused(wethIndex)).to.be.false;
        expect(await comet.isCollateralAssetTransferPaused(wethIndex)).to.be.false;
      });

      it('so WETH can be supplied again', async function () {
        await comet.connect(bob).supply(weth.address, exp(1, 18));
        expect(await comet.collateralBalanceOf(bob.address, weth.address)).to.equal(exp(1, 18));
      });
    });
  });

});