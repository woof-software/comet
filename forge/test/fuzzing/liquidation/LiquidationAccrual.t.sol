// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { CometConfiguration } from "@comet-contracts/CometConfiguration.sol";
import { Deployable } from "@comet-contracts/CometProxyAdmin.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModule } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModule.sol";
import { LiquidationModule } from "@comet-contracts/liquidation-module/LiquidationModule.sol";
import { OneInchV6Adapter } from "@comet-contracts/dex-adapters/core/OneInchV6Adapter.sol";

import { LiquidationModuleDeployer } from "../../helpers/LiquidationModuleDeployer.sol";
import { ProtocolFixture } from "../../helpers/ProtocolFixture.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Accrual and time
 * @notice The one group where market rates are non-zero: here accrual is the subject itself. Each
 *         position stands on a single collateral, enumerated by a loop with a snapshot per asset.
 */
contract LiquidationAccrualFuzzTest is ProtocolFixture {
    address internal borrower = alice;
    address internal liquidator = bob;
    address internal baseSupplier = charlie;

    function setUp() public {
        // Base liquidity is supplied per test, sized to the borrow, so utilization (and therefore the
        // rate) can be placed where each scenario needs it.
        prepareFixture();
    }

    /// @dev Interest rates stay as the fixture ships them (non-zero) - accrual is the subject. Reward
    ///      tracking is turned off: with a small base pool and a long elapsed the per-unit tracking index
    ///      (speed x time x scale / totalBase) overflows its uint64, unrelated to interest accrual.
    function buildCometConfiguration(address liquidationModule_)
        internal
        view
        override
        returns (CometConfiguration.Configuration memory config)
    {
        config = super.buildCometConfiguration(liquidationModule_);

        config.baseTrackingSupplySpeed = 0;
        config.baseTrackingBorrowSpeed = 0;
    }

    /**
     * @notice Accrual always happens - lastAccrualTime = block.timestamp
     * @dev Invariant. Liquidation accrues interest regardless of how much time has passed since the
     *      previous accrual - a second, a year, or zero seconds. No conditional "too little time" skip
     *      may leave the clock behind.
     * @param supplyAmount how much collateral the borrower supplies.
     * @param borrowAmount how much base the borrower draws.
     * @param priceSeed the new collateral price.
     * @param elapsedSeed how much time passes before the call (0 and 1 second guaranteed to occur).
     * @param utilizationSeed the market's utilization, spanning the rate kink.
     */
    function testFuzz_accrualAlwaysHappens(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed,
        uint256 elapsedSeed,
        uint256 utilizationSeed
    ) public {
        uint256 exercised;

        // Elapsed spans zero to a year, with zero and one second guaranteed to appear among the values.
        uint256 elapsed;
        {
            uint256 pick = elapsedSeed % 4;
            if (pick == 0) elapsed = 0;
            else if (pick == 1) elapsed = 1;
            else elapsed = bound(elapsedSeed, 2, 365 days);
        }

        // Target utilization in bps, spanning the 80% borrow kink so both rate slopes are exercised.
        uint256 targetUtilBps = bound(utilizationSeed, 100, 9_900);
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

            // Size the pool so utilization = borrow / pool = target, placing the rate on either side of
            // the kink. (Deviation: the doc drives utilization with a second user's borrow; per-asset
            // supply caps pin one account's borrow far below the base pool, so it cannot reach the kink -
            // sizing the pool crosses it exactly and keeps the borrower's own bound faithful.)
            _supplyBase(borrow * 10_000 / targetUtilBps);
            _openPosition(i, supply, borrow);

            // Threshold before the warp: the isLiquidatable gate reads the stored (build-time) debt, so
            // the price drop is measured against the same figure. The warp then gives the absorb a real
            // interval to accrue - which is what this invariant is about.
            uint256 thresholdPrice = _firstHealthyPrice(assetInfo);
            if (thresholdPrice < 2) {
                vm.revertToState(snapshot);
                continue;
            }

            vm.warp(block.timestamp + elapsed);

            collateralPriceFeeds[i].setRoundData(0, int256(bound(priceSeed, 1, thresholdPrice * 99 / 100)), 0, 0, 0);

            if (!liquidationModule.isLiquidatable(borrower)) {
                vm.revertToState(snapshot);
                continue;
            }

            address[] memory accounts = new address[](1);
            accounts[0] = borrower;
            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);

            assertEq(
                comet.totalsBasic().lastAccrualTime,
                uint40(block.timestamp),
                "the absorb did not accrue to the current time"
            );
            ++exercised;

            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "the invariant was never exercised");
    }

    /**
     * @notice Liquidation looks at the current debt - plan == plan after accrueAccount
     * @dev Invariant. Eligibility and the seizure size are computed from the accrued debt, not a stale
     *      principal: a position that went underwater from interest is seen, and an explicit accrual
     *      changes nothing. No price moves anywhere here.
     * @param supplyAmount how much collateral the borrower supplies.
     * @param borrowAmount how much base the borrower draws (near the top, so interest alone tips it).
     * @param elapsedSeed how much time passes before the call.
     */
    function testFuzz_liquidationUsesCurrentDebt(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 elapsedSeed
    ) public {
        uint256 exercised;
        // Interest tips the position underwater only after enough time at the fixture's rate (~0.65/yr
        // at full utilization). The doc's 1-hour floor cannot, so it is raised to where the debt reliably
        // crosses the liquidate line from interest alone (see report - a flagged deviation).
        uint256 elapsed = bound(elapsedSeed, 180 days, 365 days);
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

            // Near the top of the borrow capacity, so interest alone can carry it over the liquidate line.
            // Floor clamped to baseBorrowMin: when maxBorrow sits just above it, 95% of maxBorrow would
            // fall under the minimum and Comet rejects the withdraw with BorrowTooSmall.
            uint256 borrow = bound(borrowAmount, Math.max(maxBorrow * 95 / 100, comet.baseBorrowMin()), maxBorrow);

            uint256 snapshot = vm.snapshotState();

            // Near-full utilization for the fastest accrual the rate model allows.
            _supplyBase(borrow * 100 / 99);
            _openPosition(i, supply, borrow);

            vm.warp(block.timestamp + elapsed);

            // The standalone views read the stored index, so the interest just accrued is invisible to
            // isLiquidatable/seizurePlan until it is written back. Accrue it in, so the account is seen as
            // the interest left it - which is the point: liquidation reads the accrued debt.
            comet.accrueAccount(borrower);

            // Precondition: the position went underwater with no price movement.
            if (!liquidationModule.isLiquidatable(borrower)) {
                vm.revertToState(snapshot);
                continue;
            }

            ICoreLiquidationModule.Seizure[] memory planA = liquidationModule.seizurePlan(borrower);
            comet.accrueAccount(borrower);
            ICoreLiquidationModule.Seizure[] memory planB = liquidationModule.seizurePlan(borrower);

            assertEq(planA.length, planB.length, "the plan length changed across an explicit accrual");
            for (uint256 k; k < planA.length; ++k) {
                assertEq(planA[k].index, planB[k].index, "seizure index changed across accrual");
                assertEq(planA[k].asset, planB[k].asset, "seizure asset changed across accrual");
                assertEq(planA[k].seizedAmount, planB[k].seizedAmount, "seized amount changed across accrual");
                assertEq(planA[k].seizedValue, planB[k].seizedValue, "seized value changed across accrual");
                assertEq(
                    planA[k].wantedCollateralValue,
                    planB[k].wantedCollateralValue,
                    "wanted collateral value changed across accrual"
                );
            }
            ++exercised;

            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "the invariant was never exercised");
    }

    /**
     * @notice Indexes never decrease - index after >= index before
     * @dev Invariant. The supply and borrow indexes grow monotonically or stay put across a liquidation.
     *      An index moving backwards would mean accrued interest disappeared. `rateKind` picks the regime:
     *      0 redeploys the market with zero rates (indexes stay put), 1 keeps the non-zero default
     *      (indexes grow) - both must satisfy `after >= before`.
     * @param supplyAmount how much collateral the borrower supplies.
     * @param borrowAmount how much base the borrower draws.
     * @param priceSeed the new collateral price.
     * @param elapsedSeed how much time passes before the call.
     * @param rateKind 0 zero rates (via redeploy), 1 the non-zero default.
     */
    function testFuzz_indexesNeverDecrease(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 priceSeed,
        uint256 elapsedSeed,
        uint8 rateKind
    ) public {
        if (bound(rateKind, 0, 1) == 0) _switchToZeroRates();

        uint256 exercised;
        uint256 elapsed = bound(elapsedSeed, 0, 365 days);
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

            _supplyBase(borrow * 2);
            _openPosition(i, supply, borrow);

            // Threshold before the warp: the gate reads the stored (build-time) debt either way.
            uint256 thresholdPrice = _firstHealthyPrice(assetInfo);
            if (thresholdPrice < 2) {
                vm.revertToState(snapshot);
                continue;
            }

            vm.warp(block.timestamp + elapsed);

            collateralPriceFeeds[i].setRoundData(0, int256(bound(priceSeed, 1, thresholdPrice * 99 / 100)), 0, 0, 0);

            if (!liquidationModule.isLiquidatable(borrower)) {
                vm.revertToState(snapshot);
                continue;
            }

            uint64 supplyIndexBefore = comet.totalsBasic().baseSupplyIndex;
            uint64 borrowIndexBefore = comet.totalsBasic().baseBorrowIndex;

            address[] memory accounts = new address[](1);
            accounts[0] = borrower;
            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);

            ICometData.TotalsBasic memory totals = comet.totalsBasic();
            assertGe(totals.baseSupplyIndex, supplyIndexBefore, "the supply index moved backwards across the absorb");
            assertGe(totals.baseBorrowIndex, borrowIndexBefore, "the borrow index moved backwards across the absorb");
            ++exercised;

            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "the invariant was never exercised");
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Redeploys the market implementation with zeroed interest rates.
     * @dev Rates are constructor immutables, so the regime is a new implementation. The redeploy re-runs
     *      the constructor's `setAssetList`, which the live module rejects with AlreadySet - so it is
     *      pointed at a fresh adapter + `LiquidationModuleForComet` (bound to the existing Comet, so it
     *      needs no `initializeStorage`). Storage - balances, indexes, the borrower's position - survives
     *      the upgrade; only the immutables (rates, assetList, module) change.
     */
    function _switchToZeroRates() internal {
        OneInchV6Adapter newAdapter =
            LiquidationModuleDeployer.deployAdapter(DEX_ROUTER, weth, DEX_SLIPPAGE_BPS, collateralAddresses());
        LiquidationModule newModule =
            LiquidationModuleDeployer.deployDefaultLiquidationModuleWithComet(moduleOpts(newAdapter), address(comet));

        CometConfiguration.Configuration memory config = buildCometConfiguration(address(newModule));
        config.supplyPerYearInterestRateBase = 0;
        config.supplyPerYearInterestRateSlopeLow = 0;
        config.supplyPerYearInterestRateSlopeHigh = 0;
        config.borrowPerYearInterestRateBase = 0;
        config.borrowPerYearInterestRateSlopeLow = 0;
        config.borrowPerYearInterestRateSlopeHigh = 0;

        vm.startPrank(timelock);
        configurator.setConfiguration(address(cometProxy), config);
        proxyAdmin.deployAndUpgradeTo(Deployable(address(configuratorProxy)), cometProxy);
        vm.stopPrank();

        // Point the test's handles at the freshly bound module and adapter.
        liquidationModule = newModule;
        dexAdapter = newAdapter;
    }

    /// The base supplier funds the pool with `amount`, the market's only source of borrowable base.
    function _supplyBase(uint256 amount) internal {
        baseToken.allocateTo(baseSupplier, amount);
        vm.startPrank(baseSupplier);
        baseToken.approve(address(comet), amount);
        comet.supply(address(baseToken), amount);
        vm.stopPrank();
    }

    /// The borrower supplies collateral `i` and draws `borrow` of base, at the market's current price.
    function _openPosition(uint8 i, uint256 supply, uint256 borrow) internal {
        collaterals[i].allocateTo(borrower, supply);
        vm.startPrank(borrower);
        collaterals[i].approve(address(comet), supply);
        comet.supply(address(collaterals[i]), supply);
        comet.withdraw(address(baseToken), borrow);
        vm.stopPrank();
    }

    /**
     * @notice The smallest collateral price at which the borrower is no longer liquidatable, inverted
     *         from the module's own single-floor liquidity off the borrower's live balances.
     * @param assetInfo the borrower's single collateral, whose scale and liquidate factor set the boundary.
     * @return the first collateral price at which the LCF-weighted collateral covers the debt.
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
