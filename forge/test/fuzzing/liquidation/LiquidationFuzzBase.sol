// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModule } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModule.sol";

import { ProtocolFixture } from "../../helpers/ProtocolFixture.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice What the liquidation fuzz suites share: the actors, the position they draw, and the
///         scenario that builds it.
abstract contract LiquidationFuzzBase is ProtocolFixture {
    /// @notice Unit a price fall is expressed in. `DROP_SCALE` leaves the price where it is.
    /// @dev Parts per billion, not basis points: a small debt against a large deposit needs a fall
    ///      finer than one basis point, and those positions could not be built at all.
    uint256 internal constant DROP_SCALE = 1e9;

    /*//////////////////////////////////////////////////////////////
                                 ACTORS
    //////////////////////////////////////////////////////////////*/

    address internal borrower = alice;
    address internal liquidator = bob;
    address internal baseSupplier = charlie;
    address internal secondSupplier = makeAddr("secondSupplier");

    /*//////////////////////////////////////////////////////////////
                                POSITION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice The position a test is about to build.
     * @param amounts     how much to supply of each collateral, by asset index; zero means untouched
     * @param borrow      how much base to draw against them
     * @param dropPpb     what to multiply the selected prices by, in parts of `DROP_SCALE`
     * @param seizable    what a seizure could recover from the whole position
     * @param dropCeiling top of the range `dropPpb` came from, for tests that want a narrower slice
     */
    struct Position {
        uint256[] amounts;
        uint256 borrow;
        uint256 dropPpb;
        uint256 seizable;
        uint256 dropCeiling;
    }

    /*//////////////////////////////////////////////////////////////
                         BOUNDS: A SET OF ASSETS
    //////////////////////////////////////////////////////////////*/

    /// @notice The set of collaterals a position stands on, one bit per asset.
    /// @dev Virtual so a group can bias the draw towards the indexes it cares about, instead of
    ///      bounding a second mask beside this one and letting the two drift apart.
    function _assetMask(uint256 maskSeed) internal view virtual returns (uint256) {
        return bound(maskSeed, 1, (uint256(1) << comet.numAssets()) - 1);
    }

    /// @notice The largest deposit an asset can still take.
    /// @dev Measured against what the market already holds: the fixture seeds every collateral, so
    ///      ignoring that would draw a deposit Comet rejects.
    function _supplyCeiling(ICometData.AssetInfo memory info) internal view returns (uint256) {
        (uint128 totalSupplyAsset,) = comet.totalsCollateral(info.asset);

        return Math.min(1_000_000 * uint256(info.scale), uint256(info.supplyCap) - uint256(totalSupplyAsset));
    }

    /// @notice The smallest fall that still leaves every selected price above zero.
    /// @dev Comet rejects a zero price outright, and at a billionth resolution the cheapest assets
    ///      reach zero before the range runs out. One multiplier moves the whole set, so the
    ///      cheapest selected price sets the floor.
    function _minDropPpb(uint256[] memory amounts) internal view returns (uint256 floor) {
        floor = 1;

        for (uint8 i; i < amounts.length; ++i) {
            if (amounts[i] == 0) continue;

            uint256 need = Math.ceilDiv(DROP_SCALE, comet.getPrice(address(collateralPriceFeeds[i])));
            if (need > floor) floor = need;
        }
    }

    /// @notice The smallest deposit of this asset that can carry `debt` of base.
    /// @dev Inverted step by step rather than in one division: the forward chain floors three times,
    ///      and a deposit a unit short is a `withdraw` that reverts instead of a run that is skipped.
    function _supplyForDebt(ICometData.AssetInfo memory info, uint256 debt) internal view returns (uint256) {
        uint256 value = Math.ceilDiv(debt * comet.getPrice(comet.baseTokenPriceFeed()), comet.baseScale()) + 1;
        value = Math.ceilDiv(value * FACTOR_SCALE, uint256(info.borrowCollateralFactor)) + 1;

        return Math.ceilDiv(value * uint256(info.scale), comet.getPrice(info.priceFeed)) + 1;
    }

    /**
     * @notice Draws a position on the selected set: deposits, debt, and a fall that leaves it
     *         liquidatable.
     * @dev `borrowLimit` and `liquidity` weigh the same deposits in different orders on purpose.
     *      Comet's `_getCollaterizedLiquidity` gates the withdrawal in two divisions, the module's
     *      `_getLiquidity` fuses them into one; mirroring each against its own consumer keeps the top
     *      of the borrow range acceptable and the fall on the right side of the threshold.
     * @param borrowFloorBps Lifts the borrow floor to that fraction of the ceiling, for invariants
     *        that need a debt with no slack. Zero draws from the whole range.
     */
    function _boundPositionMask(
        uint256 mask,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        uint256 borrowFloorBps
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

            // The thousandth of a unit earns its place: a deposit that small is worth almost nothing
            // against the debt, so the plan reaches for all of it and runs into the end of the balance.
            uint256 amount = bound(
                uint256(keccak256(abi.encode(supplySeed, i))),
                uint256(info.scale) / 1000,
                _supplyCeiling(info)
            );
            p.amounts[i] = amount;

            uint256 price = comet.getPrice(info.priceFeed);

            uint256 weighted = amount * price / uint256(info.scale);
            borrowLimit += weighted * info.borrowCollateralFactor / FACTOR_SCALE;

            liquidity += amount * price * info.liquidateCollateralFactor / (uint256(info.scale) * FACTOR_SCALE);

            p.seizable += amount * price * info.liquidationFactor / (uint256(info.scale) * FACTOR_SCALE);
        }

        if (borrowFloorBps == 0) {
            uint256 maxBorrow = borrowLimit * baseScale / basePrice;
            vm.assume(maxBorrow >= BASE_BORROW_MIN); // too cheap a set to reach the minimum borrow
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            p.borrow = bound(borrowAmount, BASE_BORROW_MIN, maxBorrow);
        } else {
            uint256 maxBorrow = borrowLimit * baseScale / basePrice;
            uint256 borrowFloor = Math.max(BASE_BORROW_MIN, maxBorrow * borrowFloorBps / 10_000);
            vm.assume(maxBorrow >= borrowFloor); // too cheap a set to reach the minimum borrow
            vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

            p.borrow = bound(borrowAmount, borrowFloor, maxBorrow);
        }

        // Prices floor on the way down, so the fall always lands a shade lower than this says. A
        // percent of clearance covers that; the boundary itself belongs to its own invariant.
        uint256 maxDrop = (p.borrow * basePrice / baseScale) * DROP_SCALE / liquidity;
        vm.assume(maxDrop >= 100); // no room left below the boundary to fall into

        p.dropCeiling = maxDrop * 99 / 100;
        p.dropPpb = bound(dropSeed, _minDropPpb(p.amounts), p.dropCeiling);
    }

    /// @notice Builds the position and reads the plan: supply, borrow, set the mode, drop the prices.
    /// @dev Nothing moves between the plan and the absorb that follows, so what a test inspects is
    ///      what the module executes.
    function _baseScenario(Position memory p, bool partialEnabled)
        internal
        returns (ICoreLiquidationModule.Seizure[] memory plan)
    {
        uint8 numAssets = comet.numAssets();

        for (uint8 i; i < numAssets; ++i) {
            if (p.amounts[i] == 0) continue;

            collaterals[i].allocateTo(borrower, p.amounts[i]);

            vm.startPrank(borrower);
            collaterals[i].approve(address(comet), p.amounts[i]);
            comet.supply(address(collaterals[i]), p.amounts[i]);
            vm.stopPrank();
        }

        vm.prank(borrower);
        comet.withdraw(address(baseToken), p.borrow);

        if (liquidationModule.partialLiquidationEnabled() != partialEnabled) {
            vm.prank(pauser);
            liquidationModule.liquidationModeToggle(partialEnabled);
        }

        // Only the selected feeds move, which is what lets a second account stand on an untouched
        // asset and stay healthy across the absorb.
        for (uint8 i; i < numAssets; ++i) {
            if (p.amounts[i] == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * p.dropPpb / DROP_SCALE;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        // Both hold by construction of the bounds. An empty plan would let every loop over it pass
        // on nothing, so it is caught here rather than in each invariant that walks the plan.
        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        plan = liquidationModule.seizurePlan(borrower);
        assertGt(plan.length, 0, "the position built seizes nothing");
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    function _absorb() internal {
        address[] memory accounts = new address[](1);
        accounts[0] = borrower;

        vm.prank(liquidator);
        comet.absorb(liquidator, accounts);
    }
}
