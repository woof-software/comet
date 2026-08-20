// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { CometInterface } from "@comet-contracts/CometInterface.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";

import { ProtocolFixture, FaucetToken } from "../../helpers/ProtocolFixture.sol";
import { LiquidationMath } from "../../helpers/LiquidationMath.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Account state after liquidation
 * @notice What the absorb leaves behind: whether the debt is healthy again, and whether a shortfall
 *         reached reserves only when it had to. Health and value are read from balances and price
 *         feeds, never from the module, so the code is not compared against itself.
 *
 *         Each test builds its own position end to end. The repetition is deliberate: a position is
 *         the thing under test, and a shared builder hides the very bounds a reader has to check.
 */
contract AccountStateFuzzTest is ProtocolFixture {
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

    /// @notice After the absorb the account either owes nothing, or its debt is healthy again. There is
    ///         no state in between: a leftover debt still under target means the seizure stopped short.
    function testFuzz_healthAfterLiquidation(
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
            // Clear of the minimum: at or under it the plan closes the debt outright and there is no
            // partial seizure to say anything about.
            if (maxBorrow < comet.baseBorrowMin() * 4) continue;

            uint256 borrow = bound(borrowSeed, comet.baseBorrowMin() * 2, maxBorrow);

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
            assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

            address[] memory accounts = new address[](1);
            accounts[0] = borrower;
            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);

            uint256 debt = comet.borrowBalanceOf(borrower);
            uint256 health = comet.healthFactor(borrower);

            assertTrue(debt == 0 || health >= TARGET_HF, "debt remains and health is below target");
            ++exercised;

            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "no position was liquidatable, the property was never exercised");
    }

    /// @notice A shortfall goes to reserves only once the account holds nothing that counts towards a
    ///         borrow. Writing one off while collateral remains hands the loss to the protocol and
    ///         leaves the borrower the rest.
    function testFuzz_badDebtOnlyAtZeroCollateralization(
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
            if (maxBorrow < comet.baseBorrowMin()) continue;

            uint256 borrow = bound(borrowSeed, comet.baseBorrowMin(), maxBorrow);

            // Below the liquidation-factor boundary even seizing every unit falls short, which is the
            // only state a write-off is meant for.
            uint256 badDebtAt = borrow * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
            badDebtAt = badDebtAt * FACTOR_SCALE / info.liquidationFactor * scale / supply;
            if (badDebtAt < 100) continue;

            builtSupply = supply;
            builtBorrow = borrow;
            builtPrice = bound(priceSeed, 1, badDebtAt * 99 / 100);

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

            uint256 debtValueBefore = comet.borrowBalanceOf(borrower)
                * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();

            address[] memory accounts = new address[](1);
            accounts[0] = borrower;
            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);

            // What the seizure actually paid down, at the discount the protocol takes collateral at.
            uint256 paid = (supply - comet.collateralBalanceOf(borrower, info.asset)) * builtPrice
                * info.liquidationFactor / (uint256(info.scale) * FACTOR_SCALE);

            // A debt cleared for less than it was worth is a debt partly written off. Where the
            // seizure covered it there is nothing to write off and the property has no claim.
            if (comet.borrowBalanceOf(borrower) != 0 || paid >= debtValueBefore) {
                vm.revertToState(snapshot);
                continue;
            }

            uint256 collateralization = comet.weightedCollateral(borrower);

            assertEq(collateralization, 0, "a debt was written off while the account still had collateralization");
            ++exercised;

            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "nothing was written off, the property was never exercised");
    }

    /**
     * @notice When the collateral is worth more than the debt at the liquidation factor, the absorb
     *         closes the debt with collateral and leaves reserves alone. Seizing everything and
     *         writing off a remainder here would hand a loss to the protocol that the position covers.
     */
    function testFuzz_coveredDebtClosesWithoutWriteOff(uint256 supplySeed, uint256 priceSeed) public {
        uint256 exercised;
        uint256 minDebt = comet.baseBorrowMin();

        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            uint256 scale = info.scale;
            uint256 supply = bound(supplySeed, scale / 1000, Math.min(1_000_000 * scale, info.supplyCap));

            uint256 maxBorrow = supply * comet.getPrice(info.priceFeed) / scale;
            maxBorrow = maxBorrow * info.borrowCollateralFactor / FACTOR_SCALE;
            maxBorrow = maxBorrow * comet.baseScale() / comet.getPrice(comet.baseTokenPriceFeed());
            if (maxBorrow < minDebt) continue;

            uint256 boundary = minDebt * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
            boundary = boundary * FACTOR_SCALE / info.liquidationFactor * scale / supply;
            uint256 liquidatableAt = minDebt * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();
            liquidatableAt = liquidatableAt * FACTOR_SCALE / info.liquidateCollateralFactor * scale / supply;
            if (boundary * 101 / 100 >= liquidatableAt * 99 / 100) continue;

            builtSupply = supply;
            builtBorrow = minDebt;
            builtPrice = bound(priceSeed, boundary * 101 / 100, liquidatableAt * 99 / 100);

            uint256 snapshot = vm.snapshotState();

            FaucetToken collateral = collaterals[i];
            collateral.allocateTo(borrower, supply);
            vm.startPrank(borrower);
            collateral.approve(address(comet), supply);
            comet.supply(address(collateral), supply);
            comet.withdraw(address(baseToken), minDebt);
            vm.stopPrank();

            collateralPriceFeeds[i].setRoundData(0, int256(builtPrice), 0, 0, 0);
            if (!liquidationModule.isLiquidatable(borrower)) {
                vm.revertToState(snapshot);
                continue;
            }

            address[] memory accounts = new address[](1);
            accounts[0] = borrower;
            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);

            uint256 left = comet.collateralBalanceOf(borrower, info.asset);
            uint256 debt = comet.borrowBalanceOf(borrower);

            assertEq(debt, 0, "a debt the collateral covers survived the absorb");
            assertGt(left, 0, "the whole balance was taken for a debt it more than covers");
            ++exercised;

            vm.revertToState(snapshot);
        }
        assertGt(exercised, 0, "no covered position was built, the property was never exercised");
    }
}
