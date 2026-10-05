// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title Compound's Asset List Structs
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface IAssetListStructs {
    /**
     * @notice The part of an asset config that never changes for a deployed asset list
     * @dev Passed to the asset list constructor and kept in immutables, so reading it costs no storage access.
     *      Changing any of these values means deploying a new asset list
     */
    struct ImmutableConfig {
        address asset;                      // slot 0
        uint8 decimals;
        address priceFeed;                  // slot 1
    }

    /**
     * @notice The part of an asset config the configurator can change without redeploying the asset list
     * @dev Kept in storage so the setters can update it
     */
    struct StorageConfig {
        uint64 borrowCollateralFactor;      // slot 0
        uint64 liquidateCollateralFactor;
        uint64 liquidationFactor;
        uint128 supplyCap;                  // slot 1
    }

    /**
     * @notice Everything about one asset, as returned by getAssetInfo and getAssetInfoByAddress
     * @dev Joins the immutable part (asset, scale, price feed) with the storage part (factors, supply cap).
     *      The offset is the asset's index in the list. The scale is 10 to the power of the asset decimals
     */
    struct AssetInfo {
        address asset;                      // slot 0
        uint64 scale;
        uint8 offset;
        address priceFeed;                  // slot 1
        uint64 borrowCollateralFactor;
        uint128 supplyCap;                  // slot 2
        uint64 liquidateCollateralFactor;
        uint64 liquidationFactor;
    }

    /**
     * @notice Storage of the asset list's mutable configs
     * @dev The set lets the setters reject an unlisted asset with one lookup, without scanning the immutables.
     *      Configs are keyed by asset address, so they stay attached to the right asset whatever its index
     */
    struct AssetConfigStorage {
        EnumerableSet.AddressSet assets;    // slots 0-1
        mapping(address => StorageConfig) configs; // slot 2
    }
}
