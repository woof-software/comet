// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "./ConfiguratorIntermediateStorageOptimism.sol";

/**
 * @title Compound's Configurator Contract, Intermediate version for Optimism
 * @dev Temporary implementation for the Configurator upgrade path on Optimism (ConfiguratorV1 -> ConfiguratorIntermediateOptimism -> ConfiguratorOptimism).
 *      Same as ConfiguratorIntermediate, but keeps the marketAdminPermissionChecker slot of the Optimism Configurator.
 *      It only moves the asset configs to their new storage, so it has nothing else of the Configurator.
 *      Delete this folder once the upgrade is deployed.
 */
contract ConfiguratorIntermediateOptimism is ConfiguratorIntermediateStorageOptimism {

    /** Custom events **/
    event AssetConfigsMigrated(address indexed cometProxy, uint256 numAssets);

    /** Custom errors **/
    error AlreadyInitialized();
    error AlreadyMigrated();
    error InvalidAddress();
    error Unauthorized();

    /**
     * @notice Constructs a new Configurator instance
     **/
    constructor() {
        // Set a high version to prevent the implementation contract from being initialized
        version = type(uint256).max;
    }

    /**
     * @notice Initializes the storage for Configurator
     * @param governor_ The address of the governor
     **/
    function initialize(address governor_) public {
        if (version != 0) revert AlreadyInitialized();
        if (governor_ == address(0)) revert InvalidAddress();

        governor = governor_;
        version = 1;
    }

    /**
     * @notice Moves the asset configs of each market from Configuration.assetConfigs to the assetConfigs mapping
     * @dev Note: Only callable by governor. The whole configs are copied, factors and supply caps included.
     *      Clearing Configuration.assetConfigs also zeroes the slot the final Configuration reads as assetList
     * @param comets The Comet proxies to migrate
     */
    function migrateAssetConfig(address[] calldata comets) external {
        if (msg.sender != governor) revert Unauthorized();

        for (uint256 i; i < comets.length; ++i) {
            address cometProxy = comets[i];
            // A second run would copy the already cleared, empty array over the migrated configs
            if (assetConfigs[cometProxy].length != 0) revert AlreadyMigrated();

            uint256 numAssets = configuratorParams[cometProxy].assetConfigs.length;
            assetConfigs[cometProxy] = configuratorParams[cometProxy].assetConfigs;
            delete configuratorParams[cometProxy].assetConfigs;
            emit AssetConfigsMigrated(cometProxy, numAssets);
        }
    }
}
