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
 *      router first (_coreSwap) and falls back to the redundant router (executeRedundantSwap) on failure or empty swap data. If
 *      the redundant route also fails, the collateral is swept back to Comet and swap() returns false so the
 *      module can absorb it. Concrete adapters implement the protocol-specific swap routines.
 * @dev Configuration is immutable; changing it requires a redeployment of the adapter and pointing liquidation module to a new adapter.
 * @custom:security-contact dmitriy@woof.software
 */
abstract contract CoreDexAdapter is ICoreDexAdapter {
    using SafeERC20 for IERC20;

    /// @notice Basis-points denominator (100%).
    uint16 public constant BPS = 10_000;
    /// @notice The Comet market for this adapter; source of prices and asset config. Set in initiateAdapter.
    CometMainInterface public comet;
    /// @notice The base asset that collateral is swapped into. Set in initiateAdapter.
    IERC20 public baseAsset;
    /// @notice Primary DEX router used by _coreSwap.
    address public immutable coreRouter;
    /// @notice Fallback DEX router used by _redundantSwap when the core swap fails.
    address public immutable redundantRouter;
    /// @notice Slippage applied to the oracle-derived minimum output, in basis points.
    uint16 public immutable slippageBps;

    /// @notice The liquidation module authorized to call swap().
    address public module;

    /**
     * @notice Sets the adapter's core/redundant routers and slippage. The Comet is NOT bound here: at
     *         deployment time the Comet does not exist yet, so it is resolved later in {initiateAdapter}.
     * @param _coreRouter The primary DEX router.
     * @param _redundantRouter The fallback DEX router.
     * @param _slippageBps Allowed slippage in basis points (0 < value <= BPS).
     */
    constructor(address _coreRouter, address _redundantRouter, uint16 _slippageBps) {
        if (_coreRouter == address(0) || _redundantRouter == address(0)) revert ZeroAddress();
        if (_slippageBps == 0 || _slippageBps > BPS) revert SlippageOutOfBounds(_slippageBps);

        coreRouter = _coreRouter;
        redundantRouter = _redundantRouter;
        slippageBps = _slippageBps;
    }

    /**
     * @notice Finalized the initialization of Dex Adapter.
     * @param _comet The Comet market this adapter serves.
     * @param _baseAsset The Comet base asset that collateral is swapped into.
     */
    function _initiateAdapter(address _comet, address _baseAsset) internal {
        if (module != address(0)) revert AlreadySet();
        if (_comet == address(0) || _baseAsset == address(0)) revert ZeroAddress();

        module = msg.sender;
        comet = CometMainInterface(_comet);
        baseAsset = IERC20(_baseAsset);
    }

    /// @inheritdoc ICoreDexAdapter
    function swap(address collateral, bytes calldata swapData) external returns (bool) {
        if (msg.sender != module) revert Unathorized();

        IERC20 collateralToken = IERC20(collateral);
        uint256 amountIn = collateralToken.balanceOf(address(this));
        if (amountIn == 0) revert ZeroAmountIn();

        uint256 minAmountOut = calculateMinAmountOut(collateral, amountIn);
        uint256 baseBalBefore = baseAsset.balanceOf(address(this));

        bool coreStatus;
        if (swapData.length != 0) {
            coreStatus = _coreSwap(collateralToken, amountIn, minAmountOut, swapData);
        }

        if (!coreStatus && !_redundantSwap(collateralToken, amountIn, minAmountOut)) {
            return false;
        }

        uint256 baseBalAfter = baseAsset.balanceOf(address(this));
        uint256 amountOut = baseBalAfter - baseBalBefore;
        if (amountOut < minAmountOut) revert InvalidAmountOut();
        baseAsset.safeTransfer(msg.sender, baseBalAfter);

        emit Swap(collateral, amountIn, amountOut);
        return true;
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
     *      swap, so the swap can fall back to the redundant router.
     * @param collateralToken The collateral token being swapped.
     * @param amountIn The amount of collateral to swap.
     * @param minAmountOut The minimum acceptable base-asset output.
     * @param swapData Protocol-specific calldata describing the swap.
     * @return status True if the core swap succeeded; false to trigger the redundant path.
     */
    function _coreSwap(IERC20 collateralToken, uint256 amountIn, uint256 minAmountOut, bytes calldata swapData) internal virtual returns (bool status);

    /**
     * @notice Swaps `collateralToken` into the base asset on the redundant (fallback) router.
     * @dev Implemented per DEX by concrete adapters. Called when the core swap is skipped or fails.
     * @dev On failed swap, must return false and sweep the collateral back to the Comet to proceed with absorb liquidation route.
     * @param collateralToken The collateral token being swapped.
     * @param amountIn The amount of collateral to swap.
     * @param minAmountOut The minimum acceptable base-asset output.
     * @return status True if the collateral was swapped into the base asset; false if it was swept to Comet.
     */
    function _redundantSwap(IERC20 collateralToken, uint256 amountIn, uint256 minAmountOut) internal virtual returns (bool status);
}
