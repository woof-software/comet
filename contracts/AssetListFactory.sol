// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { AssetList } from "./AssetList.sol";
import { IAssetListStructs } from "./interfaces/assetList/IAssetListStructs.sol";

/**
 * @title Compound's Asset List Factory
 * @author Compound
 */
contract AssetListFactory {
    event AssetListCreated(address indexed assetList, IAssetListStructs.ImmutableConfig[] assetConfigs);

    /**
     * @notice Create a new asset list
     * @dev Factors and supply caps are not part of the list's constructor; they are set later through its initialize
     * @param assetConfigs The immutable part of the asset configurations
     * @return assetList The address of the new asset list
     */
    function createAssetList(IAssetListStructs.ImmutableConfig[] memory assetConfigs) external returns (address assetList) {
        assetList = address(new AssetList(assetConfigs));
        emit AssetListCreated(assetList, assetConfigs);
    }
}
