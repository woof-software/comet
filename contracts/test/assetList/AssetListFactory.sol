// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { AssetList } from "contracts/AssetList.sol";
import { IAssetListStructs } from "contracts/interfaces/assetList/IAssetListStructs.sol";

/**
 * @title Compound's Asset List Factory
 * @author Compound
 */
contract AssetListFactory {
    event AssetListCreated(address indexed assetList, IAssetListStructs.ImmutableAssetConfig[] assetConfigs);

    /// @notice The only address allowed to call the setters of every asset list this factory creates
    address public immutable configurator;

    /**
     * @param configurator_ The Configurator (its proxy) that will manage the asset lists this factory creates
     */
    constructor(address configurator_) {
        configurator = configurator_;
    }

    /**
     * @notice Create a new asset list
     * @dev Factors and supply caps are not part of the list's constructor; they are set later through its initialize,
     *      on the proxy that points to the new list
     * @param assetConfigs The immutable part of the asset configurations
     * @return assetList The address of the new asset list
     */
    function createAssetList(IAssetListStructs.ImmutableAssetConfig[] memory assetConfigs) external returns (address assetList) {
        assetList = address(new AssetList(assetConfigs, configurator));
        emit AssetListCreated(assetList, assetConfigs);
    }
}
