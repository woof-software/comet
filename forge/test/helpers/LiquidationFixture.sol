// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { CometConfiguration } from "@comet-contracts/CometConfiguration.sol";

import { ProtocolFixture } from "./ProtocolFixture.sol";

/**
 * @title Liquidation fixture
 * @notice The protocol fixture with the market the liquidation fuzz suites bound their positions for: a minimum
 *         borrow of one base unit and a supply cap of 150,000 whole tokens per collateral. The shared fixture's
 *         $350 minimum borrow sits above most of the borrows those bounds produce, so few runs ever open a position.
 */
abstract contract LiquidationFixture is ProtocolFixture {
    function buildAssetConfigs()
        internal
        view
        virtual
        override
        returns (CometConfiguration.AssetConfig[] memory assetConfigs)
    {
        assetConfigs = super.buildAssetConfigs();
        for (uint256 i; i < assetConfigs.length; ++i) {
            assetConfigs[i].supplyCap = uint128(150_000 * 10 ** assetSpecs[i + 1].decimals); // index 0 is the base token
        }
    }

    function buildCometConfiguration()
        internal
        view
        virtual
        override
        returns (CometConfiguration.Configuration memory config)
    {
        config = super.buildCometConfiguration();
        config.baseBorrowMin = uint104(10 ** assetSpecs[0].decimals);
    }
}
