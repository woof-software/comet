// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

/**
 * @title Compound's Asset List Errors
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface IAssetListErrors {
    /// @dev The asset list is built with no assets
    error NoAssets();

    /// @dev The asset list is built with more assets than it can hold
    error TooManyAssets();

    /// @dev The number of storage configs differs from the number of assets
    error StorageConfigsLengthMismatch();

    /// @dev The index is not below the number of assets
    error AssetIndexOutOfRange();

    /// @dev The asset is not registered in the list
    error AssetNotFound();

    /// @dev The asset's position in the registered assets differs from its index in the immutables
    error AssetIndexMismatch();

    /// @dev The asset or its price feed is the zero address
    error ZeroAddress();

    /// @dev The price feed does not have the expected 8 decimals
    error PriceFeedDecimalsNotMatched();

    /// @dev The asset has too many decimals for its scale to fit in uint64
    error MaxAssetDecimalsExceeds();

    /// @dev The borrow collateral factor is not below the liquidate collateral factor
    error BorrowCFTooLarge();

    /// @dev The liquidate collateral factor is above 1
    error LiquidateCFTooLarge();

    /// @dev The liquidation factor is above 1
    error LiqPenaltyTooHigh();

    /// @dev The caller is not the configurator
    error OnlyConfigurator();

    /// @dev The caller is not the admin of the list proxy
    error OnlyProxyAdmin();

    /// @dev The configurator is the zero address
    error ZeroConfigurator();

    /// @dev The asset is already registered, so its storage config can only be changed through the setters
    error AssetAlreadyAdded();
}
