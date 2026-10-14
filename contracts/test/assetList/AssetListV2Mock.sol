// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { AssetList } from "../../AssetList.sol";
import { IAssetListStructs } from "../../interfaces/assetList/IAssetListStructs.sol";

/**
 * @dev AssetList with the same storage and TYPEHASH, plus version(), so a proxy upgraded to it shows the new code
 */
contract AssetListV2Mock is AssetList {
    constructor(ImmutableAssetConfig[] memory assetConfigs) AssetList(assetConfigs) {}

    function version() external pure returns (uint256) {
        return 2;
    }
}

contract AssetListFactoryV2Mock {
    function createAssetList(IAssetListStructs.ImmutableAssetConfig[] memory assetConfigs) external returns (address) {
        return address(new AssetListV2Mock(assetConfigs));
    }
}
