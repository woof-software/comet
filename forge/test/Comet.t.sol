// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../../contracts/Comet.sol";
import "../../contracts/configuratorUpgrade/CometConfigurationV1.sol";
import { CometExtAssetList } from "../../contracts/CometExtAssetList.sol";
import { AssetListFactory } from "../../contracts/AssetListFactory.sol";


contract CometTest is Test {
    Comet public comet;

    function setUp() public {
        // XXX
    }

    function test_RevertIf_Condition_XXX() public {
        CometConfigurationV1.AssetConfig[] memory assets = new CometConfigurationV1.AssetConfig[](0);
        CometConfigurationV1.Configuration memory config =
            CometConfigurationV1.Configuration(address(0),
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
        comet = new Comet(config);
    }
}
