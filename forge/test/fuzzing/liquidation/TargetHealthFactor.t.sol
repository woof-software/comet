// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { CometInterface } from "@comet-contracts/CometInterface.sol";
import { CometMainInterface } from "@comet-contracts/CometMainInterface.sol";
import { Deployable } from "@comet-contracts/CometProxyAdmin.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";

import { ProtocolFixture, FaucetToken } from "../../helpers/ProtocolFixture.sol";
import { LiquidationMath } from "../../helpers/LiquidationMath.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Configured target health factor
 */
contract TargetHealthFactorFuzzTest is ProtocolFixture {
    using LiquidationMath for CometInterface;

    address internal borrower = alice;
    address internal liquidator = bob;
    address internal baseSupplier = charlie;

    /// Base liquidity, comfortably above the largest borrow the bounds below allow.
    uint256 internal constant BASE_LIQUIDITY = 1e18;
    /// The lowest target the Comet constructor accepts.
    uint256 internal constant MIN_TARGET_HF = 1e18;
    /// Well past any practical target: from here on nearly every seizure is capped at the whole debt.
    uint256 internal constant MAX_TESTED_TARGET_HF = 3e18;

    function setUp() public {
        prepareFixture();

        baseToken.allocateTo(baseSupplier, BASE_LIQUIDITY);
        vm.startPrank(baseSupplier);
        baseToken.approve(address(comet), type(uint256).max);
        comet.supply(address(baseToken), BASE_LIQUIDITY);
        vm.stopPrank();
    }

    /// @notice Sets the target in the market's configuration and deploys a new implementation from it.
    function _setTargetHealthFactor(uint256 target) internal {
        vm.startPrank(timelock);
        configurator.setTargetHealthFactor(address(cometProxy), uint64(target));
        proxyAdmin.deployAndUpgradeTo(Deployable(address(configuratorProxy)), cometProxy);
        vm.stopPrank();
    }

    function _boundSupplyAndMaxBorrow(ICometData.AssetInfo memory info, uint256 supplySeed)
        internal view
        returns (uint256 supply, uint256 maxBorrow)
    {
        uint256 scale = info.scale;
        supply = bound(supplySeed, scale / 1000, Math.min(1_000_000 * scale, info.supplyCap));

        maxBorrow = supply * comet.getPrice(info.priceFeed) / scale;
        maxBorrow = maxBorrow * info.borrowCollateralFactor / FACTOR_SCALE;
        maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(comet.baseTokenPriceFeed());
    }

    function _supplyAndBorrow(uint8 index, uint256 supply, uint256 borrow) internal {
        FaucetToken collateral = collaterals[index];
        collateral.allocateTo(borrower, supply);

        vm.startPrank(borrower);
        collateral.approve(address(comet), supply);
        comet.supply(address(collateral), supply);
        comet.withdraw(address(baseToken), borrow);
        vm.stopPrank();
    }

    function _absorbBorrower() internal {
        address[] memory accounts = new address[](1);
        accounts[0] = borrower;
        vm.prank(liquidator);
        comet.absorb(liquidator, accounts);
    }

    /*//////////////////////////////////////////////////////////////
                    A. THE MINIMUM TARGET IS ENFORCED
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice A target below 1.0 would leave the account liquidatable right after it was liquidated.
     *         The Configurator stores whatever it is given, so the guard is the deploy: no
     *         implementation can be built from such a configuration.
     */
    function testFuzz_targetBelowMinimumIsRejected(uint256 targetSeed) public {
        uint256 target = bound(targetSeed, 0, MIN_TARGET_HF - 1);

        vm.startPrank(timelock);
        configurator.setTargetHealthFactor(address(cometProxy), uint64(target));

        vm.expectRevert(CometMainInterface.BadHealthFactor.selector);
        proxyAdmin.deployAndUpgradeTo(Deployable(address(configuratorProxy)), cometProxy);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
               B. THE ACCOUNT REACHES THE CONFIGURED TARGET
    //////////////////////////////////////////////////////////////*/

    /// @notice After the absorb the account either owes nothing, or its health is at least the target
    ///         the market is configured with — whatever that target is.
    function testFuzz_healthReachesConfiguredTarget(
        uint256 targetSeed,
        uint256 supplySeed,
        uint256 borrowSeed,
        uint256 priceSeed
    ) public {
        uint256 target = bound(targetSeed, MIN_TARGET_HF, MAX_TESTED_TARGET_HF);
        _setTargetHealthFactor(target);

        uint256 exercised;

        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            uint256 scale = info.scale;
            (uint256 supply, uint256 maxBorrow) = _boundSupplyAndMaxBorrow(info, supplySeed);
            // Clear of the minimum: at or under it the debt is closed outright and there is no
            // partial seizure to say anything about.
            if (maxBorrow < comet.baseBorrowMin() * 4) continue;

            uint256 borrow = bound(borrowSeed, comet.baseBorrowMin() * 2, maxBorrow);

            uint256 boundary = borrow * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
            boundary = boundary * FACTOR_SCALE / info.liquidationFactor * scale / supply;
            uint256 liquidatableAt = borrow * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
            liquidatableAt = liquidatableAt * FACTOR_SCALE / info.liquidateCollateralFactor * scale / supply;
            if (boundary * 101 / 100 >= liquidatableAt * 99 / 100) continue;

            uint256 collateralPrice = bound(priceSeed, boundary * 101 / 100, liquidatableAt * 99 / 100);

            uint256 snapshot = vm.snapshotState();

            _supplyAndBorrow(i, supply, borrow);

            collateralPriceFeeds[i].setRoundData(0, int256(collateralPrice), 0, 0, 0);
            assertTrue(comet.isLiquidatable(borrower), "the position built is not liquidatable");

            _absorbBorrower();

            uint256 debt = comet.borrowBalanceOf(borrower);
            uint256 health = comet.healthFactor(borrower);

            assertTrue(debt == 0 || health >= target, "debt remains and health is below the configured target");
            ++exercised;

            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "no position was liquidatable, the property was never exercised");
    }

    /*//////////////////////////////////////////////////////////////
           C. THE SEIZURE DOES NOT RUN PAST THE CONFIGURED TARGET
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Reaching the target is only half of it: a market that solved against a deeper target than
     *         the configured one would pass B and still take collateral it had no claim to. This bounds
     *         the overshoot past the configured target at one collateral unit, the smallest step a
     *         seizure can be made in.
     *
     * @dev Same measurement as the default-target suite: the requirement is the solved value S for the
     *      configured target, the measurement is the collateralization that actually left, and the
     *      budget is one weighted unit plus two value units for the two ceilings on the way.
     */
    function testFuzz_overshootPastConfiguredTargetIsBounded(
        uint256 targetSeed,
        uint256 supplySeed,
        uint256 borrowSeed,
        uint256 priceSeed
    ) public {
        uint256 target = bound(targetSeed, MIN_TARGET_HF, MAX_TESTED_TARGET_HF);
        _setTargetHealthFactor(target);

        uint256 exercised;

        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            uint256 scale = info.scale;
            (uint256 supply, uint256 maxBorrow) = _boundSupplyAndMaxBorrow(info, supplySeed);
            // Well clear of the minimum. Near it the seizure that reaches target would drop the debt
            // under the floor, and the debt is closed outright instead — a different branch.
            if (maxBorrow < comet.baseBorrowMin() * 40) continue;

            uint256 borrow = bound(borrowSeed, comet.baseBorrowMin() * 20, maxBorrow);

            uint256 boundary = borrow * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
            boundary = boundary * FACTOR_SCALE / info.liquidationFactor * scale / supply;
            uint256 liquidatableAt = borrow * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
            liquidatableAt = liquidatableAt * FACTOR_SCALE / info.liquidateCollateralFactor * scale / supply;
            if (boundary * 101 / 100 >= liquidatableAt * 99 / 100) continue;

            uint256 collateralPrice = bound(priceSeed, boundary * 101 / 100, liquidatableAt * 99 / 100);

            uint256 snapshot = vm.snapshotState();

            _supplyAndBorrow(i, supply, borrow);

            collateralPriceFeeds[i].setRoundData(0, int256(collateralPrice), 0, 0, 0);
            if (!comet.isLiquidatable(borrower)) {
                vm.revertToState(snapshot);
                continue;
            }

            uint256 collateralizationBefore = comet.weightedCollateral(borrower) / FACTOR_SCALE;
            uint256 debtValue = comet.borrowBalanceOf(borrower)
                * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();

            _absorbBorrower();

            // Nothing was left to reach a target for; the debt was closed outright.
            if (comet.borrowBalanceOf(borrower) == 0) {
                vm.revertToState(snapshot);
                continue;
            }

            // The collateralization the configured target required be removed, solved in one division.
            uint256 required = Math.ceilDiv(
                (debtValue * target - collateralizationBefore * FACTOR_SCALE) * FACTOR_SCALE,
                uint256(info.liquidationFactor) * target - uint256(info.liquidateCollateralFactor) * FACTOR_SCALE
            ) * info.liquidateCollateralFactor / FACTOR_SCALE;

            uint256 removed = collateralizationBefore - comet.weightedCollateral(borrower) / FACTOR_SCALE;
            uint256 oneUnit = collateralPrice * info.liquidateCollateralFactor / (uint256(info.scale) * FACTOR_SCALE) + 2;
            uint256 overshoot = removed > required ? removed - required : 0;

            assertLe(overshoot, oneUnit, "the seizure removed more than one unit past the configured target");
            ++exercised;

            vm.revertToState(snapshot);
        }
        // Some draws reach the partial branch on no asset at all; discarded rather than failed.
        vm.assume(exercised > 0);
    }

    /*//////////////////////////////////////////////////////////////
                  D. A HIGHER TARGET NEVER TAKES LESS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice The same position, liquidated under two targets: the higher one seizes at least as much.
     *
     * @dev The solved seizure S = (T·D − C) / (T·LF − LCF) grows with T exactly when it is below the cap
     *      D / LF, and above the cap it is the cap whatever T is. Every rounding step is a ceiling, and the
     *      min-debt switch only ever takes more, so the order survives all of them.
     */
    function testFuzz_higherTargetSeizesNoLess(
        uint256 assetSeed,
        uint256 lowSeed,
        uint256 highSeed,
        uint256 supplySeed,
        uint256 borrowSeed,
        uint256 priceSeed
    ) public {
        uint256 low = bound(lowSeed, MIN_TARGET_HF, MAX_TESTED_TARGET_HF);
        uint256 high = bound(highSeed, low, MAX_TESTED_TARGET_HF);

        uint8 i = uint8(bound(assetSeed, 0, comet.numAssets() - 1));
        ICometData.AssetInfo memory info = comet.getAssetInfo(i);
        (uint256 supply, uint256 maxBorrow) = _boundSupplyAndMaxBorrow(info, supplySeed);
        vm.assume(maxBorrow >= comet.baseBorrowMin() * 4);

        uint256 borrow = bound(borrowSeed, comet.baseBorrowMin() * 2, maxBorrow);

        uint256 boundary = borrow * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
        boundary = boundary * FACTOR_SCALE / info.liquidationFactor * info.scale / supply;
        uint256 liquidatableAt = borrow * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
        liquidatableAt = liquidatableAt * FACTOR_SCALE / info.liquidateCollateralFactor * info.scale / supply;
        vm.assume(boundary * 101 / 100 < liquidatableAt * 99 / 100);

        uint256 collateralPrice = bound(priceSeed, boundary * 101 / 100, liquidatableAt * 99 / 100);

        uint256 snapshot = vm.snapshotState();
        uint256 seizedUnderLow = _seizedUnderTarget(low, i, supply, borrow, collateralPrice);
        vm.revertToState(snapshot);
        uint256 seizedUnderHigh = _seizedUnderTarget(high, i, supply, borrow, collateralPrice);

        assertGe(seizedUnderHigh, seizedUnderLow, "a higher target seized less of the same position");
    }

    /// @notice Configures `target`, opens the position, prices it into the liquidation window and
    ///         absorbs it. Returns how much of the collateral the absorb took.
    function _seizedUnderTarget(uint256 target, uint8 index, uint256 supply, uint256 borrow, uint256 collateralPrice)
        internal
        returns (uint256)
    {
        _setTargetHealthFactor(target);
        _supplyAndBorrow(index, supply, borrow);
        collateralPriceFeeds[index].setRoundData(0, int256(collateralPrice), 0, 0, 0);
        assertTrue(comet.isLiquidatable(borrower), "the position built is not liquidatable");

        _absorbBorrower();

        return supply - comet.collateralBalanceOf(borrower, address(collaterals[index]));
    }
}
