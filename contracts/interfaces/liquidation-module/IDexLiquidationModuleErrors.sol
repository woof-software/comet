// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Dex Liquidation Module Errors
 * @author Woof
 * @notice Errors specific to DexLiquidationModule — the extended module that adds a DEX-based
 *         liquidation path on top of the base LiquidationModule.
 * @custom:security-contact dmitriy@woof.software
 */
interface IDexLiquidationModuleErrors {

    /// @notice Reverts when the number of provided swap calldatas does not match the number of seized
    ///         collaterals in the computed seizure plan.
    error InvalidSwapDataLength();

    /// @notice Reverts when incentiveBps is set above BPS (100%).
    error InvalidIncentiveBps();
}
