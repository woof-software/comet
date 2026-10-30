// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "./ConfiguratorIntermediateStorage.sol";

/**
 * @title Compound's Configurator Contract, Intermediate version
 * @dev Temporary implementation for the Configurator upgrade path (ConfiguratorV1 -> ConfiguratorIntermediate -> Configurator).
 *      It only moves the asset configs to their new storage, so it has nothing else of the Configurator.
 *      Delete this folder once the upgrade is deployed.
 */
contract ConfiguratorIntermediate is ConfiguratorIntermediateStorage {

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
     * @dev Note: Only callable by governor. Every field but decimals is copied, factors and supply caps included;
     *      decimals are dropped because the asset list now reads them from the token.
     *      Clearing Configuration.assetConfigs also zeroes the slot the final Configuration reads as assetList
     * @param comets The Comet proxies to migrate
     */
    function migrateAssetConfig(address[] calldata comets) external {
        if (msg.sender != governor) revert Unauthorized();

        for (uint256 i; i < comets.length; ++i) {
            address cometProxy = comets[i];
            // A second run would copy the already cleared, empty array over the migrated configs
            if (assetConfigs[cometProxy].length != 0) revert AlreadyMigrated();

            AssetConfig[] storage oldConfigs = configuratorParams[cometProxy].assetConfigs;
            uint256 numAssets = oldConfigs.length;
            // The old struct has decimals between the price feed and the factors, so the two layouts differ
            // and each config is rebuilt field by field instead of copying the array as a whole
            for (uint256 j; j < numAssets; ++j) {
                AssetConfig storage oldConfig = oldConfigs[j];
                assetConfigs[cometProxy].push(CometConfiguration.AssetConfig({
                    asset: oldConfig.asset,
                    priceFeed: oldConfig.priceFeed,
                    borrowCollateralFactor: oldConfig.borrowCollateralFactor,
                    liquidateCollateralFactor: oldConfig.liquidateCollateralFactor,
                    liquidationFactor: oldConfig.liquidationFactor,
                    supplyCap: oldConfig.supplyCap
                }));
            }
            delete configuratorParams[cometProxy].assetConfigs;
            emit AssetConfigsMigrated(cometProxy, numAssets);
        }
    }
}
