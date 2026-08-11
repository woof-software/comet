// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { IUniswapAdapterErrors } from "./IUniswapAdapterErrors.sol";
import { PoolKey, PathKey } from "../../vendor/uniswap/UniswapV4Vendor.sol";

/**
 * @title Uniswap Adapter interface
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface IUniswapAdapter is IUniswapAdapterErrors {
    /// @notice The kind of V4 route configured for a collateral.
    enum RouteKind {
        Unset,  // no route configured
        Single, // single-pool swap (SWAP_EXACT_IN_SINGLE)
        Multi   // multi-hop swap (SWAP_EXACT_IN)
    }

    /// @notice Single-pool V4 route for a collateral asset.
    struct SingleRoute {
        PoolKey poolKey;
        bool zeroForOne;
    }

    /// @notice Per-collateral route configuration supplied at constructor.
    /// @dev `collateral` keys the route in storage; `poolKey`/`zeroForOne` are read only when
    ///      `kind == Single`; `path` only when `kind == Multi`.
    struct RouteConfig {
        address collateral;
        RouteKind kind;
        PoolKey poolKey;
        bool zeroForOne;
        PathKey[] path;
    }
}
