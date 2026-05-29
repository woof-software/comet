// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { IDefaultLiquidationModuleErrors } from "./IDefaultLiquidationModuleErrors.sol";
import { IDefaultLiquidationModuleEvents } from "./IDefaultLiquidationModuleEvents.sol";

/**
 * @title Default Liquidation Module Interface
 * @author Woof
 * @notice Interface for the default liquidation module used by Comet.
 * @dev Function documentation is maintained in the module implementation contract.
 * @custom:security-contact dmitriy@woof.software
 */
interface IDefaultLiquidationModule is IDefaultLiquidationModuleErrors, IDefaultLiquidationModuleEvents {
    function liquidate(address absorber, address account) external;

    function isLiquidatable(address account) external view returns (bool);
}
