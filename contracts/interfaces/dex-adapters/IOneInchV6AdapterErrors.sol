// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title OneInch V6 Adapter errors
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface IOneInchV6AdapterErrors {
    /// @notice Thrown when the swap calldata is shorter than a 4-byte selector.
    error InvalidSwapData();
    /// @notice Thrown when the swap calldata selector is not IOneInchV6.swap.
    error InvalidSelector();
    /// @notice Thrown when the calldata src/dst tokens do not match the collateral and base asset.
    error InvalidTokens();
    /// @notice Thrown when the swap recipient is not this adapter.
    error InvalidReceiver();
    /// @notice Thrown when the calldata input amount does not match the swap amount.
    error InvalidAmountIn();
    /// @notice Thrown when the calldata minimum return is below the required minimum output.
    error InvalidMinAmountOut();
}