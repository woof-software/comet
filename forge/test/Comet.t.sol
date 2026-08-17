// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import { CometWithExtendedAssetList } from "@comet-contracts/CometWithExtendedAssetList.sol";
import { CometConfiguration } from "@comet-contracts/CometConfiguration.sol";
import { CometExtAssetList } from "@comet-contracts/CometExtAssetList.sol";
import { AssetListFactory } from "@comet-contracts/AssetListFactory.sol";


contract CometTest is Test {
    CometWithExtendedAssetList public comet;

    function setUp() public {
        // XXX
    }

    function test_RevertIf_Condition_XXX() public {
        CometConfiguration.AssetConfig[] memory assets = new CometConfiguration.AssetConfig[](0);
        CometConfiguration.Configuration memory config =
            CometConfiguration.Configuration({
                governor: address(0),
                pauseGuardian: address(0),
                baseToken: address(0),
                baseTokenPriceFeed: address(0),
                extensionDelegate: address(0),
                supplyKink: 0,
                supplyPerYearInterestRateSlopeLow: 0,
                supplyPerYearInterestRateSlopeHigh: 0,
                supplyPerYearInterestRateBase: 0,
                borrowKink: 0,
                borrowPerYearInterestRateSlopeLow: 0,
                borrowPerYearInterestRateSlopeHigh: 0,
                borrowPerYearInterestRateBase: 0,
                storeFrontPriceFactor: 0,
                trackingIndexScale: 0,
                baseTrackingSupplySpeed: 0,
                baseTrackingBorrowSpeed: 0,
                baseMinForRewards: 0,
                baseBorrowMin: 0,
                targetReserves: 0,
                assetConfigs: assets,
                liquidationModule: address(0)
            });
        vm.expectRevert();
        comet = new CometWithExtendedAssetList(config);
    }
}
