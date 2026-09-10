// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { Deployable } from "@comet-contracts/CometProxyAdmin.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModule } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModule.sol";

import { LiquidationModuleDeployer } from "../../helpers/LiquidationModuleDeployer.sol";
import { LiquidationFuzzBase } from "./LiquidationFuzzBase.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Borrower collateral
 * @notice What a seizure does to the borrower's collateral balances and to the account's asset bitmap.
 * @dev Positions stand on several collaterals at once. Twenty-four assets make sixteen million
 *      subsets, so the set is fuzzed by a bit mask rather than enumerated.
 */
contract BorrowerCollateralFuzzTest is LiquidationFuzzBase {
    function setUp() public {
        prepareFixture();
        seedMarketActivity();
    }

    /// @notice Balances do not grow - balance after <= balance before
    /// @dev Liquidation only takes away, including from assets the borrower never supplied.
    function testFuzz_balancesDoNotGrow(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);
        _baseScenario(p, partialEnabled);

        // Every asset, not only the masked ones: zero is the balance with somewhere to grow to.
        uint8 numAssets = comet.numAssets();
        uint256[] memory balancesBefore = new uint256[](numAssets);
        for (uint8 i; i < numAssets; ++i) {
            balancesBefore[i] = comet.collateralBalanceOf(borrower, address(collaterals[i]));
        }

        _absorb();

        for (uint8 i; i < numAssets; ++i) {
            assertLe(
                comet.collateralBalanceOf(borrower, address(collaterals[i])),
                balancesBefore[i],
                "a collateral balance grew across the absorb"
            );
        }
    }

    /// @notice Assets outside the plan are untouched - asset not in plan → balance unchanged
    /// @dev To the last unit, not "approximately".
    function testFuzz_assetsOutsidePlanAreUntouched(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 mask = _assetMask(maskSeed);

        // Something has to be left over for the claim to be about, and one asset never leaves
        // anything. A thin mask is widened rather than discarded, so the run is reshaped not lost.
        if (_bitCount(mask) < 2) {
            mask |= uint256(1) << (maskSeed % numAssets);
            mask |= uint256(1) << ((maskSeed / numAssets) % numAssets);
        }

        Position memory p = _boundPositionMask(mask, supplySeed, borrowAmount, dropSeed, 0);

        // Barely liquidatable, so the first asset or two satisfies the plan and the rest is left
        // alone - which is the state this claim is about. Partial mode for the same reason: full
        // mode closes the debt outright and sweeps everything.
        p.dropPpb = bound(dropSeed, p.dropCeiling * 10 / 11, p.dropCeiling);

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, true);

        // A plan reaching every asset leaves no outsider, so the loop below would pass on nothing.
        vm.assume(plan.length < _bitCount(mask));

        bool[] memory inPlan = new bool[](numAssets);
        for (uint256 k; k < plan.length; ++k) {
            inPlan[plan[k].index] = true;
        }

        uint256[] memory balancesBefore = new uint256[](numAssets);
        for (uint8 i; i < numAssets; ++i) {
            balancesBefore[i] = comet.collateralBalanceOf(borrower, address(collaterals[i]));
        }

        _absorb();

        for (uint8 i; i < numAssets; ++i) {
            if (inPlan[i]) continue;

            assertEq(
                comet.collateralBalanceOf(borrower, address(collaterals[i])),
                balancesBefore[i],
                "an asset outside the seizure plan lost collateral"
            );
        }
    }

    /// @notice A non-seizable asset is untouched - LF = 0 → balance unchanged
    /// @dev Holds even once everything else is exhausted and the remainder is written off.
    function testFuzz_nonSeizableAssetIsUntouched(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 deadAmount,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        // Placed last, where the seizure reaches it only once everything before it is gone - the
        // hardest place to survive. Kept out of the mask so the shared chain never counts it: while
        // the position is built it still carries its factors, so the borrow is accepted with room to
        // spare, and by the time anything is seized its liquidation factor is zero.
        uint8 dead = comet.numAssets() - 1;
        Position memory p = _boundPositionMask(bound(maskSeed, 1, (uint256(1) << dead) - 1), supplySeed, borrowAmount, dropSeed, 0);

        // Below this the seizable collateral no longer covers the debt, so the liquidation runs out
        // of anything it may touch and writes off the remainder.
        {
            uint256 badDebtDrop = p.borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            badDebtDrop = badDebtDrop * DROP_SCALE / p.seizable;
            vm.assume(badDebtDrop >= 100); // no room left below the boundary to drop the prices into

            p.dropPpb = bound(dropSeed, _minDropPpb(p.amounts), badDebtDrop * 99 / 100);
        }

        // Large on purpose: an asset well worth taking, sitting in front of a liquidation that has
        // nothing left it is allowed to take.
        uint256 deadSupply;
        {
            ICometData.AssetInfo memory deadInfo = comet.getAssetInfo(dead);
            deadSupply = bound(
                deadAmount,
                uint256(deadInfo.scale) / 1000,
                _supplyCeiling(deadInfo)
            );
        }

        for (uint8 i; i < dead; ++i) {
            if (p.amounts[i] == 0) continue;

            collaterals[i].allocateTo(borrower, p.amounts[i]);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), p.amounts[i]);
            comet.supply(address(collaterals[i]), p.amounts[i]);
            vm.stopPrank();
        }

        collaterals[dead].allocateTo(borrower, deadSupply);

        vm.startPrank(borrower);
        collaterals[dead].approve(address(comet), deadSupply);
        comet.supply(address(collaterals[dead]), deadSupply);
        comet.withdraw(address(baseToken), p.borrow);
        vm.stopPrank();

        // The last asset keeps its price: its balance surviving has to be the module refusing to
        // touch it, not the arithmetic valuing it at nothing.
        for (uint8 i; i < dead; ++i) {
            if (p.amounts[i] == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * p.dropPpb / DROP_SCALE;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        // Stripped only now, on a market that already holds the position - which is how governance
        // dropping an asset actually plays out for the borrowers standing on it.
        vm.startPrank(timelock);
        configurator.updateAssetBorrowCollateralFactor(address(cometProxy), address(collaterals[dead]), 0);
        configurator.updateAssetLiquidateCollateralFactor(address(cometProxy), address(collaterals[dead]), 0);
        configurator.updateAssetLiquidationFactor(address(cometProxy), address(collaterals[dead]), 0);
        vm.stopPrank();

        // Comet binds its module in the constructor and a module accepts one asset list for life,
        // so new configuration needs a new implementation and a new module behind it.
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

        // The mode lives on the module, and the module is a new one, so it is set after the upgrade.
        if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
            vm.prank(pauser);
            liquidationModule.liquidationModeToggle(partialEnabled);
        }

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        _absorb();

        assertEq(
            comet.collateralBalanceOf(borrower, address(collaterals[dead])),
            deadSupply,
            "the non-seizable asset lost collateral"
        );
    }

    /// @notice A seizure never exceeds the balance - seizedAmount <= balance before
    /// @dev The plan must not write out amounts that are not on the balance.
    function testFuzz_seizureNeverExceedsBalance(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        // The top tenth of the capacity: a debt that large leaves no slack, so the seizure works
        // through the balances instead of stopping at the first.
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 9_000);

        // Judged on the plan alone, nothing absorbed: an overdrawn entry would revert inside the
        // transfer and never reach a balance to compare, so it has to be caught where it is written.
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        for (uint256 j; j < plan.length; ++j) {
            assertLe(
                plan[j].seizedAmount,
                comet.collateralBalanceOf(borrower, plan[j].asset),
                "the plan seizes more of an asset than the borrower holds"
            );
        }
    }

    /// @notice Exactly the planned amount is taken - balance after = balance before - seizedAmount
    /// @dev Execution does not round, does not add and does not trim.
    function testFuzz_exactlyThePlannedAmountIsTaken(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);

        // Nothing happens between the plan and the absorb, so any difference between them is the
        // execution disagreeing with itself rather than the market having moved.
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        uint256[] memory balancesBefore = new uint256[](plan.length);
        for (uint256 j; j < plan.length; ++j) {
            balancesBefore[j] = comet.collateralBalanceOf(borrower, plan[j].asset);
        }

        _absorb();

        for (uint256 j; j < plan.length; ++j) {
            assertEq(
                comet.collateralBalanceOf(borrower, plan[j].asset),
                balancesBefore[j] - plan[j].seizedAmount,
                "the seizure did not match the plan"
            );
        }
    }

    /// @notice The membership bit clears exactly at zero - bit set <=> balance > 0
    /// @dev Not earlier, not later.
    function testFuzz_membershipBitClearsExactlyAtZero(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 mask = _assetMask(maskSeed);

        // The bitmap spans two fields, and the ends of those words are where a shift goes wrong, so
        // at least one edge index is forced into the set rather than left to the draw.
        {
            uint8[4] memory edges = [uint8(0), 15, 16, numAssets - 1];
            uint256 boundaries;
            for (uint256 e; e < edges.length; ++e) {
                boundaries |= uint256(1) << edges[e];
            }
            if (mask & boundaries == 0) mask |= uint256(1) << edges[maskSeed % 4];
        }

        // The whole range: a shallow fall leaves remainders and the bits must stay, a deep one
        // empties the balances and the bits must go. Both are the claim.
        Position memory p = _boundPositionMask(mask, supplySeed, borrowAmount, dropSeed, 0);
        _baseScenario(p, partialEnabled);

        _absorb();

        // Comet exposes `userBasic` as its storage getter, so the struct arrives flattened.
        (,,, uint16 assetsIn, uint8 reservedBits) = comet.userBasic(borrower);

        for (uint8 i; i < numAssets; ++i) {
            assertEq(
                _inBitmap(assetsIn, reservedBits, i),
                comet.collateralBalanceOf(borrower, address(collaterals[i])) > 0,
                "the membership bit disagrees with the balance"
            );
        }
    }

    /// @notice Other bits do not change - asset not in plan → bit unchanged
    /// @dev The bitmap is edited pointwise, not rewritten wholesale.
    function testFuzz_bitsOutsidePlanDoNotChange(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 mask = _assetMask(maskSeed);

        // A wholesale rewrite would show up as one bitmap word clobbering the other, which a mask
        // sitting entirely in one word cannot catch - so it is widened across the seam.
        if (mask & ((uint256(1) << 16) - 1) == 0 || mask >> 16 == 0) {
            mask |= (uint256(1) << 15) | (uint256(1) << 16);
        }

        Position memory p = _boundPositionMask(mask, supplySeed, borrowAmount, dropSeed, 0);

        // Barely liquidatable and partial mode on, so the plan is satisfied early and assets are
        // guaranteed to be left outside it.
        p.dropPpb = bound(dropSeed, p.dropCeiling * 10 / 11, p.dropCeiling);

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, true);

        // A plan reaching every asset leaves no outsider, so the loop below would pass on nothing.
        vm.assume(plan.length < _bitCount(mask));

        bool[] memory inPlan = new bool[](numAssets);
        for (uint256 k; k < plan.length; ++k) {
            inPlan[plan[k].index] = true;
        }

        // Comet exposes `userBasic` as its storage getter, so the struct arrives flattened.
        (,,, uint16 assetsInBefore, uint8 reservedBefore) = comet.userBasic(borrower);

        _absorb();

        (,,, uint16 assetsInAfter, uint8 reservedAfter) = comet.userBasic(borrower);

        for (uint8 i; i < numAssets; ++i) {
            if (inPlan[i]) continue;

            assertEq(
                _inBitmap(assetsInAfter, reservedAfter, i),
                _inBitmap(assetsInBefore, reservedBefore, i),
                "the membership bit of an asset outside the plan changed"
            );
        }
    }

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

    function _bitCount(uint256 mask) internal pure returns (uint256 count) {
        while (mask != 0) {
            mask &= mask - 1;
            ++count;
        }
    }

    /// @dev The bitmap spans two `userBasic` fields: the first sixteen assets in `assetsIn`, the
    ///      rest in `_reserved`, which is not reserved in this Comet.
    function _inBitmap(uint16 assetsIn, uint8 reservedBits, uint8 i) internal pure returns (bool) {
        return i < 16 ? assetsIn & (uint16(1) << i) != 0 : reservedBits & (uint8(1) << (i - 16)) != 0;
    }
}
