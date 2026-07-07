// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Core Liquidation Module Errors
 * @author Woof
 * @notice Interface of errors emitted by the DefaultLiquidationModule.
 * @custom:security-contact dmitriy@woof.software
 */
interface ICoreLiquidationModuleErrors {
    error OnlyComet();

    error NotLiquidatable();

    /// @notice Reverts when a price feed returns a non-positive price.
    error BadPrice();

    /// @notice Reverts when collateral that must be checked for borrower solvency is deactivated.
    error TokenIsDeactivated(address asset);

    /// @notice Reverts when the number of assets is set to zero.
    error InvalidNumAssets();
}
