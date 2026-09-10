// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { Vm } from "forge-std/Vm.sol";

import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICometLiquidationInterface } from "@comet-contracts/interfaces/ICometLiquidationInterface.sol";
import { ICoreLiquidationModule } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModule.sol";

import { LiquidationFuzzBase } from "./LiquidationFuzzBase.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Seizure economics
 * @notice What was taken against what was written off, in value terms.
 * @dev The asset table is given scales nothing in production uses, because inconsistent rounding
 *      surfaces precisely there: a conversion that quietly assumes eighteen decimals lands on the
 *      right answer for a 6/8/18 table often enough to survive a whole suite. The mask is drawn
 *      freely but always reaches one of those odd assets.
 *
 *      Every claim here relates quantities inside a single call. None of them checks the module
 *      against an independent model of what it should have taken.
 */
contract SeizureEconomicsFuzzTest is LiquidationFuzzBase {

    function setUp() public {
        prepareFixture();

        // Nudged off the round dollar: whole-dollar prices divide evenly by the six- and
        // eight-decimal scales, and a repricing that never leaves a remainder cannot tell a value
        // restated from the amount apart from one carried over mid-computation.
        uint8 numAssets = comet.numAssets();
        for (uint8 i; i < numAssets; ++i) {
            int256 price = int256(comet.getPrice(address(collateralPriceFeeds[i])));
            collateralPriceFeeds[i].setRoundData(0, price + int256(uint256(i)) * 2 + 1, 0, 0, 0);
        }
        seedMarketActivity();
    }

    /// @notice The fixture's table with two odd scales, and one asset the protocol will not seize.
    /// @dev Only the decimals move, so the pairs the other groups lean on all survive. The dead row
    ///      replaces one rather than joining, because the membership bitmap holds twenty-four and no
    ///      more, and it is priced far above everything else so a module that counted it would be
    ///      caught by how much it counted rather than by a rounding.
    function defaultAssets() internal pure override returns (AssetSpec[] memory specs) {
        specs = super.defaultAssets();

        specs[17].decimals = 7; // LDO, at $2
        specs[20].decimals = 12; // ARB, at $1

        //                                symbol  decimals      price   borrow  liquidate  liquidation
        specs[specs.length - 1] = AssetSpec("DEAD", 8, 1_000_000, 0, 0, 0);
    }

    /// @notice Written-off debt is backed by what was seized - basePaidOutValue = sum of seizedValue
    /// @dev Anything forgiven beyond what was taken is a gift at the suppliers' expense. Stated as an
    ///      equality with nothing allowed for, which two chosen conditions make exact: the fall
    ///      leaves the collateral covering the debt, and partial mode is off, so the debt closes to
    ///      the last unit and never makes the return trip into base tokens - the only rounding step
    ///      in the chain. Bad debt is a separate claim with its own test.
    function testFuzz_writtenOffDebtIsBackedByWhatWasSeized(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);

        // Above this the collateral still settles the debt in full; below it the seizure runs out
        // and the remainder is written off, which is the one case this claim is not about.
        uint256 badDebtDrop = _badDebtDrop(p);
        vm.assume(badDebtDrop <= p.dropCeiling); // no room between covering the debt and the threshold

        p.dropPpb = bound(dropSeed, badDebtDrop, p.dropCeiling);

        // Partial off, so the seizure closes the debt rather than stopping at a health target.
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

        // The premise of the equality. A residue left here means the bounds are wrong, and the run
        // must not pass on a rounding allowance instead.
        assertEq(comet.borrowBalanceOf(borrower), 0, "the seizure left a debt the bounds meant to close");

        assertEq(paidOutValue, seizedValue, "the debt forgiven is not the value the seizure took");
    }

    /// @notice The seizure is minimal - a step less → the debt is not closed
    /// @dev Without this, a module that seized twice what it needed would satisfy every other claim
    ///      in the group. The same state is used twice: the real absorb, then a replay a step short.
    ///
    ///      The replay goes straight through Comet's hooks, because `absorb` would re-plan and hand
    ///      back the same amounts. Partial mode is off: against a health target the module overshoots
    ///      by a margin of its own, far larger than a single step, so minimality cannot be stated.
    function testFuzz_theSeizureIsMinimal(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);

        uint256 badDebtDrop = _badDebtDrop(p);
        vm.assume(badDebtDrop <= p.dropCeiling); // no room between covering the debt and the threshold

        p.dropPpb = bound(dropSeed, badDebtDrop, p.dropCeiling);

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, false);

        uint256 debtBase = comet.borrowBalanceOf(borrower);
        uint256 last = plan.length - 1;

        ICometData.AssetInfo memory info = comet.getAssetInfo(plan[last].index);
        uint256 step = _smallestObservableStep(info);

        // A seizure smaller than the step is one the ledger could not tell apart anyway.
        vm.assume(plan[last].seizedAmount > step);

        uint256 snapshot = vm.snapshotState();

        // Held against a closure that actually happened, not one the bounds merely expect.
        _absorb();
        assertEq(comet.borrowBalanceOf(borrower), 0, "the seizure left a debt the bounds meant to close");

        vm.revertToState(snapshot);

        _replayShort(plan, debtBase, step);

        assertGt(comet.borrowBalanceOf(borrower), 0, "a shorter seizure still closed the debt");
    }

    /// @notice Entry value matches the seized amount - wantedCollateralValue = seizedAmount × price / scale
    /// @dev Comet puts this value in `AbsorbCollateral`, so a stale one misreports every seizure
    ///      without changing a single balance. The whole fall range is drawn, because the module
    ///      reaches this figure by three branches and each restates it in its own place.
    function testFuzz_entryValueMatchesTheSeizedAmount(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);
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

        // A plan whose divisions all came out even would hold just as well against a stale value.
        vm.assume(withRemainder > 0);
    }

    /// @notice Bad debt only on an exhausted account - written off → every seizable balance is zero
    /// @dev Anything less is the protocol taking a loss with collateral still on the account. Every
    ///      asset is inspected, not only the planned ones: an asset the plan skipped is exactly the
    ///      failure being looked for, and it would not appear in the plan to be found there.
    function testFuzz_badDebtOnlyOnAnExhaustedAccount(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);

        uint256 badDebtDrop = _badDebtDrop(p);
        vm.assume(badDebtDrop >= 100); // no room left below full exhaustion to drop the prices into

        p.dropPpb = bound(dropSeed, _minDropPpb(p.amounts), badDebtDrop * 99 / 100);

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        uint256 debtValue = _baseValue(comet.borrowBalanceOf(borrower));

        uint256 seizedValue;
        for (uint256 j; j < plan.length; ++j) {
            seizedValue += plan[j].seizedValue;
        }

        _absorb();

        // The premise, asserted rather than waited for: a run that quietly covered its debt would
        // otherwise be counted as checked while proving nothing.
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

    /// @notice Non-seizable collateral provides no coverage - LF = 0 → contributes no coverage
    /// @dev Built so the two readings are far apart: the ordinary collateral falls below covering the
    ///      debt while the non-seizable deposit beside it is worth several times that debt. A module
    ///      that counted it would have no shortfall at all, so the outcomes differ by the whole
    ///      uncovered remainder rather than by a rounding.
    function testFuzz_nonSeizableCollateralProvidesNoCoverage(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 deadAmount,
        uint256 borrowAmount,
        uint256 dropSeed
    ) public {
        uint8 dead = _deadIndex();

        // The draw never sees the non-seizable asset, so the borrow, the fall and the prices that
        // move are all worked out over the ordinary collateral alone.
        uint256 mask = _assetMask(maskSeed) & ~(uint256(1) << dead);
        vm.assume(mask != 0); // a position standing on nothing but the non-seizable asset

        Position memory p = _boundPositionMask(mask, supplySeed, borrowAmount, dropSeed, 0);

        uint256 badDebtDrop = _badDebtDrop(p);
        vm.assume(badDebtDrop >= 100); // no room left below full exhaustion to drop the prices into

        p.dropPpb = bound(dropSeed, _minDropPpb(p.amounts), badDebtDrop * 99 / 100);

        // Supplied here rather than through the scenario, so it is on the books when the plan is
        // read but its price never moves. Worth more than the whole debt, or its being ignored would
        // prove nothing.
        ICometData.AssetInfo memory deadInfo = comet.getAssetInfo(dead);
        uint256 deadCeiling = _supplyCeiling(deadInfo);
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

        // Nothing of it was taken, so nothing of it can have been credited.
        assertEq(
            comet.collateralBalanceOf(borrower, deadInfo.asset),
            deadSupply,
            "the non-seizable deposit was seized"
        );

        // At this fall, owing nothing can only be the protocol writing the remainder off. Counting
        // the deposit would have left the account collateralized and the debt standing instead.
        assertEq(comet.borrowBalanceOf(borrower), 0, "the debt survived a drop meant to exhaust the collateral");

        // And the loss is real: the borrower held collateral worth more than the whole debt and the
        // protocol still recovered less, which is only right if that collateral counted for nothing.
        assertLt(seizedValue, debtValueBefore, "the non-seizable deposit was counted towards the debt");
    }

    /*//////////////////////////////////////////////////////////////
                          BOUNDS AND SCENARIO
    //////////////////////////////////////////////////////////////*/

    /// @notice The set of collaterals, guaranteed to reach a scale the market does not otherwise use.
    /// @dev A draw that misses every odd scale has one forced on rather than being discarded, which
    ///      reshapes the run instead of throwing it away.
    function _assetMask(uint256 maskSeed) internal view override returns (uint256 mask) {
        uint8 numAssets = comet.numAssets();
        mask = bound(maskSeed, 1, (uint256(1) << numAssets) - 1);

        uint8[] memory odd = _oddScaleIndexes();

        uint256 oddMask;
        for (uint256 k; k < odd.length; ++k) {
            oddMask |= uint256(1) << odd[k];
        }

        if (mask & oddMask == 0) mask |= uint256(1) << odd[maskSeed % odd.length];
    }

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice The indexes whose scale is not one the market otherwise runs on.
    /// @dev Found on the market rather than named, so it follows the table above. A table without one
    ///      cannot state what this group is for, so the absence is a failure.
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

    /// @notice The smallest reduction of a seizure the protocol can notice.
    /// @dev A debt is stored in whole base tokens, so a shortfall worth less than one is forgiven on
    ///      the way back into the ledger rather than recorded - and on most assets a single token is
    ///      worth far less than that. The step is one base token in the collateral's own units, plus
    ///      the token the module was already granted by rounding its amount up. Both are read off the
    ///      market, neither is a margin chosen to make runs pass.
    function _smallestObservableStep(ICometData.AssetInfo memory info) internal view returns (uint256) {
        uint256 baseQuantum = Math.ceilDiv(comet.getPrice(address(basePriceFeed)), comet.baseScale());

        uint256 perBaseToken = Math.ceilDiv(
            baseQuantum * uint256(info.scale) * FACTOR_SCALE,
            comet.getPrice(info.priceFeed) * info.liquidationFactor
        );

        return perBaseToken + 1;
    }

    /// @notice Writes a plan into Comet as the module would, with the last entry shortened.
    /// @dev Pranked as the module, since Comet accepts a seizure from nobody else. The shortened
    ///      entry is credited at what the collateral actually left is worth, truncated: crediting a
    ///      part unit that was never taken is what would let the replay reach a target it has not
    ///      paid for.
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

    /// @notice The shallowest fall at which the whole position still settles the debt.
    /// @dev Two roundings are answered by raising the multiplier rather than hoping they cancel: the
    ///      division goes upwards, and one price unit per asset is added for the flooring each price
    ///      takes on its way into the feed. Neither term is tuned.
    function _badDebtDrop(Position memory p) internal view returns (uint256) {
        uint256 debtValue = _baseValue(p.borrow);

        for (uint8 i; i < uint8(p.amounts.length); ++i) {
            if (p.amounts[i] == 0) continue;

            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            debtValue += Math.ceilDiv(p.amounts[i] * info.liquidationFactor, uint256(info.scale) * FACTOR_SCALE);
        }

        return Math.ceilDiv(debtValue * DROP_SCALE, p.seizable);
    }

    /// @notice What the absorb reported paying out, in base and in value units.
    /// @dev The protocol's own outward statement, which is the right side of a claim about forgiven
    ///      debt: recomputing the payout instead would let a market that misfunds and misreports pass.
    function _absorbDebtReport(Vm.Log[] memory logs) internal view returns (uint256 basePaidOut, uint256 paidOutValue) {
        bytes32 signature = keccak256("AbsorbDebt(address,address,uint256,uint256)");

        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(comet)) continue;
            if (logs[i].topics.length == 0 || logs[i].topics[0] != signature) continue;

            return abi.decode(logs[i].data, (uint256, uint256));
        }
        revert("the absorb emitted no AbsorbDebt");
    }

    /// @notice The index of the asset the protocol will not seize.
    /// @dev Found by its factor, not its position, so the row can move without the test following.
    function _deadIndex() internal view returns (uint8) {
        uint8 numAssets = comet.numAssets();

        for (uint8 i; i < numAssets; ++i) {
            if (comet.getAssetInfo(i).liquidationFactor == 0) return i;
        }

        revert("the market holds no asset with a zero liquidation factor");
    }

    function _baseValue(uint256 amount) internal view returns (uint256) {
        return amount * comet.getPrice(address(basePriceFeed)) / comet.baseScale();
    }

    function _collateralValue(uint8 index, uint256 amount) internal view returns (uint256) {
        ICometData.AssetInfo memory info = comet.getAssetInfo(index);
        return amount * comet.getPrice(info.priceFeed) / uint256(info.scale);
    }

    /// @notice Splits runs in two on a seed already in hand, so a branch costs no extra argument.
    function _coinFlip(uint256 seed, string memory tag) internal pure returns (bool) {
        return uint256(keccak256(abi.encode(seed, tag))) % 2 == 0;
    }

    function _bitCount(uint256 mask) internal pure returns (uint256 count) {
        while (mask != 0) {
            mask &= mask - 1;
            ++count;
        }
    }
}
