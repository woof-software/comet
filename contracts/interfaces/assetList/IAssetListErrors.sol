// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

/**
 * @title Compound's Asset List Errors
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface IAssetListErrors {
    /// @dev The number of storage configs differs from the number of assets
    error StorageConfigsLengthMismatch();

    /// @dev The asset is not listed, or the index is out of range
    error BadAsset();

    /// @dev The price feed or asset decimals differ from what is expected
    error BadDecimals();

    /// @dev The borrow collateral factor is not below the liquidate collateral factor
    error BorrowCFTooLarge();

    /// @dev The liquidate collateral factor is above 1
    error LiquidateCFTooLarge();

    /// @dev The liquidation factor is above 1
    error LiqPenaltyTooHigh();

    /// @dev The caller is not the configurator
    error OnlyConfigurator();

    /// @dev The configurator is the zero address
    error ZeroConfigurator();

    /// @dev The asset is already registered, so its storage config can only be changed through the setters
    error AssetAlreadyAdded();
}
