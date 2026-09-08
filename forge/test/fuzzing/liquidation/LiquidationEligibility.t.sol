// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModuleErrors } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModuleErrors.sol";

import { ProtocolFixture } from "../../helpers/ProtocolFixture.sol";
import { SimplePriceFeed } from "@comet-contracts/test/SimplePriceFeed.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Eligibility for liquidation
 */
contract LiquidationEligibilityFuzzTest is ProtocolFixture {
    address internal borrower = alice;
    address internal liquidator = bob;
    address internal baseSupplier = charlie;

    function setUp() public {
        prepareFixture();

        // Partial liquidation is on by default; this suite is about the entry predicate, which is
        // mode-independent, so it is left as the market ships it.
        uint256 BASE_LIQUIDITY = 1e18;

        baseToken.allocateTo(baseSupplier, BASE_LIQUIDITY);
        vm.startPrank(baseSupplier);
        baseToken.approve(address(comet), type(uint256).max);
        comet.supply(address(baseToken), BASE_LIQUIDITY);
        vm.stopPrank();
    }

    /**
     * @notice A non-borrower is never liquidatable - no debt → isLiquidatable = false
     * @dev Invariant. An account with no debt cannot be liquidated at any price: having no debt is
     *      not a state in which collateralization can be insufficient. Proven even when the oracle
     *      is switched to revert mode — the predicate must answer false without reaching the feed.
     * @param accountKind 0 empty, 1 collateral only, 2 positive base balance.
     * @param supplyAmount how much collateral or base is supplied.
     * @param priceSeed the collateral price at the time of the check.
     * @param revertFeed in some runs the collateral feed is switched to revert mode.
     */
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

            uint256 supply = bound(
                supplyAmount,
                uint256(assetInfo.scale) / 1000,
                Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
            );
            // The whole feed range, from a collapse to one up to the largest value the feed can carry.
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

    /**
     * @notice The threshold is strict - debtValue <= liquidity → not liquidatable
     * @dev Invariant. Eligibility appears only when the debt value is strictly greater than the
     *      LCF-weighted liquidity. Equality is still a healthy state; one step past it is liquidating
     *      a solvent position.
     * @param supplyAmount how much collateral the borrower supplies.
     * @param borrowAmount how much base the borrower draws.
     * @param offsetKind which side of the threshold the position is placed on.
     */
    function testFuzz_thresholdIsStrict(uint256 supplyAmount, uint256 borrowAmount, uint8 offsetKind) public {
        uint256 exercised;
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            assetInfo = comet.getAssetInfo(i);

            uint256 supply = bound(
                supplyAmount,
                uint256(assetInfo.scale) / 1000,
                Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
            );

            uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
            maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
            maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            if (maxBorrow < comet.baseBorrowMin()) continue; // too cheap to reach the minimum borrow

            uint256 borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            uint256 snapshot = vm.snapshotState();

            collaterals[i].allocateTo(borrower, supply);
            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), supply);
            comet.supply(address(collaterals[i]), supply);
            comet.withdraw(address(baseToken), borrow);
            vm.stopPrank();

            uint256 thresholdPrice = _firstHealthyPrice(assetInfo);
            if (thresholdPrice < 2) { // the neighbouring points are not representable
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

    /**
     * @notice Absorbing a healthy account reverts - healthy → absorb reverts NotLiquidatable
     * @dev Invariant. The predicate and the entry point agree: an account the predicate calls
     *      healthy cannot be absorbed.
     * @param supplyAmount how much collateral the borrower supplies.
     * @param borrowAmount how much base the borrower draws.
     * @param offsetKind how far above the threshold the position sits (at it, or one above).
     */
    function testFuzz_absorbingHealthyReverts(uint256 supplyAmount, uint256 borrowAmount, uint8 offsetKind) public {
        uint256 exercised;
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            assetInfo = comet.getAssetInfo(i);

            uint256 supply = bound(
                supplyAmount,
                uint256(assetInfo.scale) / 1000,
                Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
            );

            uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
            maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
            maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            if (maxBorrow < comet.baseBorrowMin()) continue;

            uint256 borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

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

            // Precondition: the position must be healthy. With an exact threshold this holds by
            // construction; asserted rather than skipped, so a boundary drift surfaces here instead of
            // slipping through the absorb below.
            assertFalse(liquidationModule.isLiquidatable(borrower), "precondition: the built position is not healthy");

            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.expectRevert(ICoreLiquidationModuleErrors.NotLiquidatable.selector);
            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
            ++exercised;

            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "the invariant was never exercised");
    }

    /**
     * @notice Planning for a healthy account reverts - healthy → seizurePlan reverts NotLiquidatable
     * @dev Invariant. The view does not build a plan where liquidation is impossible: it must not
     *      return an empty array or a draft that someone will mistake for a course of action.
     * @param supplyAmount how much collateral the borrower supplies.
     * @param borrowAmount how much base the borrower draws.
     * @param accountKind 0 a borrower with the price exactly at the threshold, 1 an account with no debt.
     */
    function testFuzz_planningForHealthyReverts(uint256 supplyAmount, uint256 borrowAmount, uint8 accountKind) public {
        uint256 exercised;
        uint256 kind = bound(accountKind, 0, 1);
        ICometData.AssetInfo memory assetInfo;

        for (uint8 i; i < comet.numAssets(); ++i) {
            assetInfo = comet.getAssetInfo(i);

            uint256 supply = bound(
                supplyAmount,
                uint256(assetInfo.scale) / 1000,
                Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
            );

            uint256 snapshot = vm.snapshotState();

            if (kind == 0) {
                uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(address(basePriceFeed));
                if (maxBorrow < comet.baseBorrowMin()) {
                    vm.revertToState(snapshot);
                    continue;
                }

                uint256 borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

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

                // The borrower sits exactly at the threshold - the first price at which the account is
                // healthy again.
                collateralPriceFeeds[i].setRoundData(0, int256(thresholdPrice), 0, 0, 0);
            } else {
                // An account with no debt at all: collateral supplied, nothing drawn.
                collaterals[i].allocateTo(borrower, supply);
                vm.startPrank(borrower);
                collaterals[i].approve(address(comet), supply);
                comet.supply(address(collaterals[i]), supply);
                vm.stopPrank();
            }

            // Precondition: the account is healthy. Asserted rather than skipped now the threshold is
            // exact - a borrower drifted over the line, or a no-debt account read as liquidatable,
            // fails here rather than passing the revert below for the wrong reason.
            assertFalse(liquidationModule.isLiquidatable(borrower), "precondition: the account is not healthy");

            vm.expectRevert(ICoreLiquidationModuleErrors.NotLiquidatable.selector);
            liquidationModule.seizurePlan(borrower);
            ++exercised;

            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "the invariant was never exercised");
    }

    /**
     * @notice The smallest collateral price at which the borrower is no longer liquidatable.
     * @dev Inverts the module's own liquidity, read off the borrower's live balances:
     *
     *          liquidatable  ⟺  debtValue > collBalance * price * LCF / (scale * 1e18)
     *
     *      The single floor on the right makes the inversion exact - `ceilDiv` returns the first
     *      integer price at which the weighted collateral covers the debt, so `price - 1` is the last
     *      liquidatable price and `price` the first healthy one. Assumes a single supplied collateral,
     *      which every position in this suite has.
     * @param assetInfo the borrower's single collateral, whose scale and liquidate factor set the boundary.
     * @return the smallest collateral price at which the borrower is no longer liquidatable.
     */
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
