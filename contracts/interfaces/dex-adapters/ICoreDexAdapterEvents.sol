// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Core Dex Adapter events
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface ICoreDexAdapterEvents {
    /// @notice Emitted after collateral is successfully swapped into the base asset.
    /// @param collateral Address of the collateral swapped.
    /// @param amountIn Amount of the `collateral` swapped.
    /// @param amountOut Amount of the `baseAsset` sent to the liquidation module after swap.
    event Swap(address collateral, uint256 amountIn, uint256 amountOut);
}