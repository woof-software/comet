// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { CometConfiguration } from "@comet-contracts/CometConfiguration.sol";
import { CometCore } from "@comet-contracts/CometCore.sol";
import { CometProxyAdmin, Deployable } from "@comet-contracts/CometProxyAdmin.sol";

import { ProtocolFixture } from "../helpers/ProtocolFixture.sol";

/**
 * @title Collateral configuration invariants
 * @notice The configurator holds the caps governance votes on, and an upgrade is what carries them
 *         into the market. These tests hold the two sides to the same numbers.
 */
contract CollateralConfigurationTest is ProtocolFixture {
    function setUp() public {
        prepareFixture();
    }

    /// A cap set through the configurator and carried over by an upgrade is the cap the
    /// market answers with, for every collateral. Caps cover the whole uint128 range and differ per
    /// asset, so a cap landing on the wrong collateral shows up as well.
    function testFuzz_configuredSupplyCapsReachTheMarket(uint256 seed) public {
        CometConfiguration.AssetConfig[] memory assetConfigs =
            configurator.getConfiguration(address(cometProxy)).assetConfigs;

        vm.startPrank(timelock);
        for (uint256 i; i < assetConfigs.length; ++i) {
            uint128 supplyCap = uint128(uint256(keccak256(abi.encode(seed, i))));
            configurator.updateAssetSupplyCap(address(cometProxy), assetConfigs[i].asset, supplyCap);
        }
        proxyAdmin.deployAndUpgradeTo(Deployable(address(configuratorProxy)), cometProxy);
        vm.stopPrank();

        CometConfiguration.AssetConfig[] memory storedConfigs = configurator.getConfiguration(address(cometProxy)).assetConfigs;

        assertEq(comet.numAssets(), storedConfigs.length, "asset count differs from the configurator's");

        for (uint8 i; i < storedConfigs.length; ++i) {
            CometCore.AssetInfo memory assetInfo = comet.getAssetInfo(i);

            assertEq(storedConfigs[i].supplyCap, uint128(uint256(keccak256(abi.encode(seed, i)))), "configurator did not store the cap");
            assertEq(assetInfo.asset, storedConfigs[i].asset, "collateral order differs from the configurator's");
            assertEq(assetInfo.supplyCap, storedConfigs[i].supplyCap, "market cap differs from the configurator's");
        }
    }
}
