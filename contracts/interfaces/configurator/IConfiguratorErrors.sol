// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

/**
 * @title Compound's Configurator Errors
 * @author Compound
 */
interface IConfiguratorErrors {
    /// @dev The Configurator is already initialized, or is the implementation, which can never be initialized
    error AlreadyInitialized();

    /// @dev The Comet proxy has no asset list proxy yet; the first one is set by setConfiguration
    error AssetListNotSet();

    /// @dev The Comet proxy already has an asset list proxy, so setConfiguration, which sets it, can't be called again
    error ConfigurationAlreadyExists();

    /// @dev The Comet proxy has no asset list factory, so a new asset list can't be deployed; it is set by setAssetListFactory
    error AssetListFactoryNotSet();

    /// @dev The asset is already in the asset configs of the Comet proxy
    error AssetAlreadyExists();

    /// @dev The asset is not in the asset configs of the Comet proxy
    error AssetDoesNotExist();

    /// @dev The address is the zero address
    error InvalidAddress();

    /// @dev The caller is not allowed to call this function
    error Unauthorized();
}
