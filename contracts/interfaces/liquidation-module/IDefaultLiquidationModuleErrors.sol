// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Default Liquidation Module Errors
 * @author Woof
 * @notice Interface of errors emitted by the DefaultLiquidationModule.
 * @custom:security-contact dmitriy@woof.software
 */
interface IDefaultLiquidationModuleErrors {
    /// @notice Reverts when the caller is not the bound Comet instance.
    error Unauthorized();

    error NotLiquidatable();

    error ZeroAddress();

    /// @notice Reverts when a price feed returns a non-positive price.
    error BadPrice();

    /// @notice Reverts when collateral that must be checked for borrower solvency is deactivated.
    error TokenIsDeactivated(address asset);
}
