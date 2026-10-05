// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "./IAssetListErrors.sol";
import "./IAssetListEvents.sol";
import "./IAssetListStructs.sol";
import "../IConfigHash.sol";

/**
 * @title Compound's Asset List
 * @notice Interface of the asset list. The functions are documented in the AssetList contract
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface IAssetList is IConfigHash, IAssetListErrors, IAssetListEvents, IAssetListStructs {
    function numAssets() external view returns (uint8);

    function configurator() external view returns (address);

    function addAsset(address asset, StorageConfig calldata config) external;

    function setBorrowCollateralFactor(address asset, uint64 borrowCollateralFactor) external;

    function setLiquidateCollateralFactor(address asset, uint64 liquidateCollateralFactor) external;

    function setLiquidationFactor(address asset, uint64 liquidationFactor) external;

    function setSupplyCap(address asset, uint128 supplyCap) external;

    function getAssetInfo(uint8 i) external view returns (AssetInfo memory);

    function getAssetInfoByAddress(address asset) external view returns (AssetInfo memory);
}
