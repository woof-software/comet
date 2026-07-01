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

    /// @notice Reverts when the number of provided swap calldatas does not match the number of seized
    ///         collaterals in the computed seizure plan.
    error InvalidSwapDataLength();

    /// @notice Reverts when incentiveBps is set above BPS (100%).
    error InvalidIncentiveBps();

    /// @notice Reverts when absorb is paused on the Comet.
    error Paused();
}
