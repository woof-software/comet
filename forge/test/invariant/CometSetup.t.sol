// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

import {Test} from "forge-std/Test.sol";
import {CometWithExtendedAssetList} from "../../../contracts/CometWithExtendedAssetList.sol";
import {CometConfiguration} from "../../../contracts/CometConfiguration.sol";
import {CometExtAssetList} from "../../../contracts/CometExtAssetList.sol";
import {AssetListFactory} from "../../../contracts/AssetListFactory.sol";
import {FaucetToken} from "../../../contracts/test/FaucetToken.sol";
import {SimplePriceFeed} from "../../../contracts/test/SimplePriceFeed.sol";

/// @notice Prove that we can spin up Comet.
///         No invariants yet — just a deployment + one trivial test.
contract CometSetupTest is Test, CometConfiguration {
    CometWithExtendedAssetList public comet;

    // tokens
    FaucetToken public base;        // base asset (USDC-like, 6 decimals)
    FaucetToken public weth;        // collateral #1

    // price feeds (8 decimals — PRICE_FEED_DECIMALS requirement)
    SimplePriceFeed public basePriceFeed;
    SimplePriceFeed public wethPriceFeed;

    function setUp() public {
        // 1) base and collateral tokens
        base = new FaucetToken(0, "USD Coin", 6, "USDC");
        weth = new FaucetToken(0, "Wrapped ETH", 18, "WETH");

        // 2) price feeds: price in 8 decimals. base = $1, weth = $2000
        basePriceFeed = new SimplePriceFeed(1e8, 8);
        wethPriceFeed = new SimplePriceFeed(2000e8, 8);

        // 3) extensionDelegate chain: factory -> ext
        AssetListFactory factory = new AssetListFactory();
        ExtConfiguration memory extConfig = ExtConfiguration({
            name32: "Compound USDC",
            symbol32: "cUSDCv3"
        });
        CometExtAssetList ext = new CometExtAssetList(extConfig, address(factory));

        // 4) asset config: a single collateral (WETH)
        AssetConfig[] memory assets = new AssetConfig[](1);
        assets[0] = AssetConfig({
            asset: address(weth),
            priceFeed: address(wethPriceFeed),
            decimals: 18,
            borrowCollateralFactor: 0.8e18,      // 80%
            liquidateCollateralFactor: 0.85e18,  // 85%
            liquidationFactor: 0.95e18,          // 95%
            supplyCap: 1_000_000e18
        });

        // 5) main Comet config
        Configuration memory config = Configuration({
            governor: address(this),
            pauseGuardian: address(this),
            baseToken: address(base),
            baseTokenPriceFeed: address(basePriceFeed),
            extensionDelegate: address(ext),
            supplyKink: 0.8e18,
            supplyPerYearInterestRateSlopeLow: 0.04e18,
            supplyPerYearInterestRateSlopeHigh: 0.4e18,
            supplyPerYearInterestRateBase: 0,
            borrowKink: 0.8e18,
            borrowPerYearInterestRateSlopeLow: 0.05e18,
            borrowPerYearInterestRateSlopeHigh: 0.5e18,
            borrowPerYearInterestRateBase: 0.01e18,
            storeFrontPriceFactor: 0.5e18,
            trackingIndexScale: 1e15,
            baseTrackingSupplySpeed: 0,
            baseTrackingBorrowSpeed: 0,
            baseMinForRewards: 1e6,          // != 0 (BadMinimum requirement)
            baseBorrowMin: 1e6,
            targetReserves: 0,
            assetConfigs: assets
        });

        comet = new CometWithExtendedAssetList(config);
    }

    /// trivial test: Comet is up and returns its basic parameters
    function test_deploymentWorks() public view {
        assertEq(comet.baseToken(), address(base));
        assertEq(comet.numAssets(), 1);
    }
}
