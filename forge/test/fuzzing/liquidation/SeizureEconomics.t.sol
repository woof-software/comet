// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { Vm } from "forge-std/Vm.sol";

import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICometLiquidationInterface } from "@comet-contracts/interfaces/ICometLiquidationInterface.sol";
import { ICoreLiquidationModule } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModule.sol";

import { ProtocolFixture } from "../../helpers/ProtocolFixture.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Seizure economics
 * @notice One invariant per test: a single statement a counterexample can refute. The group checks
 *         that what was taken matches what was written off, in value terms.
 * @dev It borders on differential verification but does not replace it. Every statement here is
 *      about the relation between quantities inside a single call - what the plan took against what
 *      the debt did - and none of them is a claim that the module agrees with an independent model
 *      of what it should have taken.
 *
 *      The market is not the fixture's. The asset table is taken over and given a scale nothing in
 *      production uses, because inconsistent rounding surfaces precisely on non-standard scales: a
 *      conversion that quietly assumes eighteen decimals, or one that divides by a scale it should
 *      have multiplied by, lands on the right answer for a 6/8/18 table often enough to survive a
 *      whole suite. The mask is drawn freely but is guaranteed to reach one of those odd assets, so
 *      no run is spent entirely on the scales that hide the bug.
 *
 *      Actors: the borrower, the liquidator (sends the transaction and is passed as the absorber
 *      argument), the pauser, the base supplier from the fixture.
 *
 *      The bound chain and the scenario the group shares are in `_boundPosition` and `_baseScenario`.
 *      A test that needs a narrower slice of the range redraws from the fields the chain leaves on
 *      the `Position` rather than repeating the chain. A run that cannot be built - too little
 *      collateral to reach the minimum borrow, more base than the market holds, no room left to drop
 *      the price into - is rejected rather than passed, so a vacuous run is never counted as a
 *      checked one.
 */
contract SeizureEconomicsFuzzTest is ProtocolFixture {
    uint256 internal constant BASE_LIQUIDITY = 1e18;

    address internal borrower = alice;
    address internal liquidator = bob;
    address internal baseSupplier = charlie;

    /// @dev `seizable` is what a seizure could recover if it took the whole position, which is the
    ///      line between a seizure that covers the debt and one that runs out of collateral.
    ///      `dropCeiling` is the top of the drawable range, for the tests that need the collateral to
    ///      still cover the debt and redraw the drop into the shallow end against it.
    struct Position {
        uint256[] amounts;
        uint256 borrow;
        uint256 dropBps;
        uint256 seizable;
        uint256 dropCeiling;
    }

    function setUp() public {
        prepareFixture();

        // Every price is nudged off the round dollar it was deployed at. The fixture prices whole
        // dollars, which on the six- and eight-decimal assets makes the price an exact multiple of the
        // scale - and a repricing that always divides evenly cannot tell a value restated from the
        // amount apart from one carried over from the middle of a computation. An odd number of price
        // units, different per asset, leaves every one of those divisions with a remainder.
        uint8 numAssets = comet.numAssets();
        for (uint8 i; i < numAssets; ++i) {
            int256 price = int256(comet.getPrice(address(collateralPriceFeeds[i])));
            collateralPriceFeeds[i].setRoundData(0, price + int256(uint256(i)) * 2 + 1, 0, 0, 0);
        }

        baseToken.allocateTo(baseSupplier, BASE_LIQUIDITY);
        vm.startPrank(baseSupplier);
        baseToken.approve(address(comet), type(uint256).max);
        comet.supply(address(baseToken), BASE_LIQUIDITY);
        vm.stopPrank();
    }

    /**
     * @notice The fixture's table with two of its scales moved off the standard ones, and one asset
     *         the protocol will not lend against or seize appended to it.
     * @dev Only the decimals move on the assets that were already there. The prices, the factors and
     *      the order are the fixture's, so the pairs the other groups lean on - two assets a swapped
     *      index could hide behind, a spread of liquidation factors above the liquidate collateral
     *      factors - all survive.
     *
     *      The last row is the non-seizable one: all three factors zero, which the asset list accepts
     *      because it only orders the factors it is given when the lower of a pair is non-zero. It
     *      replaces a row rather than joining one, because Comet's membership bitmap holds twenty-four
     *      collaterals and no more. It is priced far above anything else on the market, so that even a
     *      modest deposit of it is worth several times any debt the rest of the table can support - the
     *      point being that a module which counted it would be caught by how much it counted, not by a
     *      rounding. The row it takes over is the last of five one-dollar stables, so the table loses
     *      nothing it had only one of.
     */
    function defaultAssets() internal pure override returns (AssetSpec[] memory specs) {
        specs = super.defaultAssets();

        specs[17].decimals = 7; // LDO, at $2
        specs[20].decimals = 12; // ARB, at $1

        //                                symbol  decimals      price   borrow  liquidate  liquidation
        specs[specs.length - 1] = AssetSpec("DEAD", 8, 1_000_000, 0, 0, 0);
    }

    /**
     * @notice Written-off debt is backed by what was seized - basePaidOutValue <= sum of seizedValue
     * @dev Invariant. The protocol never forgives more debt than the seized collateral covers.
     *      Anything beyond the derived tolerance is a gift to the borrower at the suppliers' expense.
     *
     *      The write-off case is deliberately outside this one. Where the collateral no longer covers
     *      the debt the protocol does forgive the remainder on purpose, and holding that against the
     *      seizure would be checking the wrong thing - the drop is drawn short of it and bad debt has
     *      an invariant of its own.
     *
     *      Stated as an equality with nothing allowed for. The two conditions that make it exact are
     *      chosen rather than hoped for: the drop leaves the collateral covering the debt, and partial
     *      mode is off, so the seizure closes the debt to the last unit. A debt that ends at zero is
     *      never converted back into base tokens, and that conversion is the only step in the chain
     *      that can round - the plan's values subtract from the debt in the units the debt is measured
     *      in, and they telescope. Where a residue is left, flooring it to a whole base token hands the
     *      borrower up to one quantum, and no equality can hold; that case belongs to partial mode and
     *      is not this claim.
     */
    function testFuzz_writtenOffDebtIsBackedByWhatWasSeized(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        Position memory p = _boundPosition(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed);

        // Above this multiplier the collateral still settles the debt in full. Below it the seizure
        // runs out and the protocol writes off the remainder, which is the one case this invariant is
        // not about: there the forgiven debt is deliberately larger than what was taken.
        uint256 badDebtDrop = _badDebtDrop(p);
        vm.assume(badDebtDrop <= p.dropCeiling); // no room between covering the debt and the threshold

        p.dropBps = bound(dropSeed, badDebtDrop, p.dropCeiling);

        // Partial mode off: the seizure closes the debt rather than stopping at a health target, which
        // is what leaves nothing behind to be rounded.
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, false);

        uint256 seizedValue;
        for (uint256 j; j < plan.length; ++j) {
            seizedValue += plan[j].seizedValue;
        }

        vm.recordLogs();
        _absorb();

        (, uint256 paidOutValue) = _absorbDebtReport(vm.getRecordedLogs());

        // An absorb that paid out nothing would satisfy the claim below by doing nothing at all.
        assertGt(paidOutValue, 0, "the absorb wrote off no debt for the seizure to back");

        // The premise of the equality: a debt closed to the last unit never makes the return trip into
        // base tokens. If a residue is ever left here the bounds are wrong, and the run must not pass
        // on a rounding allowance instead.
        assertEq(comet.borrowBalanceOf(borrower), 0, "the seizure left a debt the bounds meant to close");

        assertEq(paidOutValue, seizedValue, "the debt forgiven is not the value the seizure took");
    }

    /**
     * @notice The seizure is minimal - seizedAmount - 1 → target missed
     * @dev Invariant. Exactly as much is taken as is needed: reducing the last plan entry by one token
     *      quantum breaks the result. That is what separates a sufficient seizure from an excessive
     *      one - without it, a module that seized twice what it needed would satisfy every other
     *      statement in this group.
     *
     *      The same starting state is used twice. The first run is the real absorb, which closes the
     *      debt; the second replays the identical seizure a step short, and the closure the first run
     *      achieved has to be out of reach.
     *
     *      Partial mode is off, and not by preference. There the module aims at a health factor rather
     *      than at a debt, and it lands above that target by a rounding margin of its own - measured on
     *      this market at up to two parts in a hundred million of the target, which is far more than
     *      any single-token step removes. Strict minimality against a health target is not a statement
     *      this arrangement can make; the overshoot itself is worth bounding, but that is a different
     *      claim.
     *
     *      The replay is written straight through Comet's liquidation hooks, as the module. Going back
     *      through `absorb` would re-plan against the state it finds and hand back the same amounts,
     *      which answers a different question. The debt credited for the shortened seizure is worked
     *      out here, and it is credited at what the remaining collateral is worth and no more, so a
     *      replay that misses the target is not missing it on the test's own generosity.
     *
     *      The shortening is by the smallest step the protocol can register rather than by one token,
     *      which on this market is the same thing only on the two coarsest assets. See
     *      `_smallestObservableStep` for why one token is not a testable amount on the rest.
     *
     *      Bad debt is excluded by the drop: there everything is seized and minimality means nothing.
     */
    function testFuzz_theSeizureIsMinimal(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        Position memory p = _boundPosition(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed);

        uint256 badDebtDrop = _badDebtDrop(p);
        vm.assume(badDebtDrop <= p.dropCeiling); // no room between covering the debt and the threshold

        p.dropBps = bound(dropSeed, badDebtDrop, p.dropCeiling);

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, false);

        uint256 debtBase = comet.borrowBalanceOf(borrower);
        uint256 last = plan.length - 1;

        ICometData.AssetInfo memory info = comet.getAssetInfo(plan[last].index);
        uint256 step = _smallestObservableStep(info);

        // The entry has to be big enough to take the step out of. A seizure smaller than the step is
        // one the ledger could not have told apart from a slightly larger one anyway.
        vm.assume(plan[last].seizedAmount > step);

        uint256 snapshot = vm.snapshotState();

        // What the real seizure achieved, on this exact state. The replay is held against a closure
        // that actually happened rather than against one the bounds merely expect.
        _absorb();
        assertEq(comet.borrowBalanceOf(borrower), 0, "the seizure left a debt the bounds meant to close");

        vm.revertToState(snapshot);

        _replayShort(plan, debtBase, step);

        assertGt(comet.borrowBalanceOf(borrower), 0, "a shorter seizure still closed the debt");
    }

    /**
     * @notice Entry value matches the seized amount - wantedCollateralValue = seizedAmount × price / scale
     * @dev Invariant. The collateral value an entry declares is the repricing of the amount actually
     *      being seized, not a quantity left over from the middle of the computation. That value is
     *      what Comet puts in `AbsorbCollateral` and what the books are read against, so a stale one
     *      misreports every seizure without changing a single balance.
     *
     *      The whole drop range is drawn, because the module reaches this figure by three different
     *      routes - the debt-closing branch, the partial branch that takes only what the health target
     *      needs, and the branch that empties an asset and moves on - and each restates the value in
     *      its own place. A shallow drop exercises the first two and a deep one the third.
     */
    function testFuzz_entryValueMatchesTheSeizedAmount(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPosition(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed);
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        uint256 withRemainder;

        for (uint256 j; j < plan.length; ++j) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(plan[j].index);
            uint256 priced = plan[j].seizedAmount * comet.getPrice(info.priceFeed);

            if (priced % uint256(info.scale) != 0) ++withRemainder;

            assertEq(
                plan[j].wantedCollateralValue,
                priced / uint256(info.scale),
                "the entry's declared value is not the repricing of the amount it seizes"
            );
        }

        // A plan whose every division came out even would hold just as well against a value carried
        // over from before the amount was rounded, and would be counted as a checked run without
        // having checked the thing.
        vm.assume(withRemainder > 0);
    }

    /**
     * @notice Bad debt only on an exhausted account - written off → every seizable balance is zero
     * @dev Invariant. An uncovered remainder may be written off only once everything that could be
     *      seized has been seized. Anything less is the protocol taking a loss with collateral still
     *      sitting on the account.
     *
     *      This is the case the rest of the group excludes, reached from the other side: the drop is
     *      drawn below the point where the whole position stops covering the debt, so the seizure is
     *      certain to run out. That the write-off then happens is asserted rather than waited for - a
     *      run that quietly covered its debt would otherwise be counted as a checked one while proving
     *      nothing.
     *
     *      Every asset is inspected, not only the ones the plan named. An asset the plan skipped while
     *      the protocol took a loss is exactly the failure this is looking for, and it would not appear
     *      in the plan to be found there.
     */
    function testFuzz_badDebtOnlyOnAnExhaustedAccount(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPosition(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed);

        uint256 badDebtDrop = _badDebtDrop(p);
        vm.assume(badDebtDrop >= 100); // no room left below full exhaustion to drop the prices into

        p.dropBps = bound(dropSeed, 1, badDebtDrop * 99 / 100);

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        uint256 debtValue = _baseValue(comet.borrowBalanceOf(borrower));

        uint256 seizedValue;
        for (uint256 j; j < plan.length; ++j) {
            seizedValue += plan[j].seizedValue;
        }

        _absorb();

        // The premise, held to by the bounds: the account came out owing nothing, and what was taken
        // was worth less than what it owed - which is a loss the protocol absorbed.
        assertEq(comet.borrowBalanceOf(borrower), 0, "the debt survived a drop meant to exhaust the collateral");
        assertLt(seizedValue, debtValue, "the seizure covered a debt the drop meant to leave uncovered");

        uint8 numAssets = comet.numAssets();
        for (uint8 i; i < numAssets; ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);

            // An asset the module may not touch is not one it can be asked to have taken.
            if (info.liquidationFactor == 0) continue;

            assertEq(
                comet.collateralBalanceOf(borrower, info.asset),
                0,
                "debt was written off while the borrower still held seizable collateral"
            );
        }
    }

    /**
     * @notice Non-seizable collateral provides no coverage - LF = 0 → contributes no coverage
     * @dev Invariant. The value of an asset with a zero liquidation factor does not reduce the debt.
     *      It is not seized, and it must not be counted as though it had been.
     *
     *      The position is built so that the two readings are far apart. The ordinary collateral is
     *      dropped below the point where it can cover the debt, so a correct module runs out and the
     *      protocol takes the loss; the non-seizable deposit standing beside it is worth several times
     *      that debt and its price never moves. A module that counted it would have no shortfall to
     *      write off at all, so the two outcomes are not separated by a rounding but by the whole
     *      uncovered remainder.
     */
    function testFuzz_nonSeizableCollateralProvidesNoCoverage(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 deadAmount,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        uint8 dead = _deadIndex();

        // The bound chain never sees the non-seizable asset: it is supplied separately below, so the
        // borrow it allows, the drop it survives and the prices that move are all worked out over the
        // ordinary collateral alone.
        uint256 mask = _assetMask(maskSeed) & ~(uint256(1) << dead);
        vm.assume(mask != 0); // a position standing on nothing but the non-seizable asset

        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed);

        uint256 badDebtDrop = _badDebtDrop(p);
        vm.assume(badDebtDrop >= 100); // no room left below full exhaustion to drop the prices into

        p.dropBps = bound(dropSeed, 1, badDebtDrop * 99 / 100);

        // Supplied before the scenario so it is on the books when the plan is read, and kept out of
        // `p.amounts` so the scenario neither supplies it twice nor touches its price.
        //
        // The floor is the debt itself, restated in this asset's units: the deposit has to be worth
        // more than everything the borrower owes, or its being ignored would prove nothing. A market
        // too small to hold that much of it is rejected rather than run at a lower bar.
        ICometData.AssetInfo memory deadInfo = comet.getAssetInfo(dead);
        uint256 deadCeiling = Math.min(1_000_000 * uint256(deadInfo.scale), deadInfo.supplyCap);
        uint256 deadFloor = _baseValue(p.borrow) * uint256(deadInfo.scale) / comet.getPrice(deadInfo.priceFeed) + 1;

        vm.assume(deadFloor <= deadCeiling); // the cap cannot hold a deposit that outweighs the debt

        uint256 deadSupply = bound(deadAmount, deadFloor, deadCeiling);

        collaterals[dead].allocateTo(borrower, deadSupply);

        vm.startPrank(borrower);
        collaterals[dead].approve(address(comet), deadSupply);
        comet.supply(address(collaterals[dead]), deadSupply);
        vm.stopPrank();

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, false);

        uint256 debtValueBefore = _baseValue(comet.borrowBalanceOf(borrower));

        uint256 seizedValue;
        for (uint256 j; j < plan.length; ++j) {
            seizedValue += plan[j].seizedValue;
        }

        _absorb();

        // The deposit is untouched: nothing of it was taken, so nothing of it can have been credited.
        assertEq(
            comet.collateralBalanceOf(borrower, deadInfo.asset),
            deadSupply,
            "the non-seizable deposit was seized"
        );

        // The account came out owing nothing, which at this drop can only be the protocol writing the
        // remainder off. Counting the deposit would have left the account collateralized and the debt
        // standing instead, so this is the branch that separates the two readings.
        assertEq(comet.borrowBalanceOf(borrower), 0, "the debt survived a drop meant to exhaust the collateral");

        // And the loss is real. The borrower was holding collateral worth more than everything they
        // owed, and the protocol still recovered less than the debt - which is only right if that
        // collateral counted for nothing. Had any of it been credited there would have been no
        // shortfall to absorb.
        assertLt(seizedValue, debtValueBefore, "the non-seizable deposit was counted towards the debt");
    }

    /*//////////////////////////////////////////////////////////////
                          BOUNDS AND SCENARIO
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice The set of collaterals the position stands on, one bit per asset, guaranteed to reach a
     *         scale the market does not otherwise use.
     * @dev Bounded away from zero, because a position on nothing has no seizure to state anything
     *      about. A draw that misses every odd scale has one forced on rather than being discarded:
     *      that reshapes the run instead of throwing it away, and it leaves the rest of the set
     *      exactly as the seed drew it.
     */
    function _assetMask(uint256 maskSeed) internal view returns (uint256 mask) {
        uint8 numAssets = comet.numAssets();
        mask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);

        uint8[] memory odd = _oddScaleIndexes();

        uint256 oddMask;
        for (uint256 k; k < odd.length; ++k) {
            oddMask |= uint256(1) << odd[k];
        }

        if (mask & oddMask == 0) mask |= uint256(1) << odd[maskSeed % odd.length];
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
     */
    function _boundPosition(uint256 mask, uint256 supplySeed, uint256 borrowAmount, uint256 dropSeed)
        internal
        view
        returns (Position memory p)
    {
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
            // whichever binds first. The scale is widened before it is multiplied, because the asset
            // table's scales overflow their own uint64 at a million units.
            uint256 amount = bound(
                uint256(keccak256(abi.encode(supplySeed, i))),
                uint256(info.scale) / 1000,
                Math.min(1_000_000 * uint256(info.scale), info.supplyCap)
            );
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
        vm.assume(maxBorrow >= comet.baseBorrowMin()); // too cheap a set to reach the minimum borrow
        vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

        p.borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

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
     * @dev The plan is read in the same block as the absorb that follows, with price, time and mode
     *      untouched in between, so what a test inspects is what the module executes.
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

        // Both hold by construction of the bounds above. If either ever does not, the bounds are
        // wrong and the run must not pass quietly.
        assertTrue(liquidationModule.isLiquidatable(borrower), "the position built is not liquidatable");

        plan = liquidationModule.seizurePlan(borrower);
        assertGt(plan.length, 0, "the position built seizes nothing");
    }

    function _absorb() internal {
        address[] memory accounts = new address[](1);
        accounts[0] = borrower;

        vm.prank(liquidator);
        comet.absorb(liquidator, accounts);
    }

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice The indexes whose scale is not one the market otherwise runs on.
     * @dev Found on the market rather than named, so the set follows whatever asset table this
     *      contract's override produces. A table with no odd scale in it cannot state what this group
     *      is for, so the absence is a failure rather than something to work around.
     */
    function _oddScaleIndexes() internal view returns (uint8[] memory indexes) {
        uint8 numAssets = comet.numAssets();
        uint8[] memory found = new uint8[](numAssets);
        uint256 n;

        for (uint8 i; i < numAssets; ++i) {
            uint64 scale = comet.getAssetInfo(i).scale;
            if (scale == 1e6 || scale == 1e8 || scale == 1e18) continue;

            found[n] = i;
            ++n;
        }

        require(n != 0, "the market holds no asset on a non-standard scale");

        indexes = new uint8[](n);
        for (uint256 k; k < n; ++k) {
            indexes[k] = found[k];
        }
    }

    /**
     * @notice The smallest reduction of a seizure that the protocol is able to notice.
     * @dev A debt is stored in whole base tokens, so a shortfall worth less than one of them is
     *      forgiven on the way back into the ledger rather than recorded. On this market one base
     *      token is worth a hundred value units, while one token of an eighteen-decimal collateral is
     *      worth a fraction of one - so taking a single token less changes nothing that any reading of
     *      the account can show, and asserting that it does would be asserting arithmetic that cannot
     *      hold. Only the two eight-decimal assets priced in the tens of thousands carry a token worth
     *      more than a base token, and there this returns the two tokens the literal statement asks
     *      for.
     *
     *      The step is therefore one base token expressed in the collateral's own units, plus the one
     *      token the module was already granted by rounding its amount up. Both terms are read off the
     *      market - a price, a scale, a factor - and neither is a margin chosen to make runs pass.
     */
    function _smallestObservableStep(ICometData.AssetInfo memory info) internal view returns (uint256) {
        uint256 baseQuantum = Math.ceilDiv(comet.getPrice(address(basePriceFeed)), comet.baseScale());

        uint256 perBaseToken = Math.ceilDiv(
            baseQuantum * uint256(info.scale) * FACTOR_SCALE,
            comet.getPrice(info.priceFeed) * info.liquidationFactor
        );

        return perBaseToken + 1;
    }

    /**
     * @notice Writes a plan into Comet as the module would, with the last entry shortened.
     * @dev Comet accepts a seizure only from the module, so the replay is pranked as it. The two hooks
     *      are the whole of what a liquidation writes: one per collateral taken, then one for the debt.
     *
     *      The debt written is the only figure the module does not supply here, and it is derived
     *      rather than copied. Every entry but the last is credited at the value the plan reported; the
     *      last is credited at what the collateral actually left in the seizure is worth, truncated,
     *      because crediting a part unit that was never taken is what would let a shortened seizure
     *      reach a target it has not paid for. What the seizure leaves uncovered is then floored into
     *      whole base tokens - the same conversion the module makes, in the same direction.
     */
    function _replayShort(ICoreLiquidationModule.Seizure[] memory plan, uint256 debtBase, uint256 step) internal {
        uint256 last = plan.length - 1;

        ICometData.AssetInfo memory info = comet.getAssetInfo(plan[last].index);
        uint256 price = comet.getPrice(info.priceFeed);

        uint256 credited;

        vm.startPrank(address(liquidationModule));

        for (uint256 j; j < plan.length; ++j) {
            uint256 amount = plan[j].seizedAmount;
            uint256 wantedValue = plan[j].wantedCollateralValue;
            uint256 value = plan[j].seizedValue;

            if (j == last) {
                amount -= step;
                wantedValue = amount * price / uint256(info.scale);
                value = amount * price * info.liquidationFactor / (uint256(info.scale) * FACTOR_SCALE);
            }

            credited += value;

            // The module skips an entry that takes nothing, and so does the replay.
            if (amount == 0) continue;

            ICometLiquidationInterface(address(comet)).updateCollateral(
                liquidator, borrower, plan[j].index, uint128(amount), wantedValue
            );
        }

        uint256 debtValue = _baseValue(debtBase);
        if (credited > debtValue) credited = debtValue; // a seizure cannot repay more than is owed

        uint256 basePrice = comet.getPrice(address(basePriceFeed));
        uint256 debtLeft = (debtValue - credited) * comet.baseScale() / basePrice;

        ICometLiquidationInterface(address(comet)).updateDebtAndPrincipal(
            liquidator,
            borrower,
            -int256(debtLeft),
            debtBase - debtLeft,
            (debtBase - debtLeft) * basePrice / comet.baseScale()
        );

        vm.stopPrank();
    }

    /**
     * @notice The shallowest price multiplier at which the whole position, seized at once, still
     *         settles the debt - the line between a seizure that covers what it forgives and a
     *         write-off.
     * @dev Two roundings sit between the arithmetic and the market, and both are answered by raising
     *      the multiplier rather than by hoping they cancel. The division is taken upwards, because
     *      the truncated multiplier lands just under the line rather than just over it. And every
     *      price is floored on its way into the feed, so the position ends up worth marginally less
     *      than scaling `seizable` says: at most one price unit per asset, which is added to the debt
     *      the multiplier has to keep covered. Neither term is tuned - the first is a rounding
     *      direction and the second is the width of a price unit.
     */
    function _badDebtDrop(Position memory p) internal view returns (uint256) {
        uint256 debtValue = _baseValue(p.borrow);

        for (uint8 i; i < uint8(p.amounts.length); ++i) {
            if (p.amounts[i] == 0) continue;

            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            debtValue += Math.ceilDiv(p.amounts[i] * info.liquidationFactor, uint256(info.scale) * FACTOR_SCALE);
        }

        return Math.ceilDiv(debtValue * 10_000, p.seizable);
    }

    /**
     * @notice What the absorb itself reported paying out, in base and in value units.
     * @dev The report is the protocol's own outward statement of the write-off, which is what makes it
     *      the right side of a claim about forgiven debt: a market that misfunds an absorption and
     *      then reports the funded figure would satisfy a check that recomputed the payout instead.
     */
    function _absorbDebtReport(Vm.Log[] memory logs) internal view returns (uint256 basePaidOut, uint256 paidOutValue) {
        bytes32 signature = keccak256("AbsorbDebt(address,address,uint256,uint256)");

        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(comet)) continue;
            if (logs[i].topics.length == 0 || logs[i].topics[0] != signature) continue;

            return abi.decode(logs[i].data, (uint256, uint256));
        }
        revert("the absorb emitted no AbsorbDebt");
    }

    /**
     * @notice The index of the asset the protocol will not seize.
     * @dev Found by its factor rather than by its position, so the row can move in the table without
     *      the test following it. A market without one cannot state the invariant it serves, so the
     *      absence is a failure rather than something to skip over.
     */
    function _deadIndex() internal view returns (uint8) {
        uint8 numAssets = comet.numAssets();

        for (uint8 i; i < numAssets; ++i) {
            if (comet.getAssetInfo(i).liquidationFactor == 0) return i;
        }

        revert("the market holds no asset with a zero liquidation factor");
    }

    /// What an amount of the base token is worth, in the value units prices are quoted in.
    function _baseValue(uint256 amount) internal view returns (uint256) {
        return amount * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
    }

    /// What an amount of a collateral is worth, before any factor is applied to it.
    function _collateralValue(uint8 index, uint256 amount) internal view returns (uint256) {
        ICometData.AssetInfo memory info = comet.getAssetInfo(index);
        return amount * comet.getPrice(info.priceFeed) / uint256(info.scale);
    }

    /// Splits the runs of a test in two on a seed it is already drawing from, so a branch the group
    /// wants both sides of does not cost an argument.
    function _coinFlip(uint256 seed, string memory tag) internal pure returns (bool) {
        return uint256(keccak256(abi.encode(seed, tag))) % 2 == 0;
    }

    /// How many assets the mask selected, which is how many the borrower supplied.
    function _bitCount(uint256 mask) internal pure returns (uint256 count) {
        while (mask != 0) {
            mask &= mask - 1;
            ++count;
        }
    }
}
