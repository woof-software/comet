// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { Vm } from "forge-std/Vm.sol";

import { CometConfiguration } from "@comet-contracts/CometConfiguration.sol";
import { CometInterface } from "@comet-contracts/CometInterface.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";
import { ICoreLiquidationModule } from "@comet-contracts/interfaces/liquidation-module/ICoreLiquidationModule.sol";
import { FaucetToken } from "@comet-contracts/test/FaucetToken.sol";

import { LiquidationMath } from "../../helpers/LiquidationMath.sol";
import { LiquidationFuzzBase } from "./LiquidationFuzzBase.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Protocol accounting after a seizure
 * @notice That a seizure lands correctly in Comet's books, and that no token moves while it does.
 * @dev Market rates are zero throughout: accrual would shift the base totals independently of the
 *      liquidation and blur every delta. It also pins `baseBorrowIndex`, which is what lets the
 *      reserve check assert an equality rather than a tolerance.
 */
contract ProtocolAccountingFuzzTest is LiquidationFuzzBase {
    using LiquidationMath for CometInterface;

    uint64 internal constant BASE_INDEX_SCALE = 1e15;

    address internal secondBorrower = makeAddr("secondBorrower");

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
        seedMarketActivity();
    }

    /*//////////////////////////////////////////////////////////////
                              COLLATERAL
    //////////////////////////////////////////////////////////////*/

    /// @notice The asset total falls by the seized amount - totalSupplyAsset after = before - seizedAmount
    /// @dev Exactly what was taken from the borrower, no more and no less.
    function testFuzz_assetTotalFallsBySeizedAmount(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);
        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        // A total holding nothing but the borrower's deposit cannot tell "fell by the seized amount"
        // apart from "was wiped". Added after the position, so the cap never turns the borrower away.
        if (_coinFlip(supplySeed, "second supplier")) {
            uint8 numAssets = comet.numAssets();
            for (uint8 i; i < numAssets; ++i) {
                if (p.amounts[i] == 0) continue;

                ICometData.AssetInfo memory info = comet.getAssetInfo(i);
                (uint128 totalSupplyAsset,) = comet.totalsCollateral(info.asset);
                uint256 headroom = uint256(info.supplyCap) - uint256(totalSupplyAsset);
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

            // An addition rather than a subtraction: a total that fell too far would underflow and
            // revert, and a revert says less than a failed assertion.
            assertEq(
                uint256(totalSupplyAsset) + plan[j].seizedAmount,
                totalsBefore[j],
                "the asset total did not fall by the seized amount"
            );
        }
    }

    /// @notice Reserves grow by the seized amount - reserves after = before + seizedAmount
    /// @dev A collateral reserve is derived, not stored, so this cannot fail while the asset total
    ///      and the token balance both hold. Kept anyway: it is the figure the protocol reports
    ///      outward, and the one that breaks first if reserves ever become stored.
    function testFuzz_reservesGrowBySeizedAmount(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);

        // Reserves starting at zero would let "grew by" pass as "was set to". Tokens sent to Comet
        // directly raise the reserve without raising the tracked total, which is the gap reported.
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

    /// @notice Collateral tokens do not move - comet token balance unchanged
    /// @dev On the default route a seizure is an accounting move, not a transfer.
    function testFuzz_collateralTokensDoNotMove(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);
        _baseScenario(p, partialEnabled);

        // Every asset, not only the planned ones: a transfer of something unnamed is the failure.
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

    /// @notice Total borrow falls by the principal delta - totalBorrowBase after = before - dPrincipal
    /// @dev No divergence from index rounding.
    function testFuzz_totalBorrowFallsByPrincipalDelta(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);

        // A market whose only debt is the absorbed account's cannot tell "fell by the delta" apart
        // from "was zeroed". The second borrower stands on an asset the fall never reaches.
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

    /// @notice Total base supply does not change - totalSupply unchanged
    /// @dev Liquidating a borrower does not touch the base suppliers.
    function testFuzz_totalBaseSupplyDoesNotChange(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);
        _baseScenario(p, partialEnabled);

        uint256 totalSupplyBefore = comet.totalSupply();
        uint256 totalSupplyBaseBefore = comet.totalsBasic().totalSupplyBase;

        // A market with nothing supplied would hold this by having nothing to move.
        assertGt(totalSupplyBefore, 0, "the market carries no base supply for the invariant to protect");

        _absorb();

        assertEq(comet.totalSupply(), totalSupplyBefore, "absorbing a borrower moved the base suppliers");

        // The same claim one level down: the two part company only if a change in the total were
        // offset by a change in the supply index.
        assertEq(
            comet.totalsBasic().totalSupplyBase,
            totalSupplyBaseBefore,
            "absorbing a borrower moved the base suppliers' principal"
        );
    }

    /// @notice Base tokens do not move - comet base balance unchanged
    /// @dev Writing down a debt is bookkeeping, not a transfer.
    function testFuzz_baseTokensDoNotMove(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);
        _baseScenario(p, partialEnabled);

        uint256 balanceBefore = baseToken.balanceOf(address(comet));

        _absorb();

        assertEq(baseToken.balanceOf(address(comet)), balanceBefore, "the base token moved on the default route");
    }

    /// @notice Base reserves fall by the amount paid out - baseReserves after = before - basePaidOut
    /// @dev The payout is derived from the collateral that actually left the borrower, not read off
    ///      the `AbsorbDebt` event: a market that misfunds and misreports by the same amount would
    ///      satisfy a check that took its own report as the source. The event is then held to it.
    ///
    ///      The zero tolerance holds only while the borrow index sits at `BASE_INDEX_SCALE`, where
    ///      the principal-to-present conversion cannot round. Asserted below rather than assumed.
    function testFuzz_baseReservesFallByAmountPaidOut(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);
        uint256 basePrice = comet.getPrice(comet.baseTokenPriceFeed());

        // A fall drawn across the whole range nearly always exhausts the collateral, and a write-off
        // leaves the bracket below with nothing to say. The slice where the collateral still covers
        // the debt is only a few percent wide, so half the runs are drawn inside it on purpose.
        uint256 coversDebt = (p.borrow * basePrice / comet.baseScale()) * DROP_SCALE / p.seizable;
        if (coversDebt <= p.dropCeiling && _coinFlip(dropSeed, "covering drop")) {
            p.dropPpb = bound(dropSeed, coversDebt, p.dropCeiling);
        }

        ICoreLiquidationModule.Seizure[] memory plan = _baseScenario(p, partialEnabled);

        // The premise of the zero tolerance above.
        assertEq(comet.totalsBasic().baseBorrowIndex, BASE_INDEX_SCALE, "the borrow index left BASE_INDEX_SCALE");

        int256 reservesBefore = comet.getReserves();
        uint256 debtBefore = comet.borrowBalanceOf(borrower);

        vm.recordLogs();
        _absorb();

        uint256 debtAfter = comet.borrowBalanceOf(borrower);

        // An account left with nothing that carries borrowing power can never cover a remainder, so
        // the protocol takes the loss instead of leaving the debt standing.
        {
            (uint256 low, uint256 high) = _debtLeftBySeizure(plan, debtBefore * basePrice / comet.baseScale());

            if (comet.weightedCollateral(borrower) == 0) {
                assertEq(debtAfter, 0, "an account stripped of collateralization was left owing");
            } else {
                assertGe(debtAfter, low * comet.baseScale() / basePrice, "the seizure paid off more than it is worth");
                assertLe(debtAfter, high * comet.baseScale() / basePrice, "the seizure paid off less than it is worth");
            }
        }

        // Anchored to collateral that genuinely left the borrower, so both the reserve and the
        // report are held to it.
        uint256 paidOut = debtBefore - debtAfter;

        assertEq(
            comet.getReserves(),
            reservesBefore - int256(paidOut),
            "base reserves did not fall by the amount the seizure pays off"
        );
        (uint256 reported, uint256 reportedValue) = _absorbDebtReport(vm.getRecordedLogs());

        assertEq(reported, paidOut, "AbsorbDebt reported a payout the seizure does not pay for");

        // Nothing else in the suite reads this figure, so unchecked it could drift in silence.
        assertEq(
            reportedValue,
            paidOut * basePrice / comet.baseScale(),
            "AbsorbDebt priced the payout wrongly"
        );
    }

    /*//////////////////////////////////////////////////////////////
                             THE MODULE
    //////////////////////////////////////////////////////////////*/

    /// @notice The module receives no tokens - module balance delta = 0
    /// @dev Nothing passes through the module; it only writes into Comet's storage.
    function testFuzz_moduleReceivesNoTokens(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        uint256 dustSeed,
        bool partialEnabled
    ) public {
        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);
        _baseScenario(p, partialEnabled);

        // A module starting empty makes "took nothing" and "swept it straight out" indistinguishable.
        // Dust goes on every token, since an untouched asset is where a stray transfer would hide,
        // and each pile is drawn separately so a transfer matching another amount still shows.
        FaucetToken[] memory tokens = _marketTokens();
        for (uint256 t; t < tokens.length; ++t) {
            tokens[t].allocateTo(
                address(liquidationModule),
                bound(
                    uint256(keccak256(abi.encode(dustSeed, t))),
                    0,
                    1_000_000 * uint256(10 ** tokens[t].decimals())
                )
            );
        }

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

    /// @notice The adapter is never called - adapter calls = 0
    /// @dev The adapter exists only because the module cannot be deployed without one.
    function testFuzz_adapterIsNeverCalled(
        uint256 maskSeed,
        uint256 supplySeed,
        uint256 borrowAmount,
        uint256 dropSeed,
        bool partialEnabled
    ) public {
        // A fallback counter stands in for one on every method: the claim is that none is reached.
        CallCounter counter = CallCounter(payable(address(dexAdapter)));
        vm.etch(address(dexAdapter), address(new CallCounter()).code);

        Position memory p = _boundPositionMask(_assetMask(maskSeed), supplySeed, borrowAmount, dropSeed, 0);
        _baseScenario(p, partialEnabled);

        counter.reset();

        _absorb();

        assertEq(counter.calls(), 0, "the default route reached the DEX adapter");
    }

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Opens a borrow for a second account on an asset the mask left out.
    /// @dev That asset's price never moves, so the account stays healthy across the absorb and its
    ///      debt is still on the books afterwards. A mask covering everything leaves nowhere to
    ///      stand, and the run goes ahead without it.
    function _openSecondBorrow(Position memory p) internal {
        uint8 numAssets = comet.numAssets();

        for (uint8 i; i < numAssets; ++i) {
            if (p.amounts[i] != 0) continue;

            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            uint256 amount = _supplyCeiling(info);

            uint256 limit = amount * comet.getPrice(info.priceFeed) / uint256(info.scale);
            limit = limit * info.borrowCollateralFactor / FACTOR_SCALE;
            uint256 borrow = limit * comet.baseScale() / comet.getPrice(comet.baseTokenPriceFeed()) / 2;
            if (borrow < BASE_BORROW_MIN) return;

            collaterals[i].allocateTo(secondBorrower, amount);

            vm.startPrank(secondBorrower);
            collaterals[i].approve(address(comet), amount);
            comet.supply(address(collaterals[i]), amount);
            comet.withdraw(address(baseToken), borrow);
            vm.stopPrank();

            return;
        }
    }

    /// @notice The debt a seizure can honestly leave, bracketed by which way its credits round.
    /// @dev A seizure's worth rarely lands on a whole value unit, and the module chooses the rounding
    ///      direction per branch - so the walk is run both ways and the two bracket the answer. One
    ///      value unit per seized asset wide, which is the price feed's resolution, not a margin
    ///      picked to fit.
    /// @return low  crediting every part unit up
    /// @return high crediting every part unit down
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

    /// @notice What the absorb reported paying out, in base and in value units.
    function _absorbDebtReport(Vm.Log[] memory logs) internal view returns (uint256 basePaidOut, uint256 usdValue) {
        bytes32 signature = keccak256("AbsorbDebt(address,address,uint256,uint256)");

        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(comet)) continue;
            if (logs[i].topics.length == 0 || logs[i].topics[0] != signature) continue;

            return abi.decode(logs[i].data, (uint256, uint256));
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

    /// @notice Splits runs in two on a seed already in hand, so a branch costs no extra argument.
    function _coinFlip(uint256 seed, string memory tag) internal pure returns (bool) {
        return uint256(keccak256(abi.encode(seed, tag))) & 1 == 0;
    }
}

/// @notice Stands in for the DEX adapter and counts calls instead of answering them.
/// @dev `calls` and `reset` have their own selectors, so reading and clearing never reach the
///      fallback that increments.
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
