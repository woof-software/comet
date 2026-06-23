// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ICoreDexAdapterErrors } from "./ICoreDexAdapterErrors.sol";
import { ICoreDexAdapterEvents } from "./ICoreDexAdapterEvents.sol";

/**
 * @title Core Dex Adapter Interface
 * @author Woof
 * @notice Interface for the CoreDexAdapter including functions core and redundant swap routes.
 * @custom:security-contact dmitriy@woof.software
 */
interface ICoreDexAdapter is ICoreDexAdapterErrors, ICoreDexAdapterEvents {
    /**
     * @notice Swaps the adapter's entire `collateral` balance into the base asset and sends it to the caller.
     * @dev Only callable by the liquidation module. Tries _coreSwap, then _redundantSwap on failure, and
     *      reverts if the realized output is below the oracle-derived minimum.
     * @dev Collateral `amountIn` must be be pre-transferred before swap() is called.
     * @param collateral The collateral token to swap.
     * @param swapData Protocol-specific calldata for the core router swap.
     */
    function swap(address collateral, bytes calldata swapData) external;
}