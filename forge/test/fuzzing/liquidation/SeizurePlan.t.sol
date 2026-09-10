// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { Deployable } from "@comet-contracts/CometProxyAdmin.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModule } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModule.sol";

import { LiquidationModuleDeployer } from "../../helpers/LiquidationModuleDeployer.sol";
import { LiquidationFuzzBase } from "./LiquidationFuzzBase.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Seizure plan structure
 * @notice The plan as an object rather than as arithmetic: order, composition, no duplicates, no junk.
 * @dev Nothing is executed here - reading `seizurePlan` is the whole of it, so no liquidator takes
 *      part. The mask is biased towards the ends of the bitmap's two words, because the plan walks
 *      assets by number and a traversal bug shows there rather than in the middle.
 */
contract SeizurePlanFuzzTest is LiquidationFuzzBase {

    /**
     * @notice What a test asks the draw to aim at. Every field off at zero leaves the plain draw.
     * @param dustMask         assets to press far below a thousandth of a unit
     * @param topMask          assets to pin to the top of their range
     * @param bottomMask       assets to pin to the bottom of their range
     * @param borrowFloorBps   lift the borrow floor to this fraction of the ceiling
     * @param borrowCeilingBps cut the borrow ceiling to this fraction of the capacity
     */
    struct Bias {
        uint256 dustMask;
        uint256 topMask;
        uint256 bottomMask;
        uint256 borrowFloorBps;
        uint256 borrowCeilingBps;
    }

    function setUp() public {
        prepareFixture();
        seedMarketActivity();
    }

    /// @notice Indexes are increasing - plan[j].index < plan[j+1].index
    /// @dev The order decides what gets seized first, so it has to be predictable.
    function testFuzz_indexesAreIncreasing(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 mask = _assetMask(maskSeed);

        // Order is a claim about pairs, so a thin draw is widened rather than discarded. Both sides
        // of the 15/16 seam first: a plan inside one bitmap word cannot catch a bad crossing.
        if (mask & ((uint256(1) << 16) - 1) == 0) mask |= uint256(1) << (maskSeed % 16);
        if (mask >> 16 == 0) mask |= uint256(1) << (16 + maskSeed % (numAssets - 16));

        for (uint256 n = 1; _bitCount(mask) < 3; ++n) {
            mask |= uint256(1) << (uint256(keccak256(abi.encode(maskSeed, n))) % numAssets);
        }

        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed);

        // Half the threshold or less, so the seizure works well down the list instead of being
        // satisfied by the first asset - otherwise there are no entries for the order to be about.
        p.dropPpb = bound(dropSeed, _minDropPpb(p.amounts), p.dropCeiling * 50 / 99);

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        // One entry has no adjacent pair, and the loop below would pass on nothing.
        vm.assume(plan.length > 1);

        for (uint256 j; j + 1 < plan.length; ++j) {
            assertLt(
                plan[j].index, plan[j + 1].index, "the plan does not walk the asset list in increasing order"
            );
        }
    }

    /// @notice The plan holds only what the borrower owns - plan[j].index in assetsIn || _reserved
    /// @dev The planner has to read the account's bitmap, not the market list.
    function testFuzz_planHoldsOnlyWhatTheBorrowerOwns(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 mask = _assetMask(maskSeed);

        // Thinned to every other index so a gap sits between every pair. A dense set would return
        // the same assets whichever list the planner read, and the run would prove nothing.
        mask &= maskSeed % 2 == 0
            ? 0x5555555555555555555555555555555555555555555555555555555555555555
            : 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
        if (mask == 0) mask = uint256(1) << (maskSeed % 2);

        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed);

        // On some runs somebody else fills the gaps, so the market carries totals for assets this
        // borrower never held. A planner reading those totals would reach for them here.
        if (_coinFlip(supplySeed, "second supplier")) {
            for (uint8 i; i < numAssets; ++i) {
                if (p.amounts[i] != 0) continue;

                ICometData.AssetInfo memory info = comet.getAssetInfo(i);
                uint256 amount = bound(
                    uint256(keccak256(abi.encode(supplySeed, "second supplier", i))),
                    uint256(info.scale) / 1000,
                    _supplyCeiling(info)
                );

                collaterals[i].allocateTo(secondSupplier, amount);

                vm.startPrank(secondSupplier);
                collaterals[i].approve(address(comet), amount);
                comet.supply(address(collaterals[i]), amount);
                vm.stopPrank();
            }
        }

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        // Read after the plan, which is the same thing here: nothing in this group absorbs.
        (,,, uint16 assetsIn, uint8 reservedBits) = comet.userBasic(borrower);

        for (uint256 j; j < plan.length; ++j) {
            assertTrue(
                _inBitmap(assetsIn, reservedBits, plan[j].index),
                "the plan reached for an asset the borrower does not hold"
            );
        }
    }

    /// @notice Address matches index - plan[j].asset = getAssetInfo(plan[j].index).asset
    /// @dev The index and the address must not drift apart.
    function testFuzz_addressMatchesIndex(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint256 mask = _assetMask(maskSeed);

        // Two assets sharing a scale and a price are always in the set: one index standing in for
        // the other gives a plan that is arithmetically perfect and still points at the wrong token.
        (uint8 twinA, uint8 twinB) = _confusableIndexes();
        mask |= (uint256(1) << twinA) | (uint256(1) << twinB);

        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed);
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        for (uint256 j; j < plan.length; ++j) {
            assertEq(
                plan[j].asset,
                comet.getAssetInfo(plan[j].index).asset,
                "the plan's asset address is not the one at its index"
            );
        }
    }

    /// @notice No empty entries - plan[j].seizedAmount > 0
    /// @dev An entry that takes nothing is junk the execution loop will still walk.
    function testFuzz_noEmptyEntries(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint256 mask = _assetMask(maskSeed);

        // Part of the set is pressed down to where pricing a deposit floors to nothing, which is
        // where a zero-sized entry would be written. A run with no dust in it proves nothing here.
        uint256 dustMask = mask & uint256(keccak256(abi.encode(supplySeed, "dust")));
        if (dustMask == 0) dustMask = mask & (~mask + 1);

        Bias memory bias;
        bias.dustMask = dustMask;

        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed, bias);
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        for (uint256 j; j < plan.length; ++j) {
            assertGt(plan[j].seizedAmount, 0, "the plan holds an entry that seizes nothing");
        }
    }

    /// @notice No duplicates - indexes are pairwise distinct
    /// @dev A second entry for the same asset would write off what is already gone.
    function testFuzz_noDuplicates(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        // A large debt and a deep fall together: either alone is settled by the first asset the loop
        // reaches, and only a travelling loop could write a repeat.
        Bias memory bias;
        bias.borrowFloorBps = 8_000;

        Position memory p = _boundPosition(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, bias);
        p.dropPpb = bound(dropSeed, _minDropPpb(p.amounts), p.dropCeiling * 50 / 99);

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        // One entry has no pair to be distinct.
        vm.assume(plan.length > 1);

        // Struck off in a set rather than compared pairwise: neighbours would only catch an adjacent
        // repeat, and would lean on the ordering invariant holding.
        uint256 seen;
        for (uint256 j; j < plan.length; ++j) {
            uint256 bit = uint256(1) << plan[j].index;

            assertEq(seen & bit, 0, "the plan seizes the same asset twice");
            seen |= bit;
        }
    }

    /// @notice The plan is no longer than the asset list - plan.length <= numAssets
    /// @dev The loop terminates, and the array length matches the entries actually filled.
    function testFuzz_planIsNoLongerThanTheAssetList(
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        // Every asset, no mask: a thinned set could not reach the limit even if the loop overran.
        uint8 numAssets = comet.numAssets();
        uint256 mask = (uint256(1) << numAssets) - 1;

        // A large debt and a crash: the seizure works through the whole list and stops only when it
        // runs out of assets, which is where an overrun would show.
        Bias memory bias;
        bias.borrowFloorBps = 9_000;

        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed, bias);
        p.dropPpb = bound(dropSeed, _minDropPpb(p.amounts), p.dropCeiling * 10 / 99);

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        assertLe(plan.length, numAssets, "the plan holds more entries than the market has assets");
    }

    /// @notice A non-seizable asset is not in the plan - LF = 0 → asset not in plan
    /// @dev Holds even once everything else is exhausted. The asset is stripped only after the
    ///      position is built, which is how governance dropping an asset plays out; which asset it
    ///      is comes from the seed, so no index is special.
    function testFuzz_nonSeizableAssetIsNotInThePlan(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 deadAmount,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 mask = _assetMask(maskSeed);

        // One asset to strip and at least one to leave standing, or there is nothing to exhaust.
        for (uint256 n = 1; _bitCount(mask) < 2; ++n) {
            mask |= uint256(1) << (uint256(keccak256(abi.encode(maskSeed, n))) % numAssets);
        }

        uint8 dead;
        {
            uint256 pick = maskSeed % _bitCount(mask);
            for (uint8 i; i < numAssets; ++i) {
                if (mask & (uint256(1) << i) == 0) continue;
                if (pick == 0) {
                    dead = i;
                    break;
                }
                --pick;
            }
        }

        // The draw never sees the asset about to be stripped: while the borrow is drawn it still
        // carries its factors, so the withdraw is accepted with room to spare, and by planning time
        // its liquidation factor is zero.
        Position memory p = _boundPosition(mask & ~(uint256(1) << dead), supplySeed, borrowAmount, dropSeed);

        // Below this the seizable collateral no longer covers the debt, so the seizure runs out and
        // the rest is written off - nothing left to take, one attractive asset standing right there.
        {
            uint256 badDebtDrop = p.borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            badDebtDrop = badDebtDrop * DROP_SCALE / p.seizable;
            vm.assume(badDebtDrop >= 100); // no room left below the boundary to drop the prices into

            p.dropPpb = bound(dropSeed, _minDropPpb(p.amounts), badDebtDrop * 99 / 100);
        }

        // Large, and its price never moves: surviving has to be the module refusing to touch it,
        // not the arithmetic valuing it at nothing.
        uint256 deadSupply;
        {
            ICometData.AssetInfo memory deadInfo = comet.getAssetInfo(dead);
            deadSupply = bound(
                deadAmount,
                uint256(deadInfo.scale) / 1000,
                _supplyCeiling(deadInfo)
            );
        }

        for (uint8 i; i < numAssets; ++i) {
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

        for (uint8 i; i < numAssets; ++i) {
            if (p.amounts[i] == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * p.dropPpb / DROP_SCALE;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        vm.startPrank(timelock);
        configurator.updateAssetBorrowCollateralFactor(address(cometProxy), address(collaterals[dead]), 0);
        configurator.updateAssetLiquidateCollateralFactor(address(cometProxy), address(collaterals[dead]), 0);
        configurator.updateAssetLiquidationFactor(address(cometProxy), address(collaterals[dead]), 0);
        vm.stopPrank();

        // Comet binds its module in the constructor and a module accepts one asset list for life,
        // so new configuration needs a new implementation and a new module behind it.
        dexAdapter =
            LiquidationModuleDeployer.deployAdapter(DEX_ROUTER, weth, DEX_SLIPPAGE_BPS, collateralAddresses());
        liquidationModule = LiquidationModuleDeployer.deployDefaultLiquidationModuleWithComet(
            moduleOpts(dexAdapter), address(cometProxy)
        );

        vm.startPrank(timelock);
        configurator.setLiquidationModule(address(cometProxy), address(liquidationModule));
        proxyAdmin.deployAndUpgradeTo(Deployable(address(configuratorProxy)), cometProxy);
        vm.stopPrank();

        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        ICoreLiquidationModule.Seizure[] memory plan = liquidationModule.seizurePlan(borrower);

        for (uint256 j; j < plan.length; ++j) {
            assertNotEq(plan[j].index, dead, "the plan reached for an asset with a zero liquidation factor");
        }
    }

    /// @notice The plan stops once the debt is covered - debt covered → plan ends
    /// @dev Built lopsided on purpose: the first asset the loop meets is worth several times the
    ///      debt, so there is no arithmetic reason to go further. Whether it stops anyway is the claim.
    function testFuzz_planStopsOnceTheDebtIsCovered(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 mask = _assetMask(maskSeed);

        // Something has to be left after the first asset for the plan to have stopped short of it.
        for (uint256 n = 1; _bitCount(mask) < 2; ++n) {
            mask |= uint256(1) << (uint256(keccak256(abi.encode(maskSeed, n))) % numAssets);
        }

        uint256 first = mask & (~mask + 1); // the lowest asset in the set, the one the loop meets first

        Bias memory bias;
        bias.topMask = first;
        bias.bottomMask = mask & ~first;
        bias.borrowCeilingBps = 2_000;

        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed, bias);

        ICometData.AssetInfo memory info = comet.getAssetInfo(_lowestIndex(first));

        // The fall has to leave the position liquidatable and still leave the first asset able to
        // cover the debt on its own, and those two pull against each other. Liquidatable means the
        // collateral falls short of the debt under the liquidate collateral factor; covering means it
        // clears the debt under the liquidation factor. Both hold only in the gap between the two
        // factors, so the floor is the multiplier at which that asset's own deposit, discounted by
        // its liquidation factor, still clears the debt.
        //
        // Read off that deposit and its price rather than recovered from the ceiling the chain left
        // behind: multiplying `dropCeiling` back up floors a second time, and the unit lost there is
        // a unit of headroom out of the gap - which is a real share of it whenever the gap is narrow.
        // The range starts halfway up so rounding at either end cannot push a run out of it.
        {
            uint256 coverageFloor = Math.ceilDiv(
                (p.borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale())
                    * DROP_SCALE * uint256(info.scale) * FACTOR_SCALE,
                p.amounts[_lowestIndex(first)] * comet.getPrice(info.priceFeed) * info.liquidationFactor
            );
            vm.assume(coverageFloor <= p.dropCeiling); // no gap between covering the debt and the threshold

            p.dropPpb = bound(dropSeed, (coverageFloor + p.dropCeiling) / 2, p.dropCeiling);
        }

        // Partial off, so the plan ends on the entry that closes the debt, not on a health target.
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, false);

        assertEq(plan.length, 1, "the plan did not stop at the asset that covered the debt");
        assertEq(uint256(1) << plan[0].index, first, "the plan did not start at the lowest asset held");

        // Both sides computed here rather than read off the module, which is the thing under test.
        uint256 perValueUnit = uint256(info.scale) * FACTOR_SCALE;
        uint256 price = comet.getPrice(info.priceFeed);

        uint256 debtValue = comet.borrowBalanceOf(borrower) * comet.getPrice(address(basePriceFeed)) / comet.baseScale();

        assertGe(
            plan[0].seizedAmount * price * info.liquidationFactor / perValueUnit,
            debtValue,
            "the single entry does not cover the debt it ended on"
        );

        // Without this the entry could take far more than closing the debt needs and still be green.
        assertLt(
            (plan[0].seizedAmount - 1) * price * info.liquidationFactor / perValueUnit,
            debtValue,
            "the entry seizes more than closing the debt requires"
        );

        // Not merely exhausted: the loop had the option of taking more and did not.
        assertLt(
            plan[0].seizedAmount,
            comet.collateralBalanceOf(borrower, plan[0].asset),
            "the plan emptied the first asset rather than stopping on it"
        );

        for (uint8 i; i < numAssets; ++i) {
            if (uint256(1) << i == first || p.amounts[i] == 0) continue;

            assertGt(
                comet.collateralBalanceOf(borrower, address(collaterals[i])),
                0,
                "an asset the plan skipped is not actually held"
            );
        }
    }

    /*//////////////////////////////////////////////////////////////
                            SHARED CHAIN
    //////////////////////////////////////////////////////////////*/

    /// @notice The set of collaterals, biased towards the indexes where a traversal goes wrong.
    /// @dev A draw that misses every boundary index has one forced on rather than being discarded,
    ///      which reshapes the run instead of throwing it away.
    function _assetMask(uint256 maskSeed) internal view override returns (uint256 mask) {
        uint8 numAssets = comet.numAssets();
        mask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);

        uint8[4] memory edges = [uint8(0), 15, 16, numAssets - 1];
        uint256 boundaries;
        for (uint256 e; e < edges.length; ++e) {
            boundaries |= uint256(1) << edges[e];
        }

        if (mask & boundaries == 0) mask |= uint256(1) << edges[maskSeed % 4];
    }

    /// @notice The group's own draw: `_boundPositionMask` with the `Bias` knobs this group needs.
    /// @dev `borrowLimit` and `liquidity` weigh the same deposits in different orders on purpose -
    ///      Comet gates the withdrawal in two divisions, the module fuses them into one, and each is
    ///      mirrored against its own consumer.
    function _boundPosition(uint256 mask, uint256 supplySeed, uint256 borrowAmount, uint256 dropSeed)
        internal
        view
        returns (Position memory)
    {
        Bias memory bias;
        return _boundPosition(mask, supplySeed, borrowAmount, dropSeed, bias);
    }

    function _boundPosition(
        uint256 mask,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        Bias memory bias
    ) internal view returns (Position memory p) {
        uint8 numAssets = comet.numAssets();
        uint256 basePrice = comet.getPrice(address(basePriceFeed));
        uint256 baseScale = comet.baseScale();

        p.amounts = new uint256[](numAssets);

        uint256 borrowLimit;
        uint256 liquidity;

        for (uint8 i; i < numAssets; ++i) {
            if (mask & (uint256(1) << i) == 0) continue;

            ICometData.AssetInfo memory info = comet.getAssetInfo(i);

            uint256 floor = uint256(info.scale) / 1000;
            uint256 ceiling = _supplyCeiling(info);

            // Dust is drawn under a ceiling that is itself drawn. Bounding flat into the range
            // below the thousandth lands in its top decade almost every time, nowhere near low
            // enough for a price to floor; moving the ceiling gives every order of magnitude a turn.
            if (bias.dustMask & (uint256(1) << i) != 0) {
                ceiling = floor >> bound(uint256(keccak256(abi.encode(supplySeed, "decade", i))), 0, 60);
                floor = 1;
            }

            // Pinning makes an asset certain to carry the position, or certain to be beside the point.
            if (bias.topMask & (uint256(1) << i) != 0) floor = ceiling;
            if (bias.bottomMask & (uint256(1) << i) != 0) ceiling = floor;

            uint256 amount =
                bound(uint256(keccak256(abi.encode(supplySeed, i))), floor, Math.max(ceiling, floor));
            p.amounts[i] = amount;

            uint256 price = comet.getPrice(info.priceFeed);

            uint256 weighted = amount * price / uint256(info.scale);
            borrowLimit += weighted * info.borrowCollateralFactor / FACTOR_SCALE;

            liquidity += amount * price * info.liquidateCollateralFactor / (uint256(info.scale) * FACTOR_SCALE);

            p.seizable += amount * price * info.liquidationFactor / (uint256(info.scale) * FACTOR_SCALE);
        }

        uint256 maxBorrow = borrowLimit * baseScale / basePrice;
        uint256 borrowFloor = Math.max(BASE_BORROW_MIN, maxBorrow * bias.borrowFloorBps / 10_000);
        uint256 borrowCeiling =
            bias.borrowCeilingBps == 0 ? maxBorrow : maxBorrow * bias.borrowCeilingBps / 10_000;

        vm.assume(borrowCeiling >= borrowFloor); // too cheap a set to reach the minimum borrow
        vm.assume(borrowCeiling <= baseToken.balanceOf(address(comet))); // more base than the market can lend

        p.borrow = bound(borrowAmount, borrowFloor, borrowCeiling);

        // Prices floor on the way down, so the fall always lands a shade lower than this says. A
        // percent of clearance covers that; the boundary itself belongs to its own invariant.
        uint256 maxDrop = (p.borrow * basePrice / baseScale) * DROP_SCALE / liquidity;
        vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

        p.dropCeiling = maxDrop * 99 / 100;
        p.dropPpb = bound(dropSeed, _minDropPpb(p.amounts), p.dropCeiling);
    }

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Two indexes whose assets are interchangeable on the numbers: same scale, same price.
    /// @dev Found on the market rather than named, so it follows whatever asset table is built. A
    ///      market without such a pair cannot state the invariant, so the absence is a failure.
    function _confusableIndexes() internal view returns (uint8, uint8) {
        uint8 numAssets = comet.numAssets();
        uint64[] memory scales = new uint64[](numAssets);
        uint256[] memory prices = new uint256[](numAssets);

        for (uint8 i; i < numAssets; ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            scales[i] = info.scale;
            prices[i] = comet.getPrice(info.priceFeed);
        }

        for (uint8 i; i < numAssets; ++i) {
            for (uint8 j = i + 1; j < numAssets; ++j) {
                if (scales[i] == scales[j] && prices[i] == prices[j]) return (i, j);
            }
        }

        revert("the market holds no two assets a swapped index could hide behind");
    }

    /// @dev The bitmap spans two `userBasic` fields: the first sixteen assets in `assetsIn`, the
    ///      rest in `_reserved`, which is not reserved in this Comet.
    function _inBitmap(uint16 assetsIn, uint8 reservedBits, uint8 i) internal pure returns (bool) {
        return i < 16 ? assetsIn & (uint16(1) << i) != 0 : reservedBits & (uint8(1) << (i - 16)) != 0;
    }

    /// @notice Splits runs in two on a seed already in hand, so a branch costs no extra argument.
    function _coinFlip(uint256 seed, string memory tag) internal pure returns (bool) {
        return uint256(keccak256(abi.encode(seed, tag))) % 2 == 0;
    }

    function _lowestIndex(uint256 mask) internal pure returns (uint8 i) {
        while (mask & 1 == 0) {
            mask >>= 1;
            ++i;
        }
    }

    function _bitCount(uint256 mask) internal pure returns (uint256 count) {
        while (mask != 0) {
            mask &= mask - 1;
            ++count;
        }
    }
}
