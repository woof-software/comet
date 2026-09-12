// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Liquidation Module Errors
 * @author Woof
 * @notice Errors specific to LiquidationModule — the base module exposing the keeper-driven absorb
 *         liquidation entry point. DEX-route errors live in IDexLiquidationModuleErrors.
 * @custom:security-contact dmitriy@woof.software
 */
interface ILiquidationModuleErrors {

    /// @notice Reverts when absorb is paused on the Comet.
    error Paused();
}
