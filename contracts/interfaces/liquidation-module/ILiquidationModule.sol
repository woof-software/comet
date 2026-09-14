// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ILiquidationModuleErrors } from "./ILiquidationModuleErrors.sol";

/**
 * @title Liquidation Module Interface
 * @author Woof
 * @notice Errors, events and the keeper-driven absorb entry point of the base LiquidationModule.
 *         The DEX-based liquidation path is defined in IDexLiquidationModule.
 * @dev Function documentation is maintained in the module implementation contract.
 * @custom:security-contact dmitriy@woof.software
 */
interface ILiquidationModule is ILiquidationModuleErrors {
    function liquidate(address absorber, address account, bytes[] calldata swapData) external;
}
