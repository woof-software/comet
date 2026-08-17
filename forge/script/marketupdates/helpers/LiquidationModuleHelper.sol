// SPDX-License-Identifier: MIT
pragma solidity ^0.8.15;

import { CometConfiguration } from "@comet-contracts/CometConfiguration.sol";
import { Configurator } from "@comet-contracts/Configurator.sol";
import { OneInchV6Adapter } from "@comet-contracts/dex-adapters/core/OneInchV6Adapter.sol";
import { ICoreDexAdapter } from "@comet-contracts/interfaces/dex-adapters/ICoreDexAdapter.sol";
import { IUniswapAdapter } from "@comet-contracts/interfaces/dex-adapters/IUniswapAdapter.sol";
import { LiquidationModuleForComet } from "@comet-contracts/liquidation-module/LiquidationModuleForComet.sol";

/// Builds liquidation modules for markets deployed before the module existed.
library LiquidationModuleHelper {

    /// Placeholders to get past the constructor checks. Nothing here swaps.
    address constant DEX_ROUTER_PLACEHOLDER = 0x111111125421cA6dc452d289314280a0f8842A65;
    uint16 constant DEX_SLIPPAGE_BPS = 500;
    uint16 constant LIQUIDATION_INCENTIVE_BPS = 500;

    /// The adapter accepts the Comet's asset list only if built with one route per collateral, so
    /// routes come from the market's own config. Single-use: a module rejects a second asset list.
    function deployForMarket(
        address configuratorProxy,
        address cometProxy,
        address roleHolder
    ) internal returns (address) {
        CometConfiguration.AssetConfig[] memory assetConfigs =
            Configurator(configuratorProxy).getConfiguration(cometProxy).assetConfigs;

        IUniswapAdapter.RouteConfig[] memory routes = new IUniswapAdapter.RouteConfig[](assetConfigs.length);
        for (uint256 i; i < assetConfigs.length; ++i) {
            routes[i].collateral = assetConfigs[i].asset;
        }

        OneInchV6Adapter dexAdapter = new OneInchV6Adapter(
            DEX_ROUTER_PLACEHOLDER,
            DEX_ROUTER_PLACEHOLDER,
            DEX_ROUTER_PLACEHOLDER,
            DEX_SLIPPAGE_BPS,
            routes,
            new ICoreDexAdapter.CollateralSlippage[](0)
        );

        // Needs at least one executor and one pauser, and won't grant a role twice — so not the DAO.
        address[] memory roleHolders = new address[](1);
        roleHolders[0] = roleHolder;

        return address(new LiquidationModuleForComet(
            dexAdapter,
            roleHolder,
            roleHolders,
            roleHolders,
            LIQUIDATION_INCENTIVE_BPS,
            cometProxy
        ));
    }
}
