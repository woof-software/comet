// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import "forge-std/Test.sol";

import { AssetList } from "@comet-contracts/AssetList.sol";
import { IAssetListStructs } from "@comet-contracts/interfaces/assetList/IAssetListStructs.sol";
import { ConfigHash } from "@comet-contracts/libraries/ConfigHash.sol";
import { TransparentUpgradeableProxy } from "@comet-contracts/vendor/proxy/transparent/TransparentUpgradeableProxy.sol";

import { FaucetToken } from "@comet-contracts/test/FaucetToken.sol";
import { SimplePriceFeed } from "@comet-contracts/test/SimplePriceFeed.sol";

/**
 * @title ConfigHash library
 * @notice How the Configurator decides whether an asset list has to be redeployed: compareConfigHashes reads the
 *         hash the asset list was built from and tells whether the new immutable configs are still the same ones.
 */
contract ConfigHashTest is Test {
    /// An asset list built from `configs`, and a proxy in front of it
    AssetList internal assetList;
    AssetList internal assetListProxy;
    IAssetListStructs.ImmutableAssetConfig[] internal configs;

    function setUp() public {
        uint8[3] memory decimals = [18, 8, 6];
        for (uint256 i; i < decimals.length; ++i) {
            configs.push(_deployConfig(decimals[i]));
        }

        assetList = new AssetList(configs, makeAddr("configurator"));
        assetListProxy = AssetList(address(new TransparentUpgradeableProxy(address(assetList), makeAddr("proxyAdmin"), "")));
    }

    /*//////////////////////////////////////////////////////////////
                               hashConfig
    //////////////////////////////////////////////////////////////*/

    /// An asset list stores the hash of the configs it was built from, under its own type hash
    function test_hashConfig_matchesAssetListConfigHash() public view {
        assertEq(ConfigHash.hashConfig(assetList.TYPEHASH(), abi.encode(configs)), assetList.configHash());
    }

    /*//////////////////////////////////////////////////////////////
                    compareConfigHashes: RETURNS TRUE
    //////////////////////////////////////////////////////////////*/

    /// An asset list built from the same configs needs no redeploy, read directly or through its proxy,
    /// which is the address the Configurator holds
    function test_compareConfigHashes_trueForAssetListBuiltFromSameConfigs() public view {
        assertTrue(ConfigHash.compareConfigHashes(address(assetList), abi.encode(configs)), "asset list");
        assertTrue(ConfigHash.compareConfigHashes(address(assetListProxy), abi.encode(configs)), "asset list proxy");
    }

    /*//////////////////////////////////////////////////////////////
           compareConfigHashes: RETURNS FALSE, THE CONFIG DIFFERS
    //////////////////////////////////////////////////////////////*/

    function test_compareConfigHashes_falseWhenAssetChanged() public {
        IAssetListStructs.ImmutableAssetConfig[] memory newConfigs = configs;
        newConfigs[1].asset = makeAddr("otherAsset");

        assertFalse(ConfigHash.compareConfigHashes(address(assetList), abi.encode(newConfigs)));
    }

    function test_compareConfigHashes_falseWhenPriceFeedChanged() public {
        IAssetListStructs.ImmutableAssetConfig[] memory newConfigs = configs;
        newConfigs[1].priceFeed = makeAddr("otherPriceFeed");

        assertFalse(ConfigHash.compareConfigHashes(address(assetList), abi.encode(newConfigs)));
    }

    function test_compareConfigHashes_falseWhenElementAdded() public {
        IAssetListStructs.ImmutableAssetConfig[] memory newConfigs = new IAssetListStructs.ImmutableAssetConfig[](configs.length + 1);
        for (uint256 i; i < configs.length; ++i) {
            newConfigs[i] = configs[i];
        }
        newConfigs[configs.length] = IAssetListStructs.ImmutableAssetConfig(makeAddr("newAsset"), makeAddr("newPriceFeed"));

        assertFalse(ConfigHash.compareConfigHashes(address(assetList), abi.encode(newConfigs)));
    }

    function test_compareConfigHashes_falseWhenElementRemoved() public {
        IAssetListStructs.ImmutableAssetConfig[] memory newConfigs = new IAssetListStructs.ImmutableAssetConfig[](configs.length - 1);
        for (uint256 i; i < newConfigs.length; ++i) {
            newConfigs[i] = configs[i];
        }

        assertFalse(ConfigHash.compareConfigHashes(address(assetList), abi.encode(newConfigs)));
    }

    function test_compareConfigHashes_falseWhenElementsReordered() public {
        IAssetListStructs.ImmutableAssetConfig[] memory newConfigs = configs;
        (newConfigs[0], newConfigs[1]) = (newConfigs[1], newConfigs[0]);

        assertFalse(ConfigHash.compareConfigHashes(address(assetList), abi.encode(newConfigs)));
    }

    /*//////////////////////////////////////////////////////////////
       compareConfigHashes: RETURNS FALSE, NO HASH TO COMPARE WITH
    //////////////////////////////////////////////////////////////*/

    /// A migrated market has no asset list until the first one is deployed for it
    function test_compareConfigHashes_falseForZeroAddress() public view {
        assertFalse(ConfigHash.compareConfigHashes(address(0), abi.encode(configs)));
    }

    /// An asset list from before config hashing, like the one on main, has no configHash getter
    function test_compareConfigHashes_falseForOldAssetListWithoutConfigHash() public {
        assertFalse(ConfigHash.compareConfigHashes(address(new OldAssetList()), abi.encode(configs)));
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// A config with a real token and price feed, as the asset list constructor reads both
    function _deployConfig(uint8 decimals) internal returns (IAssetListStructs.ImmutableAssetConfig memory) {
        return IAssetListStructs.ImmutableAssetConfig({
            asset: address(new FaucetToken(0, "Token", decimals, "TKN")),
            priceFeed: address(new SimplePriceFeed(1e8, 8))
        });
    }
}

/// Stands for an asset list built before config hashing: no configHash, no TYPEHASH, no fallback
contract OldAssetList {
    uint8 public constant numAssets = 0;
}
