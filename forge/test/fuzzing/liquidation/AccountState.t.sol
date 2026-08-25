// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { CometInterface } from "@comet-contracts/CometInterface.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModuleErrors } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModuleErrors.sol";

import { LiquidationMath } from "../../helpers/LiquidationMath.sol";
import { ProtocolFixture } from "../../helpers/ProtocolFixture.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Account state after liquidation
 * @notice One invariant per test: a single statement a counterexample can refute.
 * @dev Each position stands on one collateral, and that collateral is enumerated rather than fuzzed.
 *      Sampling at random would leave the tail of a twenty-four asset list barely visited; a snapshot
 *      per asset covers all of them on every run and leaves the fuzzer's budget to the amounts and
 *      the price, which is where the rounding lives.
 *
 *      Health is read off balances and prices, never asked of the module — that would compare the
 *      code against itself. Bounds, position and absorb are written out in each test rather than
 *      shared, so reading one does not mean reading five helpers first.
 */
contract AccountStateFuzzTest is ProtocolFixture {
    using LiquidationMath for CometInterface;

    address internal borrower = alice;
    address internal liquidator = bob;
    address internal baseSupplier = charlie;

    function setUp() public {
        prepareFixture();
        uint256 BASE_LIQUIDITY = 1e18;

        baseToken.allocateTo(baseSupplier, BASE_LIQUIDITY);
        vm.startPrank(baseSupplier);
        baseToken.approve(address(comet), type(uint256).max);
        comet.supply(address(baseToken), BASE_LIQUIDITY);
        vm.stopPrank();
    }

    /**
     * @notice Health after liquidation - HF = 0 || HF >= 1.05
     * @dev Invariant. After liquidation the account either owes nothing, or its debt is healthy
     *      again. There is no state in between: a leftover debt that is still under-collateralized
     *      means the liquidation stopped too early.
     */
    function testFuzz_healthAfterLiquidation(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;
        uint256 supply;
        uint256 borrow;
        uint256 price;
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            {
                assetInfo = comet.getAssetInfo(i);

                // No less than a thousandth of a unit, no more than a million units or the asset's
                // supply cap, whichever binds first. The scale is widened before it is multiplied —
                // the asset table's scales overflow their own uint64 at a million units.
                supply = bound(
                    supplyAmount,
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                // The largest base debt this supply can open: Comet lets an account borrow while its
                // collateral, weighted by the borrow collateral factor, still covers the debt. Floored
                // in the very order Comet floors it, so the top of the range stays acceptable to it
                // and no run is wasted on a borrow that reverts.
                uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed));
                if (maxBorrow < comet.baseBorrowMin()) continue; // too cheap to reach the minimum borrow

                borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

                // The price at which the debt exactly equals the collateral weighted by the liquidate
                // collateral factor. The account turns liquidatable below it.
                uint256 boundaryPrice = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
                boundaryPrice = boundaryPrice * FACTOR_SCALE / assetInfo.liquidateCollateralFactor;
                boundaryPrice = boundaryPrice * uint256(assetInfo.scale) / supply;
                if (boundaryPrice < 100) continue; // no room left below the boundary to drop the price into

                // A percent clear of the boundary — the boundary itself belongs to its own invariant.
                price = bound(priceSeed, 1, boundaryPrice * 99 / 100);
            }

            uint256 snapshot = vm.snapshotState();

            collaterals[i].allocateTo(borrower, supply);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), supply);
            comet.supply(address(collaterals[i]), supply);
            comet.withdraw(address(baseToken), borrow);
            vm.stopPrank();

            if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
                vm.prank(pauser);
                liquidationModule.liquidationModeToggle(partialEnabled);
            }

            collateralPriceFeeds[i].setRoundData(0, int256(price), 0, 0, 0);

            // Holds by construction of the bounds above. If it ever does not, the bounds are wrong
            // and the run must not pass quietly.
            assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

            {
                address[] memory accounts = new address[](1);
                accounts[0] = borrower;

                vm.prank(liquidator);
                comet.absorb(liquidator, accounts);
            }

            uint256 debt = comet.borrowBalanceOf(borrower);

            assertTrue(debt == 0 || comet.healthFactor(borrower) >= TARGET_HF, "debt != 0 or HF < TARGET HF");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice Minimum debt - debt = 0 || debt >= baseBorrowMin
     * @dev Invariant. Liquidation never leaves the borrower with a debt smaller than the market's
     *      minimum borrow size. Either zero, or no less than the minimum.
     */
    function testFuzz_minimumDebtAfterLiquidation(
        uint256 supplyAmount,
        uint8 targetDebtSeed,
        uint256 priceSeed
    ) public {
        uint256 liquidated;
        uint256 baseBorrowMin = comet.baseBorrowMin();
        uint256 supply;
        uint256 targetDebt;
        uint256 price;
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            {
                assetInfo = comet.getAssetInfo(i);

                supply = bound(
                    supplyAmount,
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed));
                if (maxBorrow < 2 * baseBorrowMin) continue; // the largest target debt is out of reach

                // The debts worth probing sit either side of the minimum: a hair under it, exactly on
                // it, a hair over it, and clear of it.
                uint256 choice = bound(targetDebtSeed, 0, 3);
                if (choice == 0) targetDebt = baseBorrowMin - 1;
                else if (choice == 1) targetDebt = baseBorrowMin;
                else if (choice == 2) targetDebt = baseBorrowMin + 1;
                else targetDebt = 2 * baseBorrowMin;

                uint256 boundaryPrice = targetDebt * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
                boundaryPrice = boundaryPrice * FACTOR_SCALE / assetInfo.liquidateCollateralFactor;
                boundaryPrice = boundaryPrice * uint256(assetInfo.scale) / supply;
                if (boundaryPrice < 100) continue; // no room left below the boundary to drop the price into

                price = bound(priceSeed, 1, boundaryPrice * 99 / 100);
            }

            uint256 snapshot = vm.snapshotState();

            collaterals[i].allocateTo(borrower, supply);

            // Comet refuses to open a borrow below the minimum, so a position that has to end up
            // under it is opened at the minimum and repaid down afterwards. There is no minimum on a
            // repayment, which is what lets a position sit below the minimum borrow size at all.
            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), supply);
            comet.supply(address(collaterals[i]), supply);
            comet.withdraw(address(baseToken), targetDebt < baseBorrowMin ? baseBorrowMin : targetDebt);
            vm.stopPrank();

            if (comet.borrowBalanceOf(borrower) > targetDebt) {
                uint256 repayment = comet.borrowBalanceOf(borrower) - targetDebt;
                baseToken.allocateTo(borrower, repayment);

                vm.startPrank(borrower);
                baseToken.approve(address(comet), repayment);
                comet.supply(address(baseToken), repayment);
                vm.stopPrank();
            }
            assertEq(comet.borrowBalanceOf(borrower), targetDebt, "the position was not brought to the target debt");

            // Partial liquidation is what can stop mid-way and leave a remainder, so it stays on.
            if (!liquidationModule.partialLiquidationEnabled()) {
                vm.prank(pauser);
                liquidationModule.liquidationModeToggle(true);
            }

            collateralPriceFeeds[i].setRoundData(0, int256(price), 0, 0, 0);
            assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

            {
                address[] memory accounts = new address[](1);
                accounts[0] = borrower;

                vm.prank(liquidator);
                comet.absorb(liquidator, accounts);
            }

            uint256 debt = comet.borrowBalanceOf(borrower);

            assertTrue(debt == 0 || debt >= baseBorrowMin, "debt != 0 and debt < baseBorrowMin");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice The account is no longer liquidatable - isLiquidatable = false
     * @dev Invariant. Liquidation finishes the job in a single call: right after it, the account
     *      stops being a valid target.
     */
    function testFuzz_notLiquidatableAfterLiquidation(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;
        uint256 supply;
        uint256 borrow;
        uint256 price;
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            {
                assetInfo = comet.getAssetInfo(i);

                supply = bound(
                    supplyAmount,
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed));
                if (maxBorrow < comet.baseBorrowMin()) continue; // too cheap to reach the minimum borrow

                borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

                uint256 boundaryPrice = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
                boundaryPrice = boundaryPrice * FACTOR_SCALE / assetInfo.liquidateCollateralFactor;
                boundaryPrice = boundaryPrice * uint256(assetInfo.scale) / supply;
                if (boundaryPrice < 100) continue; // no room left below the boundary to drop the price into

                price = bound(priceSeed, 1, boundaryPrice * 99 / 100);
            }

            uint256 snapshot = vm.snapshotState();

            collaterals[i].allocateTo(borrower, supply);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), supply);
            comet.supply(address(collaterals[i]), supply);
            comet.withdraw(address(baseToken), borrow);
            vm.stopPrank();

            if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
                vm.prank(pauser);
                liquidationModule.liquidationModeToggle(partialEnabled);
            }

            collateralPriceFeeds[i].setRoundData(0, int256(price), 0, 0, 0);
            assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

            {
                address[] memory accounts = new address[](1);
                accounts[0] = borrower;

                vm.prank(liquidator);
                comet.absorb(liquidator, accounts);
            }

            // The price, the block time and the liquidation mode are left exactly as the absorb saw
            // them, so the answer below is about the account and nothing else.
            assertFalse(
                liquidationModule.isLiquidatable(borrower), "the account is still liquidatable after the absorb"
            );
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice A repeat liquidation is rejected - second absorb → NotLiquidatable
     * @dev Invariant. The same account cannot be absorbed twice in a row: the second call does not
     *      go through.
     */
    function testFuzz_repeatLiquidationIsRejected(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;
        uint256 supply;
        uint256 borrow;
        uint256 price;
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            {
                assetInfo = comet.getAssetInfo(i);

                supply = bound(
                    supplyAmount,
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed));
                if (maxBorrow < comet.baseBorrowMin()) continue; // too cheap to reach the minimum borrow

                borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

                uint256 boundaryPrice = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
                boundaryPrice = boundaryPrice * FACTOR_SCALE / assetInfo.liquidateCollateralFactor;
                boundaryPrice = boundaryPrice * uint256(assetInfo.scale) / supply;
                if (boundaryPrice < 100) continue; // no room left below the boundary to drop the price into

                price = bound(priceSeed, 1, boundaryPrice * 99 / 100);
            }

            uint256 snapshot = vm.snapshotState();

            collaterals[i].allocateTo(borrower, supply);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), supply);
            comet.supply(address(collaterals[i]), supply);
            comet.withdraw(address(baseToken), borrow);
            vm.stopPrank();

            if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
                vm.prank(pauser);
                liquidationModule.liquidationModeToggle(partialEnabled);
            }

            collateralPriceFeeds[i].setRoundData(0, int256(price), 0, 0, 0);
            assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            // The first absorb going through is half the invariant: it reverting would fail the run
            // here, before the second call is ever made.
            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);

            vm.expectRevert(ICoreLiquidationModuleErrors.NotLiquidatable.selector);
            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);

            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice The borrower does not become a supplier - principal <= 0
     * @dev Invariant. Liquidation closes the debt but never hands the borrower a positive base
     *      balance: the seizure cannot spill over in their favour.
     */
    function testFuzz_borrowerDoesNotBecomeSupplier(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed
    ) public {
        uint256 liquidated;
        uint256 baseBorrowMin = comet.baseBorrowMin();
        uint256 supply;
        uint256 borrow;
        uint256 price;
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            {
                assetInfo = comet.getAssetInfo(i);

                supply = bound(
                    supplyAmount,
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                // A third of what the collateral could carry: the debt is deliberately small against
                // the collateral, so the seizure has slack and an overshoot is possible at all. An
                // asset that cannot reach the minimum borrow at a third of its ceiling has no such
                // position to build.
                uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed)) / 3;
                if (maxBorrow < baseBorrowMin) continue;

                borrow = bound(borrowAmount, baseBorrowMin, maxBorrow);

                uint256 boundaryPrice = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
                boundaryPrice = boundaryPrice * FACTOR_SCALE / assetInfo.liquidateCollateralFactor;
                boundaryPrice = boundaryPrice * uint256(assetInfo.scale) / supply;
                if (boundaryPrice < 100) continue; // no room left below the boundary to drop the price into

                // A moderate drop rather than the full range: the collateral stays abundant, which is
                // the condition under which the seizure has room to overshoot the debt.
                price = bound(priceSeed, boundaryPrice / 2, boundaryPrice * 99 / 100);
            }

            uint256 snapshot = vm.snapshotState();

            collaterals[i].allocateTo(borrower, supply);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), supply);
            comet.supply(address(collaterals[i]), supply);
            comet.withdraw(address(baseToken), borrow);
            vm.stopPrank();

            // Full liquidation, so the debt is closed outright and the whole seizure lands in one go.
            if (liquidationModule.partialLiquidationEnabled()) {
                vm.prank(pauser);
                liquidationModule.liquidationModeToggle(false);
            }

            collateralPriceFeeds[i].setRoundData(0, int256(price), 0, 0, 0);
            assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

            {
                address[] memory accounts = new address[](1);
                accounts[0] = borrower;

                vm.prank(liquidator);
                comet.absorb(liquidator, accounts);
            }

            // Comet exposes `userBasic` as its storage getter, so the struct arrives flattened.
            (int104 principal,,,,) = comet.userBasic(borrower);

            assertLe(principal, 0, "the borrower holds a positive base balance after the absorb");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice The debt does not grow - debt after < debt before
     * @dev Invariant. Liquidation reduces the debt, but never increases it.
     */
    function testFuzz_debtDoesNotGrow(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;
        uint256 supply;
        uint256 borrow;
        uint256 price;
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            {
                assetInfo = comet.getAssetInfo(i);

                supply = bound(
                    supplyAmount,
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed));
                if (maxBorrow < comet.baseBorrowMin()) continue; // too cheap to reach the minimum borrow

                borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

                uint256 boundaryPrice = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
                boundaryPrice = boundaryPrice * FACTOR_SCALE / assetInfo.liquidateCollateralFactor;
                boundaryPrice = boundaryPrice * uint256(assetInfo.scale) / supply;
                if (boundaryPrice < 100) continue; // no room left below the boundary to drop the price into

                price = bound(priceSeed, 1, boundaryPrice * 99 / 100);
            }

            uint256 snapshot = vm.snapshotState();

            collaterals[i].allocateTo(borrower, supply);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), supply);
            comet.supply(address(collaterals[i]), supply);
            comet.withdraw(address(baseToken), borrow);
            vm.stopPrank();

            if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
                vm.prank(pauser);
                liquidationModule.liquidationModeToggle(partialEnabled);
            }

            uint256 borrowIndexBefore = comet.totalsBasic().baseBorrowIndex;
            uint256 debtBefore = comet.borrowBalanceOf(borrower);

            collateralPriceFeeds[i].setRoundData(0, int256(price), 0, 0, 0);
            assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

            {
                address[] memory accounts = new address[](1);
                accounts[0] = borrower;

                vm.prank(liquidator);
                comet.absorb(liquidator, accounts);
            }

            // Nothing in this test advances the clock, so the borrow index cannot have moved and no
            // interest is blended into the difference below. Asserted rather than assumed: a later
            // edit that warps time would otherwise quietly turn accrual into part of the measurement.
            assertEq(comet.totalsBasic().baseBorrowIndex, borrowIndexBefore, "interest accrued across the absorb");

            assertLt(comet.borrowBalanceOf(borrower), debtBefore, "the debt did not shrink");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice Non-partial mode closes the debt in full - partial off → debt = 0
     * @dev Invariant. With partial liquidation disabled, stopping at target health is impossible:
     *      the debt goes to zero either way - through coverage or through a write-off.
     */
    function testFuzz_nonPartialModeClosesDebtInFull(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed
    ) public {
        uint256 liquidated;
        uint256 supply;
        uint256 borrow;
        uint256 price;
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            {
                assetInfo = comet.getAssetInfo(i);

                supply = bound(
                    supplyAmount,
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed));
                if (maxBorrow < comet.baseBorrowMin()) continue; // too cheap to reach the minimum borrow

                borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

                uint256 boundaryPrice = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
                boundaryPrice = boundaryPrice * FACTOR_SCALE / assetInfo.liquidateCollateralFactor;
                boundaryPrice = boundaryPrice * uint256(assetInfo.scale) / supply;
                if (boundaryPrice < 100) continue; // no room left below the boundary to drop the price into

                // The price runs the whole way down to 1, so the range holds both positions the
                // collateral still covers and positions it no longer does. Both must end at zero.
                price = bound(priceSeed, 1, boundaryPrice * 99 / 100);
            }

            uint256 snapshot = vm.snapshotState();

            collaterals[i].allocateTo(borrower, supply);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), supply);
            comet.supply(address(collaterals[i]), supply);
            comet.withdraw(address(baseToken), borrow);
            vm.stopPrank();

            if (liquidationModule.partialLiquidationEnabled()) {
                vm.prank(pauser);
                liquidationModule.liquidationModeToggle(false);
            }

            collateralPriceFeeds[i].setRoundData(0, int256(price), 0, 0, 0);
            assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

            {
                address[] memory accounts = new address[](1);
                accounts[0] = borrower;

                vm.prank(liquidator);
                comet.absorb(liquidator, accounts);
            }

            assertEq(comet.borrowBalanceOf(borrower), 0, "the debt survived a non-partial liquidation");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice Bad debt only at zero collateralization - written off → collateralized = 0
     * @dev Invariant. The protocol writes off an uncovered debt only when the account has nothing
     *      left that provides collateralization.
     */
    function testFuzz_badDebtOnlyAtZeroCollateralization(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;
        uint256 baseBorrowMin = comet.baseBorrowMin();
        uint256 supply;
        uint256 borrow;
        uint256 price;
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            {
                assetInfo = comet.getAssetInfo(i);

                supply = bound(
                    supplyAmount,
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed));
                if (maxBorrow < baseBorrowMin) continue; // too cheap to reach the minimum borrow

                borrow = bound(borrowAmount, baseBorrowMin, maxBorrow);

                // Weighted by the liquidation factor rather than the liquidate collateral factor:
                // this is the price below which seizing every last unit still falls short of the
                // debt, so the drop is deeper than mere liquidatability requires and a write-off is
                // what the run is after.
                uint256 badDebtPrice = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
                badDebtPrice = badDebtPrice * FACTOR_SCALE / assetInfo.liquidationFactor;
                badDebtPrice = badDebtPrice * uint256(assetInfo.scale) / supply;
                if (badDebtPrice < 100) continue; // no room left below the boundary to drop the price into

                price = bound(priceSeed, 1, badDebtPrice * 99 / 100);
            }

            uint256 snapshot = vm.snapshotState();

            collaterals[i].allocateTo(borrower, supply);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), supply);
            comet.supply(address(collaterals[i]), supply);
            comet.withdraw(address(baseToken), borrow);
            vm.stopPrank();

            if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
                vm.prank(pauser);
                liquidationModule.liquidationModeToggle(partialEnabled);
            }

            uint256 debtValueBefore =
                comet.borrowBalanceOf(borrower) * comet.getPrice(address(basePriceFeed)) / comet.baseScale();

            collateralPriceFeeds[i].setRoundData(0, int256(price), 0, 0, 0);
            assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

            {
                address[] memory accounts = new address[](1);
                accounts[0] = borrower;

                vm.prank(liquidator);
                comet.absorb(liquidator, accounts);
            }

            // What the absorb credited against the debt. Read off balances, not off the module's plan
            // — the plan is the thing under test. Only asset `i` was ever supplied, so it is the only
            // balance that can have moved. The liquidation factor is what makes this the credited
            // value rather than the market value: the protocol takes the collateral at a discount, so
            // a seizure worth more than the debt at spot can still pay down less than the debt.
            uint256 seizedValue =
                (supply - comet.collateralBalanceOf(borrower, assetInfo.asset)) * price / uint256(assetInfo.scale);
            seizedValue = seizedValue * assetInfo.liquidationFactor / FACTOR_SCALE;

            // A debt cleared for less value than it was worth is a debt partly written off. Where the
            // seizure did cover it there is nothing to write off and the invariant has no claim.
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
}
