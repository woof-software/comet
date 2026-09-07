// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { Deployable } from "@comet-contracts/CometProxyAdmin.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModule } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModule.sol";

import { LiquidationModuleDeployer } from "../../helpers/LiquidationModuleDeployer.sol";
import { ProtocolFixture } from "../../helpers/ProtocolFixture.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Seizure plan structure
 * @notice One invariant per test: a single statement a counterexample can refute. The group checks
 *         the plan as an object rather than as arithmetic - order, composition, absence of
 *         duplicates and of junk.
 * @dev Nothing is executed here. Reading `seizurePlan` is the whole of it, so the scenarios are
 *      shorter than the groups either side of this one and no liquidator takes part: the actors are
 *      the borrower, the pauser and the base supplier from the fixture.
 *
 *      The collateral set is chosen by a mask, and the mask is biased towards boundary indexes on
 *      purpose. The plan walks the assets by number and Comet's bitmap is discontinuous at 15/16 -
 *      the first sixteen assets live in `assetsIn` and the rest in `_reserved` - so a traversal bug
 *      is far likelier to show at the ends of those two words than in the middle. Leaving that to an
 *      unbiased draw would spend most runs where nothing is at stake.
 *
 *      The bound chain and the scenario the group shares are in `_boundPosition` and `_baseScenario`.
 *      A test that needs a narrower slice of the range redraws from the fields the chain leaves on
 *      the `Position` rather than repeating the chain. A run that cannot be built - too little
 *      collateral to reach the minimum borrow, more base than the market holds, no room left to drop
 *      the price into - is rejected rather than passed, so a vacuous run is never counted as a
 *      checked one.
 *
 *      `_baseScenario` deliberately does not assert that the plan holds anything. An empty plan for a
 *      liquidatable account is a claim about composition, and it belongs to the test that makes it
 *      rather than to the scaffolding every test stands on.
 */
contract SeizurePlanFuzzTest is ProtocolFixture {
    uint256 internal constant BASE_LIQUIDITY = 1e18;

    address internal borrower = alice;
    address internal baseSupplier = charlie;
    address internal secondSupplier = makeAddr("secondSupplier");

    /// @dev `dropCeiling` is the top of the drawable range, for the invariants that need a plan which
    ///      stops early and redraw the drop into the shallow end against it. `seizable` is read by the
    ///      non-seizable-asset invariant, which redraws the drop into the slice where the collateral
    ///      runs out altogether.
    struct Position {
        uint256[] amounts;
        uint256 borrow;
        uint256 dropBps;
        uint256 seizable;
        uint256 dropCeiling;
    }

    /// @dev What a test asks the shared chain to aim at. Every field is off at zero, so a test
    ///      declares an empty one and sets only what it needs. `dustMask` presses deposits far below
    ///      a thousandth of a unit; `topMask` and `bottomMask` pin them to the ends of their range;
    ///      the two borrow fields cut the borrow range down to a slice of what the collateral carries.
    struct Bias {
        uint256 dustMask;
        uint256 topMask;
        uint256 bottomMask;
        uint256 borrowFloorBps;
        uint256 borrowCeilingBps;
    }

    function setUp() public {
        prepareFixture();

        baseToken.allocateTo(baseSupplier, BASE_LIQUIDITY);
        vm.startPrank(baseSupplier);
        baseToken.approve(address(comet), type(uint256).max);
        comet.supply(address(baseToken), BASE_LIQUIDITY);
        vm.stopPrank();
    }

    /**
     * @notice Indexes are increasing - plan[j].index < plan[j+1].index
     * @dev Invariant. The plan walks assets in list order rather than an arbitrary one: the order
     *      decides what gets seized first and must be predictable.
     */
    function testFuzz_indexesAreIncreasing(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 mask = _assetMask(maskSeed);

        // Order is a claim about pairs, so the set is widened rather than discarded when the draw is
        // too thin to make one. Assets are needed on both sides of the 15/16 seam first - a plan that
        // stays inside one word of the bitmap cannot catch a traversal that crosses them in the wrong
        // order - and then the set is topped up until three assets are in it.
        if (mask & ((uint256(1) << 16) - 1) == 0) mask |= uint256(1) << (maskSeed % 16);
        if (mask >> 16 == 0) mask |= uint256(1) << (16 + maskSeed % (numAssets - 16));

        for (uint256 n = 1; _bitCount(mask) < 3; ++n) {
            mask |= uint256(1) << (uint256(keccak256(abi.encode(maskSeed, n))) % numAssets);
        }

        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed);

        // Half the threshold or less. The collateral is worth so much less than the debt that the
        // seizure works its way well down the list instead of being satisfied by the first asset it
        // reaches, which is what puts entries in the plan for the ordering to be about.
        p.dropBps = bound(dropSeed, 1, p.dropCeiling * 50 / 99);

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        // A plan of one entry has no adjacent pair and would pass on an empty loop.
        vm.assume(plan.length > 1);

        for (uint256 j; j + 1 < plan.length; ++j) {
            assertLt(
                plan[j].index, plan[j + 1].index, "the plan does not walk the asset list in increasing order"
            );
        }
    }

    /**
     * @notice The plan holds only what the borrower owns - plan[j].index in assetsIn || _reserved
     * @dev Invariant. The planner cannot pick an asset the account does not hold: it reads the
     *      bitmap, not the market list.
     */
    function testFuzz_planHoldsOnlyWhatTheBorrowerOwns(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 mask = _assetMask(maskSeed);

        // Thinned to every other index, so an unoccupied asset sits between every pair of occupied
        // ones. A dense set has no gap for the planner to fall into: reading the market list instead
        // of the bitmap would return the same assets either way and the run would prove nothing.
        // Which half of the list the gaps fall on comes from the seed, so neither is left untried.
        mask &= maskSeed % 2 == 0
            ? 0x5555555555555555555555555555555555555555555555555555555555555555
            : 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
        if (mask == 0) mask = uint256(1) << (maskSeed % 2);

        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed);

        // On some runs the gaps are filled in by somebody else, so the market carries a total for
        // assets this borrower has never held. A planner reading those totals rather than the
        // account's own bitmap would reach for them here.
        if (_coinFlip(supplySeed, "second supplier")) {
            for (uint8 i; i < numAssets; ++i) {
                if (p.amounts[i] != 0) continue;

                ICometData.AssetInfo memory info = comet.getAssetInfo(i);
                uint256 amount = bound(
                    uint256(keccak256(abi.encode(supplySeed, "second supplier", i))),
                    uint256(info.scale) / 1000,
                    Math.min(1_000_000 * uint256(info.scale), info.supplyCap)
                );

                collaterals[i].allocateTo(secondSupplier, amount);

                vm.startPrank(secondSupplier);
                collaterals[i].approve(address(comet), amount);
                comet.supply(address(collaterals[i]), amount);
                vm.stopPrank();
            }
        }

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        // Read after the plan rather than before it, which is the same thing here: reading a plan is
        // a view call and nothing in this group absorbs, so the bitmap cannot have moved in between.
        (,,, uint16 assetsIn, uint8 reservedBits) = comet.userBasic(borrower);

        for (uint256 j; j < plan.length; ++j) {
            assertTrue(
                _inBitmap(assetsIn, reservedBits, plan[j].index),
                "the plan reached for an asset the borrower does not hold"
            );
        }
    }

    /**
     * @notice Address matches index - plan[j].asset = getAssetInfo(plan[j].index).asset
     * @dev Invariant. The asset address in a plan entry is exactly the one sitting at that index in
     *      the market list. The index/address pair does not drift apart.
     */
    function testFuzz_addressMatchesIndex(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint256 mask = _assetMask(maskSeed);

        // A pair the amounts cannot tell apart is put in the position on every run. Where two assets
        // share a scale and a price, one index standing in for the other produces a plan that is
        // arithmetically perfect and still points at the wrong token, which is the only way this can
        // go wrong quietly.
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

    /**
     * @notice No empty entries - plan[j].seizedAmount > 0
     * @dev Invariant. The plan contains no zero-sized seizures: an entry that takes nothing is junk
     *      that will later be walked by the execution loop.
     */
    function testFuzz_noEmptyEntries(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        uint256 mask = _assetMask(maskSeed);

        // Some of the set is pressed to the bottom of its range, where a deposit is worth so little
        // that pricing it floors to nothing. Which ones comes from the seed the deposits already come
        // from; if the draw picks none, the lowest asset in the set is pressed down instead, because
        // a run with no dust in it cannot say anything about empty entries.
        uint256 dustMask = mask & uint256(keccak256(abi.encode(supplySeed, "dust")));
        if (dustMask == 0) dustMask = mask & (~mask + 1);

        // The whole drop range. Deep in it the small deposits reprice to nothing at all, which is
        // where an entry claiming to take zero of them would be written.
        Bias memory bias;
        bias.dustMask = dustMask;

        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed, bias);
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        for (uint256 j; j < plan.length; ++j) {
            assertGt(plan[j].seizedAmount, 0, "the plan holds an entry that seizes nothing");
        }
    }

    /**
     * @notice No duplicates - indexes are pairwise distinct
     * @dev Invariant. One asset cannot be seized twice in a single plan: the second entry would write
     *      off what is already gone.
     */
    function testFuzz_noDuplicates(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        // A debt in the top fifth of what the collateral carries, against prices at half the
        // threshold or below. Neither on its own is enough: a large debt with a shallow drop is
        // settled by the first asset the loop reaches, and a deep drop with a small debt likewise.
        // Together they make the loop travel, which is the only way a repeat could be written.
        Bias memory bias;
        bias.borrowFloorBps = 8_000;

        Position memory p = _boundPosition(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, bias);
        p.dropBps = bound(dropSeed, 1, p.dropCeiling * 50 / 99);

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        // A plan of one entry has no pair to be distinct and would pass on an empty claim.
        vm.assume(plan.length > 1);

        // Each index is struck off as it is met. Kept independent of the order the plan arrives in,
        // because comparing neighbours would only catch a repeat that happens to be adjacent and
        // would quietly lean on the ordering invariant holding.
        uint256 seen;
        for (uint256 j; j < plan.length; ++j) {
            uint256 bit = uint256(1) << plan[j].index;

            assertEq(seen & bit, 0, "the plan seizes the same asset twice");
            seen |= bit;
        }
    }

    /**
     * @notice The plan is no longer than the asset list - plan.length <= numAssets
     * @dev Invariant. The number of seizures does not exceed the number of market assets: the loop
     *      terminates, and the array length matches the entries actually filled.
     */
    function testFuzz_planIsNoLongerThanTheAssetList(
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        // Every asset on the market, so there is no mask seed to draw. A length bound is a claim
        // about the largest plan the module can produce, and the largest plan needs the fullest
        // position - a set the mask thinned out could not reach the limit even if the loop overran
        // it.
        uint8 numAssets = comet.numAssets();
        uint256 mask = (uint256(1) << numAssets) - 1;

        // A debt in the top tenth of what the collateral carries, against a crash that leaves prices
        // at a tenth of the threshold or less. Nothing survives that: the seizure works through the
        // whole list and stops only when it runs out of assets, which is where an overrun would show.
        Bias memory bias;
        bias.borrowFloorBps = 9_000;

        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed, bias);
        p.dropBps = bound(dropSeed, 1, p.dropCeiling * 10 / 99);

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        assertLe(plan.length, numAssets, "the plan holds more entries than the market has assets");
    }

    /**
     * @notice A non-seizable asset is not in the plan - LF = 0 → asset not in plan
     * @dev Invariant. An asset with a zero liquidation factor never enters the plan, not even when
     *      everything else is exhausted and the protocol goes into bad debt.
     *
     *      The market is the ordinary one and the position is built the ordinary way. Only afterwards
     *      does one of the assets the borrower is already standing on lose its factors, on a market
     *      that already holds the position - which is what governance stripping an asset it no longer
     *      wants to lend against actually looks like. Which asset it is comes from the mask seed, so
     *      no index is special and none is left untried.
     */
    function testFuzz_nonSeizableAssetIsNotInThePlan(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 deadAmount,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 mask = _assetMask(maskSeed);

        // One asset to strip and at least one to leave standing. A position on the stripped asset
        // alone has nothing for the seizure to exhaust first.
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

        // The chain sees the position without the asset that is about to be stripped. That is right on
        // either side: the asset still carries its factors while the borrow is drawn, so the real
        // borrowing power is larger than the chain's and the withdraw is accepted with room to spare,
        // and its liquidation factor is zero by the time anything is planned.
        Position memory p = _boundPosition(mask & ~(uint256(1) << dead), supplySeed, borrowAmount, dropSeed);

        // Below this multiplier every seizable unit taken together no longer covers the debt, so the
        // seizure runs out of collateral it may touch and the rest is written off. That is the state
        // the invariant is about: nothing left to take, and one attractive asset standing right there.
        {
            uint256 badDebtDrop = p.borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            badDebtDrop = badDebtDrop * 10_000 / p.seizable;
            vm.assume(badDebtDrop >= 100); // no room left below the boundary to drop the prices into

            p.dropBps = bound(dropSeed, 1, badDebtDrop * 99 / 100);
        }

        // Large on purpose, and its price never moves. The asset has to look well worth taking, so
        // that surviving is the module refusing to touch it rather than the arithmetic quietly
        // valuing it at nothing.
        uint256 deadSupply;
        {
            ICometData.AssetInfo memory deadInfo = comet.getAssetInfo(dead);
            deadSupply = bound(
                deadAmount,
                uint256(deadInfo.scale) / 1000,
                Math.min(1_000_000 * uint256(deadInfo.scale), deadInfo.supplyCap)
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

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * p.dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        vm.startPrank(timelock);
        configurator.updateAssetBorrowCollateralFactor(address(cometProxy), address(collaterals[dead]), 0);
        configurator.updateAssetLiquidateCollateralFactor(address(cometProxy), address(collaterals[dead]), 0);
        configurator.updateAssetLiquidationFactor(address(cometProxy), address(collaterals[dead]), 0);
        vm.stopPrank();

        // A Comet binds its module for good in the constructor and a module accepts one asset list in
        // its lifetime, so new configuration means a new implementation and a new module behind it.
        // `LiquidationModuleForComet` is the one meant for this: it takes the live proxy in its
        // constructor, which is how a market that is already running gets upgraded.
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

    /**
     * @notice The plan stops once the debt is covered - debt covered → plan ends
     * @dev Invariant. As soon as the debt is covered, seizures stop: later assets do not enter the
     *      plan even though the borrower holds them.
     *
     *      The position is built lopsided on purpose. The lowest asset in the set is pinned to the top
     *      of its range and everything after it to the bottom, the borrow is held to a fifth of what
     *      the set can carry, and the drop is shallow - so the first asset the loop meets is worth
     *      several times the debt and there is no arithmetic reason to go further. Whether the loop
     *      stops anyway is the claim.
     */
    function testFuzz_planStopsOnceTheDebtIsCovered(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        uint8 numAssets = comet.numAssets();
        uint256 mask = _assetMask(maskSeed);

        // Something has to be left after the first asset for the plan to have stopped short of.
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

        // The drop has to leave the position liquidatable and still leave the first asset able to
        // cover the debt on its own, and those two pull against each other. Liquidatable means the
        // collateral falls short of the debt under the liquidate collateral factor; covering means it
        // clears the debt under the liquidation factor. Both hold only in the gap between the two
        // factors, which is why the floor is that ratio rather than a percentage picked by hand - and
        // why it is read off the asset that has to do the covering. The range starts halfway up the
        // gap so rounding at either end cannot push a run out of it.
        {
            uint256 threshold = p.dropCeiling * 100 / 99;
            uint256 coverageFloor =
                threshold * info.liquidateCollateralFactor / info.liquidationFactor;

            p.dropBps = bound(dropSeed, (coverageFloor + p.dropCeiling) / 2, p.dropCeiling);
        }

        // Partial liquidation off, so the debt-closing branch is the one taken and the plan has to
        // end on the entry that closes it rather than on a health target.
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, false);

        assertEq(plan.length, 1, "the plan did not stop at the asset that covered the debt");
        assertEq(uint256(1) << plan[0].index, first, "the plan did not start at the lowest asset held");

        // What the seizure is worth against what is owed, both computed here. The debt comes from the
        // borrow balance and the base price; the credit comes from the amount the plan takes, priced
        // and discounted by the asset's liquidation factor. Neither is read off the module.
        uint256 perValueUnit = uint256(info.scale) * FACTOR_SCALE;
        uint256 price = comet.getPrice(info.priceFeed);

        uint256 debtValue = comet.borrowBalanceOf(borrower) * comet.getPrice(address(basePriceFeed))
            / comet.baseScale();

        assertGe(
            plan[0].seizedAmount * price * info.liquidationFactor / perValueUnit,
            debtValue,
            "the single entry does not cover the debt it ended on"
        );

        // One unit less would not have covered it. Without this the entry could be taking far more
        // than closing the debt requires and the test above would still be green.
        assertLt(
            (plan[0].seizedAmount - 1) * price * info.liquidationFactor / perValueUnit,
            debtValue,
            "the entry seizes more than closing the debt requires"
        );

        // The asset was not merely exhausted - the loop had the option of taking more from it and did
        // not - and everything after it is still on the balance untouched.
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

    /**
     * @notice The set of collaterals the position stands on, one bit per asset, weighted towards the
     *         indexes where a traversal goes wrong.
     * @dev Bounded away from zero, because a position on nothing has no plan to state anything about.
     *      A draw that misses every boundary index has one forced on rather than being discarded:
     *      that reshapes the run instead of throwing it away, and it leaves the rest of the set
     *      exactly as the seed drew it.
     */
    function _assetMask(uint256 maskSeed) internal view returns (uint256 mask) {
        uint8 numAssets = comet.numAssets();
        mask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);

        uint8[4] memory edges = [uint8(0), 15, 16, numAssets - 1];
        uint256 boundaries;
        for (uint256 e; e < edges.length; ++e) {
            boundaries |= uint256(1) << edges[e];
        }

        if (mask & boundaries == 0) mask |= uint256(1) << edges[maskSeed % 4];
    }

    /**
     * @notice The deposits for the selected set, the largest borrow the market will accept against
     *         them, and a price drop that lands the position below the liquidation threshold.
     * @dev The two weighted sums are deliberately computed in different orders, because two different
     *      contracts consume them. `borrowLimit` decides whether `withdraw` is accepted, and Comet's
     *      `_getCollaterizedLiquidity` prices and weights in two separate divisions; `liquidity`
     *      decides whether the position is liquidatable, and the module's `_getLiquidity` fuses both
     *      into one, on purpose - pricing and weighting separately truncates the balance twice.
     *      Mirroring each against the code that reads it is what keeps the top of the borrow range
     *      acceptable and the drop on the right side of the module's own threshold.
     *
     *      The knobs in `Bias` are all off at zero, so a test that wants one declares an empty struct
     *      and sets the single field it cares about. They exist because several invariants need the
     *      same chain aimed at a different corner of it, and repeating the chain per corner is how the
     *      two halves drift apart.
     */
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

            // One seed for the whole set, one clamp per asset: the deposit is no less than a
            // thousandth of a unit and no more than a million units or the asset's supply cap,
            // whichever binds first, or the range below that thousandth where the asset was named as
            // dust. The scale is widened before it is multiplied, because the asset table's scales
            // overflow their own uint64 at a million units.
            uint256 floor = uint256(info.scale) / 1000;
            uint256 ceiling = Math.min(1_000_000 * uint256(info.scale), info.supplyCap);

            // A dust deposit is drawn under a ceiling that is itself drawn, that thousandth shifted
            // down by up to sixty bits. Bounding flat into the range below it would not do: the range
            // spans fifteen decimal places on an eighteen-decimal asset and a flat draw lands in the
            // top one almost every time, nowhere near low enough for the price to floor. Moving the
            // ceiling instead gives every order of magnitude a turn.
            if (bias.dustMask & (uint256(1) << i) != 0) {
                ceiling = floor >> bound(uint256(keccak256(abi.encode(supplySeed, "decade", i))), 0, 60);
                floor = 1;
            }

            // Pinning collapses the range onto one of its own ends, so an asset can be made certain
            // to carry the position or certain to be beside the point.
            if (bias.topMask & (uint256(1) << i) != 0) floor = ceiling;
            if (bias.bottomMask & (uint256(1) << i) != 0) ceiling = floor;

            uint256 amount =
                bound(uint256(keccak256(abi.encode(supplySeed, i))), floor, Math.max(ceiling, floor));
            p.amounts[i] = amount;

            uint256 price = comet.getPrice(info.priceFeed);

            // What the deposit is worth, then the same worth under the borrow collateral factor,
            // which sets how much can be drawn against it.
            uint256 weighted = amount * price / uint256(info.scale);
            borrowLimit += weighted * info.borrowCollateralFactor / FACTOR_SCALE;

            // How far the price may fall before the deposit stops covering the debt.
            liquidity += amount * price * info.liquidateCollateralFactor / (uint256(info.scale) * FACTOR_SCALE);

            // What a seizure could recover from this asset if it took all of it. Weighted by the
            // liquidation factor rather than the liquidate collateral factor, it is the line between
            // a seizure that covers the debt and one that runs out of collateral.
            p.seizable += amount * price * info.liquidationFactor / (uint256(info.scale) * FACTOR_SCALE);
        }

        uint256 maxBorrow = borrowLimit * baseScale / basePrice;
        uint256 borrowFloor = Math.max(comet.baseBorrowMin(), maxBorrow * bias.borrowFloorBps / 10_000);
        uint256 borrowCeiling =
            bias.borrowCeilingBps == 0 ? maxBorrow : maxBorrow * bias.borrowCeilingBps / 10_000;

        vm.assume(borrowCeiling >= borrowFloor); // too cheap a set to reach the minimum borrow
        vm.assume(borrowCeiling <= baseToken.balanceOf(address(comet))); // more base than the market can lend

        p.borrow = bound(borrowAmount, borrowFloor, borrowCeiling);

        // The multiplier at which the debt value meets the liquidation-weighted collateral, in basis
        // points of where the prices stand now. Every selected price is floored on the way down, so
        // the drop only ever lands lower than this arithmetic says, and a percent of clearance covers
        // it - the boundary itself belongs to its own invariant.
        uint256 maxDrop = (p.borrow * basePrice / baseScale) * 10_000 / liquidity;
        vm.assume(maxDrop >= 100); // no room left below the boundary to drop the prices into

        p.dropCeiling = maxDrop * 99 / 100;
        p.dropBps = bound(dropSeed, 1, p.dropCeiling);
    }

    /**
     * @notice The scenario the group shares: the borrower supplies the set, draws the base, the mode
     *         is set, the selected prices fall, and the plan is read.
     * @dev The plan is read against a market that has not moved since the prices were written - no
     *      warp, no second reprice - so what a test inspects is what the module would execute.
     */
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

        // Only the selected feeds move. What the mask left out keeps its price.
        for (uint8 i; i < numAssets; ++i) {
            if (p.amounts[i] == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * p.dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(dropped), 0, 0, 0);
        }

        // Holds by construction of the bounds above. If it ever does not, the bounds are wrong and
        // the run must not pass quietly.
        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        plan = liquidationModule.seizurePlan(borrower);
    }

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Two indexes whose assets are interchangeable on the numbers: same scale, same price.
     * @dev Found on the market rather than named, so the pair follows whatever asset table the
     *      fixture is built with. A market that holds no such pair cannot state the invariant this
     *      serves - a swapped index would show up in the amounts - so the absence is a failure rather
     *      than something to work around.
     */
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

    /// @dev The bitmap is split across two of `userBasic`'s fields: the first sixteen assets live in
    ///      `assetsIn`, the rest in `_reserved`, which is not reserved in this Comet.
    function _inBitmap(uint16 assetsIn, uint8 reservedBits, uint8 i) internal pure returns (bool) {
        return i < 16 ? assetsIn & (uint16(1) << i) != 0 : reservedBits & (uint8(1) << (i - 16)) != 0;
    }

    /// Splits the runs of a test in two on a seed it is already drawing from, so a branch the group
    /// wants both sides of does not cost an argument.
    function _coinFlip(uint256 seed, string memory tag) internal pure returns (bool) {
        return uint256(keccak256(abi.encode(seed, tag))) % 2 == 0;
    }

    /// The index of the lowest asset in a mask.
    function _lowestIndex(uint256 mask) internal pure returns (uint8 i) {
        while (mask & 1 == 0) {
            mask >>= 1;
            ++i;
        }
    }

    /// How many assets the mask selected, which is how many the borrower supplied.
    function _bitCount(uint256 mask) internal pure returns (uint256 count) {
        while (mask != 0) {
            mask &= mask - 1;
            ++count;
        }
    }
}
