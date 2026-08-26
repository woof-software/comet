// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { ICoreDexAdapter } from "@comet-contracts/interfaces/dex-adapters/ICoreDexAdapter.sol";
import { IUniswapAdapter } from "@comet-contracts/interfaces/dex-adapters/IUniswapAdapter.sol";
import { LiquidationModule } from "@comet-contracts/liquidation-module/LiquidationModule.sol";
import { LiquidationModuleForComet } from "@comet-contracts/liquidation-module/LiquidationModuleForComet.sol";
import { OneInchV6Adapter } from "@comet-contracts/dex-adapters/core/OneInchV6Adapter.sol";

/**
 * @title Liquidation module deployment
 * @notice The Solidity counterpart of `test/helpers/liquidation-module.ts`: the roles a module needs
 *         are collected in one struct and handed to whichever of the two constructors fits.
 * @dev Which one fits depends on when the module is built. A module learns its Comet from the
 *      `initializeStorage()` call the market makes on first deployment, so a market being deployed
 *      from scratch takes the plain module. That call cannot happen twice, so a market that is
 *      already running has no way to introduce itself, and an upgrade takes the variant that is
 *      given the Comet address directly.
 *
 *      The adapter is deployed separately and passed in, exactly as the TypeScript helper takes it.
 *      A module accepts one adapter, one asset list and one Comet in its lifetime, so every new
 *      module needs a new adapter behind it.
 */
library LiquidationModuleDeployer {
    struct Opts {
        address multisig;
        address[] executors;
        address[] pausers;
        ICoreDexAdapter dexAdapter;
        uint16 incentiveBps;
    }

    /**
     * @notice Deploys the DEX adapter a module sits on, with one route per collateral.
     * @dev The adapter refuses an asset list it does not have exactly one route for, so the routes
     *      are built from the market's own collateral list. They are left unconfigured: with no
     *      route to swap through, a liquidation sweeps the collateral to Comet instead.
     */
    function deployAdapter(address router, address weth, uint16 slippageBps, address[] memory collaterals)
        internal
        returns (OneInchV6Adapter)
    {
        IUniswapAdapter.RouteConfig[] memory routes = new IUniswapAdapter.RouteConfig[](collaterals.length);
        for (uint256 i; i < collaterals.length; ++i) {
            routes[i].collateral = collaterals[i];
        }

        return new OneInchV6Adapter(
            router, router, weth, slippageBps, routes, new ICoreDexAdapter.CollateralSlippage[](0)
        );
    }

    /// For a market being deployed from scratch: pass the module's address as
    /// `config.liquidationModule`, and Comet binds itself to it during initialization.
    function deployDefaultLiquidationModule(Opts memory opts) internal returns (LiquidationModule) {
        return new LiquidationModule(opts.dexAdapter, opts.multisig, opts.executors, opts.pausers, opts.incentiveBps);
    }

    /// For a market that is already live: the Comet proxy goes in through the constructor, then the
    /// module is registered with the Configurator and the implementation is redeployed onto it.
    function deployDefaultLiquidationModuleWithComet(Opts memory opts, address comet)
        internal
        returns (LiquidationModuleForComet)
    {
        return new LiquidationModuleForComet(
            opts.dexAdapter, opts.multisig, opts.executors, opts.pausers, opts.incentiveBps, comet
        );
    }
}
