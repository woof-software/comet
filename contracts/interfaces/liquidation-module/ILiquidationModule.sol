// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ILiquidationModuleErrors } from "./ILiquidationModuleErrors.sol";
import { ILiquidationModuleEvents } from "./ILiquidationModuleEvents.sol";

/**
 * @title Liquidation Module Interface
 * @author Woof
 * @notice Errors and events specific to LiquidationModule — the extended module that adds a
 *         DEX-based liquidation path gated by configurable health factor boundaries.
 * @dev Function documentation is maintained in the module implementation contract.
 * @custom:security-contact dmitriy@woof.software
 */
interface ILiquidationModule is ILiquidationModuleErrors, ILiquidationModuleEvents {
    function liquidate(address absorber, address account, bytes calldata swapData) external;
}