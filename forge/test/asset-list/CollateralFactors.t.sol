// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { AssetList } from "@comet-contracts/AssetList.sol";
import { CometConfiguration } from "@comet-contracts/CometConfiguration.sol";
import { CometCore } from "@comet-contracts/CometCore.sol";

import { ProtocolFixture } from "../helpers/ProtocolFixture.sol";

/**
 * @title Collateral factor descaling invariants
 * @notice The asset list stores each collateral factor with four decimal digits, so everything below
 *         one precision step of 1e14 is dropped when the factor is stored. These fuzz tests state what
 *         governance expects from a valid factor setup and show where dropping those digits breaks it.
 *         Each test gives every collateral of the market the same factors, which covers every asset index.
 */
contract CollateralFactorsTest is ProtocolFixture {
    /// The smallest factor difference the asset list can store: one unit of the fourth decimal digit
    uint64 internal constant PRECISION_STEP = 1e14;

    /// The highest liquidation factor the asset list accepts
    uint64 internal constant MAX_COLLATERAL_FACTOR = 1e18;

    /// Factors of an ordinary active collateral, all exact multiples of the precision step
    uint64 internal constant COLLATERAL_LCF = 0.8e18;
    uint64 internal constant COLLATERAL_LF = 0.9e18;

    function setUp() public {
        prepareFixture();
    }

    /*//////////////////////////////////////////////////////////////
                  ORDERED FACTORS ARE ACCEPTED AS ORDERED
    //////////////////////////////////////////////////////////////*/

    /// The plainest form of the ordering rule: any borrow collateral factor below the liquidate
    /// collateral factor is valid, so it must be accepted and stay below it once stored.
    /// Both factors are drawn from 0.6 to 0.8, the range real markets use, and the fuzzer only skips
    /// pairs that are not ordered. The liquidation factor is at its maximum so it never gets in the way.
    function testFuzz_borrowFactorBelowLiquidateFactor(uint64 collateralBCF, uint64 collateralLCF) public {
        collateralBCF = uint64(bound(collateralBCF, 0.6e18, 0.8e18));
        collateralLCF = uint64(bound(collateralLCF, 0.6e18, 0.8e18));
        vm.assume(collateralBCF < collateralLCF);

        AssetList assetList = _deployWithFactors(collateralBCF, collateralLCF, MAX_COLLATERAL_FACTOR);

        for (uint8 i; i < collaterals.length; ++i) {
            CometCore.AssetInfo memory assetInfo = assetList.getAssetInfo(i);
            assertLt(assetInfo.borrowCollateralFactor, assetInfo.liquidateCollateralFactor, "stored borrow factor is not below the liquidate factor");
        }
    }

    /// The same rule one step up: any liquidate collateral factor below the liquidation factor is valid,
    /// so it must be accepted and stay below it once stored. Both factors are drawn from 0.8 to 0.9,
    /// the range real markets use, and the borrow factor is zero so only this ordering is under test.
    function testFuzz_liquidateFactorBelowLiquidationFactor(uint64 collateralLCF, uint64 collateralLF) public {
        collateralLCF = uint64(bound(collateralLCF, 0.8e18, 0.9e18));
        collateralLF = uint64(bound(collateralLF, 0.8e18, 0.9e18));
        vm.assume(collateralLCF < collateralLF);

        AssetList assetList = _deployWithFactors(0, collateralLCF, collateralLF);

        for (uint8 i; i < collaterals.length; ++i) {
            CometCore.AssetInfo memory assetInfo = assetList.getAssetInfo(i);
            assertLt(assetInfo.liquidateCollateralFactor, assetInfo.liquidationFactor, "stored liquidate factor is not below the liquidation factor");
        }
    }

    /// Any liquidation factor up to the maximum is valid, so it must be accepted and stay at or below
    /// the maximum once stored. The other two factors are zero so only the upper bound is under test.
    function testFuzz_liquidationFactorAtMostMax(uint64 collateralLF) public {
        collateralLF = uint64(bound(collateralLF, 0, MAX_COLLATERAL_FACTOR));

        AssetList assetList = _deployWithFactors(0, 0, collateralLF);

        for (uint8 i; i < collaterals.length; ++i) {
            assertLe(assetList.getAssetInfo(i).liquidationFactor, MAX_COLLATERAL_FACTOR, "stored liquidation factor is above the maximum");
        }
    }

    /// The borrow collateral factor in the config always equals the one getAssetInfo returns
    function testFuzz_storedBorrowFactorEqualsConfigured(uint64 collateralBCF) public {
        collateralBCF = uint64(bound(collateralBCF, 1, COLLATERAL_LCF - 1));

        AssetList assetList = _deployWithFactors(collateralBCF, COLLATERAL_LCF, COLLATERAL_LF);

        for (uint8 i; i < collaterals.length; ++i) {
            assertEq(assetList.getAssetInfo(i).borrowCollateralFactor, collateralBCF, "stored borrow factor differs from the configured one");
        }
    }

    /// The liquidate collateral factor in the config always equals the one getAssetInfo returns
    function testFuzz_storedLiquidateFactorEqualsConfigured(uint64 collateralLCF) public {
        collateralLCF = uint64(bound(collateralLCF, 1, COLLATERAL_LF - 1));

        AssetList assetList = _deployWithFactors(0, collateralLCF, COLLATERAL_LF);

        for (uint8 i; i < collaterals.length; ++i) {
            assertEq(assetList.getAssetInfo(i).liquidateCollateralFactor, collateralLCF, "stored liquidate factor differs from the configured one");
        }
    }

    /// The liquidation factor in the config always equals the one getAssetInfo returns
    function testFuzz_storedLiquidationFactorEqualsConfigured(uint64 collateralLF) public {
        collateralLF = uint64(bound(collateralLF, 1, MAX_COLLATERAL_FACTOR));

        AssetList assetList = _deployWithFactors(0, 0, collateralLF);

        for (uint8 i; i < collaterals.length; ++i) {
            assertEq(assetList.getAssetInfo(i).liquidationFactor, collateralLF, "stored liquidation factor differs from the configured one");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// Builds an asset list from the market's own asset configs, with the given factors on every collateral
    function _deployWithFactors(uint64 collateralBCF, uint64 collateralLCF, uint64 collateralLF)
        internal
        returns (AssetList)
    {
        CometConfiguration.AssetConfig[] memory assetConfigs =
            configurator.getConfiguration(address(cometProxy)).assetConfigs;

        for (uint256 i; i < assetConfigs.length; ++i) {
            assetConfigs[i].borrowCollateralFactor = collateralBCF;
            assetConfigs[i].liquidateCollateralFactor = collateralLCF;
            assetConfigs[i].liquidationFactor = collateralLF;
        }

        return new AssetList(assetConfigs);
    }
}
