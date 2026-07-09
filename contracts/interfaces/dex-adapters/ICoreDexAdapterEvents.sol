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

    /// @notice Emitted when the redundant swap fails and the collateral is swept back to Comet for absorption.
    /// @param collateral Address of the collateral that could not be swapped.
    /// @param amountIn Amount of the `collateral` swept back to Comet.
    event RedundantSwapFailed(address collateral, uint256 amountIn);

    /// @notice Emitted when slippage is set.
    /// @param collateral address(0) for the global slippage, or the collateral address for a per-collateral override.
    /// @param _oldBps Previous slippage in basis points.
    /// @param _newBps New slippage in basis points.
    event SlippageSet(address collateral, uint16 _oldBps, uint16 _newBps);
}