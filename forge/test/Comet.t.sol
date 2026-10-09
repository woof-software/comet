// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../../contracts/CometWithExtendedAssetList.sol";
import "../../contracts/configurator/CometConfigurationIntermediate.sol";
import { CometExtAssetList } from "../../contracts/CometExtAssetList.sol";
import { AssetListFactory } from "../../contracts/AssetListFactory.sol";


contract CometTest is Test {
    CometWithExtendedAssetList public comet;

    function setUp() public {
        // XXX
    }

    function test_RevertIf_Condition_XXX() public {
        CometConfigurationIntermediate.AssetConfig[] memory assets = new CometConfigurationIntermediate.AssetConfig[](0);
        CometConfigurationIntermediate.Configuration memory config =
            CometConfigurationIntermediate.Configuration(address(0),
                          address(0),
                          address(0),
                          address(0),
                          address(0),
                          0,
                          0,
                          0,
                          0,
                          0,
                          0,
                          0,
                          0,
                          0,
                          0,
                          0,
                          0,
                          0,
                          0,
                          0,
                          assets);
        vm.expectRevert();
        comet = new CometWithExtendedAssetList(config);
    }
}
