// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Uniswap Adapter errors
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface IUniswapAdapterErrors {
    /// @notice Thrown when the provided routes count does not match the number of Comet collateral assets.
    error InvalidRoutesNumber();

    /// @notice Thrown when a collateral's route is empty.
    /// @param collateral The collateral asset whose route is invalid.
    error EmptyPath(address collateral);

    /// @notice Thrown when there is no swap route for collateral in Uniswap V4.
    /// @param collateral The collateral asset whose route is missing.
    error MissingSwapRoute(address collateral);
}