// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { Vm } from "forge-std/Vm.sol";

import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModule } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModule.sol";

import { ProtocolFixture } from "../../helpers/ProtocolFixture.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Protocol accounting
 * @notice One invariant per test: a single statement a counterexample can refute.
 * @dev This group asks what a seizure does to Comet's books, and what it must leave alone. The
 *      collateral set is picked by a bit mask rather than enumerated, because a delta has to be
 *      read across several assets at once - a mistake in the traversal loop shows up as one asset
 *      being counted twice or skipped, and a single-asset position cannot see that.
 *
 *      The deposits come from a single seed: asset `i` takes the hash of the seed and its own index,
 *      so one argument settles the whole set while every asset keeps bounds cut to its own scale and
 *      supply cap. The fall in price is one multiplier applied to every selected asset, which scales
 *      the account's liquidity by exactly the same amount and makes the liquidatable threshold one
 *      comparison for the whole set instead of a percentage picked by hand.
 *
 *      Each figure is floored the way the code that consumes it floors it - twice for the borrow
 *      ceiling, which Comet checks in two steps, once for liquidity, which the module weighs in a
 *      single division. Getting either wrong moves a bound off the real threshold. A run that cannot
 *      be built is rejected rather than passed, so a vacuous run is never counted as checked.
 *
 *      Nothing here advances the clock, so no interest accrues between a reading and the call that
 *      follows it and every delta below is exact rather than approximate. A test in this group that
 *      needs to warp time would have to switch the market's rates off first.
 */
contract ProtocolAccountingFuzzTest is ProtocolFixture {
    address internal borrower = alice;
    address internal liquidator = bob;
    address internal baseSupplier = charlie;
    /// Holds collateral alongside the borrower so a total can exceed one account's balance.
    address internal coSupplier = makeAddr("coSupplier");
    /// Carries a debt of its own so a market total is never one account's figure.
    address internal otherBorrower = makeAddr("otherBorrower");

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
     * @notice The asset total falls by the seized amount - totalSupplyAsset after = before - seized
     * @dev Invariant. The tracked supply of an asset decreases by exactly what was taken from the
     *      borrower - no more, no less.
     */
    function testFuzz_assetTotalFallsBySeizedAmount(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 assetMask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);

        uint256[] memory amounts = new uint256[](numAssets);
        uint256 borrow;
        uint256 dropBps;
        {
            uint256 borrowLimit;
            uint256 liquidity;
            ICometData.AssetInfo memory assetInfo;

            for (uint8 i; i < numAssets; ++i) {
                if (assetMask & (uint256(1) << i) == 0) continue;
                assetInfo = comet.getAssetInfo(i);

                amounts[i] = bound(
                    uint256(keccak256(abi.encode(supplySeed, i))),
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                // Comet floors twice when it decides whether a borrow is collateralized, so the
                // borrow ceiling is floored the same way and stays acceptable to it.
                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;

                // The module weighs liquidity in a single division. Flooring twice here would put
                // this figure below the module's, which would push the drop ceiling above the price
                // at which the account really turns liquidatable.
                liquidity += amounts[i] * comet.getPrice(assetInfo.priceFeed) * assetInfo.liquidateCollateralFactor
                    / (uint256(assetInfo.scale) * FACTOR_SCALE);
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            vm.assume(maxBorrow >= comet.baseBorrowMin()); // the set is too cheap to open a borrow at all
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            uint256 maxDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            maxDrop = maxDrop * 10_000 / liquidity;
            vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

            dropBps = bound(dropSeed, 1, maxDrop * 99 / 100);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            collaterals[i].allocateTo(borrower, amounts[i]);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), amounts[i]);
            comet.supply(address(collaterals[i]), amounts[i]);
            vm.stopPrank();
        }

        // On half the draws a second account holds the same assets, so the market's total sits above
        // the borrower's balance. Against a total that equals the balance, a bug that zeroes the
        // whole total and one that subtracts the right amount are the same arithmetic.
        if (supplySeed % 2 == 1) {
            for (uint8 i; i < numAssets; ++i) {
                if (assetMask & (uint256(1) << i) == 0) continue;

                // Whatever the supply cap still has room for, never more than the borrower put in.
                uint256 room = comet.getAssetInfo(i).supplyCap - amounts[i];
                uint256 alongside = Math.min(amounts[i], room);
                if (alongside == 0) continue;

                collaterals[i].allocateTo(coSupplier, alongside);

                vm.startPrank(coSupplier);
                collaterals[i].approve(address(comet), alongside);
                comet.supply(address(collaterals[i]), alongside);
                vm.stopPrank();
            }
        }

        vm.prank(borrower);
        comet.withdraw(address(baseToken), borrow);

        if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
            vm.prank(pauser);
            liquidationModule.liquidationModeToggle(partialEnabled);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        ICoreLiquidationModule.Seizure[] memory plan = liquidationModule.seizurePlan(borrower);

        // Comet exposes `totalsCollateral` as its storage getter, so the struct arrives flattened.
        uint256[] memory totalsBefore = new uint256[](plan.length);
        for (uint256 j; j < plan.length; ++j) {
            (totalsBefore[j],) = comet.totalsCollateral(plan[j].asset);
        }

        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        for (uint256 j; j < plan.length; ++j) {
            (uint256 totalAfter,) = comet.totalsCollateral(plan[j].asset);

            assertEq(
                totalAfter,
                totalsBefore[j] - plan[j].seizedAmount,
                "the asset total did not fall by exactly the seized amount"
            );
        }
    }

    /**
     * @notice Reserves grow by the seized amount - reserves after = before + seizedAmount
     * @dev Invariant. Everything seized becomes a protocol reserve - nothing is lost on the way and
     *      nothing extra appears.
     *
     *      Comet reports an asset's reserves as its own token balance less the supply it is holding
     *      for accounts. The protocol route moves no tokens at all: it writes the seizure down
     *      against the account and against the total, and the same balance is suddenly backing less
     *      supply. That is the whole of the increase, which is why it must land unit for unit.
     *
     *      Because reserves are worked out from those two figures rather than stored, this cannot
     *      fail while the asset total and the token balance both hold - it is the same write read a
     *      third way. It is kept as the statement in the terms the protocol reports to the outside,
     *      and it is the reading that would break first if reserves ever became a stored figure.
     */
    function testFuzz_reservesGrowBySeizedAmount(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 assetMask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);

        uint256[] memory amounts = new uint256[](numAssets);
        uint256 borrow;
        uint256 dropBps;
        {
            uint256 borrowLimit;
            uint256 liquidity;
            ICometData.AssetInfo memory assetInfo;

            for (uint8 i; i < numAssets; ++i) {
                if (assetMask & (uint256(1) << i) == 0) continue;
                assetInfo = comet.getAssetInfo(i);

                amounts[i] = bound(
                    uint256(keccak256(abi.encode(supplySeed, i))),
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                // Comet floors twice when it decides whether a borrow is collateralized, so the
                // borrow ceiling is floored the same way and stays acceptable to it.
                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;

                // The module weighs liquidity in a single division. Flooring twice here would put
                // this figure below the module's, which would push the drop ceiling above the price
                // at which the account really turns liquidatable.
                liquidity += amounts[i] * comet.getPrice(assetInfo.priceFeed) * assetInfo.liquidateCollateralFactor
                    / (uint256(assetInfo.scale) * FACTOR_SCALE);
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            vm.assume(maxBorrow >= comet.baseBorrowMin()); // the set is too cheap to open a borrow at all
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            uint256 maxDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            maxDrop = maxDrop * 10_000 / liquidity;
            vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

            dropBps = bound(dropSeed, 1, maxDrop * 99 / 100);
        }

        // On half the draws the reserves do not start at zero. Tokens sent straight to the market
        // are backing no account's supply, so they read as reserves immediately - and a seizure that
        // assigned reserves rather than adding to them would pass against a zero and fail here.
        if (supplySeed % 2 == 1) {
            for (uint8 i; i < numAssets; ++i) {
                if (assetMask & (uint256(1) << i) == 0) continue;

                collaterals[i].allocateTo(
                    address(comet),
                    bound(
                        uint256(keccak256(abi.encode(supplySeed, "reserves", i))),
                        1,
                        uint256(comet.getAssetInfo(i).scale)
                    )
                );
            }
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            collaterals[i].allocateTo(borrower, amounts[i]);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), amounts[i]);
            comet.supply(address(collaterals[i]), amounts[i]);
            vm.stopPrank();
        }

        vm.prank(borrower);
        comet.withdraw(address(baseToken), borrow);

        if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
            vm.prank(pauser);
            liquidationModule.liquidationModeToggle(partialEnabled);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        ICoreLiquidationModule.Seizure[] memory plan = liquidationModule.seizurePlan(borrower);

        uint256[] memory reservesBefore = new uint256[](plan.length);
        for (uint256 j; j < plan.length; ++j) {
            reservesBefore[j] = comet.getCollateralReserves(plan[j].asset);
        }

        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        for (uint256 j; j < plan.length; ++j) {
            assertEq(
                comet.getCollateralReserves(plan[j].asset),
                reservesBefore[j] + plan[j].seizedAmount,
                "the reserves did not grow by exactly the seized amount"
            );
        }
    }

    /**
     * @notice Collateral tokens do not move - comet token balance unchanged
     * @dev Invariant. On the default route a seizure is an accounting move, not a token transfer:
     *      not a single unit of collateral leaves Comet or arrives into it.
     *
     *      The balance is read for every asset on the market, not only the ones the plan names. A
     *      transfer of the wrong asset is exactly the kind of mistake that a plan-shaped check would
     *      step over, and the seized asset would still balance.
     */
    function testFuzz_collateralTokensDoNotMove(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 assetMask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);

        uint256[] memory amounts = new uint256[](numAssets);
        uint256 borrow;
        uint256 dropBps;
        {
            uint256 borrowLimit;
            uint256 liquidity;
            ICometData.AssetInfo memory assetInfo;

            for (uint8 i; i < numAssets; ++i) {
                if (assetMask & (uint256(1) << i) == 0) continue;
                assetInfo = comet.getAssetInfo(i);

                amounts[i] = bound(
                    uint256(keccak256(abi.encode(supplySeed, i))),
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                // Comet floors twice when it decides whether a borrow is collateralized, so the
                // borrow ceiling is floored the same way and stays acceptable to it.
                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;

                // The module weighs liquidity in a single division. Flooring twice here would put
                // this figure below the module's, which would push the drop ceiling above the price
                // at which the account really turns liquidatable.
                liquidity += amounts[i] * comet.getPrice(assetInfo.priceFeed) * assetInfo.liquidateCollateralFactor
                    / (uint256(assetInfo.scale) * FACTOR_SCALE);
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            vm.assume(maxBorrow >= comet.baseBorrowMin()); // the set is too cheap to open a borrow at all
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            uint256 maxDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            maxDrop = maxDrop * 10_000 / liquidity;
            vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

            dropBps = bound(dropSeed, 1, maxDrop * 99 / 100);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            collaterals[i].allocateTo(borrower, amounts[i]);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), amounts[i]);
            comet.supply(address(collaterals[i]), amounts[i]);
            vm.stopPrank();
        }

        vm.prank(borrower);
        comet.withdraw(address(baseToken), borrow);

        if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
            vm.prank(pauser);
            liquidationModule.liquidationModeToggle(partialEnabled);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        uint256[] memory balancesBefore = new uint256[](numAssets);
        for (uint8 i; i < numAssets; ++i) {
            balancesBefore[i] = collaterals[i].balanceOf(address(comet));
        }

        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        for (uint8 i; i < numAssets; ++i) {
            assertEq(
                collaterals[i].balanceOf(address(comet)),
                balancesBefore[i],
                "collateral tokens moved across the absorb"
            );
        }
    }

    /**
     * @notice Total borrow falls by the principal delta - totalBorrow after = before - deltaPrincipal
     * @dev Invariant. The reduction of the borrower's debt is reflected exactly in the market's total
     *      debt, with no divergence from index rounding.
     *
     *      Both figures are read as principal rather than as present value, which costs nothing here
     *      - the index has not moved, so the two coincide - and keeps the comparison exact if this
     *      group ever runs on a market where it has. The second borrower is what gives the test its
     *      teeth: without another debt on the books, a total recomputed from scratch and a total
     *      correctly decremented arrive at the same number.
     */
    function testFuzz_totalBorrowFallsByPrincipalDelta(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 assetMask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);

        uint256[] memory amounts = new uint256[](numAssets);
        uint256 borrow;
        uint256 dropBps;
        {
            uint256 borrowLimit;
            uint256 liquidity;
            ICometData.AssetInfo memory assetInfo;

            for (uint8 i; i < numAssets; ++i) {
                if (assetMask & (uint256(1) << i) == 0) continue;
                assetInfo = comet.getAssetInfo(i);

                amounts[i] = bound(
                    uint256(keccak256(abi.encode(supplySeed, i))),
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                // Comet floors twice when it decides whether a borrow is collateralized, so the
                // borrow ceiling is floored the same way and stays acceptable to it.
                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;

                // The module weighs liquidity in a single division. Flooring twice here would put
                // this figure below the module's, which would push the drop ceiling above the price
                // at which the account really turns liquidatable.
                liquidity += amounts[i] * comet.getPrice(assetInfo.priceFeed) * assetInfo.liquidateCollateralFactor
                    / (uint256(assetInfo.scale) * FACTOR_SCALE);
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            vm.assume(maxBorrow >= comet.baseBorrowMin()); // the set is too cheap to open a borrow at all
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            uint256 maxDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            maxDrop = maxDrop * 10_000 / liquidity;
            vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

            // The whole range: a shallow drop closes part of the debt, a deep one closes all of it,
            // and the deepest writes off what the collateral cannot cover. The total has to follow
            // the account in each case.
            dropBps = bound(dropSeed, 1, maxDrop * 99 / 100);
        }

        // On half the draws someone else owes the market too, on an asset outside the mask so their
        // position is never repriced and never liquidatable. Against a market whose only debt is the
        // borrower's, a total that is recomputed from scratch and one that is decremented correctly
        // come to the same number.
        if (supplySeed % 2 == 1) {
            for (uint8 i; i < numAssets; ++i) {
                if (assetMask & (uint256(1) << i) != 0) continue;

                uint256 stake = Math.min(1_000_000 * uint256(comet.getAssetInfo(i).scale), comet.getAssetInfo(i).supplyCap);
                collaterals[i].allocateTo(otherBorrower, stake);

                vm.startPrank(otherBorrower);
                collaterals[i].approve(address(comet), stake);
                comet.supply(address(collaterals[i]), stake);
                comet.withdraw(address(baseToken), comet.baseBorrowMin());
                vm.stopPrank();
                break;
            }
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            collaterals[i].allocateTo(borrower, amounts[i]);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), amounts[i]);
            comet.supply(address(collaterals[i]), amounts[i]);
            vm.stopPrank();
        }

        vm.prank(borrower);
        comet.withdraw(address(baseToken), borrow);

        if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
            vm.prank(pauser);
            liquidationModule.liquidationModeToggle(partialEnabled);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        // Comet exposes both as storage getters, so the structs arrive flattened.
        uint256 totalBorrowBefore = comet.totalsBasic().totalBorrowBase;
        (int104 principalBefore,,,,) = comet.userBasic(borrower);

        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        uint256 totalBorrowAfter = comet.totalsBasic().totalBorrowBase;
        (int104 principalAfter,,,,) = comet.userBasic(borrower);

        // The debt shrinks, so the principal moves up towards zero. Stated before it is used as an
        // unsigned amount below, where a move the other way would read as an enormous one.
        assertGe(principalAfter, principalBefore, "the borrower's principal moved further into debt");

        assertEq(
            totalBorrowAfter,
            totalBorrowBefore - uint256(int256(principalAfter - principalBefore)),
            "the market total did not follow the account's principal"
        );
    }

    /**
     * @notice Total base supply does not change - totalSupply unchanged
     * @dev Invariant. Liquidating a borrower does not touch base suppliers: their aggregate position
     *      stays exactly as it was.
     *
     *      The absorb writes one base figure and one only, the total borrow. Whatever the borrower
     *      is credited comes out of reserves, never out of what suppliers are owed, so a market with
     *      real liquidity on it must come through the call with that side of the book untouched.
     */
    function testFuzz_totalBaseSupplyDoesNotChange(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 assetMask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);

        uint256[] memory amounts = new uint256[](numAssets);
        uint256 borrow;
        uint256 dropBps;
        {
            uint256 borrowLimit;
            uint256 liquidity;
            ICometData.AssetInfo memory assetInfo;

            for (uint8 i; i < numAssets; ++i) {
                if (assetMask & (uint256(1) << i) == 0) continue;
                assetInfo = comet.getAssetInfo(i);

                amounts[i] = bound(
                    uint256(keccak256(abi.encode(supplySeed, i))),
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                // Comet floors twice when it decides whether a borrow is collateralized, so the
                // borrow ceiling is floored the same way and stays acceptable to it.
                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;

                // The module weighs liquidity in a single division. Flooring twice here would put
                // this figure below the module's, which would push the drop ceiling above the price
                // at which the account really turns liquidatable.
                liquidity += amounts[i] * comet.getPrice(assetInfo.priceFeed) * assetInfo.liquidateCollateralFactor
                    / (uint256(assetInfo.scale) * FACTOR_SCALE);
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            vm.assume(maxBorrow >= comet.baseBorrowMin()); // the set is too cheap to open a borrow at all
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            uint256 maxDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            maxDrop = maxDrop * 10_000 / liquidity;
            vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

            dropBps = bound(dropSeed, 1, maxDrop * 99 / 100);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            collaterals[i].allocateTo(borrower, amounts[i]);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), amounts[i]);
            comet.supply(address(collaterals[i]), amounts[i]);
            vm.stopPrank();
        }

        vm.prank(borrower);
        comet.withdraw(address(baseToken), borrow);

        if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
            vm.prank(pauser);
            liquidationModule.liquidationModeToggle(partialEnabled);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        uint256 totalSupplyBefore = comet.totalSupply();
        uint256 totalSupplyBaseBefore = comet.totalsBasic().totalSupplyBase;

        // A market with nothing supplied would hold this invariant by having nothing to move.
        assertGt(totalSupplyBefore, 0, "the market carries no base supply for the invariant to protect");

        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        assertEq(comet.totalSupply(), totalSupplyBefore, "the base supply moved across the absorb");

        // The same claim one level down. Present value is principal through the supply index, so the
        // two could only part company if a change in the total were offset by a change in the index.
        assertEq(
            comet.totalsBasic().totalSupplyBase,
            totalSupplyBaseBefore,
            "the base supply principal moved across the absorb"
        );
    }

    /**
     * @notice Base tokens do not move - comet base balance unchanged
     * @dev Invariant. Writing down a debt is a bookkeeping operation: the base token is not
     *      transferred into Comet or out of it.
     *
     *      The borrower is credited by moving their principal towards zero, and where the collateral
     *      falls short the shortfall is charged to reserves - which Comet measures as the base it
     *      holds beyond what it owes, not as a balance of its own. Neither is a payment, so the
     *      market's base balance is the one figure that should read the same on both sides of the
     *      call even as the totals move underneath it.
     */
    function testFuzz_baseTokensDoNotMove(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 assetMask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);

        uint256[] memory amounts = new uint256[](numAssets);
        uint256 borrow;
        uint256 dropBps;
        {
            uint256 borrowLimit;
            uint256 liquidity;
            ICometData.AssetInfo memory assetInfo;

            for (uint8 i; i < numAssets; ++i) {
                if (assetMask & (uint256(1) << i) == 0) continue;
                assetInfo = comet.getAssetInfo(i);

                amounts[i] = bound(
                    uint256(keccak256(abi.encode(supplySeed, i))),
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                // Comet floors twice when it decides whether a borrow is collateralized, so the
                // borrow ceiling is floored the same way and stays acceptable to it.
                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;

                // The module weighs liquidity in a single division. Flooring twice here would put
                // this figure below the module's, which would push the drop ceiling above the price
                // at which the account really turns liquidatable.
                liquidity += amounts[i] * comet.getPrice(assetInfo.priceFeed) * assetInfo.liquidateCollateralFactor
                    / (uint256(assetInfo.scale) * FACTOR_SCALE);
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            vm.assume(maxBorrow >= comet.baseBorrowMin()); // the set is too cheap to open a borrow at all
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            uint256 maxDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            maxDrop = maxDrop * 10_000 / liquidity;
            vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

            dropBps = bound(dropSeed, 1, maxDrop * 99 / 100);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            collaterals[i].allocateTo(borrower, amounts[i]);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), amounts[i]);
            comet.supply(address(collaterals[i]), amounts[i]);
            vm.stopPrank();
        }

        vm.prank(borrower);
        comet.withdraw(address(baseToken), borrow);

        if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
            vm.prank(pauser);
            liquidationModule.liquidationModeToggle(partialEnabled);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        uint256 baseBalanceBefore = baseToken.balanceOf(address(comet));

        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        assertEq(baseToken.balanceOf(address(comet)), baseBalanceBefore, "base tokens moved across the absorb");
    }

    /// `AbsorbDebt(address indexed absorber, address indexed borrower, uint basePaidOut, uint usdValue)`
    bytes32 internal constant ABSORB_DEBT = keccak256("AbsorbDebt(address,address,uint256,uint256)");

    /**
     * @notice Base reserves fall by the amount paid out - baseReserves after = before - basePaidOut
     * @dev Invariant. The value of the closed debt leaves the protocol's reserves in exactly the
     *      amount paid out - that is how the protocol funds an absorption.
     *
     *      Reserves are the base Comet holds less what it owes suppliers plus what borrowers owe it.
     *      The absorb leaves the balance and the supply side alone, so the whole movement comes from
     *      the total borrow shrinking, and it has to shrink by what the borrower was credited.
     *
     *      The payout is worked out here from the collateral, not read back off the account. The
     *      rule an absorption follows is that seized collateral pays the debt down by what it is
     *      worth at its liquidation discount, and where the account is left with nothing that
     *      carries borrowing power the rest of the debt is written off instead of surviving. Both
     *      halves are applied below to the balances taken from the borrower, and the resulting debt
     *      and payout are what the market is then held to. The `AbsorbDebt` figure is checked
     *      against that rather than used as its source.
     *
     *      **The tolerance is zero, and that is derived rather than hoped for.** The reserves figure
     *      converts the total borrow from principal to present value, and the paid-out figure in the
     *      event is a present value too, so a drifted index could round the two apart by a unit or
     *      so. Nothing in this group advances the clock, so the borrow index is still at
     *      `BASE_INDEX_SCALE`, where that conversion is a multiply and divide by the same number and
     *      cannot round at all. The index is asserted below rather than assumed: a later edit that
     *      warps time invalidates the reasoning, and it should fail loudly at the reason rather than
     *      quietly by a unit.
     */
    function testFuzz_baseReservesFallByAmountPaidOut(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 assetMask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);

        uint256[] memory amounts = new uint256[](numAssets);
        uint256 borrow;
        uint256 dropBps;
        {
            uint256 borrowLimit;
            uint256 liquidity;
            uint256 seizableValue;
            ICometData.AssetInfo memory assetInfo;

            for (uint8 i; i < numAssets; ++i) {
                if (assetMask & (uint256(1) << i) == 0) continue;
                assetInfo = comet.getAssetInfo(i);

                amounts[i] = bound(
                    uint256(keccak256(abi.encode(supplySeed, i))),
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                // Comet floors twice when it decides whether a borrow is collateralized, so the
                // borrow ceiling is floored the same way and stays acceptable to it.
                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;

                // The module weighs liquidity in a single division. Flooring twice here would put
                // this figure below the module's, which would push the drop ceiling above the price
                // at which the account really turns liquidatable.
                liquidity += amounts[i] * comet.getPrice(assetInfo.priceFeed) * assetInfo.liquidateCollateralFactor
                    / (uint256(assetInfo.scale) * FACTOR_SCALE);

                // What a liquidation could recover from this asset if it took all of it. Weighted by
                // the liquidation factor rather than the liquidate collateral factor, it is the line
                // between a seizure that covers the debt and one that runs out of collateral.
                seizableValue += amounts[i] * comet.getPrice(assetInfo.priceFeed) * assetInfo.liquidationFactor
                    / (uint256(assetInfo.scale) * FACTOR_SCALE);
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            vm.assume(maxBorrow >= comet.baseBorrowMin()); // the set is too cheap to open a borrow at all
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            uint256 maxDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            maxDrop = maxDrop * 10_000 / liquidity;
            vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

            // The two outcomes this invariant speaks about are nowhere near equally likely if the
            // drop is drawn across the whole range. Scaling the prices by k scales what a seizure
            // can recover by k too, so the collateral still covers the debt only while
            // `k * seizableValue >= debtValue` - the top slice of the range, and a narrow one,
            // because the liquidation factors sit close above the liquidate collateral factors.
            // Everything below that slice is a write-off, where the only thing left to say is that
            // the debt reached zero. So the outcome is chosen first and the drop drawn inside it.
            uint256 coversDebtAbove = maxDrop * liquidity / seizableValue;

            if (uint256(keccak256(abi.encode(dropSeed))) % 2 == 0 && coversDebtAbove <= maxDrop * 99 / 100) {
                dropBps = bound(dropSeed, coversDebtAbove, maxDrop * 99 / 100);
            } else {
                dropBps = bound(dropSeed, 1, maxDrop * 99 / 100);
            }
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            collaterals[i].allocateTo(borrower, amounts[i]);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), amounts[i]);
            comet.supply(address(collaterals[i]), amounts[i]);
            vm.stopPrank();
        }

        vm.prank(borrower);
        comet.withdraw(address(baseToken), borrow);

        if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
            vm.prank(pauser);
            liquidationModule.liquidationModeToggle(partialEnabled);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        // The premise of the zero tolerance above.
        assertEq(comet.totalsBasic().baseBorrowIndex, 1e15, "the borrow index has drifted from its scale");

        int256 reservesBefore = comet.getReserves();
        uint256 debtBefore = comet.borrowBalanceOf(borrower);
        uint256 debtValue = debtBefore * comet.getPrice(address(basePriceFeed)) / comet.baseScale();

        uint256[] memory balancesBefore = new uint256[](numAssets);
        for (uint8 i; i < numAssets; ++i) {
            balancesBefore[i] = comet.collateralBalanceOf(borrower, address(collaterals[i]));
        }

        ICoreLiquidationModule.Seizure[] memory plan = liquidationModule.seizurePlan(borrower);

        vm.recordLogs();
        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        // Everything below is built on what actually left the borrower's balances. The plan's own
        // amounts are held to that first, so a payout worked out from the plan is a payout worked
        // out from collateral that genuinely moved.
        for (uint256 j; j < plan.length; ++j) {
            assertEq(
                balancesBefore[plan[j].index] - comet.collateralBalanceOf(borrower, plan[j].asset),
                plan[j].seizedAmount,
                "the plan named an amount the balance did not give up"
            );
        }

        // What that collateral pays off. Each seizure covers what it is worth once the liquidation
        // discount is applied, and never more than is still owed at that point in the walk - the
        // protocol cannot credit a debt it has already cleared.
        //
        // A seizure's worth does not always land on a whole value unit, and which way that part unit
        // goes is a real choice rather than an accident: crediting down leaves the borrower paying
        // for collateral they were not credited for, crediting up hands them a part unit they did
        // not cover. So the walk is run twice, once each way, and the two runs bracket the debt the
        // seizure can honestly leave. The bracket is a value unit per seized asset wide - the
        // resolution of the price feed - and it is derived here, not chosen to make a number fit.
        uint256 remainingLow = debtValue; // credits rounded up: the least debt that can be left
        uint256 remainingHigh = debtValue; // credits rounded down: the most
        for (uint256 j; j < plan.length; ++j) {
            ICometData.AssetInfo memory seized = comet.getAssetInfo(plan[j].index);

            uint256 worth = plan[j].seizedAmount * comet.getPrice(seized.priceFeed) * seized.liquidationFactor;
            uint256 perValueUnit = uint256(seized.scale) * FACTOR_SCALE;

            remainingLow -= Math.min(Math.ceilDiv(worth, perValueUnit), remainingLow);
            remainingHigh -= Math.min(worth / perValueUnit, remainingHigh);
        }

        // And what is left of the debt afterwards, in base. An account with nothing left that
        // carries borrowing power has no way to ever cover the remainder, so the protocol takes the
        // loss rather than leaving the debt standing.
        uint256 debtAfter = comet.borrowBalanceOf(borrower);

        if (weightedCollateral(borrower) == 0) {
            assertEq(debtAfter, 0, "an account stripped of collateralization was left owing");
        } else {
            uint256 basePrice = comet.getPrice(address(basePriceFeed));
            assertGe(debtAfter, remainingLow * comet.baseScale() / basePrice, "the seizure paid off more than it is worth");
            assertLe(debtAfter, remainingHigh * comet.baseScale() / basePrice, "the seizure paid off less than it is worth");
        }

        // The debt left having been held to the collateral, the payout follows from it and the two
        // readings below are exact.
        uint256 expectedPaidOut = debtBefore - debtAfter;
        assertGt(expectedPaidOut, 0, "the absorb paid out nothing");

        assertEq(
            comet.getReserves(),
            reservesBefore - int256(expectedPaidOut),
            "the reserves did not fall by the amount the seizure pays off"
        );

        // The protocol's own report, held to the same figure. A market that funds an absorption
        // correctly but misreports it still misleads everything reading its events.
        uint256 reported;
        uint256 reportedValue;
        bool sawEvent;
        {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 k; k < logs.length; ++k) {
                if (logs[k].topics[0] != ABSORB_DEBT) continue;

                (reported, reportedValue) = abi.decode(logs[k].data, (uint256, uint256));
                sawEvent = true;
            }
        }
        assertTrue(sawEvent, "the absorb emitted no AbsorbDebt");
        assertEq(reported, expectedPaidOut, "AbsorbDebt reported a payout the seizure does not pay for");

        // The event carries the same payout priced in dollars, and that second figure is held to the
        // first. Left unread it is a number nothing in the suite would notice going wrong.
        assertEq(
            reportedValue,
            expectedPaidOut * comet.getPrice(address(basePriceFeed)) / comet.baseScale(),
            "AbsorbDebt priced the payout wrongly"
        );
    }

    /// Everything the account still holds that carries borrowing power, priced and weighted in a
    /// single division. Only whether this is zero matters here - it is the write-off condition.
    function weightedCollateral(address account) internal view returns (uint256 weighted) {
        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            uint256 balance = comet.collateralBalanceOf(account, info.asset);
            if (balance == 0) continue;

            weighted += balance * comet.getPrice(info.priceFeed) * info.borrowCollateralFactor
                / (uint256(info.scale) * FACTOR_SCALE);
        }
    }

    /**
     * @notice The module receives no tokens - module balance delta = 0
     * @dev Invariant. Neither base nor collateral passes through the liquidation module: it only
     *      writes into Comet's storage.
     *
     *      Dust is placed on the module first, in every token on the market rather than only the
     *      ones the position uses. An empty module makes "received nothing" and "was swept clean"
     *      the same reading, and it is the second one that would matter: a module that hands its
     *      balance on, or that a seizure routes through, would pass a zero-to-zero check and fail
     *      this one. The assets the position never touches need that just as much - they are where
     *      a stray transfer would go unnoticed.
     */
    function testFuzz_moduleReceivesNoTokens(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        uint256 dustSeed
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 assetMask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);

        uint256[] memory amounts = new uint256[](numAssets);
        uint256 borrow;
        uint256 dropBps;
        {
            uint256 borrowLimit;
            uint256 liquidity;
            ICometData.AssetInfo memory assetInfo;

            for (uint8 i; i < numAssets; ++i) {
                if (assetMask & (uint256(1) << i) == 0) continue;
                assetInfo = comet.getAssetInfo(i);

                amounts[i] = bound(
                    uint256(keccak256(abi.encode(supplySeed, i))),
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                // Comet floors twice when it decides whether a borrow is collateralized, so the
                // borrow ceiling is floored the same way and stays acceptable to it.
                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;

                // The module weighs liquidity in a single division. Flooring twice here would put
                // this figure below the module's, which would push the drop ceiling above the price
                // at which the account really turns liquidatable.
                liquidity += amounts[i] * comet.getPrice(assetInfo.priceFeed) * assetInfo.liquidateCollateralFactor
                    / (uint256(assetInfo.scale) * FACTOR_SCALE);
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            vm.assume(maxBorrow >= comet.baseBorrowMin()); // the set is too cheap to open a borrow at all
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            uint256 maxDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            maxDrop = maxDrop * 10_000 / liquidity;
            vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

            dropBps = bound(dropSeed, 1, maxDrop * 99 / 100);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            collaterals[i].allocateTo(borrower, amounts[i]);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), amounts[i]);
            comet.supply(address(collaterals[i]), amounts[i]);
            vm.stopPrank();
        }

        vm.prank(borrower);
        comet.withdraw(address(baseToken), borrow);

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        // No spare argument for the mode, so it comes off the dust seed. Both routes reach the same
        // hook, but a test that only ever ran one of them would not be able to say so.
        bool partialEnabled = uint256(keccak256(abi.encode(dustSeed, "mode"))) % 2 == 0;
        if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
            vm.prank(pauser);
            liquidationModule.liquidationModeToggle(partialEnabled);
        }

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        // Straight to the module's address, so nothing about the market's own books moves with it.
        // Each token gets its own amount rather than a single figure repeated, so a transfer that
        // happened to match another token's pile still shows.
        address module = address(liquidationModule);
        baseToken.allocateTo(module, bound(dustSeed, 0, 1_000_000 * uint256(comet.baseScale())));
        for (uint8 i; i < numAssets; ++i) {
            collaterals[i].allocateTo(
                module,
                bound(
                    uint256(keccak256(abi.encode(dustSeed, i))),
                    0,
                    1_000_000 * uint256(comet.getAssetInfo(i).scale)
                )
            );
        }

        // Every token on the market, not only the ones in the mask: a module that received the wrong
        // asset is exactly what a mask-shaped reading would step over.
        uint256 baseBefore = baseToken.balanceOf(module);
        uint256[] memory balancesBefore = new uint256[](numAssets);
        for (uint8 i; i < numAssets; ++i) {
            balancesBefore[i] = collaterals[i].balanceOf(module);
        }

        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        assertEq(baseToken.balanceOf(module), baseBefore, "the module's base balance moved across the absorb");

        for (uint8 i; i < numAssets; ++i) {
            assertEq(
                collaterals[i].balanceOf(module),
                balancesBefore[i],
                "the module's collateral balance moved across the absorb"
            );
        }
    }
}
