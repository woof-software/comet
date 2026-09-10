// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModuleErrors } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModuleErrors.sol";

import { LiquidationFuzzBase } from "./LiquidationFuzzBase.sol";
import { SimplePriceFeed } from "@comet-contracts/test/SimplePriceFeed.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Eligibility for liquidation
 * @notice When the module says an account may be absorbed, and that the entry points agree with it.
 * @dev Positions stand on one collateral, enumerated rather than fuzzed. The liquidation mode is
 *      left as the market ships it: the entry predicate does not depend on it.
 */
contract LiquidationEligibilityFuzzTest is LiquidationFuzzBase {
    function setUp() public {
        prepareFixture();
        seedMarketActivity();
    }

    /// @notice A non-borrower is never liquidatable - no debt → isLiquidatable = false
    /// @dev Held even with the oracle mocked to revert: the predicate must answer false without
    ///      reaching the feed at all.
    /// @param accountKind 0 empty, 1 collateral only, 2 positive base balance.
    function testFuzz_nonBorrowerIsNeverLiquidatable(
        uint8 accountKind,
        uint256 supplyAmount,
        uint256 priceSeed,
        bool revertFeed
    ) public {
        uint256 exercised;
        uint256 kind = bound(accountKind, 0, 2);
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            assetInfo = comet.getAssetInfo(i);

            // One collateral carries the whole position, so it alone has to reach the minimum borrow.
            uint256 supply = bound(
                supplyAmount,
                Math.max(uint256(assetInfo.scale) / 1000, _supplyForDebt(assetInfo, BASE_BORROW_MIN)),
                _supplyCeiling(assetInfo)
            );
            // The whole feed range: a collapse to one, up to the largest value it can carry.
            uint256 newPrice = bound(priceSeed, 1, uint256(type(int256).max));

            uint256 snapshot = vm.snapshotState();

            // No borrow is taken in any variant.
            if (kind == 1) {
                collaterals[i].allocateTo(borrower, supply);
                vm.startPrank(borrower);
                collaterals[i].approve(address(comet), supply);
                comet.supply(address(collaterals[i]), supply);
                vm.stopPrank();
            } else if (kind == 2) {
                baseToken.allocateTo(borrower, supply);
                vm.startPrank(borrower);
                baseToken.approve(address(comet), supply);
                comet.supply(address(baseToken), supply);
                vm.stopPrank();
            }

            if (revertFeed) {
                vm.mockCallRevert(
                    address(collateralPriceFeeds[i]),
                    abi.encodeWithSelector(SimplePriceFeed.latestRoundData.selector),
                    bytes("oracle down")
                );
            } else {
                collateralPriceFeeds[i].setRoundData(0, int256(newPrice), 0, 0, 0);
            }

            assertFalse(liquidationModule.isLiquidatable(borrower), "a non-borrower was reported liquidatable");
            ++exercised;

            if (revertFeed) vm.clearMockedCalls();
            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "the invariant was never exercised");
    }

    /// @notice The threshold is strict - debtValue <= liquidity → not liquidatable
    /// @dev Equality is still healthy; one step past it would be liquidating a solvent position.
    /// @param offsetKind which side of the threshold the position is placed on.
    function testFuzz_thresholdIsStrict(uint256 supplyAmount, uint256 borrowAmount, uint8 offsetKind) public {
        uint256 exercised;
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            assetInfo = comet.getAssetInfo(i);

            // One collateral carries the whole position, so it alone has to reach the minimum borrow.
            uint256 supply = bound(
                supplyAmount,
                Math.max(uint256(assetInfo.scale) / 1000, _supplyForDebt(assetInfo, BASE_BORROW_MIN)),
                _supplyCeiling(assetInfo)
            );

            uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
            maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
            maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            if (maxBorrow < BASE_BORROW_MIN) continue; // too cheap to reach the minimum borrow

            uint256 borrow = bound(borrowAmount, BASE_BORROW_MIN, maxBorrow);

            uint256 snapshot = vm.snapshotState();

            collaterals[i].allocateTo(borrower, supply);
            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), supply);
            comet.supply(address(collaterals[i]), supply);
            comet.withdraw(address(baseToken), borrow);
            vm.stopPrank();

            uint256 thresholdPrice = _firstHealthyPrice(assetInfo);
            if (thresholdPrice < 2) { // no room to probe a unit either side
                vm.revertToState(snapshot);
                continue;
            }

            uint256 offset = bound(offsetKind, 0, 2);
            uint256 price;
            bool expectLiquidatable;
            if (offset == 0) (price, expectLiquidatable) = (thresholdPrice + 1, false);
            else if (offset == 1) (price, expectLiquidatable) = (thresholdPrice, false);
            else (price, expectLiquidatable) = (thresholdPrice - 1, true);

            collateralPriceFeeds[i].setRoundData(0, int256(price), 0, 0, 0);

            assertEq(
                liquidationModule.isLiquidatable(borrower),
                expectLiquidatable,
                "isLiquidatable disagreed with the strict threshold"
            );
            ++exercised;

            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "the invariant was never exercised");
    }

    /// @notice Absorbing a healthy account reverts - healthy → absorb reverts NotLiquidatable
    /// @dev The predicate and the entry point have to agree.
    /// @param offsetKind how far above the threshold the position sits: at it, or one above.
    function testFuzz_absorbingHealthyReverts(uint256 supplyAmount, uint256 borrowAmount, uint8 offsetKind) public {
        uint256 exercised;
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            assetInfo = comet.getAssetInfo(i);

            // One collateral carries the whole position, so it alone has to reach the minimum borrow.
            uint256 supply = bound(
                supplyAmount,
                Math.max(uint256(assetInfo.scale) / 1000, _supplyForDebt(assetInfo, BASE_BORROW_MIN)),
                _supplyCeiling(assetInfo)
            );

            uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
            maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
            maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            if (maxBorrow < BASE_BORROW_MIN) continue;

            uint256 borrow = bound(borrowAmount, BASE_BORROW_MIN, maxBorrow);

            uint256 snapshot = vm.snapshotState();

            collaterals[i].allocateTo(borrower, supply);
            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), supply);
            comet.supply(address(collaterals[i]), supply);
            comet.withdraw(address(baseToken), borrow);
            vm.stopPrank();

            uint256 thresholdPrice = _firstHealthyPrice(assetInfo);
            if (thresholdPrice < 1) { // no positive price to set
                vm.revertToState(snapshot);
                continue;
            }

            uint256 offset = bound(offsetKind, 0, 1);
            collateralPriceFeeds[i].setRoundData(0, int256(offset == 0 ? thresholdPrice : thresholdPrice + 1), 0, 0, 0);

            // Asserted rather than skipped, so a boundary drift surfaces here instead of slipping
            // through the revert below for the wrong reason.
            assertFalse(liquidationModule.isLiquidatable(borrower), "precondition: the built position is not healthy");

            vm.expectRevert(ICoreLiquidationModuleErrors.NotLiquidatable.selector);
            _absorb();
            ++exercised;

            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "the invariant was never exercised");
    }

    /// @notice Planning for a healthy account reverts - healthy → seizurePlan reverts NotLiquidatable
    /// @dev It must revert rather than return an empty array someone could mistake for a plan.
    /// @param accountKind 0 a borrower priced exactly at the threshold, 1 an account with no debt.
    function testFuzz_planningForHealthyReverts(uint256 supplyAmount, uint256 borrowAmount, uint8 accountKind) public {
        uint256 exercised;
        uint256 kind = bound(accountKind, 0, 1);
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            assetInfo = comet.getAssetInfo(i);

            // One collateral carries the whole position, so it alone has to reach the minimum borrow.
            uint256 supply = bound(
                supplyAmount,
                Math.max(uint256(assetInfo.scale) / 1000, _supplyForDebt(assetInfo, BASE_BORROW_MIN)),
                _supplyCeiling(assetInfo)
            );

            uint256 snapshot = vm.snapshotState();

            if (kind == 0) {
                uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed));
                if (maxBorrow < BASE_BORROW_MIN) {
                    vm.revertToState(snapshot);
                    continue;
                }

                uint256 borrow = bound(borrowAmount, BASE_BORROW_MIN, maxBorrow);

                collaterals[i].allocateTo(borrower, supply);
                vm.startPrank(borrower);
                collaterals[i].approve(address(comet), supply);
                comet.supply(address(collaterals[i]), supply);
                comet.withdraw(address(baseToken), borrow);
                vm.stopPrank();

                uint256 thresholdPrice = _firstHealthyPrice(assetInfo);
                if (thresholdPrice < 1) {
                    vm.revertToState(snapshot);
                    continue;
                }

                // Exactly at the threshold: the first price at which the account is healthy again.
                collateralPriceFeeds[i].setRoundData(0, int256(thresholdPrice), 0, 0, 0);
            } else {
                // An account with no debt at all: collateral supplied, nothing drawn.
                collaterals[i].allocateTo(borrower, supply);
                vm.startPrank(borrower);
                collaterals[i].approve(address(comet), supply);
                comet.supply(address(collaterals[i]), supply);
                vm.stopPrank();
            }

            // Asserted rather than skipped: a drifted boundary must fail here, not pass the revert
            // below for the wrong reason.
            assertFalse(liquidationModule.isLiquidatable(borrower), "precondition: the account is not healthy");

            vm.expectRevert(ICoreLiquidationModuleErrors.NotLiquidatable.selector);
            liquidationModule.seizurePlan(borrower);
            ++exercised;

            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "the invariant was never exercised");
    }

    /// @notice The smallest collateral price at which the borrower is no longer liquidatable.
    /// @dev Exact, so `price - 1` is the last liquidatable price and `price` the first healthy one -
    ///      which is what lets the threshold test probe both sides a unit apart. Assumes a single
    ///      supplied collateral, which every position here has.
    function _firstHealthyPrice(ICometData.AssetInfo memory assetInfo) internal view returns (uint256) {
        uint256 debtValue =
            comet.borrowBalanceOf(borrower) * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
        uint256 collBalance = comet.collateralBalanceOf(borrower, assetInfo.asset);

        return Math.ceilDiv(
            debtValue * uint256(assetInfo.scale) * uint256(FACTOR_SCALE),
            collBalance * uint256(assetInfo.liquidateCollateralFactor)
        );
    }
}
