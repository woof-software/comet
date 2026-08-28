// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { CoreDexAdapter } from "../CoreDexAdapter.sol";
import { IUniswapAdapter } from "../../interfaces/dex-adapters/IUniswapAdapter.sol";
import { IAssetList } from "../../IAssetList.sol";
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

    /// @dev Universal Router / V4 value meaning "use the full contract balance".
    uint256 private constant CONTRACT_BALANCE = 0x8000000000000000000000000000000000000000000000000000000000000000;
    /// @dev Universal Router / V4 recipient sentinel that resolves to the router itself.
    address private constant ADDRESS_THIS = address(2);
    /// @dev Universal Router command: execute a V4 swap.
    uint8 private constant V4_SWAP = 0x10;
    /// @dev Universal Router command: wrap the router's ETH into WETH.
    uint8 private constant WRAP_ETH = 0x0b;
    /// @dev Universal Router command: unwrap the router's WETH into ETH.
    uint8 private constant UNWRAP_WETH = 0x0c;
    /// @dev Universal Router command: transfer token to a specified recipient.
    uint8 private constant TRANSFER = 0x05;

    /// @notice Universal Router commands for a swap with an ERC-20 input and output: V4_SWAP.
    bytes public constant SWAP_COMMANDS = abi.encodePacked(V4_SWAP);
    /// @notice Universal Router commands for a WETH (native) input: UNWRAP_WETH, V4_SWAP.
    bytes public constant UNWRAP_SWAP_COMMANDS = abi.encodePacked(UNWRAP_WETH, V4_SWAP);
    /// @notice Universal Router commands for a WETH (native) output: V4_SWAP, WRAP_ETH.
    bytes public constant SWAP_WRAP_COMMANDS = abi.encodePacked(V4_SWAP, WRAP_ETH);
    /// @notice Universal Router command to return the router's pre-transferred collateral to Comet on swap failure: TRANSFER.
    bytes public constant TRANSFER_COMMAND = abi.encodePacked(TRANSFER);

    /// @notice V4 action sequence for a single-pool swap: SWAP_EXACT_IN_SINGLE, SETTLE, TAKE.
    bytes public constant SINGLE_ACTIONS = abi.encodePacked(uint8(0x06), uint8(0x0b), uint8(0x0e));
    /// @notice V4 action sequence for a multi-hop swap: SWAP_EXACT_IN, SETTLE, TAKE.
    bytes public constant MULTI_ACTIONS = abi.encodePacked(uint8(0x07), uint8(0x0b), uint8(0x0e));

    /// @notice The wrapped native token. Collateral equal to it is swapped as native ETH.
    address public immutable weth;
    /// @notice True when the base asset is WETH, so swap output is taken as native ETH and wrapped to WETH.
    /// @dev Set in initiateAdapter (depends on the base asset, unknown at construction).
    bool public baseIsNative;
    /// @notice Number of route entries provided at construction.
    uint8 private _routesCount;

    /// @notice Encoded TAKE action sending the swap output to this adapter (or to the router when native).
    bytes public takeAction;
    /// @notice Encoded input for the wrap/unwrap command.
    bytes public nativeCommandInput;

    /// @notice Route kind per collateral asset.
    mapping(address => RouteKind) public routeKind;
    /// @notice Single-pool route per collateral asset (set when `routeKind == Single`).
    mapping(address => SingleRoute) public singleRoutes;
    /// @notice Multi-hop path per collateral asset (set when `routeKind == Multi`).
    mapping(address => PathKey[]) internal _multiPaths;

    /**
     * @notice Stores a V4 route per collateral, keyed by `RouteConfig.collateral`. Router/slippage parameters are forwarded to {CoreDexAdapter}.
     * @param _coreRouter The primary DEX router.
     * @param _redundantRouter The fallback DEX router.
     * @param _weth The wrapped native token for this chain.
     * @param _slippageBps Allowed slippage in basis points.
     * @param _swapRoutes V4 routes, one entry per collateral asset (each tagged with its collateral).
     * @param _initialCollateralSlippages Per-collateral slippage overrides, forwarded to {CoreDexAdapter}.
     */
    constructor(
        address _coreRouter,
        address _redundantRouter,
        address _weth,
        uint16 _slippageBps,
        RouteConfig[] memory _swapRoutes,
        CollateralSlippage[] memory _initialCollateralSlippages
    ) CoreDexAdapter(_coreRouter, _redundantRouter, _slippageBps, _initialCollateralSlippages) {
        if (_weth == address(0)) revert ZeroAddress();
        weth = _weth;
        _routesCount = uint8(_swapRoutes.length);

        for (uint8 i; i < _swapRoutes.length; ++i) {
            RouteConfig memory cfg = _swapRoutes[i];
            address collateral = cfg.collateral;

            routeKind[collateral] = cfg.kind;
            if (cfg.kind == RouteKind.Single) {
                singleRoutes[collateral] = SingleRoute({ poolKey: cfg.poolKey, zeroForOne: cfg.zeroForOne });
            } else if (cfg.kind == RouteKind.Multi) {
                _multiPaths[collateral] = cfg.path;
            }
        }
    }

    function setAssetList(address _assetList, uint8 numAssets, address _baseAsset) public override {
        if (address(baseAsset) != address(0)) revert AlreadySet();
        if (_routesCount != numAssets) revert InvalidRoutesNumber();

        baseAsset = IERC20(_baseAsset);
        IAssetList assetList = IAssetList(_assetList);

        bool baseNative = _baseAsset == weth;
        address expectedDstAsset = baseNative ? address(0) : _baseAsset;

        for (uint8 i; i < numAssets; ++i) {
            address collateral = assetList.getAssetInfo(i).asset;
            address expectedSrcAsset = collateral == weth ? address(0) : collateral;
            RouteKind kind = routeKind[collateral];

            if (kind == RouteKind.Single) {
                SingleRoute memory r = singleRoutes[collateral];
                address srcCurrency = Currency.unwrap(r.zeroForOne ? r.poolKey.currency0 : r.poolKey.currency1);
                address dstCurrency = Currency.unwrap(r.zeroForOne ? r.poolKey.currency1 : r.poolKey.currency0);
                if (srcCurrency != expectedSrcAsset || dstCurrency != expectedDstAsset) revert InvalidRoute(collateral);
                if (address(r.poolKey.hooks) != address(0)) revert NonZeroHooks(collateral);
            } else if (kind == RouteKind.Multi) {
                PathKey[] memory path = _multiPaths[collateral];
                if (path.length == 0) revert EmptyPath(collateral);
                // The final hop of a multi-hop route must land in the base asset.
                if (Currency.unwrap(path[path.length - 1].intermediateCurrency) != expectedDstAsset) revert InvalidRoute(collateral);
                for (uint8 j; j < path.length; ++j)
                    if (address(path[j].hooks) != address(0) || path[j].hookData.length != 0) revert NonZeroHooks(collateral);
            }
            // RouteKind.Unset: no route for this collateral; the redundant swap sweeps it to Comet.
        }

        baseIsNative = baseNative;
        takeAction = abi.encode(
            Currency.wrap(baseNative ? address(0) : _baseAsset),
            baseNative ? ADDRESS_THIS : address(this),
            uint256(0)
        );
        nativeCommandInput = baseNative
            ? abi.encode(address(this), CONTRACT_BALANCE)
            : abi.encode(ADDRESS_THIS, uint256(0));
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
     * @dev Routes the fallback swap through the Uniswap V4 Universal Router. A WETH collateral is unwrapped to
     *      native ETH before the swap; a WETH base asset is produced by wrapping the native ETH output. If no
     *      route is configured, or the router swap reverts (including its own amountOutMinimum enforcement),
     *      the collateral is sent to Comet for absorption and the function returns false instead of reverting.
     */
    function _redundantSwap(IERC20 collateralToken, uint256 amountIn, uint256 minAmountOut) internal override returns (bool) {
        address collateral = address(collateralToken);

        // No redundant route configured for this collateral: sweep it straight to Comet for absorption.
        if (routeKind[collateral] == RouteKind.Unset) {
            collateralToken.safeTransfer(address(comet), amountIn);
            emit RedundantSwapFailed(collateral, amountIn);
            return false;
        }

        (bytes memory commands, bytes[] memory inputs) = _buildCommandsAndInputs(collateral, amountIn, minAmountOut);
        collateralToken.safeTransfer(redundantRouter, amountIn);

        try IUniversalRouter(redundantRouter).execute(commands, inputs, block.timestamp) {
            return true;
        } catch {
            // Transfer collateral back to the Comet.
            bytes[] memory transferInputs = new bytes[](1);
            transferInputs[0] = abi.encode(collateral, address(comet), amountIn);
            IUniversalRouter(redundantRouter).execute(TRANSFER_COMMAND, transferInputs, block.timestamp);

            emit RedundantSwapFailed(collateral, amountIn);
            return false;
        }
    }

    /**
     * @notice Builds the Universal Router commands and inputs for an exact-input swap of `collateral`.
     * @dev Wraps the V4 swap input with a leading UNWRAP_WETH (WETH collateral) or trailing WRAP_ETH (WETH
     *      base).
     * @param collateral The collateral token being swapped.
     * @param amountIn The amount of collateral to swap.
     * @param minAmountOut The minimum acceptable base-asset output.
     * @return commands The encoded Universal Router command sequence.
     * @return inputs The encoded input for each command.
     */
    function _buildCommandsAndInputs(address collateral, uint256 amountIn, uint256 minAmountOut)
        internal
        view
        returns (bytes memory commands, bytes[] memory inputs)
    {
        bytes memory v4Input = _buildV4SwapInput(collateral, amountIn, minAmountOut);

        if (collateral == weth) {
            commands = UNWRAP_SWAP_COMMANDS;
            inputs = new bytes[](2);
            inputs[0] = nativeCommandInput;
            inputs[1] = v4Input;
        } else if (baseIsNative) {
            commands = SWAP_WRAP_COMMANDS;
            inputs = new bytes[](2);
            inputs[0] = v4Input;
            inputs[1] = nativeCommandInput;
        } else {
            commands = SWAP_COMMANDS;
            inputs = new bytes[](1);
            inputs[0] = v4Input;
        }
    }

    /**
     * @notice Builds the input for the V4_SWAP command for an exact-input swap of `collateral`.
     * @dev Reverts if collateral is missing swap route.
     * @param collateral The collateral token being swapped.
     * @param amountIn The amount of collateral to swap.
     * @param minAmountOut The minimum acceptable base-asset output.
     * @return v4Input The encoded V4_SWAP command input (actions + params).
     */
    function _buildV4SwapInput(address collateral, uint256 amountIn, uint256 minAmountOut) internal view returns (bytes memory v4Input) {
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
                minHopPriceX36: 0,
                hookData: ""
            }));
        } else if (kind == RouteKind.Multi) {
            actions = MULTI_ACTIONS;
            params[0] = abi.encode(ExactInputParams({
                currencyIn: Currency.wrap(collateral == weth ? address(0) : collateral),
                path: _multiPaths[collateral],
                minHopPriceX36: new uint256[](_multiPaths[collateral].length),
                amountIn: uint128(amountIn),
                amountOutMinimum: uint128(minAmountOut)
            }));
        } else {
            revert MissingSwapRoute(collateral);
        }

        params[1] = abi.encode(
            Currency.wrap(collateral == weth ? address(0) : collateral),
            amountIn,
            false
        );
        params[2] = takeAction;
        v4Input = abi.encode(actions, params);
    }
}
