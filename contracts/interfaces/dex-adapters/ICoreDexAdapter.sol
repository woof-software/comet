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
     * @dev Only callable by the liquidation module.
     * @dev On both swap route fail, collateral should be sent back to the Comet to proceed with the absorb liquidation route.
     * @param collateral The collateral token to swap.
     * @param swapData Core router calldata; pass empty to skip the core route and use only the redundant route.
     * @return swapped True if the collateral was swapped into the base asset; false if it was swept to Comet.
     */
    function swap(address collateral, bytes calldata swapData) external returns (bool swapped);

    function initiateAdapter(address comet, address assetList, address baseAsset) external;
}