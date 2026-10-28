// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { AssetList } from "@comet-contracts/AssetList.sol";
import { CometConfiguration } from "@comet-contracts/CometConfiguration.sol";
import { CometCore } from "@comet-contracts/CometCore.sol";
import { IERC20NonStandard } from "@comet-contracts/interfaces/IERC20NonStandard.sol";
import { IAssetListErrors } from "@comet-contracts/interfaces/assetList/IAssetListErrors.sol";

import { ProtocolFixture } from "../helpers/ProtocolFixture.sol";

/**
 * @title Supply cap storage invariants
 * @notice The asset list stores a supply cap in full, as the uint128 it is configured with, next to
 *         the collateral factors. These fuzz tests hold the cap that comes back out to the cap that
 *         went in, across the market's whole asset table.
 */
contract SupplyCapTest is ProtocolFixture {
    function setUp() public {
        prepareFixture();
    }

    /// Driven straight by the fuzzer: the cap itself is the input, so every value a
    /// uint128 can hold is fair game. The whole market gets it, which covers every asset index.
    function testFuzz_anySupplyCapReadsBackExactly(uint128 supplyCap) public {
        uint128[] memory supplyCaps = new uint128[](collaterals.length);

        for (uint256 i; i < supplyCaps.length; ++i) {
            supplyCaps[i] = supplyCap;
        }

        _assertSupplyCapsReadBackExactly(supplyCaps);
    }

    /// Any uint128 cap reads back exactly as configured, at every asset index.
    /// Each collateral gets a different cap, so a cap leaking between assets shows up here.
    function testFuzz_supplyCapReadsBackExactly(uint256 seed) public {
        uint128[] memory supplyCaps = new uint128[](collaterals.length);

        for (uint256 i; i < supplyCaps.length; ++i) {
            supplyCaps[i] = uint128(uint256(keccak256(abi.encode(seed, i))));
        }

        _assertSupplyCapsReadBackExactly(supplyCaps);
    }

    /// A cap below one whole token survives, where the old whole-unit packing left zero
    function testFuzz_subUnitSupplyCapReadsBackExactly(uint256 seed) public {
        uint128[] memory supplyCaps = new uint128[](collaterals.length);

        for (uint256 i; i < supplyCaps.length; ++i) {
            uint256 oneToken = 10 ** assetSpecs[i + 1].decimals; // index 0 is the base token
            supplyCaps[i] = uint128(bound(uint256(keccak256(abi.encode(seed, i))), 1, oneToken - 1));
        }

        _assertSupplyCapsReadBackExactly(supplyCaps);
    }

    /// The cap is stored next to the collateral factors, and the asset info joins it with the
    /// immutable part of the config. Every other field of the asset info must survive any cap.
    function testFuzz_supplyCapDoesNotBleedIntoOtherFields(uint128 supplyCap) public {
        CometConfiguration.AssetConfig[] memory assetConfigs =
            configurator.getAssetConfigs(address(cometProxy));

        for (uint256 i; i < assetConfigs.length; ++i) {
            assetConfigs[i].supplyCap = supplyCap;
        }

        AssetList assetList = deployAssetList(assetConfigs, address(proxyAdmin), address(configuratorProxy));

        for (uint8 i; i < assetConfigs.length; ++i) {
            CometCore.AssetInfo memory assetInfo = assetList.getAssetInfo(i);

            assertEq(assetInfo.offset, i, "offset");
            assertEq(assetInfo.asset, assetConfigs[i].asset, "asset");
            assertEq(assetInfo.priceFeed, assetConfigs[i].priceFeed, "price feed");
            assertEq(assetInfo.scale, 10 ** IERC20NonStandard(assetConfigs[i].asset).decimals(), "scale");
            assertEq(assetInfo.borrowCollateralFactor, assetConfigs[i].borrowCollateralFactor, "borrow collateral factor");
            assertEq(assetInfo.liquidateCollateralFactor, assetConfigs[i].liquidateCollateralFactor, "liquidate collateral factor");
            assertEq(assetInfo.liquidationFactor, assetConfigs[i].liquidationFactor, "liquidation factor");
        }
    }

    /// The old packing split the cap across two words at bit 88. The values right at that seam
    /// must read back exactly like any other.
    function test_supplyCapBitBoundariesReadBackExactly() public {
        uint128[5] memory boundaries = [
            uint128(2 ** 88 - 1),      // every bit below the seam set
            uint128(2 ** 88),          // the lowest cap above the seam
            uint128(2 ** 88 + 1),      // a bit on each side of the seam
            uint128((2 ** 40 - 1) << 88), // every bit above the seam set, none below
            type(uint128).max          // every bit set
        ];

        for (uint256 boundary; boundary < boundaries.length; ++boundary) {
            uint128[] memory supplyCaps = new uint128[](collaterals.length);

            for (uint256 i; i < supplyCaps.length; ++i) {
                supplyCaps[i] = boundaries[boundary];
            }

            _assertSupplyCapsReadBackExactly(supplyCaps);
        }
    }

    /// Whatever the market's asset count is, each collateral answers at its own index
    /// and anything past the last one reverts.
    function testFuzz_assetIndexesHoldForAnyAssetCount(uint128 supplyCap, uint8 assetCount, uint8 badIndex) public {
        assetCount = uint8(bound(assetCount, 1, collaterals.length));
        badIndex = uint8(bound(badIndex, assetCount, type(uint8).max));

        CometConfiguration.AssetConfig[] memory marketConfigs = configurator.getAssetConfigs(address(cometProxy));
        CometConfiguration.AssetConfig[] memory assetConfigs = new CometConfiguration.AssetConfig[](assetCount);

        for (uint256 i; i < assetCount; ++i) {
            assetConfigs[i] = marketConfigs[i];
            assetConfigs[i].supplyCap = supplyCap;
        }

        AssetList assetList = deployAssetList(assetConfigs, address(proxyAdmin), address(configuratorProxy));
        assertEq(assetList.numAssets(), assetCount, "asset count");

        for (uint8 i; i < assetCount; ++i) {
            CometCore.AssetInfo memory assetInfo = assetList.getAssetInfo(i);
            assertEq(assetInfo.offset, i, "offset");
            assertEq(assetInfo.supplyCap, supplyCap, "supply cap does not read back as configured");
        }

        vm.expectRevert(IAssetListErrors.AssetIndexOutOfRange.selector);
        assetList.getAssetInfo(badIndex);
    }

    /// The asset info depends on nothing but the config, so two asset lists built from
    /// the same configs answer the same way. A leftover of the deployment itself would show up here.
    function testFuzz_equalConfigsGiveEqualAssetInfo(uint256 seed) public {
        CometConfiguration.AssetConfig[] memory assetConfigs =
            configurator.getAssetConfigs(address(cometProxy));

        for (uint256 i; i < assetConfigs.length; ++i) {
            assetConfigs[i].supplyCap = uint128(uint256(keccak256(abi.encode(seed, i))));
        }

        AssetList assetList = deployAssetList(assetConfigs, address(proxyAdmin), address(configuratorProxy));
        AssetList otherAssetList = deployAssetList(assetConfigs, address(proxyAdmin), address(configuratorProxy));

        for (uint8 i; i < assetConfigs.length; ++i) {
            assertEq(
                keccak256(abi.encode(assetList.getAssetInfo(i))),
                keccak256(abi.encode(otherAssetList.getAssetInfo(i))),
                "asset info differs between two asset lists built from the same configs"
            );
        }
    }

    /// Takes the market's own asset configs, swaps in the given caps, and reads every collateral back
    function _assertSupplyCapsReadBackExactly(uint128[] memory supplyCaps) internal {
        CometConfiguration.AssetConfig[] memory assetConfigs =
            configurator.getAssetConfigs(address(cometProxy));

        for (uint256 i; i < assetConfigs.length; ++i) {
            assetConfigs[i].supplyCap = supplyCaps[i];
        }

        AssetList assetList = deployAssetList(assetConfigs, address(proxyAdmin), address(configuratorProxy));

        for (uint8 i; i < assetConfigs.length; ++i) {
            CometCore.AssetInfo memory assetInfo = assetList.getAssetInfo(i);
            assertEq(assetInfo.supplyCap, supplyCaps[i], "supply cap does not read back as configured");
        }
    }
}
