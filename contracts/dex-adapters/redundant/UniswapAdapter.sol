// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { CoreDexAdapter } from "../CoreDexAdapter.sol";
import { CometMainInterface } from "../../CometMainInterface.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { PoolKey, Currency, ExactInputSingleParams, IUniversalRouter } from "../../vendor/uniswap/UniswapV4Vendor.sol";

/**
 * @title Uniswap Redundant Adapter
 * @author Woof
 * @notice DEX adapter that routes the redundant (fallback) swap through the Uniswap V4 Universal Router.
 * @dev Stores a preconfigured immutable V4 swap Route per collateral, built at construction from the Comet asset
 *      list. 
 * @dev This contract implements only a redundant swap. Core swap is implemented in a concrete core adapter.
 * @custom:security-contact dmitriy@woof.software
 */
abstract contract UniswapAdapter is CoreDexAdapter {
    using SafeERC20 for IERC20;

    /// @dev Universal Router value meaning "use the full contract balance".
    uint256 private constant CONTRACT_BALANCE = 0x8000000000000000000000000000000000000000000000000000000000000000;
    /// @notice Universal Router command set: a single V4_SWAP command.
    bytes public constant COMMANDS = abi.encodePacked(uint8(0x10));
    /// @notice Encoded V4 action sequence: exact-input single swap, settle, take.
    bytes public constant ACTIONS = abi.encodePacked(uint8(0x06), uint8(0x0b), uint8(0x0e));
    /// @notice Encoded TAKE action sending the base-asset output to this adapter.
    bytes public takeAction;

    /// @notice V4 swap route for a collateral asset.
    struct Route {
        PoolKey poolKey;  // pool to swap through
        bool zeroForOne;  // swap direction within the pool
    }

    /// @notice V4 swap route per collateral asset.
    mapping(address => Route) public routes;
    /// @notice Encoded SETTLE action per collateral asset.
    mapping(address => bytes) public settleActions;

    /// @notice Thrown when the provided routes count does not match the number of Comet collateral assets.
    error InvalidRoutesNumber();

    /**
     * @notice Stores a V4 swap route and settle action for every Comet collateral asset.
     * @dev Requires exactly one route per collateral, ordered to match the Comet asset list. Remaining
     *      parameters are forwarded to {CoreDexAdapter}.
     * @param _swapRoutes V4 routes, one per collateral asset in asset-list order.
     */
    constructor(
        CometMainInterface _comet,
        address _module,
        address _coreRouter,
        address _redundantRouter,
        uint16 _slippageBps,
        Route[] memory _swapRoutes
        ) CoreDexAdapter(_comet, _module, _coreRouter, _redundantRouter, _slippageBps) {
        uint8 numAssets = _comet.numAssets();
        if (_swapRoutes.length != numAssets) revert InvalidRoutesNumber();
        address collateral;
        for (uint8 i; i < numAssets; ++i) {
            collateral = _comet.getAssetInfo(i).asset;
            routes[collateral] = _swapRoutes[i];
            settleActions[collateral] = abi.encode(Currency.wrap(collateral), CONTRACT_BALANCE, false);
        }

        takeAction = abi.encode(Currency.wrap(address(baseAsset)), address(this), 0);
    }

    /**
     * @inheritdoc CoreDexAdapter
     * @dev Routes the fallback swap through the Uniswap V4 Universal Router: transfers the collateral to the
     *      router and executes a single exact-input swap using the collateral's preconfigured Route.
     */
    function _redundantSwap(IERC20 collateralToken, uint256 amountIn, uint256 minAmountOut) internal override {
        bytes[] memory inputs = _buildInputs(address(collateralToken), amountIn, minAmountOut);
        collateralToken.safeTransfer(redundantRouter, amountIn);
        IUniversalRouter(redundantRouter).execute(COMMANDS, inputs, block.timestamp);
    }

    /**
     * @notice Builds the Universal Router inputs for a single exact-input V4 swap of `collateral`.
     * @dev Encodes the swap, settle and take actions using the collateral's stored Route.
     * @param collateral The collateral token being swapped.
     * @param amountIn The amount of collateral to swap.
     * @param minAmountOut The minimum acceptable base-asset output.
     * @return inputs The encoded Universal Router inputs.
     */
    function _buildInputs(address collateral, uint256 amountIn, uint256 minAmountOut) internal view returns (bytes[] memory inputs) {
        Route memory r = routes[collateral];
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams({
            poolKey: r.poolKey,
            zeroForOne: r.zeroForOne,
            amountIn: uint128(amountIn),
            amountOutMinimum: uint128(minAmountOut),
            hookData: ""
        }));
        params[1] = settleActions[collateral];
        params[2] = takeAction;
        inputs = new bytes[](1);
        inputs[0] = abi.encode(ACTIONS, params);
    }
}
