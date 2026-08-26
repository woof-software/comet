// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { Deployable } from "@comet-contracts/CometProxyAdmin.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModule } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModule.sol";

import { LiquidationModuleDeployer } from "../../helpers/LiquidationModuleDeployer.sol";
import { ProtocolFixture } from "../../helpers/ProtocolFixture.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Borrower collateral
 * @notice One invariant per test: a single statement a counterexample can refute.
 * @dev A position here stands on several collaterals at once, so the asset stops being something to
 *      enumerate and becomes something to fuzz. Twenty-four assets make sixteen million subsets and
 *      no loop can walk them, so the set is picked by a bit mask: a mask hands over sparse sets,
 *      neighbouring indexes and the ends of the list on its own, which is what this group is for.
 *
 *      The deposits come from a single seed rather than a fuzz argument each. The seed is a root -
 *      asset `i` takes the hash of the seed and its own index - so one argument settles the whole
 *      set of deposits while every asset still gets bounds cut to its own scale and supply cap.
 *
 *      The fall in price is one multiplier applied to every selected asset. Scaling all of the
 *      prices together scales the account's liquidity by exactly the same amount, so how far the
 *      price has to fall before the account is liquidatable is one comparison for the whole set
 *      instead of a percentage picked by hand, and it holds on any market.
 *
 *      Every division below is floored in the order Comet floors it, so the ceiling the bounds hand
 *      to the fuzzer is never larger than the one Comet will accept and no run is spent on a borrow
 *      that reverts. A run that cannot be built - too little collateral to reach the minimum borrow,
 *      more base than the market holds, no room left to drop the price into - is rejected rather
 *      than passed, so a vacuous run is never counted as a checked one.
 */
contract BorrowerCollateralFuzzTest is ProtocolFixture {
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
     * @notice Balances do not grow - balance after <= balance before
     * @dev Invariant. Liquidation only takes away. No collateral balance can increase, including
     *      assets the borrower never supplied at all.
     */
    function testFuzz_balancesDoNotGrow(
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

                // No less than a thousandth of a unit, no more than a million units or the asset's
                // supply cap, whichever binds first. The scale is widened before it is multiplied -
                // the asset table's scales overflow their own uint64 at a million units.
                amounts[i] = bound(
                    uint256(keccak256(abi.encode(supplySeed, i))),
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                // What the deposit is worth, then the same worth under each of the two factors: the
                // borrow collateral factor sets how much can be drawn against it, the liquidate
                // collateral factor sets how far the price may fall before it stops covering.
                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                liquidity += value * assetInfo.liquidateCollateralFactor / FACTOR_SCALE;
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            vm.assume(maxBorrow >= comet.baseBorrowMin()); // the set is too cheap to open a borrow at all
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            // How far the prices have to fall together before the collateral stops covering the
            // debt, in basis points of where they stand now.
            uint256 maxDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            maxDrop = maxDrop * 10_000 / liquidity;
            vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

            // A percent clear of the boundary - the boundary itself belongs to its own invariant.
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

        // Every asset on the market, not only the ones in the mask. An asset the borrower never
        // touched has a balance of zero, and zero is the one balance that has somewhere to grow to.
        uint256[] memory balancesBefore = new uint256[](numAssets);
        for (uint8 i; i < numAssets; ++i) {
            balancesBefore[i] = comet.collateralBalanceOf(borrower, address(collaterals[i]));
        }

        // Holds by construction of the bounds above. If it ever does not, the bounds are wrong and
        // the run must not pass quietly.
        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        for (uint8 i; i < numAssets; ++i) {
            assertLe(
                comet.collateralBalanceOf(borrower, address(collaterals[i])),
                balancesBefore[i],
                "a collateral balance grew across the absorb"
            );
        }
    }

    /**
     * @notice Assets outside the plan are untouched - asset not in plan → balance unchanged
     * @dev Invariant. Whatever is not in the seizure plan stays with the borrower exactly as it was -
     *      to the last unit, not "approximately".
     */
    function testFuzz_assetsOutsidePlanAreUntouched(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 assetMask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);
        uint8 supplied;

        // The invariant needs something left over to talk about, and a position on a single asset
        // can never leave anything. A thin mask is widened rather than discarded: two indexes taken
        // from the same seed are forced on, which reshapes the run instead of throwing it away.
        {
            for (uint8 i; i < numAssets; ++i) {
                if (assetMask & (uint256(1) << i) != 0) ++supplied;
            }
            if (supplied < 2) {
                assetMask |= uint256(1) << (maskSeed % numAssets);
                assetMask |= uint256(1) << ((maskSeed / numAssets) % numAssets);

                supplied = 0;
                for (uint8 i; i < numAssets; ++i) {
                    if (assetMask & (uint256(1) << i) != 0) ++supplied;
                }
            }
        }

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

                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                liquidity += value * assetInfo.liquidateCollateralFactor / FACTOR_SCALE;
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            vm.assume(maxBorrow >= comet.baseBorrowMin()); // the set is too cheap to open a borrow at all
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            uint256 maxDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            maxDrop = maxDrop * 10_000 / liquidity;
            vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

            // The shallow end of the range, a hair under the boundary. The account is barely
            // liquidatable, so the first asset or two satisfies the plan and the rest of the set is
            // left alone - which is the state this invariant is about.
            dropBps = bound(dropSeed, maxDrop * 90 / 100, maxDrop * 99 / 100);
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

        // Partial liquidation, otherwise the debt is closed outright, every asset is swept and the
        // plan covers the whole position.
        if (!liquidationModule.partialLiquidationEnabled()) {
            vm.prank(pauser);
            liquidationModule.liquidationModeToggle(true);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        // A plan that reaches every supplied asset leaves no outsider, so there is nothing for the
        // final check to be about and the run is discarded rather than passed on an empty loop.
        bool[] memory inPlan = new bool[](numAssets);
        {
            ICoreLiquidationModule.Seizure[] memory plan = liquidationModule.seizurePlan(borrower);
            vm.assume(plan.length < supplied);

            for (uint256 k; k < plan.length; ++k) {
                inPlan[plan[k].index] = true;
            }
        }

        uint256[] memory balancesBefore = new uint256[](numAssets);
        for (uint8 i; i < numAssets; ++i) {
            balancesBefore[i] = comet.collateralBalanceOf(borrower, address(collaterals[i]));
        }

        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (inPlan[i]) continue;

            assertEq(
                comet.collateralBalanceOf(borrower, address(collaterals[i])),
                balancesBefore[i],
                "an asset outside the seizure plan lost collateral"
            );
        }
    }

    /**
     * @notice A non-seizable asset is untouched - LF = 0 → balance unchanged
     * @dev Invariant. An asset with a zero liquidation factor is never seized under any
     *      circumstances, including full exhaustion of everything else and a bad-debt write-off.
     */
    function testFuzz_nonSeizableAssetIsUntouched(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 deadAmount,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        // The asset that loses its factors sits last, where the seizure reaches it only once
        // everything before it is gone - the hardest place for it to survive. It always joins the
        // position: it is the subject of the invariant, not a draw.
        uint8 dead = comet.numAssets() - 1;
        uint256 assetMask = bound(maskSeed, 1, (uint256(1) << dead) - 1);

        uint256[] memory amounts = new uint256[](dead);
        uint256 borrow;
        uint256 dropBps;
        {
            uint256 borrowLimit;
            uint256 seizableValue;
            ICometData.AssetInfo memory assetInfo;

            for (uint8 i; i < dead; ++i) {
                if (assetMask & (uint256(1) << i) == 0) continue;
                assetInfo = comet.getAssetInfo(i);

                amounts[i] = bound(
                    uint256(keccak256(abi.encode(supplySeed, i))),
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                // Both sums leave out the asset that is about to be stripped. It still carries its
                // factors while the position is being built, so the real borrowing power is larger
                // than this and the borrow is accepted with room to spare. Its liquidation factor is
                // zero by the time anything is seized, so it belongs in neither total.
                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                seizableValue += value * assetInfo.liquidationFactor / FACTOR_SCALE;
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            vm.assume(maxBorrow >= comet.baseBorrowMin()); // the set is too cheap to open a borrow at all
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            // Below this multiplier every seizable unit taken together no longer covers the debt, so
            // the liquidation runs out of collateral it may touch and writes off the remainder.
            uint256 badDebtDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            badDebtDrop = badDebtDrop * 10_000 / seizableValue;
            vm.assume(badDebtDrop >= 100); // no room left below the boundary to drop the prices into

            dropBps = bound(dropSeed, 1, badDebtDrop * 99 / 100);
        }

        // Large on purpose. The point is an asset that looks well worth taking sitting in front of a
        // liquidation that has nothing left it is allowed to take.
        uint256 deadSupply;
        {
            ICometData.AssetInfo memory deadInfo = comet.getAssetInfo(dead);
            deadSupply = bound(
                deadAmount,
                uint256(deadInfo.scale) / 1000,
                Math.min(1_000_000 * uint256(deadInfo.scale), deadInfo.supplyCap)
            );
        }

        for (uint8 i; i < dead; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            collaterals[i].allocateTo(borrower, amounts[i]);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), amounts[i]);
            comet.supply(address(collaterals[i]), amounts[i]);
            vm.stopPrank();
        }

        collaterals[dead].allocateTo(borrower, deadSupply);

        vm.startPrank(borrower);
        collaterals[dead].approve(address(comet), deadSupply);
        comet.supply(address(collaterals[dead]), deadSupply);
        comet.withdraw(address(baseToken), borrow);
        vm.stopPrank();

        // The last asset keeps its price throughout. Its balance surviving has to be the module
        // refusing to touch it, not the arithmetic quietly valuing it at nothing.
        for (uint8 i; i < dead; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        // Only now do the factors go, on a market that already holds the position. Governance can
        // strip an asset it no longer wants to lend against, and the borrowers standing on it are
        // still standing there when it happens.
        vm.startPrank(timelock);
        configurator.updateAssetBorrowCollateralFactor(address(cometProxy), address(collaterals[dead]), 0);
        configurator.updateAssetLiquidateCollateralFactor(address(cometProxy), address(collaterals[dead]), 0);
        configurator.updateAssetLiquidationFactor(address(cometProxy), address(collaterals[dead]), 0);
        vm.stopPrank();

        // A Comet binds its module for good in the constructor and a module accepts one asset list
        // in its lifetime, so new configuration means a new implementation and a new module behind
        // it. `LiquidationModuleForComet` is the one meant for this: it takes the live proxy in its
        // constructor, which is how a market that is already running gets upgraded.
        dexAdapter = LiquidationModuleDeployer.deployAdapter(
            DEX_ROUTER, weth, DEX_SLIPPAGE_BPS, collateralAddresses()
        );
        liquidationModule = LiquidationModuleDeployer.deployDefaultLiquidationModuleWithComet(
            moduleOpts(dexAdapter), address(cometProxy)
        );

        vm.startPrank(timelock);
        configurator.setLiquidationModule(address(cometProxy), address(liquidationModule));
        proxyAdmin.deployAndUpgradeTo(Deployable(address(configuratorProxy)), cometProxy);
        vm.stopPrank();

        // The mode lives on the module, and the module is a new one, so this is set after the
        // upgrade rather than before it.
        if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
            vm.prank(pauser);
            liquidationModule.liquidationModeToggle(partialEnabled);
        }

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        assertEq(
            comet.collateralBalanceOf(borrower, address(collaterals[dead])),
            deadSupply,
            "the non-seizable asset lost collateral"
        );
    }

    /**
     * @notice A seizure never exceeds the balance - seizedAmount <= balance before
     * @dev Invariant. You cannot seize more than the borrower has: the plan does not write out
     *      amounts that are not on the balance.
     */
    function testFuzz_seizureNeverExceedsBalance(
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

                // The floor of the range is a thousandth of a unit and it earns its place here: a
                // deposit that small is worth almost nothing against the debt, so the plan reaches
                // for the whole of it and runs into the end of the balance, which is the edge the
                // invariant lives on.
                amounts[i] = bound(
                    uint256(keccak256(abi.encode(supplySeed, i))),
                    uint256(assetInfo.scale) / 1000,
                    Math.min(1_000_000 * uint256(assetInfo.scale), assetInfo.supplyCap)
                );

                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                liquidity += value * assetInfo.liquidateCollateralFactor / FACTOR_SCALE;
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            // The floor of the borrow range, not the ceiling, is what has to clear the minimum here.
            vm.assume(maxBorrow * 90 / 100 >= comet.baseBorrowMin());
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            // The top tenth of what the collateral can carry. A debt that large leaves the seizure
            // little slack, so it works its way through the balances rather than stopping at the
            // first one.
            borrow = bound(borrowAmount, maxBorrow * 90 / 100, maxBorrow);

            uint256 maxDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            maxDrop = maxDrop * 10_000 / liquidity;
            vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

            // The whole range, down to a price of almost nothing: a shallow drop takes one asset,
            // a deep one takes every asset to the last unit, and both must respect the balance.
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

        uint256[] memory balances = new uint256[](numAssets);
        for (uint8 i; i < numAssets; ++i) {
            balances[i] = comet.collateralBalanceOf(borrower, address(collaterals[i]));
        }

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        // The plan is read and judged on its own, with nothing absorbed. An overdrawn entry would
        // revert inside the transfer and never reach a balance to be compared against, so the claim
        // has to be caught where it is written rather than where it is spent.
        ICoreLiquidationModule.Seizure[] memory plan = liquidationModule.seizurePlan(borrower);

        for (uint256 j; j < plan.length; ++j) {
            assertLe(
                plan[j].seizedAmount,
                balances[plan[j].index],
                "the plan seizes more of an asset than the borrower holds"
            );
        }
    }

    /**
     * @notice Exactly the planned amount is taken - balance after = balance before - seizedAmount
     * @dev Invariant. The actual seizure matches the plan to the unit: execution does not round,
     *      does not add and does not trim.
     */
    function testFuzz_exactlyThePlannedAmountIsTaken(
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

                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                liquidity += value * assetInfo.liquidateCollateralFactor / FACTOR_SCALE;
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

        // Nothing at all happens between reading the plan and running the absorb - no warp, no
        // reprice, no change of mode. The plan is recomputed inside the absorb from the same inputs,
        // so any difference between the two is the execution disagreeing with itself, not the market
        // having moved underneath it.
        ICoreLiquidationModule.Seizure[] memory plan = liquidationModule.seizurePlan(borrower);

        uint256[] memory balancesBefore = new uint256[](plan.length);
        for (uint256 j; j < plan.length; ++j) {
            balancesBefore[j] = comet.collateralBalanceOf(borrower, plan[j].asset);
        }

        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        for (uint256 j; j < plan.length; ++j) {
            assertEq(
                comet.collateralBalanceOf(borrower, plan[j].asset),
                balancesBefore[j] - plan[j].seizedAmount,
                "the seizure did not match the plan"
            );
        }
    }

    /**
     * @notice The membership bit clears exactly at zero - bit set <=> balance > 0
     * @dev Invariant. An asset leaves the account's bitmap if and only if its balance reached zero.
     *      Not earlier, not later.
     */
    function testFuzz_membershipBitClearsExactlyAtZero(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 assetMask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);

        // The bitmap is kept in two fields: the first sixteen assets in `assetsIn`, the rest in
        // `_reserved`. The ends of those two words are where a shift or a mask goes wrong, so at
        // least one of them is made to take part rather than left to the draw.
        {
            uint8[4] memory edges = [uint8(0), 15, 16, numAssets - 1];
            uint256 boundaries;
            for (uint256 e; e < edges.length; ++e) {
                boundaries |= uint256(1) << edges[e];
            }
            if (assetMask & boundaries == 0) assetMask |= uint256(1) << edges[maskSeed % 4];
        }

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

                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                liquidity += value * assetInfo.liquidateCollateralFactor / FACTOR_SCALE;
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            vm.assume(maxBorrow >= comet.baseBorrowMin()); // the set is too cheap to open a borrow at all
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            uint256 maxDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            maxDrop = maxDrop * 10_000 / liquidity;
            vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

            // The whole range on purpose. A shallow drop leaves remainders on the balances and the
            // bits must stay set; a deep one empties them and the bits must go. Both are the claim.
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

        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        // Comet exposes `userBasic` as its storage getter, so the struct arrives flattened.
        (,,, uint16 assetsIn, uint8 reservedBits) = comet.userBasic(borrower);

        for (uint8 i; i < numAssets; ++i) {
            bool inBitmap = i < 16
                ? assetsIn & (uint16(1) << i) != 0
                : reservedBits & (uint8(1) << (i - 16)) != 0;

            assertEq(
                inBitmap,
                comet.collateralBalanceOf(borrower, address(collaterals[i])) > 0,
                "the membership bit disagrees with the balance"
            );
        }
    }

    /**
     * @notice Other bits do not change - asset not in plan → bit unchanged
     * @dev Invariant. Liquidation does not touch membership for assets outside the plan: the bitmap
     *      is edited pointwise, not rewritten wholesale.
     */
    function testFuzz_bitsOutsidePlanDoNotChange(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 assetMask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);
        uint8 supplied;

        // Assets are needed on both sides of the seam between the two words the bitmap lives in,
        // because a wholesale rewrite would most likely show up as one word clobbering the other.
        // A mask sitting entirely in one word cannot catch that, so it is widened across the seam.
        {
            if (assetMask & ((uint256(1) << 16) - 1) == 0 || assetMask >> 16 == 0) {
                assetMask |= (uint256(1) << 15) | (uint256(1) << 16);
            }
            for (uint8 i; i < numAssets; ++i) {
                if (assetMask & (uint256(1) << i) != 0) ++supplied;
            }
        }

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

                uint256 value = amounts[i] * comet.getPrice(assetInfo.priceFeed) / uint256(assetInfo.scale);
                borrowLimit += value * assetInfo.borrowCollateralFactor / FACTOR_SCALE;
                liquidity += value * assetInfo.liquidateCollateralFactor / FACTOR_SCALE;
            }

            uint256 maxBorrow = borrowLimit * comet.baseScale() / comet.getPrice(address(basePriceFeed));
            vm.assume(maxBorrow >= comet.baseBorrowMin()); // the set is too cheap to open a borrow at all
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

            uint256 maxDrop = borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            maxDrop = maxDrop * 10_000 / liquidity;
            vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

            // The shallow end, a hair under the boundary: the account is barely liquidatable, the
            // plan is satisfied early, and assets are guaranteed to be left outside it.
            dropBps = bound(dropSeed, maxDrop * 90 / 100, maxDrop * 99 / 100);
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

        // Partial liquidation, otherwise the debt is closed outright, every asset is swept and the
        // plan covers the whole position.
        if (!liquidationModule.partialLiquidationEnabled()) {
            vm.prank(pauser);
            liquidationModule.liquidationModeToggle(true);
        }

        for (uint8 i; i < numAssets; ++i) {
            if (assetMask & (uint256(1) << i) == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        // A plan that reaches every supplied asset leaves no outsider, so there is nothing for the
        // final check to be about and the run is discarded rather than passed on an empty loop.
        bool[] memory inPlan = new bool[](numAssets);
        {
            ICoreLiquidationModule.Seizure[] memory plan = liquidationModule.seizurePlan(borrower);
            vm.assume(plan.length < supplied);

            for (uint256 k; k < plan.length; ++k) {
                inPlan[plan[k].index] = true;
            }
        }

        // Comet exposes `userBasic` as its storage getter, so the struct arrives flattened. The
        // bitmap is kept in two of its fields: the first sixteen assets in `assetsIn`, the rest in
        // `_reserved`.
        (,,, uint16 assetsInBefore, uint8 reservedBefore) = comet.userBasic(borrower);

        {
            address[] memory accounts = new address[](1);
            accounts[0] = borrower;

            vm.prank(liquidator);
            comet.absorb(liquidator, accounts);
        }

        (,,, uint16 assetsInAfter, uint8 reservedAfter) = comet.userBasic(borrower);

        for (uint8 i; i < numAssets; ++i) {
            if (inPlan[i]) continue;

            bool before = i < 16
                ? assetsInBefore & (uint16(1) << i) != 0
                : reservedBefore & (uint8(1) << (i - 16)) != 0;
            bool afterwards = i < 16
                ? assetsInAfter & (uint16(1) << i) != 0
                : reservedAfter & (uint8(1) << (i - 16)) != 0;

            assertEq(afterwards, before, "the membership bit of an asset outside the plan changed");
        }
    }
}
