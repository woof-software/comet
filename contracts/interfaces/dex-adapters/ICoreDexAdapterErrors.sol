// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Core Dex Adapter errors
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface ICoreDexAdapterErrors {
    /// @notice Thrown when a required address is zero address.
    error ZeroAddress();
    /// @notice Thrown when the configured slippage is zero or greater than BPS.
    error SlippageOutOfBounds(uint256 _slippageBps);
    /// @notice Thrown when swap() is called by an address other than the liquidation module.
    error Unathorized();
    /// @notice Thrown when the realized base-asset output is below the required minimum.
    error InvalidAmountOut();
    /// @notice Thrown when collateral exchange amount is zero.
    error ZeroAmountIn();
}