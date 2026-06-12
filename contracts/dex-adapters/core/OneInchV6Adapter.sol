// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { CometMainInterface } from "../../CometMainInterface.sol";
import { CoreDexAdapter } from "../CoreDexAdapter.sol";
import { IOneInchV6AdapterErrors } from "../../interfaces/dex-adapters/IOneInchV6AdapterErrors.sol";
import { UniswapAdapter } from "../redundant/UniswapAdapter.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SwapDescription, IOneInchV6 } from "../../vendor/OneInchV6/IOneInchV6.sol";

/**
 * @title 1inch V6 Core Adapter
 * @author Woof
 * @notice DEX adapter using the 1inch V6 aggregation router as the core swap path and Uniswap V4 as the
 *         redundant path.
 * @dev Validates the off-chain 1inch swap calldata against the requested swap before forwarding it to the router.
 * @custom:security-contact dmitriy@woof.software
 */
contract OneInchV6CoreAdapter is UniswapAdapter, IOneInchV6AdapterErrors {
    using SafeERC20 for IERC20;

    /// @notice Selector of IOneInchV6.swap, the only 1inch router call accepted as core swap data.
    bytes4 public constant SWAP_SELECTOR = IOneInchV6.swap.selector;

    /// @dev Parameters are forwarded to {UniswapAdapter} and {CoreDexAdapter}.
    constructor(
        CometMainInterface _comet,
        address _module,
        address _coreRouter,
        address _redundantRouter,
        uint16 _slippageBps,
        Route[] memory _swapRoutes
    ) UniswapAdapter(_comet, _module, _coreRouter, _redundantRouter, _slippageBps, _swapRoutes) {}

    /**
     * @inheritdoc CoreDexAdapter
     * @dev Performs the core swap via the 1inch V6 router with necessary calldata validations. Clears any leftover
     *      allowance if the call fails so the redundant path starts from a zero allowance.
     */
    function _coreSwap(IERC20 collateralToken, uint256 amountIn, uint256 minAmountOut, bytes calldata swapData) internal override returns (bool status) {
        SwapDescription memory desc = _decodeSwapData(swapData);
        _validateSwapData(desc, address(collateralToken), amountIn, minAmountOut);
        collateralToken.safeIncreaseAllowance(coreRouter, amountIn);
        (status, ) = coreRouter.call(swapData);
        // Clear unused allowance
        if (!status) collateralToken.safeApprove(coreRouter, 0);
    }

    /**
     * @notice Decodes 1inch swap calldata into its SwapDescription.
     * @dev Reverts if the calldata is too short or its selector is not IOneInchV6.swap.
     * @param swapData The 1inch router calldata.
     * @return desc The decoded swap description.
     */
    function _decodeSwapData(bytes calldata swapData) internal view returns (SwapDescription memory desc) {
        if (swapData.length <= 4) revert InvalidSwapData();
        if(bytes4(swapData[:4]) != SWAP_SELECTOR) revert InvalidSelector();
        (
            ,
            // address executor
            desc,

        ) = abi.decode(
                swapData[4:],
                (address, SwapDescription, bytes)
            );
    }

    /**
     * @notice Validates a decoded 1inch SwapDescription against the requested swap parameters.
     * @dev Reverts if tokens, receiver, input amount, or minimum return do not match.
     * @param desc The decoded swap description.
     * @param collateral The collateral token being swapped.
     * @param amountIn The expected input amount.
     * @param minAmountOut The minimum acceptable base-asset output.
     */
    function _validateSwapData(SwapDescription memory desc, address collateral, uint256 amountIn, uint256 minAmountOut) internal view {
        if (collateral != desc.srcToken || address(baseAsset) != desc.dstToken) revert InvalidTokens();
        if (desc.dstReceiver != address(this)) revert InvalidReceiver();
        if (amountIn != desc.amount) revert InvalidAmountIn();
        if (desc.minReturnAmount < minAmountOut) revert InvalidMinAmountOut();
    }
}
