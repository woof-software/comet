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
    /// @notice Reverts when the new BORDER_HF value is zero.
    error InvalidHFBoundaries();

    /// @notice Reverts when the number of provided swap calldatas does not match the number of seized
    ///         collaterals in the computed seizure plan.
    error InvalidSwapDataLength();

    /// @notice Reverts when the base received from the DEX swaps cannot cover the base owed to Comet to
    ///         clear the liquidated debt after the executor's penalty is taken.
    /// @param baseReceived The base amount realized from the swaps.
    /// @param baseRequired The minimum base required (debt cleared plus the executor penalty).
    error SwapProceedsTooLow(uint256 baseReceived, uint256 baseRequired);

    /// @notice Reverts when penaltyBps is set above BPS (100%).
    error InvalidPenaltyBps();
}
