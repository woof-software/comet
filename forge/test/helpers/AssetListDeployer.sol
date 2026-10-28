// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { AssetList } from "@comet-contracts/AssetList.sol";
import { CometConfiguration } from "@comet-contracts/CometConfiguration.sol";
import { IAssetListStructs } from "@comet-contracts/interfaces/assetList/IAssetListStructs.sol";
import { TransparentUpgradeableProxy } from "@comet-contracts/vendor/proxy/transparent/TransparentUpgradeableProxy.sol";

abstract contract AssetListDeployer {
    /// Deploys an asset list the way a market gets one: the implementation holds the immutable part of
    /// each config, and the proxy is initialized with the factors and the supply cap.
    function deployAssetList(CometConfiguration.AssetConfig[] memory assetConfigs, address admin, address configurator_)
        internal
        returns (AssetList)
    {
        IAssetListStructs.ImmutableAssetConfig[] memory immutableConfigs =
            new IAssetListStructs.ImmutableAssetConfig[](assetConfigs.length);
        IAssetListStructs.StorageAssetConfig[] memory storageConfigs =
            new IAssetListStructs.StorageAssetConfig[](assetConfigs.length);

        for (uint256 i; i < assetConfigs.length; ++i) {
            immutableConfigs[i] = IAssetListStructs.ImmutableAssetConfig({
                asset: assetConfigs[i].asset,
                decimals: assetConfigs[i].decimals,
                priceFeed: assetConfigs[i].priceFeed
            });
            storageConfigs[i] = IAssetListStructs.StorageAssetConfig({
                borrowCollateralFactor: assetConfigs[i].borrowCollateralFactor,
                liquidateCollateralFactor: assetConfigs[i].liquidateCollateralFactor,
                liquidationFactor: assetConfigs[i].liquidationFactor,
                supplyCap: assetConfigs[i].supplyCap
            });
        }

        return AssetList(address(new TransparentUpgradeableProxy(
            address(new AssetList(immutableConfigs, configurator_)),
            admin,
            abi.encodeCall(AssetList.initialize, (storageConfigs))
        )));
    }
}
