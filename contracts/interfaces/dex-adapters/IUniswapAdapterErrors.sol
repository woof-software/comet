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
}