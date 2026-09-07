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
 *      The bound chain and the scenario the group shares are in `_boundPosition` and `_baseScenario`.
 *      A test that needs a narrower slice of the range redraws from the fields the chain leaves on
 *      the `Position` rather than repeating the chain. A run that cannot be built - too little
 *      collateral to reach the minimum borrow, more base than the market holds, no room left to drop
 *      the price into - is rejected rather than passed, so a vacuous run is never counted as a
 *      checked one.
 */
contract BorrowerCollateralFuzzTest is ProtocolFixture {
    address internal borrower = alice;
    address internal liquidator = bob;
    address internal baseSupplier = charlie;

    /// @dev `seizable` is read only by the non-seizable-asset invariant, which redraws the drop into
    ///      the slice where the collateral runs out. `dropCeiling` is the top of the drawable range
    ///      and the two shallow-drop invariants redraw against it.
    struct Position {
        uint256[] amounts;
        uint256 borrow;
        uint256 dropBps;
        uint256 seizable;
        uint256 dropCeiling;
    }

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
        Position memory p = _boundPosition(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed);
        _baseScenario(p, partialEnabled);

        // Every asset on the market, not only the ones in the mask. An asset the borrower never
        // touched has a balance of zero, and zero is the one balance that has somewhere to grow to.
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
        uint256 mask = _assetMask(maskSeed);

        // The invariant needs something left over to talk about, and a position on a single asset
        // can never leave anything. A thin mask is widened rather than discarded: two indexes taken
        // from the same seed are forced on, which reshapes the run instead of throwing it away.
        if (_bitCount(mask) < 2) {
            mask |= uint256(1) << (maskSeed % numAssets);
            mask |= uint256(1) << ((maskSeed / numAssets) % numAssets);
        }

        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed);

        // The shallow end of the range, a hair under the boundary - the top eleventh of what the
        // chain drew from. The account is barely liquidatable, so the first asset or two satisfies
        // the plan and the rest of the set is left alone, which is the state this invariant is about.
        p.dropBps = bound(dropSeed, p.dropCeiling * 10 / 11, p.dropCeiling);

        // Partial liquidation, otherwise the debt is closed outright, every asset is swept and the
        // plan covers the whole position.
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, true);

        // A plan that reaches every supplied asset leaves no outsider, so there is nothing for the
        // final check to be about and the run is discarded rather than passed on an empty loop.
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
        // position: it is the subject of the invariant, not a draw, so the mask stops short of it and
        // the shared chain never sees it. Both of the chain's weighted sums therefore leave it out,
        // which is right on either side: it still carries its factors while the position is being
        // built, so the real borrowing power is larger than the chain's and the borrow is accepted
        // with room to spare, and its liquidation factor is zero by the time anything is seized.
        uint8 dead = comet.numAssets() - 1;
        Position memory p =
            _boundPosition(bound(maskSeed, 1, (uint256(1) << dead) - 1), supplySeed, borrowAmount, dropSeed);

        // Below this multiplier every seizable unit taken together no longer covers the debt, so the
        // liquidation runs out of collateral it may touch and writes off the remainder. Weighted by
        // the liquidation factor, which sits above the liquidate collateral factor on every asset
        // here, so this boundary is strictly under the one the chain drew against.
        {
            uint256 badDebtDrop = p.borrow * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
            badDebtDrop = badDebtDrop * 10_000 / p.seizable;
            vm.assume(badDebtDrop >= 100); // no room left below the boundary to drop the prices into

            p.dropBps = bound(dropSeed, 1, badDebtDrop * 99 / 100);
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

        // The last asset keeps its price throughout. Its balance surviving has to be the module
        // refusing to touch it, not the arithmetic quietly valuing it at nothing.
        for (uint8 i; i < dead; ++i) {
            if (p.amounts[i] == 0) continue;

            uint256 dropped = comet.getPrice(address(collateralPriceFeeds[i])) * p.dropBps / 10_000;
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

        _absorb();

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
        // The top tenth of what the collateral can carry. A debt that large leaves the seizure little
        // slack, so it works its way through the balances rather than stopping at the first one. The
        // drop keeps the whole range: a shallow one takes a single asset, a deep one takes every
        // asset to the last unit, and both must respect the balance.
        Position memory p = _boundPosition(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 9_000);

        // The plan is read and judged on its own, with nothing absorbed. An overdrawn entry would
        // revert inside the transfer and never reach a balance to be compared against, so the claim
        // has to be caught where it is written rather than where it is spent.
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        for (uint256 j; j < plan.length; ++j) {
            assertLe(
                plan[j].seizedAmount,
                comet.collateralBalanceOf(borrower, plan[j].asset),
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
        Position memory p = _boundPosition(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed);

        // Nothing at all happens between reading the plan and running the absorb - no warp, no
        // reprice, no change of mode. The plan is recomputed inside the absorb from the same inputs,
        // so any difference between the two is the execution disagreeing with itself, not the market
        // having moved underneath it.
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
        uint256 mask = _assetMask(maskSeed);

        // The bitmap is kept in two fields: the first sixteen assets in `assetsIn`, the rest in
        // `_reserved`. The ends of those two words are where a shift or a mask goes wrong, so at
        // least one of them is made to take part rather than left to the draw.
        {
            uint8[4] memory edges = [uint8(0), 15, 16, numAssets - 1];
            uint256 boundaries;
            for (uint256 e; e < edges.length; ++e) {
                boundaries |= uint256(1) << edges[e];
            }
            if (mask & boundaries == 0) mask |= uint256(1) << edges[maskSeed % 4];
        }

        // The whole drop range on purpose. A shallow drop leaves remainders on the balances and the
        // bits must stay set; a deep one empties them and the bits must go. Both are the claim.
        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed);
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
        uint256 mask = _assetMask(maskSeed);

        // Assets are needed on both sides of the seam between the two words the bitmap lives in,
        // because a wholesale rewrite would most likely show up as one word clobbering the other.
        // A mask sitting entirely in one word cannot catch that, so it is widened across the seam.
        if (mask & ((uint256(1) << 16) - 1) == 0 || mask >> 16 == 0) {
            mask |= (uint256(1) << 15) | (uint256(1) << 16);
        }

        Position memory p = _boundPosition(mask, supplySeed, borrowAmount, dropSeed);

        // The shallow end, the top eleventh of the range: the account is barely liquidatable, the
        // plan is satisfied early, and assets are guaranteed to be left outside it.
        p.dropBps = bound(dropSeed, p.dropCeiling * 10 / 11, p.dropCeiling);

        // Partial liquidation, otherwise the debt is closed outright, every asset is swept and the
        // plan covers the whole position.
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, true);

        // A plan that reaches every supplied asset leaves no outsider, so there is nothing for the
        // final check to be about and the run is discarded rather than passed on an empty loop.
        vm.assume(plan.length < _bitCount(mask));

        bool[] memory inPlan = new bool[](numAssets);
        for (uint256 k; k < plan.length; ++k) {
            inPlan[plan[k].index] = true;
        }

        // Comet exposes `userBasic` as its storage getter, so the struct arrives flattened. The
        // bitmap is kept in two of its fields: the first sixteen assets in `assetsIn`, the rest in
        // `_reserved`.
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
                            SHARED CHAIN
    //////////////////////////////////////////////////////////////*/

    /// @notice The set of collaterals the position stands on, one bit per asset.
    /// @dev Bounded away from zero: a position on nothing has no invariant to state.
    function _assetMask(uint256 maskSeed) internal view returns (uint256) {
        return bound(maskSeed, 1, (uint256(1) << comet.numAssets()) - 1);
    }

    /// The borrow drawn from the whole range the collateral can carry.
    function _boundPosition(uint256 mask, uint256 supplySeed, uint256 borrowAmount, uint256 dropSeed)
        internal
        view
        returns (Position memory)
    {
        return _boundPosition(mask, supplySeed, borrowAmount, dropSeed, 0);
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
     *      `borrowFloorBps` lifts the floor of the borrow range to that fraction of the ceiling, for
     *      the invariants that need a debt with no slack in it. Where the market's own minimum sits
     *      higher, the minimum wins and the slice is narrower still.
     */
    function _boundPosition(
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

            // One seed for the whole set, one clamp per asset: the deposit is no less than a
            // thousandth of a unit and no more than a million units or the asset's supply cap,
            // whichever binds first. The thousandth earns its place - a deposit that small is worth
            // almost nothing against the debt, so the plan reaches for the whole of it and runs into
            // the end of the balance. The scale is widened before it is multiplied, because the asset
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
        uint256 borrowFloor = Math.max(comet.baseBorrowMin(), maxBorrow * borrowFloorBps / 10_000);
        vm.assume(maxBorrow >= borrowFloor); // too cheap a set to reach the minimum borrow
        vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more base than the market can lend

        p.borrow = bound(borrowAmount, borrowFloor, maxBorrow);

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
     *      untouched in between, so what is read is what is executed.
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

    /// How many assets the mask selected, which is how many the borrower supplied.
    function _bitCount(uint256 mask) internal pure returns (uint256 count) {
        while (mask != 0) {
            mask &= mask - 1;
            ++count;
        }
    }

    /// @dev The bitmap is split across two of `userBasic`'s fields: the first sixteen assets live in
    ///      `assetsIn`, the rest in `_reserved`, which is not reserved in this Comet.
    function _inBitmap(uint16 assetsIn, uint8 reservedBits, uint8 i) internal pure returns (bool) {
        return i < 16 ? assetsIn & (uint16(1) << i) != 0 : reservedBits & (uint8(1) << (i - 16)) != 0;
    }
}
