// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { CometInterface } from "@comet-contracts/CometInterface.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModule } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModule.sol";

import { ProtocolFixture, FaucetToken } from "../../helpers/ProtocolFixture.sol";
import { LiquidationMath } from "../../helpers/LiquidationMath.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Seizure precision
 * @notice Properties of the liquidation module. Value and health are read from balances and price
 *         feeds, never from the module, so the code is not compared against itself. The one place the
 *         module is consulted is `isLiquidatable`, and only for a yes or no.
 *
 *         Each test builds its own position end to end. The repetition is deliberate: a position is
 *         the thing under test, and a shared builder hides the very bounds a reader has to check.
 */
contract SeizurePrecisionFuzzTest is ProtocolFixture {
    using LiquidationMath for CometInterface;

    address internal borrower = alice;
    address internal liquidator = bob;
    address internal baseSupplier = charlie;

    /// Base liquidity, comfortably above the largest borrow the bounds below allow.
    uint256 internal constant BASE_LIQUIDITY = 1e18;

    /// What the position under test was actually built from. The fuzzer reports raw arguments, which
    /// say nothing on their own; these are the numbers a failure is read with.
    uint256 internal builtSupply;
    uint256 internal builtBorrow;
    uint256 internal builtPrice;

    function setUp() public {
        prepareFixture();

        baseToken.allocateTo(baseSupplier, BASE_LIQUIDITY);
        vm.startPrank(baseSupplier);
        baseToken.approve(address(comet), type(uint256).max);
        comet.supply(address(baseToken), BASE_LIQUIDITY);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
        A1. THE LIQUIDATABILITY THRESHOLD SITS WHERE THE REFERENCE PUTS IT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice `_getLiquidity` values a portfolio one collateral at a time. This pins where its total
     *         crosses the debt: at the price a one-division-per-asset reference calls just sufficient
     *         the account must be safe, and one tick below it must not be.
     *
     * @dev Both sides are asserted, so the threshold is fixed exactly rather than bounded. Valuing a
     *      balance in two truncated steps loses a second unit per asset, which drags the module's
     *      threshold above the reference and breaks the first assertion.
     *
     *      Asset 0 is the probe and holds exactly one unit of itself. With the balance equal to the
     *      scale its own term cannot truncate, and one tick of its price is worth exactly one value
     *      unit — so "one tick below" is precisely "one value unit short", and the other twenty-three
     *      assets carry whatever the valuation loses.
     */
    function testFuzz_liquidityThresholdMatchesReference(uint256 supplySeed, uint256 borrowSeed) public {
        uint256 held;
        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            uint256 scale = info.scale;
            uint256 supply = i == 0
                ? scale
                : bound(uint256(keccak256(abi.encode(supplySeed, i))), scale / 1000, Math.min(1_000_000 * scale, info.supplyCap));

            FaucetToken collateral = collaterals[i];
            collateral.allocateTo(borrower, supply);
            vm.startPrank(borrower);
            collateral.approve(address(comet), supply);
            comet.supply(address(collateral), supply);
            vm.stopPrank();
            ++held;
        }

        uint256 borrow = bound(borrowSeed, comet.baseBorrowMin(), _portfolioMaxBorrow() * 9 / 10);
        vm.prank(borrower);
        comet.withdraw(address(baseToken), borrow);

        // Halve everything but the probe. Otherwise the rest of the portfolio covers the debt on its
        // own, the probe's price decides nothing, and there is no threshold to find.
        for (uint8 i = 1; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            collateralPriceFeeds[i].setRoundData(0, int256(comet.getPrice(info.priceFeed) / 2), 0, 0, 0);
        }

        ICometData.AssetInfo memory probe = comet.getAssetInfo(0);
        uint256 balance = comet.collateralBalanceOf(borrower, probe.asset);
        uint256 debtValue = comet.borrowBalanceOf(borrower) * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();

        // What the other twenty-three are worth, priced and weighted in one division each.
        uint256 others;
        for (uint8 i = 1; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            others += comet.collateralBalanceOf(borrower, info.asset) * comet.getPrice(info.priceFeed)
                * info.liquidateCollateralFactor / (uint256(info.scale) * FACTOR_SCALE);
        }
        if (others >= debtValue) return; // covered without the probe: nothing to pin

        // The probe price at which the reference total just reaches the debt.
        uint256 threshold = Math.ceilDiv(
            (debtValue - others) * uint256(probe.scale) * FACTOR_SCALE,
            balance * probe.liquidateCollateralFactor
        );
        if (threshold < 2 || threshold > uint256(type(uint128).max)) return; // outside the feed's usable range

        collateralPriceFeeds[0].setRoundData(0, int256(threshold), 0, 0, 0);
        bool safeAtThreshold = !liquidationModule.isLiquidatable(borrower);

        collateralPriceFeeds[0].setRoundData(0, int256(threshold - 1), 0, 0, 0);
        bool unsafeBelow = liquidationModule.isLiquidatable(borrower);

        assertTrue(safeAtThreshold, "liquidatable at the price the reference calls sufficient");
        assertTrue(unsafeBelow, "not liquidatable one value unit below the reference threshold");
    }

    /*//////////////////////////////////////////////////////////////
       A2. A FULLY COLLATERALIZED ACCOUNT IS NEVER CALLED LIQUIDATABLE
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice A hand-built portfolio whose collateral covers the debt exactly, on balances chosen so
     *         that pricing and weighting them in two truncated steps drops the total below the debt.
     *         Valued in one division it does not, and the account must not be liquidatable.
     *
     * @dev Not fuzzed. The point is a named position that a reader can check by hand and that runs in
     *      milliseconds on every build; `testFuzz_liquidityThresholdMatchesReference` is what searches
     *      for the same defect on inputs nobody chose.
     *
     *      Every balance is one wei short of a whole unit, which leaves the largest possible remainder
     *      for each of the two truncations to discard.
     */
    function test_exactlyCollateralizedAccountIsNotLiquidatable() public {
        // Asset 0 is the probe and holds exactly one unit, so its own term cannot truncate and its
        // price is a clean lever. The rest carry balances picked so that pricing and weighting them in
        // two truncated steps loses a whole unit somewhere.
        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            uint256 supply = i == 0 ? uint256(info.scale) : _balanceTheTwoFormsDisagreeOn(info);

            FaucetToken collateral = collaterals[i];
            collateral.allocateTo(borrower, supply);
            vm.startPrank(borrower);
            collateral.approve(address(comet), supply);
            comet.supply(address(collateral), supply);
            vm.stopPrank();
        }

        // As large a debt as Comet will allow, found by asking it. Sizing this from the valuation
        // above would be guessing at Comet's own rounding, and the number only has to be big enough
        // that the probe is left with something to cover.
        uint256 borrow;
        for (uint256 step = comet.baseBorrowMin(); step < 1e15; step *= 2) {
            uint256 snapshot = vm.snapshotState();
            vm.prank(borrower);
            try comet.withdraw(address(baseToken), step) { borrow = step; } catch { }
            vm.revertToState(snapshot);
        }

        vm.prank(borrower);
        comet.withdraw(address(baseToken), borrow);

        uint256 debtValue =
            comet.borrowBalanceOf(borrower) * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();

        // Price the rest down until they no longer cover the debt on their own, or the probe's price
        // would decide nothing and there would be no boundary to place the account on. The divisor is
        // derived from the position rather than picked, so this holds whatever the market looks like.
        uint256 divisor;
        for (uint8 i = 1; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            divisor += comet.collateralBalanceOf(borrower, info.asset) * comet.getPrice(info.priceFeed)
                * info.liquidateCollateralFactor / (uint256(info.scale) * FACTOR_SCALE);
        }
        divisor = divisor / debtValue + 2;

        for (uint8 i = 1; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            collateralPriceFeeds[i].setRoundData(0, int256(comet.getPrice(info.priceFeed) / divisor), 0, 0, 0);
        }

        // What the other twenty-three are worth under each valuation.
        uint256 othersOneDivision;
        uint256 othersTwoStep;
        for (uint8 i = 1; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            uint256 valued = comet.collateralBalanceOf(borrower, info.asset) * comet.getPrice(info.priceFeed);
            othersOneDivision += valued * info.liquidateCollateralFactor / (uint256(info.scale) * FACTOR_SCALE);
            othersTwoStep += (valued / uint256(info.scale)) * info.liquidateCollateralFactor / FACTOR_SCALE;
        }

        // Without this the position proves nothing: the two valuations would agree and any answer from
        // the module would be the right one.
        assertGt(othersOneDivision, othersTwoStep, "the two valuations agree on this portfolio");
        assertGt(debtValue, othersOneDivision, "the debt is already covered without the probe");

        ICometData.AssetInfo memory probe = comet.getAssetInfo(0);

        // The probe price that brings the one-division total exactly up to the debt. The two-step total
        // then lands below it by however much the other assets lose, and an account whose collateral
        // covers its debt is one the module must not touch.
        uint256 price = Math.ceilDiv((debtValue - othersOneDivision) * FACTOR_SCALE, probe.liquidateCollateralFactor);
        collateralPriceFeeds[0].setRoundData(0, int256(price), 0, 0, 0);

        uint256 probeTerm = price * probe.liquidateCollateralFactor / FACTOR_SCALE;
        uint256 oneDivision = othersOneDivision + probeTerm;
        uint256 twoStep = othersTwoStep + probeTerm;

        assertGe(oneDivision, debtValue, "the probe price did not reach the debt");
        assertLt(twoStep, debtValue, "the two-step valuation does not fall short here");

        bool liquidatable = liquidationModule.isLiquidatable(borrower);

        assertFalse(liquidatable, "an account whose collateral covers the debt was called liquidatable");
    }

    /// @notice A balance for `info` on which the two valuations of it differ, so the portfolio above
    ///         can show the defect at all. Searched rather than guessed: whether truncating twice
    ///         loses a whole unit depends on this asset's price and factor.
    /// @dev The stride is prime because the residues that decide it move with `balance * price` modulo
    ///      the scale, and a stride sharing a factor with the scale would only walk a subset of them.
    function _balanceTheTwoFormsDisagreeOn(ICometData.AssetInfo memory info) internal view returns (uint256) {
        uint256 price = comet.getPrice(info.priceFeed);

        for (uint256 k = 1; k <= 512; ++k) {
            uint256 candidate = uint256(info.scale) / 2 + k * 1_000_003;
            uint256 valued = candidate * price;

            if ((valued / uint256(info.scale)) * info.liquidateCollateralFactor / FACTOR_SCALE
                    < valued * info.liquidateCollateralFactor / (uint256(info.scale) * FACTOR_SCALE)) {
                return candidate;
            }
        }
        return uint256(info.scale) / 2;
    }

    /*//////////////////////////////////////////////////////////////
                 B1. THE CLOSING BRANCH FORGIVES NO DEBT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice The branch that closes the debt outright credits the whole remaining debt at once, so
     *         the collateral taken has to be worth it. Anything credited beyond what left the account
     *         is debt forgiven that no collateral paid for, and the protocol carries it on a position
     *         that was covering itself.
     *
     *         Sizing that seizure with two truncated divisions forgave debt on every collateral in
     *         this market. Doing it in one, rounded up, forgives none.
     *
     * @dev The credit is read from the module's own plan rather than from the borrow balance: the
     *      balance is kept in base units and the residual is floored on its way back into them, which
     *      folds in a quantisation of a hundred value units and drowns the property.
     *
     *      One value unit of slack, and no more: the module rounds the credit up from the same product
     *      this reads down — it must, or the debt would land short — so ceiling and floor of one
     *      rational number part by less than one.
     */
    function testFuzz_closingBranchForgivesNoDebt(
        uint256 supplySeed,
        uint256 priceSeed,
        uint256 debtSeed
    ) public {
        uint256 exercised;
        uint256 minDebt = comet.baseBorrowMin();

        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            uint256 scale = info.scale;
            uint256 supply = bound(supplySeed, scale / 1000, Math.min(1_000_000 * scale, info.supplyCap));

            // The branch under test needs a debt at or under the market's minimum, so the position is
            // opened at the minimum and repaid down to a target inside it.
            uint256 maxBorrow = supply * comet.getPrice(info.priceFeed) / scale;
            maxBorrow = maxBorrow * info.borrowCollateralFactor / FACTOR_SCALE;
            maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(comet.baseTokenPriceFeed());
            if (maxBorrow < minDebt) continue;

            // Just inside the minimum: far enough below to enter the branch, close enough that the
            // price band around it is still wider than a tick.
            uint256 target = bound(debtSeed, minDebt * 3 / 4, minDebt);

            // Below the price where seizing everything stops covering the target the debt is written
            // off by design, which is not this property's business.
            uint256 boundary = target * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
            boundary = boundary * FACTOR_SCALE / info.liquidationFactor * scale / supply;
            uint256 liquidatableAt = target * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
            liquidatableAt = liquidatableAt * FACTOR_SCALE / info.liquidateCollateralFactor * scale / supply;
            if (boundary * 101 / 100 >= liquidatableAt * 99 / 100) continue;

            builtSupply = supply;
            builtBorrow = target;
            builtPrice = bound(priceSeed, boundary * 101 / 100, liquidatableAt * 99 / 100);

            uint256 snapshot = vm.snapshotState();

            FaucetToken collateral = collaterals[i];
            collateral.allocateTo(borrower, supply);
            vm.startPrank(borrower);
            collateral.approve(address(comet), supply);
            comet.supply(address(collateral), supply);
            comet.withdraw(address(baseToken), minDebt);
            vm.stopPrank();

            uint256 owed = comet.borrowBalanceOf(borrower);
            if (owed > target) {
                baseToken.allocateTo(borrower, owed - target);
                vm.startPrank(borrower);
                baseToken.approve(address(comet), owed - target);
                comet.supply(address(baseToken), owed - target);
                vm.stopPrank();
            }

            collateralPriceFeeds[i].setRoundData(0, int256(builtPrice), 0, 0, 0);
            if (!liquidationModule.isLiquidatable(borrower)) {
                vm.revertToState(snapshot);
                continue;
            }

            uint256 credited;
            ICoreLiquidationModule.Seizure[] memory plan = liquidationModule.seizurePlan(borrower);
            for (uint256 p; p < plan.length; ++p) credited += plan[p].seizedValue;

            address[] memory accounts = new address[](1);
            accounts[0] = borrower;
            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);

            uint256 seized = supply - comet.collateralBalanceOf(borrower, info.asset);
            uint256 backing = seized * builtPrice * info.liquidationFactor / (uint256(info.scale) * FACTOR_SCALE);
            uint256 forgiven = credited > backing ? credited - backing : 0;

            assertLe(forgiven, 1, "the closing branch forgave debt that no collateral paid for");
            ++exercised;

            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "no position reached the closing branch, the property was never exercised");
    }

    /*//////////////////////////////////////////////////////////////
             C2. THE SEIZURE DOES NOT RUN PAST WHAT IT NEEDED
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Reaching the target is only half of it. A seizure that overshoots takes collateral the
     *         account did not have to give, so this bounds the overshoot at the value of a single
     *         collateral unit — which is the smallest step a seizure can be made in, and therefore the
     *         least it can be asked to overshoot by.
     *
     * @dev The requirement is the solved value S, the collateralization the target needs removed. The
     *      measurement is the collateralization that actually left, taken from balances before and
     *      after. One collateral unit is worth `price * BCF / scale`; on a coarse token that is
     *      thousands of value units, and no bound tighter than one unit can be met.
     */
    function testFuzz_overshootPastTargetIsBounded(
        uint256 supplySeed,
        uint256 borrowSeed,
        uint256 priceSeed
    ) public {
        uint256 exercised;

        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            uint256 scale = info.scale;
            uint256 supply = bound(supplySeed, scale / 1000, Math.min(1_000_000 * scale, info.supplyCap));

            uint256 maxBorrow = supply * comet.getPrice(info.priceFeed) / scale;
            maxBorrow = maxBorrow * info.borrowCollateralFactor / FACTOR_SCALE;
            maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(comet.baseTokenPriceFeed());
            // Well clear of the minimum. Near it the seizure that reaches target would drop the debt
            // under the floor, and the plan closes it outright instead — a different branch.
            if (maxBorrow < comet.baseBorrowMin() * 40) continue;

            uint256 borrow = bound(borrowSeed, comet.baseBorrowMin() * 20, maxBorrow);

            uint256 boundary = borrow * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
            boundary = boundary * FACTOR_SCALE / info.liquidationFactor * scale / supply;
            uint256 liquidatableAt = borrow * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
            liquidatableAt = liquidatableAt * FACTOR_SCALE / info.liquidateCollateralFactor * scale / supply;
            if (boundary * 101 / 100 >= liquidatableAt * 99 / 100) continue;

            builtSupply = supply;
            builtBorrow = borrow;
            builtPrice = bound(priceSeed, boundary * 101 / 100, liquidatableAt * 99 / 100);

            uint256 snapshot = vm.snapshotState();

            FaucetToken collateral = collaterals[i];
            collateral.allocateTo(borrower, supply);
            vm.startPrank(borrower);
            collateral.approve(address(comet), supply);
            comet.supply(address(collateral), supply);
            comet.withdraw(address(baseToken), borrow);
            vm.stopPrank();

            collateralPriceFeeds[i].setRoundData(0, int256(builtPrice), 0, 0, 0);
            if (!liquidationModule.isLiquidatable(borrower)) {
                vm.revertToState(snapshot);
                continue;
            }

            uint256 collateralizationBefore = comet.weightedCollateral(borrower) / FACTOR_SCALE;
            uint256 debtValue = comet.borrowBalanceOf(borrower)
                * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();

            address[] memory accounts = new address[](1);
            accounts[0] = borrower;
            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);

            // Nothing was left to reach a target for; the debt was closed outright.
            if (comet.borrowBalanceOf(borrower) == 0) {
                vm.revertToState(snapshot);
                continue;
            }

            if (collateralizationBefore * FACTOR_SCALE >= debtValue * TARGET_HF) {
                vm.revertToState(snapshot); // already at target before the absorb: nothing was required
                continue;
            }

            // The collateralization the target required be removed, solved in one division.
            uint256 required = Math.ceilDiv(
                (debtValue * TARGET_HF - collateralizationBefore * FACTOR_SCALE) * FACTOR_SCALE,
                uint256(info.liquidationFactor) * TARGET_HF - uint256(info.borrowCollateralFactor) * FACTOR_SCALE
            ) * info.borrowCollateralFactor / FACTOR_SCALE;

            uint256 removed = collateralizationBefore - comet.weightedCollateral(borrower) / FACTOR_SCALE;
            // What one collateral unit is worth once weighted, which is the step the seizure moves in
            // and so the least it can be asked to overshoot by. Plus two, for the ceilings the plan
            // applies on the way — one on the value it solves for, one on the units it converts that
            // into — each of which can add a value unit of its own. On a cheap collateral the unit is
            // worth less than a value unit and those two are the whole budget.
            uint256 oneUnit = builtPrice * info.borrowCollateralFactor / (uint256(info.scale) * FACTOR_SCALE) + 2;
            uint256 overshoot = removed > required ? removed - required : 0;

            assertLe(overshoot, oneUnit, "the seizure removed more collateralization than one unit past the target");
            ++exercised;

            vm.revertToState(snapshot);
        }
        // The branch this is about is narrow — the debt has to sit clear of the minimum and the price
        // inside a band — so some draws reach it on no asset at all. Those are discarded rather than
        // failed; if the branch were unreachable outright the fuzzer would run out of draws and say so.
        vm.assume(exercised > 0);
    }

    /*//////////////////////////////////////////////////////////////
            E. THE CLAMP ON THE CREDIT IS LOAD BEARING
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice `if (seizedValue > debtRemainingValue) seizedValue = debtRemainingValue;` is not dead
     *         code. This finds inputs that reach it, so it is not removed alongside the two ceilings
     *         beside it, which their branch conditions really do make unreachable.
     *
     * @dev What makes it reachable: `seizedAmount` is rounded up to a whole collateral unit, and that
     *      unit can be worth more than the debt still standing. The line it protects is the next one,
     *      `debtRemainingValue -= seizedValue` — without the clamp that underflows, the absorb reverts,
     *      and the account cannot be liquidated at all.
     *
     *      Arithmetic only, and swept rather than fuzzed. The region is a handful of value units wide,
     *      sitting where the debt is worth almost exactly what the collateral repays after the penalty,
     *      so a search over positions would step straight over it.
     */
    function test_seizedValueClampIsLoadBearing() public view {
        uint256 minDebtValue = comet.baseBorrowMin() * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
        uint256 reached;

        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);

            for (uint256 magnitude; magnitude < 4; ++magnitude) {
                uint256 balance = Math.min(
                    uint256(info.scale) * (10 ** (magnitude * 2)),
                    Math.min(1_000_000 * uint256(info.scale), info.supplyCap)
                );
                reached += _timesTheClampWouldFire(info, balance, minDebtValue);
            }
        }

        assertGt(reached, 0, "no input reaches the clamp; it may be dead code now");
    }

    /// @notice How many points in the neighbourhood of one balance produce a credit larger than the
    ///         debt still standing. Split out only to keep the sweep below off the stack limit.
    /// @dev The running collateralization is swept upward from this asset's own contribution, which is
    ///      the least the loop can hold when it reaches the asset — no earlier iteration can have
    ///      removed it. The debt is swept down from what the balance repays after the penalty.
    function _timesTheClampWouldFire(
        ICometData.AssetInfo memory info,
        uint256 balance,
        uint256 minDebtValue
    ) internal view returns (uint256 fired) {
        uint256 scale = info.scale;
        uint256 price = comet.getPrice(info.priceFeed);

        uint256 collateralValue = balance * price / scale;
        if (collateralValue < 2) return 0;

        uint256 payable_ = balance * price * info.liquidationFactor / (scale * FACTOR_SCALE);
        if (payable_ < minDebtValue + 8) return 0; // under the minimum the plan closes the debt instead

        uint256 own = balance * price * info.borrowCollateralFactor / (scale * FACTOR_SCALE);

        for (uint256 debtOffset; debtOffset < 8; ++debtOffset) {
            uint256 debt = payable_ - debtOffset;

            for (uint256 collateralizationOffset; collateralizationOffset < 8; ++collateralizationOffset) {
                uint256 collateralization = own + collateralizationOffset;
                if (debt * TARGET_HF / FACTOR_SCALE <= collateralization) continue; // target already met

                uint256 wanted = Math.ceilDiv(
                    (debt * TARGET_HF - collateralization * FACTOR_SCALE) * FACTOR_SCALE,
                    uint256(info.liquidationFactor) * TARGET_HF - uint256(info.borrowCollateralFactor) * FACTOR_SCALE
                );

                uint256 cap = debt * FACTOR_SCALE / info.liquidationFactor;
                if (wanted > cap) wanted = cap;
                if (wanted >= collateralValue) continue; // the other branch seizes everything

                uint256 seizedAmount = Math.ceilDiv(wanted * scale, price);
                uint256 seizedValue = Math.ceilDiv(seizedAmount * price * info.liquidationFactor, scale * FACTOR_SCALE);

                if (seizedValue > debt) ++fired;
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                                  HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice What the borrower's whole portfolio can borrow, weighted by the borrow collateral factors.
    function _portfolioMaxBorrow() internal view returns (uint256 total) {
        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            total += comet.collateralBalanceOf(borrower, info.asset) * comet.getPrice(info.priceFeed)
                * info.borrowCollateralFactor / (uint256(info.scale) * FACTOR_SCALE);
        }
        total = total * comet.baseScale() / comet.getPrice(comet.baseTokenPriceFeed());
    }

}
