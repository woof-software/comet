// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

/**
 * @title Compound's Configurator Errors
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface IConfiguratorErrors {
    /// @dev The Configurator is already initialized, or is the implementation, which can never be initialized
    error AlreadyInitialized();

    /// @dev The asset is not in the asset configs of the Comet proxy
    error AssetDoesNotExist();

    /// @dev The Comet proxy already has a configuration with a different base token or tracking index scale
    error ConfigurationAlreadyExists();

    /// @dev The address is the zero address
    error InvalidAddress();

    /// @dev The caller is not allowed to call this function
    error Unauthorized();
}
