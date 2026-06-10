// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Liquidation Module Interface
 * @author Woof
 * @notice Errors and events specific to LiquidationModule — the extended module that adds a
 *         DEX-based liquidation path gated by configurable health factor boundaries.
 * @custom:security-contact dmitriy@woof.software
 */
interface ILiquidationModuleErrors {
    /// @notice Reverts when the new BORDER_HF or HEALTH_POSITION_HF value would violate the
    ///         invariant BORDER_HF < HEALTH_POSITION_HF, or when either value is zero.
    error InvalidHFBoundaries();

    error DexLiquidationNotImplemented();
}
