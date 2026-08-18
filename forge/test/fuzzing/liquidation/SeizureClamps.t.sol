// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { console2 } from "forge-std/console2.sol";

import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";

import { ProtocolFixture } from "../../helpers/ProtocolFixture.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Are the clamps after the ceiling divisions reachable
 * @notice `_computeSeizurePlan` and `_processDebtClosing` each round a quantity up and then clamp the
 *         result. A clamp that no input can reach is dead code; one that a single input can reach is
 *         load-bearing, because the line it protects would revert on underflow instead.
 *
 *         The clamps guard pure integer expressions, so they are checked as pure integer expressions
 *         here rather than by driving absorbs: the inputs are enumerated over the whole range the
 *         module can hand them, which a few thousand end-to-end liquidations would never cover. Every
 *         asset in the market is swept on every run, so the coarse collaterals — where a single unit
 *         is worth thousands of value units, and where a rounded-up unit overshoots hardest — are
 *         always included rather than sampled.
 */
contract SeizureClampsFuzzTest is ProtocolFixture {
    /// Mirrors the contract's own helper.
    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function setUp() public {
        prepareFixture();
    }

    /**
     * @notice Clamp A — `if (seizedAmount > collateralAmount)` in the partial branch.
     * @dev Reached only under `wantedCollateralValue < collateralValue`, so the branch condition is
     *      reproduced exactly: the fuzzed value is bounded to one below the balance's own value.
     */
    function testFuzz_partialSeizedAmountFitsInBalance(uint256 balanceSeed, uint256 wantedSeed) public view {
        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory assetInfo = comet.getAssetInfo(i);
            uint256 scale = assetInfo.scale;
            uint256 price = comet.getPrice(assetInfo.priceFeed);

            uint256 collateralAmount = bound(balanceSeed, 1, Math.min(1_000_000 * scale, assetInfo.supplyCap));

            uint256 collateralValue = collateralAmount * price / scale;
            if (collateralValue < 2) continue; // nothing the branch could ask for

            // The whole range the branch admits, from a single value unit up to one below the balance.
            uint256 wantedCollateralValue = bound(wantedSeed, 1, collateralValue - 1);

            uint256 seizedAmount = ceilDiv(wantedCollateralValue * scale, price);

            if (seizedAmount > collateralAmount) {
                console2.log(string.concat("clamp A reached on ", assetSpecs[i + 1].symbol));
                console2.log("  balance      ", collateralAmount);
                console2.log("  wanted value ", wantedCollateralValue);
                console2.log("  seized amount", seizedAmount);
            }

            assertLe(seizedAmount, collateralAmount, "the rounded-up seizure exceeds the balance");
        }
    }

    /**
     * @notice Clamp B — `if (seizedValue > debtRemainingValue)` in the partial branch.
     * @dev Unlike the other two, `wantedCollateralValue` is not fuzzed: it is solved for exactly as
     *      the module solves for it, because the value it can take is what the question turns on.
     *
     *      This one is reachable, and the test asserts that it is: the clamp must not be removed. The
     *      region that reaches it is narrow and is swept rather than sampled. It sits where the debt is
     *      worth almost exactly what the collateral can repay after the penalty — the request then comes
     *      within a few units of the whole balance, rounding up takes the balance entire, and the value
     *      credited for it exceeds what is still owed. The running collateralization is swept from this
     *      asset's own contribution, which is the least the loop can hold when it reaches the asset,
     *      since no earlier iteration can have removed it.
     *
     *      Without the clamp `debtRemainingValue -= seizedValue` underflows and the absorb reverts, so
     *      the account could not be liquidated at all.
     */
    function test_partialSeizedValueClampIsReachable() public view {
        uint256 reached;

        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory assetInfo = comet.getAssetInfo(i);
            uint256 scale = assetInfo.scale;

            // A few magnitudes rather than a fuzzed balance: whether the clamp is reachable is a
            // property of the market's factors and decimals, not of any particular position, and a
            // fixed sweep says so without depending on where the fuzzer happens to look.
            for (uint256 magnitude; magnitude < 4; ++magnitude) {
                uint256 collateralAmount = Math.min(
                    scale * (10 ** (magnitude * 2)),
                    Math.min(1_000_000 * scale, assetInfo.supplyCap)
                );
                reached += _sweepAsset(i, assetInfo, collateralAmount);
            }
        }

        assertGt(reached, 0, "no input reached the clamp, it may be dead code now");
    }

    /// Sweeps clamp B's neighbourhood for one asset at one balance.
    function _sweepAsset(
        uint8 index,
        ICometData.AssetInfo memory assetInfo,
        uint256 collateralAmount
    ) internal view returns (uint256 reached) {
        uint256 scale = assetInfo.scale;
        uint256 price = comet.getPrice(assetInfo.priceFeed);
        uint256 minDebtValue = comet.baseBorrowMin() * comet.getPrice(comet.baseTokenPriceFeed()) / comet.baseScale();

        {
            uint256 collateralValue = collateralAmount * price / scale;
            if (collateralValue < 2) return 0;

            // The debt the collateral can just barely repay once the penalty is applied.
            uint256 payableValue = collateralAmount * price * assetInfo.liquidationFactor / (scale * FACTOR_SCALE);
            if (payableValue < minDebtValue + 8) return 0; // below the minimum the plan closes the debt instead

            uint256 ownContribution =
                collateralAmount * price * assetInfo.borrowCollateralFactor / (scale * FACTOR_SCALE);

            for (uint256 debtOffset; debtOffset < 8; ++debtOffset) {
                uint256 debtRemainingValue = payableValue - debtOffset;

                for (uint256 collateralizationOffset; collateralizationOffset < 8; ++collateralizationOffset) {
                    reached += _overshootsTheDebt(
                        index,
                        assetInfo,
                        collateralAmount,
                        collateralValue,
                        debtRemainingValue,
                        ownContribution + collateralizationOffset
                    );
                }
            }
        }
    }

    /// One combination of clamp B's check. Returns 1 when the credit overshoots the remaining debt.
    function _overshootsTheDebt(
        uint8 index,
        ICometData.AssetInfo memory assetInfo,
        uint256 collateralAmount,
        uint256 collateralValue,
        uint256 debtRemainingValue,
        uint256 totalCollateralizedValue
    ) internal view returns (uint256) {
        uint256 scale = assetInfo.scale;
        uint256 price = comet.getPrice(assetInfo.priceFeed);

        // Past this point the loop would have broken out on target reached.
        if (debtRemainingValue * TARGET_HF / FACTOR_SCALE <= totalCollateralizedValue) return 0;

        uint256 wantedCollateralValue = ceilDiv(
            (debtRemainingValue * TARGET_HF - totalCollateralizedValue * FACTOR_SCALE) * FACTOR_SCALE,
            uint256(assetInfo.liquidationFactor) * TARGET_HF
                - uint256(assetInfo.borrowCollateralFactor) * FACTOR_SCALE
        );

        uint256 maxWantedCollateralValue = debtRemainingValue * FACTOR_SCALE / assetInfo.liquidationFactor;
        if (wantedCollateralValue > maxWantedCollateralValue) wantedCollateralValue = maxWantedCollateralValue;

        if (wantedCollateralValue >= collateralValue) return 0; // the other branch seizes everything

        uint256 seizedAmount = ceilDiv(wantedCollateralValue * scale, price);
        uint256 seizedValue = ceilDiv(seizedAmount * price * assetInfo.liquidationFactor, scale * FACTOR_SCALE);

        if (seizedValue > debtRemainingValue) {
            console2.log(string.concat("clamp B reached on ", assetSpecs[index + 1].symbol));
            console2.log("  balance             ", collateralAmount);
            console2.log("  debt remaining      ", debtRemainingValue);
            console2.log("  collateralization   ", totalCollateralizedValue);
            console2.log("  wanted value        ", wantedCollateralValue);
            console2.log("  seized amount       ", seizedAmount);
            console2.log("  seized value        ", seizedValue);
            console2.log("  overshoot           ", seizedValue - debtRemainingValue);
            return 1;
        }

        return 0;
    }

    /**
     * @notice Clamp C — `if (seizedAmount > collateralAmount)` in `_processDebtClosing`.
     * @dev Reached only under `debtRemainingValue < collateralValueLeft`, which is reproduced exactly.
     */
    function testFuzz_debtClosingSeizedAmountFitsInBalance(uint256 balanceSeed, uint256 debtSeed) public view {
        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory assetInfo = comet.getAssetInfo(i);
            uint256 scale = assetInfo.scale;
            uint256 price = comet.getPrice(assetInfo.priceFeed);

            uint256 collateralAmount = bound(balanceSeed, 1, Math.min(1_000_000 * scale, assetInfo.supplyCap));

            uint256 collateralValueLeft =
                collateralAmount * price * assetInfo.liquidationFactor / (scale * FACTOR_SCALE);
            if (collateralValueLeft < 2) continue; // the branch is unreachable, everything is seized

            uint256 debtRemainingValue = bound(debtSeed, 1, collateralValueLeft - 1);

            uint256 seizedAmount = ceilDiv(
                debtRemainingValue * FACTOR_SCALE * scale,
                uint256(assetInfo.liquidationFactor) * price
            );

            if (seizedAmount > collateralAmount) {
                console2.log(string.concat("clamp C reached on ", assetSpecs[i + 1].symbol));
                console2.log("  balance      ", collateralAmount);
                console2.log("  debt value   ", debtRemainingValue);
                console2.log("  seized amount", seizedAmount);
            }

            assertLe(seizedAmount, collateralAmount, "the rounded-up seizure exceeds the balance");
        }
    }
}
