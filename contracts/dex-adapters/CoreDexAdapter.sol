// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ICoreDexAdapter } from "../interfaces/dex-adapters/ICoreDexAdapter.sol";
import { CometMainInterface } from "../CometMainInterface.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Core DEX Adapter
 * @author Woof
 * @notice Base adapter that swaps collateral seized during liquidation into the Comet base asset via an external DEX.
 * @dev Bound 1:1 to a Comet market and callable only by its liquidation module. Each swap tries the core
 *      router first (_coreSwap) and falls back to the redundant router (_redundantSwap) on failure. Concrete
 *      adapters implement the protocol-specific swap routines.
 * @dev Configuration is immutable; changing it requires a redeployment of the adapter and pointing liquidation module to a new adapter.
 * @custom:security-contact dmitriy@woof.software
 */
abstract contract CoreDexAdapter is ICoreDexAdapter {
    using SafeERC20 for IERC20;

    /// @notice Basis-points denominator (100%).
    uint16 public constant BPS = 10_000;
    /// @notice The Comet market for this adapter; source of prices and asset config.
    CometMainInterface public immutable comet;
    /// @notice The base asset that collateral is swapped into.
    IERC20 public immutable baseAsset;
    /// @notice The liquidation module authorized to call swap().
    address public immutable module;
    /// @notice Primary DEX router used by _coreSwap.
    address public immutable coreRouter;
    /// @notice Fallback DEX router used by _redundantSwap when the core swap fails.
    address public immutable redundantRouter;
    /// @notice Slippage applied to the oracle-derived minimum output, in basis points.
    uint16 public immutable slippageBps;

    /**
     * @notice Binds the adapter to a Comet market and its core/redundant routers.
     * @dev `baseAsset` is resolved through the provided Comet.
     * @param _comet The Comet market to serve.
     * @param _module The liquidation module allowed to trigger swaps.
     * @param _coreRouter The primary DEX router.
     * @param _redundantRouter The fallback DEX router.
     * @param _slippageBps Allowed slippage in basis points (0 < value <= BPS).
     */
    constructor(CometMainInterface _comet, address _module, address _coreRouter, address _redundantRouter, uint16 _slippageBps) {
        if (address(_comet) == address(0) || _module == address(0) || _coreRouter == address(0) || _redundantRouter == address(0)) revert ZeroAddress();
        if (_slippageBps == 0 || _slippageBps > BPS) revert SlippageOutOfBounds(_slippageBps);

        comet = _comet;
        module = _module;
        coreRouter = _coreRouter;
        redundantRouter = _redundantRouter;
        slippageBps = _slippageBps;
        baseAsset = IERC20(_comet.baseToken());
    }

    /// @inheritdoc ICoreDexAdapter
    function swap(address collateral, bytes calldata swapData) external {
        if (msg.sender != module) revert Unathorized();

        IERC20 collateralToken = IERC20(collateral);
        uint256 amountIn = collateralToken.balanceOf(address(this));
        if (amountIn == 0) revert ZeroAmountIn();

        uint256 minAmountOut = calculateMinAmountOut(collateral, amountIn);

        uint256 baseBalBefore = baseAsset.balanceOf(address(this));
        bool status = _coreSwap(collateralToken, amountIn, minAmountOut, swapData);
        if (!status) _redundantSwap(collateralToken, amountIn, minAmountOut);

        uint256 baseBalAfter = baseAsset.balanceOf(address(this));
        uint256 amountOut = baseBalAfter - baseBalBefore;
        if (amountOut < minAmountOut) revert InvalidAmountOut();
        baseAsset.safeTransfer(msg.sender, baseBalAfter);

        emit Swap(collateral, amountIn, amountOut);
    }

    /**
     * @notice Computes the minimum acceptable base-asset output for swapping `amountIn` of `collateral`.
     * @dev Values collateral and base asset via Comet's price feeds and applies slippage BPS to the converted base asset value.
     * @param collateral Address of the collateral token being swapped.
     * @param amountIn The amount of `collateral` (in its native units) being swapped.
     * @return minAmountOut The minimum base-asset amount the swap must return.
     */
    function calculateMinAmountOut(address collateral, uint256 amountIn) public view returns (uint256 minAmountOut) {
        CometMainInterface.AssetInfo memory assetInfo = comet.getAssetInfoByAddress(collateral);

        uint256 assetPrice = comet.getPrice(assetInfo.priceFeed);
        uint256 basePrice = comet.getPrice(comet.baseTokenPriceFeed());

        // Value collateral in USD (price-scaled), then convert that value into base-asset units.
        uint256 baseAssetValue = amountIn * assetPrice * comet.baseScale() / assetInfo.scale / basePrice;

        minAmountOut = baseAssetValue * (BPS - slippageBps) / BPS;
    }

    /**
     * @notice Swaps `collateralToken` into the base asset on the core (primary) router.
     * @dev Implemented per DEX by concrete adapters. Should return false rather than revert on a failed
     *      swap, so the caller can fall back to the redundant router.
     * @param collateralToken The collateral token being swapped.
     * @param amountIn The amount of collateral to swap.
     * @param minAmountOut The minimum acceptable base-asset output.
     * @param swapData Protocol-specific calldata describing the swap.
     * @return status True if the core swap succeeded; false to trigger the redundant path.
     */
    function _coreSwap(IERC20 collateralToken, uint256 amountIn, uint256 minAmountOut, bytes calldata swapData) internal virtual returns (bool status);

    /**
     * @notice Swaps `collateralToken` into the base asset on the redundant (fallback) router.
     * @dev Implemented per DEX by concrete adapters. Called only when _coreSwap returns false.
     * @param collateralToken The collateral token being swapped.
     * @param amountIn The amount of collateral to swap.
     * @param minAmountOut The minimum acceptable base-asset output.
     */
    function _redundantSwap(IERC20 collateralToken, uint256 amountIn, uint256 minAmountOut) internal virtual;
}
