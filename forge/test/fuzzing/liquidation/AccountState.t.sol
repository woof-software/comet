// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { CometInterface } from "@comet-contracts/CometInterface.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModuleErrors } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModuleErrors.sol";

import { LiquidationMath } from "../../helpers/LiquidationMath.sol";
import { LiquidationFuzzBase } from "./LiquidationFuzzBase.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Account state after liquidation
 * @notice What the borrower's account looks like once an absorb has run: health, debt, and whether
 *         anything was written off.
 * @dev Every position stands on one collateral, and the asset is enumerated rather than fuzzed so
 *      the tail of a twenty-four asset list is not left barely visited. Health is read off balances
 *      and prices, never asked of the module, which would compare the code against itself.
 */
contract AccountStateFuzzTest is LiquidationFuzzBase {
    using LiquidationMath for CometInterface;

    function setUp() public {
        prepareFixture();
        seedMarketActivity();
    }

    /*//////////////////////////////////////////////////////////////
                              INVARIANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Health after liquidation - HF = 0 || HF >= 1.05
    /// @dev A leftover debt that is still under-collateralized means the liquidation stopped early.
    function testFuzz_healthAfterLiquidation(
        uint256 supplySeed,
        uint256 borrowSeed,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;

        for (uint8 i; i < comet.numAssets(); ++i) {
            (bool ok, Position memory p) = _boundPosition(i, supplySeed, borrowSeed, priceSeed);
            if (!ok) continue;

            uint256 snapshot = vm.snapshotState();

            _baseScenario(p, partialEnabled);
            _absorb();

            uint256 debt = comet.borrowBalanceOf(borrower);

            assertTrue(debt == 0 || comet.healthFactor(borrower) >= TARGET_HF, "debt != 0 or HF < TARGET HF");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /// @notice Minimum debt - debt = 0 || debt >= baseBorrowMin
    /// @dev Liquidation never leaves a debt smaller than the market's minimum borrow.
    function testFuzz_minimumDebtAfterLiquidation(uint256 supplySeed, uint8 targetDebtSeed, uint256 priceSeed) public {
        uint256 liquidated;

        // Either side of the minimum: a hair under, exactly on, a hair over, and clear of it.
        uint256 choice = bound(targetDebtSeed, 0, 3);
        uint256 targetDebt;
        if (choice == 0) targetDebt = BASE_BORROW_MIN - 1;
        else if (choice == 1) targetDebt = BASE_BORROW_MIN;
        else if (choice == 2) targetDebt = BASE_BORROW_MIN + 1;
        else targetDebt = 2 * BASE_BORROW_MIN;

        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory assetInfo = comet.getAssetInfo(i);

            // Comet refuses to open a borrow below the minimum, so a position that has to end up
            // under it is opened at the minimum and repaid down. Repayments have no minimum, which
            // is what lets a position sit there at all.
            uint256 opening = Math.max(targetDebt, BASE_BORROW_MIN);

            (bool ok, Position memory p) = _boundPositionAtDebt(i, supplySeed, opening, priceSeed);
            if (!ok) continue;

            // Measured against the debt the position ends with. Drawn against the opening it could
            // land where the larger debt is liquidatable and the target is not.
            p.dropCeiling = _dropCeiling(assetInfo, p.amounts[i], targetDebt, assetInfo.liquidateCollateralFactor);
            if (p.dropCeiling == 0) continue;

            p.dropPpb = bound(priceSeed, _minDropPpb(p.amounts), p.dropCeiling);

            uint256 snapshot = vm.snapshotState();

            // Partial mode is what can stop mid-way and leave a remainder, so it stays on.
            _baseScenario(p, true);

            if (comet.borrowBalanceOf(borrower) > targetDebt) {
                uint256 repayment = comet.borrowBalanceOf(borrower) - targetDebt;
                baseToken.allocateTo(borrower, repayment);

                vm.startPrank(borrower);
                baseToken.approve(address(comet), repayment);
                comet.supply(address(baseToken), repayment);
                vm.stopPrank();
            }
            assertEq(comet.borrowBalanceOf(borrower), targetDebt, "the position was not brought to the target debt");

            // The repayment moved the debt after the scenario checked it, so the state the absorb
            // actually sees is checked again rather than taken on trust.
            assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

            _absorb();

            uint256 debt = comet.borrowBalanceOf(borrower);

            assertTrue(debt == 0 || debt >= BASE_BORROW_MIN, "debt != 0 and debt < baseBorrowMin");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /// @notice The account is no longer liquidatable - isLiquidatable = false
    /// @dev Liquidation finishes the job in a single call.
    function testFuzz_notLiquidatableAfterLiquidation(
        uint256 supplySeed,
        uint256 borrowSeed,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;

        for (uint8 i; i < comet.numAssets(); ++i) {
            (bool ok, Position memory p) = _boundPosition(i, supplySeed, borrowSeed, priceSeed);
            if (!ok) continue;

            uint256 snapshot = vm.snapshotState();

            _baseScenario(p, partialEnabled);
            _absorb();

            // Price, block time and mode are left as the absorb saw them, so this is about the
            // account and nothing else.
            assertFalse(
                liquidationModule.isLiquidatable(borrower), "the account is still liquidatable after the absorb"
            );
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /// @notice A repeat liquidation is rejected - second absorb → NotLiquidatable
    /// @dev The same account cannot be absorbed twice in a row.
    function testFuzz_repeatLiquidationIsRejected(
        uint256 supplySeed,
        uint256 borrowSeed,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;

        for (uint8 i; i < comet.numAssets(); ++i) {
            (bool ok, Position memory p) = _boundPosition(i, supplySeed, borrowSeed, priceSeed);
            if (!ok) continue;

            uint256 snapshot = vm.snapshotState();

            _baseScenario(p, partialEnabled);

            // The first absorb going through is half the invariant.
            _absorb();

            vm.expectRevert(ICoreLiquidationModuleErrors.NotLiquidatable.selector);
            _absorb();

            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /// @notice The borrower does not become a supplier - principal <= 0
    /// @dev The seizure cannot spill over in the borrower's favour.
    function testFuzz_borrowerDoesNotBecomeSupplier(uint256 supplySeed, uint256 borrowSeed, uint256 priceSeed) public {
        uint256 liquidated;

        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory assetInfo = comet.getAssetInfo(i);

            // A third of the capacity, and only a moderate fall: the collateral has to stay abundant
            // against the debt, which is the only condition under which a seizure can overshoot.
            (bool ok, Position memory p) =
                _boundPosition(i, supplySeed, borrowSeed, priceSeed, 3, assetInfo.liquidateCollateralFactor);
            if (!ok) continue;

            p.dropPpb = bound(priceSeed, p.dropCeiling / 2, p.dropCeiling);

            uint256 snapshot = vm.snapshotState();

            // Full liquidation, so the whole seizure lands in one go.
            _baseScenario(p, false);
            _absorb();

            // Comet exposes `userBasic` as its storage getter, so the struct arrives flattened.
            (int104 principal,,,,) = comet.userBasic(borrower);

            assertLe(principal, 0, "the borrower holds a positive base balance after the absorb");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /// @notice The debt does not grow - debt after < debt before
    /// @dev Liquidation reduces the debt, never increases it.
    function testFuzz_debtDoesNotGrow(
        uint256 supplySeed,
        uint256 borrowSeed,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;

        for (uint8 i; i < comet.numAssets(); ++i) {
            (bool ok, Position memory p) = _boundPosition(i, supplySeed, borrowSeed, priceSeed);
            if (!ok) continue;

            uint256 snapshot = vm.snapshotState();

            _baseScenario(p, partialEnabled);

            uint256 borrowIndexBefore = comet.totalsBasic().baseBorrowIndex;
            uint256 debtBefore = comet.borrowBalanceOf(borrower);

            _absorb();

            // No clock moves here, so no interest is blended into the difference below. Asserted
            // rather than assumed: a later edit that warps time would make accrual part of it.
            assertEq(comet.totalsBasic().baseBorrowIndex, borrowIndexBefore, "interest accrued across the absorb");

            assertLt(comet.borrowBalanceOf(borrower), debtBefore, "the debt did not shrink");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /// @notice Non-partial mode closes the debt in full - partial off → debt = 0
    /// @dev The fall runs the whole way down, so the range holds positions the collateral still
    ///      covers and positions it no longer does. Both must end at zero.
    function testFuzz_nonPartialModeClosesDebtInFull(uint256 supplySeed, uint256 borrowSeed, uint256 priceSeed) public {
        uint256 liquidated;

        for (uint8 i; i < comet.numAssets(); ++i) {
            (bool ok, Position memory p) = _boundPosition(i, supplySeed, borrowSeed, priceSeed);
            if (!ok) continue;

            uint256 snapshot = vm.snapshotState();

            _baseScenario(p, false);
            _absorb();

            assertEq(comet.borrowBalanceOf(borrower), 0, "the debt survived a non-partial liquidation");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /// @notice Bad debt only at zero collateralization - written off → collateralized = 0
    /// @dev The protocol takes a loss only once the account has nothing left that collateralizes it.
    function testFuzz_badDebtOnlyAtZeroCollateralization(
        uint256 supplySeed,
        uint256 borrowSeed,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;

        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory assetInfo = comet.getAssetInfo(i);

            // Measured against the liquidation factor, so the fall goes deeper than liquidatability
            // needs and a write-off is what the run is after.
            (bool ok, Position memory p) =
                _boundPosition(i, supplySeed, borrowSeed, priceSeed, 1, assetInfo.liquidationFactor);
            if (!ok) continue;

            uint256 snapshot = vm.snapshotState();

            _baseScenario(p, partialEnabled);

            uint256 debtValueBefore =
                comet.borrowBalanceOf(borrower) * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
            uint256 droppedPrice = comet.getPrice(assetInfo.priceFeed);

            _absorb();

            // Read off balances rather than the module's plan, which is the thing under test. The
            // liquidation factor is what makes this the credited value and not the market one: the
            // protocol takes collateral at a discount, so a seizure worth more than the debt at spot
            // can still pay down less than the debt.
            uint256 seizedValue = (p.amounts[i] - comet.collateralBalanceOf(borrower, assetInfo.asset)) * droppedPrice
                / uint256(assetInfo.scale);
            seizedValue = seizedValue * assetInfo.liquidationFactor / FACTOR_SCALE;

            // A debt cleared for less than it was worth is a debt partly written off. Where the
            // seizure covered it there is nothing to write off and the invariant has no claim.
            if (comet.borrowBalanceOf(borrower) != 0 || seizedValue >= debtValueBefore) {
                vm.revertToState(snapshot);
                continue;
            }

            assertEq(
                comet.weightedCollateral(borrower),
                0,
                "the debt was written off while the account still had collateralization"
            );
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "nothing was written off, the invariant was never exercised");
    }

    /*//////////////////////////////////////////////////////////////
                          BOUNDS AND SCENARIO
    //////////////////////////////////////////////////////////////*/

    /// @notice The draw as most of the invariants want it: the whole capacity in range, measured
    ///         against the factor a liquidation is judged by.
    function _boundPosition(uint8 index, uint256 supplySeed, uint256 borrowSeed, uint256 dropSeed)
        internal
        view
        returns (bool, Position memory)
    {
        return _boundPosition(
            index, supplySeed, borrowSeed, dropSeed, 1, comet.getAssetInfo(index).liquidateCollateralFactor
        );
    }

    /**
     * @notice Draws a position on one collateral: the deposit, the debt, and a fall that leaves it
     *         liquidatable.
     * @dev `amounts` holds the deposit at this asset's index and zeros elsewhere, so the shared
     *      scenario can treat a single collateral as a set of one.
     * @param borrowDivisor Cuts the debt ceiling by this factor, for the invariant that needs the
     *        collateral abundant against the debt. One leaves the whole capacity in range.
     * @param boundaryFactor What the fall is measured against: the liquidate collateral factor for
     *        the point the account turns liquidatable, the liquidation factor for the deeper point
     *        where seizing everything still falls short.
     * @return ok False where this asset cannot carry a position, so the caller skips it and keeps
     *         the rest of the enumeration. A `vm.assume` here would throw away the other assets too.
     */
    function _boundPosition(
        uint8 index,
        uint256 supplySeed,
        uint256 borrowSeed,
        uint256 dropSeed,
        uint256 borrowDivisor,
        uint64 boundaryFactor
    ) internal view returns (bool ok, Position memory p) {
        ICometData.AssetInfo memory info = comet.getAssetInfo(index);

        // One collateral carries the whole position, so it alone has to reach the market's minimum
        // borrow - and where the draw uses only a share of its capacity, that many times over.
        uint256 floor = Math.max(uint256(info.scale) / 1000, _supplyForDebt(info, BASE_BORROW_MIN * borrowDivisor));
        uint256 ceiling = _supplyCeiling(info);
        if (ceiling < floor) return (false, p);

        p.amounts = new uint256[](comet.numAssets());
        p.amounts[index] = bound(supplySeed, floor, ceiling);

        uint256 maxBorrow = _maxBorrow(info, p.amounts[index]) / borrowDivisor;
        if (maxBorrow < BASE_BORROW_MIN) return (false, p); // the flooring left it a shade short

        // A debt small enough against its collateral needs a fall finer than one unit of
        // `DROP_SCALE`, which cannot be expressed. The floor is the debt whose fall is exactly a
        // hundred units, found by scaling: the fall moves with the debt, so the ratio at full
        // capacity carries straight over.
        uint256 topDrop = _maxDropPpb(info, p.amounts[index], maxBorrow, boundaryFactor);
        if (topDrop < 100) return (false, p);

        p.borrow = bound(borrowSeed, Math.max(BASE_BORROW_MIN, maxBorrow * 100 / topDrop), maxBorrow);

        p.dropCeiling = _dropCeiling(info, p.amounts[index], p.borrow, boundaryFactor);
        if (p.dropCeiling == 0) return (false, p);

        p.dropPpb = bound(dropSeed, _minDropPpb(p.amounts), p.dropCeiling);
        ok = true;
    }

    /// @notice The same draw for a debt the test names rather than one it draws.
    /// @dev The deposit is drawn around the debt, not the other way round: a debt pinned at the
    ///      market's minimum against a freely drawn deposit is a rounding error's worth of the
    ///      capacity, and needs a fall finer than the scenario can apply. The band tops out where
    ///      that fall is still a hundred units of `DROP_SCALE`.
    function _boundPositionAtDebt(uint8 index, uint256 supplySeed, uint256 debt, uint256 dropSeed)
        internal
        view
        returns (bool ok, Position memory p)
    {
        ICometData.AssetInfo memory info = comet.getAssetInfo(index);

        uint256 floor = _supplyForDebt(info, debt);
        uint256 topDrop = _maxDropPpb(info, floor, debt, info.liquidateCollateralFactor);
        if (topDrop < 100) return (false, p);

        uint256 ceiling = Math.min(_supplyCeiling(info), floor * topDrop / 100);
        if (ceiling < floor) return (false, p);

        p.amounts = new uint256[](comet.numAssets());
        p.amounts[index] = bound(supplySeed, floor, ceiling);

        // Comet weighs the deposit in two divisions where `_maxBorrow` uses three, so the inversion
        // is checked against the figure that actually gates the withdrawal.
        if (_maxBorrow(info, p.amounts[index]) < debt) return (false, p);

        p.borrow = debt;

        p.dropCeiling = _dropCeiling(info, p.amounts[index], debt, info.liquidateCollateralFactor);
        if (p.dropCeiling == 0) return (false, p);

        p.dropPpb = bound(dropSeed, _minDropPpb(p.amounts), p.dropCeiling);
        ok = true;
    }

    function _maxBorrow(ICometData.AssetInfo memory info, uint256 supply) internal view returns (uint256 maxBorrow) {
        maxBorrow = supply * comet.getPrice(info.priceFeed) / uint256(info.scale);
        maxBorrow = maxBorrow * info.borrowCollateralFactor / FACTOR_SCALE;
        maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(comet.baseTokenPriceFeed());
    }

    /// @notice The top of the drawable fall.
    /// @dev Prices floor on the way into the feed, so a percent of clearance is kept; the boundary
    ///      itself belongs to its own invariant. Zero when that leaves nothing to draw from.
    function _dropCeiling(ICometData.AssetInfo memory info, uint256 supply, uint256 debt, uint64 factor)
        internal
        view
        returns (uint256)
    {
        uint256 maxDrop = _maxDropPpb(info, supply, debt, factor);

        return maxDrop < 100 ? 0 : maxDrop * 99 / 100;
    }

    /// @notice How far the price may fall, in parts of `DROP_SCALE`, before the deposit weighted by
    ///         `factor` stops covering the debt.
    function _maxDropPpb(ICometData.AssetInfo memory info, uint256 supply, uint256 debt, uint64 factor)
        internal
        view
        returns (uint256)
    {
        uint256 boundary = debt * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
        boundary = boundary * FACTOR_SCALE / uint256(factor);
        boundary = boundary * uint256(info.scale) / supply;

        return boundary * DROP_SCALE / comet.getPrice(info.priceFeed);
    }
}
