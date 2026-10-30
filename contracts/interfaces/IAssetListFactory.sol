// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { IAssetListStructs } from "./assetList/IAssetListStructs.sol";

/**
 * @title Compound's Asset List Factory
 * @author Compound
 */
interface IAssetListFactory {
    /**
     * @notice Create a new asset list
     * @param assetConfigs The immutable part of the asset configurations
     * @param configurator The only address allowed to call the setters of the new asset list
     * @return assetList The address of the new asset list
     */
    function createAssetList(
        IAssetListStructs.ImmutableAssetConfig[] memory assetConfigs,
        address configurator
    ) external returns (address assetList);
}