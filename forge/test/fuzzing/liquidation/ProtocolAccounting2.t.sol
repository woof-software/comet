// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { Vm } from "forge-std/Vm.sol";

import { CometConfiguration } from "@comet-contracts/CometConfiguration.sol";
import { CometInterface } from "@comet-contracts/CometInterface.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModule } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModule.sol";
import { FaucetToken } from "@comet-contracts/test/FaucetToken.sol";

import { LiquidationMath } from "../../helpers/LiquidationMath.sol";
import { ProtocolFixture } from "../../helpers/ProtocolFixture.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Protocol accounting after a seizure, second reading
 * @notice One invariant per test: a single statement a counterexample can refute. The group checks
 *         that a seizure is reflected correctly in Comet's books and is not accompanied by any token
 *         movement.
 * @dev A second, independent implementation of the same invariant group as
 *      `ProtocolAccounting.t.sol`, kept alongside it on purpose. The two were written from the same
 *      doc without sight of each other, so where they agree that is evidence about the module rather
 *      than about one author's reading of the spec. Two places they do not overlap: this file also
 *      covers the adapter invariant (`testFuzz_adapterIsNeverCalled`), and it switches the market's
 *      rates off rather than relying on the clock never being advanced.
 *
 *      The collateral set is chosen by a mask rather than enumerated: deltas must be checked across
 *      several assets at once, otherwise a bug in the traversal loop will not surface.
 *
 *      Actors: the borrower, the liquidator (sends the transaction and is passed as the absorber
 *      argument), the pauser, the base supplier from the fixture. The bound chain and the scenario
 *      every test shares are in `_boundPosition` and `_baseScenario`.
 *
 *      Market rates are zero throughout: accrual would shift the base totals independently of
 *      liquidation and blur the deltas. It also holds `baseBorrowIndex` at `BASE_INDEX_SCALE`, which
 *      keeps the plan read here identical to the one `absorb` executes and lets the reserve check
 *      assert an equality rather than a tolerance.
 */
contract ProtocolAccounting2FuzzTest is ProtocolFixture {
    using LiquidationMath for CometInterface;

    uint64 internal constant BASE_INDEX_SCALE = 1e15;
    uint256 internal constant BASE_LIQUIDITY = 1e18;

    address internal borrower = alice;
    address internal liquidator = bob;
    address internal baseSupplier = charlie;
    address internal secondSupplier = makeAddr("secondSupplier");
    address internal secondBorrower = makeAddr("secondBorrower");

    /// @dev `seizable` and `dropCeiling` are read only by the reserve invariant, which redraws the
    ///      drop into the slice where the collateral still covers the debt.
    struct Position {
        uint256[] amounts;
        uint256 borrow;
        uint256 dropBps;
        uint256 seizable;
        uint256 dropCeiling;
    }

    /// @dev Build a Comet with zero rates
    function buildCometConfiguration(address liquidationModule_)
        internal
        view
        override
        returns (CometConfiguration.Configuration memory config)
    {
        config = super.buildCometConfiguration(liquidationModule_);

        config.supplyPerYearInterestRateBase = 0;
        config.supplyPerYearInterestRateSlopeLow = 0;
        config.supplyPerYearInterestRateSlopeHigh = 0;
        config.borrowPerYearInterestRateBase = 0;
        config.borrowPerYearInterestRateSlopeLow = 0;
        config.borrowPerYearInterestRateSlopeHigh = 0;
    }

    function setUp() public {
        prepareFixture();

        baseToken.allocateTo(baseSupplier, BASE_LIQUIDITY);
        vm.startPrank(baseSupplier);
        baseToken.approve(address(comet), type(uint256).max);
        comet.supply(address(baseToken), BASE_LIQUIDITY);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                              COLLATERAL
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice The asset total falls by the seized amount - totalSupplyAsset after = before - seizedAmount
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
        Position memory p = _boundPosition(maskSeed, supplySeed, borrowAmount, dropSeed);
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        // A total that holds nothing but the borrower's own deposit cannot tell "fell by the seized
        // amount" apart from "was wiped". A second supplier lifts it clear of the borrower's balance
        // wherever the cap leaves room, and comes after the position is built so the borrower's own
        // deposits are never the ones the cap turns away.
        if (_coinFlip(supplySeed, "second supplier")) {
            uint8 numAssets = comet.numAssets();
            for (uint8 i; i < numAssets; ++i) {
                if (p.amounts[i] == 0) continue;

                uint256 headroom = uint256(comet.getAssetInfo(i).supplyCap) - p.amounts[i];
                if (headroom == 0) continue;

                uint256 amount = Math.min(headroom, p.amounts[i]);
                collaterals[i].allocateTo(secondSupplier, amount);

                vm.startPrank(secondSupplier);
                collaterals[i].approve(address(comet), amount);
                comet.supply(address(collaterals[i]), amount);
                vm.stopPrank();
            }
        }

        uint256[] memory totalsBefore = new uint256[](plan.length);
        for (uint256 j; j < plan.length; ++j) {
            (uint128 totalSupplyAsset,) = comet.totalsCollateral(plan[j].asset);
            totalsBefore[j] = totalSupplyAsset;
        }

        _absorb();

        for (uint256 j; j < plan.length; ++j) {
            (uint128 totalSupplyAsset,) = comet.totalsCollateral(plan[j].asset);

            // Stated as an addition rather than a subtraction on the other side: a total that fell
            // too far would underflow the subtraction and revert, and a revert says less than a
            // failed assertion does.
            assertEq(
                uint256(totalSupplyAsset) + plan[j].seizedAmount,
                totalsBefore[j],
                "the asset total did not fall by the seized amount"
            );
        }
    }

    /**
     * @notice Reserves grow by the seized amount - reserves after = before + seizedAmount
     * @dev Invariant. Everything seized becomes a protocol reserve - nothing is lost on the way and
     *      nothing extra appears.
     */
    function testFuzz_reservesGrowBySeizedAmount(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPosition(maskSeed, supplySeed, borrowAmount, dropSeed);

        // Reserves that start at zero would let "grew by the seized amount" pass as "was set to the
        // seized amount". A few tokens sent to Comet directly raise the reserve without raising the
        // tracked total, which is exactly the gap the accessor reports.
        if (_coinFlip(supplySeed, "seeded reserves")) {
            uint8 numAssets = comet.numAssets();
            for (uint8 i; i < numAssets; ++i) {
                if (p.amounts[i] == 0) continue;

                uint256 dust = bound(
                    uint256(keccak256(abi.encode(supplySeed, "seeded reserves", i))),
                    1,
                    uint256(comet.getAssetInfo(i).scale)
                );
                collaterals[i].allocateTo(address(comet), dust);
            }
        }

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        uint256[] memory reservesBefore = new uint256[](plan.length);
        for (uint256 j; j < plan.length; ++j) reservesBefore[j] = comet.getCollateralReserves(plan[j].asset);

        _absorb();

        for (uint256 j; j < plan.length; ++j) {
            assertEq(
                comet.getCollateralReserves(plan[j].asset),
                reservesBefore[j] + plan[j].seizedAmount,
                "the collateral reserve did not grow by the seized amount"
            );
        }
    }

    /**
     * @notice Collateral tokens do not move - comet token balance unchanged
     * @dev Invariant. On the default route a seizure is an accounting move, not a token transfer:
     *      not a single unit of collateral leaves Comet or arrives into it.
     */
    function testFuzz_collateralTokensDoNotMove(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPosition(maskSeed, supplySeed, borrowAmount, dropSeed);
        _baseScenario(p, partialEnabled);

        // Every market asset, not only the ones in the plan: a transfer of something the plan never
        // named is the failure this is looking for.
        uint8 numAssets = comet.numAssets();
        uint256[] memory balancesBefore = new uint256[](numAssets);
        for (uint8 i; i < numAssets; ++i) balancesBefore[i] = collaterals[i].balanceOf(address(comet));

        _absorb();

        for (uint8 i; i < numAssets; ++i) {
            assertEq(
                collaterals[i].balanceOf(address(comet)),
                balancesBefore[i],
                "a collateral token moved on the default route"
            );
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 BASE
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Total borrow falls by the principal delta - totalBorrowBase after = before - dPrincipal
     * @dev Invariant. The reduction of the borrower's debt is reflected exactly in the market's total
     *      debt, with no divergence from index rounding.
     */
    function testFuzz_totalBorrowFallsByPrincipalDelta(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPosition(maskSeed, supplySeed, borrowAmount, dropSeed);

        // A market whose only debt is the absorbed account's cannot tell "fell by the delta" apart
        // from "was zeroed". The second borrower stands on an asset the mask left out, so the drop
        // never reaches them and they stay healthy through the absorb.
        if (_coinFlip(supplySeed, "second borrower")) _openSecondBorrow(p);

        _baseScenario(p, partialEnabled);

        uint256 totalBorrowBefore = comet.totalsBasic().totalBorrowBase;
        (int104 principalBefore,,,,) = comet.userBasic(borrower);

        _absorb();

        uint256 totalBorrowAfter = comet.totalsBasic().totalBorrowBase;
        (int104 principalAfter,,,,) = comet.userBasic(borrower);

        assertEq(
            int256(totalBorrowBefore) - int256(totalBorrowAfter),
            int256(principalAfter) - int256(principalBefore),
            "the market's total debt did not fall by the borrower's principal delta"
        );
    }

    /**
     * @notice Total base supply does not change - totalSupply unchanged
     * @dev Invariant. Liquidating a borrower does not touch base suppliers: their aggregate position
     *      stays exactly as it was.
     */
    function testFuzz_totalBaseSupplyDoesNotChange(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPosition(maskSeed, supplySeed, borrowAmount, dropSeed);
        _baseScenario(p, partialEnabled);

        uint256 totalSupplyBefore = comet.totalSupply();

        _absorb();

        assertEq(comet.totalSupply(), totalSupplyBefore, "absorbing a borrower moved the base suppliers");
    }

    /**
     * @notice Base tokens do not move - comet base balance unchanged
     * @dev Invariant. Writing down a debt is a bookkeeping operation: the base token is not
     *      transferred into Comet or out of it.
     */
    function testFuzz_baseTokensDoNotMove(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPosition(maskSeed, supplySeed, borrowAmount, dropSeed);
        _baseScenario(p, partialEnabled);

        uint256 balanceBefore = baseToken.balanceOf(address(comet));

        _absorb();

        assertEq(baseToken.balanceOf(address(comet)), balanceBefore, "the base token moved on the default route");
    }

    /**
     * @notice Base reserves fall by the amount paid out - baseReserves after = before - basePaidOut
     * @dev Invariant. The value of the closed debt leaves the protocol's reserves in exactly the
     *      amount paid out - that is how the protocol funds an absorption.
     *
     *      The payout is worked out here from the collateral that actually left the borrower, not
     *      read back off the `AbsorbDebt` event: a market that misfunds an absorption and misreports
     *      it by the same amount satisfies a check that takes its own report as the source. The
     *      event is then held to that figure rather than supplying it.
     *
     *      The tolerance on the reserve movement is zero, and derived rather than hoped for. The
     *      reserve figure converts the market total from principal to present value and the payout
     *      is a present value too, so a drifted index could round the two apart by a unit. Nothing
     *      in this group advances the clock, so the borrow index still sits at `BASE_INDEX_SCALE`,
     *      where that conversion multiplies and divides by the same number and cannot round at all.
     *      It is asserted below rather than assumed: a later edit that warps time should fail at the
     *      reason, not quietly by a unit.
     */
    function testFuzz_baseReservesFallByAmountPaidOut(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPosition(maskSeed, supplySeed, borrowAmount, dropSeed);
        uint256 basePrice = comet.getPrice(comet.baseTokenPriceFeed());

        // A drop drawn across the whole range nearly always exhausts the collateral, and a write-off
        // leaves the bracket below with nothing to say. Scaling every price by k scales what a
        // seizure recovers by k too, so the collateral still covers the debt exactly while
        // `k * seizable >= debtValue`. That slice runs from `coversDebt` to the top of the range and
        // is only a few percent of it, because the liquidation factors sit just above the liquidate
        // collateral factors — so half the runs are drawn inside it on purpose.
        uint256 coversDebt = (p.borrow * basePrice / comet.baseScale()) * 10_000 / p.seizable;
        if (coversDebt <= p.dropCeiling && _coinFlip(dropSeed, "covering drop")) {
            p.dropBps = bound(dropSeed, coversDebt, p.dropCeiling);
        }

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        // The premise of the zero tolerance above.
        assertEq(comet.totalsBasic().baseBorrowIndex, BASE_INDEX_SCALE, "the borrow index left BASE_INDEX_SCALE");

        int256 reservesBefore = comet.getReserves();
        uint256 debtBefore = comet.borrowBalanceOf(borrower);

        vm.recordLogs();
        _absorb();

        uint256 debtAfter = comet.borrowBalanceOf(borrower);

        // What the seizure is worth, held against what the debt actually did. An account left with
        // nothing that carries borrowing power can never cover a remainder, so the protocol takes
        // the loss instead of leaving the debt standing.
        {
            (uint256 low, uint256 high) = _debtLeftBySeizure(plan, debtBefore * basePrice / comet.baseScale());

            if (comet.weightedCollateral(borrower) == 0) {
                assertEq(debtAfter, 0, "an account stripped of collateralization was left owing");
            } else {
                assertGe(debtAfter, low * comet.baseScale() / basePrice, "the seizure paid off more than it is worth");
                assertLe(debtAfter, high * comet.baseScale() / basePrice, "the seizure paid off less than it is worth");
            }
        }

        // The debt movement is now anchored to collateral that genuinely left the borrower, so it is
        // what both the reserve and the report are held to.
        uint256 paidOut = debtBefore - debtAfter;

        assertEq(
            comet.getReserves(),
            reservesBefore - int256(paidOut),
            "base reserves did not fall by the amount the seizure pays off"
        );
        assertEq(
            _basePaidOut(vm.getRecordedLogs()),
            paidOut,
            "AbsorbDebt reported a payout the seizure does not pay for"
        );
    }

    /*//////////////////////////////////////////////////////////////
                             THE MODULE
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice The module receives no tokens - module balance delta = 0
     * @dev Invariant. Neither base nor collateral passes through the liquidation module: it only
     *      writes into Comet's storage.
     */
    function testFuzz_moduleReceivesNoTokens(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        uint256 dustSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPosition(maskSeed, supplySeed, borrowAmount, dropSeed);
        _baseScenario(p, partialEnabled);

        // A module that starts empty makes "took nothing" and "swept what it took straight out"
        // indistinguishable. Dust placed in advance means a sweep has something to carry.
        uint8 numAssets = comet.numAssets();
        baseToken.allocateTo(
            address(liquidationModule), bound(dustSeed, 0, 1_000_000 * uint256(comet.baseScale()))
        );
        for (uint8 i; i < numAssets; ++i) {
            if (p.amounts[i] == 0) continue;
            collaterals[i].allocateTo(
                address(liquidationModule), bound(dustSeed, 0, 1_000_000 * uint256(comet.getAssetInfo(i).scale))
            );
        }

        FaucetToken[] memory tokens = _marketTokens();
        uint256[] memory balancesBefore = new uint256[](tokens.length);
        for (uint256 t; t < tokens.length; ++t) balancesBefore[t] = tokens[t].balanceOf(address(liquidationModule));

        _absorb();

        for (uint256 t; t < tokens.length; ++t) {
            assertEq(
                tokens[t].balanceOf(address(liquidationModule)),
                balancesBefore[t],
                "the liquidation module's balance moved on the default route"
            );
        }
    }

    /**
     * @notice The adapter is never called - adapter calls = 0
     * @dev Invariant. The default route never reaches the DEX adapter - it exists only because the
     *      module cannot be deployed without one.
     */
    function testFuzz_adapterIsNeverCalled(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        // One counter behind a fallback stands in for a counter on every interface method: the claim
        // is that none of them is reached, and which one would have been is not the question.
        CallCounter counter = CallCounter(payable(address(dexAdapter)));
        vm.etch(address(dexAdapter), address(new CallCounter()).code);

        Position memory p = _boundPosition(maskSeed, supplySeed, borrowAmount, dropSeed);
        _baseScenario(p, partialEnabled);

        counter.reset();

        _absorb();

        assertEq(counter.calls(), 0, "the default route reached the DEX adapter");
    }

    /*//////////////////////////////////////////////////////////////
                          BOUNDS AND SCENARIO
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice The bound chain the group shares: a mask, a deposit per selected asset, a borrow the
     *         market will accept, and a price drop that lands the position below the liquidation
     *         threshold.
     * @dev The two weighted sums are deliberately computed in different orders, because two
     *      different contracts consume them. `borrowLimit` decides whether `withdraw` is accepted,
     *      and Comet's `_getCollaterizedLiquidity` prices and weights in two separate divisions;
     *      `liquidity` decides whether the position is liquidatable, and the module's `_getLiquidity`
     *      fuses both into one, on purpose — pricing and weighting separately truncates the balance
     *      twice. Mirroring each against the code that reads it is what keeps the top of the borrow
     *      range acceptable and the drop on the right side of the module's own threshold.
     */
    function _boundPosition(uint256 maskSeed, uint256 supplySeed, uint256 borrowAmount, uint256 dropSeed)
        internal
        view
        returns (Position memory p)
    {
        uint8 numAssets = comet.numAssets();
        uint256 basePrice = comet.getPrice(comet.baseTokenPriceFeed());
        uint256 baseScale = comet.baseScale();

        uint256 mask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);
        p.amounts = new uint256[](numAssets);

        uint256 borrowLimit;
        uint256 liquidity;

        for (uint8 i; i < numAssets; ++i) {
            if (mask & (uint256(1) << i) == 0) continue;

            ICometData.AssetInfo memory info = comet.getAssetInfo(i);

            // One seed for the whole set, one clamp per asset: the deposit is no less than a
            // thousandth of a unit and no more than a million units or the asset's supply cap,
            // whichever binds first. The scale is widened before it is multiplied — the asset
            // table's scales overflow their own uint64 at a million units.
            uint256 amount = bound(
                uint256(keccak256(abi.encode(supplySeed, i))),
                uint256(info.scale) / 1000,
                Math.min(1_000_000 * uint256(info.scale), info.supplyCap)
            );
            p.amounts[i] = amount;

            uint256 price = comet.getPrice(info.priceFeed);

            uint256 weighted = amount * price / uint256(info.scale);
            borrowLimit += weighted * info.borrowCollateralFactor / FACTOR_SCALE;

            liquidity += amount * price * info.liquidateCollateralFactor / (uint256(info.scale) * FACTOR_SCALE);

            // What a seizure could recover from this asset if it took all of it. Weighted by the
            // liquidation factor rather than the liquidate collateral factor, it is the line between
            // a seizure that covers the debt and one that runs out of collateral.
            p.seizable += amount * price * info.liquidationFactor / (uint256(info.scale) * FACTOR_SCALE);
        }

        uint256 maxBorrow = borrowLimit * baseScale / basePrice;
        vm.assume(maxBorrow >= comet.baseBorrowMin()); // too cheap a set to reach the minimum borrow
        vm.assume(maxBorrow <= baseToken.balanceOf(address(comet))); // more debt than the market can fund

        p.borrow = bound(borrowAmount, comet.baseBorrowMin(), maxBorrow);

        // The multiplier at which the debt value meets the liquidation-weighted collateral. Every
        // selected price is floored on the way down, so the drop only ever lands lower than this
        // arithmetic says, and a percent of clearance covers it.
        uint256 maxDrop = (p.borrow * basePrice / baseScale) * 10_000 / liquidity;
        vm.assume(maxDrop >= 100); // no room left below the threshold to drop the prices into

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

        // Only the selected feeds move. What the mask left out keeps its price, which is what lets a
        // second account stand on an untouched asset and stay healthy across the absorb.
        for (uint8 i; i < numAssets; ++i) {
            if (p.amounts[i] == 0) continue;

            uint256 price = comet.getPrice(address(collateralPriceFeeds[i])) * p.dropBps / 10_000;
            collateralPriceFeeds[i].setRoundData(0, int256(price), 0, 0, 0);
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
     * @notice Opens a borrow for a second account on the lowest-indexed asset the mask left out.
     * @dev That asset's price never moves, so the account is still collateralized when the absorb
     *      lands and its debt is still on the market's books afterwards. Half its borrowing power
     *      keeps it clear of the threshold. A mask that selected everything leaves nowhere to stand,
     *      and the run goes ahead without it.
     */
    function _openSecondBorrow(Position memory p) internal {
        uint8 numAssets = comet.numAssets();

        for (uint8 i; i < numAssets; ++i) {
            if (p.amounts[i] != 0) continue;

            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            uint256 amount = Math.min(1_000_000 * uint256(info.scale), info.supplyCap);

            uint256 limit = amount * comet.getPrice(info.priceFeed) / uint256(info.scale);
            limit = limit * info.borrowCollateralFactor / FACTOR_SCALE;
            uint256 borrow = limit * comet.baseScale() / comet.getPrice(comet.baseTokenPriceFeed()) / 2;
            if (borrow < comet.baseBorrowMin()) return;

            collaterals[i].allocateTo(secondBorrower, amount);

            vm.startPrank(secondBorrower);
            collaterals[i].approve(address(comet), amount);
            comet.supply(address(collaterals[i]), amount);
            comet.withdraw(address(baseToken), borrow);
            vm.stopPrank();

            return;
        }
    }

    /**
     * @notice The debt a seizure can honestly leave, bracketed by the direction its credits round.
     * @dev Each seizure pays the debt down by what it is worth once the liquidation discount is
     *      applied, and never by more than is still owed at that point in the walk — the protocol
     *      cannot credit a debt it has already cleared.
     *
     *      A seizure's worth rarely lands on a whole value unit, and which way that part unit goes
     *      is a real choice rather than an accident: crediting down leaves the borrower paying for
     *      collateral they were not credited for, crediting up hands them a part unit they did not
     *      cover. The module makes that choice per branch, so the walk is run both ways here and the
     *      two runs bracket the debt the seizure can leave. The bracket is one value unit per seized
     *      asset wide — the resolution of the price feed — and it is derived, not picked to fit.
     * @param plan The seizure plan, read before the absorb that executed it.
     * @param debtValue The account's debt at the point the plan was built, in value units.
     * @return low The least debt the seizure can leave, crediting every part unit up.
     * @return high The most it can leave, crediting every part unit down.
     */
    function _debtLeftBySeizure(ICoreLiquidationModule.Seizure[] memory plan, uint256 debtValue)
        internal
        view
        returns (uint256 low, uint256 high)
    {
        low = debtValue;
        high = debtValue;

        for (uint256 j; j < plan.length; ++j) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(plan[j].index);

            uint256 worth = plan[j].seizedAmount * comet.getPrice(info.priceFeed) * info.liquidationFactor;
            uint256 valueUnit = uint256(info.scale) * FACTOR_SCALE;

            low -= Math.min(Math.ceilDiv(worth, valueUnit), low);
            high -= Math.min(worth / valueUnit, high);
        }
    }

    /// @notice The base paid out as the absorb itself reported it, rather than as the test recomputed it.
    function _basePaidOut(Vm.Log[] memory logs) internal view returns (uint256) {
        bytes32 signature = keccak256("AbsorbDebt(address,address,uint256,uint256)");

        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(comet)) continue;
            if (logs[i].topics.length == 0 || logs[i].topics[0] != signature) continue;

            (uint256 basePaidOut,) = abi.decode(logs[i].data, (uint256, uint256));
            return basePaidOut;
        }
        revert("the absorb emitted no AbsorbDebt");
    }

    /// @notice Every token the market touches, base first.
    function _marketTokens() internal view returns (FaucetToken[] memory tokens) {
        uint8 numAssets = comet.numAssets();

        tokens = new FaucetToken[](uint256(numAssets) + 1);
        tokens[0] = baseToken;
        for (uint8 i; i < numAssets; ++i) tokens[uint256(i) + 1] = collaterals[i];
    }

    /**
     * @notice Whether a run takes the noisier of two setups.
     */
    function _coinFlip(uint256 seed, string memory tag) internal pure returns (bool) {
        return uint256(keccak256(abi.encode(seed, tag))) & 1 == 0;
    }
}

/**
 * @title Call counter
 * @notice Stands in for the DEX adapter and counts calls instead of answering them.
 * @dev `calls` and `reset` have selectors of their own, so reading and clearing the counter never
 *      reaches the fallback that increments it.
 */
contract CallCounter {
    uint256 public calls;

    function reset() external {
        calls = 0;
    }

    fallback() external payable {
        unchecked {
            ++calls;
        }
    }

    receive() external payable {
        unchecked {
            ++calls;
        }
    }
}
