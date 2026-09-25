// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { AssetList } from "@comet-contracts/AssetList.sol";
import { CometConfiguration } from "@comet-contracts/CometConfiguration.sol";
import { CometCore } from "@comet-contracts/CometCore.sol";
import { CometMainInterface } from "@comet-contracts/CometMainInterface.sol";

import { ProtocolFixture } from "../helpers/ProtocolFixture.sol";

/**
 * @title Supply cap packing invariants
 * @notice The asset list stores a supply cap in full: the lower 88 bits sit in one packed word and
 *         the upper 40 bits in the other. These fuzz tests hold the cap that comes back out to the
 *         cap that went in, across the market's whole asset table.
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

    /// The cap sits in the spare bits of both packed words, so a shift or mask error
    /// would land on a neighbouring field. Every other field of the asset info must survive any cap.
    function testFuzz_supplyCapDoesNotBleedIntoOtherFields(uint128 supplyCap) public {
        CometConfiguration.AssetConfig[] memory assetConfigs =
            configurator.getConfiguration(address(cometProxy)).assetConfigs;

        for (uint256 i; i < assetConfigs.length; ++i) {
            assetConfigs[i].supplyCap = supplyCap;
        }

        AssetList assetList = new AssetList(assetConfigs);

        for (uint8 i; i < assetConfigs.length; ++i) {
            CometCore.AssetInfo memory assetInfo = assetList.getAssetInfo(i);

            assertEq(assetInfo.offset, i, "offset");
            assertEq(assetInfo.asset, assetConfigs[i].asset, "asset");
            assertEq(assetInfo.priceFeed, assetConfigs[i].priceFeed, "price feed");
            assertEq(assetInfo.scale, 10 ** assetConfigs[i].decimals, "scale");
            // The market's factors are multiples of the 1e14 step the packing keeps, so they read back exactly
            assertEq(assetInfo.borrowCollateralFactor, assetConfigs[i].borrowCollateralFactor, "borrow collateral factor");
            assertEq(assetInfo.liquidateCollateralFactor, assetConfigs[i].liquidateCollateralFactor, "liquidate collateral factor");
            assertEq(assetInfo.liquidationFactor, assetConfigs[i].liquidationFactor, "liquidation factor");
        }
    }

    /// The cap is split across the two packed words at bit 88, so the values right at
    /// that seam are the ones an off-by-one shift or a wrong mask would drop.
    function test_supplyCapBitBoundariesReadBackExactly() public {
        uint128[5] memory boundaries = [
            uint128(2 ** 88 - 1),      // fills the lower word's share, upper bits empty
            uint128(2 ** 88),          // the lowest cap that reaches the upper word
            uint128(2 ** 88 + 1),      // both words carry a bit
            uint128((2 ** 40 - 1) << 88), // every upper bit set, lower share empty
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
    /// and anything past the last one reverts. The cap now shares a word with the index fields.
    function testFuzz_assetIndexesHoldForAnyAssetCount(uint128 supplyCap, uint8 assetCount, uint8 badIndex) public {
        assetCount = uint8(bound(assetCount, 1, collaterals.length));
        badIndex = uint8(bound(badIndex, assetCount, type(uint8).max));

        CometConfiguration.AssetConfig[] memory marketConfigs = configurator.getConfiguration(address(cometProxy)).assetConfigs;
        CometConfiguration.AssetConfig[] memory assetConfigs = new CometConfiguration.AssetConfig[](assetCount);

        for (uint256 i; i < assetCount; ++i) {
            assetConfigs[i] = marketConfigs[i];
            assetConfigs[i].supplyCap = supplyCap;
        }

        AssetList assetList = new AssetList(assetConfigs);
        assertEq(assetList.numAssets(), assetCount, "asset count");

        for (uint8 i; i < assetCount; ++i) {
            CometCore.AssetInfo memory assetInfo = assetList.getAssetInfo(i);
            assertEq(assetInfo.offset, i, "offset");
            assertEq(assetInfo.supplyCap, supplyCap, "supply cap does not read back as configured");
        }

        vm.expectRevert(CometMainInterface.BadAsset.selector);
        assetList.getAssetInfo(badIndex);
    }

    /// Packing a cap depends on nothing but the config, so two asset lists built from
    /// the same configs answer the same way. A leftover of the deployment itself would show up here.
    function testFuzz_equalConfigsGiveEqualAssetInfo(uint256 seed) public {
        CometConfiguration.AssetConfig[] memory assetConfigs =
            configurator.getConfiguration(address(cometProxy)).assetConfigs;

        for (uint256 i; i < assetConfigs.length; ++i) {
            assetConfigs[i].supplyCap = uint128(uint256(keccak256(abi.encode(seed, i))));
        }

        AssetList assetList = new AssetList(assetConfigs);
        AssetList otherAssetList = new AssetList(assetConfigs);

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
            configurator.getConfiguration(address(cometProxy)).assetConfigs;

        for (uint256 i; i < assetConfigs.length; ++i) {
            assetConfigs[i].supplyCap = supplyCaps[i];
        }

        AssetList assetList = new AssetList(assetConfigs);

        for (uint8 i; i < assetConfigs.length; ++i) {
            CometCore.AssetInfo memory assetInfo = assetList.getAssetInfo(i);
            assertEq(assetInfo.supplyCap, supplyCaps[i], "supply cap does not read back as configured");
        }
    }
}
