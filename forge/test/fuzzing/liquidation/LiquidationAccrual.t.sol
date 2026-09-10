// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { CometConfiguration } from "@comet-contracts/CometConfiguration.sol";
import { Deployable } from "@comet-contracts/CometProxyAdmin.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModule } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModule.sol";
import { LiquidationModule } from "@comet-contracts/liquidation-module/LiquidationModule.sol";
import { OneInchV6Adapter } from "@comet-contracts/dex-adapters/core/OneInchV6Adapter.sol";

import { LiquidationModuleDeployer } from "../../helpers/LiquidationModuleDeployer.sol";
import { LiquidationFuzzBase } from "./LiquidationFuzzBase.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Accrual and time
 * @notice That a liquidation accrues interest, reads the accrued debt, and never walks an index back.
 * @dev The one group with non-zero rates, and the only one that moves the clock. Each test sizes the
 *      base pool itself, so it does not take the fixture's seeded market: utilization is what places
 *      the rate, and a pre-filled pool would pin it near zero.
 */
contract LiquidationAccrualFuzzTest is LiquidationFuzzBase {
    function setUp() public {
        prepareFixture();
    }

    /// @dev Reward tracking off: with a small pool and a long elapsed its per-unit index overflows a
    ///      uint64, which has nothing to do with interest accrual. Rates stay as the fixture ships them.
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

    /// @notice Accrual always happens - lastAccrualTime = block.timestamp
    /// @dev No conditional "too little time" skip may leave the clock behind, so zero and one second
    ///      are drawn on purpose alongside the longer intervals.
    /// @param elapsedSeed how long passes before the call; 0 and 1 second are guaranteed to occur.
    /// @param utilizationSeed where to put utilization, spanning the rate kink.
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

            // Utilization is placed by sizing the pool rather than by a second borrower: supply caps
            // hold one account's borrow far below the pool, so it could never reach the kink.
            _supplyBase(borrow * 10_000 / targetUtilBps);
            _openPosition(i, supply, borrow);

            // Taken before the warp: the gate reads the stored debt, so the fall has to be measured
            // against that same figure.
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

            _absorb();

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

    /// @notice Liquidation looks at the current debt - plan == plan after accrueAccount
    /// @dev No price moves here: the position has to go underwater on interest alone, and an explicit
    ///      accrual afterwards must change nothing.
    function testFuzz_liquidationUsesCurrentDebt(
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 elapsedSeed
    ) public {
        uint256 exercised;

        // At the fixture's rate (~0.65/yr at full utilization) interest needs months to carry a debt
        // over the liquidate line, so the interval starts at half a year rather than at an hour.
        uint256 elapsed = bound(elapsedSeed, 180 days, 365 days);
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

            // Near the top of the capacity, so interest alone can carry it over the line. Clamped to
            // the minimum: 95% of a maxBorrow that barely clears it would fall under and be rejected.
            uint256 borrow = bound(borrowAmount, Math.max(maxBorrow * 95 / 100, BASE_BORROW_MIN), maxBorrow);

            uint256 snapshot = vm.snapshotState();

            // Near-full utilization for the fastest accrual the rate model allows.
            _supplyBase(borrow * 100 / 99);
            _openPosition(i, supply, borrow);

            vm.warp(block.timestamp + elapsed);

            // The views read the stored index, so interest stays invisible to them until it is
            // written back. Accrued in here so the account is seen as the interest left it.
            comet.accrueAccount(borrower);

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

    /// @notice Indexes never decrease - index after >= index before
    /// @dev An index moving backwards would mean accrued interest disappeared. Both regimes have to
    ///      satisfy it: with zero rates the indexes stay put, with the default they grow.
    /// @param rateKind 0 zero rates via a redeploy, 1 the non-zero default.
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

            _supplyBase(borrow * 2);
            _openPosition(i, supply, borrow);

            // Taken before the warp: the gate reads the stored debt either way.
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

            _absorb();

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

    /// @notice Redeploys the market implementation with zeroed interest rates.
    /// @dev Rates are constructor immutables, so changing them means a new implementation - and the
    ///      constructor re-runs `setAssetList`, which the live module rejects, so it needs a fresh
    ///      module too. Storage survives the upgrade; only the immutables change.
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

        liquidationModule = newModule;
        dexAdapter = newAdapter;
    }

    /// @notice Funds the pool. Sized per test, because utilization is what places the rate.
    function _supplyBase(uint256 amount) internal {
        baseToken.allocateTo(baseSupplier, amount);
        vm.startPrank(baseSupplier);
        baseToken.approve(address(comet), amount);
        comet.supply(address(baseToken), amount);
        vm.stopPrank();
    }

    function _openPosition(uint8 i, uint256 supply, uint256 borrow) internal {
        collaterals[i].allocateTo(borrower, supply);
        vm.startPrank(borrower);
        collaterals[i].approve(address(comet), supply);
        comet.supply(address(collaterals[i]), supply);
        comet.withdraw(address(baseToken), borrow);
        vm.stopPrank();
    }

    /// @notice The smallest collateral price at which the borrower is no longer liquidatable.
    /// @dev Assumes a single supplied collateral, which every position here has.
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
