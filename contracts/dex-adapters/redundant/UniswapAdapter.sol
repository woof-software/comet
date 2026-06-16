// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { CoreDexAdapter } from "../CoreDexAdapter.sol";
import { IUniswapAdapter } from "../../interfaces/dex-adapters/IUniswapAdapter.sol";
import { CometMainInterface } from "../../CometMainInterface.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { PathKey, Currency, ExactInputSingleParams, ExactInputParams, IUniversalRouter } from "../../vendor/uniswap/UniswapV4Vendor.sol";

/**
 * @title Uniswap Redundant Adapter
 * @author Woof
 * @notice DEX adapter that routes the redundant (fallback) swap through the Uniswap V4 Universal Router.
 * @dev Stores a preconfigured immutable V4 route per collateral, built at construction from the Comet asset
 *      list. Each route is either a single-pool swap (`SWAP_EXACT_IN_SINGLE`) or a multi-hop swap
 *      (`SWAP_EXACT_IN`).
 * @dev This contract implements only a redundant swap. Core swap is implemented in a concrete core adapter.
 * @custom:security-contact dmitriy@woof.software
 */
abstract contract UniswapAdapter is CoreDexAdapter, IUniswapAdapter {
    using SafeERC20 for IERC20;

    /// @dev Universal Router value meaning "use the full contract balance".
    uint256 private constant CONTRACT_BALANCE = 0x8000000000000000000000000000000000000000000000000000000000000000;
    /// @notice Universal Router command set: a single V4_SWAP command.
    bytes public constant COMMANDS = abi.encodePacked(uint8(0x10));
    /// @notice V4 action sequence for a single-pool swap: SWAP_EXACT_IN_SINGLE, SETTLE, TAKE.
    bytes public constant SINGLE_ACTIONS = abi.encodePacked(uint8(0x06), uint8(0x0b), uint8(0x0e));
    /// @notice V4 action sequence for a multi-hop swap: SWAP_EXACT_IN, SETTLE, TAKE.
    bytes public constant MULTI_ACTIONS = abi.encodePacked(uint8(0x07), uint8(0x0b), uint8(0x0e));
    /// @notice Encoded TAKE action sending the base-asset output to this adapter.
    bytes public takeAction;

    /// @notice Route kind per collateral asset.
    mapping(address => RouteKind) public routeKind;
    /// @notice Single-pool route per collateral asset (set when `routeKind == Single`).
    mapping(address => SingleRoute) public singleRoutes;
    /// @notice Multi-hop path per collateral asset (set when `routeKind == Multi`).
    mapping(address => PathKey[]) internal _multiPaths;
    /// @notice Encoded SETTLE action per collateral asset.
    mapping(address => bytes) public settleActions;

    /**
     * @notice Stores a V4 route and settle action for every Comet collateral asset.
     * @dev Requires exactly one route per collateral, ordered to match the Comet asset list. Each route must
     *      be a single-pool or multi-hop route; multi-hop routes require a non-empty path. Remaining
     *      parameters are forwarded to {CoreDexAdapter}.
     * @param _swapRoutes V4 routes, one per collateral asset in asset-list order.
     */
    constructor(
        CometMainInterface _comet,
        address _module,
        address _coreRouter,
        address _redundantRouter,
        uint16 _slippageBps,
        RouteConfig[] memory _swapRoutes
        ) CoreDexAdapter(_comet, _module, _coreRouter, _redundantRouter, _slippageBps) {
        uint8 numAssets = _comet.numAssets();
        if (_swapRoutes.length != numAssets) revert InvalidRoutesNumber();
        address collateral;
        RouteConfig memory cfg;
        for (uint8 i; i < numAssets; ++i) {
            collateral = _comet.getAssetInfo(i).asset;
            cfg = _swapRoutes[i];
            if (cfg.kind == RouteKind.Single) {
                singleRoutes[collateral] = SingleRoute({ poolKey: cfg.poolKey, zeroForOne: cfg.zeroForOne });
            } else if (cfg.kind == RouteKind.Multi) {
                if (cfg.path.length == 0) revert EmptyPath(collateral);
                _multiPaths[collateral] = cfg.path;
            }
            routeKind[collateral] = cfg.kind;
            settleActions[collateral] = abi.encode(Currency.wrap(collateral), CONTRACT_BALANCE, false);
        }

        takeAction = abi.encode(Currency.wrap(address(baseAsset)), address(this), 0);
    }

    /**
     * @notice Returns the configured multi-hop path for `collateral`.
     * @dev Empty when not a multi-hop route.
     * @param collateral The collateral token whose multi-hop path to read.
     * @return path The ordered hops of the multi-hop route.
     */
    function multiPath(address collateral) external view returns (PathKey[] memory path) {
        return _multiPaths[collateral];
    }

    /**
     * @inheritdoc CoreDexAdapter
     * @dev Routes the fallback swap through the Uniswap V4 Universal Router using a pre-configured route.
     */
    function _redundantSwap(IERC20 collateralToken, uint256 amountIn, uint256 minAmountOut) internal override {
        bytes[] memory inputs = _buildInputs(address(collateralToken), amountIn, minAmountOut);
        collateralToken.safeTransfer(redundantRouter, amountIn);
        IUniversalRouter(redundantRouter).execute(COMMANDS, inputs, block.timestamp);
    }

    /**
     * @notice Builds the Universal Router inputs for an exact-input V4 swap of `collateral`.
     * @dev Selects single-pool or multi-hop based on the `kind` of the collateral's swap route.
     * @param collateral The collateral token being swapped.
     * @param amountIn The amount of collateral to swap.
     * @param minAmountOut The minimum acceptable base-asset output.
     * @return inputs The encoded Universal Router inputs.
     */
    function _buildInputs(address collateral, uint256 amountIn, uint256 minAmountOut) internal view returns (bytes[] memory inputs) {
        RouteKind kind = routeKind[collateral];
        bytes memory actions;
        bytes[] memory params = new bytes[](3);

        if (kind == RouteKind.Single) {
            SingleRoute memory r = singleRoutes[collateral];
            actions = SINGLE_ACTIONS;
            params[0] = abi.encode(ExactInputSingleParams({
                poolKey: r.poolKey,
                zeroForOne: r.zeroForOne,
                amountIn: uint128(amountIn),
                amountOutMinimum: uint128(minAmountOut),
                hookData: ""
            }));
        } else if (kind == RouteKind.Multi) {
            actions = MULTI_ACTIONS;
            params[0] = abi.encode(ExactInputParams({
                currencyIn: Currency.wrap(collateral),
                path: _multiPaths[collateral],
                amountIn: uint128(amountIn),
                amountOutMinimum: uint128(minAmountOut)
            }));
        } else {
            revert MissingSwapRoute(collateral);
        }

        params[1] = settleActions[collateral];
        params[2] = takeAction;
        inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
    }
}
