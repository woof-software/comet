// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { console2 } from "forge-std/console2.sol";

import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModuleErrors } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModuleErrors.sol";

import { ProtocolFixture, FaucetToken } from "../../helpers/ProtocolFixture.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Group A — account state after liquidation
 * @notice One invariant per test: a single statement a counterexample can refute.
 *
 *         Every scenario in this group builds a position on exactly one collateral, so the asset is
 *         not fuzzed — it is enumerated. Twenty-four assets sampled at random would leave the tail of
 *         the list barely visited across a few hundred runs; a loop with a snapshot per asset covers
 *         all of them on every run and leaves the fuzzer's whole budget to the amounts and the price,
 *         which is where the rounding lives.
 *
 *         Health is measured from balances and prices only. Asking the module how healthy an account
 *         is would compare the code against itself.
 */
contract AccountStateFuzzTest is ProtocolFixture {
    /// The account being liquidated.
    address internal borrower = alice;
    /// Sends the absorb transaction and is passed as the absorber. Comet relates the two in no way:
    /// it never looks at msg.sender, and the points go to the address in the argument.
    address internal liquidator = bob;
    /// Supplies the base the borrower draws from.
    address internal baseSupplier = charlie;

    /// A trillion dollars of base, comfortably above the largest borrow the bounds below allow.
    uint256 internal constant BASE_LIQUIDITY = 1e18;

    /// What the position under test was actually built from, after bounding. The fuzzer reports the
    /// raw arguments, which say nothing on their own — these are the numbers a failure is read with.
    uint256 internal builtSupplyAmount;
    uint256 internal builtBorrowAmount;
    uint256 internal builtPrice;

    function setUp() public {
        prepareFixture();

        baseToken.allocateTo(baseSupplier, BASE_LIQUIDITY);
        vm.startPrank(baseSupplier);
        baseToken.approve(address(comet), type(uint256).max);
        comet.supply(address(baseToken), BASE_LIQUIDITY);
        vm.stopPrank();
    }

    /**
     * @notice A1. After liquidation the account either owes nothing, or its debt is healthy again.
     *         There is no state in between: a leftover debt that is still under-collateralized means
     *         the liquidation stopped too early.
     */
    function testFuzz_healthAfterLiquidation(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;

        for (uint8 i; i < comet.numAssets(); ++i) {
            if (!_sizeLiquidatablePosition(i, supplyAmount, borrowAmount, priceSeed)) continue;

            uint256 snapshot = vm.snapshotState();

            _absorbSingleCollateralPosition(i, builtSupplyAmount, builtBorrowAmount, builtPrice, partialEnabled);

            uint256 debt = comet.borrowBalanceOf(borrower);
            uint256 health = _healthFactor(borrower);

            if (debt > 0 && health < TARGET_HF) _reportPosition("A1", i);

            assertTrue(debt == 0 || health >= TARGET_HF, "debt != 0 or HF < TARGET HF");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice A2. Liquidation never leaves the borrower with a debt smaller than the market's
     *         minimum borrow size. Either the debt is closed outright, or what is left is no less
     *         than `baseBorrowMin`.
     */
    function testFuzz_minimumDebtAfterLiquidation(
        uint256 supplyAmount,
        uint8 targetDebtSeed,
        uint256 priceSeed
    ) public {
        uint256 liquidated;
        uint256 baseBorrowMin = comet.baseBorrowMin();

        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory assetInfo = comet.getAssetInfo(i);

            uint256 supply = _boundSupply(assetInfo, supplyAmount);

            if (_maxBorrow(assetInfo, supply) < 2 * baseBorrowMin) continue; // the largest target debt is out of reach

            // The debts worth probing sit either side of the minimum: a hair under it, exactly on
            // it, a hair over it, and clear of it.
            uint256 targetDebt = _targetDebt(bound(targetDebtSeed, 0, 3), baseBorrowMin);

            // Comet refuses to open a borrow below the minimum, so a position that has to end up
            // under it is opened at the minimum and repaid down afterwards.
            uint256 borrow = targetDebt < baseBorrowMin ? baseBorrowMin : targetDebt;

            uint256 boundaryPrice = _boundaryPrice(assetInfo, supply, targetDebt, assetInfo.liquidateCollateralFactor);
            if (boundaryPrice < 100) continue; // no room left below the boundary to drop the price into

            builtSupplyAmount = supply;
            builtBorrowAmount = borrow;
            builtPrice = bound(priceSeed, 1, boundaryPrice * 99 / 100);

            uint256 snapshot = vm.snapshotState();

            _openPosition(i, supply, borrow);
            _repayTo(targetDebt);
            assertEq(comet.borrowBalanceOf(borrower), targetDebt, "the position was not brought to the target debt");

            // Partial liquidation is what can stop mid-way and leave a remainder, so it stays on.
            _setPartialLiquidation(true);
            _repriceAndAbsorb(i, builtPrice);

            uint256 debt = comet.borrowBalanceOf(borrower);

            if (debt > 0 && debt < baseBorrowMin) _reportPosition("A2", i);

            assertTrue(debt == 0 || debt >= baseBorrowMin, "debt != 0 and debt < baseBorrowMin");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice A3. Liquidation finishes the job in a single call: right after it, the account stops
     *         being a valid target. A position that is still liquidatable afterwards would let the
     *         very same absorb be repeated, which means the first one stopped too early.
     */
    function testFuzz_notLiquidatableAfterLiquidation(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;

        for (uint8 i; i < comet.numAssets(); ++i) {
            if (!_sizeLiquidatablePosition(i, supplyAmount, borrowAmount, priceSeed)) continue;

            uint256 snapshot = vm.snapshotState();

            // The price, the block time and the liquidation mode are left exactly as the absorb saw
            // them, so the answer below is about the account and nothing else.
            _absorbSingleCollateralPosition(i, builtSupplyAmount, builtBorrowAmount, builtPrice, partialEnabled);

            bool stillLiquidatable = liquidationModule.isLiquidatable(borrower);

            if (stillLiquidatable) _reportPosition("A3", i);

            assertFalse(stillLiquidatable, "the account is still liquidatable after the absorb");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice A4. The same account cannot be absorbed twice in a row. With nothing changed between
     *         the two calls — same block, same price, same mode — the second one is refused outright,
     *         so a liquidator cannot keep charging the same position for points or for incentive.
     */
    function testFuzz_repeatLiquidationIsRejected(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;

        for (uint8 i; i < comet.numAssets(); ++i) {
            if (!_sizeLiquidatablePosition(i, supplyAmount, borrowAmount, priceSeed)) continue;

            uint256 snapshot = vm.snapshotState();

            // The first absorb going through is half the invariant: it reverting would fail the run
            // here, before the second call is ever made.
            _absorbSingleCollateralPosition(i, builtSupplyAmount, builtBorrowAmount, builtPrice, partialEnabled);

            vm.expectRevert(ICoreLiquidationModuleErrors.NotLiquidatable.selector);
            _absorb();

            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice A5. Liquidation closes the debt but never hands the borrower a positive base balance.
     *         The seizure is allowed to cover the debt exactly; spilling over in the borrower's
     *         favour would turn a liquidated account into a base supplier at the protocol's expense.
     */
    function testFuzz_borrowerDoesNotBecomeSupplier(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed
    ) public {
        uint256 liquidated;
        uint256 baseBorrowMin = comet.baseBorrowMin();

        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory assetInfo = comet.getAssetInfo(i);

            uint256 supply = _boundSupply(assetInfo, supplyAmount);

            // A third of what the collateral could carry: the debt is deliberately small against the
            // collateral, so the seizure has slack and an overshoot is possible at all. An asset that
            // cannot reach the minimum borrow at a third of its ceiling has no such position to build.
            uint256 maxBorrow = _maxBorrow(assetInfo, supply) / 3;
            if (maxBorrow < baseBorrowMin) continue;

            uint256 borrow = bound(borrowAmount, baseBorrowMin, maxBorrow);

            uint256 boundaryPrice = _boundaryPrice(assetInfo, supply, borrow, assetInfo.liquidateCollateralFactor);
            if (boundaryPrice < 100) continue; // no room left below the boundary to drop the price into

            builtSupplyAmount = supply;
            builtBorrowAmount = borrow;
            // A moderate drop rather than the full range: the collateral stays abundant, which is the
            // condition under which the seizure has room to overshoot the debt.
            builtPrice = bound(priceSeed, boundaryPrice / 2, boundaryPrice * 99 / 100);

            uint256 snapshot = vm.snapshotState();

            // Full liquidation, so the debt is closed outright and the whole seizure lands in one go.
            _absorbSingleCollateralPosition(i, supply, borrow, builtPrice, false);

            // Comet exposes `userBasic` as its storage getter, so the struct arrives flattened.
            (int104 principal,,,,) = comet.userBasic(borrower);

            if (principal > 0) _reportPosition("A5", i);

            assertLe(principal, 0, "the borrower holds a positive base balance after the absorb");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice A6. Liquidation only ever reduces the debt. An absorb that leaves the borrower owing
     *         more than they did a moment earlier would mean the seizure was charged against them
     *         instead of paid to them.
     */
    function testFuzz_debtDoesNotGrow(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;

        for (uint8 i; i < comet.numAssets(); ++i) {
            if (!_sizeLiquidatablePosition(i, supplyAmount, borrowAmount, priceSeed)) continue;

            uint256 snapshot = vm.snapshotState();

            _openPosition(i, builtSupplyAmount, builtBorrowAmount);
            _setPartialLiquidation(partialEnabled);

            uint256 borrowIndexBefore = comet.totalsBasic().baseBorrowIndex;
            uint256 debtBefore = comet.borrowBalanceOf(borrower);

            _repriceAndAbsorb(i, builtPrice);

            uint256 debtAfter = comet.borrowBalanceOf(borrower);

            // Nothing in this test advances the clock, so the borrow index cannot have moved and no
            // interest is blended into the difference below. Asserted rather than assumed: a later
            // edit that warps time would otherwise quietly turn accrual into part of the measurement.
            assertEq(comet.totalsBasic().baseBorrowIndex, borrowIndexBefore, "interest accrued across the absorb");

            if (debtAfter >= debtBefore) _reportPosition("A6", i);

            assertLt(debtAfter, debtBefore, "the debt did not shrink");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice A7. With partial liquidation disabled there is no stopping at target health: the debt
     *         goes to zero either way. Where the collateral covers it the debt is paid off, and where
     *         it does not the remainder is written off against reserves — but nothing is left owing.
     */
    function testFuzz_nonPartialModeClosesDebtInFull(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed
    ) public {
        uint256 liquidated;

        for (uint8 i; i < comet.numAssets(); ++i) {
            // The price runs the whole way down to 1, so the range holds both positions the
            // collateral still covers and positions it no longer does. Both must end at zero.
            if (!_sizeLiquidatablePosition(i, supplyAmount, borrowAmount, priceSeed)) continue;

            uint256 snapshot = vm.snapshotState();

            _absorbSingleCollateralPosition(i, builtSupplyAmount, builtBorrowAmount, builtPrice, false);

            uint256 debt = comet.borrowBalanceOf(borrower);

            if (debt > 0) _reportPosition("A7", i);

            assertEq(debt, 0, "the debt survived a non-partial liquidation");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "no position was liquidatable, the invariant was never exercised");
    }

    /**
     * @notice A8. A debt is written off only once the account has nothing left that provides
     *         collateralization. Absorbing a shortfall while the borrower still holds collateral that
     *         counts towards a borrow would hand the loss to reserves and leave the borrower the rest.
     */
    function testFuzz_badDebtOnlyAtZeroCollateralization(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed,
        bool partialEnabled
    ) public {
        uint256 liquidated;
        uint256 baseBorrowMin = comet.baseBorrowMin();

        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory assetInfo = comet.getAssetInfo(i);

            uint256 supply = _boundSupply(assetInfo, supplyAmount);

            uint256 maxBorrow = _maxBorrow(assetInfo, supply);
            if (maxBorrow < baseBorrowMin) continue; // too cheap to reach the minimum borrow

            uint256 borrow = bound(borrowAmount, baseBorrowMin, maxBorrow);

            // Weighted by the liquidation factor rather than the liquidate collateral factor: this is
            // the price below which seizing every last unit still falls short of the debt, so the drop
            // is deeper than mere liquidatability requires and a write-off is what the run is after.
            uint256 badDebtPrice = _boundaryPrice(assetInfo, supply, borrow, assetInfo.liquidationFactor);
            if (badDebtPrice < 100) continue; // no room left below the boundary to drop the price into

            builtSupplyAmount = supply;
            builtBorrowAmount = borrow;
            builtPrice = bound(priceSeed, 1, badDebtPrice * 99 / 100);

            uint256 snapshot = vm.snapshotState();

            _openPosition(i, supply, borrow);
            _setPartialLiquidation(partialEnabled);

            uint256 debtValueBefore =
                comet.borrowBalanceOf(borrower) * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();

            _repriceAndAbsorb(i, builtPrice);

            // What the absorb credited against the debt. Read off balances, not off the module's plan
            // — the plan is the thing under test. Only asset `i` was ever supplied, so it is the only
            // balance that can have moved. The liquidation factor is what makes this the credited
            // value rather than the market value: the protocol takes the collateral at a discount, so
            // a seizure worth more than the debt at spot can still pay down less than the debt.
            uint256 seizedValue =
                (supply - comet.collateralBalanceOf(borrower, assetInfo.asset)) * builtPrice / uint256(assetInfo.scale);
            seizedValue = seizedValue * assetInfo.liquidationFactor / FACTOR_SCALE;

            // A debt cleared for less value than it was worth is a debt partly written off. Where the
            // seizure did cover it there is nothing to write off and the invariant has no claim.
            if (comet.borrowBalanceOf(borrower) != 0 || seizedValue >= debtValueBefore) {
                vm.revertToState(snapshot);
                continue;
            }

            uint256 collateralized = _weightedCollateral(borrower);

            if (collateralized != 0) _reportPosition("A8", i);

            assertEq(collateralized, 0, "the debt was written off while the account still had collateralization");
            ++liquidated;

            vm.revertToState(snapshot);
        }
        assertGt(liquidated, 0, "nothing was written off, the invariant was never exercised");
    }

    /**
     * @notice Sizes the position A1, A3 and A4 all probe on the asset at `index`: the supply is bounded
     *         to what the market accepts, the borrow to what the borrow collateral factor allows, and
     *         the price to a percent below the point where the account turns liquidatable — the
     *         boundary itself belongs to its own invariant. The result lands in the `built*` fields.
     * @return false when the asset cannot carry a position at all and the run must move on.
     */
    function _sizeLiquidatablePosition(
        uint8 index,
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed
    ) internal returns (bool) {
        ICometData.AssetInfo memory assetInfo = comet.getAssetInfo(index);

        uint256 supply = _boundSupply(assetInfo, supplyAmount);

        uint256 maxBorrow = _maxBorrow(assetInfo, supply);
        if (maxBorrow < comet.baseBorrowMin()) return false; // too cheap to reach the minimum borrow

        uint256 borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

        uint256 boundaryPrice = _boundaryPrice(assetInfo, supply, borrow, assetInfo.liquidateCollateralFactor);
        if (boundaryPrice < 100) return false; // no room left below the boundary to drop the price into

        builtSupplyAmount = supply;
        builtBorrowAmount = borrow;
        builtPrice = bound(priceSeed, 1, boundaryPrice * 99 / 100);

        return true;
    }

    /**
     * @notice Bounds a raw fuzzer argument to a supply the market accepts: no less than a thousandth
     *         of a unit, no more than a million units or the asset's supply cap, whichever binds first.
     * @dev The scale is widened before it is multiplied — the asset table's scales overflow their own
     *      uint64 at a million units.
     */
    function _boundSupply(ICometData.AssetInfo memory assetInfo, uint256 supplyAmount) internal pure returns (uint256) {
        uint256 scale = assetInfo.scale;
        return bound(supplyAmount, scale / 1000, Math.min(1_000_000 * scale, assetInfo.supplyCap));
    }

    /**
     * @notice The largest base debt `supply` of this collateral can open. Comet lets an account
     *         borrow while its collateral, weighted by the borrow collateral factor, still covers the
     *         debt.
     * @dev Rounded down in the very order Comet does, so the top of the range stays acceptable to it
     *      and no run is wasted on a borrow that reverts.
     */
    function _maxBorrow(ICometData.AssetInfo memory assetInfo, uint256 supply) internal view returns (uint256) {
        // Widened: the asset table's scales overflow their own uint64 when multiplied.
        uint256 maxBorrow = supply * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
        maxBorrow = maxBorrow * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
        return maxBorrow * comet.baseScale() / comet.getPrice(comet.baseTokenPriceFeed());
    }

    /**
     * @notice The collateral price at which `debt` exactly equals `supply` weighted by `factor`.
     * @dev Which boundary this is depends on the factor handed in. Weighted by the liquidate
     *      collateral factor it is the price the account turns liquidatable below; weighted by the
     *      liquidation factor it is the price below which even seizing everything falls short of the
     *      debt, and what is left over becomes bad debt.
     */
    function _boundaryPrice(
        ICometData.AssetInfo memory assetInfo,
        uint256 supply,
        uint256 debt,
        uint64 factor
    ) internal view returns (uint256) {
        uint256 boundaryPrice = debt * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
        boundaryPrice = boundaryPrice * FACTOR_SCALE / factor;
        return boundaryPrice * uint256(assetInfo.scale) / supply;
    }

    /// The four debts A2 probes, either side of the minimum borrow size.
    function _targetDebt(uint256 choice, uint256 baseBorrowMin) internal pure returns (uint256) {
        if (choice == 0) return baseBorrowMin - 1;
        if (choice == 1) return baseBorrowMin;
        if (choice == 2) return baseBorrowMin + 1;
        return 2 * baseBorrowMin;
    }

    /**
     * @notice Builds the position the caller sized and absorbs it: the borrower supplies `index`,
     *         draws `borrowAmount` of base, the collateral is repriced to `newPrice`, and the
     *         liquidator absorbs the account.
     * @dev Sizing the position is the caller's job — bounds differ per invariant, this does not.
     */
    function _absorbSingleCollateralPosition(
        uint8 index,
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 newPrice,
        bool partialEnabled
    ) internal {
        _openPosition(index, supplyAmount, borrowAmount);
        _setPartialLiquidation(partialEnabled);
        _repriceAndAbsorb(index, newPrice);
    }

    /// The borrower supplies the collateral at `index` and draws `borrowAmount` of base against it.
    function _openPosition(uint8 index, uint256 supplyAmount, uint256 borrowAmount) internal {
        FaucetToken collateral = collaterals[index];
        collateral.allocateTo(borrower, supplyAmount);

        vm.startPrank(borrower);
        collateral.approve(address(comet), supplyAmount);
        comet.supply(address(collateral), supplyAmount);
        comet.withdraw(address(baseToken), borrowAmount);
        vm.stopPrank();
    }

    /// Repays base until the borrower owes exactly `targetDebt`. Nothing happens if they owe less
    /// already. Comet has no minimum on a repayment, which is what lets a position sit below the
    /// minimum borrow size.
    function _repayTo(uint256 targetDebt) internal {
        uint256 debt = comet.borrowBalanceOf(borrower);
        if (debt <= targetDebt) return;

        uint256 repayment = debt - targetDebt;
        baseToken.allocateTo(borrower, repayment);

        vm.startPrank(borrower);
        baseToken.approve(address(comet), repayment);
        comet.supply(address(baseToken), repayment);
        vm.stopPrank();
    }

    function _setPartialLiquidation(bool enabled) internal {
        if (liquidationModule.partialLiquidationEnabled() == enabled) return;

        vm.prank(pauser);
        liquidationModule.liquidationModeToggle(enabled);
    }

    /// Drops the collateral price to `newPrice` and absorbs the borrower.
    function _repriceAndAbsorb(uint8 index, uint256 newPrice) internal {
        collateralPriceFeeds[index].setRoundData(0, int256(newPrice), 0, 0, 0);

        // The caller's bounds put the price below the liquidation boundary, so this holds by
        // construction. If it ever does not, the bounds are wrong and the run must not pass quietly.
        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        _absorb();
    }

    /// The liquidator absorbs the borrower. Comet relates the absorber argument to the sender in no
    /// way, so the same address plays both parts.
    function _absorb() internal {
        address[] memory accounts = new address[](1);
        accounts[0] = borrower;

        vm.prank(liquidator);
        comet.absorb(liquidator, accounts);
    }

    /**
     * @notice Prints the position a refuted invariant was built from, so a failure can be read
     *         without re-deriving the bounds from the fuzzer's raw arguments.
     * @dev One report for all of group A. Every invariant here is refuted by the same position, so
     *      they are all read with the same numbers — and a report that always prints the same block
     *      cannot drift out of step with the invariant it belongs to. Differences are left to the
     *      reader rather than computed: a shortfall printed as `target - actual` underflows the moment
     *      the run that failed happens to sit on the other side of the threshold. Everything here is
     *      read back off state, so no invariant has to hand its own numbers over.
     */
    function _reportPosition(string memory invariant, uint8 index) internal view {
        ICometData.AssetInfo memory info = comet.getAssetInfo(index);
        (int104 principal,,,,) = comet.userBasic(borrower);

        console2.log(string.concat(invariant, " refuted on collateral"), assetSpecs[index + 1].symbol); // index 0 is the base token
        console2.log("  partial liquidation   ", liquidationModule.partialLiquidationEnabled());
        console2.log("  supplied              ", builtSupplyAmount);
        console2.log("  borrowed              ", builtBorrowAmount);
        console2.log("  price after the drop  ", builtPrice);
        console2.log("  debt left             ", comet.borrowBalanceOf(borrower));
        console2.log("  base borrow minimum   ", comet.baseBorrowMin());
        console2.log("  collateral left       ", comet.collateralBalanceOf(borrower, info.asset));
        console2.log("  collateralization left", _weightedCollateral(borrower));
        console2.log("  health factor         ", _healthFactor(borrower));
        console2.log("  target health factor  ", TARGET_HF);
        console2.log("  principal left        ", principal);
        console2.log("  base handed over      ", comet.balanceOf(borrower));
    }

    /**
     * @notice The account's health, read off balances and prices alone: the collateral value weighted
     *         by the borrow collateral factors over the value of the debt, on the 1e18 scale.
     * @dev Zero when the account has no debt.
     */
    function _healthFactor(address account) internal view returns (uint256) {
        uint256 debt = comet.borrowBalanceOf(account);
        if (debt == 0) return 0;

        // The collateral still carries the factors' 1e18, which is exactly the scale the health
        // factor is reported on, so it cancels against the debt instead of being divided out.
        return _weightedCollateral(account) * comet.baseScale() / (debt * comet.getPrice(comet.baseTokenPriceFeed()));
    }

    /**
     * @notice Everything the account holds that provides collateralization: each balance valued at
     *         its price and weighted by its borrow collateral factor, summed. Carries the factors'
     *         1e18. Zero means nothing the account still holds counts towards a borrow.
     * @dev Everything is multiplied out before it is divided. Valuing each asset on its own would
     *      floor the collateral twice more, and one floored unit of value is worth thousands of wei
     *      of health factor — the measurement would lose more precision than the protocol does.
     */
    function _weightedCollateral(address account) internal view returns (uint256 weightedCollateral) {
        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            uint256 balance = comet.collateralBalanceOf(account, info.asset);
            if (balance == 0) continue;

            weightedCollateral += balance * comet.getPrice(info.priceFeed) * info.borrowCollateralFactor / info.scale;
        }
    }
}
